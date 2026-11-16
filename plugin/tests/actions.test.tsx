import { expect, test } from 'claude-code/testing'

import { PANE, engine, seen } from './helpers'
import { finishRequest, addCandidates, emptyStore, flagGonePrs } from '../hooks/lib/undone'
import { PROMPT_SECTION } from '../hooks/lib/tools'

const ADD = 'mcp__workbench__left_undone_add'
const RESOLVE = 'mcp__workbench__left_undone_resolve'
const LIST = 'mcp__workbench__left_undone_list'

const FACTS = (model: string) => ({ model, promptModel: model, surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })

let clockNow = 1_762_140_000_000

async function setup($: any, on: any) {
  clockNow = 1_762_140_000_000
  engine(on, undefined, undefined, () => clockNow)
  const registered: string[] = []
  on('tool.register', (_: unknown, e: { name: string }) => { registered.push(e.name); return { value: { tool: `mcp__workbench__${e.name}` } } })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'Intro.', scope: 'shared' }] }))
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  return registered
}

const turn = ($: any, answer: string, agentId?: string) =>
  $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId: `t-${Math.random()}`, reason: 'answer', agentId })

async function mountPane($: any) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })
  return ui
}

const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })).map((t: any) => t.text), ...(await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label ?? '')].join('\n')
const call = ($: any, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, tool_use_id: `u-${Math.random()}`, ...input })
// The engine takes a registered tool's result as plain text (or content blocks), never the MCP {content} wrapper.
const said = (r: any): string => (typeof r?.result === 'string' ? r.result : '')

test('the tools are registered once, at session start, and the list never changes', async ($: any, on: any) => {
  const registered = await setup($, on)
  expect(registered).toEqual(['left_undone_add', 'left_undone_resolve', 'handover_brief', 'handover_clear', 'left_undone_list'])
  await turn($, "I'll close #135 at release.")
  await call($, ADD, { text: 'Check the staging key note' })
  await mountPane($).then((ui: any) => ui.unmount())
  expect(registered).toHaveLength(5)
})

test('the prompt section is static: identical on every call, added last', async ($: any, on: any) => {
  await setup($, on)
  const a = await $.prompt.compose(FACTS('opus'))
  await turn($, "I'll close #135 at release.")
  await call($, ADD, { text: 'Something to remember later' })
  const b = await $.prompt.compose(FACTS('opus'))
  const c = await $.prompt.compose(FACTS('sonnet'))
  const ours = (r: any) => r.sections.filter((s: any) => s.id === 'workbench:left-undone')
  expect(ours(a)).toHaveLength(1)
  expect(ours(a)[0].text).toBe(PROMPT_SECTION.text)
  expect(ours(b)[0].text).toBe(ours(a)[0].text)
  expect(ours(c)[0].text).toBe(ours(a)[0].text)
  expect(a.sections.at(-1).id).toBe('workbench:left-undone')
  // No count, id or date in it
  expect(PROMPT_SECTION.text).not.toMatch(/\bU\d+\b|\d{4}-\d\d-\d\d/)
})

test('left_undone_add, list and resolve: Claude resolves, Sam sees a fold and can reopen', async ($: any, on: any) => {
  await setup($, on)
  expect(said(await call($, ADD, { text: 'Post the release note after merge', kind: 'promise' }))).toBe('Recorded as U1.')
  expect(said(await call($, ADD, { text: 'Post the release note after merge' }))).toContain('Not recorded')
  expect(said(await call($, LIST))).toContain('U1 [Said, orchestrator] Post the release note after merge')
  expect(said(await call($, RESOLVE, { id: 'u9' }))).toContain('No open item U9')
  expect(said(await call($, RESOLVE, { id: 'u1', note: 'posted' }))).toContain('U1 marked done')
  expect(said(await call($, LIST))).toBe('Nothing is left undone.')
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('Nothing open.')
  expect(t).toContain('Recently resolved by Claude (1)')
  expect(t).not.toContain('Post the release note')
  await ui.press({ key: 'u-fold' })
  expect(await texts(ui)).toContain('Post the release note after merge: posted')
  await ui.press({ key: 'u-reopen-U1' })
  const after = await texts(ui)
  expect(after).toContain('Post the release note after merge')
  expect(after).not.toContain('Recently resolved')
  await ui.unmount()
})

test('f fills the prompt with the finish request and does not send it', async ($: any, on: any) => {
  await setup($, on)
  await turn($, '**Not done**\n- Live test of the mic repair button', 'agent-1')
  await turn($, "I'll close #135 at release.")
  const ui = await mountPane($)
  await ui.press({ key: 'u-finish' })
  expect(seen.submitted).toEqual([])
  expect(seen.filled).toHaveLength(1)
  const text = seen.filled[0] ?? ''
  expect(text).toContain('These are yours, left undone from earlier.')
  expect(text).toContain('call left_undone_resolve with its id. Leave what is waiting on the owner alone.')
  expect(text).toContain("- U2 [Said, orchestrator] I'll close #135 at release")
  expect(text).toContain('- U1 [Not done, builder] Live test of the mic repair button')
  // oldest first
  expect(text.indexOf('U1')).toBeLessThan(text.indexOf('U2'))
  await ui.unmount()
})

test('with finishSends the same key submits', { options: { finishSends: true } }, async ($: any, on: any) => {
  await setup($, on)
  await turn($, "I'll close #135 at release.")
  const ui = await mountPane($)
  await ui.press({ key: 'u-finish' })
  expect(seen.filled).toEqual([])
  expect(seen.submitted).toHaveLength(1)
  await ui.unmount()
})

test('x once changes nothing; twice within 3 seconds clears; a late second press only re-arms', async ($: any, on: any) => {
  await setup($, on)
  await turn($, '**Not done**\n- Alpha thing to finish\n- Beta thing to finish', 'agent-1')
  const ui = await mountPane($)
  await ui.press({ key: 'u-clear' })
  let t = await texts(ui)
  expect(t).toContain('Alpha thing to finish')
  expect(t).toContain('press x again to clear')
  clockNow += 2_000
  await ui.press({ key: 'u-clear' })
  expect(await texts(ui)).toContain('Nothing open.')
  await turn($, '**Not done**\n- Gamma thing to finish', 'agent-1')
  await ui.press({ key: 'u-clear' })
  clockNow += 5_000
  await ui.press({ key: 'u-clear' })
  t = await texts(ui)
  expect(t).toContain('Gamma thing to finish')
  await ui.unmount()
})

test('h opens and closes the help inline; every help line fits', async ($: any, on: any) => {
  await setup($, on)
  await turn($, "I'll close #135 at release.")
  const ui = await mountPane($)
  await ui.press({ key: 'u-help' })
  const t = await texts(ui)
  expect(t).toContain('never sends it')
  for (const x of await ui.findAll({ type: 'Text' })) expect(x.text.length).toBeLessThanOrEqual(86)
  await ui.press({ key: 'u-help' })
  expect(await texts(ui)).not.toContain('never sends it')
  await ui.unmount()
})

test('hotkeys f x h are on the card buttons', async ($: any, on: any) => {
  await setup($, on)
  await turn($, "I'll close #135 at release.")
  const ui = await mountPane($)
  const keys = Object.fromEntries((await ui.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey]))
  expect(keys['u-finish']).toBe('f')
  expect(keys['u-clear']).toBe('x')
  expect(keys['u-help']).toBe('h')
  await ui.unmount()
})

test('merged PRs sort to the top of the finish request', async () => {
  const o = { now: 1, sessionId: 's' }
  const cand = (text: string) => ({ kind: 'commit' as const, tag: 'Said' as const, text, source: { label: 'orchestrator' }, confidence: 'medium' as const })
  let s = addCandidates(emptyStore(), [cand("I'll write the note later"), cand("I'll close web#135 at release")], o).store
  s = flagGonePrs(s, ['web#135'])
  const lines = finishRequest(s).split('\n')
  expect(lines[1]).toContain('U2')
  expect(lines[1]).toContain('(#135 merged or closed)')
  const many = addCandidates(emptyStore(), Array.from({ length: 12 }, (_, i) => cand(`I'll tidy part ${i} later`)), o).store
  const more = { ...many, items: [...many.items, ...many.items.map((x, i) => ({ ...x, id: `U${100 + i}`, key: `${x.key}b` }))] }
  expect(finishRequest(more).split('\n').filter(l => l.startsWith('- '))).toHaveLength(15)
  expect(finishRequest(more)).toContain('(and 9 more: left_undone_list shows them)')
})
