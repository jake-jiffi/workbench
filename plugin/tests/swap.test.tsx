import { expect, test } from 'claude-code/testing'

import { gh, seen } from './helpers'
import { OPTIONS, ORG, WHO, calls, commandsRun, hasKey, k, mcpCalls, mcp, measure, mountPane, setup, texts, turn, SPAWN } from './kit'
import { MOVE_KEY, NEXT_STEP_PROMPT, WHAT_CHANGES, isAccountFailure, swapChecks } from '../hooks/lib/swap'

// The swap sheet and the move. Nothing here signs in: the mod leaves a request for the claude wrapper, fills
// /exit and the person presses Enter. The account probe is a mock, so a "change" is the mock answering with
// another address.

const K0 = 1_762_140_000_000
const WRAPPED = { CLAUDE_WRAPPER_PID: '4242' }
const REQUEST = '/Users/test/.claude/swap-requests/4242.json'

const startTurn = ($: any) => $.turn.start({ text: 'carry on', turnId: `s-${Math.random()}` })

async function readyPane($: any, on: any, o: { quiet?: boolean; env?: Record<string, string>; store?: Record<string, unknown> } = {}) {
  await setup($, on, { quiet: true, ...o })
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  return ui
}

// The session the wrapper reopened after a move to team: the store still holds the move.
const moved = (o: { at?: number; session?: string } = {}) => ({
  [MOVE_KEY]: { label: 'team', session: o.session ?? 'session-1', fromEmail: 'lab@example.com', fromOrg: 'org-b', at: o.at ?? K0 - 30_000 },
})

test('a opens the sheet; without the wrapper the button fills /exit, writes nothing and says how to move', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on)
  await ui.press({ key: 'acct-swap' })
  const t = await texts(ui)
  expect(t).toContain('Swap account')
  expect(t).toContain('To team · team@example.com (max) · 5-hour 70%')
  expect(t).toContain('put /exit in the prompt')
  expect(t.replace(/\s+/g, ' ')).toContain('To move: press Enter on /exit, then start claude on the team account')
  await ui.press({ key: 'sw-move' })
  expect(seen.filled).toEqual(['/exit'])
  expect(seen.submitted).toEqual([])
  expect(seen.written).toEqual([])
  expect(commandsRun).toEqual([])
  expect(seen.toasts).toContain('Press Enter on /exit, then start claude on the team account.')
  for (const c of calls) expect(c.argv.join(' ')).not.toMatch(/login|logout/)
  await ui.unmount()
})

test('under the wrapper the move leaves the request for its pid, keeps the move and fills /exit', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { env: WRAPPED })
  await ui.press({ key: 'acct-swap' })
  expect(await texts(ui)).toContain('move this conversation to team')
  await ui.press({ key: 'sw-move' })
  expect(seen.written).toHaveLength(1)
  expect(seen.written[0]?.path).toBe(REQUEST)
  expect(JSON.parse(seen.written[0]?.text ?? '')).toEqual({ account: 'team', session: 'session-1', at: K0 })
  expect(seen.filled).toEqual(['/exit'])
  expect(seen.submitted).toEqual([])
  expect(seen.toasts).toContain('Press Enter: this conversation reopens on team.')
  const t = (await texts(ui)).replace(/\s+/g, ' ')
  expect(t).toContain('this conversation reopens on team in this terminal')
  expect(t).not.toContain('claude-swap')
  await ui.unmount()
})

test('even with finishSends /exit is only filled', { options: { ...OPTIONS, finishSends: true } }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { env: WRAPPED })
  await ui.press({ key: 'acct-swap' })
  await ui.press({ key: 'sw-move' })
  expect(seen.filled).toEqual(['/exit'])
  expect(seen.submitted).toEqual([])
  await ui.unmount()
})

test('a pid that is not a number is ignored: nothing is written anywhere', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { env: { CLAUDE_WRAPPER_PID: '../../x' } })
  await ui.press({ key: 'acct-swap' })
  await ui.press({ key: 'sw-move' })
  expect(seen.written).toEqual([])
  expect(seen.filled).toEqual(['/exit'])
  await ui.unmount()
})

test('a click on another account row moves straight away; this session\'s row is not a button', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { env: WRAPPED })
  const buttons = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key)
  expect(buttons).toContain('k-team')
  expect(buttons).not.toContain('k-lab')
  await ui.press({ key: 'k-team' })
  expect(seen.written.map(w => JSON.parse(w.text).account)).toEqual(['team'])
  expect(seen.filled).toEqual(['/exit'])
  expect(await texts(ui)).toContain('Swap account')
  await ui.unmount()
})

test('a click on a row while a release is in flight opens the held sheet and writes nothing', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { quiet: false, env: WRAPPED })
  await ui.press({ key: 'k-team' })
  const t = await texts(ui)
  expect(t).toContain('A release is in flight: finish or park it first')
  expect(t).toContain('held: press twice to move this conversation to team')
  expect(seen.written).toEqual([])
  expect(seen.filled).toEqual([])
  await ui.unmount()
})

test('the hotkeys are a and s on the Accounts card', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on)
  const keys = Object.fromEntries((await ui.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey]))
  expect(keys['acct-swap']).toBe('a')
  expect(keys['acct-choose']).toBe('s')
  await ui.unmount()
})

test('with a release in flight the move is held until it is pressed twice inside a minute', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { quiet: false, env: WRAPPED })
  await ui.press({ key: 'acct-swap' })
  expect(await texts(ui)).toContain('held: press twice to move this conversation to team')
  await ui.press({ key: 'sw-move' })
  expect(seen.filled).toEqual([])
  expect(seen.written).toEqual([])
  expect(await texts(ui)).toContain('press again: move this conversation to team')
  await ui.press({ key: 'sw-move' })
  expect(seen.filled).toEqual(['/exit'])
  expect(seen.written).toHaveLength(1)
  await ui.unmount()
})

test('a second press after the minute only re-arms the hold', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { quiet: false })
  await ui.press({ key: 'acct-swap' })
  await ui.press({ key: 'sw-move' })
  k.now += 61_000
  await ui.press({ key: 'sw-move' })
  expect(seen.filled).toEqual([])
  await ui.unmount()
})

test('running workers hold the move even in the same organisation: the restart ends them', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on, { quiet: true })
  ORG['/d/team'] = 'org-b'
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  await $.agent.spawn(SPAWN)
  await ui.press({ key: 'acct-swap' })
  const t = (await texts(ui)).replace(/\s+/g, ' ')
  expect(t).toContain('1 worker running (agent-1). The restart ends them; their worktrees stay.')
  expect(t).toContain('held: press twice')
  await ui.press({ key: 'sw-move' })
  expect(seen.filled).toEqual([])
  ORG['/d/team'] = 'org-a'
  await ui.unmount()
})

test('the sheet says what changes: workers, instruction files, connectors, cache, plan', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on)
  await ui.press({ key: 'acct-swap' })
  const t = (await texts(ui)).replace(/\s+/g, ' ')
  expect(t).toMatch(/Ended: background workers/)
  expect(t).toMatch(/instruction files/)
  expect(t).toMatch(/claude\.ai connectors/)
  expect(t).toMatch(/prompt cache/)
  expect(t).toMatch(/plan, limits and model access/i)
  expect(t).toContain('A handover brief is saved first')
  for (const x of await ui.findAll({ type: 'Text' })) expect(x.text.length).toBeLessThanOrEqual(86)
  expect(WHAT_CHANGES.join(' ')).toMatch(/Opus/)
  await ui.unmount()
})

test('the reopened session announces the move once the probe sees the new email, and fills the next step', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { store: moved() })
  // the probe still answers the old address: nothing yet
  await startTurn($)
  expect(seen.toasts.some(t => t.startsWith('Now on'))).toBe(false)
  WHO.self = 'team@example.com'
  ORG.self = 'org-a'
  await startTurn($)
  expect(seen.toasts.filter(t => t.startsWith('Now on'))).toHaveLength(1)
  expect(seen.toasts.find(t => t.startsWith('Now on'))).toMatch(/^Now on team \(60%\)\. Connectors may be gone\.$/)
  expect(await texts(ui)).toContain('Account changed')
  // a cross-organisation change fills the next-step prompt for the orchestrator, and does not send it
  expect(seen.filled.at(-1)).toBe(NEXT_STEP_PROMPT('team'))
  expect(seen.submitted).toEqual([])
  await startTurn($)
  expect(seen.toasts.filter(t => t.startsWith('Now on'))).toHaveLength(1)
  await ui.unmount()
})

test('a stale move is dropped and never announced', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { store: moved({ at: K0 - 7 * 60_000 }) })
  WHO.self = 'team@example.com'
  await startTurn($)
  expect(seen.toasts.some(t => t.startsWith('Now on'))).toBe(false)
  await ui.unmount()
})

test('another session\'s move is left for it', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { store: moved({ session: 'session-2' }) })
  WHO.self = 'team@example.com'
  await startTurn($)
  expect(seen.toasts.some(t => t.startsWith('Now on'))).toBe(false)
  await ui.unmount()
})

test('without a move nothing is watched', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on)
  WHO.self = 'team@example.com'
  await startTurn($)
  expect(seen.toasts.some(t => t.startsWith('Now on'))).toBe(false)
  await ui.unmount()
})

test('after a move the post-check reports a connector that does not answer', { options: { ...OPTIONS, connectorProbe: 'claude.ai Slack|slack_search_users' } }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { store: moved() })
  mcp.fails = true
  WHO.self = 'team@example.com'
  await startTurn($)
  expect(mcpCalls).toEqual([{ server: 'claude.ai Slack', tool: 'slack_search_users' }])
  const t = await texts(ui)
  expect(t).toContain('claude.ai Slack did not answer')
  const result = (await ui.findAll({ type: 'Text' })).find((x: any) => x.text.includes('did not answer'))
  expect(result?.props.color).toBe('error')
  await ui.unmount()
})

test('with the connector check off the sheet says so and calls nothing', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { store: moved() })
  WHO.self = 'team@example.com'
  await startTurn($)
  expect(mcpCalls).toEqual([])
  expect(await texts(ui)).toContain('Connector check is off')
  await ui.unmount()
})

test('an account on the same email in another organisation is still another account', { options: OPTIONS }, async ($: any, on: any) => {
  WHO['/d/team'] = 'lab@example.com'
  try {
    const ui = await readyPane($, on, { store: moved() })
    const buttons = (await ui.findAll({ type: 'Button' })).map((b: any) => b.key)
    expect(buttons).toContain('k-team')
    expect(buttons).not.toContain('k-lab')
    expect(await texts(ui)).toContain('swap to team')
    await ui.press({ key: 'acct-choose' })
    expect(await hasKey(ui, 'sw-pick-team')).toBe(true)
    // the reopened session is on the same email in org-a: still a change
    ORG.self = 'org-a'
    await startTurn($)
    expect(seen.toasts.filter(t => t.startsWith('Now on'))).toEqual(['Now on team (60%). Connectors may be gone.'])
    await ui.unmount()
  } finally {
    WHO['/d/team'] = 'team@example.com'
  }
})

test('the sheet closes, and /model is filled instead on request', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on)
  await ui.press({ key: 'acct-swap' })
  await ui.press({ key: 'sw-model' })
  expect(seen.filled).toEqual(['/model'])
  await ui.press({ key: 'sw-close' })
  expect(await texts(ui)).not.toContain('Swap account')
  await ui.unmount()
})

test('s lets Sam choose the target', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on)
  await ui.press({ key: 'acct-choose' })
  expect(await hasKey(ui, 'sw-pick-team')).toBe(true)
  expect(await hasKey(ui, 'sw-pick-lab')).toBe(false)
  await ui.press({ key: 'sw-pick-team' })
  expect(await texts(ui)).toContain('To team')
  await ui.unmount()
})

test('a worker failure with an account error just after a move is amber and tagged, not red', { options: OPTIONS }, async ($: any, on: any) => {
  const ui = await readyPane($, on, { store: moved() })
  WHO.self = 'team@example.com'
  await startTurn($)
  await $.agent.spawn(SPAWN)
  await $.turn.complete({ answer: 'API error: authentication_failed (401)', durationMs: 1, isAborted: false, turnId: 'w1', reason: 'error', agentId: 'agent-1' })
  const row = (await ui.findAll({ type: 'Text' })).find((x: any) => x.text.includes('Web PR: mic repair'))
  expect(row?.text).toContain('account')
  expect(row?.text).not.toContain('failed')
  await ui.unmount()
})

test('pure: the checks, the failure words and the window', async () => {
  const w = (id: string, status = 'running') => ({ id, description: 'x', type: 'web-builder', status, startedAt: 1 })
  const none = swapChecks({ workers: [], isRelease: false })
  expect(none.isBlocked).toBe(false)
  expect(swapChecks({ workers: [], isRelease: true }).isBlocked).toBe(true)
  expect(swapChecks({ workers: [w('a')], isRelease: false }).isBlocked).toBe(true)
  expect(swapChecks({ workers: [w('a', 'completed')], isRelease: false }).isBlocked).toBe(false)
  expect(swapChecks({ workers: [w('a')], isRelease: false, selfOrg: 'o', target: { at: 1, orgId: 'o' } }).isBlocked).toBe(true)
  expect(swapChecks({ workers: [], isRelease: false, selfOrg: 'o', target: { at: 1, orgId: 'o' } }).isBlocked).toBe(false)
  expect(isAccountFailure('authentication_failed')).toBe(true)
  expect(isAccountFailure('HTTP 401 Unauthorized')).toBe(true)
  expect(isAccountFailure('Your credit balance is too low')).toBe(true)
  expect(isAccountFailure('TypeError: undefined is not a function')).toBe(false)
  expect(isAccountFailure('Fixed 401 lines of CSS')).toBe(false)
  expect(isAccountFailure('API error: authentication_failed (401)')).toBe(true)
  void gh
  void turn
  void measure
})
