'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { world, sleep } = require('./helpers');

const startAsync = (w, extra = []) => w.cwAsync(['start', '--worktree', w.wt, '--brief', w.brief, '--json', ...extra]);
const slotCounts = w => {
  const out = {};
  let accts = []; try { accts = fs.readdirSync(path.join(w.home, 'slots')); } catch { /* none */ }
  for (const a of accts) out[a] = fs.readdirSync(path.join(w.home, 'slots', a)).length;
  return out;
};

test('25 concurrent starts against 2 slots per account: exactly 6 get one, the other 19 queue, no account over its cap', async () => {
  const w = world({ CLAUDE_WORKER_PER_ACCOUNT: '2' });
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'hang' }] });
    const outs = await Promise.all(Array.from({ length: 25 }, () => startAsync(w)));
    for (const o of outs) assert.strictEqual(o.code, 0, o.stderr);
    const rs = outs.map(o => o.json());
    assert.strictEqual(new Set(rs.map(r => r.id)).size, 25);
    const placed = rs.filter(r => r.account);
    assert.strictEqual(placed.length, 6);
    const per = {};
    for (const r of placed) per[r.account] = (per[r.account] || 0) + 1;
    assert.deepStrictEqual(Object.values(per).sort(), [2, 2, 2]);
    // Let everything settle: still capped.
    await sleep(2500);
    const running = Object.values(slotCounts(w));
    assert.ok(running.every(n => n <= 2), JSON.stringify(slotCounts(w)));
    assert.strictEqual(running.reduce((a, b) => a + b, 0), 6);
    assert.strictEqual(w.runs(), 6, 'only six processes were started');
    // Free one slot: exactly one queued worker takes it.
    const victim = placed[0];
    w.cw(['stop', victim.id]);
    await w.waitFor(victim.id, () => w.runs() >= 7, 20000);
    await sleep(1500);
    assert.strictEqual(w.runs(), 7);
    assert.ok(Object.values(slotCounts(w)).every(n => n <= 2));
  } finally { await w.cleanup(); }
});

test('the fleet cap holds across accounts', async () => {
  const w = world({ CLAUDE_WORKER_PER_ACCOUNT: '4', CLAUDE_WORKER_MAX_TOTAL: '5' });
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'hang' }] });
    const outs = await Promise.all(Array.from({ length: 12 }, () => startAsync(w)));
    const placed = outs.map(o => o.json()).filter(r => r.account);
    assert.strictEqual(placed.length, 5);
    await sleep(1500);
    assert.strictEqual(w.runs(), 5);
  } finally { await w.cleanup(); }
});

test('10 concurrent starts when only one account is eligible and it has one slot: one wins', async () => {
  const w = world({ CLAUDE_WORKER_PER_ACCOUNT: '1' });
  try {
    w.usage('beta', { session: 95, week: 10 }); w.usage('home', { session: 10, week: 95 });
    w.scenario({ default: [{ t: 'init' }, { t: 'hang' }] });
    const outs = await Promise.all(Array.from({ length: 10 }, () => startAsync(w)));
    const placed = outs.map(o => o.json()).filter(r => r.account);
    assert.strictEqual(placed.length, 1);
    assert.strictEqual(placed[0].account, 'alpha');
  } finally { await w.cleanup(); }
});

test('a pinned account that is full is refused, not queued', async () => {
  const w = world({ CLAUDE_WORKER_PER_ACCOUNT: '1' });
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'hang' }] });
    w.start(['--account', 'alpha']);
    const second = w.cw(['start', '--worktree', w.wt, '--brief', w.brief, '--account', 'alpha']);
    assert.strictEqual(second.code, 2);
    assert.match(second.stderr, /1 of 1 slots used/);
    assert.strictEqual(w.cw(['status', '--json']).json().length, 1, 'the refused start left nothing behind');
  } finally { await w.cleanup(); }
});
