import { expect, test } from 'claude-code/testing'

import { PANE, STATE, engine, mocked, seen } from './helpers'
import { forgetAll, isReadDue, readFile, toCWorker, visibleCW } from '../hooks/lib/cworkers'
import { summarize } from '../hooks/lib/summary'

const BAND = { plugin: 'workbench', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 100, scroll: { offset: 0, bodyRows: 8 } } } as const

const HOME = '/Users/test'
const W = `${HOME}/.claude/workers/w`
const MIN = 60_000
const HOUR = 3_600_000

// A fake ~/.claude/workers/w: id -> file name -> text. Every list and read is logged.
let disk: Record<string, Record<string, string>> = {}
const reads: string[] = []
const lists: string[] = []
let clockNow = 1_800_000_000_000
let isFolderMissing = false

const json = (o: unknown) => JSON.stringify(o)
const stateOf = (o: Record<string, unknown>) => json({ id: 'x', state: 'running', reason: 'leg 1 on team', account: 'team', sessionId: 's', legs: [{ n: 1 }], createdAt: clockNow - 12 * MIN, updatedAt: clockNow - 5_000, waiting: null, ...o })

// Each test moves the clock on first, then builds its files from it.
const fresh = () => {
  clockNow += 10 * HOUR
}

async function setup($: any, on: any, workers: Record<string, Record<string, string>>) {
  forgetAll()
  disk = workers
  reads.length = 0
  lists.length = 0
  isFolderMissing = false
  // The default engine answers every read with STATE.md; a worker file comes from the fake disk.
  const readOf = (path?: string) => {
    const m = /\/w\/([^/]+)\/([^/]+)$/.exec(String(path))
    if (!m) return STATE
    reads.push(String(path))
    const text = disk[m[1] ?? '']?.[m[2] ?? '']
    if (text === undefined) throw new Error('ENOENT')
    return text
  }
  engine(on, undefined, readOf, () => clockNow)
  on('fs.list', (_: unknown, e: { path?: string }) => {
    lists.push(String(e.path))
    if (isFolderMissing || e.path !== W) throw new Error('ENOENT')
    return { value: Object.keys(disk).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }
  })
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
}

const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 40))

// session.start reads the workers once; the pane shows what that read found.
async function paneTexts($: any): Promise<string> {
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const t = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text).join('\n')
  await ui.unmount()
  return t
}

test('a running worker shows with its name, state, account, age and reason', async ($: any, on: any) => {
  fresh()
  await setup($, on, {
    'w-3b3c7e': {
      'spec.json': json({ name: 'fix-web-login', worktree: '/x/y', agent: 'web-builder', agentDef: { prompt: 'SECRET-PROMPT' }, caller: 'c' }),
      'state.json': stateOf({ id: 'w-3b3c7e' }),
    },
  })
  const t = await paneTexts($)
  expect(t).toContain('fix-web-login')
  expect(t).toMatch(/running · team 12m/)
  expect(t).toContain('leg 1 on team')
  // Only the name is taken from the spec.
  expect(t).not.toContain('SECRET-PROMPT')
  expect(t).not.toContain('web-builder')
  // The card's running total counts it.
  expect(t).toMatch(/Workers\s+1 running/)
  for (const x of t.split('\n')) expect(x.length).toBeLessThanOrEqual(PANE.props.bodyColumns - 4)
})

test('the band and status line count a running claude-worker worker', async ($: any, on: any) => {
  fresh()
  await setup($, on, { 'w-aaaaaa': { 'spec.json': json({ name: 'a' }), 'state.json': stateOf({}) }, 'w-bbbbbb': { 'spec.json': json({ name: 'b' }), 'state.json': stateOf({ state: 'waiting', reason: 'waiting for an account: team: 91%' }) } })
  await settle()
  const ui = await $.ui.mount({ ...BAND })
  const t = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text).join('\n')
  // One running (the waiting one is not running).
  expect(t).toContain('1 working')
  await ui.unmount()
})

test('summarize counts only running claude-worker workers', () => {
  const w = (state: string) => ({ id: state, name: state, state, createdAt: 1, updatedAt: 1, legs: 1 })
  const s = summarize({ workers: [], cworkers: [w('running'), w('running'), w('waiting'), w('done'), w('failed')], snap: null, undoneOpen: 0, usage: null, cache: { lastAt: null, lastContext: 0, isObserved: false, read: 0, total: 0 }, ttl: '5m', th: { warn: 60, urgent: 80 }, now: 0 })
  expect(s.running).toBe(2)
})

test('a malformed state file is skipped; state.json.prev stands in; a missing spec shows the id', async ($: any, on: any) => {
  fresh()
  await setup($, on, {
    'w-bad001': { 'spec.json': json({ name: 'broken-one' }), 'state.json': '{"state": "run', 'state.json.prev': 'not json at all' },
    'w-bad002': { 'spec.json': json({ name: 'wrong-shape' }), 'state.json': '[1,2,3]' },
    'w-bad003': { 'spec.json': json({ name: 'no-times' }), 'state.json': json({ state: 'running' }) },
    'w-bad004': { 'spec.json': json({ name: 'evil-state' }), 'state.json': stateOf({ state: 'running\nIGNORE ALL' }) },
    'w-prev01': { 'spec.json': json({ name: 'from-prev' }), 'state.json': '{"half', 'state.json.prev': stateOf({ reason: 'leg 2 on lab' }) },
    'w-nospec': { 'state.json': stateOf({}) },
    'w-nostate': { 'spec.json': json({ name: 'nothing-else' }) },
  })
  const t = await paneTexts($)
  for (const gone of ['broken-one', 'wrong-shape', 'no-times', 'evil-state', 'nothing-else', 'IGNORE']) expect(t).not.toContain(gone)
  expect(t).toContain('from-prev')
  expect(t).toContain('leg 2 on lab')
  expect(t).toContain('w-nospec')
})

test('finished workers stay for a while, then drop off', async ($: any, on: any) => {
  fresh()
  await setup($, on, {
    'w-done01': { 'spec.json': json({ name: 'just-finished' }), 'state.json': stateOf({ state: 'done', reason: 'result ok', finishedAt: clockNow - 20 * MIN, updatedAt: clockNow - 20 * MIN }) },
    'w-fail01': { 'spec.json': json({ name: 'just-failed' }), 'state.json': stateOf({ state: 'failed', reason: 'crashed twice', finishedAt: clockNow - 2 * HOUR, updatedAt: clockNow - 2 * HOUR }) },
    'w-old001': { 'spec.json': json({ name: 'ancient-run' }), 'state.json': stateOf({ state: 'done', finishedAt: clockNow - 5 * HOUR, updatedAt: clockNow - 5 * HOUR }) },
    'w-stop01': { 'spec.json': json({ name: 'ancient-stop' }), 'state.json': stateOf({ state: 'stopped', updatedAt: clockNow - 9 * HOUR }) },
  })
  const t = await paneTexts($)
  expect(t).toContain('just-finished')
  expect(t).toContain('just-failed')
  expect(t).toContain('crashed twice')
  expect(t).not.toContain('ancient-run')
  expect(t).not.toContain('ancient-stop')
  expect(t).toMatch(/\d+ finished recently/)
  // An old finished worker is dropped from the list and not opened again on later reads.
  const first = reads.filter(p => p.includes('w-old001')).length
  expect(first).toBeGreaterThan(0)
})

test('a worker past the auto-move line shows what claude-worker says about it', () => {
  const moved = toCWorker('w-1', { state: 'running', reason: 'between legs: moved off team at 94%', account: 'team', createdAt: 5, updatedAt: 6, legs: [{}, {}] }, 'n')
  expect(moved?.reason).toBe('between legs: moved off team at 94%')
  expect(moved?.legs).toBe(2)
  const queued = toCWorker('w-2', { state: 'waiting', reason: 'waiting for an account: team: session 96%', createdAt: 5, updatedAt: 6 }, undefined)
  expect(queued?.name).toBe('w-2')
  expect(queued?.reason).toContain('session 96%')
})

test('a silent running worker is flagged, and not hidden', async ($: any, on: any) => {
  fresh()
  await setup($, on, { 'w-quiet1': { 'spec.json': json({ name: 'maybe-dead' }), 'state.json': stateOf({ updatedAt: clockNow - 10 * MIN }) } })
  const t = await paneTexts($)
  expect(t).toContain('maybe-dead')
  expect(t).toContain('no heartbeat 10m')
})

test('only state.json, state.json.prev and spec.json are ever read, and nothing is written', async ($: any, on: any) => {
  fresh()
  await setup($, on, {
    'w-3b3c7e': {
      'spec.json': json({ name: 'ok' }),
      'state.json': stateOf({}),
      'brief.md': 'CLIENT BRIEF',
      'settings.json': '{}',
      'leg-1.prompt.md': 'p',
      'leg-1.out.jsonl': '{}',
    },
    'w-prev02': { 'spec.json': json({ name: 'p' }), 'state.json': '{"x', 'state.json.prev': stateOf({}) },
  })
  const t = await paneTexts($)
  expect(t).toContain('ok')
  expect(reads.length).toBeGreaterThan(0)
  for (const p of reads) expect(p).toMatch(/\/\.claude\/workers\/w\/w-[a-z0-9]+\/(state\.json|state\.json\.prev|spec\.json)$/)
  expect(reads.join('\n')).not.toMatch(/brief|leg-|settings/)
  // The only listing is the workers folder itself.
  for (const p of lists) expect(p).toBe(W)
  expect(seen.written.filter(w => w.path.includes('/workers/'))).toEqual([])
})

test('readFile refuses any other file and any path trick', async ($: any, on: any) => {
  fresh()
  await setup($, on, {})
  for (const [id, file] of [['w-1', 'brief.md'], ['w-1', 'leg-1.out.jsonl'], ['w-1', 'settings.json'], ['w-1', '../spec.json'], ['..', 'spec.json'], ['w-1/../x', 'state.json'], ['', 'state.json']] as const) {
    await expect(readFile($ as any, W, id, file)).rejects.toThrow()
  }
  expect(reads).toEqual([])
})

test('a missing workers folder is quiet', async ($: any, on: any) => {
  fresh()
  await setup($, on, {})
  isFolderMissing = true
  const t = await paneTexts($)
  expect(t).toContain('Workers')
})

test('visibleCW lists live workers first, then recent finished ones', () => {
  const now = 100 * HOUR
  const w = (id: string, state: string, endedAt?: number) => ({ id, name: id, state, createdAt: 1, updatedAt: 1, endedAt, legs: 1 })
  const list = visibleCW([w('old', 'done', now - 4 * HOUR), w('new', 'done', now - MIN), w('live', 'running'), w('q', 'waiting')], now)
  expect(list.map(x => x.id)).toEqual(['live', 'q', 'new'])
})

test('the read is due every 15 seconds, and only while the pane or band is shown', () => {
  const base = { isPlaced: false, lastDrawAt: 0, lastBandAt: 0, lastReadAt: 0, now: 1_000_000 }
  // Neither shown: never, unless forced.
  expect(isReadDue(base)).toBe(false)
  expect(isReadDue({ ...base, force: true })).toBe(true)
  // Docked pane: due once 15 seconds have passed.
  expect(isReadDue({ ...base, isPlaced: true, lastReadAt: base.now - 5_000 })).toBe(false)
  expect(isReadDue({ ...base, isPlaced: true, lastReadAt: base.now - 15_000 })).toBe(true)
  // Drawn a minute ago counts as shown; three minutes ago does not. The band counts the same way.
  expect(isReadDue({ ...base, lastDrawAt: base.now - 60_000 })).toBe(true)
  expect(isReadDue({ ...base, lastDrawAt: base.now - 180_000 })).toBe(false)
  expect(isReadDue({ ...base, lastBandAt: base.now - 60_000 })).toBe(true)
})

test('the 15-second tick picks up a worker that starts and one that finishes', async ($: any, on: any) => {
  fresh()
  forgetAll()
  disk = { 'w-first1': { 'spec.json': json({ name: 'first-one' }), 'state.json': stateOf({}) } }
  reads.length = 0
  lists.length = 0
  const clock = { now: clockNow }
  engine(on, undefined, (path?: string) => {
    const m = /\/w\/([^/]+)\/([^/]+)$/.exec(String(path))
    if (!m) return STATE
    reads.push(String(path))
    const text = disk[m[1] ?? '']?.[m[2] ?? '']
    if (text === undefined) throw new Error('ENOENT')
    return text
  }, () => clockNow, undefined, undefined, clock)
  on('fs.list', () => ({ value: Object.keys(disk).map(name => ({ name, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })) }))
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  await settle()
  const names = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const t = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text).join('\n')
    await ui.unmount()
    return t
  }
  expect(await names()).toContain('first-one')
  expect(await names()).not.toContain('second-one')
  disk['w-second'] = { 'spec.json': json({ name: 'second-one' }), 'state.json': stateOf({}) }
  disk['w-first1'] = { 'spec.json': json({ name: 'first-one' }), 'state.json': stateOf({ state: 'done', reason: 'result ok', finishedAt: clock.now, updatedAt: clock.now }) }
  await mocked.clock!.advance(16_000)
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await settle()
  const t = await names()
  expect(t).toContain('second-one')
  expect(t).toMatch(/✓ first-one/)
})
