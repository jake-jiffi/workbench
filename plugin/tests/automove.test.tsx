import { expect, test } from 'claude-code/testing'

import { AUTO_COOLDOWN_MIN, alertKey, decideAutoMove, hitOf, parseAutoPct } from '../hooks/lib/automove'
import type { AutoInput } from '../hooks/lib/automove'
import { swapChecks } from '../hooks/lib/swap'
import type { AccountRow } from '../types'
import { agents, commandNames, gh, mocked, promptBox, reads, seen } from './helpers'
import { MOVE_KEY } from '../hooks/lib/swap'
import { ORG, SESSION, USE, WEEK, WHO, commandsRun, iso, k, mountPane, measure, setup, texts, turn } from './kit'

// The automatic move. Pure table first (every hold on its own, the line at 93 and 94 on each meter, which accounts
// can be chosen), then the real hooks on a mock clock.

const NOW = 1_762_140_000_000
const FUTURE = new Date(NOW + 3_600_000).toISOString()
const SELF = { email: 'sam@example.com', orgId: 'org-a' }

const row = (label: string, o: { email?: string; org?: string; session?: number; week?: number; at?: number; error?: 'billing_error' | 'unreadable' } = {}): AccountRow => ({
  label,
  dir: `/d/${label}`,
  reading: {
    email: o.email ?? `${label}@example.com`,
    orgId: o.org ?? `org-${label}`,
    session: o.session === undefined ? { percent: 10 } : { percent: o.session },
    week: o.error ? undefined : { percent: o.week ?? 20 },
    error: o.error,
    at: o.at ?? NOW - 60_000,
  },
})

const input = (over: Partial<AutoInput> = {}): AutoInput => ({
  pct: 94,
  now: NOW,
  limits: [{ kind: 'five_hour', percent: 94, resetsAt: FUTURE }],
  self: SELF,
  rows: [row('team', { email: SELF.email, org: 'org-a', week: 94 }), row('personal'), row('lab')],
  probeMinutes: 15,
  canMove: true,
  isTurnRunning: false,
  promptText: '',
  checks: swapChecks({ workers: [], isRelease: false }),
  prState: 'ok',
  background: { known: true, tasks: 0, crons: 0 },
  lastMoveAt: 0,
  staleGiveUp: false,
  ...over,
})

const code = (i: AutoInput) => {
  const v = decideAutoMove(i)
  return v.kind === 'hold' ? v.code : v.kind
}

test('93 does not fire and 94 does, on each meter', async () => {
  for (const kind of ['five_hour', 'seven_day']) {
    expect(code(input({ limits: [{ kind, percent: 93, resetsAt: FUTURE }] }))).toBe('below')
    expect(code(input({ limits: [{ kind, percent: 94, resetsAt: FUTURE }] }))).toBe('move')
    expect(code(input({ limits: [{ kind, percent: 100, resetsAt: FUTURE }] }))).toBe('move')
  }
  // A meter that is not one of the two, or a window that has already reset, is not a reason to move.
  expect(code(input({ limits: [{ kind: 'spend_limit', percent: 99 }] }))).toBe('below')
  expect(code(input({ limits: [{ kind: 'five_hour', percent: 99, resetsAt: new Date(NOW - 1000).toISOString() }] }))).toBe('below')
  // Off, and the option's parsing.
  expect(code(input({ pct: 0 }))).toBe('off')
  expect([parseAutoPct(undefined), parseAutoPct(94), parseAutoPct('90'), parseAutoPct(0), parseAutoPct(120), parseAutoPct('x'), parseAutoPct(10)]).toEqual([94, 94, 90, 0, 0, 0, 50])
  expect(hitOf([{ kind: 'five_hour', percent: 95 }, { kind: 'seven_day', percent: 97 }], 94, NOW)?.kind).toBe('seven_day')
})

test('each condition holds the move on its own', async () => {
  const running = [{ id: 'a', description: 'x', type: 't', status: 'running', startedAt: 0 }]
  const table: Array<[string, Partial<AutoInput>, string]> = [
    ['a release in flight', { checks: swapChecks({ workers: [], isRelease: true }) }, 'at-risk'],
    ['a worker running', { checks: swapChecks({ workers: running, isRelease: false }) }, 'at-risk'],
    ['a background task', { background: { known: true, tasks: 1, crons: 0 }, checks: swapChecks({ workers: [], isRelease: false, background: { tasks: 1, crons: 0 } }) }, 'at-risk'],
    ['a background task seen only by the last Stop', { background: { known: true, tasks: 2, crons: 0 } }, 'background'],
    ['a scheduled wake-up', { background: { known: true, tasks: 0, crons: 1 } }, 'background'],
    ['background not known yet', { background: { known: false, tasks: 0, crons: 0 } }, 'bg-unknown'],
    ['a turn running', { isTurnRunning: true }, 'turn'],
    ['text in the prompt box', { promptText: 'half a sentence' }, 'typing'],
    ['a prompt box that cannot be read', { promptText: undefined }, 'typing'],
    ['no wrapper', { canMove: false }, 'no-wrapper'],
    ['the PR list unknown', { prState: 'unknown' }, 'pr-unknown'],
    ['a move a minute ago', { lastMoveAt: NOW - 60_000 }, 'cooldown'],
  ]
  expect(code(input())).toBe('move')
  for (const [name, over, want] of table) expect([name, code(input(over))]).toEqual([name, want])
  // A whitespace-only box is empty. The cooldown lifts after its minutes.
  expect(code(input({ promptText: '  \n' }))).toBe('move')
  expect(code(input({ lastMoveAt: NOW - AUTO_COOLDOWN_MIN * 60_000 }))).toBe('move')
  // Only the ones that cannot clear by themselves are told to Sam.
  const alert = (over: Partial<AutoInput>) => {
    const v = decideAutoMove(input(over))
    return v.kind === 'hold' && v.alert
  }
  expect([alert({ isTurnRunning: true }), alert({ promptText: 'x' }), alert({ lastMoveAt: NOW - 1 }), alert({ canMove: false }), alert({ checks: swapChecks({ workers: running, isRelease: false }) })]).toEqual([false, false, false, true, true])
})

test('the target: below the line on both meters, fresh, readable, not out of credits; any of the three accounts can be chosen', async () => {
  const rowsFor = (...rows: AccountRow[]) => ({ rows: [row('team', { email: SELF.email, org: 'org-a', week: 94 }), ...rows] })
  const pick = (over: Partial<AutoInput>) => {
    const v = decideAutoMove(input(over))
    return v.kind === 'move' ? v.label : v.kind === 'hold' ? v.code : v.kind
  }
  // Both meters under the line on the target.
  expect(pick(rowsFor(row('b', { session: 93, week: 93 })))).toBe('b')
  expect(pick(rowsFor(row('b', { session: 94, week: 10 })))).toBe('no-target')
  expect(pick(rowsFor(row('b', { session: 10, week: 94 })))).toBe('no-target')
  // Readable and not out of credits.
  expect(pick(rowsFor(row('b', { error: 'billing_error' })))).toBe('no-target')
  expect(pick(rowsFor(row('b', { error: 'unreadable' })))).toBe('no-target')
  // Fresh: a stale reading is waited for (a probe is due), then given up on.
  const stale = row('b', { at: NOW - 16 * 60_000 })
  expect(pick(rowsFor(stale))).toBe('stale')
  expect(pick({ ...rowsFor(stale), staleGiveUp: true })).toBe('no-target')
  // A fresh target is used without waiting for a stale one.
  expect(pick(rowsFor(stale, row('c')))).toBe('c')
  // The lowest week wins.
  expect(pick(rowsFor(row('b', { week: 50 }), row('c', { week: 30 })))).toBe('c')
  // Any of the three can be chosen, whichever the session is on, whatever its address: no organisation, domain or
  // label rule. Two rows sharing an address with different organisations are different accounts.
  for (const [self, target] of [['team', 'personal'], ['team', 'lab'], ['personal', 'team'], ['personal', 'lab'], ['lab', 'team'], ['lab', 'personal']] as const) {
    const rows = [
      row('team', { email: 'sam@example.com', org: 'org-team', week: 90 }),
      row('personal', { email: 'sam@example.com', org: 'org-personal', week: 90 }),
      row('lab', { email: 'sam@other.example', org: 'org-lab', week: 90 }),
    ]
    const mine = rows.find(r => r.label === self) as AccountRow
    const rank = rows.map(r => (r.label === target ? { ...r, reading: { ...r.reading!, week: { percent: 5 } } } : r))
    expect([self, pick({ self: { email: mine.reading!.email, orgId: mine.reading!.orgId }, rows: rank })]).toEqual([self, target])
  }
  // No other account at all.
  expect(pick({ rows: [row('team', { email: SELF.email, org: 'org-a', week: 94 })] })).toBe('no-target')
})

test('no ping-pong: a move starts a cooldown, and the account it left is not a target while it is still over the line', async () => {
  const a = row('a', { week: 96 })
  const b = row('b', { week: 10 })
  const onA = { email: a.reading!.email, orgId: a.reading!.orgId }
  const onB = { email: b.reading!.email, orgId: b.reading!.orgId }
  // On A at 96: moves to B.
  expect(decideAutoMove(input({ self: onA, rows: [a, b] }))).toMatchObject({ kind: 'move', label: 'b' })
  // On B soon after, B now at 94 and A still at 96: A is over the line, so there is nowhere to go; and inside the
  // cooldown nothing would fire anyway.
  const b2 = row('b', { week: 94 })
  expect(code(input({ self: onB, rows: [a, b2], lastMoveAt: NOW - 5 * 60_000 }))).toBe('cooldown')
  expect(code(input({ self: onB, rows: [a, b2], lastMoveAt: NOW - 60 * 60_000 }))).toBe('no-target')
  // If A has reset since (under the line), a later move back is the intended behaviour, not a bounce.
  expect(decideAutoMove(input({ self: onB, rows: [row('a', { week: 5 }), b2], lastMoveAt: NOW - 60 * 60_000 }))).toMatchObject({ kind: 'move', label: 'a' })
})

test('the alert key is per account and per window', async () => {
  const hit = { kind: 'five_hour', percent: 95, resetsAt: FUTURE }
  expect(alertKey('me', hit, NOW)).toBe(alertKey('me', { ...hit, percent: 99 }, NOW + 1000))
  expect(alertKey('me', hit, NOW)).not.toBe(alertKey('you', hit, NOW))
  expect(alertKey('me', hit, NOW)).not.toBe(alertKey('me', { ...hit, resetsAt: new Date(NOW + 5 * 3_600_000).toISOString() }, NOW))
  expect(alertKey('me', { ...hit, kind: 'seven_day' }, NOW)).not.toBe(alertKey('me', hit, NOW))
})

// ---------- the hooks, on a mock clock ----------

const WRAPPED = { CLAUDE_WRAPPER_PID: '4242' }
const REQUEST = '/Users/test/.claude/swap-requests/4242.json'
const OPTS = { accounts: 'team=/d/team, personal=/d/personal, lab=/d/lab' }
const commands = commandNames
const box = promptBox

async function ready($: any, on: any, o: { env?: Record<string, string>; store?: Record<string, unknown> } = {}) {
  await setup($, on, { quiet: true, clock: true, env: { ...WRAPPED, ...o.env }, store: o.store })
  WHO.self = 'sam@example.com'
  ORG.self = 'org-team'
  WHO['/d/team'] = 'sam@example.com'
  ORG['/d/team'] = 'org-team'
  WHO['/d/personal'] = 'sam@example.com'
  ORG['/d/personal'] = 'org-personal'
  WHO['/d/lab'] = 'sam@other.example'
  ORG['/d/lab'] = 'org-lab'
  USE['/d/team'] = `${SESSION(50)}\n${WEEK(50)}`
  USE['/d/personal'] = `${SESSION(10)}\n${WEEK(10)}`
  USE['/d/lab'] = `${SESSION(20)}\n${WEEK(20)}`
  USE.self = `${SESSION(50)}\n${WEEK(50)}`
  agents.list = []
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  // The last Stop: nothing in flight.
  await $.classic.Stop({ background_tasks: [], session_crons: [] })
  return ui
}

const tickOnce = async () => {
  await mocked.clock!.advance(1000)
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
// Held checks are re-read at most every 5 seconds (or at once on a limit, background, agent or turn event).
const tickHeld = async () => {
  for (let i = 0; i < 5; i++) await tickOnce()
}
const fireAt = ($: any, percent: number, kind = 'five_hour') => measure($, [{ kind, percentUsed: percent, resetsAt: iso(3_600_000) }])
const WINDOW = { cwd: '/' }

test('at 94 with everything clear it leaves the request marked auto and runs /exit; nothing is filled or pressed', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  await fireAt($, 93)
  await tickOnce()
  expect(seen.written).toEqual([])
  await fireAt($, 94)
  await tickOnce()
  expect(seen.written).toHaveLength(1)
  expect(seen.written[0]?.path).toBe(REQUEST)
  // personal is the lowest at 10%.
  expect(JSON.parse(seen.written[0]?.text ?? '')).toMatchObject({ account: 'personal', session: 'session-1', auto: true })
  expect(commandsRun).toContain('exit')
  expect(seen.filled).toEqual([])
  expect(seen.submitted).toEqual([])
  expect(seen.toasts.join('\n')).toContain('moving to personal')
  // Once only: further ticks do not write again.
  await tickOnce()
  await tickOnce()
  expect(seen.written).toHaveLength(1)
  void WINDOW
  await ui.unmount()
})

test('the weekly meter fires it too', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  await fireAt($, 94, 'seven_day')
  await tickOnce()
  expect(seen.written).toHaveLength(1)
  await ui.unmount()
})

test('text being typed is never replaced; it moves once the box is empty', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  commands.list = [] // no supported /exit: the fallback is the only path that touches the prompt box
  box.text = 'half a sentence'
  await fireAt($, 96)
  for (let i = 0; i < 5; i++) await tickOnce()
  expect(seen.filled).toEqual([])
  expect(seen.written).toEqual([])
  expect(commandsRun).not.toContain('exit')
  expect((await texts(ui)).replace(/\s+/g, ' ')).toContain('held, text in the prompt box')
  box.text = ''
  // No event says the box was emptied: the held check looks again within 5 seconds.
  await tickHeld()
  expect(seen.written).toHaveLength(1)
  expect(seen.filled).toEqual(['/exit'])
  expect(seen.notices.join('\n')).toContain('Press Enter on /exit')
  await ui.unmount()
})

test('if the engine has no /exit to run, the fill and a notice are the fallback', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  commands.list = ['clear']
  await fireAt($, 95)
  await tickOnce()
  expect(commandsRun).not.toContain('exit')
  expect(seen.filled).toEqual(['/exit'])
  expect(seen.submitted).toEqual([])
  expect(seen.notices.join('\n')).toContain('personal')
  await ui.unmount()
})

test('a turn running, a worker, a background task, a release and a missing wrapper each hold it; clearing lets it through', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  await fireAt($, 95)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await tickOnce()
  expect(seen.written).toEqual([])
  await turn($, 'done')
  agents.list = [{ id: 'agent-9', description: 'builder', type: 'web-builder', status: 'running' }]
  await tickOnce()
  expect(seen.written).toEqual([])
  agents.list = []

  await $.classic.Stop({ background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'watch pr' }], session_crons: [] })
  await tickOnce()
  expect(seen.written).toEqual([])
  expect((await texts(ui)).replace(/\s+/g, ' ')).toContain('held, 1 background task')
  await $.classic.Stop({ background_tasks: [], session_crons: [{ id: 'c1', schedule: '* * * * *', recurring: true, prompt: 'x' }] })
  await tickOnce()
  expect(seen.written).toEqual([])
  await $.classic.Stop({ background_tasks: [], session_crons: [] })

  gh.prs = { 'acme/web-app': [{ number: 9, title: 'Release', baseRefName: 'main', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: '', statusCheckRollup: [], url: 'u' }], 'acme/mobile-app': [] }
  await ui.press({ key: 'refresh' })
  await tickOnce()
  expect(seen.written).toEqual([])
  gh.prs = { 'acme/web-app': [], 'acme/mobile-app': [] }
  await ui.press({ key: 'refresh' })
  await tickOnce()
  expect(seen.written).toHaveLength(1)
  await ui.unmount()
})

test('no wrapper: no move, nothing written, one alert', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on, { env: { CLAUDE_WRAPPER_PID: '' } })
  await fireAt($, 97)
  await tickOnce()
  expect(seen.written).toEqual([])
  expect(commandsRun).not.toContain('exit')
  expect(seen.toasts.filter(t => t.includes('Not moving'))).toHaveLength(1)
  await ui.unmount()
})

test('a hold that cannot clear alerts once per window, toast and notification, then again in the next window', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  agents.list = [{ id: 'agent-9', description: 'builder', type: 'web-builder', status: 'running' }]
  await fireAt($, 95)
  for (let i = 0; i < 4; i++) await tickOnce()
  const toasts = () => seen.toasts.filter(t => t.includes('Not moving'))
  const notes = () => seen.notices.filter(t => t.includes('Not moving'))
  expect(toasts()).toHaveLength(1)
  expect(notes()).toHaveLength(1)
  expect(toasts()[0]).toContain('1 worker running')
  // The percent moving inside the same window is not a new alert.
  await fireAt($, 97)
  await tickOnce()
  expect(toasts()).toHaveLength(1)
  // A new window is.
  await measure($, [{ kind: 'five_hour', percentUsed: 95, resetsAt: iso(5 * 3_600_000) }])
  await tickOnce()
  expect(toasts()).toHaveLength(2)
  // And it moves as soon as the hold clears.
  agents.list = []
  await tickHeld()
  expect(seen.written).toHaveLength(1)
  await ui.unmount()
})

test('a turn, a typed line and a cooldown only show on the card: no alert', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on, { store: { 'automove.last': { at: k.now - 5 * 60_000 } } })
  await fireAt($, 96)
  await tickOnce()
  expect(seen.written).toEqual([])
  expect(seen.toasts.filter(t => t.includes('Not moving'))).toEqual([])
  expect((await texts(ui)).replace(/\s+/g, ' ')).toContain('held, moved a short while ago')
  await ui.unmount()
})

test('a move inside the cooldown of the last one does not happen; after it, it does', { options: OPTS }, async ($: any, on: any) => {
  // U333: the last move was 30 minutes less 20 seconds ago, so the cooldown (AUTO_COOLDOWN_MIN) ends 20 seconds in.
  // The old test advanced the mock clock 25 minutes, 1500 one-second ticks, and timed out under load.
  const ui = await ready($, on, { store: { 'automove.last': { at: k.now - AUTO_COOLDOWN_MIN * 60_000 + 20_000, to: 'team', from: 'personal' } } })
  await fireAt($, 95)
  await tickOnce()
  expect(seen.written).toEqual([])
  for (let i = 0; i < 10; i++) await tickOnce()
  expect(seen.written).toEqual([])
  expect((await texts(ui)).replace(/\s+/g, ' ')).toContain('held, moved a short while ago')
  for (let i = 0; i < 15; i++) await tickOnce()
  expect(seen.written).toHaveLength(1)
  await ui.unmount()
})

test('the card says the threshold, and why when held; off says off', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  expect((await texts(ui)).replace(/\s+/g, ' ')).toContain('Auto-move at 94%: on')
  await ui.unmount()
})

test('autoMovePct 0 turns it off', { options: { ...OPTS, autoMovePct: 0 } }, async ($: any, on: any) => {
  const ui = await ready($, on)
  await fireAt($, 99)
  await tickOnce()
  expect(seen.written).toEqual([])
  expect((await texts(ui)).replace(/\s+/g, ' ')).toContain('Auto-move: off')
  await ui.unmount()
})

test('the manual move now also holds on a background task, and still arms', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  await $.classic.Stop({ background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'watch' }], session_crons: [] })
  await ui.press({ key: 'acct-swap' })
  const t = (await texts(ui)).replace(/\s+/g, ' ')
  expect(t).toContain('1 background task running')
  await ui.press({ key: 'sw-move' })
  expect(seen.written).toEqual([])
  expect(MOVE_KEY).toBe('swap.moved')
  await ui.unmount()
})

test('if /exit was run and this session is still here 20 seconds later, it falls back to the prompt box and a notice', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  await fireAt($, 95)
  await tickOnce()
  expect(commandsRun).toContain('exit')
  expect(seen.filled).toEqual([])
  await mocked.clock!.advance(25_000)
  for (let i = 0; i < 30; i++) await Promise.resolve()
  expect(seen.filled).toEqual(['/exit'])
  expect(seen.notices.join('\n')).toContain('Press Enter on /exit')
  expect(seen.written).toHaveLength(1)
  await ui.unmount()
})

test('U188: held over the line, the prompt box is read about every 5 seconds, not every second', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  agents.list = [{ id: 'agent-9', description: 'builder', type: 'web-builder', status: 'running' }]
  await fireAt($, 96)
  await tickOnce()
  expect(seen.written).toEqual([])
  const before = reads.prompt
  for (let i = 0; i < 20; i++) await tickOnce()
  // 20 seconds: at most one look per 5 seconds (4), and one spare for the edge. Every second would be 20.
  expect(reads.prompt - before).toBeLessThanOrEqual(5)
  expect(reads.prompt - before).toBeGreaterThanOrEqual(3)
  expect(seen.written).toEqual([])
  await ui.unmount()
})

test('U188: a limit, background, turn or agent event is seen at once; a change with no event within 5 seconds', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  // A turn running holds; the turn ending is an event and the move follows on the next tick.
  await fireAt($, 96)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await tickOnce()
  expect(seen.written).toEqual([])
  await turn($, 'done')
  await tickOnce()
  expect(seen.written).toHaveLength(1)
  await ui.unmount()
})

test('U188: a held state that changes with no event (the box is emptied) is seen within 5 seconds', { options: OPTS }, async ($: any, on: any) => {
  const ui = await ready($, on)
  box.text = 'half a sentence'
  await fireAt($, 96)
  await tickOnce()
  expect(seen.written).toEqual([])
  box.text = ''
  await tickHeld()
  await tickOnce()
  expect(seen.written).toHaveLength(1)
  await ui.unmount()
})
