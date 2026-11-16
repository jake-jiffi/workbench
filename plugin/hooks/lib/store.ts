import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { TaskLine, UndoneItem, UndoneStore } from '../../types'
import { emptyStore, pruneResolved, scopeItems } from './undone'
import { rootDir } from './workspace'

// Left undone lives in `$.store` (this Mac, this plugin, shared by every Claude session in the folder).
// The atoms only mirror it for drawing. Nothing here is written to a repo, to Slack or to a PR.

// The engine's scan reads state from the file that uses it, so each file declares the atoms it touches,
// with the same key, default and shape as register.tsx.
const undone = atom({ plugin: 'workbench', key: 'undone' } as const, [], { shape: 'undone-1' })
const tasksOpen = atom({ plugin: 'workbench', key: 'tasksOpen' } as const, [], { shape: 'tasks-1' })

const KEY = 'undone.v1'
const TASKS_KEY = 'tasks.v1'

// Module memory: lost on reload, which only costs one re-read of the store.
let loadedFor = ''
let chain: Promise<unknown> = Promise.resolve()

function valid(raw: unknown): raw is UndoneStore {
  const s = raw as UndoneStore | undefined
  return Boolean(s && s.v === 1 && Array.isArray(s.items) && Array.isArray(s.tombstones) && typeof s.counter === 'number')
}

export async function loadStore($: EngineInterface): Promise<UndoneStore> {
  const raw = await $.store.get(KEY)
  return valid(raw) ? raw : emptyStore()
}

/**
 * Read the store fresh, change it, write it back, mirror it into the atom. Calls queue, so two hooks in one
 * turn never overwrite each other, and another session's items are re-read just before every write.
 */
export function mutate<R>($: EngineInterface, now: number, fn: (store: UndoneStore) => { store: UndoneStore; result: R }): Promise<R> {
  const run = async () => {
    const { store, result } = fn(await loadStore($))
    const kept = pruneResolved(store, now)
    await $.store.set(KEY, kept)
    await update($, undone, () => kept.items)
    return result
  }
  const next = chain.then(run, run)
  chain = next.catch(() => undefined)
  return next
}

/**
 * Hydrate the atom from the store. There is no `session.start` after a /clear, so every hook and the pane
 * call this: it reloads when the session id changed, or when the atom is empty while the store is not.
 */
export async function ensureLoaded($: EngineInterface): Promise<void> {
  const id = await $.session.id().catch(() => '')
  const shown = await read($, undone)
  if (id === loadedFor && shown.length > 0) return
  const store = await loadStore($)
  if (id === loadedFor && store.items.length === 0 && shown.length === 0) return
  await update($, undone, () => store.items)
  const tasks = (await $.store.get(TASKS_KEY)) as TaskLine[] | undefined
  await update($, tasksOpen, () => (Array.isArray(tasks) ? tasks : []))
  loadedFor = id
}

export async function saveTasks($: EngineInterface, list: TaskLine[]): Promise<void> {
  await $.store.set(TASKS_KEY, list)
  await update($, tasksOpen, () => list)
}

/**
 * What the card draws. A render hook may not write state, so it cannot hydrate the atom: when the atom is
 * empty (after a /clear, before any hook has run) it reads the store directly.
 */
export async function readItems($: EngineInterface): Promise<{ items: UndoneItem[]; tasks: TaskLine[] }> {
  const items = await read($, undone)
  const tasks = await read($, tasksOpen)
  const root = rootDir()
  if (items.length > 0 || tasks.length > 0) return { items: scopeItems(items, root), tasks }
  const store = await loadStore($)
  const stored = (await $.store.get(TASKS_KEY)) as TaskLine[] | undefined
  return { items: scopeItems(store.items, root), tasks: Array.isArray(stored) ? stored : [] }
}
