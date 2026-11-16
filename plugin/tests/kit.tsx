import { PANE, files, override, gh, engine, where, withClaude, workspace } from './helpers'
import type { ClaudeCall } from './helpers'

// A shared set-up for the account, swap and handover tests. Every address, folder and figure is invented.

export const WEEK = (p: number) => `Current week (all models): ${p}% used · resets Nov 12 at 4pm (Australia/Sydney)`
export const SESSION = (p: number) => `Current session: ${p}% used · resets 6pm (Australia/Sydney)`

export const WHO: Record<string, string> = { '/d/team': 'team@example.com', '/d/lab': 'lab@example.com', '/d/max': 'max@example.com', self: 'lab@example.com' }
export const ORG: Record<string, string> = { '/d/team': 'org-a', '/d/lab': 'org-b', '/d/max': 'org-c', self: 'org-b' }
export const USE: Record<string, string> = { '/d/team': `${SESSION(70)}\n${WEEK(60)}`, '/d/lab': `${SESSION(20)}\n${WEEK(12)}`, '/d/max': 'Your credit balance is too low.' }

export const OPTIONS = { accounts: 'team=/d/team, lab=/d/lab, spare=/d/max', accountNotes: 'spare=out of credits 4 Nov' }

export const k = { now: 1_762_140_000_000 }
export const calls: ClaudeCall[] = []
export const toolsRegistered: string[] = []
export const toolDefs: Array<{ name: string; description?: string; inputSchema?: unknown }> = []
export const commandsRun: string[] = []
export const compactions: Array<string | undefined> = []
export const mcpCalls: Array<{ server: string; tool: string }> = []
export const mcp = { fails: false }

export function resetKit() {
  WHO.self = 'lab@example.com'
  ORG.self = 'org-b'
  k.now = 1_762_140_000_000
  calls.length = 0
  toolsRegistered.length = 0
  toolDefs.length = 0
  commandsRun.length = 0
  compactions.length = 0
  mcpCalls.length = 0
  mcp.fails = false
}

function claude(c: ClaudeCall) {
  const dir = c.env.CLAUDE_CONFIG_DIR ?? 'self'
  if (c.argv[1] === 'auth') return { exitCode: 0, stdout: JSON.stringify({ loggedIn: true, email: WHO[dir], orgId: ORG[dir], subscriptionType: 'max' }) }
  return dir === '/d/max' ? { exitCode: 1, stdout: '', stderr: USE[dir] } : { exitCode: 0, stdout: USE[dir] ?? '' }
}

export async function setup($: any, on: any, opts: { quiet?: boolean; env?: Record<string, string>; store?: Record<string, unknown>; clock?: boolean; host?: Record<string, string>; cwd?: string; list?: Array<{ name: string }>; noMarker?: boolean; git?: 'inside' | 'cannot-run'; root?: string; files?: Record<string, string> } = {}) {
  resetKit()
  engine(on, withClaude(claude, calls, opts.host), undefined, () => k.now, { HOME: '/Users/test', ...opts.env }, opts.store, opts.clock ? { now: k.now } : undefined)
  if (opts.root) workspace.root = opts.root
  where.cwd = opts.cwd ?? opts.root ?? '/work/acme'
  if (opts.noMarker) workspace.json = null
  if (opts.git) override.handler = argv => (argv[0] !== 'git' ? undefined : opts.git === 'inside' ? { exitCode: 0, stdout: 'true\n' } : { exitCode: 127, stdout: '', stderr: 'git: not found' })
  Object.assign(files, opts.files ?? {})
  // quiet: no PR into main, so no release is in flight
  if (opts.quiet) gh.prs = { 'acme/web-app': [], 'acme/mobile-app': [] }
  on('session.usage', () => ({ value: { startedAt: k.now - 60_000, context: { window: 200_000, tokens: 20_000, percent: 10 }, rateLimits: [], cost: { usd: 1 } } }))
  on('turn.complete', (_: unknown, e: { answer: string }) => ({ text: e.answer }))
  on('turn.start', (_: unknown, e: { turnId: string }) => ({ turnId: e.turnId }))
  on('session.end', (_: unknown, e: { sessionId: string }) => ({ sessionId: e.sessionId }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('session.compact', (_: unknown, e: { instructions?: string }) => { compactions.push(e.instructions); return { skip: 'test' } })
  on('classic.StopFailure', () => ({}))
  on('classic.Stop', () => ({}))
  on('classic.SubagentStop', () => ({}))
  on('classic.PostModelSwitch', () => ({}))
  on('prompt.compose', () => ({ sections: [] }))
  on('tool.register', (_: unknown, e: { name: string; description?: string; inputSchema?: unknown }) => { toolsRegistered.push(e.name); toolDefs.push(e); return { value: { tool: e.name } } })
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  on('command.run', (_: unknown, e: { command: string }) => { commandsRun.push(e.command); return { text: '' } })
  on('mcp.call', (_: unknown, e: { server: string; tool: string }) => {
    mcpCalls.push({ server: e.server, tool: e.tool })
    return mcp.fails ? { deny: 'server gone' } : { value: { content: [{ type: 'text', text: 'ok' }], isError: false } }
  })
  // list: what an empty-folder check finds in the session's folder (none: the folder cannot be listed).
  if (opts.list) on('fs.list', () => ({ value: opts.list!.map(x => ({ ...x, kind: 'file', size: 0, mtimeMs: 0, isLink: false })) }))
  await $.session.start({ cwd: opts.cwd ?? opts.root ?? '/work/acme', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

export const iso = (ms: number) => new Date(k.now + ms).toISOString()

export const measure = ($: any, limits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>, percent = 10) =>
  $.session.measure({ context: { window: 200_000, tokens: percent * 2000, percent }, rateLimits: limits, cost: { usd: 1 }, changed: ['rateLimits'] })

export async function mountPane($: any, columns = 90) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
  await ui.press({ key: 'refresh' })
  return ui
}

export const texts = async (ui: any) =>
  [...(await ui.findAll({ type: 'Text' })).map((t: any) => t.text), ...(await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label ?? '')].join('\n')

export const hasKey = async (ui: any, key: string) => (await ui.findAll({ type: 'Button', key })).length > 0

export const turn = ($: any, answer: string, agentId?: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: `t-${Math.random()}`, reason: 'answer', agentId })

export const SPAWN = { prompt: 'Work in ~/work/acme/worktrees/web/feat-x', description: 'Web PR: mic repair', subagentType: 'web-builder' }
