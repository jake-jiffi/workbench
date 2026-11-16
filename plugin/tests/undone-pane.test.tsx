import { expect, test } from 'claude-code/testing'

import { PANE, engine, seen } from './helpers'

// Synthetic reports and messages written for these tests. Nothing here is real client or builder output.

const REPORT = `PR opened as #206.

**Not done**
- Live test of the mic repair button
- Dark mode styling for the new dialog

**Couldn't run it**
- The end-to-end suite: no runner in this worktree

**Noticed, left alone**
- None`

const SPAWN = { prompt: 'Work in ~/work/acme/worktrees/web/feat-x', description: 'Web PR: mic repair', subagentType: 'web-builder' }

async function setup($: any, on: any, state?: string) {
  engine(on, undefined, state)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
}

const turn = ($: any, answer: string, agentId?: string) =>
  $.turn.complete({ answer, durationMs: 10, isAborted: false, turnId: `t-${Math.random()}`, reason: 'answer', agentId })

async function texts(ui: any) {
  return (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
}

async function mountPane($: any, columns = 90) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
  await ui.press({ key: 'refresh' })
  return ui
}

test('a builder report lands in the card with its tags and its worker', async ($: any, on: any) => {
  await setup($, on)
  const started = await $.agent.spawn(SPAWN)
  await turn($, REPORT, started?.agentId ?? 'agent-1')
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('Left undone')
  expect(t).toContain('Not done')
  expect(t).toContain("Couldn't run")
  expect(t).toContain('Live test of the mic repair button')
  expect(t).toContain('Web PR: mic repair')
  expect(t).not.toContain('Noticed')
  expect(seen.toasts).toContain('+3 left undone')
  expect(seen.notices).toEqual([])
  for (const x of await ui.findAll({ type: 'Text' })) expect(x.text.length).toBeLessThanOrEqual(86)
  await ui.unmount()
})

test('exactly one toast per turn, and none when nothing was found', async ($: any, on: any) => {
  await setup($, on)
  await turn($, 'All green. Nothing else to report.')
  expect(seen.toasts.filter(x => x.includes('left undone'))).toHaveLength(0)
  await turn($, "I'll close #135 at release. I haven't run the mobile suite.")
  expect(seen.toasts.filter(x => x.includes('left undone'))).toEqual(['+2 left undone'])
})

test('the same item from a builder and the orchestrator is one row', async ($: any, on: any) => {
  await setup($, on)
  await $.agent.spawn(SPAWN)
  await turn($, '**Not done**\n- Close #135 at release', 'agent-1')
  await turn($, "I'll close #135 at release.")
  const ui = await mountPane($)
  expect(await ui.findAll({ type: 'Button', key: 'u-done-U1' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Button', key: 'u-done-U2' })).toHaveLength(0)
  expect(await texts(ui)).toContain('+1')
  await ui.unmount()
})

test('items survive /clear: the pane draws them with no session.start after it', async ($: any, on: any) => {
  await setup($, on)
  await turn($, "I'll close #135 at release.")
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: {} })
  const ui = await mountPane($)
  expect(await texts(ui)).toContain("I'll close #135 at release.")
  await ui.unmount()
})

test('done and drop buttons resolve an item; a dropped one does not return', async ($: any, on: any) => {
  await setup($, on)
  await turn($, '**Not done**\n- Alpha thing to finish\n- Beta thing to finish', 'agent-1')
  const ui = await mountPane($)
  await ui.press({ key: 'u-done-U1' })
  await ui.press({ key: 'u-drop-U2' })
  expect(await texts(ui)).toContain('Nothing open.')
  // The same builder repeating its report brings back neither: Alpha was done, Beta dropped.
  await turn($, '**Not done**\n- Beta thing to finish\n- Alpha thing to finish', 'agent-1')
  expect(await texts(ui)).toContain('Nothing open.')
  await turn($, '**Not done**\n- Beta thing to finish\n- Alpha thing to finish', 'agent-2')
  const t = await texts(ui)
  // From another builder, Alpha was only done, so it can return; Beta was dropped, so it cannot.
  expect(t).toContain('Alpha thing to finish')
  expect(t).not.toContain('Beta thing')
  await ui.unmount()
})

test('writes and edits with TODO markers add items; removing the marker resolves them', async ($: any, on: any) => {
  await setup($, on)
  await $.tool.call({ tool: 'Write', tool_use_id: 'a', file_path: '/w/src/mic.ts', content: 'const a = 1\n// TODO: handle no device\n' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'b', file_path: '/w/README.md', content: '// TODO: docs' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'c', file_path: '/w/package-lock.json', content: '// TODO' })
  let ui = await mountPane($)
  let t = await texts(ui)
  expect(t).toContain('handle no device')
  expect(t).toContain('src/mic.ts')
  expect(t).not.toContain('docs')
  await $.tool.call({ tool: 'Edit', tool_use_id: 'd', file_path: '/w/src/mic.ts', old_string: '// TODO: handle no device\n', new_string: 'if (!device) return\n' })
  t = await texts(ui)
  expect(t).toContain('Nothing open.')
  await ui.unmount()
})

test('a builder\'s own edit is labelled with the worker', async ($: any, on: any) => {
  await setup($, on)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e', agentId: 'agent-1', file_path: '/w/src/x.ts', old_string: 'a', new_string: 'a // FIXME retry' })
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('Web PR: mic repair')
  await ui.unmount()
})

test('the task list is mirrored and vanishes when completed; builders\' lists are ignored', async ($: any, on: any) => {
  await setup($, on)
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'a', todos: [{ content: 'Wire the card', status: 'in_progress', activeForm: 'Wiring' }] })
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'b', agentId: 'agent-1', todos: [{ content: 'Builder internal step', status: 'pending', activeForm: 'x' }] })
  let ui = await mountPane($)
  let t = await texts(ui)
  expect(t).toContain('Wire the card')
  expect(t).not.toContain('Builder internal step')
  await $.tool.call({ tool: 'TodoWrite', tool_use_id: 'c', todos: [{ content: 'Wire the card', status: 'completed', activeForm: 'Wiring' }] })
  t = await texts(ui)
  expect(t).not.toContain('Wire the card')
  await ui.unmount()
})

test('a candidate that restates Waiting on Sam never reaches the card', async ($: any, on: any) => {
  await setup($, on)
  await turn($, '**Not done**\n- Web release timing\n- Something else entirely to finish', 'agent-1')
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('Something else entirely')
  expect(await ui.findAll({ type: 'Button', key: 'u-done-U1' })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Button', key: 'u-done-U2' })).toHaveLength(0)
  await ui.unmount()
})

test('the card is amber when open and the border is never red', async ($: any, on: any) => {
  await setup($, on)
  await turn($, "I'll close #135 at release.")
  const ui = await mountPane($)
  const tree = JSON.stringify(await ui.drawn())
  const m = /"borderColor":"(\w+)"[^]*?"Left undone"/.exec(tree)
  const boxes = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props.borderStyle && JSON.stringify(b.children).includes('"Left undone"'))
  expect(boxes[0]?.props.borderColor).toBe('warning')
  expect(m).toBeDefined()
  await ui.unmount()
})
