import type { AccountReading, AccountRow, Worker } from '../../types'
import { planKeepsOpus } from './models'
import { isEnded } from './tones'

// The account move, as far as a mod may go: prepare, explain, leave a request and fill the prompt. The person
// presses Enter on /exit (an automatic move at the limit asks the engine to run it; see automove.ts); a claude wrapper (CLAUDE_WRAPPER_PID) reads the request and reopens the same
// conversation on the other account. Nothing here signs in or runs a command, and the shell route is only shown.

export const EXIT_COMMAND = '/exit'
export const MODEL_COMMAND = '/model'
export const HOLD_MS = 60_000
export const WATCH_MS = 3 * 60_000
export const WATCH_EVERY_MS = 15_000
export const ACCOUNT_TAG_MS = 5 * 60_000
// The wrapper honours a request this long after the press; the store keeps the move for the reopened session.
export const MOVE_MS = 3 * 60_000
export const MOVE_KEY = 'swap.moved'

/** Where the wrapper with this pid looks when claude exits. One file per terminal, so tabs never mix. */
export const moveRequestPath = (home: string, wrapperPid: string) => `${home}/.claude/swap-requests/${wrapperPid}.json`

export type SwapChecks = {
  running: Worker[]
  isRelease: boolean
  isSameOrg: boolean | null
  // Why the button is held, empty when it is free.
  blockers: string[]
  warnings: string[]
  isBlocked: boolean
}

/**
 * Pre-check, read only. A release or production step in flight holds the move. Running workers hold it too:
 * the move restarts this session, which ends them. A hold lifts when the person presses twice within 60 seconds.
 */
export function swapChecks(i: { workers: Worker[]; isRelease: boolean; selfOrg?: string; target?: AccountReading; background?: { tasks: number; crons: number } }): SwapChecks {
  const running = i.workers.filter(w => !isEnded(w.status))
  const isSameOrg = i.selfOrg && i.target?.orgId ? i.selfOrg === i.target.orgId : null
  const blockers: string[] = []
  const warnings: string[] = []
  if (i.isRelease) blockers.push('A release is in flight: finish or park it first. A PR post or watcher that goes through a connector would break.')
  if (running.length) {
    blockers.push(`${running.length} worker${running.length === 1 ? '' : 's'} running (${running.slice(0, 3).map(w => w.id).join(', ')}${running.length > 3 ? ', …' : ''}). The restart ends them; their worktrees stay.`)
  }
  // Background shells, monitors and scheduled wakeups (a PR watcher is one) end with the session too. Absent: not known.
  const tasks = i.background?.tasks ?? 0
  const crons = i.background?.crons ?? 0
  if (tasks) blockers.push(`${tasks} background task${tasks === 1 ? '' : 's'} running (shells, watchers, monitors). The restart ends them.`)
  if (crons) blockers.push(`${crons} scheduled wake-up${crons === 1 ? '' : 's'} (a loop or cron). The restart drops them.`)
  if (isSameOrg === null) warnings.push('The target organisation is unknown: connectors may change.')
  if (!planKeepsOpus(i.target?.plan)) warnings.push(`The target plan (${i.target?.plan}) may not include Opus or the 1M window: /model opus could fail there.`)
  return { running, isRelease: i.isRelease, isSameOrg, blockers, warnings, isBlocked: blockers.length > 0 }
}

/** What a move keeps and changes. Fixed text; the sheet adds the target's facts. */
export const WHAT_CHANGES = [
  'Kept: the conversation (it reopens with --resume), the shared memory, settings, plugins and this mod\'s lists.',
  'Ended: background workers and watchers in this session. Their worktrees and branches stay.',
  'Re-read: the instruction files and plugins, as on any fresh start.',
  'Changed: the claude.ai connectors belong to the account\'s organisation. They change or vanish, and anything that goes through one fails until it is reconnected.',
  'Changed: plan, limits and model access. A 1M window or Opus may not carry over.',
  'Cold: the prompt cache is per account, so the first turn re-reads the whole context once, uncached. Expect one expensive turn.',
]

/** How to move without the wrapper, shown and never run. */
export const moveRoute = (label: string) => `start claude on the ${label} account`

export const NEXT_STEP_PROMPT = (label: string) => `Account changed to ${label}. Re-check connectors, \`gh pr list\`, and the worker list, then carry on.`

export type PostCheck = { text: string; isProblem: boolean }

/** Which connector probe to run, from the connectorProbe setting `server|tool`. Empty: the check is off. */
export function parseConnectorProbe(text: string): { server: string; tool: string } | null {
  const [server, tool] = text.split('|').map(s => s.trim())
  return server && tool ? { server, tool } : null
}

/** An account failure on a worker inside five minutes of a swap is tagged "account", not read as a code fault. */
export function isAccountFailure(text: string): boolean {
  return /authentication_failed|billing_error|\b(?:http|status|error|code)\D{0,4}401\b|\(401\)|\b401 unauthori[sz]ed|invalid (?:api key|x-api-key)|credit balance|out of (?:extra )?usage/i.test(text)
}

export const isInAccountWindow = (changedAt: number | undefined, now: number) => changedAt !== undefined && changedAt > 0 && now - changedAt < ACCOUNT_TAG_MS

export function targetFacts(row: AccountRow | undefined): string[] {
  const rd = row?.reading
  if (!row) return []
  const bits = [`${row.label}${rd?.email ? ` · ${rd.email}` : ''}${rd?.plan ? ` (${rd.plan})` : ''}`]
  if (rd?.session) bits.push(`5-hour ${rd.session.percent}%${rd.session.resets ? `, resets ${rd.session.resets}` : ''}`)
  if (rd?.week) bits.push(`week ${rd.week.percent}%${rd.week.resets ? `, resets ${rd.week.resets}` : ''}`)
  if (rd?.error === 'billing_error') bits.push('out of credits')
  return bits
}
