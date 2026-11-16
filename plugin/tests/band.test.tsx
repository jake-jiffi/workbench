import { expect, test } from 'claude-code/testing'

import { PANE, PRS, STATE, engine, seen } from './helpers'
import { statusText, summarize, hasRisenSince, hiddenAtOf } from '../hooks/lib/summary'
import type { Summary } from '../hooks/lib/summary'

const BAND = { plugin: 'workbench', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 } } } as const

let clockNow = 1_762_140_000_000
let percent = 10
let prs: Record<string, unknown[]> = PRS
let state = STATE

const ctx = (p: number) => ({ window: 200_000, tokens: p * 2000, percent: p })

async function setup($: any, on: any, opts: { quiet?: boolean } = {}) {
  clockNow = 1_762_140_000_000
  percent = 10
  state = opts.quiet ? '# State\n\n## Waiting on Sam\n\nNothing.\n' : STATE
  prs = opts.quiet ? { 'acme/web-app': [], 'acme/mobile-app': [] } : PRS
  engine(on, (_: unknown, e: { argv: string[] }) => {
    if (e.argv.includes('list')) {
      const repo = e.argv[e.argv.indexOf('--repo') + 1] ?? ''
      return { value: { exitCode: 0, stdout: JSON.stringify(prs[repo] ?? []), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 0, stdout: JSON.stringify({ ahead: 2, live: 'a', head: 'b' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }, () => state, () => clockNow)
  on('session.usage', () => ({ value: { startedAt: clockNow - 60_000, context: ctx(percent), rateLimits: [], cost: { usd: 3.87 } } }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
}

const turn = ($: any, answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `t-${Math.random()}`, reason: 'answer' })
const measure = ($: any, p: number) => {
  percent = p
  return $.session.measure({ context: ctx(p), rateLimits: [], cost: { usd: 3.87 }, changed: ['context'] })
}

async function refreshGithub($: any) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  await ui.unmount()
}

// The band, or null when it draws nothing (the hook passes and nothing sits beneath it).
async function mountBand($: any) {
  try {
    return await $.ui.mount({ ...BAND })
  } catch {
    return null
  }
}

const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })).map((t: any) => t.text), ...(await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label ?? '')].join('\n')

test('the band shows the undone count in amber and the finish button', async ($: any, on: any) => {
  await setup($, on)
  await refreshGithub($)
  await turn($, "I'll close #135 at release. I haven't run the mobile suite.")
  const ui = await mountBand($)
  expect(ui).not.toBeNull()
  const t = await texts(ui)
  expect(t).toContain('2 undone')
  expect(t).toContain('3 for you')
  expect(t).toContain('finish undone')
  const undone = (await ui.findAll({ type: 'Text' })).find((x: any) => x.text === '2 undone')
  expect(undone?.props.color).toBe('warning')
  const keys = Object.fromEntries((await ui.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey]))
  expect(keys['band-finish']).toBe('f')
  // no context row below the warning level
  expect(t).not.toContain('/clear')
  await ui.unmount()
})

test('the context row appears only at the warning level, with c and k', async ($: any, on: any) => {
  await setup($, on)
  await refreshGithub($)
  await measure($, 40)
  let ui = await mountBand($)
  expect(await texts(ui)).not.toContain('Context 40%')
  await ui.unmount()
  await measure($, 72)
  ui = await mountBand($)
  expect(await texts(ui)).toContain('Context 72%:')
  const keys = Object.fromEntries((await ui.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey]))
  expect(keys['band-clear']).toBe('c')
  expect(keys['band-compact']).toBe('k')
  await ui.press({ key: 'band-clear' })
  await ui.press({ key: 'band-compact' })
  expect(seen.filled).toEqual(['/clear', '/compact'])
  await ui.unmount()
})

test('the band hides when idle', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await refreshGithub($)
  expect(await mountBand($)).toBeNull()
})

test('finish undone from the band fills the prompt and does not send it', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await refreshGithub($)
  await turn($, "I'll close #135 at release.")
  const ui = await mountBand($)
  await ui.press({ key: 'band-finish' })
  expect(seen.filled).toHaveLength(1)
  expect(seen.filled[0]).toContain('These are yours, left undone')
  expect(seen.submitted).toEqual([])
  await ui.unmount()
})

test('Hide holds until red, for-you or undone goes up, or a new context level is reached', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await refreshGithub($)
  await turn($, "I'll close #135 at release.")
  let ui = await mountBand($)
  await ui.press({ key: 'hide' })
  await ui.unmount()
  expect(await mountBand($)).toBeNull()
  // the same count again: still hidden
  await turn($, "I'll close #135 at release.")
  expect(await mountBand($)).toBeNull()
  // undone goes up
  await turn($, "I'll write the release note later.")
  ui = await mountBand($)
  expect(ui).not.toBeNull()
  await ui.press({ key: 'hide' })
  await ui.unmount()
  expect(await mountBand($)).toBeNull()
  // a new context level
  await measure($, 65)
  ui = await mountBand($)
  expect(ui).not.toBeNull()
  await ui.press({ key: 'hide' })
  await ui.unmount()
  await measure($, 70)
  expect(await mountBand($)).toBeNull()
  await measure($, 85)
  expect(await mountBand($)).not.toBeNull()
})

test('red going up shows a hidden band again', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await refreshGithub($)
  await turn($, "I'll close #135 at release.")
  let ui = await mountBand($)
  await ui.press({ key: 'hide' })
  await ui.unmount()
  prs = { 'acme/web-app': [PRS['acme/web-app']![1]!], 'acme/mobile-app': [] }
  await refreshGithub($)
  ui = await mountBand($)
  expect(ui).not.toBeNull()
  expect(await texts(ui)).toContain('1✗')
  await ui.unmount()
})

test('the band counts match what the pane lists', async ($: any, on: any) => {
  await setup($, on)
  await refreshGithub($)
  const ui = await mountBand($)
  const t = await texts(ui)
  // 4 live PRs not held, not bots: #197 green, #122 red, #198 green (approved), #107 green
  expect(t).toContain('3✓')
  expect(t).toContain('1✗')
  expect(t).toContain('3 for you')
  for (const x of await ui.findAll({ type: 'Text' })) expect(x.text.length).toBeLessThanOrEqual(100)
  await ui.unmount()
})

test('the status line follows the counts and clears when there is nothing', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await refreshGithub($)
  expect(seen.statuses.at(-1)).toBeUndefined()
  await turn($, "I'll close #135 at release.")
  expect(seen.statuses.at(-1)).toMatch(/^workbench · 1 undone · ctx 10% · \$3\.87/)
  await measure($, 83)
  expect(seen.statuses.at(-1)).toContain('ctx 83%!!')
})

const sum = (over: Partial<Summary> = {}): Summary => ({ running: 3, green: 1, going: 1, red: 1, yours: 2, undone: 5, level: 2, acct: 0, percent: 83, costUsd: 3.87, cacheLeftMs: 212_000, ...over })

test('status text: full form, and under 80 characters at every combination', async () => {
  expect(statusText(sum({ level: 0, percent: 83 }), true)).toBe('workbench · 3 working · 2 for you · 5 undone · ctx 83% · $3.87 · cache 3:32')
  expect(statusText(sum({ level: 1, percent: 62 }), true)).toContain('ctx 62%!')
  expect(statusText(sum({ running: 0, yours: 0, undone: 0, level: 0 }), true)).toBeUndefined()
  for (const running of [0, 3, 12]) for (const yours of [0, 2, 12]) for (const undone of [0, 5, 120]) for (const level of [0, 1, 2] as const) for (const cacheLeftMs of [undefined, 212_000, 3_599_000]) for (const costUsd of [undefined, 3.87, 1234.56]) {
    const s = statusText(sum({ running, yours, undone, level, percent: level ? 99 : 5, cacheLeftMs, costUsd }), true)
    if (s !== undefined) {
      expect(s.length).toBeLessThanOrEqual(80)
      expect(s.startsWith('workbench')).toBe(true)
    }
  }
})

test('status text drops cache before everything else, and workbench last', async () => {
  const long = sum({ running: 123456, yours: 123456, undone: 123456, costUsd: 123456.78, percent: 100, cacheLeftMs: 3_599_000 })
  const s = statusText(long, true) ?? ''
  expect(s.length).toBeLessThanOrEqual(80)
  expect(s).not.toContain('cache')
  expect(s).toContain('workbench')
  expect(s).toContain('for you')
  const slightly = statusText(sum({ running: 1234, yours: 1234, undone: 1234 }), true) ?? ''
  expect(slightly).toContain('$')
  expect(slightly).not.toContain('cache')
})

test('hide holds until a count rises', async () => {
  const h = hiddenAtOf(sum())
  expect(hasRisenSince(h, sum())).toBe(false)
  expect(hasRisenSince(h, sum({ red: 2 }))).toBe(true)
  expect(hasRisenSince(h, sum({ undone: 6 }))).toBe(true)
  expect(hasRisenSince(h, sum({ yours: 3 }))).toBe(true)
  expect(hasRisenSince(h, sum({ undone: 1, red: 0 }))).toBe(false)
})

test('summarize counts PRs the way the pane lists them', async () => {
  const s = summarize({ workers: [], snap: null, undoneOpen: 2, usage: null, cache: { lastAt: null, lastContext: 0, isObserved: false, read: 0, total: 0 }, ttl: '5m', th: { warn: 60, urgent: 80 }, now: 0 })
  expect(s).toMatchObject({ running: 0, undone: 2, yours: 0, level: 0 })
})

test('exactly one toast per turn for undone, and no notification for it', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await turn($, "I'll close #135 at release. I'll write the note later. I haven't run the suite.")
  expect(seen.toasts.filter(t => t.includes('left undone'))).toEqual(['+3 left undone'])
  expect(seen.notices).toEqual([])
})
