import { expect, test } from 'claude-code/testing'

import {
  addCandidates, dropAllOpen, dropItem, emptyStore, extractRefs, findCommitments, findMarkers, isOwnersItem, jaccard, mask, normaliseKey,
  parseReport, removedMarkers, resolveItem, resolveRemovedMarkers, similar, applyTaskCall, flagGonePrs, pruneCap, openItems,
} from '../hooks/lib/undone'
import type { Candidate } from '../hooks/lib/undone'

// Every text here is written for the test. None of it is a real report, message or client record.

const REPORT = `Done. PR opened into staging as #206, CI green.

**What changed**
- Added the repair button to the mic settings page.

**Not done**
- Live test of the mic repair button
- Dark mode styling for the new dialog, carried over to the next PR

**Couldn't run it**
- The end-to-end suite: no runner in this worktree

**Noticed, left alone**
- The settings page imports a helper that is never used

Thanks.`

test('a builder report with the fixed headings gives the right items and tags', async () => {
  const items = parseReport(REPORT)
  expect(items.map(i => i.tag)).toEqual(['Not done', 'Not done', "Couldn't run", 'Noticed'])
  expect(items[0]?.text).toBe('Live test of the mic repair button')
  expect(items[2]?.text).toContain('end-to-end suite')
  expect(items.some(i => i.text.includes('Thanks'))).toBe(false)
  expect(items.some(i => i.text.includes('Added the repair button'))).toBe(false)
})

test('None bullets, empty headings and inline forms', async () => {
  expect(parseReport('**Not done**\n- None\n\n**Couldn\'t run**\nNothing.\n\n**Noticed, left alone**\n- n/a')).toEqual([])
  expect(parseReport('Not done: nothing')).toEqual([])
  expect(parseReport('Not done: the retry path for the sync job')).toEqual([{ tag: 'Not done', text: 'the retry path for the sync job' }])
  expect(parseReport('## Not run\n1. migration check\n2. type check')).toHaveLength(2)
  expect(parseReport('- **Not done**: staging deploy\n- **Left alone**: a flaky test in billing')).toHaveLength(2)
})

test('prose that only sounds like a heading is not an item', async () => {
  expect(parseReport('Noticed the build was slow, so I cached it.')).toEqual([])
  expect(parseReport('Not done yet? It is. All green.')).toEqual([])
  expect(parseReport('```\nNot done\n- pasted from a log\n```')).toEqual([])
})

test('a heading list ends at the next paragraph and folds continuation lines', async () => {
  const items = parseReport('**Not done**\n- First thing that is long\n  and carries on here\n- Second thing\n\nThe rest is a normal paragraph about nothing.')
  expect(items).toHaveLength(2)
  expect(items[0]?.text).toBe('First thing that is long and carries on here')
})

test('the orchestrator: promises for later are caught', async () => {
  const hits = (s: string) => findCommitments(s).map(c => c.text)
  expect(hits("I'll close #135 at release.")).toEqual(["I'll close #135 at release."])
  expect(hits("Once the release PR merges I'll tell you the live check.")).toHaveLength(1)
  expect(hits("I will give you the post to paste when it is ready.")).toHaveLength(1)
  expect(hits("I'm going to cut the next release tomorrow.")).toHaveLength(1)
  expect(hits("I can write the follow-up after approval.")).toHaveLength(1)
  expect(findCommitments("I'll close #135 at release.")[0]?.confidence).toBe('medium')
})

test('the orchestrator: admissions are caught at low confidence', async () => {
  const c = findCommitments("I haven't run the mobile suite. The web suite is green.")
  expect(c).toHaveLength(1)
  expect(c[0]?.confidence).toBe('low')
  expect(findCommitments("I couldn't verify the live page, the deploy is still building.")).toHaveLength(1)
  expect(findCommitments('The migration was not yet tested on staging.')).toHaveLength(1)
})

test('the orchestrator: work in hand, questions and Sam\'s items are not caught', async () => {
  const hits = (s: string) => findCommitments(s)
  expect(hits("I'll now run the tests.")).toHaveLength(0)
  expect(hits("I'll run the tests after the build finishes.")).toHaveLength(0)
  expect(hits('Shall I close #135 at release?')).toHaveLength(0)
  expect(hits('Want me to close #135 once it merges?')).toHaveLength(0)
  expect(hits("You'll need to run the migration at release.")).toHaveLength(0)
  expect(hits("I'm waiting on you for the production decision, later this week.")).toHaveLength(0)
  expect(hits('Skipped files were not counted; the report skipped nothing important.')).toHaveLength(0)
  expect(hits('The test named "not implemented yet" passes.')).toHaveLength(0)
  expect(hits('```\nI will do it later\n```')).toHaveLength(0)
})

test('TODO markers: comment forms count, docs and lock files do not', async () => {
  expect(findMarkers('src/a.ts', '', 'const a = 1\n// TODO: handle the empty list\n')).toEqual(['// TODO: handle the empty list'])
  expect(findMarkers('src/a.py', '', 'x = 1  # FIXME retry on 502')).toHaveLength(1)
  expect(findMarkers('src/a.sql', '', '-- TODO index this column')).toHaveLength(1)
  expect(findMarkers('src/a.ts', '', "throw new Error('not implemented')")).toHaveLength(1)
  expect(findMarkers('src/a.rs', '', 'unimplemented!("later")')).toHaveLength(1)
  expect(findMarkers('README.md', '', '// TODO: docs')).toEqual([])
  expect(findMarkers('notes/plan.txt', '', '// TODO: x')).toEqual([])
  expect(findMarkers('package-lock.json', '', '// TODO')).toEqual([])
  expect(findMarkers('.env.local', '', '# TODO set key')).toEqual([])
  expect(findMarkers('node_modules/x/index.js', '', '// TODO')).toEqual([])
  // prose and strings that merely contain the word
  expect(findMarkers('src/a.ts', '', "const label = 'TODO list'")).toEqual([])
  expect(findMarkers('src/a.ts', '', 'const todos = items.filter(isTodo)')).toEqual([])
  // already there before the edit
  expect(findMarkers('src/a.ts', '// TODO: old\n', '// TODO: old\nconst a = 1')).toEqual([])
})

test('removing a marker is seen', async () => {
  expect(removedMarkers('src/a.ts', '// TODO: handle empty\nconst a = 1', 'const a = 1')).toEqual(['// TODO: handle empty'])
  expect(removedMarkers('src/a.ts', '// TODO: x', '// TODO: x')).toEqual([])
})

test('keys, refs and similarity', async () => {
  expect(normaliseKey("**I'll** close #135, at release!")).toBe('i ll close 135 at release')
  expect(normaliseKey('x'.repeat(200))).toHaveLength(90)
  expect(extractRefs('Close web#135 and #12; see hooks/lib/undone.ts')).toEqual(['web#135', '#12', 'hooks/lib/undone.ts'])
  expect(jaccard('live test of the mic repair button', 'live test of the mic repair button today')).toBeGreaterThan(0.8)
  const a = { key: 'a', text: 'Live test of the mic repair button in web#206', refs: ['web#206'] }
  const b = { key: 'b', text: 'live test of the mic repair button for web#206', refs: ['web#206'] }
  expect(similar(a, b)).toBe(true)
  expect(similar({ ...b, refs: [] }, a)).toBe(false)
})

test('emails and long opaque strings are masked before saving', async () => {
  expect(mask('send to jo.bloggs@example.com now')).toBe('send to [email] now')
  expect(mask('token ghp_abcdefghijklmnop123456 here')).toContain('[secret]')
  expect(mask('key a1b2c3d4e5f6a7b8c9d0e1f2a3b4 done')).toContain('[secret]')
  expect(mask('path hooks/lib/undone-and-store-and-more.ts stays')).toContain('hooks/lib/undone')
})

const cand = (text: string, label = 'web-builder', over: Partial<Candidate> = {}): Candidate => ({ kind: 'report', tag: 'Not done', text, source: { label }, confidence: 'high', ...over })
const o = { now: 1_000_000, sessionId: 's1' }

test('the same text from a builder and the orchestrator is one item with two sources', async () => {
  let r = addCandidates(emptyStore(), [cand('Live test of the mic repair button', 'Web PR · web/feat-x')], o)
  r = addCandidates(r.store, [cand('Live test of the mic repair button!', 'orchestrator', { kind: 'commit', tag: 'Said', confidence: 'medium' })], { ...o, now: 2_000_000 })
  expect(r.store.items).toHaveLength(1)
  expect(r.store.items[0]?.sources.map(s => s.label)).toEqual(['Web PR · web/feat-x', 'orchestrator'])
  expect(r.store.items[0]?.seen).toBe(2)
  expect(r.store.items[0]?.lastAt).toBe(2_000_000)
})

test('a dropped item does not return; a done item can', async () => {
  let s = addCandidates(emptyStore(), [cand('Close the old flag'), cand('Rotate the staging key note')], o).store
  s = dropItem(s, 'U1', 1_100_000)
  s = resolveItem(s, 'U2', 'owner', 1_100_000)
  const again = addCandidates(s, [cand('Close the old flag'), cand('Rotate the staging key note')], { ...o, now: 1_200_000 })
  expect(again.added.map(i => i.text)).toEqual(['Rotate the staging key note'])
  // the tombstone expires with the retention window
  const later = addCandidates(s, [cand('Close the old flag')], { ...o, now: 1_100_000 + 15 * 86_400_000 })
  expect(later.added).toHaveLength(1)
})

test('clear all drops every open item once', async () => {
  const s = addCandidates(emptyStore(), [cand('one thing here'), cand('another thing here')], o).store
  const cleared = dropAllOpen(s, 2_000_000)
  expect(openItems(cleared)).toHaveLength(0)
  expect(cleared.tombstones).toHaveLength(2)
})

test('todo items auto-resolve when the marker line goes, and are per file', async () => {
  const a = cand('// TODO: handle empty', 'orchestrator', { kind: 'todo', tag: 'TODO', source: { label: 'orchestrator', file: 'src/a.ts' } })
  const b = cand('// TODO: handle empty', 'orchestrator', { kind: 'todo', tag: 'TODO', source: { label: 'orchestrator', file: 'src/b.ts' } })
  let s = addCandidates(emptyStore(), [a, b], o).store
  expect(s.items).toHaveLength(2)
  s = resolveRemovedMarkers(s, 'src/a.ts', ['// TODO: handle empty'], 3_000_000)
  expect(s.items.map(i => `${i.status}:${i.resolvedBy ?? ''}`)).toEqual(['done:auto', 'open:'])
})

test('300 candidates in one turn stay within the caps', async () => {
  const many = Array.from({ length: 300 }, (_, i) => cand(`Distinct follow-up number ${i} about subsystem ${i * 7}`))
  const r = addCandidates(emptyStore(), many, o)
  expect(r.added).toHaveLength(12)
  expect(r.store.items).toHaveLength(12)
  // the stored cap keeps open Not done items and drops resolved ones first
  let s = emptyStore()
  for (let t = 0; t < 25; t++) s = addCandidates(s, many.slice(t * 12, t * 12 + 12), { ...o, now: o.now + t }).store
  // open Not done items are never pruned by the soft cap of 200; a hard ceiling of 400 holds the store
  expect(s.items.length).toBe(300)
  for (let t = 0; t < 12; t++) s = addCandidates(s, many.slice(0, 12).map((c, i) => ({ ...c, text: `${c.text} extra ${t} ${i}` })), { ...o, now: o.now + 100 + t }).store
  expect(s.items.length).toBeLessThanOrEqual(400)
  const items = Array.from({ length: 210 }, (_, i) => ({ ...addCandidates(emptyStore(), [cand(`filler thing ${i} number ${i}`, 'x', i % 2 ? { tag: 'Noticed' as const } : {})], o).store.items[0]!, id: `U${i}`, firstAt: i, lastAt: i }))
  const pruned = pruneCap(items, 200)
  expect(pruned).toHaveLength(200)
  expect(pruned.filter(i => i.tag === 'Noticed').length).toBe(95)
})

test('a candidate that restates a Waiting on Sam line is dropped', async () => {
  const waiting = ['Browser access on this account', 'Web release timing']
  expect(isOwnersItem('Browser access on this account still not set up', waiting)).toBe(true)
  expect(isOwnersItem('Web release timing', waiting)).toBe(true)
  expect(isOwnersItem('Live test of the mic repair button', waiting)).toBe(false)
  const r = addCandidates(emptyStore(), [cand('Browser access on this account still not set up'), cand('Live test of the mic repair button')], { ...o, waiting })
  expect(r.added.map(i => i.text)).toEqual(['Live test of the mic repair button'])
})

test('a PR leaving the open list flags the item and does not clear it', async () => {
  const s = addCandidates(emptyStore(), [cand("Close #135 once the follow-up merges"), cand('Unrelated #999 follow-up note')], o).store
  const flagged = flagGonePrs(s, ['web#135'])
  expect(flagged.items[0]?.flag).toBe('#135 merged or closed')
  expect(flagged.items[0]?.status).toBe('open')
  expect(flagged.items[1]?.flag).toBeUndefined()
  expect(openItems(flagged)[0]?.id).toBe('U1')
})

test('tasks mirror the orchestrator list and drop on completion', async () => {
  let list = applyTaskCall([], { tool: 'TodoWrite', todos: [{ content: 'Wire the card', status: 'in_progress' }, { content: 'Ship it', status: 'completed' }] })
  expect(list.map(t => t.text)).toEqual(['Wire the card'])
  list = applyTaskCall(list, { tool: 'TaskCreate', subject: 'Review diff', id: '7' })
  list = applyTaskCall(list, { tool: 'TaskCreate', subject: 'Merge', id: '8' })
  expect(list).toHaveLength(3)
  list = applyTaskCall(list, { tool: 'TaskUpdate', taskId: '7', status: 'completed' })
  list = applyTaskCall(list, { tool: 'TaskUpdate', taskId: '8', status: 'deleted' })
  expect(list.map(t => t.text)).toEqual(['Wire the card'])
})

const fromAgent = (text: string, agentId: string, tag: Candidate['tag'] = 'Not done'): Candidate => ({ kind: 'report', tag, text, source: { label: 'web-builder', agentId }, confidence: 'high' })

test('one builder rewording a point between its interim and final reports is one item', async () => {
  let r = addCandidates(emptyStore(), [fromAgent('You need to give engineering.read to the role engineers hold. Until then only admins read policy entries.', 'a1')], o)
  r = addCandidates(r.store, [fromAgent('Someone with admin rights must give engineering.read to the role engineers hold. Until then only admins read the two engineers-only entries.', 'a1')], { ...o, now: 2_000_000, report: 'a1' })
  expect(r.added).toHaveLength(0)
  expect(r.store.items.filter(i => i.status === 'open')).toHaveLength(1)
  // the same words from a different builder, with no shared PR or file, stay separate
  const other = addCandidates(r.store, [fromAgent('Someone with admin rights must give engineering.read to the role engineers hold. Until then only admins read the two engineers-only entries.', 'a2')], { ...o, now: 3_000_000 })
  expect(other.added).toHaveLength(1)
})

test('a builder repeating a point already resolved does not reopen it; anyone else can', async () => {
  let s = addCandidates(emptyStore(), [fromAgent('The button seeds 20 of the 28 drafts. The 8 workshop-prep drafts are left out because their text names real clients, and they still come from the CLI script.', 'a1')], o).store
  s = resolveItem(s, 'U1', 'claude', 1_100_000)
  const again = addCandidates(s, [fromAgent('The seed button makes 20 of the 28 drafts. The 8 workshop-prep drafts are left out because their text names real clients, and they still come from scripts/brain/seed.ts.', 'a1')], { ...o, now: 1_200_000, report: 'a1' })
  expect(again.added).toHaveLength(0)
  const elsewhere = addCandidates(s, [cand('The button seeds 20 of the 28 drafts. The 8 workshop-prep drafts are left out because their text names real clients, and they still come from the CLI script.', 'orchestrator')], { ...o, now: 1_200_000 })
  expect(elsewhere.added).toHaveLength(1)
})

test('a later report from the same builder supersedes what it no longer names', async () => {
  let r = addCandidates(emptyStore(), [fromAgent('CI results pending', 'a1', "Couldn't run"), fromAgent('Pages not moved onto the commands', 'a1')], { ...o, report: 'a1' })
  // the orchestrator also said the second one, so it is not only the builder's to drop
  r = addCandidates(r.store, [cand('Pages not moved onto the commands', 'orchestrator', { kind: 'commit', tag: 'Said', confidence: 'medium' })], { ...o, now: 1_500_000 })
  r = addCandidates(r.store, [fromAgent('Live database tests', 'a1', "Couldn't run")], { ...o, now: 2_000_000, report: 'a1' })
  const byText = (t: string) => r.store.items.find(i => i.text === t)
  expect(byText('CI results pending')?.status).toBe('done')
  expect(byText('CI results pending')?.resolvedBy).toBe('auto')
  expect(byText('Pages not moved onto the commands')?.status).toBe('open')
  expect(byText('Live database tests')?.status).toBe('open')
  // a report with nothing under the headings replaces nothing
  const quiet = addCandidates(r.store, [], { ...o, now: 2_500_000, report: 'a1' })
  expect(quiet.store.items.find(i => i.text === 'Live database tests')?.status).toBe('open')
  // items from another builder are never touched
  const two = addCandidates(emptyStore(), [fromAgent('Theirs', 'a2')], o)
  const after = addCandidates(two.store, [fromAgent('Mine only', 'a1')], { ...o, now: 2_000_000, report: 'a1' })
  expect(after.store.items.find(i => i.text === 'Theirs')?.status).toBe('open')
})
