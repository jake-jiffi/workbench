import type { TaskLine, UndoneItem, UndoneKind, UndoneSource, UndoneStore, UndoneTag } from '../../types'

// Left undone: finding what Claude and its builders said they would do and did not come back to.
// Pure functions only (no `$`), so the tests call them directly.
//
// Adapted from terminal-desk, hooks/detect.ts and hooks/register.tsx (MIT, Doonminus2; see NOTICE):
//   sentences()        the fenced-code strip and the sentence split
//   parseReport()      the heading-then-bullets idea of findSections(), rewritten for our fixed headings
//   findMarkers()      the "marker on a line that was not there before" idea, with tighter markers
//   applyTaskCall()    the mirror of TodoWrite, TaskCreate and TaskUpdate in trackTasks()
// Everything else (cues for future promises, the report headings, keys, merging, tombstones,
// caps, the waiting-on-the-owner filter) is ours.

export const MAX_TEXT = 200
export const MAX_NEW_PER_TURN = 12
export const MAX_STORED = 200
// Open Not done and Said items are never pruned by the soft cap above; this ceiling keeps the store bounded anyway.
export const HARD_MAX = 400
export const TOMBSTONE_DAYS = 14
export const RESOLVED_KEEP_MS = 7 * 86_400_000
const DAY = 86_400_000

export type Candidate = {
  kind: UndoneKind
  tag: UndoneTag
  text: string
  source: UndoneSource
  confidence: 'high' | 'medium' | 'low'
}

// ---------- text hygiene ----------

/** Mask what must never sit in the store: emails and long opaque strings (hex, base64, tokens). */
export function mask(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email]')
    .replace(/\b(?:sk|pk|ghp|gho|ghs|xox[a-z]|eyJ)[A-Za-z0-9_-]{8,}/g, '[secret]')
    .replace(/(?<![\w/.-])[A-Za-z0-9+/_=-]{24,}(?![\w/.-])/g, m => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? '[secret]' : m))
}

export function clip(text: string, max = MAX_TEXT): string {
  const one = mask(text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim())
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** Split an answer into sentences, leaving out fenced code. */
export function sentences(answer: string): string[] {
  const prose = answer.replace(/```[\s\S]*?```/g, '\n')
  return prose
    .split(/\n+|(?<=[.!?])\s+/)
    .map(s => s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^#+\s*/, '').trim())
    .filter(s => s.length > 3)
}

// ---------- keys, refs, similarity ----------

/** Lowercase, markdown stripped, punctuation gone, spaces collapsed, digits kept, 90 characters. */
export function normaliseKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[*_`>#]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90)
}

/** PR and issue numbers (`web#206`, `#135`) and file paths named in the text. */
export function extractRefs(text: string): string[] {
  const refs = new Set<string>()
  for (const m of text.matchAll(/(?<![\w#])([A-Za-z][\w-]{0,30})?#(\d{1,5})\b/gi)) refs.add(`${(m[1] ?? '').toLowerCase()}#${m[2]}`)
  for (const m of text.matchAll(/(?<![\w/])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]{1,5})\b/g)) refs.add((m[1] ?? '').toLowerCase())
  return [...refs]
}

const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'will', 'have', 'not', 'are', 'was', 'its', 'but', 'you', 'your', 'our', 'then', 'when', 'once', 'all'])

const tokens = (text: string) => new Set(normaliseKey(text).split(' ').filter(t => t.length > 2 && !STOP.has(t)))

export function jaccard(a: string, b: string): number {
  const [x, y] = [tokens(a), tokens(b)]
  if (!x.size || !y.size) return 0
  let both = 0
  for (const t of x) if (y.has(t)) both += 1
  return both / (x.size + y.size - both)
}

const shareRef = (a: string[], b: string[]) => a.some(r => b.includes(r))

/** One builder's reworded point: SAME_BUILDER_JACCARD overlap and at least 4 words in common, so short lines with generic words stay apart. */
export function samePoint(a: string, b: string): boolean {
  const [x, y] = [tokens(a), tokens(b)]
  let both = 0
  for (const t of x) if (y.has(t)) both += 1
  return both >= 4 && jaccard(a, b) >= SAME_BUILDER_JACCARD
}

/** Same key, or token overlap of 0.8 and a shared PR number or file. */
export function similar(a: Pick<UndoneItem, 'key' | 'text' | 'refs'>, b: Pick<UndoneItem, 'key' | 'text' | 'refs'>): boolean {
  if (a.key === b.key) return true
  return shareRef(a.refs, b.refs) && jaccard(a.text, b.text) >= 0.8
}

/**
 * True when a candidate restates a line of Waiting on the owner. Those belong to the owner, so they are not left undone.
 * Rule: token overlap of 0.6 or more, or a waiting line of 3+ words that the candidate covers 80% of.
 */
export function isOwnersItem(text: string, waiting: string[]): boolean {
  const c = tokens(text)
  for (const line of waiting) {
    const w = tokens(line)
    if (!w.size) continue
    if (jaccard(text, line) >= 0.6) return true
    if (w.size >= 3) {
      let covered = 0
      for (const t of w) if (c.has(t)) covered += 1
      if (covered / w.size >= 0.8) return true
    }
  }
  return false
}

// ---------- builder reports ----------

const REPORT_HEADINGS: Array<{ re: RegExp; tag: UndoneTag }> = [
  { re: /^(?:not done|nothing done|left undone|not finished|incomplete)$/i, tag: 'Not done' },
  { re: /^(?:couldn'?t run(?: it)?|could not run(?: it)?|not run|wasn'?t run|didn'?t run|unable to run)$/i, tag: "Couldn't run" },
  { re: /^(?:noticed,? left alone|noticed but left alone|left alone|noticed)$/i, tag: 'Noticed' },
]

const NONE = /^(?:none|nothing|n\/a|na|no|nil|not applicable|nothing to report|none noticed|none that i know of|—|-)\.?$/i
const BULLET = /^\s*(?:[-•*+]|\d+[.)])\s+(.*)$/

function headingOf(line: string): { tag: UndoneTag; rest: string } | null {
  const bare = line.trim().replace(/^#{1,6}\s*/, '').replace(/^[-•*+]\s+(?=\S)/, '')
  const colon = bare.search(/[:：]/)
  const name = (colon < 0 ? bare : bare.slice(0, colon)).replace(/[*_]/g, '').trim().replace(/[.:]$/, '')
  const rest = (colon < 0 ? '' : bare.slice(colon + 1)).replace(/^\s*(?:\*\*|__)/, '').trim()
  if (name.length > 40) return null
  for (const h of REPORT_HEADINGS) if (h.re.test(name)) return { tag: h.tag, rest }
  return null
}

/**
 * Items under the fixed report headings (Not done, Couldn't run, Noticed, left alone).
 * One item per bullet; a bare line straight under the heading is one item; "None" is dropped.
 */
export function parseReport(answer: string): Array<{ tag: UndoneTag; text: string }> {
  const lines = answer.replace(/```[\s\S]*?```/g, '\n').split('\n')
  const found: Array<{ tag: UndoneTag; text: string }> = []
  let tag: UndoneTag | null = null
  let current: string | null = null
  let sawBullet = false
  let blanks = 0
  const flush = () => {
    if (tag && current !== null) {
      const text = clip(current)
      if (text.length > 3 && !NONE.test(text) && !found.some(f => f.tag === tag && f.text === text)) found.push({ tag, text })
    }
    current = null
  }
  for (const line of lines) {
    if (line.trim() === '') {
      blanks += 1
      continue
    }
    const h = headingOf(line)
    if (h) {
      flush()
      tag = h.tag
      sawBullet = false
      blanks = 0
      if (h.rest) {
        const b = BULLET.exec(h.rest)
        current = b ? (b[1] ?? '') : h.rest
      }
      continue
    }
    if (!tag) continue
    const b = BULLET.exec(line)
    if (b) {
      flush()
      current = b[1] ?? ''
      sawBullet = true
      blanks = 0
      continue
    }
    if (/^\s{2,}\S/.test(line) && current !== null && blanks === 0) {
      current += ` ${line.trim()}`
      continue
    }
    // A plain line straight under the heading is its one item. Any other prose ends the section.
    if (current === null && !sawBullet && blanks <= 1 && !/^#{1,6}\s/.test(line) && !headingOf(line)) {
      current = line.trim()
      blanks = 0
      continue
    }
    flush()
    tag = null
    blanks = 0
  }
  flush()
  return found.slice(0, MAX_NEW_PER_TURN)
}

// ---------- the orchestrator's final answer ----------

const FUTURE = /\b(?:I'll|I will|I'm going to|I am going to|I can|I'd)\b/i
const IMMEDIATE = /\bI(?:'ll| will) (?:now|just|go ahead|start|begin|run|check|look|read|open|fix|try|take a look)\b|\bI(?:'ll| will) (?:also )?(?:now )?(?:run|check|read|fix) (?:the|that|this|it)\b/i
const CUE: RegExp[] = [
  /\bat (?:the )?release\b/i,
  /\bwhen (?:it|that|this|the [\w-]+(?: [\w-]+)?|#\d+|[\w-]+#\d+) (?:merges|is merged|lands|is approved|is live|goes live|clears|is green)\b/i,
  /\bonce (?:it|that|this|you|the [\w-]+(?: [\w-]+)?|#\d+|[\w-]+#\d+|[\w-]+) (?:merges|merge|is merged|is approved|has been approved|lands|is live|goes live|approves|approve|clears|is green|is back)\b/i,
  /\bon approval\b/i,
  /\bafter (?:the )?(?:release|approval|it merges|the merge|merge|review|you approve)\b/i,
  /\blater\b/i,
  /\bnext (?:session|week|block|time|turn|release)\b/i,
  /\btomorrow\b/i,
  /\bgive you the post to paste\b/i,
  /\bclose #\d+/i,
  /\bat the end of (?:the|this) (?:block|week|session)\b/i,
]
const OWNERS = /\byou(?:'ll| will)? (?:need|have) to\b|\bwaiting (?:on|for) (?:you|your)\b|\bfor you to\b|\bit'?s your call\b|\byour (?:go-ahead|approval|ruling|decision)\b|\bup to you\b/i
const QUESTION = /\?\s*$|^(?:shall|should|want me|do you want|would you like|can you|could you|will you)\b/i
const ADMIT: RegExp[] = [
  /\bI (?:didn't|did not|haven't|have not|couldn't|could not|wasn't able to|was unable to|never got to)\s+(?:\w+\s+){0,2}(?:run|test|verify|check|deploy|merge|finish|complete|implement|try|reproduce|cover|confirm|get to)\b/i,
  /\bI(?:'ve| have) (?:skipped|left)\b/i,
  /\bI skipped\b/i,
  /\bnot yet (?:tested|verified|run|done|deployed|merged|checked)\b/i,
]

/** Promises for later and plain admissions in the orchestrator's own final answer. */
export function findCommitments(answer: string): Array<{ tag: UndoneTag; text: string; confidence: 'medium' | 'low' }> {
  const out: Array<{ tag: UndoneTag; text: string; confidence: 'medium' | 'low' }> = []
  const seen = new Set<string>()
  for (const s of sentences(answer)) {
    if (QUESTION.test(s) || OWNERS.test(s)) continue
    const text = clip(s)
    let hit: 'medium' | 'low' | null = null
    if (FUTURE.test(s) && !IMMEDIATE.test(s) && CUE.some(re => re.test(s))) hit = 'medium'
    else if (ADMIT.some(re => re.test(s))) hit = 'low'
    if (hit && !seen.has(text)) {
      seen.add(text)
      out.push({ tag: 'Said', text, confidence: hit })
    }
  }
  return out.slice(0, MAX_NEW_PER_TURN)
}

// ---------- TODO markers in edits ----------

const SKIP_PATH = /(?:^|\/)(?:node_modules|notes|\.git)\/|\.md$|\.mdx$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock)$|\.lock$|(?:^|\/)\.env(?:\.|$)/i
const COMMENT_MARKER = /(?:\/\/|\/\*|^\s*\*|(?:^|\s)#(?!\d)|(?:^|\s)--(?:\s|$)|<!--)[^\n]*?\b(?:TODO|FIXME|XXX|HACK)\b/
const CODE_MARKER = /NotImplementedError|unimplemented!\(|throw new Error\(\s*(['"`])not implemented/i

export const isTrackedPath = (path: string) => !SKIP_PATH.test(path)

const isMarkerLine = (line: string) => COMMENT_MARKER.test(line) || CODE_MARKER.test(line)

/** Marker lines in `after` that `before` did not already have. Skips docs, notes, lock files, env files. */
export function findMarkers(path: string, before: string, after: string): string[] {
  if (!isTrackedPath(path)) return []
  const old = new Set(before.split('\n').map(l => l.trim()))
  const found: string[] = []
  for (const line of after.split('\n')) {
    const t = line.trim()
    if (t && isMarkerLine(t) && !old.has(t)) {
      const text = clip(t)
      if (!found.includes(text)) found.push(text)
    }
  }
  return found.slice(0, 8)
}

/** Marker lines `before` had that `after` no longer has: the marker was removed. */
export function removedMarkers(path: string, before: string, after: string): string[] {
  if (!isTrackedPath(path)) return []
  const now = new Set(after.split('\n').map(l => l.trim()))
  const gone: string[] = []
  for (const line of before.split('\n')) {
    const t = line.trim()
    if (t && isMarkerLine(t) && !now.has(t)) gone.push(clip(t))
  }
  return gone
}

export const lastTwo = (path: string) => path.split('/').filter(Boolean).slice(-2).join('/')

export const todoKey = (path: string, text: string) => normaliseKey(`${lastTwo(path)} ${text}`)

// ---------- tasks (orchestrator's TaskCreate, TaskUpdate, TodoWrite) ----------

type TaskCall =
  | { tool: 'TodoWrite'; todos: Array<{ content: string; status: string }> }
  | { tool: 'TaskCreate'; subject: string; id?: string }
  | { tool: 'TaskUpdate'; taskId: string; status?: string; subject?: string }

/** Mirror of the orchestrator's open tasks. Completed and deleted ones drop out. */
export function applyTaskCall(list: TaskLine[], call: TaskCall): TaskLine[] {
  if (call.tool === 'TodoWrite') {
    return call.todos.filter(t => t.status !== 'completed').slice(0, 30).map((t, i) => ({ id: `t${i}`, text: clip(t.content, 120) }))
  }
  if (call.tool === 'TaskCreate') {
    if (!call.id) return list
    return [...list.filter(t => t.id !== call.id), { id: call.id, text: clip(call.subject, 120) }].slice(-30)
  }
  if (call.status === 'completed' || call.status === 'deleted') return list.filter(t => t.id !== call.taskId)
  if (call.subject) return list.map(t => (t.id === call.taskId ? { ...t, text: clip(call.subject ?? '', 120) } : t))
  return list
}

// ---------- the store ----------

/** Whether an item belongs in the view of workspace `root`: its own, or an old one with no root. No root asked: all. */
export const inScope = (i: { root?: string }, root: string | undefined) => !root || !i.root || i.root === root

/** The items of one workspace, plus the unscoped ones. */
export const scopeItems = (items: UndoneItem[], root: string | undefined) => items.filter(i => inScope(i, root))

/** ` (unscoped)` for an item stored before scoping, so it is clear why it shows in every workspace. */
export const unscopedTag = (i: { root?: string }) => (i.root ? '' : ' (unscoped)')

export const emptyStore = (): UndoneStore => ({ v: 1, counter: 0, items: [], tombstones: [] })

const RANK = { high: 3, medium: 2, low: 1 } as const

/**
 * `report`: the agent id when the candidates are one whole report from that builder. Its report replaces its last one:
 * an open item from it alone that the new report no longer names is resolved as superseded.
 */
export type AddOptions = { now: number; sessionId: string; waiting?: string[]; tombstoneDays?: number; report?: string; root?: string }

/** A builder rewords the same point between its interim and final reports; this much token overlap from one builder is one point. */
export const SAME_BUILDER_JACCARD = 0.5

/** Merge candidates into the store: tombstones, de-dupe, the owner's items filtered, caps held. */
export function addCandidates(store: UndoneStore, candidates: Candidate[], o: AddOptions): { store: UndoneStore; added: UndoneItem[] } {
  const ttl = (o.tombstoneDays ?? TOMBSTONE_DAYS) * DAY
  const next: UndoneStore = {
    ...store,
    items: store.items.map(i => ({ ...i })),
    tombstones: store.tombstones.filter(t => o.now - t.at < ttl),
  }
  const added: UndoneItem[] = []
  const named = new Set<string>()
  for (const cand of candidates) {
    const text = clip(cand.text)
    if (text.length < 4) continue
    const file = cand.source.file
    const key = cand.kind === 'todo' && file ? todoKey(file, text) : normaliseKey(text)
    if (!key) continue
    if (next.tombstones.some(t => t.key === key && inScope(t, o.root))) continue
    if (o.waiting && isOwnersItem(text, o.waiting)) continue
    const refs = extractRefs(text)
    const probe = { key, text, refs }
    const agent = cand.source.agentId
    const same = (i: UndoneItem) => similar(i, probe) || (Boolean(agent) && i.sources.some(s => s.agentId === agent) && samePoint(i.text, text))
    const match = next.items.find(i => i.status === 'open' && inScope(i, o.root) && same(i))
    // The same builder repeating a point already resolved: its earlier report again, not news. From anyone else it can return.
    if (!match && agent && next.items.some(i => i.status === 'done' && inScope(i, o.root) && i.sources.some(s => s.agentId === agent) && same(i))) continue
    if (match) {
      named.add(match.id)
      match.seen += 1
      match.lastAt = o.now
      if (!match.sources.some(s => s.label === cand.source.label)) match.sources.push(cand.source)
      if (RANK[cand.confidence] > RANK[match.confidence]) match.confidence = cand.confidence
      continue
    }
    if (added.length >= MAX_NEW_PER_TURN) continue
    next.counter += 1
    const item: UndoneItem = {
      id: `U${next.counter}`,
      key,
      kind: cand.kind,
      tag: cand.tag,
      text,
      sources: [cand.source],
      refs,
      confidence: cand.confidence,
      firstAt: o.now,
      lastAt: o.now,
      seen: 1,
      status: 'open',
      sessionId: o.sessionId,
      ...(o.root ? { root: o.root } : {}),
    }
    next.items.push(item)
    added.push(item)
    named.add(item.id)
  }
  // A report with no items under the headings ("Waiting on CI.") replaces nothing.
  if (o.report && candidates.length > 0) {
    const mine = (i: UndoneItem) => i.kind === 'report' && i.sources.length > 0 && i.sources.every(s => s.agentId === o.report)
    next.items = next.items.map(i =>
      i.status === 'open' && mine(i) && !named.has(i.id)
        ? { ...i, status: 'done', resolvedBy: 'auto', resolvedAt: o.now, note: 'Superseded: the same builder\'s later report left it out' }
        : i,
    )
  }
  next.items = pruneCap(next.items)
  return { store: next, added }
}

/** Over the cap, drop oldest dropped and done items first, then oldest Noticed, then low confidence. Open Not done and Said are kept. */
export function pruneCap(items: UndoneItem[], max = MAX_STORED): UndoneItem[] {
  if (items.length <= max) return items
  const out = [...items]
  const take = (pred: (i: UndoneItem) => boolean, by: (i: UndoneItem) => number, limit = max) => {
    while (out.length > limit) {
      const victims = out.filter(pred).sort((a, b) => by(a) - by(b))
      const v = victims[0]
      if (!v) return
      out.splice(out.indexOf(v), 1)
    }
  }
  take(i => i.status !== 'open', i => i.resolvedAt ?? i.lastAt)
  take(i => i.tag === 'Noticed', i => i.lastAt)
  take(i => i.confidence === 'low', i => i.lastAt)
  take(() => true, i => i.lastAt, HARD_MAX)
  return out
}

/** Resolved items go 7 days after resolution. */
export function pruneResolved(store: UndoneStore, now: number): UndoneStore {
  const items = store.items.filter(i => i.status === 'open' || now - (i.resolvedAt ?? now) < RESOLVED_KEEP_MS)
  return items.length === store.items.length ? store : { ...store, items }
}

export function resolveItem(store: UndoneStore, id: string, by: 'owner' | 'claude' | 'auto', now: number, note?: string): UndoneStore {
  return { ...store, items: store.items.map(i => (i.id === id && i.status === 'open' ? { ...i, status: 'done', resolvedBy: by, resolvedAt: now, note: note ? clip(note, 120) : i.note } : i)) }
}

/** Drop: resolved as not wanted, with a tombstone so the same words do not return. */
export function dropItem(store: UndoneStore, id: string, now: number): UndoneStore {
  const item = store.items.find(i => i.id === id && i.status === 'open')
  if (!item) return store
  return {
    ...store,
    items: store.items.map(i => (i.id === id ? { ...i, status: 'dropped', resolvedBy: 'owner', resolvedAt: now } : i)),
    tombstones: [...store.tombstones.filter(t => !(t.key === item.key && t.root === item.root)), { key: item.key, at: now, ...(item.root ? { root: item.root } : {}) }],
  }
}

export function reopenItem(store: UndoneStore, id: string): UndoneStore {
  return { ...store, items: store.items.map(i => (i.id === id && i.status === 'done' ? { ...i, status: 'open', resolvedBy: undefined, resolvedAt: undefined } : i)) }
}

/** Clear all: every open item is dropped (with tombstones). */
export function dropAllOpen(store: UndoneStore, now: number, root?: string): UndoneStore {
  return store.items.filter(i => i.status === 'open' && inScope(i, root)).reduce((s, i) => dropItem(s, i.id, now), store)
}

/** Auto-resolve open todo items in `path` whose marker line was removed. */
export function resolveRemovedMarkers(store: UndoneStore, path: string, lines: string[], now: number, root?: string): UndoneStore {
  const keys = new Set(lines.map(l => todoKey(path, l)))
  return {
    ...store,
    items: store.items.map(i => (i.status === 'open' && i.kind === 'todo' && inScope(i, root) && keys.has(i.key) ? { ...i, status: 'done', resolvedBy: 'auto', resolvedAt: now } : i)),
  }
}

/** Flag open items that name a PR which is no longer open. Flagged, never cleared. */
export function flagGonePrs(store: UndoneStore, gone: string[], root?: string): UndoneStore {
  if (!gone.length) return store
  let changed = false
  const items = store.items.map(i => {
    if (i.status !== 'open' || i.flag || !inScope(i, root)) return i
    const hit = i.refs.find(r => gone.some(g => g === r || (r.startsWith('#') && g.endsWith(r))))
    if (!hit) return i
    changed = true
    return { ...i, flag: `${hit.replace(/^[a-z]*/, '')} merged or closed` }
  })
  return changed ? { ...store, items } : store
}

// ---------- reading the store ----------

export const isStale = (i: UndoneItem, now: number, days: number) => now - i.firstAt > days * DAY

/** Open items: flagged first, then oldest first. */
export function openItems(store: { items: UndoneItem[] }): UndoneItem[] {
  return store.items.filter(i => i.status === 'open').sort((a, b) => Number(Boolean(b.flag)) - Number(Boolean(a.flag)) || a.firstAt - b.firstAt)
}

/** Open items for the card: newest first, low confidence below the rest. */
export function cardItems(items: UndoneItem[]): UndoneItem[] {
  return items.filter(i => i.status === 'open').sort((a, b) => RANK[b.confidence] - RANK[a.confidence] || Number(Boolean(b.flag)) - Number(Boolean(a.flag)) || b.lastAt - a.lastAt)
}

export const recentlyClaudeResolved = (items: UndoneItem[]) => items.filter(i => i.status === 'done' && i.resolvedBy === 'claude').sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0))

export const sourceLabel = (i: UndoneItem) => {
  const s = i.sources[0]
  return s ? (s.file ? `${s.label} · ${s.file}` : s.label) : ''
}

export const FINISH_MAX = 15

/** The prompt text for "Ask Claude to finish": flagged items first, then oldest first, 15 at most. */
export function finishRequest(store: { items: UndoneItem[] }): string {
  const open = openItems(store)
  const lines = open.slice(0, FINISH_MAX).map(i => `- ${i.id} [${i.tag}, ${i.sources[0]?.label ?? 'unknown'}]${i.flag ? ` (${i.flag})` : ''}${unscopedTag(i)} ${i.text}`)
  const more = open.length > FINISH_MAX ? `\n(and ${open.length - FINISH_MAX} more: left_undone_list shows them)` : ''
  return [
    'These are yours, left undone from earlier. For each one: do it, or say in one line why not, then call left_undone_resolve with its id. Leave what is waiting on the owner alone.',
    ...lines,
  ].join('\n') + more
}

export function reopenable(items: UndoneItem[], now: number): UndoneItem[] {
  return recentlyClaudeResolved(items).filter(i => now - (i.resolvedAt ?? now) < RESOLVED_KEEP_MS)
}
