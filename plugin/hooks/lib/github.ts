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

export async function readRepo($: EngineInterface, app: App): Promise<{ prs: Pr[]; release: Release }> {
  const fields = 'number,title,baseRefName,author,isDraft,reviewDecision,statusCheckRollup,url,labels'
  const [list, compare] = await Promise.all([
    run($, [GH, 'pr', 'list', '--repo', app.repo, '--state', 'open', '--limit', '50', '--json', fields]),
    run($, [GH, 'api', `repos/${app.repo}/compare/${app.production}...${app.integration}`, '--jq',
      '{ahead: .ahead_by, live: .base_commit.sha[0:8], head: ((.commits[-1].sha // .base_commit.sha)[0:8])}']),
  ])
  const prs = (JSON.parse(list) as Array<Record<string, any>>).map(p => ({
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
  return { prs, release: { app: app.name, integration: app.integration, production: app.production, ...JSON.parse(compare) } }
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
