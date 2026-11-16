import { expect, test } from 'claude-code/testing'

import { PANE } from './helpers'
import { mountPane, setup, texts } from './kit'
import { seen } from './helpers'

// Left undone is scoped to the workspace that made it. Three sessions in turn share one store, as one machine would.

const BAND = { plugin: 'workbench', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 } } } as const
const ADD = 'mcp__workbench__left_undone_add'
const RESOLVE = 'mcp__workbench__left_undone_resolve'
const LIST = 'mcp__workbench__left_undone_list'
const BRIEF = 'mcp__workbench__handover_brief'
const call = ($: any, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, tool_use_id: `u-${Math.random()}`, ...input })
const said = (r: any): string => (typeof r?.result === 'string' ? r.result : '')

// An item stored before scoping: no root.
const OLD = {
  id: 'U1', key: 'tidy the old loose end', kind: 'manual', tag: 'Note', text: 'Tidy the old loose end', sources: [{ label: 'orchestrator' }], refs: [],
  confidence: 'high', firstAt: 1_762_000_000_000, lastAt: 1_762_000_000_000, seen: 1, status: 'open', sessionId: 's0',
}
const ALPHA = '/work/alpha'
const BETA = '/work/beta'
let carried: unknown
let backing: Record<string, unknown> = {}
const start = async ($: any, on: any, root: string, seed: unknown) => {
  backing = { 'undone.v1': structuredClone(seed) }
  await setup($, on, { root, store: backing })
}

const openCount = async (ui: any) => (await ui.findAll({ type: 'Button' })).filter((b: any) => b.props.label === '✓ done').length
const bandText = async ($: any) => {
  const band = await $.ui.mount({ ...BAND })
  const t = await texts(band)
  await band.unmount()
  return t
}

test('workspace alpha: its own items and the old unscoped one, tagged', async ($: any, on: any) => {
  await start($, on, ALPHA, { v: 1, counter: 1, items: [OLD], tombstones: [] })
  expect(said(await call($, ADD, { text: 'Write the alpha note', kind: 'promise' }))).toContain('Recorded as U2')
  const listed = said(await call($, LIST))
  expect(listed).toContain('U2 [Said, orchestrator] Write the alpha note')
  expect(listed).toMatch(/U1 \[Note, orchestrator\] \(unscoped\) Tidy the old loose end/)
  const stored = backing['undone.v1'] as any
  expect(stored.items.find((i: any) => i.id === 'U2').root).toBe(ALPHA)
  expect(stored.items.find((i: any) => i.id === 'U1').root).toBeUndefined()
  carried = stored
})

test('workspace beta: sees its own and the unscoped one, never alpha\'s; counts agree; resolve across is refused', async ($: any, on: any) => {
  await start($, on, BETA, carried)
  expect(said(await call($, ADD, { text: 'Write the beta note', kind: 'promise' }))).toContain('Recorded as U3')
  const listed = said(await call($, LIST))
  expect(listed).toContain('Write the beta note')
  expect(listed).toContain('Tidy the old loose end')
  expect(listed).not.toContain('alpha')

  // The card, the band and the status line count the same two items.
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('Write the beta note')
  expect(t).toContain('Tidy the old loose end')
  expect(t).toContain('(unscoped)')
  expect(t).not.toContain('alpha')
  expect(await openCount(ui)).toBe(2)
  expect(await bandText($)).toMatch(/2 undone/)
  expect(seen.statuses.at(-1)).toMatch(/2 undone/)

  // finish all and the handover brief: this workspace's items only.
  await ui.press({ key: 'u-finish' })
  const request = seen.filled.at(-1) ?? ''
  expect(request).toContain('Write the beta note')
  expect(request).toContain('(unscoped) Tidy the old loose end')
  expect(request).not.toContain('alpha')
  const brief = said(await call($, BRIEF, { last_ask: 'carry on' }))
  expect(brief).toContain('Write the beta note')
  expect(brief).not.toContain('alpha')

  // Another workspace's id is refused, naming that workspace, and stays open.
  const refused = await call($, RESOLVE, { id: 'U2' })
  expect(refused.isError).toBe(true)
  expect(said(refused)).toContain(`belongs to the workspace at ${ALPHA}`)
  expect((backing['undone.v1'] as any).items.find((i: any) => i.id === 'U2').status).toBe('open')
  // An old unscoped item resolves from here too.
  expect(said(await call($, RESOLVE, { id: 'U1' }))).toContain('U1 marked done')
  // Dropping from the pane's clear-all never touches alpha's either.
  await ui.press({ key: 'u-clear' })
  await ui.press({ key: 'u-clear' })
  expect((backing['undone.v1'] as any).items.find((i: any) => i.id === 'U2').status).toBe('open')
  expect((backing['undone.v1'] as any).items.find((i: any) => i.id === 'U3').status).toBe('dropped')
  await ui.unmount()
  carried = backing['undone.v1']
})

test('back in alpha: only its own item, untouched by what beta did', async ($: any, on: any) => {
  await start($, on, ALPHA, carried)
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('Write the alpha note')
  expect(t).not.toContain('beta')
  expect(await openCount(ui)).toBe(1)
  expect(said(await call($, LIST))).not.toContain('Tidy the old loose end')
  expect(await bandText($)).toMatch(/1 undone/)
  await ui.unmount()
  void PANE
})

test('the same words in two workspaces are two items, and a drop in one does not block the other', async ($: any, on: any) => {
  await start($, on, BETA, carried)
  // "Write the alpha note" is open in alpha; beta can say the same thing as its own.
  expect(said(await call($, ADD, { text: 'Write the alpha note', kind: 'promise' }))).toMatch(/Recorded as U\d+/)
  const items = (backing['undone.v1'] as any).items.filter((i: any) => i.text === 'Write the alpha note')
  expect(items.map((i: any) => i.root).sort()).toEqual([ALPHA, BETA])
})
