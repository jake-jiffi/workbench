import { mock } from 'claude-code/testing'

// The model the next spawned agent resolves to.
export const spawn = { model: 'sonnet' }

// What $.agent.list() answers; tests change it.
export const agents: { list: unknown[] } = { list: [] }

// What the prompt box holds and which slash commands exist; tests change them.
export const promptBox = { text: '' }
export const commandNames = { list: ['exit', 'clear'] as string[] }

// How many times the mod read the prompt box or the agent list through the engine.
export const reads = { prompt: 0, agents: 0 }

export const mocked: { clock?: ReturnType<typeof mock.clock> } = {}

// The workspace the tests run in: a folder holding workbench.json. `workspace.json` is the file's text (null: no
// marker anywhere), `where.cwd` what $.session.cwd() answers and `files` any other file a test wants the mod to read.
export const WS_ROOT = '/work/acme'
export const OWNER = 'Sam'
export const WORKBENCH_JSON = JSON.stringify({
  workbench: 1,
  name: 'acme',
  owner: OWNER,
  apps: [
    { name: 'web', repo: 'acme/web-app', integration: 'staging', production: 'main' },
    { name: 'mobile', repo: 'acme/mobile-app', integration: 'staging', production: 'main', noRunner: ['engine', 'e2e'] },
  ],
})
export const workspace: { json: string | null; unreadable: boolean; root: string } = { json: WORKBENCH_JSON, unreadable: false, root: WS_ROOT }
// `cwd: null`: the engine cannot say where the session is.
export const where: { cwd: string | null } = { cwd: WS_ROOT }
export const files: Record<string, string> = {}

export const PANE = {
  plugin: 'workbench',
  component: 'Pane',
  requestId: 'workbench',
  props: {
    title: 'Workbench',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

export const check = (name: string, conclusion: string, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, status, conclusion })

export const PRS: Record<string, unknown[]> = {
  'acme/web-app': [
    { number: 197, title: 'Point paths at the new layout', baseRefName: 'staging', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: '',
      statusCheckRollup: [check('verify', 'SUCCESS'), check('database', 'SKIPPED')], url: 'https://github.com/x/197' },
    { number: 122, title: 'Node 24 for the build server', baseRefName: 'main', author: { login: 'alex-dev' }, isDraft: true, reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [check('verify', 'FAILURE')], url: 'https://github.com/x/122' },
    { number: 198, title: 'Release 2026-11-05', baseRefName: 'main', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: 'APPROVED',
      statusCheckRollup: [check('verify', 'SUCCESS')], url: 'https://github.com/x/198' },
    { number: 8, title: 'Bump actions/setup-node', baseRefName: 'main', author: { login: 'app/dependabot' }, isDraft: false, reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [check('verify', 'FAILURE')], url: 'https://github.com/x/8' },
    { number: 206, title: 'Advisor sign-in', baseRefName: 'staging', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: '', labels: [{ name: 'hold' }],
      statusCheckRollup: [check('verify', 'SUCCESS')], url: 'https://github.com/x/206' },
  ],
  'acme/mobile-app': [
    { number: 107, title: 'Add CLAUDE.md', baseRefName: 'staging', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: '',
      statusCheckRollup: [check('verify', 'SUCCESS'), check('security', 'SUCCESS'), check('engine', '', 'QUEUED'), check('e2e', '', 'QUEUED')],
      url: 'https://github.com/x/107' },
  ],
}

export const STATE = `# State\n\n## Waiting on Sam\n\n1. **Web release timing**: mid-week.\n2. **The CVE fixes**: #122 and #48.\n\n## Waiting on Alex\n\n1. **Not Sam's**: skip.\n`

// The shape of the real "Waiting on Sam" section on 11 Nov: eleven numbered bold lines, numbered 2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14
// (resolved ones are removed and the rest keep their numbers), each with long detail after the bold title, then
// plain paragraphs. Every name here is made up.
export const GAPPED = [2, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14]
export const GAPPED_STATE = `# State\n\n## Live\n\n1. **Not in the list**: before the section.\n\n## Waiting on Sam\n\n${GAPPED.map(n => `${n}. **Made-up item ${n}**: detail for item ${n} with \`code\` and a (9 Nov) date, which carries on for a good while so that the line is long.`).join('\n')}\n\nA plain paragraph under the list, not an item.\n\n## Waiting on Alex\n\n1. **Not Sam's**: skip.\n`

// Loosely typed on purpose: the test kit's generic types are deeper than tsc will follow.
// What the mod told Sam during a test: toasts and macOS notifications.
export const seen: { toasts: string[]; notices: string[]; filled: string[]; submitted: string[]; statuses: Array<string | undefined>; written: Array<{ path: string; text: string }>; opened: number } = { toasts: [], notices: [], filled: [], submitted: [], statuses: [], written: [], opened: 0 }

// Every command the mod ran through the engine, by argv, in order.
export const ran: string[][] = []

export function engine(on: any, processRun?: (_: unknown, e: { argv: string[] }) => unknown, state: string | ((path?: string) => string) = STATE, now: () => number = () => 1_762_140_000_000, env: Record<string, string> = { HOME: '/Users/test' }, store: Record<string, unknown> = {}, clock?: { now: number }) {
  gh.prs = PRS
  spawn.model = 'sonnet'
  seen.toasts.length = 0
  seen.notices.length = 0
  seen.filled.length = 0
  seen.statuses.length = 0
  on('ui.status', (_: unknown, e: { text?: string }) => { seen.statuses.push(e.text); return { value: undefined } })
  seen.submitted.length = 0
  seen.written.length = 0
  seen.opened = 0
  ran.length = 0
  on('fs.write', (_: unknown, e: { path: string; text: string }) => { seen.written.push({ path: e.path, text: e.text }); return { value: undefined } })
  on('prompt.fill', (_: unknown, e: { text: string }) => { seen.filled.push(e.text); return { isFilled: true } })
  on('prompt.submit', (_: unknown, e: { text: string }) => { seen.submitted.push(e.text); return { text: e.text } })
  promptBox.text = ''
  commandNames.list = ['exit', 'clear']
  reads.prompt = 0
  reads.agents = 0
  on('prompt.read', () => { reads.prompt += 1; return { value: { text: promptBox.text, cursor: promptBox.text.length } } })
  on('command.list', () => ({ value: commandNames.list.map(name => ({ name, description: '', source: 'builtin' })) }))
  on('session.model', () => ({ value: 'claude-opus-4-1' }))
  // The store is answered here, over the object the test passed, so a test can read what the mod wrote.
  on('store.get', (_: unknown, e: { key: string }) => ({ value: e.key in store ? structuredClone(store[e.key]) : undefined }))
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => { store[e.key] = structuredClone(e.value); return { value: undefined } })
  on('store.delete', (_: unknown, e: { key: string }) => { delete store[e.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(store) }))
  mock.env(on, env)
  on('session.id', () => ({ value: 'session-1' }))
  // Timers are refused, so no interval runs in a test; refresh runs on the Refresh press.
  // Timers are refused unless a test asks for the mock clock, which moves only when the test advances it.
  if (clock) {
    mocked.clock = mock.clock(on, clock)
  } else {
    mocked.clock = undefined
    on('clock.now', () => ({ value: now() }))
    on('clock.every', () => ({ deny: 'no timers in tests' }))
    on('clock.after', () => ({ deny: 'no timers in tests' }))
  }
  on('command.register', () => ({ value: { command: 'workbench' } }))
  on('ui.open', () => { seen.opened += 1; return { value: { isPlaced: true } } })
  on('ui.toast', (_: unknown, e: { text: string }) => { seen.toasts.push(e.text); return { value: undefined } })
  on('ui.notify', (_: unknown, e: { text: string }) => { seen.notices.push(e.text); return { value: { isSent: true, channel: 'terminal_bell' } } })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  workspace.json = WORKBENCH_JSON
  workspace.unreadable = false
  workspace.root = WS_ROOT
  where.cwd = WS_ROOT
  for (const k of Object.keys(files)) delete files[k]
  on('session.cwd', () => (where.cwd === null ? { deny: 'no cwd' } : { value: where.cwd }))
  on('fs.stat', (_: unknown, e: { path: string }) =>
    workspace.json !== null && e.path === `${workspace.root}/workbench.json` ? { value: { kind: 'file', size: workspace.json.length, mtimeMs: 0, isLink: false } } : { deny: 'ENOENT' })
  on('fs.read', (_: unknown, e: { path?: string }) => {
    if (e.path === `${workspace.root}/workbench.json` && workspace.json !== null) return workspace.unreadable ? { deny: 'EACCES' } : { value: workspace.json }
    if (e.path !== undefined && e.path in files) return { value: files[e.path] }
    return { value: typeof state === 'function' ? state(e.path) : state }
  })
  on('agent.spawn', () => ({ model: spawn.model, agentId: 'agent-1' }))
  agents.list = [{ id: 'agent-1', description: 'Web PR: workspace layout', type: 'web-builder', status: 'running' }]
  on('agent.list', () => { reads.agents += 1; return { value: agents.list } })
  on('process.run', processRun ?? ((_: unknown, e: { argv: string[] }) => {
    const argv = e.argv
    ran.push(argv)
    if (argv.includes('list')) {
      const repo = argv[argv.indexOf('--repo') + 1] ?? ''
      return { value: { exitCode: 0, stdout: JSON.stringify(PRS[repo] ?? []), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    const ahead = argv.some((a: string) => a.includes('mobile')) ? 30 : 29
    return { value: { exitCode: 0, stdout: JSON.stringify({ ahead, live: 'c07208f8', head: '7fc50413' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }))
}


// A process.run handler that answers gh like the default one and the claude binary from `claude(argv, env)`.
// Which PRs gh lists: tests change this to start or end a release.
export const gh: { prs: Record<string, unknown[]> } = { prs: PRS }

export type ClaudeCall = { argv: string[]; env: Record<string, string>; cwd?: string; raw?: string[] }

// `host` is the environment the mod's own process holds: $.process.run sets variables over it and cannot remove one,
// so a child sees host + init.env, less anything the argv strips with `/usr/bin/env -u NAME`.
export function withClaude(claude: (c: ClaudeCall) => { exitCode: number; stdout: string; stderr?: string }, calls: ClaudeCall[] = [], host: Record<string, string> = {}) {
  return (_: unknown, e: { argv: string[]; init?: { env?: Record<string, string>; cwd?: string } }) => {
    const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    ran.push(e.argv)
    let argv = e.argv
    const effective: Record<string, string> = { ...host, ...(e.init?.env ?? {}) }
    while (argv[0] === '/usr/bin/env' && argv[1] === '-u' && argv[2]) {
      delete effective[argv[2]]
      argv = argv.slice(3)
    }
    if (argv[0] === 'claude') {
      const c = { argv, env: effective, cwd: e.init?.cwd, raw: e.argv }
      calls.push(c)
      const r = claude(c)
      return out(r.stdout, r.exitCode, r.stderr ?? '')
    }
    if (e.argv.includes('list')) {
      const repo = e.argv[e.argv.indexOf('--repo') + 1] ?? ''
      return out(JSON.stringify(gh.prs[repo] ?? []))
    }
    if (e.argv[0] === '/usr/bin/open') return out('')
    return out(JSON.stringify({ ahead: 29, live: 'c07208f8', head: '7fc50413' }))
  }
}
