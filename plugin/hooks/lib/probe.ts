import type { EngineInterface } from 'claude-code'

import type { AccountReading } from '../../types'
import { parseAuthStatus, parseUsageLines } from './accounts'

// Runs the claude binary and reads what it prints about itself. The binary reads its own folder; this module
// never opens a file in it and passes the binary only two variables: the folder to read (absent for the home
// account, removed with `env -u`), and a guard so the probe's own copy of this mod returns at once instead of probing again.

export const CLAUDE = 'claude'
export const PROBE_ENV = 'WORKBENCH_PLUGIN_PROBE'
const SCRATCH = '/tmp'
const TIMEOUT_MS = 20_000

type Ran = { exitCode: number; stdout: string; stderr: string }

/** The home account's folder, which runs with the variable unset. */
export const isHomeDir = (dir: string | undefined) => !dir || /\/\.claude\/?$/.test(dir)

/**
 * The argv and env a probe runs under. `$.process.run`'s `env` only sets variables over the host's own, so it
 * cannot remove one: a session started under CLAUDE_CONFIG_DIR=<personal folder> hands that value to every child.
 * The home account (~/.claude, the team login) must run with the variable absent, so it goes through
 * `env -u`. Pointing the variable at ~/.claude instead would select a different Keychain entry.
 */
export function probeCommand(argv: string[], dir: string | undefined): { argv: string[]; env: Record<string, string> } {
  const env: Record<string, string> = { [PROBE_ENV]: '1' }
  if (isHomeDir(dir)) return { argv: ['/usr/bin/env', '-u', 'CLAUDE_CONFIG_DIR', ...argv], env }
  env.CLAUDE_CONFIG_DIR = dir as string
  return { argv, env }
}

async function run($: EngineInterface, argv: string[], dir: string | undefined): Promise<Ran | null> {
  try {
    const cmd = probeCommand(argv, dir)
    const r = await $.process.run(cmd.argv, { cwd: SCRATCH, env: cmd.env, timeoutMs: TIMEOUT_MS })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch {
    return null
  }
}

/** Who a folder (or, with no folder, this session) is signed in as. Email, plan and org id only. */
export async function probeIdentity($: EngineInterface, dir?: string) {
  const ran = await run($, [CLAUDE, 'auth', 'status', '--json'], dir)
  if (!ran || ran.exitCode !== 0) return null
  return parseAuthStatus(ran.stdout)
}

/** The two usage meters of a folder's account. Costs no model call. */
export async function probeUsage($: EngineInterface, dir: string) {
  const ran = await run($, [CLAUDE, '-p', '/usage', '--no-session-persistence'], dir)
  if (!ran) return null
  return parseUsageLines(`${ran.stdout}\n${ran.exitCode === 0 ? '' : ran.stderr}`)
}

/**
 * One reading for one folder. A failed probe returns the previous reading unchanged, so its age shows;
 * a probe that read an error keeps only the error kind.
 */
export async function probeAccount($: EngineInterface, dir: string, previous: AccountReading | undefined, now: number): Promise<AccountReading | undefined> {
  const who = await probeIdentity($, dir)
  const usage = await probeUsage($, dir)
  if (!who && !usage) return previous
  const reading: AccountReading = {
    email: who?.email ?? previous?.email,
    plan: who?.plan ?? previous?.plan,
    orgId: who?.orgId ?? previous?.orgId,
    session: usage?.session,
    week: usage?.week,
    error: usage?.error,
    at: now,
  }
  if (usage && !usage.session && !usage.week && !usage.error) reading.error = 'unreadable'
  return reading
}
