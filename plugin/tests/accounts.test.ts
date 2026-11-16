import { expect, test } from 'claude-code/testing'

import { accountTone, bestAccount, swapCandidate, emailKey, isSameAccount, errorClears, errorNeedsAction, labelFor, meterLevel, parseAccountList, parseAuthStatus, parseNotes, parseUsageLines, rowFor, throttleOk, ageLabel } from '../hooks/lib/accounts'
import type { AccountReading, AccountRow } from '../types'

// Output shapes are written for these tests from the real format: lines "Current week (all models): 12% used · resets
// Nov 12 at 4pm (Australia/Sydney)". No real address or account is used.

const WEEK = 'Current week (all models): 12% used · resets Nov 12 at 4pm (Australia/Sydney)'
const SESSION = 'Current session: 82% used · resets 6pm (Australia/Sydney)'

test('parseUsageLines reads the session and week lines and ignores the rest', async () => {
  const text = `You are currently using your subscription\n\n${SESSION}\n${WEEK}\nCurrent week (Fable): 0% used · resets Nov 12 at 4pm\n\nLast 24h · 3305 requests\n  100%  Stop sessions`
  expect(parseUsageLines(text)).toEqual({
    session: { percent: 82, resets: '6pm (Australia/Sydney)' },
    week: { percent: 12, resets: 'Nov 12 at 4pm (Australia/Sydney)' },
  })
})

test('parseUsageLines: week only, no week, error text, empty', async () => {
  expect(parseUsageLines(WEEK)).toEqual({ week: { percent: 12, resets: 'Nov 12 at 4pm (Australia/Sydney)' } })
  expect(parseUsageLines('Current session: 3% used')).toEqual({ session: { percent: 3, resets: undefined } })
  expect(parseUsageLines('Your plan limit was reached. Add credit to continue.')).toEqual({ error: 'billing_error' })
  expect(parseUsageLines('Not logged in. Run /login.')).toEqual({ error: 'authentication_failed' })
  expect(parseUsageLines('Error 429 too many requests')).toEqual({ error: 'rate_limit' })
  expect(parseUsageLines('something new and odd')).toEqual({ error: 'unreadable' })
  expect(parseUsageLines('')).toEqual({ error: 'unreadable' })
  expect(parseUsageLines('Current week (all models): 250% used')).toEqual({ week: { percent: 100, resets: undefined } })
})

test('parseAuthStatus keeps the email, plan and org id and nothing else', async () => {
  const text = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'Someone@Example.com', orgId: 'org-1', orgName: 'Some Co', subscriptionType: 'max', configDirectory: '/x', projectsDirectory: '/y' })
  const got = parseAuthStatus(text)
  expect(got).toEqual({ loggedIn: true, email: 'someone@example.com', plan: 'max', orgId: 'org-1' })
  expect(JSON.stringify(got)).not.toContain('Some Co')
  expect(parseAuthStatus('not json')).toBeNull()
  expect(parseAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({ loggedIn: false, email: undefined, plan: undefined, orgId: undefined })
  expect(parseAuthStatus(JSON.stringify({ email: 'not-an-address' }))?.email).toBeUndefined()
})

test('the account list and notes parse; bad entries are skipped', async () => {
  const rows = parseAccountList('team=~/.claude, spare=~/.claude-spare;lab = /Users/x/.claude-lab,bad label=/x,=/y,nodir=', '/Users/x')
  expect(rows).toEqual([
    { label: 'team', dir: '/Users/x/.claude' },
    { label: 'spare', dir: '/Users/x/.claude-spare' },
    { label: 'lab', dir: '/Users/x/.claude-lab' },
  ])
  expect(parseNotes('spare=out of credits 4 Nov; x=')).toEqual({ 'spare': 'out of credits 4 Nov' })
})

const reading = (over: Partial<AccountReading> = {}): AccountReading => ({ email: 'a@example.com', week: { percent: 30 }, session: { percent: 10 }, at: 1, ...over })
const row = (label: string, r?: Partial<AccountReading> | null, note?: string): AccountRow => ({ label, dir: `/d/${label}`, reading: r === null ? undefined : reading({ email: `${label}@example.com`, ...r }), note })

test('bestAccount skips the session account, unreadable rows and out-of-credit rows', async () => {
  const rows = [row('team', { week: { percent: 70 } }), row('lab', { week: { percent: 12 } }), row('spare', null, 'out of credits 4 Nov'), row('old', null), row('broke', { error: 'billing_error', week: undefined })]
  expect(bestAccount(rows, { email: 'lab@example.com' })?.label).toBe('team')
  expect(bestAccount(rows, { email: 'team@example.com' })?.label).toBe('lab')
  // a note says out of credits until a reading with a week replaces it
  expect(bestAccount([row('spare', { week: { percent: 5 } }, 'out of credits 4 Nov'), row('team', { week: { percent: 50 } })], undefined)?.label).toBe('spare')
  expect(bestAccount([row('x', { error: 'unreadable', week: undefined })], undefined)).toBeNull()
  expect(bestAccount([], undefined)).toBeNull()
})

test('labelFor prefers the email to the folder', async () => {
  const rows = [row('team'), row('lab')]
  expect(labelFor(rows, { email: 'lab@example.com' }, '.claude')).toEqual({ label: 'lab', isKnown: true })
  expect(labelFor(rows, { email: 'stranger@example.com' }, '.claude')).toEqual({ label: 'not in your list', isKnown: false })
  expect(labelFor(rows, undefined, '.claude-lab').label).toBe('account unknown (.claude-lab)')
  expect(rowFor(rows, { email: 'team@example.com' })?.label).toBe('team')
})

test('two accounts on one email are told apart by organisation', async () => {
  const rows = [row('team', { email: 's@example.com', orgId: 'org-team', week: { percent: 88 } }), row('personal', { email: 's@example.com', orgId: 'org-me', week: { percent: 94 } }), row('lab', { week: { percent: 100 } })]
  const team = { email: 's@example.com', orgId: 'org-team' }
  const me = { email: 's@example.com', orgId: 'org-me' }
  expect(rowFor(rows, team)?.label).toBe('team')
  expect(rowFor(rows, me)?.label).toBe('personal')
  expect(bestAccount(rows, team)?.label).toBe('personal')
  expect(bestAccount(rows, me)?.label).toBe('team')
  // an organisation not yet known on either side falls back to the email
  expect(rowFor(rows, { email: 's@example.com' })?.label).toBe('team')
  expect(isSameAccount(team, me)).toBe(false)
  expect(isSameAccount(team, { email: 's@example.com' })).toBe(true)
  expect(isSameAccount(undefined, undefined)).toBe(false)
  expect(isSameAccount({ email: '' }, { email: '' })).toBe(false)
})

test('tones: green, amber at the warning, red at the urgent line, short wait softens red, grey with nothing', async () => {
  const o = { warn: 80, urgent: 95, now: Date.parse('2026-11-05T10:00:00Z') }
  const lim = (percent: number, resetsAt?: string) => [{ kind: 'five_hour', percent, resetsAt }]
  expect(accountTone(lim(40), o)).toBe('ok')
  expect(accountTone(lim(80), o)).toBe('warn')
  expect(accountTone(lim(95), o)).toBe('act')
  expect(accountTone(lim(97, '2026-11-05T10:20:00Z'), o)).toBe('warn')
  expect(accountTone(lim(97, '2026-11-05T13:00:00Z'), o)).toBe('act')
  expect(accountTone([], o)).toBe('quiet')
  expect(accountTone(lim(10), { ...o, recentError: true })).toBe('act')
  expect(meterLevel(undefined, 80, 95)).toBe(0)
})

test('errors: which clear and which need a person', async () => {
  expect(errorClears('rate_limit')).toBe(true)
  expect(errorClears('overloaded')).toBe(true)
  expect(errorClears('billing_error')).toBe(false)
  expect(errorNeedsAction('billing_error')).toBe(true)
  expect(errorNeedsAction('authentication_failed')).toBe(true)
  expect(errorNeedsAction('rate_limit')).toBe(false)
})

test('emailKey is stable, case-blind and does not contain the address', async () => {
  expect(emailKey('A@Example.com')).toBe(emailKey('a@example.com'))
  expect(emailKey('a@example.com')).not.toBe(emailKey('b@example.com'))
  expect(emailKey('a@example.com')).toMatch(/^[0-9a-f]{8}$/)
})

test('throttle holds at the interval and force overrides it', async () => {
  expect(throttleOk(0, 5, 5)).toBe(true)
  expect(throttleOk(1_000, 1_000 + 4 * 60_000, 5)).toBe(false)
  expect(throttleOk(1_000, 1_000 + 5 * 60_000, 5)).toBe(true)
  expect(throttleOk(1_000, 1_001, 5, true)).toBe(true)
  expect(ageLabel(0, 20 * 60_000)).toBe('20m ago')
})

test('swapCandidate: an account at or over the line is no candidate, and the reason is said', async () => {
  const me = { email: 'me@example.com' }
  const rows = [row('me', { week: { percent: 40 } }), row('team', { week: { percent: 100 }, session: { percent: 100 } }), row('lab', { week: { percent: 94 }, session: { percent: 10 } })]
  // every other account is full on one meter or the other
  expect(swapCandidate(rows, me, 94)).toEqual({ best: null, line: 94 })
  // 93 is still a candidate; the week and the session are each checked
  expect(swapCandidate([...rows.slice(0, 2), row('lab', { week: { percent: 93 }, session: { percent: 10 } })], me, 94).best?.label).toBe('lab')
  expect(swapCandidate([...rows.slice(0, 2), row('lab', { week: { percent: 10 }, session: { percent: 94 } })], me, 94).best).toBeNull()
  // a lower weekly percent on a full session loses to the account that is under the line on both
  const mixed = [row('me', {}), row('a', { week: { percent: 5 }, session: { percent: 99 } }), row('b', { week: { percent: 60 }, session: { percent: 20 } })]
  expect(swapCandidate(mixed, { email: 'me@example.com' }, 94).best?.label).toBe('b')
  // the line follows autoMovePct; off (0) still never offers an account at 100
  expect(swapCandidate(rows, me, 50).best).toBeNull()
  expect(swapCandidate([row('me', {}), row('x', { week: { percent: 99 }, session: { percent: 10 } })], me, 0)).toEqual({ best: expect.objectContaining({ label: 'x' }), line: 100 })
  expect(swapCandidate([row('me', {}), row('x', { week: { percent: 100 }, session: { percent: 10 } })], me, 0).best).toBeNull()
  // nothing readable is not a full account: no best, same as before
  expect(swapCandidate([], me, 94)).toEqual({ best: null, line: 94 })
})
