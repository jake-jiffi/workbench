import { expect, test } from 'claude-code/testing'

import { PANE, engine, seen } from './helpers'
import { barSegments, cacheView, categoryRows, foldTurn, foldUsage, emptyCache } from '../hooks/lib/usage'
import { costLine } from '../hooks/lib/usageview'

const CATS = [
  { name: 'System prompt', tokens: 6_000, color: 'promptBorder', isDeferred: false, kind: 'used' as const },
  { name: 'Messages', tokens: 120_000, color: 'permission', isDeferred: false, kind: 'used' as const },
  { name: 'Skills', tokens: 9_000, color: 'success', isDeferred: false, kind: 'used' as const },
  { name: 'Free space', tokens: 34_000, color: 'inactive', isDeferred: false, kind: 'free' as const },
  { name: 'Autocompact buffer', tokens: 31_000, color: 'inactive', isDeferred: false, kind: 'buffer' as const },
]

const ctx = (percent: number | undefined, withBreakdown = false) => ({
  window: 200_000,
  tokens: percent === undefined ? undefined : Math.round(percent * 2000),
  percent,
  breakdown: withBreakdown ? { categories: CATS, totalTokens: 135_000, maxTokens: 200_000, rawMaxTokens: 200_000, autocompactSource: 'default', percentage: percent ?? 0, grid: [] } : undefined,
})

let clockNow = 1_762_140_000_000
let percent: number | undefined = 10
let calls: Array<{ breakdown?: string }> = []

async function setup($: any, on: any, extra?: () => void) {
  clockNow = 1_762_140_000_000
  percent = 10
  calls = []
  engine(on, undefined, undefined, () => clockNow)
  on('session.usage', (_: unknown, e: { breakdown?: string }) => {
    calls.push({ breakdown: e?.breakdown })
    return { value: { startedAt: clockNow - 48 * 60_000 - 3_000, context: ctx(percent, Boolean(e?.breakdown)), rateLimits: [], cost: { usd: 3.87 } } }
  })
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('session.compact', (_: unknown, e: { messages: unknown[] }) => ({ messages: e.messages }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('prompt.compose', () => ({ sections: [] }))
  extra?.()
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
}

const turn = ($: any, usage?: Record<string, number | string>) =>
  $.turn.complete({ answer: 'Done.', durationMs: 10, isAborted: false, turnId: `t-${Math.random()}`, reason: 'answer', usage })

const USE = (input: number, read: number, created: number) => ({ input_tokens: input, output_tokens: 50, cache_read_input_tokens: read, cache_creation_input_tokens: created, model: 'opus' })

const measure = ($: any, p: number) => {
  percent = p
  return $.session.measure({ context: ctx(p), rateLimits: [], cost: { usd: 3.87 }, changed: ['context'] })
}

const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })).map((t: any) => t.text), ...(await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label ?? '')].join('\n')

async function mountPane($: any, columns = 90) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
  await ui.press({ key: 'refresh' })
  return ui
}

const MSGS = [{ role: 'user', text: 'hello', toolUses: [] }]

const levelToasts = () => seen.toasts.filter(t => t.startsWith('Context '))

test('the warning toasts once per level going up and resets when the context drops', async ($: any, on: any) => {
  await setup($, on)
  await measure($, 40)
  expect(levelToasts()).toEqual([])
  await measure($, 62)
  await measure($, 65)
  expect(levelToasts()).toEqual(['Context 62%: getting full.'])
  await measure($, 83)
  await measure($, 90)
  expect(levelToasts()).toHaveLength(2)
  expect(levelToasts()[1]).toBe('Context 83%: nearly full. /clear or /compact.')
  await measure($, 20)
  await measure($, 61)
  expect(levelToasts()).toHaveLength(3)
  expect(seen.notices).toEqual([])
})

test('the thresholds come from the settings', { options: { warnPercent: 30, urgentPercent: 50 } }, async ($: any, on: any) => {
  await setup($, on)
  await measure($, 35)
  await measure($, 55)
  expect(levelToasts()).toHaveLength(2)
})

test('the cache counts down from the last reply: 3:32, then cold, and 1h lasts longer', { options: { cacheTtl: '5m' } }, async ($: any, on: any) => {
  await setup($, on)
  await turn($, USE(2_000, 160_000, 4_000))
  clockNow += 88_000
  const ui = await mountPane($)
  let t = await texts(ui)
  expect(t).toContain('warm, cold in 3:32 (5m cache)')
  expect(t).toContain('Next message reads ~')
  clockNow += 5 * 60_000
  await ui.press({ key: 'refresh' })
  t = await texts(ui)
  expect(t).toContain('cold since 1m28s')
  expect(t).toContain('Next message re-caches ~')
  await ui.unmount()
})

test('a 1h setting keeps the cache warm past five minutes', { options: { cacheTtl: '1h' } }, async ($: any, on: any) => {
  await setup($, on)
  await turn($, USE(2_000, 160_000, 4_000))
  clockNow += 10 * 60_000
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('warm, cold in 50:00 (1h cache)')
  await ui.unmount()
})

test('before any cached request the card says so', async ($: any, on: any) => {
  await setup($, on)
  await turn($, USE(8_000, 0, 0))
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('Caching on; set by the next reply.')
  await ui.unmount()
})

test('hit ratio is read over input, read and written tokens across main turns', async ($: any, on: any) => {
  await setup($, on)
  await turn($, USE(1_000, 80_000, 19_000)) // 100,000 in, 80,000 read
  await turn($, USE(2_000, 98_000, 0)) // 100,000 in, 98,000 read
  await turn($, undefined as any)
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('Hit ratio this session 89%')
  await ui.unmount()
})

test('/clear and /compact make the cache cold and clear the ratio', async ($: any, on: any) => {
  await setup($, on)
  await turn($, USE(1_000, 80_000, 19_000))
  let ui = await mountPane($)
  expect(await texts(ui)).toContain('warm')
  await ui.unmount()
  await $.session.compact({ trigger: 'manual', messages: MSGS })
  ui = await mountPane($)
  expect(await texts(ui)).toContain('Caching on; set by the next reply.')
  await ui.unmount()
  await turn($, USE(1_000, 80_000, 19_000))
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: {} })
  ui = await mountPane($)
  expect(await texts(ui)).toContain('Caching on; set by the next reply.')
  expect(await texts(ui)).not.toContain('Hit ratio')
  await ui.unmount()
})

test('a subagent turn does not move the cache', { options: { cacheTtl: '5m' } }, async ($: any, on: any) => {
  await setup($, on)
  await turn($, USE(1_000, 80_000, 19_000))
  clockNow += 200_000
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'sub', reason: 'answer', agentId: 'agent-9', usage: USE(5, 5, 5) })
  clockNow += 150_000
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('cold since')
  await ui.unmount()
})

test('the breakdown is fetched at most every 20 seconds', async ($: any, on: any) => {
  await setup($, on)
  const withBreakdown = () => calls.filter(c => c.breakdown).length
  for (let i = 0; i < 30; i++) await Promise.resolve()
  const first = withBreakdown()
  expect(first).toBe(1)
  await turn($, USE(1_000, 80_000, 19_000))
  clockNow += 5_000
  await turn($, USE(1_000, 80_000, 19_000))
  expect(withBreakdown()).toBe(1)
  clockNow += 21_000
  await turn($, USE(1_000, 80_000, 19_000))
  expect(withBreakdown()).toBe(2)
  expect(calls.length).toBeGreaterThan(withBreakdown())
})

test('the context card shows the line and bar, folds the categories, and offers /clear and /compact at warn', async ($: any, on: any) => {
  await setup($, on)
  await measure($, 67)
  await turn($, USE(1_000, 80_000, 19_000))
  const ui = await mountPane($)
  let t = await texts(ui)
  expect(t).toContain('Context 67%')
  expect(t).toContain('134.0K of 200.0K')
  expect(t).not.toContain('Messages')
  await ui.press({ key: 'ctx-more' })
  t = await texts(ui)
  expect(t).toContain('Messages')
  expect(t).toContain('Free space')
  await ui.press({ key: 'ctx-clear' })
  await ui.press({ key: 'ctx-compact' })
  expect(seen.filled).toEqual(['/clear', '/compact'])
  expect(seen.submitted).toEqual([])
  const keys = Object.fromEntries((await ui.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey]))
  expect(keys['ctx-clear']).toBe('c')
  expect(keys['ctx-compact']).toBe('k')
  expect(keys['ctx-more']).toBe('m')
  await ui.unmount()
})

test('the context card tones: quiet, amber, then red with the alert card above', async ($: any, on: any) => {
  const border = async (ui: any, title: string) =>
    (await ui.findAll({ type: 'Box' })).find((b: any) => b.props.borderStyle && JSON.stringify(b.children).includes(`"${title}"`))?.props
  await setup($, on)
  await turn($, USE(1_000, 80_000, 19_000))
  await measure($, 40)
  let ui = await mountPane($)
  expect((await border(ui, 'Context'))?.borderColor).toBe('subtle')
  expect(await border(ui, 'Context nearly full')).toBeUndefined()
  await measure($, 70)
  expect((await border(ui, 'Context'))?.borderColor).toBe('warning')
  await measure($, 83)
  expect((await border(ui, 'Context'))?.borderColor).toBe('error')
  const alert = await border(ui, 'Context nearly full')
  expect(alert?.borderStyle).toBe('bold')
  expect(alert?.borderColor).toBe('error')
  // the alert sits first
  const all = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props.borderStyle)
  expect(JSON.stringify(all[0]?.children)).toContain('Context nearly full')
  await ui.unmount()
})

test('the footer shows cost and session time from the engine, nothing about workers', async ($: any, on: any) => {
  await setup($, on)
  await measure($, 20)
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('$3.87 · session 48m03s · /workbench hides')
  expect(t).not.toMatch(/worker.*\$/i)
  await ui.unmount()
})

test('pure: levels, bar, rows, cache view, cost line', async () => {
  const t = { warn: 60, urgent: 80 }
  const base = foldUsage(null, { context: ctx(50, true) as any }, 1, t)
  expect(base.toast).toBeUndefined()
  expect(foldUsage(base.snap, { context: ctx(61) as any }, 2, t).toast).toBe('Context 61%: getting full.')
  // a reading with no figures (just cleared) forgets the level
  const cleared = foldUsage({ ...base.snap, level: 2 }, { context: { window: 200_000 } as any }, 3, t)
  expect(cleared.snap.level).toBe(0)
  expect(cleared.snap.percent).toBeUndefined()

  const segs = barSegments(base.snap.categories, 200_000, 40)
  expect(segs.reduce((a, s) => a + s.n, 0)).toBe(40)
  expect(segs.at(-1)?.color).toBeUndefined()
  expect(barSegments([], 200_000, 40, 50)).toEqual([{ n: 20, color: 'promptBorder' }, { n: 20 }])

  const many = Array.from({ length: 9 }, (_, i) => ({ name: `Cat ${i}`, tokens: 1000 * (i + 1), color: 'x', kind: 'used' as const }))
  const rows = categoryRows([...many, ...base.snap.categories.filter(c => c.kind !== 'used')], false)
  expect(rows.filter(r => !r.isDim)).toHaveLength(7)
  expect(rows.find(r => r.name === 'Other')?.tokens).toBe(1000 + 2000 + 3000)
  expect(rows.filter(r => r.isDim).map(r => r.name)).toEqual(['Free space', 'Autocompact buffer'])
  expect(categoryRows(many, true)).toHaveLength(9)

  const c1 = foldTurn(emptyCache(), { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, model: 'm' }, 1000)
  expect(c1.read / c1.total).toBe(0.9)
  expect(cacheView(c1, '5m', 1000 + 212_000)).toEqual({ state: 'warm', leftMs: 88_000, ratio: 90 })
  expect(cacheView(c1, '5m', 1000 + 400_000).state).toBe('cold')
  expect(cacheView({ ...c1, lastAt: null }, '5m', 5).state).toBe('unknown')
  expect(cacheView(emptyCache(), '5m', 5).state).toBe('none')
  expect(costLine({ ...base.snap, costUsd: 3.871, startedAt: 0 }, 2_883_000)).toBe('$3.87 · session 48m03s · /workbench hides')
  expect(costLine(null, 5)).toBe('/workbench hides')
})
