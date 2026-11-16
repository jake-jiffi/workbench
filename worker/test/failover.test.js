'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { world, sleep } = require('./helpers');

const workerCalls = w => w.calls('worker').sort((a, b) => a.run - b.run);
const epoch = s => Math.ceil(Date.now() / 1000) + s;
const OK = [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'result', text: 'recovered' }];

test('limit mid-run: the account cools until its stated reset and the session resumes on another account', async () => {
  const w = world();
  try {
    w.usage('alpha', { session: 5, week: 5 }); w.usage('beta', { session: 20, week: 20 }); w.usage('home', { session: 40, week: 40 });
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'working' }, { t: 'limit', resetsAt: epoch(600) }], 2: OK } });
    const r = w.start();
    assert.strictEqual(r.account, 'alpha');
    const s = await w.waitFor(r.id, s => s.state === 'done');
    assert.strictEqual(s.legs.length, 2);
    assert.strictEqual(s.legs[0].account, 'alpha');
    assert.strictEqual(s.legs[0].endReason, 'limit');
    assert.strictEqual(s.legs[1].account, 'beta');
    assert.strictEqual(s.account, 'beta');
    const calls = workerCalls(w);
    assert.strictEqual(calls[1].args[calls[1].args.indexOf('--resume') + 1], s.legs[0].sessionId);
    assert.ok(!calls[1].args.includes('--session-id'));
    assert.strictEqual(calls[1].env.CLAUDE_CONFIG_DIR, path.join(w.acct, 'beta'));
    assert.match(calls[1].prompt, /Check the working tree/);
    const cool = JSON.parse(fs.readFileSync(path.join(w.home, 'cooling', 'alpha.json'), 'utf8'));
    assert.strictEqual(cool.kind, 'limit');
    assert.ok(cool.until > Date.now() + 500_000);
    const acc = w.cw(['accounts', '--json']).json().find(a => a.account === 'alpha');
    assert.match(acc.reason, /cooling: limit until/);
    assert.deepStrictEqual(fs.readdirSync(path.join(w.home, 'slots', 'alpha')), []);
  } finally { await w.cleanup(); }
});

test('limit seen only as a rejected rate_limit_event while the process hangs: it is stopped and moved', async () => {
  const w = world();
  try {
    w.usage('alpha', { session: 5, week: 5 });
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'x' }, { t: 'ratelimit_event', resetsAt: epoch(600) }, { t: 'hang' }], 2: OK } });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done');
    assert.strictEqual(s.legs[0].endReason, 'limit');
    assert.notStrictEqual(s.legs[1].account, 'alpha');
  } finally { await w.cleanup(); }
});

test('limit text only in the stderr of a non-zero exit is still a limit', async () => {
  const w = world();
  try {
    w.usage('alpha', { session: 5, week: 5 });
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'x' }, { t: 'stderr', text: '5-hour limit reached ∙ resets 3pm\n' }, { t: 'exit', code: 1 }], 2: OK } });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done');
    assert.strictEqual(s.legs[0].endReason, 'limit');
    assert.notStrictEqual(s.legs[1].account, 'alpha');
  } finally { await w.cleanup(); }
});

test('prose that mentions a rate limit is not a limit', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'I added rate limit handling; the usage limit reached message is now friendly' }, { t: 'result', text: 'all good' }] });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done');
    assert.strictEqual(s.legs.length, 1);
  } finally { await w.cleanup(); }
});

test('auth error: the account is marked and the work moves', async () => {
  const w = world();
  try {
    w.usage('alpha', { session: 5, week: 5 });
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'x' }, { t: 'autherr' }], 2: OK } });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done');
    assert.strictEqual(s.legs[0].endReason, 'auth');
    assert.notStrictEqual(s.legs[1].account, 'alpha');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(w.home, 'cooling', 'alpha.json'), 'utf8')).kind, 'auth');
  } finally { await w.cleanup(); }
});

test('no reset stated: the account is held for the floor, then returns once a probe shows room; meanwhile the worker waits', async () => {
  const w = world({ CLAUDE_WORKER_COOL_FLOOR_MS: '1500', CLAUDE_WORKER_WAIT_PROBE_MS: '200' });
  try {
    w.usage('alpha', { session: 5, week: 5 }); w.usage('beta', { session: 99, week: 99 }); w.usage('home', { session: 99, week: 99 });
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'x' }, { t: 'limit' }], 2: OK } });
    const r = w.start();
    assert.strictEqual(r.account, 'alpha');
    const waiting = await w.waitFor(r.id, s => s.state === 'waiting' && s.legs.length === 1);
    assert.match(waiting.reason, /alpha: cooling/);
    const t0 = Date.now();
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs[1].account, 'alpha');
    assert.ok(s.legs[1].startedAt - s.legs[0].endedAt >= 1300, 'held for the floor');
    assert.ok(Date.now() - t0 < 15000);
  } finally { await w.cleanup(); }
});

test('stated reset in 2 seconds: the worker waits for it, then resumes on the same account', async () => {
  const w = world({ CLAUDE_WORKER_WAIT_PROBE_MS: '200' });
  try {
    w.usage('alpha', { session: 5, week: 5 }); w.usage('beta', { session: 99, week: 99 }); w.usage('home', { session: 99, week: 99 });
    const resetAt = epoch(3);
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'x' }, { t: 'limit', resetsAt: resetAt }], 2: OK } });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs[1].account, 'alpha');
    assert.ok(s.legs[1].startedAt >= resetAt * 1000 - 50, 'not before the reset');
  } finally { await w.cleanup(); }
});

test('every account at 90 or more: the worker queues as waiting, then runs when one resets', async () => {
  const w = world({ CLAUDE_WORKER_WAIT_PROBE_MS: '200' });
  try {
    w.usage('alpha', { session: 90, week: 10 }); w.usage('beta', { session: 10, week: 90 }); w.usage('home', { session: 100, week: 100 });
    const r = w.start();
    assert.strictEqual(r.account, null);
    assert.strictEqual(r.state, 'waiting');
    await sleep(1500);
    assert.strictEqual(w.state(r.id).state, 'waiting');
    assert.strictEqual(w.runs(), 0);
    w.usage('beta', { session: 10, week: 89 });
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.account, 'beta');
    assert.strictEqual(s.legs.length, 1);
  } finally { await w.cleanup(); }
});

test('no account for too long: failed, with the reason', async () => {
  const w = world({ CLAUDE_WORKER_WAIT_GIVE_UP_MS: '1500' });
  try {
    for (const a of ['alpha', 'beta', 'home']) w.usage(a, { session: 95, week: 95 });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'failed', 20000);
    assert.match(s.reason, /^no account: nothing eligible/);
    assert.strictEqual(s.onDisk.git, true);
    assert.strictEqual(w.runs(), 0);
  } finally { await w.cleanup(); }
});

// ---- hand-over at 94 ----
for (const [meter, other] of [['session', 'week'], ['week', 'session']]) {
  for (const [pct, moves] of [[93, false], [94, true]]) {
    test(`hand-over boundary on the ${meter} meter: ${pct}% ${moves ? 'moves the worker' : 'carries on'}`, async () => {
      const w = world();
      try {
        w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 2500 }, { t: 'result', text: 'one-leg' }], 2: OK } });
        const r = w.start(['--account', 'alpha']);
        await w.waitFor(r.id, s => s.state === 'running');
        w.usage('alpha', { [meter]: pct, [other]: 10 });
        if (moves) {
          const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
          assert.strictEqual(s.legs.length, 2);
          assert.strictEqual(s.legs[0].endReason, 'handover');
          assert.notStrictEqual(s.legs[1].account, 'alpha');
          assert.match(s.legs[1].why, /moved off alpha at 94%/);
        } else {
          const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
          assert.strictEqual(s.legs.length, 1);
          assert.strictEqual(s.result.text, 'one-leg');
          const rd = JSON.parse(fs.readFileSync(path.join(w.home, 'readings', 'alpha.json'), 'utf8'));
          assert.strictEqual(rd[meter].percent, pct, 'the worker really saw ' + pct);
        }
      } finally { await w.cleanup(); }
    });
  }
}

test('above 90 but below 94 a running worker carries on, and takes no new worker', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 2000 }, { t: 'result', text: 'stayed' }] } });
    const r = w.start(['--account', 'alpha']);
    await w.waitFor(r.id, s => s.state === 'running');
    w.usage('alpha', { session: 93, week: 10 });
    w.usage('beta', { session: 99, week: 99 }); w.usage('home', { session: 99, week: 99 });
    await sleep(800);
    const accs = w.cw(['accounts', '--json']).json();
    assert.strictEqual(accs.find(a => a.account === 'alpha').eligible, false);
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs.length, 1);
  } finally { await w.cleanup(); }
});

test('a tool in flight delays the 94% hand-over until its result arrives', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'tool_use', id: 't1' }, { t: 'sleep', ms: 2500 }, { t: 'tool_result', id: 't1' }, { t: 'sleep', ms: 5000 }, { t: 'result', text: 'late' }], 2: OK } });
    const r = w.start(['--account', 'alpha']);
    await w.waitFor(r.id, s => s.state === 'running');
    w.usage('alpha', { session: 97, week: 10 });
    await sleep(1500);
    const mid = w.state(r.id);
    const rd = JSON.parse(fs.readFileSync(path.join(w.home, 'readings', 'alpha.json'), 'utf8'));
    assert.ok(rd.session.percent >= 97, 'the reading is over the line');
    assert.strictEqual(mid.legs[0].endedAt, null, 'still running: a tool is in flight');
    assert.strictEqual(mid.legs.length, 1);
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs[0].endReason, 'handover');
    assert.ok(s.legs[0].endedAt - s.legs[0].startedAt >= 2300, 'moved only after the tool returned');
    assert.notStrictEqual(s.legs[1].account, 'alpha');
  } finally { await w.cleanup(); }
});

test('over the line but no other account has room: the worker carries on', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 2000 }, { t: 'result', text: 'nowhere' }] } });
    const r = w.start(['--account', 'alpha']);
    await w.waitFor(r.id, s => s.state === 'running');
    w.usage('alpha', { session: 96, week: 10 }); w.usage('beta', { session: 95, week: 10 }); w.usage('home', { session: 10, week: 95 });
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs.length, 1);
    assert.strictEqual(s.result.text, 'nowhere');
  } finally { await w.cleanup(); }
});

test('an unreadable account while running does not move the worker', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 1800 }, { t: 'result', text: 'steady' }] } });
    const r = w.start(['--account', 'alpha']);
    await w.waitFor(r.id, s => s.state === 'running');
    w.usage('alpha', { mode: 'garbage' });
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs.length, 1);
  } finally { await w.cleanup(); }
});

// ---- stall ----
test('stall: no output and no tool for the idle limit kills the group and resumes once', async () => {
  const w = world({ CLAUDE_WORKER_STALL_IDLE_MS: '800', CLAUDE_WORKER_STALL_TOOL_MS: '2500' });
  try {
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'child' }, { t: 'hang' }], 2: OK } });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs[0].endReason, 'stall');
    assert.strictEqual(s.legs.length, 2);
    for (const p of fs.readFileSync(path.join(w.fake, 'children.txt'), 'utf8').split('\n').filter(Boolean)) assert.throws(() => process.kill(Number(p), 0), 'stalled leg group killed');
  } finally { await w.cleanup(); }
});

test('stall twice: failed', async () => {
  const w = world({ CLAUDE_WORKER_STALL_IDLE_MS: '700' });
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'hang' }] });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'failed', 30000);
    assert.match(s.reason, /stalled twice/);
    assert.strictEqual(s.legs.length, 2);
  } finally { await w.cleanup(); }
});

test('a tool in flight is not a stall until the tool limit', async () => {
  const w = world({ CLAUDE_WORKER_STALL_IDLE_MS: '700', CLAUDE_WORKER_STALL_TOOL_MS: '2500' });
  try {
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'tool_use', id: 't' }, { t: 'sleep', ms: 1500 }, { t: 'tool_result', id: 't' }, { t: 'result', text: 'patient' }] } });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs.length, 1);
    // ...and a tool stuck past the limit is killed
    w.scenario({ runs: { 3: OK }, default: [{ t: 'init' }, { t: 'tool_use', id: 'stuck' }, { t: 'hang' }] });
    const r2 = w.start();
    const s2 = await w.waitFor(r2.id, s => s.state === 'done', 30000);
    assert.strictEqual(s2.legs[0].endReason, 'stall');
    assert.ok(s2.legs[0].endedAt - s2.legs[0].startedAt >= 2400);
  } finally { await w.cleanup(); }
});

test('limit failover chain: every account hit in turn, then the worker waits instead of failing', async () => {
  const w = world({ CLAUDE_WORKER_WAIT_PROBE_MS: '200' });
  try {
    const reset = epoch(3);
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'limit', resetsAt: reset }], 2: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'limit', resetsAt: reset }], 3: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'limit', resetsAt: reset }], 4: OK } });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done', 40000);
    assert.strictEqual(s.legs.length, 4);
    assert.strictEqual(new Set(s.legs.slice(0, 3).map(l => l.account)).size, 3, 'each leg on a different account');
    assert.ok(s.legs[3].startedAt >= reset * 1000 - 50);
  } finally { await w.cleanup(); }
});
