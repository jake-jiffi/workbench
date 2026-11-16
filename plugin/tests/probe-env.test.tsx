import { expect, test } from 'claude-code/testing'

import { bestAccount, isSameAccount, labelFor, rowFor } from '../hooks/lib/accounts'
import { probeCommand } from '../hooks/lib/probe'
import type { AccountRow } from '../types'
import { ORG, USE, WEEK, SESSION, WHO, calls, mountPane, setup, texts } from './kit'

// The home account (the team login) runs with CLAUDE_CONFIG_DIR unset. $.process.run can only set variables over
// the host's own, never remove one, so a session started under the personal folder used to probe the team row as
// personal. The mock child sees host + init.env, less anything `env -u` strips, which is how the engine behaves.

const TEAM_DIR = '/Users/test/.claude'
const PERSONAL_DIR = '/Users/test/.claude/accounts/personal'
const OPTIONS = { accounts: 'team=~/.claude, personal=~/.claude/accounts/personal' }

function identities() {
  // Same address, two organisations: the real shape of the team and personal logins.
  WHO.self = 'sam@example.com'
  ORG.self = 'org-team'
  WHO[PERSONAL_DIR] = 'sam@example.com'
  ORG[PERSONAL_DIR] = 'org-personal'
  USE.self = `${SESSION(41)}\n${WEEK(33)}`
  USE[PERSONAL_DIR] = `${SESSION(6)}\n${WEEK(6)}`
}

test('under the personal folder the team row reads the team login, not the personal one', { options: OPTIONS }, async ($: any, on: any) => {
  await setup($, on, { quiet: true, env: { CLAUDE_CONFIG_DIR: PERSONAL_DIR }, host: { CLAUDE_CONFIG_DIR: PERSONAL_DIR } })
  identities()
  const ui = await mountPane($)
  await ui.press({ key: 'acct-refresh' })
  const t = await texts(ui)
  // The session itself is on the personal folder (the variable is set, so it is probed with it).
  expect(t).toContain('known as personal')
  // Two rows, one address: the team row shows the team meters (33%), the personal row its own (6%).
  expect(t).toMatch(/team\s+sam@example.com · 5h 41% · wk 33%/)
  expect(t).toMatch(/personal\s+sam@example.com · 5h 6% · wk 6%/)
  // The home probe ran with the variable removed, never pointed at ~/.claude.
  const home = calls.filter(c => c.argv[1] === 'auth' && !c.env.CLAUDE_CONFIG_DIR)
  expect(home.length).toBeGreaterThan(0)
  for (const c of home) expect(c.raw?.slice(0, 3)).toEqual(['/usr/bin/env', '-u', 'CLAUDE_CONFIG_DIR'])
  for (const c of calls) expect(c.env.CLAUDE_CONFIG_DIR).not.toBe(TEAM_DIR)
  await ui.unmount()
})

test('probeCommand: the home folder strips the variable, any other folder sets it, the guard is always set', async () => {
  const argv = ['claude', 'auth', 'status', '--json']
  for (const dir of [undefined, '', TEAM_DIR, `${TEAM_DIR}/`]) {
    expect(probeCommand(argv, dir)).toEqual({ argv: ['/usr/bin/env', '-u', 'CLAUDE_CONFIG_DIR', ...argv], env: { WORKBENCH_PLUGIN_PROBE: '1' } })
  }
  expect(probeCommand(argv, PERSONAL_DIR)).toEqual({ argv, env: { WORKBENCH_PLUGIN_PROBE: '1', CLAUDE_CONFIG_DIR: PERSONAL_DIR } })
})

const rowAt = (label: string, orgId: string, week: number): AccountRow => ({ label, dir: `/d/${label}`, reading: { email: 'sam@example.com', orgId, week: { percent: week }, session: { percent: 5 }, at: 1 } })

test('two rows with one email and different organisations stay distinct', async () => {
  const rows = [rowAt('team', 'org-team', 33), rowAt('personal', 'org-personal', 6)]
  const onTeam = { email: 'sam@example.com', orgId: 'org-team' }
  const onPersonal = { email: 'sam@example.com', orgId: 'org-personal' }
  expect(isSameAccount(rows[0]?.reading, rows[1]?.reading)).toBe(false)
  expect(rowFor(rows, onTeam)?.label).toBe('team')
  expect(rowFor(rows, onPersonal)?.label).toBe('personal')
  expect(labelFor(rows, onPersonal, 'x').label).toBe('personal')
  // The other row is a real target, not "the same account".
  expect(bestAccount(rows, onTeam)?.label).toBe('personal')
  expect(bestAccount(rows, onPersonal)?.label).toBe('team')
})
