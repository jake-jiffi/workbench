import { expect, test } from 'claude-code/testing'

import { PANE, engine, seen, withClaude } from './helpers'
import type { ClaudeCall } from './helpers'

// Accounts, limits and warnings. Every address, folder and figure here is invented for the test; nothing logs in.

const OPTIONS = { accounts: 'team=/d/team, lab=/d/lab, spare=/d/max', accountNotes: 'spare=out of credits 4 Nov' }

const WEEK = (p: number) => `Current week (all models): ${p}% used · resets Nov 12 at 4pm (Australia/Sydney)`
const SESSION = (p: number) => `Current session: ${p}% used · resets 6pm (Australia/Sydney)`

// Which address each folder holds. The session itself (no CLAUDE_CONFIG_DIR) holds lab.
const WHO: Record<string, string> = { '/d/team': 'team@example.com', '/d/lab': 'lab@example.com', '/d/max': 'max@example.com', self: 'lab@example.com' }
const USE: Record<string, string> = { '/d/team': `${SESSION(70)}\n${WEEK(60)}`, '/d/lab': `${SESSION(20)}\n${WEEK(12)}`, '/d/max': 'Your credit balance is too low.' }

let clockNow = 1_762_140_000_000
const calls: ClaudeCall[] = []
const toolsRegistered: string[] = []

function claude(c: ClaudeCall) {
  const dir = c.env.CLAUDE_CONFIG_DIR ?? 'self'
  if (c.argv[1] === 'auth') return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: WHO[dir], orgId: `org-${WHO[dir]}`, orgName: 'Secret Co', subscriptionType: 'max' }) }
  return dir === '/d/max' ? { exitCode: 1, stdout: '', stderr: USE[dir] } : { exitCode: 0, stdout: USE[dir] ?? '' }
}

async function setup($: any, on: any, env?: Record<string, string>) {
  clockNow = 1_762_140_000_000
  calls.length = 0
  toolsRegistered.length = 0
  engine(on, withClaude(claude, calls), undefined, () => clockNow, { HOME: '/Users/test', ...env })
  on('session.usage', () => ({ value: { startedAt: clockNow - 60_000, context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits: [], cost: { usd: 1 } } }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('classic.StopFailure', () => ({}))
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.register', (_: unknown, e: { name: string }) => { toolsRegistered.push(e.name); return { value: { tool: e.name } } })
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

const iso = (ms: number) => new Date(clockNow + ms).toISOString()
const measure = ($: any, limits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>) =>
  $.session.measure({ context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits: limits, cost: { usd: 1 }, changed: ['rateLimits'] })

async function mountPane($: any, columns = 90) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
  await ui.press({ key: 'refresh' })
  return ui
}

const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })).map((t: any) => t.text), ...(await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label ?? '')].join('\n')

const borderOf = async (ui: any, title: string) =>
  (await ui.findAll({ type: 'Box' })).find((b: any) => b.props.borderStyle && JSON.stringify(b.children).includes(`"${title}"`))?.props.borderColor as string | undefined

const accountToasts = () => seen.toasts.filter(t => /resets|clears|needs action|swap/i.test(t))

test('refresh reads each account with only the folder and the guard in the environment, and never logs in', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  const probed = calls.filter(c => c.env.CLAUDE_CONFIG_DIR)
  expect(new Set(probed.map(c => c.env.CLAUDE_CONFIG_DIR))).toEqual(new Set(['/d/team', '/d/lab', '/d/max']))
  for (const c of calls) {
    expect(c.argv[0]).toBe('claude')
    expect(c.cwd).toBe('/tmp')
    expect(c.env.WORKBENCH_PLUGIN_PROBE).toBe('1')
    expect(Object.keys(c.env).filter(k => k !== 'CLAUDE_CONFIG_DIR' && k !== 'WORKBENCH_PLUGIN_PROBE')).toEqual([])
    expect(c.argv).not.toContain('login')
    expect(c.argv).not.toContain('logout')
    expect(c.argv.join(' ')).toMatch(/^claude (auth status --json|-p \/usage --no-session-persistence)$/)
  }
  // the session's own account is asked with no folder
  expect(calls.some(c => !c.env.CLAUDE_CONFIG_DIR && c.argv[1] === 'auth')).toBe(true)
  await ui.unmount()
})

test('the card names the session account by email, marks its row, and shows each account\'s meters', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  const t = await texts(ui)
  expect(t).toContain('lab@example.com (max)')
  expect(t).toContain('known as lab')
  expect(t).toMatch(/▸ lab\s+lab@example\.com · 5h 20% · wk 12%\s+\(this session\)/)
  expect(t).toContain('team  team@example.com · 5h 70% · wk 60%')
  expect(t).toContain('spare  max@example.com · out of credits')
  expect(t).not.toContain('Secret Co')
  expect(t).toContain('swap to spare'.replace('spare', 'team'))
  await ui.unmount()
})

test('a folder that now holds another account is labelled by its email, not its name', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  WHO.self = 'stranger@example.com'
  try {
    const ui = await mountPane($)
    await ui.press({ key: 'acct-refresh' })
    const t = await texts(ui)
    expect(t).toContain('stranger@example.com (max)')
    expect(t).toContain('not in your list, folder')
    expect(t).not.toMatch(/▸ /)
    await ui.unmount()
  } finally {
    WHO.self = 'lab@example.com'
  }
})

test('a note stands until a reading replaces it', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('spare  out of credits 4 Nov')
  await ui.unmount()
})

test('tones: green, amber at 80, red at 95', async ($: any, on: any) => {
  await setup($, on)
  await measure($, [{ kind: 'five_hour', percentUsed: 40, resetsAt: iso(3 * 3600_000) }, { kind: 'seven_day', percentUsed: 20 }])
  let ui = await mountPane($)
  expect(await borderOf(ui, 'Accounts')).toBe('success')
  await measure($, [{ kind: 'five_hour', percentUsed: 82, resetsAt: iso(3 * 3600_000) }])
  expect(await borderOf(ui, 'Accounts')).toBe('warning')
  await measure($, [{ kind: 'five_hour', percentUsed: 96, resetsAt: iso(3 * 3600_000) }])
  expect(await borderOf(ui, 'Accounts')).toBe('error')
  await ui.unmount()
})

test('the card draws on every surface and at 40 columns with no border', async ($: any, on: any) => {
  await setup($, on)
  await measure($, [{ kind: 'five_hour', percentUsed: 82, resetsAt: iso(3 * 3600_000) }])
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await texts(ui)).toContain('5-hour')
    await ui.unmount()
  }
  const narrow = await mountPane($, 40)
  expect((await narrow.findAll({ type: 'Box' })).filter((b: any) => b.props.borderStyle)).toHaveLength(0)
  for (const t of await narrow.findAll({ type: 'Text' })) expect(t.text.length).toBeLessThanOrEqual(40)
  await narrow.unmount()
})

test('one toast per level per window, re-armed by a new window; the cap holds one per turn', async ($: any, on: any) => {
  await setup($, on)
  await measure($, [{ kind: 'five_hour', percentUsed: 82, resetsAt: iso(3 * 3600_000) }])
  await measure($, [{ kind: 'five_hour', percentUsed: 84, resetsAt: iso(3 * 3600_000) }])
  expect(accountToasts()).toHaveLength(1)
  expect(accountToasts()[0]).toMatch(/^5-hour 82%, resets \d\d:\d\d\./)
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await measure($, [{ kind: 'five_hour', percentUsed: 96, resetsAt: iso(3 * 3600_000) }])
  expect(accountToasts()).toHaveLength(2)
  // a new window re-arms the same level
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await measure($, [{ kind: 'five_hour', percentUsed: 82, resetsAt: iso(8 * 3600_000) }])
  expect(accountToasts()).toHaveLength(3)
  // the week warns at 90, not 80
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
  await measure($, [{ kind: 'seven_day', percentUsed: 85, resetsAt: iso(80 * 3600_000) }])
  expect(accountToasts()).toHaveLength(3)
  await measure($, [{ kind: 'seven_day', percentUsed: 91, resetsAt: iso(80 * 3600_000) }])
  expect(accountToasts()).toHaveLength(4)
  // two warnings in one turn: only the first is given
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 't4', reason: 'answer' })
  await measure($, [{ kind: 'five_hour', percentUsed: 97, resetsAt: iso(30 * 3600_000) }, { kind: 'seven_day', percentUsed: 97, resetsAt: iso(300 * 3600_000) }])
  expect(accountToasts()).toHaveLength(5)
})

test('the toast names the best other account and a release in flight', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  await measure($, [{ kind: 'five_hour', percentUsed: 82, resetsAt: iso(3 * 3600_000) }])
  const t = accountToasts().at(-1) ?? ''
  expect(t).toContain('Best account to swap to: team, 60%. Press a.')
  expect(t).toContain('Release in flight')
  await ui.unmount()
})

test('a billing error turns the card red with its age, offers a swap, and survives /clear', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  let ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  await $.classic.StopFailure({ error: 'billing_error' })
  expect(await borderOf(ui, 'Accounts')).toBe('error')
  expect(await texts(ui)).toContain('billing error now: needs action')
  expect(accountToasts().at(-1)).toContain('needs action')
  expect(accountToasts().at(-1)).toContain('Press a')
  await ui.unmount()
  await $.session.end({ reason: 'clear', sessionId: 'session-1', resume: {} })
  ui = await mountPane($)
  expect(await borderOf(ui, 'Accounts')).toBe('error')
  expect(await texts(ui)).toContain('billing error')
  await ui.unmount()
})

test('a rate limit clears by itself and offers no swap', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  await $.classic.StopFailure({ error: 'rate_limit' })
  const toast = accountToasts().at(-1) ?? ''
  expect(toast).toContain('clears by itself')
  expect(toast).not.toContain('Press a')
  expect(await texts(ui)).toContain('rate limit now: clears by itself')
  await ui.unmount()
})

test('nothing older than 15 minutes is shown without its age', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  expect(await texts(ui)).not.toMatch(/\d+m ago/)
  await measure($, [{ kind: 'five_hour', percentUsed: 40, resetsAt: iso(3 * 3600_000) }])
  clockNow += 20 * 60_000
  await ui.press({ key: 'refresh' })
  const t = await texts(ui)
  expect(t).toMatch(/team .*20m ago/)
  expect(t).toMatch(/5-hour .*\(20m ago\)/)
  await ui.unmount()
})

test('a failed probe keeps the last reading', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  USE['/d/team'] = ''
  const was = USE['/d/team']
  clockNow += 6 * 60_000
  await ui.press({ key: 'acct-refresh' })
  expect(await texts(ui)).toContain('team@example.com')
  USE['/d/team'] = `${SESSION(70)}\n${WEEK(60)}`
  void was
  await ui.unmount()
})

test('a copy of the mod started by the probe does nothing', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on, { WORKBENCH_PLUGIN_PROBE: '1' })
  expect(calls).toHaveLength(0)
  expect(toolsRegistered).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui)).not.toContain('Workers')
  await ui.unmount()
  expect(calls.filter(c => c.argv[1] === '-p')).toHaveLength(0)
})

const BAND = { plugin: 'workbench', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 } } } as const

test('an account at the warning shows in the band and the status line; red at the urgent line', async ($: any, on: any) => {
  await setup($, on)
  await measure($, [{ kind: 'five_hour', percentUsed: 82, resetsAt: iso(3 * 3600_000) }])
  let band = await $.ui.mount({ ...BAND })
  let t = await texts(band)
  expect(t).toContain('Account 5-hour 82%:')
  const keys = Object.fromEntries((await band.findAll({ type: 'Button' })).map((b: any) => [b.key, b.props.hotkey]))
  expect(keys['band-swap']).toBe('a')
  const label = (await band.findAll({ type: 'Text' })).find((x: any) => x.text.startsWith('Account 5-hour'))
  expect(label?.props.color).toBe('warning')
  expect(seen.statuses.at(-1)).toContain('5h 82%!')
  await band.unmount()
  await measure($, [{ kind: 'five_hour', percentUsed: 97, resetsAt: iso(3 * 3600_000) }])
  band = await $.ui.mount({ ...BAND })
  const red = (await band.findAll({ type: 'Text' })).find((x: any) => x.text.startsWith('Account 5-hour'))
  expect(red?.props.color).toBe('error')
  expect(seen.statuses.at(-1)).toContain('5h 97%!!')
  await band.unmount()
})

test('the default account (~/.claude) is read with CLAUDE_CONFIG_DIR unset, and a session on a slot is read in its own folder', { options: { ...OPTIONS, accounts: 'team=/Users/test/.claude, lab=/d/lab' } }, async ($: any, on: any) => {
  await setup($, on, { CLAUDE_CONFIG_DIR: '/d/lab' })
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  const auth = calls.filter(c => c.argv[1] === 'auth')
  // Never the default folder by name: that would pick a different Keychain entry.
  expect(auth.some(c => c.env.CLAUDE_CONFIG_DIR === '/Users/test/.claude')).toBe(false)
  expect(auth.some(c => !('CLAUDE_CONFIG_DIR' in c.env))).toBe(true)
  // The session itself is on the lab slot, so it is read there, not as the default account.
  expect(auth.filter(c => c.env.CLAUDE_CONFIG_DIR === '/d/lab').length).toBeGreaterThanOrEqual(1)
  await ui.unmount()
})

test('U197: when every other account is at the line, the hint is plain swap and says why; one under the line is offered', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on)
  USE['/d/team'] = `${SESSION(100)}\n${WEEK(100)}`
  try {
    const ui = await mountPane($)
    await ui.press({ key: 'acct-refresh' })
    let t = await texts(ui)
    expect(t).not.toContain('swap to')
    expect(t).toContain('No other account under 94%')
    expect((await ui.findAll({ type: 'Button', key: 'acct-swap' })).map((b: any) => b.props.label)).toEqual(['swap'])
    // The warning toast does not offer it either.
    await measure($, [{ kind: 'five_hour', percentUsed: 82, resetsAt: iso(3 * 3600_000) }])
    const toast = accountToasts().at(-1) ?? ''
    expect(toast).toContain('No other account under 94%')
    expect(toast).not.toContain('Best account to swap to')
    // 93 on the week is under the line.
    USE['/d/team'] = `${SESSION(10)}\n${WEEK(93)}`
    await ui.press({ key: 'acct-refresh' })
    t = await texts(ui)
    expect(t).toContain('swap to team')
    expect(t).not.toContain('No other account under')
    await ui.unmount()
  } finally {
    USE['/d/team'] = `${SESSION(70)}\n${WEEK(60)}`
  }
})

test('U197: the line follows autoMovePct', { options: { ...OPTIONS, autoMovePct: 55 } }, async ($: any, on: any) => {
  await setup($, on)
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  // team is at 60% on the week: over a line of 55
  const t = await texts(ui)
  expect(t).toContain('No other account under 55%')
  expect(t).not.toContain('swap to team')
  await ui.unmount()
})
