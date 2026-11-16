import { expect, test } from 'claude-code/testing'

import { seen } from './helpers'
import { OPTIONS, SPAWN, commandsRun, compactions, k, measure, mountPane, setup, texts, turn } from './kit'
import { LAST_ASK_MAX, buildBrief, ruleText, compactKeepList, doorCheck, validateBriefFiles } from '../hooks/lib/handover'
import type { BriefInput } from '../hooks/lib/handover'
import { ws } from '../hooks/lib/workspace'

// The handover brief and the door. Text here is invented; nothing is a real record.

ws.current = { root: '/work/acme', owner: 'Sam', apps: [] }

const BRIEF = 'mcp__workbench__handover_brief'
const CLEAR = 'mcp__workbench__handover_clear'
const ADD = 'mcp__workbench__left_undone_add'

const call = ($: any, tool: string, input: Record<string, unknown> = {}) => $.tool.call({ tool, tool_use_id: `u-${Math.random()}`, ...input })
const said = (r: any): string => (typeof r?.result === 'string' ? r.result : '')
const isError = (r: any): boolean => r?.isError === true

const worker = (id: string, status = 'running') => ({ id, description: 'Web PR: mic repair', type: 'web-builder', status, startedAt: 1, worktree: 'worktrees/web/feat-x', lastActiveAt: 1_000 })
const undone = (id: string, text: string) => ({ id, key: id, kind: 'commit', tag: 'Said', text, sources: [{ label: 'orchestrator' }], refs: [], confidence: 'medium', firstAt: 0, lastAt: 0, seen: 1, status: 'open', sessionId: 's' }) as any

const INPUT: BriefInput = {
  now: Date.parse('2026-11-05T14:20:00'),
  why: 'context at 83%',
  files: ['notes/STATE.md', 'CLAUDE.md'],
  workers: [worker('agent-1') as any, worker('agent-2', 'completed') as any],
  prs: [{ app: 'web', number: 198, base: 'main', label: 'approved: merge and release' }],
  watchers: ['#198'],
  carried: [{ id: 'agent-1', why: 'waiting on CI' }],
  waiting: ['Web release timing', 'The CVE fixes'],
  undone: [undone('U1', "I'll close #135 at release"), { ...undone('U2', 'done already'), status: 'done' }],
  lastAsk: 'Ship the release once the PR is approved.',
}

test('the brief has the six parts in order, with pointers and no file contents', async () => {
  const text = buildBrief(INPUT)
  const at = (needle: string) => text.indexOf(needle)
  const order = ['Handover brief, 2026-11-05 14:20 (context at 83%)', 'Read first (pointers, not contents):', 'Workers running now:', 'Open PRs by next step:', 'Waiting on Sam:', 'Left undone (yours, open):', 'The last thing Sam asked', 'Rules that do not change']
  const positions = order.map(at)
  expect(positions.every(p => p >= 0)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  expect(text).toContain('- notes/STATE.md')
  expect(text).toContain('- agent-1 web-builder · web/feat-x · "Web PR: mic repair"')
  expect(text).toContain('carried: waiting on CI')
  expect(text).not.toContain('agent-2')
  expect(text).toContain('- web #198 → main: approved: merge and release')
  expect(text).toContain('PR watchers to restart (they do not survive a clear): #198')
  expect(text).toContain('1. Web release timing')
  expect(text).toContain("- U1 [Said, orchestrator, 20")
  expect(text).not.toContain('done already')
  expect(text).toContain('> Ship the release once the PR is approved.')
  expect(text).toContain(ruleText())
  expect(text).toContain('run ListAgents')
})

test('the same inputs give the same bytes, apart from the time stamp', async () => {
  expect(buildBrief(INPUT)).toBe(buildBrief({ ...INPUT }))
  const later = buildBrief({ ...INPUT, now: INPUT.now + 3_600_000 })
  const strip = (t: string) => t.replace(/Handover brief, [\d-]+ [\d:]+/, 'X').replace(/last active [^ ]+ ago/g, 'L').replace(/, \d+d\]/g, ']')
  expect(strip(later)).toBe(strip(buildBrief(INPUT)))
})

test('an undone item over 200 characters is cut, and the last ask over 600', async () => {
  const long = 'x'.repeat(500)
  const text = buildBrief({ ...INPUT, undone: [undone('U9', long)], lastAsk: 'y'.repeat(900) })
  expect(text).not.toContain('x'.repeat(201))
  expect(text).not.toContain('y'.repeat(LAST_ASK_MAX + 1))
  expect(text).toContain('…')
})

test('briefFiles under data/, env files and climbing paths are rejected', async () => {
  const got = validateBriefFiles(['notes/STATE.md', 'data/clients.csv', '/etc/hosts', '../x', '.env.local', 'apps/web/.env', 'notes/data/x.md', '/Users/x/root/CLAUDE.md', 'notes/a b.md', 'a;rm -rf', 'CLAUDE.md'], '/Users/x/root')
  expect(got.ok).toEqual(['notes/STATE.md', 'CLAUDE.md', 'notes/a b.md'].sort((a, b) => ['notes/STATE.md', 'CLAUDE.md', 'notes/a b.md'].indexOf(a) - ['notes/STATE.md', 'CLAUDE.md', 'notes/a b.md'].indexOf(b)).filter(x => got.ok.includes(x)))
  expect(got.ok).toContain('notes/STATE.md')
  expect(got.ok).toContain('CLAUDE.md')
  for (const bad of ['data/clients.csv', '/etc/hosts', '../x', '.env.local', 'apps/web/.env', 'notes/data/x.md', 'a;rm -rf']) expect(got.rejected).toContain(bad)
})

test('the door: a running worker blocks unless carried with a reason; a PR into main needs a watcher entry', async () => {
  const base = { workers: [worker('agent-1') as any], carry: [], prsToMain: [], watchers: [], isOverridden: false }
  expect(doorCheck(base)).toContain('agent-1 (Web PR: mic repair) still running')
  expect(doorCheck({ ...base, carry: [{ id: 'agent-1', why: '' }] })).not.toBeNull()
  expect(doorCheck({ ...base, carry: [{ id: 'agent-1', why: 'waiting on CI' }] })).toBeNull()
  expect(doorCheck({ ...base, workers: [worker('agent-1', 'completed') as any] })).toBeNull()
  const pr = { ...base, workers: [], prsToMain: [{ app: 'web', number: 198 }] }
  expect(doorCheck(pr)).toContain('web #198')
  expect(doorCheck({ ...pr, watchers: ['#198'] })).toBeNull()
  expect(doorCheck({ ...pr, isOverridden: true })).toBeNull()
})

test('the keep list is items 3 to 5 as text', async () => {
  const keep = compactKeepList(INPUT)
  expect(keep).toContain('Keep through this compaction')
  expect(keep).toContain('Workers running now:')
  expect(keep).toContain('Left undone (yours, open):')
  expect(keep).toContain('The last thing Sam asked')
  expect(keep).not.toContain('Read first')
  expect(keep).not.toContain('Rules that do not change')
})

test('handover_brief returns the assembled brief with the pointers from the setting', { options: { briefFiles: 'notes/STATE.md, data/clients.csv, CLAUDE.md' } }, async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await call($, ADD, { text: "I'll write the release note after the merge" })
  const got = said(await call($, BRIEF, { last_ask: 'Fix the mic button' }))
  expect(got).toContain('- notes/STATE.md')
  expect(got).toContain('- CLAUDE.md')
  expect(got).not.toContain('clients.csv\n')
  expect(got).toContain('(briefFiles left out: data/clients.csv)')
  expect(got).toContain('> Fix the mic button')
  expect(got).toContain("U1 [Note, orchestrator")
})

test('handover_clear is refused while a worker runs, naming it, and passes when it is carried', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await $.agent.spawn(SPAWN)
  const refused = await call($, CLEAR, { last_ask: 'x' })
  expect(isError(refused)).toBe(true)
  expect(said(refused)).toContain('agent-1 (Web PR: mic repair) still running')
  const ok = await call($, CLEAR, { last_ask: 'x', carry: [{ id: 'agent-1', why: 'waiting on CI' }] })
  expect(isError(ok)).toBe(false)
  expect(said(ok)).toContain('Queued')
})

test('a PR into main needs a watcher in the brief', async ($: any, on: any) => {
  await setup($, on, { quiet: false })
  const ui = await mountPane($)
  expect(isError(await call($, CLEAR, { last_ask: 'x' }))).toBe(true)
  expect(said(await call($, CLEAR, { last_ask: 'x' }))).toContain('web #198')
  expect(isError(await call($, CLEAR, { last_ask: 'x', watchers: ['#198'] }))).toBe(false)
  const brief = said(await call($, BRIEF, { last_ask: 'x' }))
  expect(brief).toContain('- web #198 → main: approved: merge and release')
  await ui.unmount()
})

test('a queued clear is put in the prompt when the turn ends; the brief follows the clear', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await call($, CLEAR, { last_ask: 'Ship it' })
  expect(seen.filled).toEqual([])
  await turn($, 'Done.')
  expect(seen.filled).toEqual(['/clear'])
  expect(commandsRun).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: {} })
  expect(seen.filled).toHaveLength(2)
  expect(seen.filled[1]).toContain('Handover brief,')
  expect(seen.filled[1]).toContain('> Ship it')
  expect(seen.submitted).toEqual([])
})

test('with handoverClear on, the clear is run and the brief still waits in the prompt box', { options: { handoverClear: true } }, async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await call($, CLEAR, { last_ask: 'Ship it' })
  await turn($, 'Done.')
  expect(commandsRun).toEqual(['clear'])
  expect(seen.filled).toEqual([])
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: {} })
  expect(seen.filled).toHaveLength(1)
  expect(seen.submitted).toEqual([])
})

test('a prompt from Sam cancels the queued clear', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await call($, CLEAR, { last_ask: 'Ship it' })
  await $.prompt.submit({ text: 'actually, wait' })
  await turn($, 'Done.')
  expect(seen.filled).toEqual([])
  expect(seen.toasts).toContain('Handover cancelled: you sent a prompt.')
})

test('b asks Claude for the handover (filled, not sent); b twice lifts the door for two minutes', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await measure($, [], 83)
  const ui = await mountPane($)
  await $.agent.spawn(SPAWN)
  await ui.press({ key: 'ctx-brief' })
  expect(seen.filled.at(-1)).toContain('Call handover_brief with last_ask')
  expect(seen.filled.at(-1)).toContain('Context is 83% full')
  expect(seen.submitted).toEqual([])
  expect(isError(await call($, CLEAR, { last_ask: 'x' }))).toBe(true)
  await ui.press({ key: 'ctx-brief' })
  expect(seen.toasts).toContain('Door override on for 2 minutes.')
  expect(isError(await call($, CLEAR, { last_ask: 'x' }))).toBe(false)
  k.now += 3 * 60_000
  expect(isError(await call($, CLEAR, { last_ask: 'x' }))).toBe(true)
  await ui.unmount()
})

test('compact now passes the keep list as the instructions', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await $.agent.spawn(SPAWN)
  await measure($, [], 72)
  const ui = await mountPane($)
  await ui.press({ key: 'ctx-compact-now' })
  expect(compactions).toHaveLength(1)
  expect(compactions[0]).toContain('Keep through this compaction')
  expect(compactions[0]).toContain('agent-1 web-builder')
  await ui.unmount()
})

test('the buttons carry the hotkeys b and n; n appears only at the warning level', async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  await measure($, [], 30)
  let ui = await mountPane($)
  let keys = Object.fromEntries((await ui.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey]))
  expect(keys['ctx-brief']).toBe('b')
  expect(keys['ctx-compact-now']).toBeUndefined()
  await ui.unmount()
  await measure($, [], 70)
  ui = await mountPane($)
  keys = Object.fromEntries((await ui.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey]))
  expect(keys['ctx-compact-now']).toBe('n')
  expect(await texts(ui)).toContain('handover brief')
  await ui.unmount()
  void OPTIONS
})

test('the brief says how many Waiting on Sam items it left out past nine', async () => {
  const waiting = Array.from({ length: 11 }, (_, n) => `Made-up item ${n + 1}`)
  const text = buildBrief({ ...INPUT, waiting })
  expect(text).toContain('9. Made-up item 9')
  expect(text).not.toContain('10. Made-up item 10')
  expect(text).toContain('(and 2 more: notes/STATE.md lists them)')
  expect(buildBrief({ ...INPUT, waiting: waiting.slice(0, 9) })).not.toContain('and 2 more')
})
