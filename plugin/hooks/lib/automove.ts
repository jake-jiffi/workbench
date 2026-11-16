import type { AccountRow, Limit } from '../../types'
import { bestAccount, isOutOfCredits, isSameAccount, throttleOk } from './accounts'
import type { Who } from './accounts'
import type { SwapChecks } from './swap'

// The automatic account move: pure decisions only. Nothing here touches the engine, a login or a file.
//
// Goal: never fully deplete an account. When this session's account reaches the threshold on the 5-hour or the
// weekly meter and nothing is at risk, the conversation moves to another account by the same request-file and
// /exit path as the manual move. Anything that makes a move unsafe holds it; the hold is reported once per window.

export const AUTO_DEFAULT_PCT = 94
export const AUTO_MIN_PCT = 50
export const AUTO_COOLDOWN_MIN = 30
// How long unread accounts are waited for before the move decides without them.
export const AUTO_STALE_GIVE_UP_MS = 10 * 60_000

/** `autoMovePct`: 0 (or a number above 100, or junk) turns it off; anything else is clamped to 50 to 100. */
export function parseAutoPct(value: unknown): number {
  if (value === undefined || value === null || value === '') return AUTO_DEFAULT_PCT
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0 || n > 100) return 0
  return Math.max(AUTO_MIN_PCT, Math.round(n))
}

export type Hit = { kind: string; percent: number; resetsAt?: string }

/** The meter at or over the line (5-hour or week). A window that has already reset no longer counts. */
export function hitOf(limits: Limit[], pct: number, now: number): Hit | null {
  let hit: Hit | null = null
  for (const l of limits) {
    if (l.kind !== 'five_hour' && l.kind !== 'seven_day') continue
    const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!Number.isNaN(reset) && reset <= now) continue
    if (l.percent >= pct && (!hit || l.percent > hit.percent)) hit = { kind: l.kind, percent: l.percent, resetsAt: l.resetsAt }
  }
  return hit
}

export type HoldCode = 'no-wrapper' | 'pr-unknown' | 'at-risk' | 'background' | 'bg-unknown' | 'turn' | 'typing' | 'cooldown' | 'stale' | 'no-target'

export type AutoVerdict =
  | { kind: 'off' }
  | { kind: 'below' }
  | { kind: 'move'; label: string; hit: Hit }
  // `alert`: worth telling the owner once per window. A turn running, text in the box, a cooldown and a wait for a
  // reading clear by themselves in seconds or minutes and are only shown on the card.
  | { kind: 'hold'; code: HoldCode; reason: string; alert: boolean; hit: Hit }

export type AutoInput = {
  pct: number
  now: number
  limits: Limit[]
  self?: Who
  rows: AccountRow[]
  probeMinutes: number
  canMove: boolean
  isTurnRunning: boolean
  // The prompt box as typed; undefined when it could not be read (treated as not empty).
  promptText: string | undefined
  checks: SwapChecks
  // 'unknown': the PR list has not been read, or the last read failed or is old. A release could be hiding in it.
  prState: 'ok' | 'unknown'
  // Counts from the last Stop event; known is false until one has been seen.
  background: { known: boolean; tasks: number; crons: number }
  lastMoveAt: number
  staleGiveUp: boolean
}

const shortRisk = (c: SwapChecks, bg: { tasks: number; crons: number }) => {
  const bits: string[] = []
  if (c.isRelease) bits.push('release in flight')
  if (c.running.length) bits.push(`${c.running.length} worker${c.running.length === 1 ? '' : 's'} running`)
  if (bg.tasks) bits.push(`${bg.tasks} background task${bg.tasks === 1 ? '' : 's'}`)
  if (bg.crons) bits.push(`${bg.crons} scheduled wake-up${bg.crons === 1 ? '' : 's'}`)
  return bits.join(', ') || 'work at risk'
}

export function decideAutoMove(i: AutoInput): AutoVerdict {
  if (i.pct <= 0) return { kind: 'off' }
  const hit = hitOf(i.limits, i.pct, i.now)
  if (!hit) return { kind: 'below' }
  const hold = (code: HoldCode, reason: string, alert: boolean): AutoVerdict => ({ kind: 'hold', code, reason, alert, hit })

  if (!i.canMove) return hold('no-wrapper', 'this session did not start through the claude wrapper', true)
  if (i.prState === 'unknown') return hold('pr-unknown', 'pull requests not read, so a release cannot be ruled out', true)
  if (i.checks.isBlocked) return hold('at-risk', shortRisk(i.checks, i.background), true)
  if (!i.background.known) return hold('bg-unknown', 'background tasks not seen yet', false)
  if (i.background.tasks || i.background.crons) return hold('background', shortRisk(i.checks, i.background), true)
  if (i.isTurnRunning) return hold('turn', 'a turn is running', false)
  if (i.promptText === undefined || i.promptText.trim() !== '') return hold('typing', 'text in the prompt box', false)
  if (!throttleOk(i.lastMoveAt, i.now, AUTO_COOLDOWN_MIN)) return hold('cooldown', 'moved a short while ago', false)

  const others = i.rows.filter(r => !isSameAccount(r.reading, i.self) && !isOutOfCredits(r))
  const isFresh = (r: AccountRow) => r.reading !== undefined && i.now - r.reading.at < i.probeMinutes * 60_000
  const unread = others.filter(r => !isFresh(r))
  const below = (r: AccountRow) => (r.reading?.session === undefined || r.reading.session.percent < i.pct) && (r.reading?.week?.percent ?? 100) < i.pct
  const eligible = others.filter(r => isFresh(r) && below(r))
  const best = bestAccount(eligible, i.self)
  if (best) return { kind: 'move', label: best.label, hit }
  if (unread.length && !i.staleGiveUp) return hold('stale', 'reading the other accounts', false)
  return hold('no-target', `no other account under ${i.pct}%`, true)
}

/** The Accounts card line: the threshold, and when a move is held, why. */
export function autoLine(v: AutoVerdict, pct: number): { text: string; isHeld: boolean } {
  if (v.kind === 'off') return { text: 'Auto-move: off (autoMovePct 0)', isHeld: false }
  if (v.kind === 'below') return { text: `Auto-move at ${pct}%: on`, isHeld: false }
  if (v.kind === 'move') return { text: `Auto-move at ${pct}%: moving to ${v.label}`, isHeld: false }
  return { text: `Auto-move at ${pct}%: held, ${v.reason}`, isHeld: true }
}

/** One alert per account per reset window. */
export const alertKey = (selfKey: string, hit: Hit, now: number) => `${selfKey}|${hit.kind}@${hit.resetsAt ?? `d${Math.floor(now / 86_400_000)}`}`

export const alertText = (pct: number, hit: Hit, reason: string) =>
  `${hit.kind === 'seven_day' ? 'Week' : '5-hour'} at ${hit.percent}% (line ${pct}%). Not moving: ${reason}.`
