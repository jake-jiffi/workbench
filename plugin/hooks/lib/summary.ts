import type { AccountsState, CacheState, CWorker, HiddenAt, Snapshot, UsageSnapshot, Worker } from '../../types'
import { contextLevel, countdown } from './format'
import { ci, nextStep } from './github'
import { isEnded } from './tones'
import { accountTone } from './accounts'
import { hasRecentError } from './acct'
import { cacheLabelMs, cacheView } from './usage'
import type { Thresholds } from './usage'

// The counts the band and the status line both show, worked out once in one place so they always agree.

export type Summary = {
  running: number
  green: number
  going: number
  red: number
  // Things the owner must do: approved releases plus what is waiting on them. Claude's own list is `undone`, never merged in.
  yours: number
  undone: number
  level: 0 | 1 | 2
  // This session's account: 0 fine, 1 amber, 2 red (a window at the urgent line, or an error just seen).
  acct: 0 | 1 | 2
  fiveHour?: number
  percent?: number
  costUsd?: number
  cacheLeftMs?: number
}

export type SummaryInput = {
  workers: Worker[]
  // claude-worker's workers; only those running are counted.
  cworkers?: CWorker[]
  snap: Snapshot | null
  undoneOpen: number
  usage: UsageSnapshot | null
  cache: CacheState
  accounts?: AccountsState | null
  acctTh?: { warn: number; urgent: number }
  ttl: string
  th: Thresholds
  now: number
}

export function summarize(i: SummaryInput): Summary {
  const prs = (i.snap?.prs ?? []).filter(p => !p.isBot && !p.isHeld)
  const v = cacheView(i.cache, i.ttl, i.now)
  return {
    running: i.workers.filter(w => !isEnded(w.status)).length + (i.cworkers ?? []).filter(w => w.state === 'running').length,
    green: prs.filter(p => ci(p.checks) === 'green').length,
    going: prs.filter(p => ci(p.checks) === 'running').length,
    red: prs.filter(p => ci(p.checks) === 'red').length,
    yours: prs.filter(p => nextStep(p).rank === 0).length + (i.snap?.waiting.length ?? 0),
    undone: i.undoneOpen,
    level: contextLevel(i.usage?.percent, i.th.warn, i.th.urgent),
    acct: acctLevel(i),
    fiveHour: i.accounts?.limits.find(l => l.kind === 'five_hour')?.percent,
    percent: i.usage?.percent,
    costUsd: i.usage?.costUsd,
    cacheLeftMs: v.state === 'warm' ? v.leftMs : undefined,
  }
}

function acctLevel(i: SummaryInput): 0 | 1 | 2 {
  if (!i.accounts) return 0
  const t = accountTone(i.accounts.limits, { warn: i.acctTh?.warn ?? 80, urgent: i.acctTh?.urgent ?? 95, now: i.now, recentError: hasRecentError(i.accounts, i.now) })
  return t === 'act' ? 2 : t === 'warn' ? 1 : 0
}

/** Whether anything is worth a band: working, PRs, the owner's items, Claude's undone, or a full context. */
export const hasSomething = (s: Summary, prCount: number) => s.running > 0 || prCount > 0 || s.undone > 0 || s.yours > 0 || s.level > 0 || s.acct > 0

export const hiddenAtOf = (s: Summary): HiddenAt => ({ red: s.red, yours: s.yours, undone: s.undone, level: s.level, acct: s.acct })

/** Hide holds until red, for-you or undone goes up, or a new context level is reached. */
export const hasRisenSince = (h: HiddenAt, s: Summary) => s.red > h.red || s.yours > h.yours || s.undone > h.undone || s.level > h.level || s.acct > (h.acct ?? 0)

// ---------- status line ----------

export const STATUS_MAX = 80

/**
 * `workbench · 3 working · 2 for you · 5 undone · ctx 83%!! · $3.87 · cache 3:32`, under 80 characters. Lowest priority
 * goes first when it is long: cache, cost, working, context, undone, for you. `workbench` always stays.
 * Undefined (the status line cleared) when there is nothing to say.
 */
export function statusText(s: Summary, isPrecise: boolean): string | undefined {
  if (s.running === 0 && s.yours === 0 && s.undone === 0 && s.level === 0 && s.acct === 0) return undefined
  const parts: Array<{ order: number; keep: number; text: string }> = [{ order: 0, keep: 0, text: 'workbench' }]
  if (s.running > 0) parts.push({ order: 1, keep: 3, text: `${s.running} working` })
  if (s.yours > 0) parts.push({ order: 2, keep: 1, text: `${s.yours} for you` })
  if (s.undone > 0) parts.push({ order: 3, keep: 2, text: `${s.undone} undone` })
  if (s.percent !== undefined) parts.push({ order: 4, keep: 4, text: `ctx ${s.percent}%${s.level === 2 ? '!!' : s.level === 1 ? '!' : ''}` })
  if (s.acct > 0 && s.fiveHour !== undefined) parts.push({ order: 4.5, keep: 4.5, text: `5h ${s.fiveHour}%${s.acct === 2 ? '!!' : '!'}` })
  if (s.costUsd !== undefined) parts.push({ order: 5, keep: 5, text: `$${s.costUsd.toFixed(2)}` })
  if (s.cacheLeftMs !== undefined) parts.push({ order: 6, keep: 6, text: `cache ${countdown(cacheLabelMs(s.cacheLeftMs, isPrecise))}` })
  const join = (list: typeof parts) => list.sort((a, b) => a.order - b.order).map(p => p.text).join(' · ')
  let shown = [...parts]
  while (join([...shown]).length > STATUS_MAX && shown.length > 1) {
    const drop = shown.filter(p => p.keep > 0).sort((a, b) => b.keep - a.keep)[0]
    if (!drop) break
    shown = shown.filter(p => p !== drop)
  }
  return join([...shown])
}
