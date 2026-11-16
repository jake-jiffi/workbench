import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { UndoneItem, UndoneSource } from '../../types'
import { ensureLoaded, mutate, saveTasks } from './store'
import { rootDir } from './workspace'
import {
  addCandidates, applyTaskCall, findCommitments, findMarkers, isTrackedPath, lastTwo, parseReport, removedMarkers, resolveRemovedMarkers,
} from './undone'
import type { Candidate } from './undone'

// Where candidates come from. Only four places are read: builder results, the orchestrator's own final
// answer, edits that add TODO or FIXME, and task lists. Never the transcript, never narration.

// One toast per turn: adds pile up here and turn.complete flushes them.
let pendingAdds = 0
export const takePendingAdds = () => {
  const n = pendingAdds
  pendingAdds = 0
  return n
}

// The engine's scan reads state from the file that uses it, so each file declares the atoms it touches,
// with the same key, default and shape as register.tsx.
const workers = atom({ plugin: 'workbench', key: 'workers' } as const, [], { shape: 'workers-2' })
const snapshot = atom({ plugin: 'workbench', key: 'snapshot' } as const, null, { shape: 'snapshot-2' })
const tasksOpen = atom({ plugin: 'workbench', key: 'tasksOpen' } as const, [], { shape: 'tasks-1' })

/** `report`: the builder whose whole report these candidates are (addCandidates' `report`). */
export type CaptureOptions = { retentionDays: number; report?: string }

export async function workerSource($: EngineInterface, agentId: string): Promise<UndoneSource> {
  const w = (await read($, workers)).find(x => x.id === agentId)
  const where = w?.worktree?.replace('worktrees/', '')
  const label = w ? (where ? `${w.description} · ${where}` : w.description) : 'builder'
  return { label, agentId, worktree: w?.worktree }
}

export async function add($: EngineInterface, candidates: Candidate[], o: CaptureOptions): Promise<UndoneItem[]> {
  if (!candidates.length) return []
  const now = await $.clock.now()
  const sessionId = await $.session.id().catch(() => '')
  const waiting = (await read($, snapshot))?.waiting ?? []
  // The workspace this item belongs to. In an empty folder the auto-init hook is about to make one, the folder is the root.
  const root = rootDir() || (await $.session.cwd().catch(() => ''))
  const added = await mutate($, now, store => {
    const r = addCandidates(store, candidates, { now, sessionId, waiting, tombstoneDays: o.retentionDays, report: o.report, root })
    return { store: r.store, result: r.added }
  })
  pendingAdds += added.length
  return added
}

/** A turn ended. A builder's report, or the orchestrator's final answer. */
export async function captureTurn($: EngineInterface, e: { answer: string; reason: string; agentId?: string }, o: CaptureOptions) {
  if (e.reason !== 'answer' || !e.answer.trim()) return
  await ensureLoaded($)
  if (e.agentId) {
    const source = await workerSource($, e.agentId)
    const items = parseReport(e.answer)
    await add($, items.map(i => ({ kind: 'report', tag: i.tag, text: i.text, source, confidence: 'high' })), { ...o, report: e.agentId })
    return
  }
  const source: UndoneSource = { label: 'orchestrator' }
  const sections: Candidate[] = parseReport(e.answer).map(i => ({ kind: 'commit', tag: i.tag, text: i.text, source, confidence: 'medium' }))
  const said: Candidate[] = findCommitments(e.answer).map(i => ({ kind: 'commit', tag: i.tag, text: i.text, source, confidence: i.confidence }))
  await add($, [...sections, ...said], o)
}

type Edit = { path: string; before: string; after: string }

function editOf(e: Record<string, unknown>): Edit | null {
  const tool = String(e.tool)
  if (tool === 'Write') return { path: String(e.file_path ?? ''), before: '', after: String(e.content ?? '') }
  if (tool === 'Edit') return { path: String(e.file_path ?? ''), before: String(e.old_string ?? ''), after: String(e.new_string ?? '') }
  if (tool === 'NotebookEdit') return { path: String(e.notebook_path ?? ''), before: '', after: String(e.new_source ?? '') }
  // Not in this build's tool table; kept for builds that have it.
  if (tool === 'MultiEdit' && Array.isArray(e.edits)) {
    const edits = e.edits as Array<{ old_string?: string; new_string?: string }>
    return { path: String(e.file_path ?? ''), before: edits.map(x => x.old_string ?? '').join('\n'), after: edits.map(x => x.new_string ?? '').join('\n') }
  }
  return null
}

/** A file edit succeeded: new TODO lines are added, removed ones resolve. */
export async function captureEdit($: EngineInterface, e: Record<string, unknown>, o: CaptureOptions) {
  const edit = editOf(e)
  if (!edit || !edit.path || !isTrackedPath(edit.path)) return
  const added = findMarkers(edit.path, edit.before, edit.after)
  const gone = edit.before ? removedMarkers(edit.path, edit.before, edit.after) : []
  if (!added.length && !gone.length) return
  await ensureLoaded($)
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined
  const base: UndoneSource = agentId ? await workerSource($, agentId) : { label: 'orchestrator' }
  const source: UndoneSource = { ...base, file: lastTwo(edit.path) }
  if (gone.length) {
    const now = await $.clock.now()
    await mutate($, now, store => ({ store: resolveRemovedMarkers(store, edit.path, gone, now, rootDir()), result: 0 }))
  }
  await add($, added.map(text => ({ kind: 'todo', tag: 'TODO', text, source, confidence: 'high' })), o)
}

/** The orchestrator's task tools. Builders' own lists are ignored. */
export async function captureTask($: EngineInterface, e: Record<string, unknown>, result: unknown) {
  if (typeof e.agentId === 'string') return
  const tool = String(e.tool)
  if (tool !== 'TodoWrite' && tool !== 'TaskCreate' && tool !== 'TaskUpdate') return
  await ensureLoaded($)
  const list = await read($, tasksOpen)
  if (tool === 'TodoWrite') {
    await saveTasks($, applyTaskCall(list, { tool, todos: (e.todos as Array<{ content: string; status: string }>) ?? [] }))
  } else if (tool === 'TaskCreate') {
    const id = (result as { task?: { id?: string } } | undefined)?.task?.id
    await saveTasks($, applyTaskCall(list, { tool, subject: String(e.subject ?? ''), id }))
  } else {
    await saveTasks($, applyTaskCall(list, { tool, taskId: String(e.taskId ?? ''), status: e.status as string | undefined, subject: e.subject as string | undefined }))
  }
}
