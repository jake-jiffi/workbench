import type { EngineInterface } from 'claude-code'

// Which workspace this session is in. A workspace is a folder holding workbench.json; the session's folder and
// every folder above it are tried, nearest first. Outside one the mod is dormant: no pane, no band, no status
// line, no toast, no polling. The marker is looked for again on the refresh tick, so a folder that becomes a
// workspace mid-session (the auto-init hook writes the marker) wakes the mod without a restart.

export const MARKER = 'workbench.json'

export type App = {
  name: string
  repo: string
  // The branch builders branch from and open PRs into.
  integration: string
  // The branch releases go into.
  production: string
  // CI jobs with no runner, which would sit pending forever and are left out of the counts.
  noRunner: string[]
}

export type Workspace = { root: string; owner: string; apps: App[] }

export const ws: { current: Workspace | null } = { current: null }

/** The workspace folder, '' outside one. */
export const rootDir = () => ws.current?.root ?? ''

/** The owner's name for text a person reads. Generic when the file gives none. */
export const ownerName = () => ws.current?.owner || 'you'

const REPO = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9_.][\w.-]*$/
const BRANCH = /^[A-Za-z0-9_][\w./-]*$/
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')
const branch = (s: unknown) => (typeof s === 'string' && BRANCH.test(s.trim()) && !s.includes('..') && !s.trim().endsWith('/') ? s.trim() : '')

/**
 * workbench.json into a workspace. The file is a person's: anything unreadable or malformed gives an empty owner and
 * no apps, never an error, because the marker alone makes the folder a workspace. An app with a bad repo is skipped.
 */
export function parseWorkspace(text: string, root: string): Workspace {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    raw = null
  }
  const doc = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const apps: App[] = []
  if (Array.isArray(doc.apps)) {
    for (const a of doc.apps) {
      if (!a || typeof a !== 'object') continue
      const o = a as Record<string, unknown>
      const repo = typeof o.repo === 'string' ? o.repo.trim() : ''
      if (!REPO.test(repo)) continue
      const production = branch(o.production) || 'main'
      const integration = branch(o.integration) || production
      const name = clean(o.name, 40) || (repo.split('/')[1] ?? repo)
      if (apps.some(x => x.name === name)) continue
      const noRunner = Array.isArray(o.noRunner) ? o.noRunner.filter((x): x is string => typeof x === 'string').map(x => x.slice(0, 80)).slice(0, 20) : []
      apps.push({ name, repo, integration, production, noRunner })
    }
  }
  return { root, owner: clean(doc.owner, 40), apps }
}

/**
 * Walk up from `start` to the first folder holding workbench.json. A regular file only: a folder of that name is
 * not a marker. A marker that cannot be read still makes a workspace. No start, or none found: null.
 */
export async function findWorkspace($: EngineInterface, start: string | undefined): Promise<Workspace | null> {
  if (!start || !start.startsWith('/')) return null
  let dir = start.replace(/\/+$/, '') || '/'
  for (let depth = 0; depth < 64; depth++) {
    const file = `${dir === '/' ? '' : dir}/${MARKER}`
    const stat = await $.fs.stat(file).catch(() => undefined)
    if (stat && stat.kind === 'file') {
      const text = await $.fs.read(file).then(t => (typeof t === 'string' ? t : '')).catch(() => '')
      return parseWorkspace(text, dir)
    }
    if (dir === '/') return null
    dir = dir.slice(0, dir.lastIndexOf('/')) || '/'
  }
  return null
}

const EXCLUDED = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders', '/dev/shm', '/run']
// The standard user folders: not eligible themselves, their subfolders are.
const USER_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public', 'Library', 'Applications', 'Sites', 'Dropbox', 'OneDrive', 'Google Drive', 'iCloud Drive', 'snap']

const trimSlash = (p: string) => p.replace(/\/+$/, '')
const under = (path: string, base: string) => Boolean(base) && (path === base || path.startsWith(`${base}/`))

/**
 * Whether session-start.sh would auto-init this folder: the same rule as `wb_eligible` in kit/lib/common.sh, which is
 * the source of truth. It exists and holds nothing but .DS_Store; it is not `/` or the home folder; not under a temp,
 * system, config or library folder or the kit's own home; no hidden path segment below the home folder; not one of the
 * standard user folders itself; not /Volumes or /mnt itself; and not inside a git work tree (git that cannot run
 * counts as inside). (Being inside a workspace is checked by the caller.) Used only to decide whether to register the
 * model's tools: a wrong "yes" costs a few tool definitions, a wrong "no" costs the tools until the next session.
 */
export async function isEligibleEmpty($: EngineInterface, dir: string | undefined, home: string, tmp: string, workbenchHome: string): Promise<boolean> {
  if (!dir || !dir.startsWith('/')) return false
  const physical = async (p: string) => (await $.fs.stat(p, { resolve: true }).catch(() => undefined))?.realPath ?? p
  const given = trimSlash(dir) || '/'
  const path = trimSlash(await physical(given)) || '/'
  if (path === '/') return false
  const homes = [...new Set([trimSlash(home), trimSlash(home ? await physical(home) : '')].filter(Boolean))]
  if (homes.some(h => path === h || given === h)) return false
  const bases = [...EXCLUDED, tmp, home && `${home}/.claude`, home && `${home}/.config`, home && `${home}/Library`, workbenchHome || (home && `${home}/.workbench`)]
  for (const raw of bases) {
    const x = trimSlash(raw || '')
    if (!x || homes.includes(x)) continue
    for (const ex of new Set([x, trimSlash(await physical(x))])) if (ex && (under(path, ex) || under(given, ex))) return false
  }
  if (path === '/Volumes' || path === '/mnt') return false
  for (const h of homes) {
    if (!path.startsWith(`${h}/`)) continue
    const rel = path.slice(h.length + 1)
    if (USER_FOLDERS.includes(rel)) return false
    if (rel.split('/').some(seg => seg.startsWith('.'))) return false
  }
  const entries = await $.fs.list(path).catch(() => undefined)
  if (!entries || !entries.every(e => e.name === '.DS_Store')) return false
  try {
    const ran = await $.process.run(['git', '-C', path, 'rev-parse', '--is-inside-work-tree'], { cwd: '/' })
    if (ran.stdout.trim() === 'true') return false
    // Outside a repository git says so; any other failure (not installed, not runnable) is "cannot tell", so not eligible.
    return ran.exitCode === 0 || /not a git repository/i.test(ran.stderr)
  } catch {
    return false
  }
}

/** The auto-init switches session-start.sh reads: WORKBENCH_AUTO is not 0 and the private config says autoInit true. */
export async function isAutoInitOn($: EngineInterface, home: string): Promise<boolean> {
  if ((await $.env.get('WORKBENCH_AUTO').catch(() => undefined)) === '0') return false
  const path = (await $.env.get('WORKBENCH_CONFIG').catch(() => undefined)) || (home ? `${home}/.config/workbench/config.json` : '')
  if (!path) return false
  try {
    const text = await $.fs.read(path)
    const doc = JSON.parse(typeof text === 'string' ? text : '')
    return Boolean(doc) && typeof doc === 'object' && doc.autoInit === true
  } catch {
    return false
  }
}
