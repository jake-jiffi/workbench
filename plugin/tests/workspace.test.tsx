import { expect, test } from 'claude-code/testing'

const FACTS = { model: 'opus', promptModel: 'opus', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] }
import { PANE, WORKBENCH_JSON, WS_ROOT, gh, mocked, override, ran, seen, where, workspace } from './helpers'
import { check } from './helpers'
import { k, mountPane, setup, texts, toolDefs, toolsRegistered } from './kit'
import { parseWaiting } from '../hooks/lib/github'
import { PROMPT_SECTION } from '../hooks/lib/tools'
import { parseWorkspace } from '../hooks/lib/workspace'

// The mod is dormant outside a workspace (a folder holding workbench.json, here or above) and wakes inside one.
// Every path, name and repo here is invented.

const CONFIG = '/Users/test/.config/workbench/config.json'
const AUTO = { [CONFIG]: JSON.stringify({ autoInit: true }) }
const BAND = { plugin: 'workbench', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 } } } as const
const gh_calls = () => ran.filter(a => a[0] === 'gh')
const tick = async (ms: number) => {
  await mocked.clock!.advance(ms)
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

// ---------- workbench.json ----------

test('workbench.json: apps, owner and branches are read; a bad app is skipped, never an error', async () => {
  const w = parseWorkspace(WORKBENCH_JSON, '/r')
  expect(w.owner).toBe('Sam')
  expect(w.apps.map(a => [a.name, a.repo, a.integration, a.production])).toEqual([
    ['web', 'acme/web-app', 'staging', 'main'],
    ['mobile', 'acme/mobile-app', 'staging', 'main'],
  ])
  expect(w.apps[1]?.noRunner).toEqual(['engine', 'e2e'])
  // No integration branch: it is the production branch. No production branch: main. No name: the repo's.
  const lone = parseWorkspace(JSON.stringify({ apps: [{ repo: 'acme/api' }, { repo: 'acme/site', production: 'release' }] }), '/r')
  expect(lone.apps.map(a => [a.name, a.integration, a.production])).toEqual([['api', 'main', 'main'], ['site', 'release', 'release']])
  const bad = parseWorkspace(JSON.stringify({ apps: [{ repo: '--upload-pack=x' }, { repo: 'no-slash' }, { repo: 'a/b', production: '../x' }, { repo: 'a/b;rm' }, null, 4, { repo: 'ok/ok', name: 'ok' }, { repo: 'ok/ok2', name: 'ok' }] }), '/r')
  expect(bad.apps.map(a => a.repo)).toEqual(['a/b', 'ok/ok'])
  expect(bad.apps[0]?.production).toBe('main')
})

test('workbench.json: unreadable, empty or not an object is a workspace with no apps and no owner', async () => {
  for (const text of ['', '{not json', 'null', '[]', '"x"', '{"apps":"web"}', '{"owner":{"a":1},"apps":[]}']) {
    const w = parseWorkspace(text, '/r')
    expect(w).toEqual({ root: '/r', owner: '', apps: [] })
  }
  expect(parseWorkspace('{"owner":"  Sam\\n\\u0007 Lee  "}', '/r').owner).toBe('Sam Lee')
  expect(parseWorkspace(JSON.stringify({ owner: 'x'.repeat(500) }), '/r').owner).toHaveLength(40)
})

test('Waiting on <owner> and Waiting on you are both read; someone else\'s section is not', async () => {
  const text = '## Waiting on Alex\n\n1. **Not mine**: x\n\n## Waiting on you\n\n1. **Mine, by role**: y\n\n## Waiting on sam\n\n1. **Mine, by name**: z\n\n## Later\n\n1. **No**: q\n'
  expect(parseWaiting(text, 'Sam')).toEqual(['Mine, by role', 'Mine, by name'])
  expect(parseWaiting(text, '')).toEqual(['Mine, by role'])
  expect(parseWaiting('# State\n\nNothing here.\n', 'Sam')).toEqual([])
})

// ---------- dormant outside a workspace ----------

test('outside a workspace: no pane, no band, no status line, no toast, no polling, no tools', async ($: any, on: any) => {
  await setup($, on, { cwd: '/work/elsewhere' })
  expect(seen.opened).toBe(0)
  expect(seen.statuses).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(seen.notices).toEqual([])
  expect(toolsRegistered).toEqual([])
  expect(gh_calls()).toEqual([])
  expect(ran).toEqual([])
  // Events that would count something are passed through untouched.
  await $.session.measure({ context: { window: 200_000, tokens: 190_000, percent: 95 }, rateLimits: [{ kind: 'five_hour', percentUsed: 99 }], cost: { usd: 1 }, changed: ['rateLimits'] })
  await $.turn.complete({ answer: "I'll finish the rest later. **Not done**\n- the thing", durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(seen.statuses).toEqual([])
  expect(seen.toasts).toEqual([])
  // The pane says so if it is somehow open, and the band is not drawn.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui)).toBe('Not in a Workbench workspace.')
  await ui.unmount()
  // (nothing sits beneath the band's hook, so a hook that passes leaves nothing to draw)
  const band = await $.ui.mount({ ...BAND }).catch(() => null)
  expect(band).toBeNull()
  // The prompt gets nothing from the mod.
  const composed = await $.prompt.compose(FACTS)
  expect(composed.sections.some((s: any) => s.id === PROMPT_SECTION.id)).toBe(false)
  expect(ran).toEqual([])
  const said = await $.command.run({ command: 'workbench' })
  expect(String(said.text)).toContain('Not in a Workbench workspace')
  expect(seen.opened).toBe(0)
})

test('with no folder at all (the engine cannot say, and the start gave none) nothing happens and nothing throws', async ($: any, on: any) => {
  await setup($, on, { cwd: '' })
  expect(seen.opened).toBe(0)
  expect(toolsRegistered).toEqual([])
  where.cwd = null
  const said = await $.command.run({ command: 'workbench' })
  expect(String(said.text)).toContain('Not in a Workbench workspace')
})

test('a folder called workbench.json is not a marker, and a marker one level up is not found from the side', async ($: any, on: any) => {
  await setup($, on, { cwd: '/work/acme-side' })
  expect(seen.opened).toBe(0)
  expect(toolsRegistered).toEqual([])
})

// ---------- active inside one ----------

test('inside a workspace: the pane opens, PRs are read from the apps in workbench.json, tools are registered, the prompt has the section', async ($: any, on: any) => {
  await setup($, on)
  expect(seen.opened).toBe(1)
  expect(toolsRegistered).toHaveLength(5)
  const lists = gh_calls().filter(a => a.includes('list'))
  expect(lists.map(a => a[a.indexOf('--repo') + 1]).sort()).toEqual(['acme/mobile-app', 'acme/web-app'])
  const composed = await $.prompt.compose(FACTS)
  expect(composed.sections.at(-1).id).toBe(PROMPT_SECTION.id)
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('Waiting on Sam')
  await ui.unmount()
  expect(seen.statuses.at(-1)).toMatch(/^workbench · /)
})

test('a session in a folder inside the workspace is in the workspace', async ($: any, on: any) => {
  await setup($, on, { cwd: `${WS_ROOT}/apps/web/src/deep/er` })
  expect(seen.opened).toBe(1)
  expect(toolsRegistered).toHaveLength(5)
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('Waiting on Sam')
  await ui.unmount()
})

test('apps come from workbench.json: each repo is read, and the Production card compares its integration branch with its production branch', async ($: any, on: any) => {
  await setup($, on)
  workspace.json = JSON.stringify({
    owner: 'Sam',
    apps: [
      { name: 'api', repo: 'acme/api', integration: 'develop', production: 'release' },
      { name: 'site', repo: 'acme/site', production: 'main' },
    ],
  })
  gh.prs = {
    'acme/api': [
      { number: 31, title: 'Into develop', baseRefName: 'develop', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: '', statusCheckRollup: [check('verify', 'SUCCESS')], url: 'https://github.com/x/31' },
      { number: 32, title: 'Cut the release', baseRefName: 'release', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [check('verify', 'SUCCESS')], url: 'https://github.com/x/32' },
    ],
    'acme/site': [
      { number: 7, title: 'Straight to main', baseRefName: 'main', author: { login: 'sam-dev' }, isDraft: false, reviewDecision: '', statusCheckRollup: [check('verify', 'SUCCESS')], url: 'https://github.com/x/7' },
    ],
  }
  ran.length = 0
  await $.command.run({ command: 'workbench' })
  for (let i = 0; i < 60; i++) await Promise.resolve()
  const compares = gh_calls().filter(a => a[1] === 'api').map(a => a[2])
  // An app with one branch has nothing to compare.
  expect(compares).toEqual(['repos/acme/api/compare/release...develop'])
  expect(gh_calls().filter(a => a.includes('list')).map(a => a[a.indexOf('--repo') + 1]).sort()).toEqual(['acme/api', 'acme/site'])
  const ui = await mountPane($)
  const t = await texts(ui)
  // Only a PR into the app's production branch needs a review and a release.
  expect(t).toMatch(/#31 → develop\s+green: ready to merge/)
  expect(t).toMatch(/#32 → release\s+approved: merge and release/)
  expect(t).toMatch(/#7 → main\s+needs a review/)
  // The Production card names each app's own branches.
  expect(t).toMatch(/api\s+live c07208f8, develop 7fc50413/)
  expect(t).toMatch(/site\s+one branch \(main\), nothing to release/)
  expect(t).not.toContain('staging')
  await ui.unmount()
})

test('no apps listed: the pane says so, no gh command runs, and nothing is an error', async ($: any, on: any) => {
  await setup($, on)
  workspace.json = JSON.stringify({ owner: 'Sam', apps: [] })
  ran.length = 0
  await $.command.run({ command: 'workbench' })
  for (let i = 0; i < 60; i++) await Promise.resolve()
  expect(gh_calls()).toEqual([])
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toContain('No apps yet: workbench add-app <owner/repo>.')
  expect(t).toContain('None open.')
  expect(t).not.toContain('error')
  await ui.unmount()
})

for (const mode of ['{not json', 'unreadable'] as const) {
  test(`a workbench.json that is ${mode === 'unreadable' ? 'unreadable' : 'malformed'} still makes a workspace, with no owner and no apps`, async ($: any, on: any) => {
    await setup($, on)
    ran.length = 0
    if (mode === 'unreadable') workspace.unreadable = true
    else workspace.json = mode
    await $.command.run({ command: 'workbench' })
    for (let i = 0; i < 60; i++) await Promise.resolve()
    expect(gh_calls()).toEqual([])
    const ui = await mountPane($)
    expect(await texts(ui)).toContain('Waiting on you')
    await ui.unmount()
  })
}

test('the owner\'s name is in the waiting card heading and the rows come from their section', async ($: any, on: any) => {
  await setup($, on)
  workspace.json = JSON.stringify({ owner: 'Priya', apps: [] })
  await $.command.run({ command: 'workbench' })
  for (let i = 0; i < 60; i++) await Promise.resolve()
  const ui = await mountPane($)
  const t = await texts(ui)
  // The default STATE has "Waiting on Sam" and "Waiting on Alex": neither is Priya's.
  expect(t).toContain('Waiting on Priya')
  expect(t).not.toContain('Web release timing')
  await ui.unmount()
})

// ---------- tools ----------

const CASES: Array<[string, { cwd: string; list?: Array<{ name: string }>; files?: Record<string, string>; env?: Record<string, string>; git?: 'inside' | 'cannot-run' }, number]> = [
  ['empty, auto-init on', { cwd: '/work/new', list: [], files: AUTO }, 5],
  ['only .DS_Store', { cwd: '/work/new', list: [{ name: '.DS_Store' }], files: AUTO }, 5],
  ['has a file', { cwd: '/work/new', list: [{ name: 'notes.md' }], files: AUTO }, 0],
  ['auto-init off in the config', { cwd: '/work/new', list: [], files: { [CONFIG]: JSON.stringify({ autoInit: false }) } }, 0],
  ['no config', { cwd: '/work/new', list: [] }, 0],
  ['WORKBENCH_AUTO=0', { cwd: '/work/new', list: [], files: AUTO, env: { WORKBENCH_AUTO: '0' } }, 0],
  ['the home folder', { cwd: '/Users/test', list: [], files: AUTO }, 0],
  ['the root folder', { cwd: '/', list: [], files: AUTO }, 0],
  ['under /tmp', { cwd: '/tmp/x', list: [], files: AUTO }, 0],
  ['under /private/var/folders', { cwd: '/private/var/folders/ab/T/x', list: [], files: AUTO }, 0],
  ['under TMPDIR', { cwd: '/scratch/t/x', list: [], files: AUTO, env: { TMPDIR: '/scratch/t' } }, 0],
  ['under ~/.claude', { cwd: '/Users/test/.claude/x', list: [], files: AUTO }, 0],
  ['under ~/.config', { cwd: '/Users/test/.config/x', list: [], files: AUTO }, 0],
  ['under ~/Library', { cwd: '/Users/test/Library/x', list: [], files: AUTO }, 0],
  ['under the kit home', { cwd: '/opt/wb/x', list: [], files: AUTO, env: { WORKBENCH_HOME: '/opt/wb' } }, 0],
  ['under ~/.workbench', { cwd: '/Users/test/.workbench/x', list: [], files: AUTO }, 0],
  ['a hidden folder below home', { cwd: '/Users/test/.ssh/x', list: [], files: AUTO }, 0],
  ['a hidden segment deeper down', { cwd: '/Users/test/code/.cache/x', list: [], files: AUTO }, 0],
  ['a hidden folder outside home is fine', { cwd: '/work/.new', list: [], files: AUTO }, 5],
  ...['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public', 'Library', 'Applications', 'Sites', 'Dropbox', 'OneDrive', 'Google Drive', 'iCloud Drive', 'snap'].map(
    (f): [string, { cwd: string; list: Array<{ name: string }>; files: Record<string, string> }, number] => [`the user folder ${f} itself`, { cwd: `/Users/test/${f}`, list: [], files: AUTO }, 0]),
  ['a subfolder of Documents stays eligible', { cwd: '/Users/test/Documents/new-project', list: [], files: AUTO }, 5],
  ['a subfolder of Dropbox stays eligible', { cwd: '/Users/test/Dropbox/new-project', list: [], files: AUTO }, 5],
  ['inside a git work tree', { cwd: '/work/new', list: [], files: AUTO, git: 'inside' }, 0],
  ['git cannot run', { cwd: '/work/new', list: [], files: AUTO, git: 'cannot-run' }, 0],
  ['under /var/tmp', { cwd: '/var/tmp/x', list: [], files: AUTO }, 0],
  ['under /private/var/tmp', { cwd: '/private/var/tmp/x', list: [], files: AUTO }, 0],
  ['under /dev/shm', { cwd: '/dev/shm/x', list: [], files: AUTO }, 0],
  ['under /run', { cwd: '/run/x', list: [], files: AUTO }, 0],
  ['/Volumes itself', { cwd: '/Volumes', list: [], files: AUTO }, 0],
  ['/mnt itself', { cwd: '/mnt', list: [], files: AUTO }, 0],
  ['a folder on a volume', { cwd: '/Volumes/Disk/new', list: [], files: AUTO }, 5],
  ['cannot be listed', { cwd: '/work/new', files: AUTO }, 0],
]

for (const [name, c, n] of CASES) {
  test(`tools: ${name}: ${n ? 'registered' : 'not registered'}, and nothing is drawn`, async ($: any, on: any) => {
    await setup($, on, { ...c, noMarker: true })
    expect(toolsRegistered).toHaveLength(n)
    // Whatever the folder, nothing was drawn: not a workspace yet.
    expect(seen.opened).toBe(0)
  })
}

test('tool definitions and the prompt section are static text: no owner, no repo, no count, no date', async ($: any, on: any) => {
  await setup($, on)
  const all = JSON.stringify([toolDefs, PROMPT_SECTION])
  for (const word of ['Sam', 'acme', 'web-app', 'staging', '/work']) expect(all).not.toContain(word)
  expect(all).not.toMatch(/\d{4}|\b\d+ (items|workers|PRs)\b/)
})

test('in an eligible empty folder the tools work before the marker exists, and the mod stays asleep', async ($: any, on: any) => {
  await setup($, on, { cwd: WS_ROOT, list: [], files: AUTO, noMarker: true })
  expect(toolsRegistered).toHaveLength(5)
  const added = await $.tool.call({ tool: 'mcp__workbench__left_undone_add', tool_use_id: 'u1', text: 'Write the first app note', kind: 'promise' })
  expect(String(added.result)).toMatch(/Recorded as U\d+/)
  const listed = await $.tool.call({ tool: 'mcp__workbench__left_undone_list', tool_use_id: 'u2' })
  expect(String(listed.result)).toContain('Write the first app note')
  expect(seen.opened).toBe(0)
  expect(seen.statuses).toEqual([])
  expect(gh_calls()).toEqual([])
})

// ---------- the marker appears, changes and goes mid-session ----------

test('the marker appearing mid-session (auto-init wrote it) wakes the mod on the next tick; the tools stay as registered', async ($: any, on: any) => {
  await setup($, on, { cwd: WS_ROOT, list: [], files: AUTO, noMarker: true, clock: true })
  expect(toolsRegistered).toHaveLength(5)
  await tick(14_000)
  expect(seen.opened).toBe(0)
  expect(gh_calls()).toEqual([])
  expect(seen.statuses).toEqual([])
  workspace.json = WORKBENCH_JSON
  await tick(2_000)
  expect(seen.opened).toBe(1)
  expect(gh_calls().filter(a => a.includes('list'))).toHaveLength(2)
  expect(seen.statuses.length).toBeGreaterThan(0)
  expect(toolsRegistered).toHaveLength(5)
  // Another tick finds the same file: nothing is started twice.
  await tick(15_000)
  expect(seen.opened).toBe(1)
  expect(toolsRegistered).toHaveLength(5)
})

test('a folder that was no workspace and had no tools wakes on a marker too, but gets no tools', async ($: any, on: any) => {
  await setup($, on, { cwd: WS_ROOT, noMarker: true, clock: true, list: [{ name: 'readme.md' }], files: AUTO })
  expect(toolsRegistered).toEqual([])
  workspace.json = WORKBENCH_JSON
  await tick(16_000)
  expect(seen.opened).toBe(1)
  expect(toolsRegistered).toEqual([])
  const composed = await $.prompt.compose(FACTS)
  expect(composed.sections.some((s: any) => s.id === PROMPT_SECTION.id)).toBe(false)
})

test('an app added to workbench.json mid-session is read on the next tick', async ($: any, on: any) => {
  await setup($, on, { clock: true })
  ran.length = 0
  workspace.json = JSON.stringify({ owner: 'Sam', apps: [{ name: 'api', repo: 'acme/api', production: 'main' }] })
  gh.prs = { 'acme/api': [] }
  await tick(16_000)
  expect(gh_calls().filter(a => a.includes('list')).map(a => a[a.indexOf('--repo') + 1])).toContain('acme/api')
})

test('a session that moves out of the workspace goes quiet: status line cleared, pane says so, band gone', async ($: any, on: any) => {
  await setup($, on, { clock: true })
  await tick(2_000)
  expect(seen.statuses.at(-1)).toMatch(/^workbench/)
  where.cwd = '/work/elsewhere'
  await tick(16_000)
  expect(seen.statuses.at(-1)).toBeUndefined()
  const before = ran.length
  await tick(100_000)
  expect(ran.length).toBe(before)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await texts(ui)).toBe('Not in a Workbench workspace.')
  await ui.unmount()
  // And back in again: it wakes up without starting its timers a second time.
  where.cwd = `${WS_ROOT}/apps`
  await tick(16_000)
  const ui2 = await mountPane($)
  expect(await texts(ui2)).toContain('Waiting on Sam')
  await ui2.unmount()
  void k
})

// ---------- the Production card when GitHub cannot be read ----------

const DEMO = JSON.stringify({ owner: 'Sam', apps: [{ name: 'web', repo: 'fixtures/demo-app', integration: 'staging', production: 'main' }] })
const gitCalls = () => ran.filter(a => a[0] === 'git')
const refreshNow = async ($: any) => {
  await $.command.run({ command: 'workbench' })
  for (let i = 0; i < 80; i++) await Promise.resolve()
}

test('GitHub fails, the local clone answers: the count comes from git, one git call for the app', async ($: any, on: any) => {
  await setup($, on)
  workspace.json = DEMO
  override.handler = argv => {
    if (argv[0] === 'gh') return { exitCode: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a Repository' }
    if (argv[0] === 'git') return { exitCode: 0, stdout: '3\n' }
    return undefined
  }
  ran.length = 0
  await refreshNow($)
  expect(gitCalls()).toEqual([['git', '-C', `${WS_ROOT}/apps/web`, 'rev-list', '--count', 'origin/main..origin/staging']])
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toMatch(/web\s+staging vs main, local clone\s+3 commits to release/)
  expect(t).not.toContain('No apps yet')
  expect(t).not.toContain("can't be read")
  await ui.unmount()
})

test('GitHub and the local clone both fail: the app has its own row saying so, never "No apps yet"', async ($: any, on: any) => {
  await setup($, on)
  workspace.json = DEMO
  override.handler = argv => {
    if (argv[0] === 'gh') return { exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
    if (argv[0] === 'git') return { exitCode: 128, stdout: '', stderr: 'fatal: cannot change to \'/work/acme/apps/web\': No such file or directory' }
    return undefined
  }
  await refreshNow($)
  const ui = await mountPane($)
  const t = await texts(ui)
  expect(t).toMatch(/web\s+can't be read: GitHub: HTTP 404: Not Found; local: no clone at apps\/web/)
  expect(t).not.toContain('No apps yet')
  await ui.unmount()
})

test('a git answer that is not a count is a failure, not a zero', async ($: any, on: any) => {
  await setup($, on)
  workspace.json = DEMO
  override.handler = argv => (argv[0] === 'gh' ? { exitCode: 1, stdout: '', stderr: 'offline' } : argv[0] === 'git' ? { exitCode: 0, stdout: 'oops' } : undefined)
  await refreshNow($)
  const ui = await mountPane($)
  expect(await texts(ui)).toMatch(/web\s+can't be read/)
  await ui.unmount()
})

test('an app named with a path in workbench.json is never read from outside apps/', async ($: any, on: any) => {
  await setup($, on)
  workspace.json = JSON.stringify({ apps: [{ name: '../../etc', repo: 'a/b', integration: 'dev', production: 'main' }] })
  override.handler = argv => (argv[0] === 'gh' ? { exitCode: 1, stdout: '', stderr: 'offline' } : undefined)
  ran.length = 0
  await refreshNow($)
  expect(gitCalls()).toEqual([])
  const ui = await mountPane($)
  expect(await texts(ui)).toMatch(/can't be read/)
  await ui.unmount()
})
