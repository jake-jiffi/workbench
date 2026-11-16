import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { AccountReading, HandoverState, SwapState, Worker } from '../../types'
import { bestAccount, emailKey, isSameAccount, rowFor } from './accounts'
import { releaseInFlight, probeNext, probeSelf, rowsWithErrors } from './acct'
import { AUTO_STALE_GIVE_UP_MS, alertKey, alertText, autoLine, decideAutoMove } from './automove'
import type { AutoVerdict } from './automove'
import type { AcctOptions } from './acct'
import { nextStep } from './github'
import { rootDir } from './workspace'

import { buildBrief, compactKeepList, doorCheck, validateBriefFiles } from './handover'
import type { BriefInput } from './handover'
import { limitToast } from './toastcap'
import { isEnded } from './tones'
import { openItems, scopeItems } from './undone'
import {
  EXIT_COMMAND, MODEL_COMMAND, MOVE_KEY, MOVE_MS, NEXT_STEP_PROMPT, HOLD_MS, WATCH_EVERY_MS, WATCH_MS, moveRequestPath,
  parseConnectorProbe, moveRoute, swapChecks,
} from './swap'

// The swap sheet's actions and the handover. Both only prepare and fill: the person presses Enter on /exit,
// /model and /clear. State is in atoms (so the pane redraws) and, for the brief, in the store.

const emptySwap = (): SwapState => ({ isOpen: false, isChoosing: false, armedAt: 0, watchUntil: 0, lastWatch: 0 })
const emptyHandover = (): HandoverState => ({ overrideAt: 0, armedAt: 0 })

// The engine's scan reads state from the file that uses it, so each file declares the atoms it touches,
// with the same key, default and shape as register.tsx.
const workers = atom({ plugin: 'workbench', key: 'workers' } as const, [], { shape: 'workers-2' })
const snapshot = atom({ plugin: 'workbench', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const undoneAtom = atom({ plugin: 'workbench', key: 'undone' } as const, [], { shape: 'undone-1' })
const accounts = atom({ plugin: 'workbench', key: 'accounts' } as const, { limits: [], limitsAt: 0, rows: [], seen: {}, warned: {}, probeAt: 0, models: {} }, { shape: 'accounts-1' })
const swap = atom({ plugin: 'workbench', key: 'swap' } as const, emptySwap(), { shape: 'swap-1' })
const handover = atom({ plugin: 'workbench', key: 'handover' } as const, emptyHandover(), { shape: 'handover-1' })

export type ControlCfg = {
  // autoMovePct (0: off): see automove.ts.
  auto: { pct: number }
  briefFiles: string
  finishSends: boolean
  handoverClear: boolean
  connectorProbe: string
  acct: AcctOptions
  // CLAUDE_WRAPPER_PID: the claude wrapper this session runs under, '' when started some other way.
  wrapperPid: string
}

/** A move can reopen the conversation by itself only under the wrapper. */
export const canMove = (cfg: ControlCfg) => Boolean(cfg.wrapperPid && cfg.acct.home)

type Moved = { label: string; session: string; fromEmail?: string; fromOrg?: string; at: number }

const BRIEF_KEY = 'brief.last'
const OVERRIDE_MS = 2 * 60_000
const DOUBLE_MS = 5_000
const READY_MS = 30 * 60_000

const parseList = (text: string) => text.split(/[,\n]/).map(s => s.trim()).filter(Boolean)

// ---------- the brief ----------

export async function gatherBrief($: EngineInterface, cfg: ControlCfg, o: { why: string; lastAsk: string; carried?: Array<{ id: string; why: string }>; watchers?: string[] }) {
  const now = await $.clock.now()
  const list = (await read($, workers)) as Worker[]
  const snap = await read($, snapshot)
  const sw = await read($, swap)
  const files = validateBriefFiles(parseList(cfg.briefFiles), rootDir())
  const prs = (snap?.prs ?? [])
    .filter(p => !p.isBot)
    .map(p => ({ p, step: nextStep(p) }))
    .sort((a, b) => a.step.rank - b.step.rank)
    .map(({ p, step }) => ({ app: p.app, number: p.number, base: p.base, label: step.label }))
  const changed = sw.changedAt !== undefined && now - sw.changedAt < 3_600_000 && sw.result
  const input: BriefInput = {
    now,
    why: o.why,
    files: files.ok,
    workers: list,
    prs,
    watchers: o.watchers ?? [],
    carried: o.carried ?? [],
    waiting: snap?.waiting ?? [],
    undone: scopeItems(await read($, undoneAtom), rootDir()).filter(i => i.status === 'open'),
    lastAsk: o.lastAsk,
    accountNote: changed ? `Account changed to ${changed.label}${changed.email ? ` (${changed.email})` : ''}. Re-run connector-dependent steps before relying on them.` : undefined,
  }
  return { input, text: buildBrief(input), rejected: files.rejected }
}

/** Build the brief and keep it in the store, so it exists whatever happens next. */
export async function saveBrief($: EngineInterface, cfg: ControlCfg, why: string, lastAsk = '', extra: { carried?: Array<{ id: string; why: string }>; watchers?: string[] } = {}) {
  const got = await gatherBrief($, cfg, { why, lastAsk, ...extra })
  const now = await $.clock.now()
  await $.store.set(BRIEF_KEY, { at: now, text: got.text })
  await update($, handover, h => ({ ...h, readyAt: now }))
  return got
}

export async function toolHandoverBrief($: EngineInterface, e: { last_ask?: unknown }, cfg: ControlCfg) {
  const got = await saveBrief($, cfg, 'asked for by Claude', String(e.last_ask ?? ''))
  const note = got.rejected.length ? `\n\n(briefFiles left out: ${got.rejected.join(', ')})` : ''
  return reply(got.text + note)
}

export async function toolHandoverClear($: EngineInterface, e: { last_ask?: unknown; carry?: unknown; watchers?: unknown }, cfg: ControlCfg) {
  const now = await $.clock.now()
  const carry = Array.isArray(e.carry) ? (e.carry as Array<{ id?: unknown; why?: unknown }>).map(c => ({ id: String(c.id ?? ''), why: String(c.why ?? '') })) : []
  const watchers = Array.isArray(e.watchers) ? (e.watchers as unknown[]).map(String) : []
  const state = await read($, handover)
  const snap = await read($, snapshot)
  const refusal = doorCheck({
    workers: (await read($, workers)) as Worker[],
    carry,
    prsToMain: (snap?.prs ?? []).filter(p => !p.isBot && p.toProduction && !p.isDraft).map(p => ({ app: p.app, number: p.number })),
    watchers,
    isOverridden: now - state.overrideAt < OVERRIDE_MS,
  })
  if (refusal) {
    $.ui.toast('Clear refused: work still running. See the reply.')
    return reply(refusal, true)
  }
  await saveBrief($, cfg, 'clearing and restarting', String(e.last_ask ?? ''), { carried: carry, watchers })
  await update($, handover, h => ({ ...h, queued: { at: now, step: 'queued' as const } }))
  return reply(cfg.handoverClear
    ? 'Queued. The clear runs when this turn ends; the brief is in the store and goes to the prompt box after it. A prompt from the owner cancels it.'
    : 'Queued. When this turn ends /clear is put in the prompt box for the owner to press Enter; the brief follows it. A prompt from the owner cancels it.')
}

/** The turn ended. A queued clear is offered, or run when the handoverClear setting is on. */
export async function runQueue($: EngineInterface, cfg: ControlCfg): Promise<void> {
  const state = await read($, handover)
  if (!state.queued || state.queued.step !== 'queued') return
  if (cfg.handoverClear) {
    await update($, handover, h => ({ ...h, queued: h.queued ? { ...h.queued, step: 'clear-run' as const } : h.queued }))
    await $.command.run({ command: 'clear' })
  } else {
    await $.prompt.fill({ text: '/clear', mode: 'replace' })
    await update($, handover, h => ({ ...h, queued: h.queued ? { ...h.queued, step: 'clear-filled' as const } : h.queued }))
    limitToast($, 'Handover saved. Press Enter to clear; the brief follows.')
  }
}

/** After a /clear: the saved brief goes to the prompt box (never straight to the model, unless finishSends). */
export async function deliverBrief($: EngineInterface, cfg: ControlCfg): Promise<void> {
  const state = await read($, handover)
  if (!state.queued) return
  const saved = (await $.store.get(BRIEF_KEY)) as { text?: string } | undefined
  await update($, handover, h => ({ ...h, queued: undefined }))
  if (!saved?.text) return
  if (cfg.finishSends) await $.prompt.submit({ text: saved.text })
  else await $.prompt.fill({ text: saved.text, mode: 'replace' })
}

/** A prompt from the owner cancels a queued clear. */
export async function cancelQueue($: EngineInterface): Promise<boolean> {
  const state = await read($, handover)
  if (!state.queued) return false
  await update($, handover, h => ({ ...h, queued: undefined }))
  $.ui.toast('Handover cancelled: you sent a prompt.')
  return true
}

/**
 * `b` on the context card. First press asks Claude to write the handover (fills the prompt, never sends it);
 * a second press within five seconds lifts the door for two minutes; with a brief waiting after a clear it
 * puts the brief in the prompt box.
 */
export async function pressHandover($: EngineInterface, cfg: ControlCfg, percent: number | undefined): Promise<void> {
  const now = await $.clock.now()
  const state = await read($, handover)
  if (state.armedAt > 0 && now - state.armedAt < DOUBLE_MS) {
    await update($, handover, h => ({ ...h, overrideAt: now, armedAt: 0 }))
    $.ui.toast('Door override on for 2 minutes.')
    return
  }
  const saved = (await $.store.get(BRIEF_KEY)) as { at?: number; text?: string } | undefined
  await update($, handover, h => ({ ...h, armedAt: now }))
  if (state.readyAt && now - state.readyAt < READY_MS && saved?.text && !state.queued && (percent === undefined || percent < 30)) {
    await $.prompt.fill({ text: saved.text, mode: 'replace' })
    return
  }
  await $.prompt.fill({
    text: `Context is ${percent ?? '?'}% full. Call handover_brief with last_ask (the last thing I asked, verbatim), then handover_clear, listing any running worker in carry and any PR watcher in watchers.`,
    mode: 'replace',
  })
}

/** "compact now": the keep list goes in as the summariser's instructions. */
export async function compactNow($: EngineInterface, cfg: ControlCfg): Promise<void> {
  const got = await gatherBrief($, cfg, { why: 'compacting', lastAsk: '' })
  await $.session.compact({ instructions: compactKeepList(got.input) })
}

// ---------- the swap sheet ----------

/** Open the sheet for the best other account, or for a chosen one. Also keeps the state in a brief first. */
export async function openSwap($: EngineInterface, cfg: ControlCfg, o: { choose?: boolean; label?: string } = {}): Promise<void> {
  const acc = await read($, accounts)
  const rows = rowsWithErrors(acc)
  const best = o.label ? rows.find(r => r.label === o.label) : bestAccount(rows, acc.self)
  await update($, swap, s => ({ ...s, isOpen: true, isChoosing: Boolean(o.choose), target: best?.label, armedAt: 0, result: undefined }))
  await saveBrief($, cfg, 'before an account swap').catch(() => null)
}

export async function closeSwap($: EngineInterface) {
  await update($, swap, s => ({ ...s, isOpen: false, isChoosing: false, armedAt: 0, result: undefined }))
}

export async function pickTarget($: EngineInterface, label: string) {
  await update($, swap, s => ({ ...s, target: label, isChoosing: false, armedAt: 0 }))
}

/**
 * What this module can see of the session between hooks, in memory (a reload starts it over, and it then reads
 * "not known" until the next Stop event, which holds an automatic move).
 */
export const live = {
  isTurnRunning: false,
  // From the last Stop or SubagentStop event: shells, monitors, subagents and scheduled wake-ups in flight.
  background: { known: false, tasks: 0, crons: 0 },
  isMoving: false,
  exitAskedAt: 0,
  staleSince: 0,
}

export function noteBackground(tasks: ReadonlyArray<{ status?: string }> | undefined, crons: ReadonlyArray<unknown> | undefined) {
  const open = (tasks ?? []).filter(t => !/^(completed|failed|killed|stopped|cancell?ed|done)$/i.test(t.status ?? ''))
  live.background = { known: true, tasks: open.length, crons: (crons ?? []).length }
  markAutoDirty()
}

export async function currentChecks($: EngineInterface, o: { workers?: Worker[]; target?: AccountReading } = {}) {
  const acc = await read($, accounts)
  const sw = await read($, swap)
  const target = o.target ?? rowsWithErrors(acc).find(r => r.label === sw.target)?.reading
  return swapChecks({
    workers: o.workers ?? ((await read($, workers)) as Worker[]),
    isRelease: releaseInFlight((await read($, snapshot))?.prs ?? []),
    selfOrg: acc.self?.orgId,
    target,
    background: live.background.known ? live.background : undefined,
  })
}

/** Leave the request the claude wrapper reads when this session exits, and keep the move for the reopened session. */
async function startMove($: EngineInterface, cfg: ControlCfg, label: string, now: number, isAuto: boolean): Promise<void> {
  const acc = await read($, accounts)
  const session = await $.session.id()
  const moved: Moved = { label, session, fromEmail: acc.self?.email, fromOrg: acc.self?.orgId, at: now }
  await $.store.set(MOVE_KEY, moved)
  await $.fs.write(moveRequestPath(cfg.acct.home, cfg.wrapperPid), JSON.stringify(isAuto ? { account: label, session, at: now, auto: true } : { account: label, session, at: now }))
}

/**
 * The move button. Held while a release or workers are at risk: the first press arms it, a second within
 * 60 seconds goes ahead. Going ahead leaves the request the claude wrapper reads when this session exits, keeps
 * the move in the store for the reopened session, and fills `/exit` (never submitted, whatever finishSends says).
 * Without the wrapper it only fills `/exit` and names how to move.
 */
export async function pressMove($: EngineInterface, cfg: ControlCfg): Promise<'moving' | 'filled' | 'armed' | 'none'> {
  const now = await $.clock.now()
  const sw = await read($, swap)
  const label = sw.target
  if (!label) return 'none'
  const checks = await currentChecks($)
  if (checks.isBlocked && !(sw.armedAt > 0 && now - sw.armedAt < HOLD_MS)) {
    await update($, swap, s => ({ ...s, armedAt: now }))
    return 'armed'
  }
  const isMoving = canMove(cfg)
  if (isMoving) await startMove($, cfg, label, now, false)
  await $.prompt.fill({ text: EXIT_COMMAND, mode: 'replace' })
  await update($, swap, s => ({ ...s, armedAt: 0, movedAt: now }))
  $.ui.toast(isMoving ? `Press Enter: this conversation reopens on ${label}.` : `Press Enter on /exit, then ${moveRoute(label)}.`)
  return isMoving ? 'moving' : 'filled'
}

/** A click on an account row: straight to the move when nothing is at risk, else the sheet with its hold. */
export async function moveTo($: EngineInterface, cfg: ControlCfg, label: string) {
  await openSwap($, cfg, { label })
  if ((await currentChecks($)).isBlocked) return 'held'
  return pressMove($, cfg)
}

/**
 * On the start that reopens a moved conversation (same session id, soon after the press), watch for the new
 * account as a sign-in used to: the next turn start announces it and runs the post-check. A stale move is dropped.
 */
export async function resumeMove($: EngineInterface): Promise<boolean> {
  const moved = (await $.store.get(MOVE_KEY)) as Moved | undefined
  if (!moved) return false
  const now = await $.clock.now()
  if (now - moved.at > 2 * MOVE_MS) {
    await $.store.delete(MOVE_KEY)
    return false
  }
  if (moved.session !== (await $.session.id())) return false
  await $.store.delete(MOVE_KEY)
  await update($, swap, s => ({ ...s, target: moved.label, watchUntil: now + WATCH_MS, lastWatch: 0, fromEmail: moved.fromEmail ?? '', fromOrg: moved.fromOrg }))
  return true
}

export async function pressModel($: EngineInterface, model = '') {
  await $.prompt.fill({ text: model ? `${MODEL_COMMAND} ${model}` : MODEL_COMMAND, mode: 'replace' })
}

export const isWatching = (sw: SwapState, now: number) => sw.watchUntil > now && sw.fromEmail !== undefined

/**
 * Poll the account every 15 seconds while the watch is on, and once on the next turn start. The change is
 * announced only when the binary reports a different email: never because the prompt was filled.
 */
export async function watchSwap($: EngineInterface, cfg: ControlCfg, o: { force?: boolean } = {}): Promise<boolean> {
  const now = await $.clock.now()
  const sw = await read($, swap)
  if (!isWatching(sw, now)) return false
  if (!o.force && now - sw.lastWatch < WATCH_EVERY_MS) return false
  await update($, swap, s => ({ ...s, lastWatch: now }))
  const who = await probeSelf($, cfg.acct.home, now)
  if (!who?.email || isSameAccount(who, { email: sw.fromEmail, orgId: sw.fromOrg })) return false
  await onSwapped($, cfg, sw)
  return true
}

async function onSwapped($: EngineInterface, cfg: ControlCfg, before: SwapState): Promise<void> {
  const now = await $.clock.now()
  const acc = await read($, accounts)
  const row = rowFor(rowsWithErrors(acc), acc.self)
  const label = row?.label ?? before.target ?? 'an account not in your list'
  const wk = row?.reading?.week?.percent
  const lines: Array<{ text: string; isProblem: boolean }> = []

  const probe = parseConnectorProbe(cfg.connectorProbe)
  if (probe) {
    try {
      await $.mcp.call(probe.server, probe.tool, {})
      lines.push({ text: `${probe.server} answered.`, isProblem: false })
    } catch {
      lines.push({ text: `${probe.server} did not answer: reconnect it.`, isProblem: true })
    }
  } else {
    lines.push({ text: 'Connector check is off (set connectorProbe to server|tool). Check your connectors by hand.', isProblem: false })
  }
  try {
    await $.fs.read(`${rootDir()}/.claude/memory/MEMORY.md`)
    lines.push({ text: 'Memory folder resolves.', isProblem: false })
  } catch {
    lines.push({ text: 'The memory folder did not resolve. Check autoMemoryDirectory.', isProblem: true })
  }

  const isCross = !(before.fromOrg && acc.self?.orgId && before.fromOrg === acc.self.orgId)
  await update($, swap, s => ({ ...s, watchUntil: 0, changedAt: now, result: { label, email: acc.self?.email, lines } }))
  $.ui.toast(`Now on ${label}${wk !== undefined ? ` (${wk}%)` : ''}.${isCross ? ' Connectors may be gone.' : ''}`)
  if (isCross) {
    const text = NEXT_STEP_PROMPT(label)
    if (cfg.finishSends) await $.prompt.submit({ text })
    else await $.prompt.fill({ text, mode: 'replace' })
  }
}

// ---------- tagging worker failures after a swap ----------

export async function tagAccountFailure($: EngineInterface, agentId: string, now: number): Promise<boolean> {
  const sw = await read($, swap)
  if (sw.changedAt === undefined || now - sw.changedAt >= 5 * 60_000) return false
  await update($, workers, list => list.map(w => (w.id === agentId ? { ...w, tag: 'account' as const } : w)))
  return true
}

// ---------- the automatic move ----------

const ALERTED_KEY = 'automove.alerted'
const LAST_KEY = 'automove.last'
// After asking the engine to run /exit, how long before the move is treated as not having happened.
const EXIT_WAIT_MS = 20_000
const PR_STALE_MS = 10 * 60_000

type Evaluated = { verdict: AutoVerdict; selfKey: string; selfLabel?: string; isCached?: boolean; key?: string }

// U188: while a meter is over the line and a move is held, the full evaluation (agent list, store, prompt box) is
// kept for this long. It is dropped at once when a limit, the pull requests or the accounts change (they are in the
// key), and by markAutoDirty() on a turn, a background, an agent or a prompt event. Unchanged held states that
// cannot be seen as an event (the person emptying the prompt box) are noticed within this time.
export const HELD_EVAL_MS = 5_000
let held: { at: number; key: string; evaluated: Evaluated } | undefined
// The held evaluation the per-second tick has already acted on (alerted, probed). The card's own look at it does not count.
let tickedKey: string | undefined

/** A turn, background task, agent or prompt event happened: the next evaluation reads everything again. */
export function markAutoDirty() {
  held = undefined
  tickedKey = undefined
}

/** Read everything the decision needs, but only once a meter is at the line. Reads and returns; changes nothing. */
export async function evaluateAuto($: EngineInterface, cfg: ControlCfg, now: number): Promise<Evaluated> {
  const acc = await read($, accounts)
  const rows = rowsWithErrors(acc)
  const base = {
    pct: cfg.auto.pct,
    now,
    limits: acc.limits,
    self: acc.self,
    rows,
    probeMinutes: cfg.acct.probeMinutes,
  }
  const selfKey = acc.self?.email ? `${emailKey(acc.self.email)}${acc.self.orgId ? `.${acc.self.orgId.slice(0, 8)}` : ''}` : 'unknown'
  const selfLabel = rowFor(rows, acc.self)?.label
  const idle = { canMove: false, isTurnRunning: false, promptText: '', checks: swapChecks({ workers: [], isRelease: false }), prState: 'ok' as const, background: { known: true, tasks: 0, crons: 0 }, lastMoveAt: 0, staleGiveUp: false }
  // Quick exit while nothing is at the line: this runs every second.
  const quick = decideAutoMove({ ...base, ...idle })
  if (quick.kind === 'off' || quick.kind === 'below') return { verdict: quick, selfKey, selfLabel }

  // Held and nothing the decision reads has changed: reuse the last evaluation (5 seconds at most).
  const snapNow = await read($, snapshot)
  const key = [
    selfKey,
    quick.kind === 'hold' ? `${quick.hit.kind}@${quick.hit.resetsAt ?? ''}:${quick.hit.percent}` : '',
    rows.map(r => `${r.label}:${r.reading?.at ?? 0}:${r.reading?.error ?? ''}:${r.note ?? ''}`).join(','),
    `${snapNow?.at ?? 0}:${snapNow?.error ?? ''}`,
  ].join('|')
  if (held && held.key === key && now >= held.at && now - held.at < HELD_EVAL_MS) return { ...held.evaluated, isCached: true }

  let workersNow = (await read($, workers)) as Worker[]
  try {
    workersNow = (await $.agent.list()).map(a => ({ id: a.id, description: a.description, type: a.type, status: a.status, startedAt: 0 }))
  } catch {}
  const snap = snapNow
  let promptText: string | undefined
  try {
    promptText = (await $.prompt.read()).text
  } catch {}
  const last = (await $.store.get(LAST_KEY)) as { at?: number } | undefined
  const verdict = decideAutoMove({
    ...base,
    canMove: canMove(cfg),
    isTurnRunning: live.isTurnRunning,
    promptText,
    checks: await currentChecks($, { workers: workersNow }),
    prState: snap && !snap.error && now - snap.at < PR_STALE_MS ? 'ok' : 'unknown',
    background: live.background,
    lastMoveAt: last?.at ?? 0,
    staleGiveUp: live.staleSince > 0 && now - live.staleSince > AUTO_STALE_GIVE_UP_MS,
  })
  const evaluated = { verdict, selfKey, selfLabel, key }
  // A wait for readings (stale) polls the probe each tick, and a move is acted on at once: neither is held.
  held = verdict.kind === 'hold' && verdict.code !== 'stale' ? { at: now, key, evaluated } : undefined
  return evaluated
}

/** The line on the Accounts card. */
export async function autoStatus($: EngineInterface, cfg: ControlCfg): Promise<{ text: string; isHeld: boolean }> {
  const { verdict } = await evaluateAuto($, cfg, await $.clock.now())
  return autoLine(verdict, cfg.auto.pct)
}

async function alertOnce($: EngineInterface, key: string, text: string, now: number): Promise<void> {
  const seen = ((await $.store.get(ALERTED_KEY)) ?? {}) as Record<string, number>
  if (seen[key] !== undefined) return
  const kept = Object.fromEntries(Object.entries({ ...seen, [key]: now }).filter(([, at]) => now - at < 8 * 86_400_000).slice(-40))
  await $.store.set(ALERTED_KEY, kept)
  $.ui.toast(text)
  void $.ui.notify(text, { title: 'Workbench' })
}

/**
 * Ask the engine to run /exit. Returns false when no supported call exists in this session. `$.command.run` is the
 * documented way to run a slash command "as if the person typed it"; whether /exit is one of them is read from
 * `$.command.list()` at run time, never assumed.
 */
async function submitExit($: EngineInterface): Promise<boolean> {
  try {
    const names = (await $.command.list()).map(c => c.name)
    const name = ['exit', 'quit'].find(n => names.includes(n))
    if (!name) return false
    await $.command.run({ command: name })
    return true
  } catch {
    return false
  }
}

/** The fallback: /exit in the prompt box (only when it is still empty) and a notification to press Enter. */
async function fillExit($: EngineInterface, label: string): Promise<void> {
  let isEmpty = false
  try {
    isEmpty = (await $.prompt.read()).text.trim() === ''
  } catch {}
  if (isEmpty) await $.prompt.fill({ text: EXIT_COMMAND, mode: 'replace' })
  const text = `Moving to ${label} at the limit. Press Enter on /exit: this conversation reopens there.`
  $.ui.toast(text)
  void $.ui.notify(text, { title: 'Workbench' })
}

/**
 * Once a second. At the line and clear of every hold, move: leave the request (marked `auto`), then run /exit.
 * Never the two-press arm of pressMove: a hold means no move. A hold that cannot clear by itself is told to the owner
 * once per account per window; the rest only show on the card.
 */
export async function autoMoveTick($: EngineInterface, cfg: ControlCfg): Promise<string> {
  const now = await $.clock.now()
  if (live.isMoving) {
    // /exit was asked for and this session is still here: it did not run. Fall back to the prompt box, once.
    if (live.exitAskedAt > 0 && now - live.exitAskedAt > EXIT_WAIT_MS) {
      live.exitAskedAt = 0
      const moved = (await $.store.get(MOVE_KEY)) as Moved | undefined
      await fillExit($, moved?.label ?? 'the other account')
      live.isMoving = false
    }
    return 'moving'
  }
  const { verdict, selfKey, isCached, key } = await evaluateAuto($, cfg, now)
  // The same held state, already alerted and already on the card: nothing more to read or tell.
  if (isCached && verdict.kind === 'hold' && key !== undefined && key === tickedKey) return autoLine(verdict, cfg.auto.pct).text
  tickedKey = verdict.kind === 'hold' && verdict.code !== 'stale' ? key : undefined
  if (verdict.kind === 'hold' && verdict.code === 'stale') {
    if (live.staleSince === 0) live.staleSince = now
    await probeNext($, cfg.acct, now).catch(() => false)
  } else {
    live.staleSince = 0
  }
  if (verdict.kind === 'hold' && verdict.alert) await alertOnce($, alertKey(selfKey, verdict.hit, now), alertText(cfg.auto.pct, verdict.hit, verdict.reason), now)
  // What the card line says, so the caller can redraw the pane when it changes.
  const sig = autoLine(verdict, cfg.auto.pct).text
  if (verdict.kind !== 'move') return sig

  // Idle again, right before acting: the checks above took a few awaits.
  let promptText: string | undefined
  try {
    promptText = (await $.prompt.read()).text
  } catch {}
  if (live.isTurnRunning || promptText === undefined || promptText.trim() !== '') return sig

  live.isMoving = true
  try {
    const acc = await read($, accounts)
    await $.store.set(LAST_KEY, { at: now, to: verdict.label, from: rowFor(rowsWithErrors(acc), acc.self)?.label ?? '' })
    await startMove($, cfg, verdict.label, now, true)
    const text = `${verdict.hit.kind === 'seven_day' ? 'Week' : '5-hour'} at ${verdict.hit.percent}%: moving to ${verdict.label}.`
    if (await submitExit($)) {
      live.exitAskedAt = now
      $.ui.toast(text)
      void $.ui.notify(text, { title: 'Workbench' })
    } else {
      await fillExit($, verdict.label)
      live.isMoving = false
    }
  } catch {
    live.isMoving = false
  }
  return sig
}

// Literal isError, so the engine's ToolCallResult union accepts it. On success isError is left out, which the engine reads as false.
const reply = (text: string, isError = false) => (isError ? { result: text, isError: true as const } : { result: text })

export { isEnded }
