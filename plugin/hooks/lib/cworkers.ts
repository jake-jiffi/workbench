import type { EngineInterface } from 'claude-code'

import type { CWorker } from '../../types'
import { RECENT_MS } from './tones'
import { clip } from './undone'

// claude-worker's workers, read-only. Each lives in <home>/.claude/workers/w/<id>/. The only files this mod
// ever opens are state.json (state.json.prev when that does not parse) and spec.json, and from spec.json only
// the worker's name is kept. Nothing is written. A file that is missing, half-written or unreadable is skipped
// without a word. Every read goes through `readFile`, which refuses any other file name.

export const CW_POLL_MS = 15_000
// The supervisor writes state every 15 seconds while it lives. Three missed beats and the row says so.
export const CW_SILENT_MS = 3 * 15_000 + 15_000
export const CW_ENDED = ['done', 'failed', 'stopped']
export const isCwEnded = (state: string) => CW_ENDED.includes(state)

const ALLOWED_FILES = ['state.json', 'state.json.prev', 'spec.json']
const ID = /^[A-Za-z0-9_-]{1,40}$/
const STATE = /^[a-z][a-z_-]{0,15}$/

export const SHOWN_MS = 120_000

/** Whether the 15-second read is due: only while the pane is docked or was drawn (or the band asked for) lately. */
export function isReadDue(i: { isPlaced: boolean; lastDrawAt: number; lastBandAt: number; lastReadAt: number; now: number; force?: boolean }): boolean {
  if (i.force) return true
  const isShown = i.isPlaced || i.now - Math.max(i.lastDrawAt, i.lastBandAt) < SHOWN_MS
  return isShown && i.now - i.lastReadAt >= CW_POLL_MS - 1_000
}

export const workersDir = (home: string) => `${home.replace(/\/+$/, '')}/.claude/workers/w`

/** The one door to the disk: a worker folder's state or spec file, and nothing else under .claude/workers. */
export async function readFile($: EngineInterface, dir: string, id: string, file: string): Promise<string> {
  if (!ID.test(id) || !ALLOWED_FILES.includes(file)) throw new Error('not a readable claude-worker file')
  return String(await $.fs.read(`${dir}/${id}/${file}`))
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.trim() ? clip(v, max) : undefined)

function parse(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A state object into a row, or null when it is not a worker's state. Pure. */
export function toCWorker(id: string, raw: Record<string, unknown>, name: string | undefined): CWorker | null {
  if (typeof raw.state !== 'string' || !STATE.test(raw.state)) return null
  const createdAt = num(raw.createdAt)
  const updatedAt = num(raw.updatedAt) ?? createdAt
  if (createdAt === undefined || updatedAt === undefined) return null
  const finishedAt = num(raw.finishedAt)
  const legs = Array.isArray(raw.legs) ? raw.legs.length : 0
  return {
    id,
    name: name ?? id,
    state: raw.state,
    account: str(raw.account, 24),
    reason: str(raw.reason, 160),
    createdAt,
    updatedAt,
    endedAt: isCwEnded(raw.state) ? (finishedAt ?? updatedAt) : undefined,
    legs,
  }
}

// Memory across reads (lost on reload, which only costs a re-read): a worker's name never changes, and a worker
// that ended long ago is not opened again.
const names = new Map<string, string>()
const gone = new Set<string>()

export function forgetAll() {
  names.clear()
  gone.clear()
}

/** Every claude-worker worker worth showing now, newest first. Never rejects. */
export async function readCWorkers($: EngineInterface, home: string, now: number): Promise<CWorker[]> {
  if (!home) return []
  const dir = workersDir(home)
  let entries: Array<{ name: string; kind: string }>
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const out: CWorker[] = []
  for (const entry of entries) {
    if (entry.kind !== 'dir' || !ID.test(entry.name) || gone.has(entry.name)) continue
    const id = entry.name
    try {
      let raw: Record<string, unknown> | null = null
      for (const file of ['state.json', 'state.json.prev']) {
        raw = await readFile($, dir, id, file).then(parse, () => null)
        if (raw && typeof raw.state === 'string') break
        raw = null
      }
      if (!raw) continue
      if (!names.has(id)) {
        const spec = await readFile($, dir, id, 'spec.json').then(parse, () => null)
        const name = spec ? str(spec.name, 40) : undefined
        // No name yet (spec unreadable this time): show the id, and look again next read.
        if (name) names.set(id, name)
      }
      const worker = toCWorker(id, raw, names.get(id))
      if (!worker) continue
      if (worker.endedAt !== undefined && now - worker.endedAt >= RECENT_MS) {
        gone.add(id)
        continue
      }
      out.push(worker)
    } catch {
      // Skipped quietly.
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 40)
}

export const runningCW = (list: CWorker[]) => list.filter(w => w.state === 'running')

/** Running but no heartbeat for a while: the supervisor may have died. claude-worker revives it on its next status. */
export const isSilentCW = (w: CWorker, now: number) => w.state === 'running' && now - w.updatedAt > CW_SILENT_MS

/** The worker's rows in the card: those not ended, then those ended inside the recent window. */
export function visibleCW(list: CWorker[], now: number): CWorker[] {
  const live = list.filter(w => !isCwEnded(w.state))
  const recent = list
    .filter(w => isCwEnded(w.state) && now - (w.endedAt ?? now) < RECENT_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 6)
  return [...live, ...recent]
}
