import { atom, read, update } from 'claude-code'
import type { EngineInterface, SessionUsage, TurnUsage } from 'claude-code'

import type { CacheState, UsageCategory, UsageSnapshot } from '../../types'
import { contextLevel } from './format'

// Context, cache and cost. The numbers come from `$.session.usage()`, the `session.measure` event and the
// token counts a finished turn reports. No transcript is read, and nothing is stored beyond these numbers.
//
// Adapted from terminal-desk (MIT, Doonminus2; see NOTICE), hooks/register.tsx and hooks/detect.ts:
// the category mapping of refreshUsage(), the once-per-level warning of checkContext(), the segmented bar
// and the wording of the cache lines. Not adapted: their `tail` of the transcript to guess the cache life.

// The engine's scan reads state from the file that uses it, so each file declares the atoms it touches,
// with the same key, default and shape as register.tsx.
const usage = atom({ plugin: 'workbench', key: 'usage' } as const, null, { shape: 'usage-1' })
const cache = atom({ plugin: 'workbench', key: 'cache' } as const, { lastAt: null, lastContext: 0, isObserved: false, read: 0, total: 0 }, { shape: 'cache-1' })

export const BREAKDOWN_EVERY_MS = 20_000
export const COLD_SOON_MS = 60_000

export type Thresholds = { warn: number; urgent: number }

// Module memory: a reload only costs one extra breakdown.
let lastBreakdownAt = 0

export const emptyCache = (): CacheState => ({ lastAt: null, lastContext: 0, isObserved: false, read: 0, total: 0 })

export const ttlMs = (ttl: string) => (ttl === '1h' ? 3_600_000 : 300_000)

// ---------- pure ----------

export function categoriesOf(u: SessionUsage): UsageCategory[] {
  return (u.context.breakdown?.categories ?? []).map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }))
}

/** Fold a fresh reading into the snapshot. Returns the new snapshot and the toast to show, if any. */
export function foldUsage(prev: UsageSnapshot | null, u: Pick<SessionUsage, 'context' | 'cost'> & { startedAt?: number }, now: number, t: Thresholds): { snap: UsageSnapshot; toast?: string } {
  const hasBreakdown = Boolean(u.context.breakdown)
  const level = contextLevel(u.context.percent, t.warn, t.urgent)
  const was = prev?.level ?? 0
  let toast: string | undefined
  let keep = was
  if (level > was) {
    toast = level === 2 ? `Context ${u.context.percent}%: nearly full. /clear or /compact.` : `Context ${u.context.percent}%: getting full.`
    keep = level
  } else if (level < was) keep = level
  const snap: UsageSnapshot = {
    at: now,
    startedAt: u.startedAt ?? prev?.startedAt ?? now,
    window: u.context.window,
    tokens: u.context.tokens ?? prev?.tokens,
    percent: u.context.percent ?? prev?.percent,
    costUsd: u.cost?.usd ?? prev?.costUsd,
    categories: hasBreakdown ? (u.context.breakdown?.categories ?? []).map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })) : (prev?.categories ?? []),
    level: keep as 0 | 1 | 2,
  }
  // A percent that is now unknown (just cleared or compacted) is not carried forward.
  if (u.context.percent === undefined && u.context.tokens === undefined) {
    snap.percent = undefined
    snap.tokens = undefined
    snap.level = 0
  }
  return { snap, toast }
}

/** A main-loop turn finished: the cache was read or written at `now`. */
export function foldTurn(c: CacheState, u: TurnUsage | undefined, now: number): CacheState {
  if (!u) return { ...c, lastAt: now }
  const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return {
    lastAt: now,
    lastContext: input,
    isObserved: c.isObserved || u.cache_read_input_tokens > 0 || u.cache_creation_input_tokens > 0,
    read: c.read + u.cache_read_input_tokens,
    total: c.total + input,
    model: u.model,
  }
}

export type CacheView =
  | { state: 'none' }
  | { state: 'unknown'; ratio: number | null }
  | { state: 'warm'; leftMs: number; ratio: number | null }
  | { state: 'cold'; sinceMs: number; ratio: number | null }

export function cacheView(c: CacheState, ttl: string, now: number): CacheView {
  const ratio = c.total > 0 ? Math.round((c.read / c.total) * 100) : null
  if (!c.isObserved) return { state: 'none' }
  if (c.lastAt === null) return { state: 'unknown', ratio }
  const left = c.lastAt + ttlMs(ttl) - now
  return left > 0 ? { state: 'warm', leftMs: left, ratio } : { state: 'cold', sinceMs: -left, ratio }
}

/** The bar: one run of blocks per used category, sized by its share of the window, then light blocks for the rest. */
export function barSegments(categories: UsageCategory[], window: number, cols: number, percent?: number): Array<{ n: number; color?: string }> {
  const total = window || 1
  const used = categories.filter(k => k.kind === 'used')
  const segs = used.map(k => ({ color: k.color, n: Math.round((k.tokens / total) * cols) })).filter(s => s.n > 0)
  const filled = segs.reduce((a, s) => a + s.n, 0)
  if (segs.length === 0) {
    const n = percent === undefined ? 0 : Math.round((percent / 100) * cols)
    return [{ n, color: 'promptBorder' }, { n: Math.max(0, cols - n) }]
  }
  const over = filled - cols
  if (over > 0) segs[segs.length - 1]!.n = Math.max(0, segs[segs.length - 1]!.n - over)
  return [...segs, { n: Math.max(0, cols - segs.reduce((a, s) => a + s.n, 0)) }]
}

export type CategoryRow = { name: string; tokens: number; color: string; isDim: boolean }

/** Up to six used categories by size, the rest as "Other"; then free space and the compaction buffer, dimmed. */
export function categoryRows(categories: UsageCategory[], showAll: boolean): CategoryRow[] {
  const used = categories.filter(k => k.kind === 'used' && k.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const rows: CategoryRow[] = (showAll ? used : used.slice(0, 6)).map(k => ({ name: k.name, tokens: k.tokens, color: k.color, isDim: false }))
  if (!showAll && used.length > 6) {
    rows.push({ name: 'Other', tokens: used.slice(6).reduce((a, k) => a + k.tokens, 0), color: 'inactive', isDim: false })
  }
  for (const k of categories) if ((k.kind === 'free' || k.kind === 'buffer') && k.tokens > 0) rows.push({ name: k.name, tokens: k.tokens, color: k.color, isDim: true })
  return rows
}

/** Text for the cache countdown. Within a minute of going cold it counts by the second; otherwise by ten seconds. */
export function cacheLabelMs(leftMs: number, isPrecise: boolean): number {
  return isPrecise || leftMs <= COLD_SOON_MS ? Math.ceil(leftMs / 1000) * 1000 : Math.ceil(leftMs / 10_000) * 10_000
}

// ---------- with `$` ----------

/** Read the usage figures into the atom. The breakdown (the costly part) is fetched at most every 20 s. */
export async function refreshUsage($: EngineInterface, t: Thresholds, o: { columns?: number; force?: boolean } = {}): Promise<SessionUsage['rateLimits']> {
  const now = await $.clock.now()
  const wantsBreakdown = o.force === true || now - lastBreakdownAt >= BREAKDOWN_EVERY_MS
  if (wantsBreakdown) lastBreakdownAt = now
  const u = await $.session.usage(wantsBreakdown ? { breakdown: 'summary', columns: o.columns ?? 60 } : undefined)
  const prev = await read($, usage)
  const { snap, toast } = foldUsage(prev, u, now, t)
  await update($, usage, () => snap)
  if (toast) $.ui.toast(toast)
  return u.rateLimits
}

/** `session.measure`: tokens, percent and cost move; the breakdown is kept. */
export async function measureUsage($: EngineInterface, e: { context: SessionUsage['context']; cost?: SessionUsage['cost'] }, t: Thresholds): Promise<void> {
  const now = await $.clock.now()
  const prev = await read($, usage)
  const { snap, toast } = foldUsage(prev, { context: e.context, cost: e.cost, startedAt: prev?.startedAt }, now, t)
  if (!prev) {
    // First reading: ask once for the start time.
    const full = await $.session.usage().catch(() => undefined)
    if (full) snap.startedAt = full.startedAt
  }
  await update($, usage, () => snap)
  if (toast) $.ui.toast(toast)
}

export async function noteTurn($: EngineInterface, u: TurnUsage | undefined): Promise<void> {
  const now = await $.clock.now()
  await update($, cache, c => foldTurn(c, u, now))
}

/** /clear, /compact and a model switch all make the prompt cache cold. */
export async function resetCache($: EngineInterface, o: { keepRatio?: boolean; unknownOnly?: boolean } = {}): Promise<void> {
  await update($, cache, c => (o.unknownOnly ? { ...c, lastAt: null } : o.keepRatio ? { ...c, lastAt: null } : emptyCache()))
}

export async function resetUsageLevel($: EngineInterface): Promise<void> {
  lastBreakdownAt = 0
  await update($, usage, u => (u ? { ...u, level: 0 as const, tokens: undefined, percent: undefined, categories: [] } : u))
}
