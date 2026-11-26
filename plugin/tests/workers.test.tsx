import { expect, test } from 'claude-code/testing'

import { isEnded, isQuietWorker } from '../hooks/lib/tones'
import { agents, mocked, seen } from './helpers'
import { SPAWN, mountPane, setup, texts } from './kit'

// Which workers count as running. A named builder goes idle when its work is done and waits for a follow-up, a
// stopped one reads "stopped" or "killed", and a stopped one also drops out of the agent list. None of those is
// still running, and none of them may sit in the pane as a red "quiet" worker for ever.

const POLL = 5_000
const tick = async (ms = POLL) => {
  await mocked.clock!.advance(ms)
  for (let i = 0; i < 30; i++) await Promise.resolve()
}
const flat = async (ui: any) => (await texts(ui)).replace(/\s+/g, ' ')
const listed = (id: string, status: string, description = `Build ${id}`) => ({ id, description, type: 'builder', status })

test('idle, stopped and killed are ended; running is not', () => {
  for (const s of ['completed', 'failed', 'killed', 'stopped', 'idle', 'gone']) expect(isEnded(s)).toBe(true)
  expect(isEnded('running')).toBe(false)
  // An ended worker is never quiet, however long ago it last did anything.
  expect(isQuietWorker({ id: 'a', description: 'x', type: 't', status: 'idle', startedAt: 0, lastActiveAt: 0 }, 10 ** 13)).toBe(false)
})

test('a builder that goes idle or is stopped leaves the running count, and comes back when messaged again', async ($: any, on: any) => {
  await setup($, on, { quiet: true, clock: true })
  agents.list = [listed('a1', 'running'), listed('a2', 'running')]
  const ui = await mountPane($)
  await tick()
  expect(await flat(ui)).toContain('2 running')

  agents.list = [listed('a1', 'idle'), listed('a2', 'stopped')]
  await tick()
  let text = await flat(ui)
  expect(text).toContain('0 running')
  expect(text).toContain('2 finished recently')
  expect(text).not.toContain('quiet')
  // An idle builder finished its work: that is "Done", like a completed one.
  expect(seen.toasts.filter(t => t === 'Done: Build a1')).toHaveLength(1)

  // A follow-up message wakes the idle one.
  agents.list = [listed('a1', 'running'), listed('a2', 'stopped')]
  await tick()
  text = await flat(ui)
  expect(text).toContain('1 running')
  expect(text).toContain('1 finished recently')
  await ui.unmount()
})

test('a worker that drops out of the agent list is ended, without a toast, and returns if it is listed again', async ($: any, on: any) => {
  await setup($, on, { quiet: true, clock: true })
  agents.list = [listed('a1', 'running'), listed('a2', 'running')]
  const ui = await mountPane($)
  await tick()
  expect(await flat(ui)).toContain('2 running')
  const toastsBefore = seen.toasts.length
  const noticesBefore = seen.notices.length

  agents.list = [listed('a2', 'running')]
  await tick()
  let text = await flat(ui)
  expect(text).toContain('1 running')
  expect(text).toContain('1 finished recently')
  expect(seen.toasts.length).toBe(toastsBefore)
  expect(seen.notices.length).toBe(noticesBefore)

  // It reads as ended, grey, never as a red "quiet" worker (an ended worker is never quiet: see the first test).
  expect(text).toContain('Build a1 builder ended')
  expect(text).not.toContain('Build a1 builder quiet')

  // A list that comes back with it (a blip, or a worker messaged again) puts it back to running.
  agents.list = [listed('a1', 'running'), listed('a2', 'running')]
  await tick()
  expect(await flat(ui)).toContain('2 running')
  await ui.unmount()
})

test('a worker just spawned is not ended before the engine has had time to list it', async ($: any, on: any) => {
  await setup($, on, { quiet: true, clock: true })
  agents.list = []
  const ui = await mountPane($)
  await ($.agent as any).spawn(SPAWN)
  await tick()
  expect(await flat(ui)).toContain('1 running')
  // Still unlisted after the grace: it is ended.
  await tick(2 * 60_000)
  expect(await flat(ui)).toContain('0 running')
  await ui.unmount()
})

test('a list that cannot be read changes nothing', async ($: any, on: any) => {
  await setup($, on, { quiet: true, clock: true })
  agents.list = [listed('a1', 'running')]
  const ui = await mountPane($)
  await tick()
  expect(await flat(ui)).toContain('1 running')
  agents.list = 'not a list' as unknown as unknown[]
  await tick()
  expect(await flat(ui)).toContain('1 running')
  agents.list = []
  await ui.unmount()
})
