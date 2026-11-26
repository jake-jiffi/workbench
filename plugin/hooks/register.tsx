import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AccountsState, CacheState, CWorker, HandoverState, HiddenAt, SwapState, Snapshot, UndoneStore, Worker } from '../types'
import { captureEdit, captureTask, captureTurn, takePendingAdds } from './lib/capture'
import { ci, currentApps, nextStep, readRepo, readWaiting } from './lib/github'
import { isEnded, QUIET_MS } from './lib/tones'
import type { AcctOptions } from './lib/acct'
import { applyLimits, initAccounts, probeNext, probeSelf, recordError, releaseInFlight, setMainModel, emptyAccounts } from './lib/acct'
import { accountsCard } from './lib/accountsview'
import { limitToast, resetToastCap } from './lib/toastcap'
import { band } from './lib/band'
import { CW_POLL_MS, isReadDue, readCWorkers } from './lib/cworkers'
import { autoMoveTick, markAutoDirty, autoStatus, canMove, cancelQueue, closeSwap, compactNow, currentChecks, deliverBrief, live, moveTo, noteBackground, openSwap, pickTarget, pressHandover, pressModel, pressMove, resumeMove, runQueue, tagAccountFailure, toolHandoverBrief, toolHandoverClear, watchSwap } from './lib/control'
import { parseAutoPct } from './lib/automove'
import type { ControlCfg } from './lib/control'
import { familyOf, modelSummary } from './lib/models'
import { isAccountFailure } from './lib/swap'
import { swapCard } from './lib/swapview'
import { hasRisenSince, hasSomething, hiddenAtOf, statusText, summarize } from './lib/summary'
import { cacheView, cacheLabelMs, measureUsage, noteTurn, refreshUsage, resetCache, resetUsageLevel } from './lib/usage'
import { alertCard, cacheCard, contextCard, costLine } from './lib/usageview'
import { ensureLoaded, loadStore, mutate, readItems } from './lib/store'
import { PROMPT_SECTION, TOOL_ADD, TOOL_BRIEF, TOOL_CLEAR, TOOL_LIST, TOOL_RESOLVE, registerTools, toolAdd, toolList, toolResolve } from './lib/tools'
import { dropAllOpen, dropItem, finishRequest, flagGonePrs, reopenable, reopenItem, resolveItem, scopeItems } from './lib/undone'
import { footerRow, makeCtx, prsCard, productionCard, undoneCard, waitingCard, workersCard } from './lib/view'
import { findWorkspace, isAutoInitOn, isEligibleEmpty, rootDir, ws } from './lib/workspace'
import type { Workspace } from './lib/workspace'

// One view for the orchestrator session of a workbench workspace (a folder holding workbench.json): the workers it
// spawned, every open PR and its CI across the workspace's apps, how far each app's integration branch is ahead of
// production, and what notes/STATE.md says is waiting on the owner. Outside a workspace the mod does nothing.

const PANE = 'workbench'
const TITLE = 'Workbench'
const WATCH_MS = 15_000
const WORKER_POLL_MS = 5_000
// How long a spawned worker may be missing from the engine's agent list before it counts as gone.
const UNLISTED_GRACE_MS = 2 * 60_000
const GITHUB_POLL_MS = 90_000

// The atoms are declared here: the engine's scan reads state from the file that declares it.
const workers = atom({ plugin: 'workbench', key: 'workers' } as const, [], { shape: 'workers-2' })
const cworkers = atom({ plugin: 'workbench', key: 'cworkers' } as const, [] as CWorker[], { shape: 'cworkers-1' })
const snapshot = atom({ plugin: 'workbench', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
// Where the counts stood when Hide was pressed; the band stays hidden until one of them goes up.
const bandHiddenAt = atom({ plugin: 'workbench', key: 'bandHiddenAt' } as const, null as HiddenAt | null, { shape: 'band-hide-1' })
const tick = atom({ plugin: 'workbench', key: 'tick' } as const, 0)
// New atoms need a `shape` string, bumped when their type changes (as `workers-2` was).
const undoneAtom = atom({ plugin: 'workbench', key: 'undone' } as const, [], { shape: 'undone-1' })
atom({ plugin: 'workbench', key: 'tasksOpen' } as const, [], { shape: 'tasks-1' })
const undoneUi = atom({ plugin: 'workbench', key: 'undoneUi' } as const, { help: false, resolvedOpen: false, clearArmedAt: 0 }, { shape: 'undone-ui-1' })
const CLEAR_WINDOW_MS = 3_000
const usage = atom({ plugin: 'workbench', key: 'usage' } as const, null, { shape: 'usage-1' })
const cache = atom({ plugin: 'workbench', key: 'cache' } as const, { lastAt: null, lastContext: 0, isObserved: false, read: 0, total: 0 } as CacheState, { shape: 'cache-1' })
const accounts = atom({ plugin: 'workbench', key: 'accounts' } as const, emptyAccounts() as AccountsState, { shape: 'accounts-1' })
const swapAtom = atom({ plugin: 'workbench', key: 'swap' } as const, { isOpen: false, isChoosing: false, armedAt: 0, watchUntil: 0, lastWatch: 0 } as SwapState, { shape: 'swap-1' })
const handoverAtom = atom({ plugin: 'workbench', key: 'handover' } as const, { overrideAt: 0, armedAt: 0 } as HandoverState, { shape: 'handover-1' })
const contextUi = atom({ plugin: 'workbench', key: 'contextUi' } as const, { showAll: false }, { shape: 'ctx-ui-1' })

// Module memory: lost on reload, which only costs a refresh.
const lastActive = new Map<string, number>()
let isRefreshing = false
let refreshSoon: { cancel(): void } | undefined

// Tell the owner about changes worth their attention. Toasts for everything, a native
// notification for what needs them, since the phone and Remote Control draw no mods.
function announce($: EngineInterface, before: Snapshot, after: Snapshot) {
  const old = new Map(before.prs.map(p => [`${p.app}#${p.number}`, p]))
  const now = new Set(after.prs.map(p => `${p.app}#${p.number}`))
  for (const pr of after.prs) {
    if (pr.isBot) continue
    const id = `${pr.app} #${pr.number}`
    const was = old.get(`${pr.app}#${pr.number}`)
    if (!was) {
      $.ui.toast(`${id} opened into ${pr.base}: ${pr.title}`)
      continue
    }
    const [from, to] = [ci(was.checks), ci(pr.checks)]
    if (from !== 'red' && to === 'red') void $.ui.notify(`${id}: CI failed`, { title: 'Workbench' })
    else if (from !== 'green' && to === 'green') $.ui.toast(`${id}: CI green`)
    if (was.review !== pr.review && pr.review === 'APPROVED') void $.ui.notify(`${id} approved: ${pr.title}`, { title: 'Workbench' })
    if (was.review !== pr.review && pr.review === 'CHANGES_REQUESTED') void $.ui.notify(`${id}: changes requested`, { title: 'Workbench' })
  }
  for (const [key, pr] of old) if (!now.has(key)) $.ui.toast(`${pr.app} #${pr.number} merged or closed`)
}

async function refresh($: EngineInterface) {
  if (dormant() || isRefreshing) return
  isRefreshing = true
  try {
    const before = await read($, snapshot)
    const at = await $.clock.now()
    const waiting = await readWaiting($)
    try {
      const repos = await Promise.all(currentApps().map(app => readRepo($, app)))
      const failed = repos.find(r => r.prError)
      // An app whose PR list could not be read keeps the PRs it last had; the error is shown in the foot.
      const after: Snapshot = {
        prs: repos.flatMap(r => r.prs ?? (before?.prs ?? []).filter(p => p.app === r.app)),
        releases: repos.map(r => r.release),
        waiting,
        at,
        ...(failed ? { error: failed.prError } : {}),
      }
      if (before && !before.error && !failed) {
        announce($, before, after)
        const open = new Set(after.prs.map(p => `${p.app}#${p.number}`))
        const gone = before.prs.map(p => `${p.app}#${p.number}`).filter(k => !open.has(k))
        if (gone.length) await mutate($, at, s => ({ store: flagGonePrs(s, gone, rootDir()), result: 0 })).catch(() => {})
      }
      await update($, snapshot, () => after)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await update($, snapshot, last => ({ prs: last?.prs ?? [], releases: last?.releases ?? [], waiting, at, error: message }))
    }
  } catch {
    // A failed read must never become an unhandled rejection; the next poll tries again.
  } finally {
    isRefreshing = false
    await updateStatus($).catch(() => {})
  }
}

async function syncWorkers($: EngineInterface) {
  if (dormant()) return
  const agents = await $.agent.list()
  // A list that cannot be read says nothing about who stopped.
  if (!Array.isArray(agents)) return
  const now = await $.clock.now()
  const finished: Worker[] = []
  await update($, workers, list => {
    finished.length = 0
    const byId = new Map(list.map(w => [w.id, w]))
    const listed = new Set(agents.map(a => a.id))
    // A worker the engine no longer lists has ended: a stopped one drops out of the list, and its last status would
    // otherwise read "running" for ever. One just spawned gets a grace period, since the spawn is recorded before the
    // engine lists it. No toast: it may only be a blip, and the next read puts it back if it is listed again.
    for (const w of list) {
      if (listed.has(w.id) || isEnded(w.status)) continue
      if (w.startedAt > 0 && now - w.startedAt < UNLISTED_GRACE_MS) continue
      byId.set(w.id, { ...w, status: 'gone', endedAt: now })
    }
    for (const agent of agents) {
      const was = byId.get(agent.id)
      // Seen first here (not at spawn), its start time is unknown: 0, and the row shows no age.
      const base: Worker = was ?? { id: agent.id, description: agent.description, type: agent.type, status: agent.status, startedAt: 0 }
      const ended = isEnded(agent.status)
      const worker: Worker = {
        ...base,
        description: agent.description,
        type: agent.type,
        status: agent.status,
        endedAt: ended ? (base.endedAt ?? now) : undefined,
        lastActiveAt: lastActive.get(agent.id) ?? base.lastActiveAt,
      }
      if (was && !isEnded(was.status) && ended) finished.push(worker)
      byId.set(agent.id, worker)
    }
    return [...byId.values()].slice(-40)
  })
  for (const w of finished) {
    // A named builder that went idle has finished its work, the same as a completed one.
    if (w.status === 'completed' || w.status === 'idle') $.ui.toast(`Done: ${w.description}`)
    else void $.ui.notify(`Worker ${w.status}: ${w.description}`, { title: 'Workbench' })
  }
  if (agents.some(a => !isEnded(a.status))) await update($, tick, n => n + 1)
  await updateStatus($).catch(() => {})
}

function scheduleRefresh($: EngineInterface) {
  refreshSoon?.cancel()
  refreshSoon = $.clock.after(5_000, () => void refresh($))
}

// Set by register() from the manifest's options; hooks read it at call time.
const settings = {
  isAutoOpen: true,
  finishSends: false,
  ttl: '5m',
  th: { warn: 60, urgent: 80 },
  acct: { list: '', notes: '', probeMinutes: 5, warn: 80, urgent: 95, weekWarn: 90, home: '', autoPct: 94 } as AcctOptions,
  control: { auto: { pct: 94 }, briefFiles: '', finishSends: false, handoverClear: false, connectorProbe: '', acct: { list: '', notes: '', probeMinutes: 5, warn: 80, urgent: 95, weekWarn: 90, home: '' } } as ControlCfg,
}

// Set at session.start when this copy of the mod was started by its own probe (see lib/probe.ts): it does nothing.
const guard = { isProbe: false }

// What the mod knows about where it runs. `cwd` is the folder the session started in, until a tick reads the live one.
// `isActive`: the workspace work (timers, first reads) has been started. `toolsOn`: the model's tools were registered
// at session start, which happens only in a workspace or an empty folder the auto-init hook would turn into one.
const gate = { cwd: '', isActive: false, toolsOn: false, isWatching: false }

/** True outside a workspace and in the usage probe's own copy: every hook then passes straight through. */
const dormant = () => guard.isProbe || !ws.current

// Whether the pane is docked (the cache countdown then counts by the second), and what the timer last drew.
const timer = { lastBandAt: 0, lastCwAt: 0, isReadingCw: false, lastDrawAt: 0, lastProbeCheck: 0, lastSelfProbe: 0, isPanePlaced: false, lastLabel: -1, lastState: '', lastStatus: undefined as string | undefined, ticks: 0, lastAutoLine: '' }

async function change($: EngineInterface, fn: (store: UndoneStore, now: number) => UndoneStore) {
  const now = await $.clock.now()
  await mutate($, now, store => ({ store: fn(store, now), result: 0 }))
}

// "Ask Claude to finish": fills the prompt box and never sends it, unless the finishSends setting is on.
async function finish($: EngineInterface) {
  const store = await loadStore($)
  const mine = { items: scopeItems(store.items, rootDir()) }
  if (!mine.items.some(i => i.status === 'open')) return
  const text = finishRequest(mine)
  if (settings.finishSends) await $.prompt.submit({ text })
  else await $.prompt.fill({ text, mode: 'replace' })
}

// "Clear all" needs a second press within three seconds, so a stray key cannot wipe a week of commitments.
async function clearAll($: EngineInterface) {
  const now = await $.clock.now()
  const view = await read($, undoneUi)
  if (view.clearArmedAt > 0 && now - view.clearArmedAt < CLEAR_WINDOW_MS) {
    await update($, undoneUi, v => ({ ...v, clearArmedAt: 0 }))
    await change($, (store, at) => dropAllOpen(store, at, rootDir()))
    return
  }
  await update($, undoneUi, v => ({ ...v, clearArmedAt: now }))
  try {
    $.clock.after(CLEAR_WINDOW_MS, () => void update($, undoneUi, v => (v.clearArmedAt === now ? { ...v, clearArmedAt: 0 } : v)).catch(() => {}))
  } catch {}
}

// claude-worker's workers, read from ~/.claude/workers/w/<id>/ about every 15 seconds, and only while the pane is
// docked or was drawn in the last two minutes, or the band was last asked for in that time. View only.
async function cwTick($: EngineInterface, now: number, force = false) {
  if (dormant() || timer.isReadingCw) return
  if (!isReadDue({ isPlaced: timer.isPanePlaced, lastDrawAt: timer.lastDrawAt, lastBandAt: timer.lastBandAt, lastReadAt: timer.lastCwAt, now, force })) return
  timer.isReadingCw = true
  timer.lastCwAt = now
  try {
    const next = await readCWorkers($, settings.acct.home, now)
    // Only a change redraws.
    await update($, cworkers, was => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
    await updateStatus($).catch(() => {})
  } catch {
    // A failed read is skipped; the next one tries again.
  } finally {
    timer.isReadingCw = false
  }
}

// The counts the band and the status line share.
async function sumNow($: EngineInterface, ttl: string = settings.ttl, th: { warn: number; urgent: number } = settings.th) {
  const now = await $.clock.now()
  const open = scopeItems(await read($, undoneAtom), rootDir()).filter(i => i.status === 'open').length
  return summarize({
    workers: await read($, workers),
    cworkers: await read($, cworkers),
    snap: await read($, snapshot),
    undoneOpen: open,
    usage: await read($, usage),
    cache: await read($, cache),
    accounts: await read($, accounts),
    acctTh: settings.acct,
    ttl,
    th,
    now,
  })
}

// One string in the status line, set only when it changed.
async function updateStatus($: EngineInterface) {
  if (dormant()) return
  const sum = await sumNow($)
  const text = statusText(sum, timer.isPanePlaced)
  if (text === timer.lastStatus) return
  timer.lastStatus = text
  $.ui.status(text)
}

// "refresh accounts": read this session's account and every known account now, one at a time.
async function refreshAccounts($: EngineInterface) {
  const now = await $.clock.now()
  await probeSelf($, settings.acct.home, now).catch(() => null)
  const rows = (await read($, accounts)).rows
  for (let i = 0; i < rows.length; i++) await probeNext($, settings.acct, await $.clock.now(), true).catch(() => false)
}

// Reads the accounts in the background, only while the pane is on screen (docked, or drawn in the last two
// minutes) or a warning is live, and no more often than the probe interval.
async function acctTick($: EngineInterface, now: number) {
  await watchSwap($, settings.control).catch(() => false)
  const state = await read($, accounts)
  const isWarning = state.limits.some(l => l.percent >= settings.acct.warn)
  const isLive = timer.isPanePlaced || now - timer.lastDrawAt < 120_000 || isWarning
  if (!isLive || now - timer.lastProbeCheck < 5_000) return
  timer.lastProbeCheck = now
  if (now - timer.lastSelfProbe >= settings.acct.probeMinutes * 60_000) {
    timer.lastSelfProbe = now
    await probeSelf($, settings.acct.home, now)
  }
  await probeNext($, settings.acct, now)
}

// Once a second, but it only redraws when what is shown changed: by the second in the last minute or while the
// pane is docked, by ten seconds otherwise, and once more when the cache goes cold.
async function cacheTick($: EngineInterface, ttl: string) {
  if (dormant()) return
  timer.ticks += 1
  if (timer.ticks % 10 === 0) await ensureLoaded($).catch(() => {})
  await updateStatus($).catch(() => {})
  await acctTick($, await $.clock.now()).catch(() => {})
  const line = await autoMoveTick($, settings.control).catch(() => '')
  if (line !== timer.lastAutoLine) {
    timer.lastAutoLine = line
    await update($, tick, n => n + 1)
  }
  const state = await read($, cache)
  const now = await $.clock.now()
  const v = cacheView(state, ttl, now)
  const label = v.state === 'warm' ? cacheLabelMs(v.leftMs, timer.isPanePlaced) : -1
  if (label === timer.lastLabel && v.state === timer.lastState) return
  timer.lastLabel = label
  timer.lastState = v.state
  if (v.state === 'none' || v.state === 'unknown') return
  await update($, tick, n => n + 1)
}

// Start the work of a workspace: the polling timers, the first reads, the pane. Once per module load. It runs at
// session start inside a workspace, and later from the watch tick when a marker appears under the session.
async function activate($: EngineInterface) {
  const { ttl, th, isAutoOpen } = settings
  if (gate.isActive) return
  gate.isActive = true
  markAutoDirty()
  await resumeMove($).catch(() => false)
  $.clock.every(WORKER_POLL_MS, () => void syncWorkers($).catch(() => {}))
  $.clock.every(CW_POLL_MS, () => void $.clock.now().then(now => cwTick($, now)).catch(() => {}))
  $.clock.every(GITHUB_POLL_MS, () => void refresh($))
  void ensureLoaded($).catch(() => {})
  void refresh($)
  // One read now so the first draw has them; after that the 15-second tick, only while the pane or band is shown.
  void $.clock.now().then(now => cwTick($, now, true)).catch(() => {})
  $.clock.every(1_000, () => void cacheTick($, ttl).catch(() => {}))
  void refreshUsage($, th, { force: true }).catch(() => {})
  if (isAutoOpen) void $.ui.open({ id: PANE, title: TITLE }).then(r => { timer.isPanePlaced = Boolean(r?.isPlaced) }).catch(() => {})
  void (async () => {
    await setMainModel($, await $.session.model().catch(() => undefined))
    await initAccounts($, settings.acct)
    await probeSelf($, settings.acct.home, await $.clock.now())
  })().catch(() => {})
}

// Where is the session now, and is it in a workspace? Sets `ws.current`, wakes the mod when a marker has appeared,
// and puts it back to sleep (status line cleared) when the session has moved out. A changed workbench.json
// (an app added, a new owner) is picked up here too.
async function look($: EngineInterface): Promise<Workspace | null> {
  const cwd = await $.session.cwd().catch(() => gate.cwd)
  const found = await findWorkspace($, cwd || gate.cwd).catch(() => null)
  const was = ws.current
  ws.current = found
  if (!found) {
    if (was) {
      timer.lastStatus = undefined
      $.ui.status(undefined)
    }
    return null
  }
  if (!gate.isActive) await activate($)
  else if (!was || JSON.stringify(was) !== JSON.stringify(found)) void refresh($)
  return found
}


export const register: Register = (on, options) => {
  const opts = { retentionDays: Number(options?.undoneRetentionDays ?? 14) || 14 }
  settings.finishSends = options?.finishSends === true
  const th = { warn: Number(options?.warnPercent ?? 60) || 60, urgent: Number(options?.urgentPercent ?? 80) || 80 }
  const ttl = options?.cacheTtl === '5m' ? '5m' : '1h'
  settings.ttl = ttl
  settings.th = th
  const isAutoOpen = options?.autoOpen !== false
  settings.isAutoOpen = isAutoOpen
  settings.acct = {
    list: String(options?.accounts ?? ''),
    notes: String(options?.accountNotes ?? ''),
    probeMinutes: Number(options?.usageProbeMinutes ?? 15) || 15,
    warn: Number(options?.usageWarnPercent ?? 80) || 80,
    urgent: Number(options?.usageUrgentPercent ?? 95) || 95,
    weekWarn: Number(options?.weekWarnPercent ?? 90) || 90,
    home: '',
    autoPct: parseAutoPct(options?.autoMovePct),
  }
  settings.control = {
    // autoMovePct: 94 when absent, 0 (or above 100) turns the automatic move off.
    auto: { pct: parseAutoPct(options?.autoMovePct) },
    briefFiles: String(options?.briefFiles ?? ''),
    finishSends: options?.finishSends === true,
    handoverClear: options?.handoverClear === true,
    connectorProbe: String(options?.connectorProbe ?? ''),
    acct: settings.acct,
    wrapperPid: '',
  }

  on('session.start', async ($, e, next) => {
    // The usage probe starts another claude, which loads this mod too. That copy must do nothing.
    if ((await $.env.get('WORKBENCH_PLUGIN_PROBE')) === '1') {
      guard.isProbe = true
      return next(e)
    }
    gate.cwd = e.cwd
    const home = (await $.env.get('HOME')) ?? ''
    settings.acct.home = home
    settings.control.acct = settings.acct
    const wrapperPid = (await $.env.get('CLAUDE_WRAPPER_PID')) ?? ''
    settings.control.wrapperPid = /^\d+$/.test(wrapperPid) ? wrapperPid : ''
    // A refused command (a name another plugin or skill already holds) must not cost the session its tools.
    await $.command.register({
      name: 'workbench',
      description: 'Open the Workbench pane: workers, PRs and CI across the workspace apps, what waits on the owner',
    }).catch(() => {})
    const found = await findWorkspace($, e.cwd).catch(() => null)
    ws.current = found
    // The model's tools are registered once, here, and never again: the tool list stays fixed for the whole session.
    // Only a workspace or an empty folder the auto-init hook would turn into one gets them; other projects pay nothing.
    const isEligible = found ? true : (await isAutoInitOn($, home)) && (await isEligibleEmpty($, e.cwd, home, (await $.env.get('TMPDIR')) ?? '', (await $.env.get('WORKBENCH_HOME')) ?? ''))
    if (isEligible) {
      gate.toolsOn = true
      await registerTools($).catch(() => {})
    }
    // The watch: one slow timer that looks again for the marker, so a folder that becomes a workspace mid-session wakes the mod.
    if (!gate.isWatching) {
      gate.isWatching = true
      $.clock.every(WATCH_MS, () => void look($).catch(() => {}))
    }
    if (found) await activate($)
    return next(e)
  })

  on('command.run', { command: 'workbench' }, async $ => {
    const found = await look($)
    if (!found) return { text: 'Not in a Workbench workspace: no workbench.json in this folder or above. Run `workbench init` in an empty folder.' }
    await update($, bandHiddenAt, () => null)
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    timer.isPanePlaced = Boolean(opened?.isPlaced)
    void refreshUsage($, th, { force: true }).catch(() => {})
    void ensureLoaded($).catch(() => {})
    void refresh($)
    void $.clock.now().then(now => cwTick($, now, true)).catch(() => {})
    return { text: 'Workbench pane open. Refreshing PRs and CI.' }
  })

  // Remember the start of each worker and the worktree its brief names.
  on('agent.spawn', async ($, e, next) => {
    if (dormant()) return next(e)
    const started = await next(e)
    markAutoDirty()
    if (started.agentId) {
      const now = await $.clock.now()
      const worktree = e.prompt.match(/worktrees\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/)?.[0]
      const worker: Worker = {
        id: started.agentId,
        description: e.description,
        type: e.subagentType,
        status: 'running',
        startedAt: now,
        worktree,
        model: started.model,
      }
      await update($, workers, list => [...list.filter(w => w.id !== worker.id), worker].slice(-40))
    }
    return started
  }).catch(($, e, next) => next(e))

  // Every tool call marks its loop active. A gh or git push call refreshes GitHub soon after.
  on('tool.call', async ($, e, next) => {
    if (guard.isProbe) return next(e)
    // Claude's own three tools answer here, without reaching the engine. (A matcher naming an MCP tool makes
    // tsc run out of memory on the 27,000-line MCP declaration, so the name is compared by hand.)
    const name = String(e.tool)
    if (name === TOOL_ADD) return toolAdd($, e as unknown as { text?: unknown; kind?: unknown; agentId?: string }, opts)
    if (name === TOOL_RESOLVE) return toolResolve($, e as unknown as { id?: unknown; note?: unknown })
    if (name === TOOL_LIST) return toolList($)
    if (name === TOOL_BRIEF) return toolHandoverBrief($, e as unknown as { last_ask?: unknown }, settings.control)
    if (name === TOOL_CLEAR) return toolHandoverClear($, e as unknown as { last_ask?: unknown; carry?: unknown; watchers?: unknown }, settings.control)
    if (!ws.current) return next(e)
    const ran = await next(e)
    if (e.agentId) lastActive.set(e.agentId, await $.clock.now())
    if (e.tool === 'Bash' && /\bgh\s+(pr|run)\b|\bgit\s+push\b/.test(e.command)) scheduleRefresh($)
    if (!ran.deny && !ran.isError) {
      try {
        await captureEdit($, e as unknown as Record<string, unknown>, opts)
        await captureTask($, e as unknown as Record<string, unknown>, ran.result)
      } catch {}
    }
    return ran
  }).catch(($, e, next) => next(e))

  // One static section: the same text on every request, so the prompt cache is never broken by it.
  on('prompt.compose', async ($, e, next) => {
    if (guard.isProbe || !gate.toolsOn) return next(e)
    const composed = await next(e)
    return { sections: [...composed.sections, PROMPT_SECTION] }
  }).catch(($, e, next) => next(e))

  // Between turns the tokens, percent and cost move; the breakdown is kept.
  on('session.measure', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    try {
      await measureUsage($, e, th)
      await applyLimits($, e.rateLimits, await $.clock.now(), settings.acct, { releaseInFlight: releaseInFlight((await read($, snapshot))?.prs ?? []), mainModel: (await read($, accounts)).models.main })
      await updateStatus($)
    } catch {}
    return done
  }).catch(($, e, next) => next(e))

  // /clear starts the context and the cache over. The left-undone list is in the store and is not touched.
  on('session.end', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    if (e.reason === 'clear') {
      try {
        await resetCache($)
        await resetUsageLevel($)
        await deliverBrief($, settings.control)
      } catch {}
    }
    return done
  }).catch(($, e, next) => next(e))

  // A compaction rewrites the prefix: the cache is cold afterwards.
  on('session.compact', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && !('skip' in done && done.skip)) {
      try {
        await resetCache($)
        await refreshUsage($, th, { force: true })
      } catch {}
    }
    return done
  }).catch(($, e, next) => next(e))

  // A different model has its own cache: when the model row changes, how warm it is becomes unknown.
  on('config.set', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    if (e.key === 'model') await resetCache($, { unknownOnly: true }).catch(() => {})
    return done
  }).catch(($, e, next) => next(e))

  // A builder's report or the orchestrator's final answer: what was left undone or promised for later.
  on('turn.complete', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    if (e.agentId === undefined) live.isTurnRunning = false
    markAutoDirty()
    if (e.agentId === undefined) {
      try {
        await noteTurn($, e.usage)
        const limits = await refreshUsage($, th)
        await applyLimits($, limits, await $.clock.now(), settings.acct, { releaseInFlight: releaseInFlight((await read($, snapshot))?.prs ?? []), mainModel: (await read($, accounts)).models.main })
      } catch {}
    }
    try {
      await captureTurn($, { answer: e.answer, reason: e.reason, agentId: e.agentId }, opts)
      const added = takePendingAdds()
      if (added > 0) $.ui.toast(`+${added} left undone`)
      await updateStatus($)
    } catch {}
    try {
      if (e.agentId === undefined) await runQueue($, settings.control)
      else if (e.reason === 'error' || isAccountFailure(e.answer)) await tagAccountFailure($, e.agentId, await $.clock.now())
    } catch {}
    if (e.agentId === undefined) resetToastCap()
    return done
  }).catch(($, e, next) => next(e))

  // The next turn start is one more look at whether the account changed after a /login.
  on('turn.start', async ($, e, next) => {
    if (dormant() || e.agentId !== undefined) return next(e)
    live.isTurnRunning = true
    markAutoDirty()
    const started = await next(e)
    await watchSwap($, settings.control, { force: true }).catch(() => false)
    return started
  }).catch(($, e, next) => next(e))

  // A prompt from the owner cancels a queued clear. A prompt this mod filled and sent itself does not reach this hook.
  on('prompt.submit', async ($, e, next) => {
    if (dormant()) return next(e)
    // A prompt typed by the owner (or sent from their phone) cancels it. An unstamped prompt counts as his: cancelling is the safe side.
    if (!e.origin || e.origin.kind === 'composer' || e.origin.kind === 'bridge') await cancelQueue($).catch(() => false)
    markAutoDirty()
    return next(e)
  }).catch(($, e, next) => next(e))

  // A model switch. `auto` is the engine falling back to another model: the earliest sign of trouble on a plan.
  on('classic.PostModelSwitch', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    try {
      const now = await $.clock.now()
      await setMainModel($, e.to_model, e.source === 'auto' ? { from: e.from_model, to: e.to_model, at: now } : undefined)
      await resetCache($, { unknownOnly: true })
      if (e.source === 'auto') limitToast($, `Fell back from ${familyOf(e.from_model)} to ${familyOf(e.to_model)} (auto). Likely limits.`)
    } catch {}
    return done
  }).catch(($, e, next) => next(e))

  // A limit or credit error from the API. Remembered per account; a rate limit clears itself, billing and auth need a person.
  on('classic.StopFailure', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    try {
      await recordError($, String(e.error), await $.clock.now(), settings.control.auto.pct)
    } catch {}
    return done
  }).catch(($, e, next) => next(e))

  // What is in flight when the main loop or a subagent stops: shells, monitors, subagents, scheduled wake-ups.
  // An automatic account move is held while any of it is open, since the restart ends it.
  on('classic.Stop', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    noteBackground(e.background_tasks, e.session_crons)
    return done
  }).catch(($, e, next) => next(e))

  on('classic.SubagentStop', async ($, e, next) => {
    if (dormant()) return next(e)
    const done = await next(e)
    noteBackground(e.background_tasks, e.session_crons)
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box } = ui
    // A pane left open after the session moved out of the workspace: say so, and read nothing.
    if (dormant()) return <ui.Text dimColor>Not in a Workbench workspace.</ui.Text>
    const columns = Math.max(24, e.props.bodyColumns ?? 60)
    const list = await read($, workers)
    const cw = await read($, cworkers)
    const snap = await read($, snapshot)
    await read($, tick)
    const { items, tasks } = await readItems($)
    const view = await read($, undoneUi)
    const snapUsage = await read($, usage)
    const cacheState = await read($, cache)
    const ctxView = await read($, contextUi)
    const acct = await read($, accounts)
    const swapState = await read($, swapAtom)
    const checks = await currentChecks($)
    const models = modelSummary(list, acct.models.main)
    const auto = await autoStatus($, settings.control).catch(() => undefined)
    const c = makeCtx(ui, columns, await $.clock.now())
    timer.lastDrawAt = c.now

    const ctxActions = {
      view: ctxView,
      openUndone: items.filter(i => i.status === 'open').length,
      onToggle: () => update($, contextUi, v => ({ ...v, showAll: !v.showAll })),
      onClear: () => $.prompt.fill({ text: '/clear', mode: 'replace' }),
      onCompact: () => $.prompt.fill({ text: '/compact', mode: 'replace' }),
      onHandover: () => pressHandover($, settings.control, snapUsage?.percent),
      onCompactNow: () => compactNow($, settings.control),
    }

    return (
      <Box flexDirection="column">
        {alertCard(c, snapUsage, th, ctxActions)}
        {swapCard(c, swapState, acct, checks, {
          onMove: () => pressMove($, settings.control),
          onModel: () => pressModel($),
          onClose: () => closeSwap($),
          onPick: label => pickTarget($, label),
        }, canMove(settings.control))}
        {waitingCard(c, snap)}
        {undoneCard(c, items, tasks, {
          retentionDays: opts.retentionDays,
          view,
          claudeResolved: reopenable(items, c.now),
          isClearArmed: view.clearArmedAt > 0 && c.now - view.clearArmedAt < CLEAR_WINDOW_MS,
          onResolve: id => change($, (s, now) => resolveItem(s, id, 'owner', now)),
          onDrop: id => change($, (s, now) => dropItem(s, id, now)),
          onReopen: id => change($, s => reopenItem(s, id)),
          onFinish: () => finish($),
          onClear: () => clearAll($),
          onHelp: () => update($, undoneUi, v => ({ ...v, help: !v.help })),
          onFold: () => update($, undoneUi, v => ({ ...v, resolvedOpen: !v.resolvedOpen })),
        })}
        {workersCard($, c, list, cw)}
        {prsCard($, c, snap)}
        {productionCard(c, snap)}
        {contextCard(c, snapUsage, th, ctxActions)}
        {cacheCard(c, cacheState, ttl, snapUsage?.tokens, timer.isPanePlaced)}
        {accountsCard(c, acct, settings.acct, {
          onSwap: () => openSwap($, settings.control),
          onChoose: () => openSwap($, settings.control, { choose: true }),
          onRefresh: () => refreshAccounts($),
          onModel: model => $.prompt.fill({ text: `/model ${model}`, mode: 'replace' }),
          onMove: label => moveTo($, settings.control, label),
        }, { autoLine: auto, folder: acct.self?.dir || '.claude', modelLine: models.line, modelFlags: models.flags.map(f => f.text), fellBack: acct.models.fellBack ? `Fell back from ${familyOf(acct.models.fellBack.from)} to ${familyOf(acct.models.fellBack.to)} (auto)` : undefined, modelButtons: true, autoPct: settings.control.auto.pct })}
        {footerRow(c, snap, () => refresh($), costLine(snapUsage, c.now))}
      </Box>
    )
  })

  // One or two rows above the prompt. Hidden while nothing is happening, and after Hide until something worse happens.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (dormant() || e.props.hasSurvey) return next(e)
    // The band is being asked for: that counts as shown, so the 15-second read of claude-worker's workers keeps going.
    const bandNow = await $.clock.now()
    timer.lastBandAt = bandNow
    const sum = await sumNow($, ttl, th)
    const hidden = await read($, bandHiddenAt)
    const prCount = ((await read($, snapshot))?.prs ?? []).filter(p => !p.isBot && !p.isHeld).length
    if (!hasSomething(sum, prCount)) return next(e)
    if (hidden && !hasRisenSince(hidden, sum)) return next(e)
    return band($.ui.resolve(e), sum, {
      onPane: () => $.ui.open({ id: PANE, title: TITLE, focus: true }),
      onHide: () => update($, bandHiddenAt, () => hiddenAtOf(sum)),
      onFinish: () => finish($),
      onClear: () => $.prompt.fill({ text: '/clear', mode: 'replace' }),
      onCompact: () => $.prompt.fill({ text: '/compact', mode: 'replace' }),
      onSwap: async () => {
        await openSwap($, settings.control)
        await $.ui.open({ id: PANE, title: TITLE, focus: true })
      },
    })
  })
}
