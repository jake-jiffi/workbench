import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AccountReading, AccountRow, AccountsState, Limit } from '../../types'
import { emailKey, errorClears, errorNeedsAction, isOutOfCredits, parseAccountList, parseNotes, rowFor, swapCandidate, throttleOk } from './accounts'
import { hhmm } from './format'
import { probeAccount, probeIdentity } from './probe'
import { limitToast } from './toastcap'

// The accounts state: this session's account and limits, the known accounts, and the last error seen per
// account. Nothing here touches a login. Emails stay in memory; the store keeps a one-way hash and a kind.

// The engine's scan reads state from the file that uses it, so each file declares the atoms it touches,
// with the same key, default and shape as register.tsx.
export const emptyAccounts = (): AccountsState => ({ limits: [], limitsAt: 0, rows: [], seen: {}, warned: {}, probeAt: 0, models: {} })
const accounts = atom({ plugin: 'workbench', key: 'accounts' } as const, emptyAccounts(), { shape: 'accounts-1' })

const SEEN_KEY = 'accounts.seen.v1'
const RECENT_ERROR_MS = 15 * 60_000

// autoPct: the auto-move line (autoMovePct), so a full account is never offered as a swap.
export type AcctOptions = { list: string; notes: string; probeMinutes: number; warn: number; urgent: number; weekWarn: number; home: string; autoPct?: number }

// ---------- pure ----------

export function limitsOf(rateLimits: ReadonlyArray<{ kind: string; percentUsed: number; resetsAt?: string }>): Limit[] {
  return rateLimits.filter(r => typeof r.percentUsed === 'number').map(r => ({ kind: r.kind, percent: Math.max(0, Math.min(100, Math.round(r.percentUsed))), resetsAt: r.resetsAt }))
}

export const limitName = (kind: string) => (kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? 'Week' : kind === 'spend_limit' ? 'Spend limit' : kind)

/** 5-hour warns at `warn` (80), the week at `weekWarn` (90); both go to level 2 at `urgent`. */
export function warnLevel(kind: string, percent: number, o: { warn: number; urgent: number; weekWarn: number }): 0 | 1 | 2 {
  const first = kind === 'seven_day' ? o.weekWarn : o.warn
  return percent >= o.urgent ? 2 : percent >= first ? 1 : 0
}

/** "18:00" for today, "Nov 12 16:00" otherwise. */
export function fmtReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ''
  const t = Date.parse(resetsAt)
  if (Number.isNaN(t)) return resetsAt.slice(0, 24)
  const d = new Date(t)
  const same = new Date(now).toDateString() === d.toDateString()
  return same ? hhmm(t) : `${d.toLocaleString('en-AU', { month: 'short', day: 'numeric' })} ${hhmm(t)}`
}

export const hasRecentError = (s: AccountsState, now: number) => Boolean(s.lastError && now - s.lastError.at < RECENT_ERROR_MS)

/** A release is in flight when a PR into a production branch is open and not a draft. The swap and the warnings read this. */
export const releaseInFlight = (prs: ReadonlyArray<{ toProduction: boolean; isDraft: boolean; isBot: boolean }>) => prs.some(p => p.toProduction && !p.isDraft && !p.isBot)

// ---------- with `$` ----------

export async function initAccounts($: EngineInterface, o: Pick<AcctOptions, 'list' | 'notes' | 'home'>): Promise<void> {
  const cfg = parseAccountList(o.list, o.home)
  const notes = parseNotes(o.notes)
  const stored = ((await $.store.get(SEEN_KEY)) ?? {}) as Record<string, { kind: string; at: number }>
  await update($, accounts, s => ({
    ...s,
    seen: { ...stored, ...s.seen },
    rows: cfg.map(c => {
      const was = s.rows.find(r => r.label === c.label)
      return { label: c.label, dir: c.dir, reading: was?.reading, note: notes[c.label] }
    }),
  }))
}

/** Fold the engine's rate-limit windows in. Returns the toast to give, if one is due. */
export async function applyLimits($: EngineInterface, rateLimits: Parameters<typeof limitsOf>[0], now: number, o: AcctOptions, extra: { releaseInFlight: boolean; mainModel?: string }): Promise<void> {
  const limits = limitsOf(rateLimits)
  const before = await read($, accounts)
  const next: AccountsState = { ...before, limits: limits.length ? limits : before.limits, limitsAt: limits.length ? now : before.limitsAt }
  const warned = { ...before.warned }
  for (const l of limits) {
    const level = warnLevel(l.kind, l.percent, o)
    const key = `${level}@${l.resetsAt ?? ''}`
    if (level === 0) {
      delete warned[l.kind]
      continue
    }
    // Once per level per window: a new window (a new resetsAt) re-arms it.
    const was = warned[l.kind]
    if (was && was.split('@')[1] === (l.resetsAt ?? '') && Number(was.split('@')[0]) >= level) continue
    const { best, line } = swapCandidate(before.rows, before.self, o.autoPct ?? 94)
    const text = [
      `${limitName(l.kind)} ${l.percent}%${l.resetsAt ? `, resets ${fmtReset(l.resetsAt, now)}` : ''}.`,
      best ? `Best account to swap to: ${best.label}, ${best.reading?.week?.percent ?? '?'}%. Press a.` : before.rows.some(r => r.reading?.week) ? `No other account under ${line}%.` : 'No other account readable yet.',
      extra.releaseInFlight ? 'Release in flight: swap before or after the production step, not during.' : '',
      extra.mainModel && /opus/i.test(extra.mainModel) ? 'Or /model sonnet: the cache stays warm, a swap makes it cold.' : '',
    ].filter(Boolean).join(' ')
    if (limitToast($, text)) warned[l.kind] = key
  }
  await update($, accounts, () => ({ ...next, warned }))
}

/** A limit error from the API (`classic.StopFailure`). Remembered per account; returns the toast text. */
export async function recordError($: EngineInterface, kind: string, now: number, autoPct = 94): Promise<void> {
  if (!['rate_limit', 'overloaded', 'server_error', 'authentication_failed', 'billing_error'].includes(kind)) return
  const before = await read($, accounts)
  const mine = before.self?.email
  const seen = { ...before.seen }
  if (mine && kind !== 'overloaded' && kind !== 'server_error') seen[emailKey(mine)] = { kind, at: now }
  await update($, accounts, () => ({ ...before, lastError: { kind, at: now }, seen }))
  await $.store.set(SEEN_KEY, seen)
  const { best, line } = swapCandidate(before.rows, before.self, autoPct)
  const none = before.rows.some(r => r.reading?.week) ? `No other account under ${line}%.` : 'No other account readable yet.'
  const text = errorClears(kind)
    ? `${kind.replace('_', ' ')}: this clears by itself. Nothing to swap.`
    : errorNeedsAction(kind)
      ? `${kind.replace('_', ' ')}: this needs action.${best ? ` Best account to swap to: ${best.label}. Press a.` : ` ${none}`}`
      : ''
  if (text) limitToast($, text)
}

/** Who this session is signed in as, from the binary. */
export async function probeSelf($: EngineInterface, home: string, now: number): Promise<{ email?: string; orgId?: string } | null> {
  // The session's own folder: a session on an account slot is signed in there, not in ~/.claude.
  const configured = await $.env.get('CLAUDE_CONFIG_DIR')
  const who = await probeIdentity($, configured || undefined)
  if (!who) return null
  const dir = (configured ?? `${home}/.claude`).split('/').filter(Boolean).pop() ?? ''
  await update($, accounts, s => ({ ...s, self: { email: who.email, plan: who.plan, orgId: who.orgId, dir, at: now } }))
  return { email: who.email, orgId: who.orgId }
}

/** One row per call, the one read longest ago, no more often than the throttle. One account at a time. */
export async function probeNext($: EngineInterface, o: AcctOptions, now: number, force = false): Promise<boolean> {
  const state = await read($, accounts)
  if (!throttleOk(state.probeAt, now, Math.min(1, o.probeMinutes), force)) return false
  const due = state.rows
    .filter(r => throttleOk(r.reading?.at ?? 0, now, o.probeMinutes, force))
    .sort((a, b) => (a.reading?.at ?? 0) - (b.reading?.at ?? 0))[0]
  if (!due) return false
  await update($, accounts, s => ({ ...s, probeAt: now }))
  const reading = await probeAccount($, due.dir, due.reading, now)
  await update($, accounts, s => ({
    ...s,
    rows: s.rows.map(r => (r.label === due.label ? { ...r, reading: reading as AccountReading | undefined, note: reading && !reading.error && reading.week ? undefined : r.note } : r)),
  }))
  return true
}

export async function setMainModel($: EngineInterface, model: string | undefined, fellBack?: { from: string; to: string; at: number }): Promise<void> {
  await update($, accounts, s => ({ ...s, models: { main: model ?? s.models.main, fellBack: fellBack ?? s.models.fellBack } }))
}

export const rowsWithErrors = (state: AccountsState): AccountRow[] =>
  state.rows.map(r => {
    const email = r.reading?.email
    const seen = email ? state.seen[emailKey(email)] : undefined
    return seen && seen.kind === 'billing_error' && !r.reading?.week ? { ...r, reading: { ...(r.reading as AccountReading), error: 'billing_error' } } : r
  })

export { isOutOfCredits, rowFor }
