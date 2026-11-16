import type { EngineInterface } from 'claude-code'

import type { UndoneTag } from '../../types'
import { add, workerSource } from './capture'
import type { CaptureOptions } from './capture'
import { loadStore, mutate } from './store'
import { openItems, resolveItem, scopeItems, unscopedTag } from './undone'
import { rootDir } from './workspace'

// The three tools Claude calls itself. They are registered once at session.start and never again, and the
// one prompt section that mentions them is static text: the prompt cache is warm for the whole session.
// Only left_undone_list reads live state, and it does so when called, not through the system prompt.

export const TOOL_ADD = 'mcp__workbench__left_undone_add' as const
export const TOOL_RESOLVE = 'mcp__workbench__left_undone_resolve' as const
export const TOOL_LIST = 'mcp__workbench__left_undone_list' as const
export const TOOL_BRIEF = 'mcp__workbench__handover_brief' as const
export const TOOL_CLEAR = 'mcp__workbench__handover_clear' as const

// Fixed text. Must read the same on every request, so it never holds a count, a name or a date.
export const PROMPT_SECTION = {
  id: 'workbench:left-undone',
  text: [
    'Left undone (workbench): when you promise something for later, or finish a task with something not done, call left_undone_add with one short line (no client names or data).',
    'When you finish one, call left_undone_resolve with its id. left_undone_list shows what is open.',
    'End a builder report with the headings Not done, Couldn\'t run, and Noticed, left alone ("None" under a heading if empty).',
    'Lines under Waiting on <owner> in notes/STATE.md are the owner\'s, not yours: do not add them.',
    'Before a /clear, call handover_brief (last_ask: the last thing the owner asked, verbatim), then handover_clear, naming running workers in carry and PR watchers in watchers.',
  ].join('\n'),
  scope: 'session',
} as const

export async function registerTools($: EngineInterface): Promise<void> {
  await $.tool.register({
    name: 'left_undone_add',
    description: 'Record something you promised for later or left undone, so it is not lost. One short line, no client names.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What is left to do, one line.' },
        kind: { type: 'string', enum: ['promise', 'not_done'], description: 'promise: said you would; not_done: finished without it.' },
      },
      required: ['text'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'left_undone_resolve',
    description: 'Mark a left-undone item finished, by its id (U12). The owner can reopen it for 7 days.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, note: { type: 'string', description: 'One line on what was done.' } },
      required: ['id'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'handover_brief',
    description: 'Build the handover brief for a fresh context from files and mod state. Pass last_ask: the last thing the owner asked, verbatim.',
    inputSchema: { type: 'object', properties: { last_ask: { type: 'string', description: 'Verbatim, at most 600 characters.' } }, required: ['last_ask'] },
    isDeferred: true,
  })
  await $.tool.register({
    name: 'handover_clear',
    description: 'Save the brief and queue a /clear for when this turn ends. Refused while workers run unless carried.',
    inputSchema: {
      type: 'object',
      properties: {
        last_ask: { type: 'string' },
        carry: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
        watchers: { type: 'array', items: { type: 'string' }, description: 'PR numbers with a watcher to restart.' },
      },
      required: ['last_ask'],
    },
    isDeferred: true,
  })
  await $.tool.register({
    name: 'left_undone_list',
    description: 'List open left-undone items (id, tag, text).',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: true,
  })
}

// The engine maps an MCP tool's result from its content blocks.
// Literal isError, so the engine's ToolCallResult union accepts it. On success isError is left out, which the engine reads as false.
const reply = (text: string, isError = false) => (isError ? { result: text, isError: true as const } : { result: text })

export async function toolAdd($: EngineInterface, e: { text?: unknown; kind?: unknown; agentId?: string }, o: CaptureOptions) {
  const text = String(e.text ?? '').trim()
  if (text.length < 4) return reply('Nothing recorded: give a short line of text.', true)
  const tag: UndoneTag = e.kind === 'not_done' ? 'Not done' : e.kind === 'promise' ? 'Said' : 'Note'
  const source = e.agentId ? await workerSource($, e.agentId) : { label: 'orchestrator' }
  const [made] = await add($, [{ kind: 'manual', tag, text, source, confidence: 'high' }], o)
  return reply(made ? `Recorded as ${made.id}.` : 'Not recorded: an open item already says this, or the owner dropped it, or it is one of theirs.')
}

export async function toolResolve($: EngineInterface, e: { id?: unknown; note?: unknown }) {
  const id = String(e.id ?? '').trim().toUpperCase()
  const now = await $.clock.now()
  const found = await mutate<boolean | string>($, now, store => {
    const item = store.items.find(i => i.id === id && i.status === 'open')
    // An item of another workspace is not this one's to resolve; an old unscoped one can be resolved from anywhere.
    if (item?.root && rootDir() && item.root !== rootDir()) return { store, result: item.root }
    return { store: item ? resolveItem(store, id, 'claude', now, e.note ? String(e.note) : undefined) : store, result: Boolean(item) }
  })
  if (typeof found === 'string') return reply(`${id} belongs to the workspace at ${found}, not this one. Resolve it from there.`, true)
  return found ? reply(`${id} marked done. The owner can reopen it for 7 days.`) : reply(`No open item ${id}. left_undone_list shows what is open.`, true)
}

export async function toolList($: EngineInterface) {
  const open = openItems({ items: scopeItems((await loadStore($)).items, rootDir()) })
  if (!open.length) return reply('Nothing is left undone.')
  const lines = open.slice(0, 40).map(i => `${i.id} [${i.tag}, ${i.sources[0]?.label ?? ''}]${i.flag ? ` (${i.flag})` : ''}${unscopedTag(i)} ${i.text}`)
  return reply(lines.join('\n') + (open.length > 40 ? `\n(and ${open.length - 40} more)` : ''))
}
