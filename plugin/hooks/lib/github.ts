import type { EngineInterface } from 'claude-code'

import type { Checks, Pr, Release } from '../../types'
import { ownerName, rootDir, ws } from './workspace'
import type { App } from './workspace'

// Found on the PATH of the session, like every other command the mod runs.
export const GH = 'gh'

const PASS = ['SUCCESS', 'SKIPPED', 'NEUTRAL']
const FAIL = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

export function countChecks(rollup: Array<Record<string, string>> | null, noRunner: string[]): Checks {
  const checks = { pass: 0, fail: 0, pending: 0 }
  for (const check of rollup ?? []) {
    if (noRunner.includes(check.name ?? check.context ?? '')) continue
    const verdict = (check.conclusion || check.state || check.status || '').toUpperCase()
    if (PASS.includes(verdict)) checks.pass += 1
    else if (FAIL.includes(verdict)) checks.fail += 1
    else checks.pending += 1
  }
  return checks
}

// Dependency bots (Dependabot, Renovate) open routine bumps: shown as one quiet line, never as red.
export const isBotAuthor = (login: string) => login.startsWith('app/') || login.endsWith('[bot]')

export const ci = (c: Checks) => (c.fail > 0 ? 'red' : c.pending > 0 ? 'running' : c.pass > 0 ? 'green' : 'none')

// What has to happen next, most urgent first. Lower sorts first.
export function nextStep(pr: Pr): { rank: number; label: string } {
  const state = ci(pr.checks)
  if (pr.isHeld) return { rank: 5, label: 'on hold' }
  if (pr.toProduction && pr.review === 'APPROVED') return { rank: 0, label: 'approved: merge and release' }
  if (state === 'red') return { rank: 1, label: 'CI red' }
  if (pr.review === 'CHANGES_REQUESTED') return { rank: 1, label: 'changes requested' }
  if (pr.isDraft) return { rank: 5, label: 'draft' }
  if (state === 'running') return { rank: 3, label: 'CI running' }
  if (pr.toProduction) return { rank: 2, label: 'needs a review' }
  return { rank: 4, label: state === 'green' ? 'green: ready to merge' : 'no checks' }
}

// The numbered bold lines under "## Waiting on <owner>" (or "## Waiting on you") in notes/STATE.md.
export function parseWaiting(markdown: string, owner: string = ownerName()): string[] {
  const names = ['you', owner].filter(Boolean).map(n => n.toLowerCase())
  const lines = markdown.split('\n')
  const out: string[] = []
  let isMine = false
  let section: string[] = []
  const flush = () => {
    if (isMine) for (const m of section.join('\n').matchAll(/^\d+\.\s+\*\*(.+?)\*\*/gm)) if (m[1]) out.push(m[1])
    section = []
  }
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      flush()
      const m = /^##\s+Waiting on\s+(.+?)\s*$/i.exec(line)
      isMine = Boolean(m) && names.includes((m?.[1] ?? '').toLowerCase())
    } else if (isMine) section.push(line)
  }
  flush()
  return out
}

async function run($: EngineInterface, argv: string[]): Promise<string> {
  const ran = await $.process.run(argv, { cwd: rootDir() })
  if (ran.exitCode !== 0) throw new Error(((ran.stderr || ran.stdout).trim().split('\n')[0] ?? '').slice(0, 160))
  return ran.stdout
}

const oneLine = (e: unknown, max = 60) => (e instanceof Error ? e.message : String(e)).split('\n')[0]?.slice(0, max) ?? ''

// An app's folder under the workspace: a plain name only, so the name can never climb out of apps/.
const SAFE_NAME = /^[\w][\w.-]*$/

/**
 * How far the integration branch is ahead of production, from the main checkout at <root>/apps/<name>. One git
 * call. It reads the remote-tracking branches as they stand, so it works for any git host and with no network.
 */
async function readLocal($: EngineInterface, app: App): Promise<{ ahead: number }> {
  if (!SAFE_NAME.test(app.name)) throw new Error('no clone at apps/')
  const dir = `${rootDir()}/apps/${app.name}`
  const ran = await $.process.run(['git', '-C', dir, 'rev-list', '--count', `origin/${app.production}..origin/${app.integration}`], { cwd: rootDir() })
  const count = Number.parseInt(ran.stdout.trim(), 10)
  if (ran.exitCode !== 0 || !Number.isFinite(count)) {
    const why = (ran.stderr || ran.stdout).trim()
    throw new Error(/not a git repository|no such file|cannot change to/i.test(why) ? `no clone at apps/${app.name}` : oneLine(why.replace(/^fatal: /, ''), 40) || 'git failed')
  }
  return { ahead: count }
}

/** One app's release row. Never throws: a row says what it could read, or why it could not. */
async function readRelease($: EngineInterface, app: App): Promise<Release> {
  const base = { app: app.name, integration: app.integration, production: app.production }
  // One branch: nothing to compare and nothing to release.
  if (app.integration === app.production) return { ...base, ahead: 0, live: '', head: '', isSingle: true }
  try {
    const compare = await run($, [GH, 'api', `repos/${app.repo}/compare/${app.production}...${app.integration}`, '--jq',
      '{ahead: .ahead_by, live: .base_commit.sha[0:8], head: ((.commits[-1].sha // .base_commit.sha)[0:8])}'])
    return { ...base, ...JSON.parse(compare) }
  } catch (github) {
    try {
      return { ...base, ahead: (await readLocal($, app)).ahead, live: '', head: '', isLocal: true }
    } catch (local) {
      return { ...base, ahead: 0, live: '', head: '', error: `GitHub: ${oneLine(github, 30)}; local: ${oneLine(local, 30)}` }
    }
  }
}

/**
 * One app: its open PRs and its release row. The two reads are independent, and neither throws: a PR list that
 * fails comes back as `prError` with `prs` null (the caller keeps the app's last PRs), and the release row falls
 * back to the local clone when GitHub cannot be read.
 */
export async function readRepo($: EngineInterface, app: App): Promise<{ app: string; prs: Pr[] | null; prError?: string; release: Release }> {
  const fields = 'number,title,baseRefName,author,isDraft,reviewDecision,statusCheckRollup,url,labels'
  const [list, release] = await Promise.all([
    run($, [GH, 'pr', 'list', '--repo', app.repo, '--state', 'open', '--limit', '50', '--json', fields]).then(
      text => ({ text }),
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    ),
    readRelease($, app),
  ])
  if ('error' in list) return { app: app.name, prs: null, prError: list.error, release }
  const prs = (JSON.parse(list.text) as Array<Record<string, any>>).map(p => ({
    app: app.name,
    number: p.number,
    title: p.title,
    base: p.baseRefName,
    toProduction: p.baseRefName === app.production,
    author: p.author?.login ?? '',
    isDraft: Boolean(p.isDraft),
    isHeld: (p.labels ?? []).some((l: { name?: string }) => l.name === 'hold'),
    isBot: isBotAuthor(p.author?.login ?? ''),
    review: p.reviewDecision ?? '',
    checks: countChecks(p.statusCheckRollup, app.noRunner),
    url: p.url,
  }))
  return { app: app.name, prs, release }
}

export async function readWaiting($: EngineInterface): Promise<string[]> {
  try {
    return parseWaiting(String(await $.fs.read(`${rootDir()}/notes/STATE.md`)))
  } catch {
    return []
  }
}

/** The apps of the workspace in force, none outside one. */
export const currentApps = (): App[] => ws.current?.apps ?? []
