'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { world, sleep, alive } = require('./helpers');

const workerCalls = w => w.calls('worker').sort((a, b) => a.run - b.run);
const OK = [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'result', text: 'finished' }];
const LONG = [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 30000 }];
const runningWith = (w, id, nLegs = 1) => w.waitFor(id, s => s.state === 'running' && s.legs.length >= nLegs && s.legs[nLegs - 1].pid && s.supervisor && !s.legs[nLegs - 1].endedAt && s.legs[nLegs - 1].progress >= 0);
const fakePid = (w, run) => { const c = workerCalls(w).find(x => x.run === run); return c && c.pid; };

test('SIGKILL the supervisor mid-run: the child carries on, status adopts it, one leg, one process, one result', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 3000 }, { t: 'result', text: 'adopted' }] });
    const r = w.start();
    const s = await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    const sup = s.supervisor.pid, child = fakePid(w, 1);
    w.kill9(sup);
    await sleep(300);
    assert.ok(!alive(sup));
    assert.ok(alive(child), 'the worker outlived its supervisor');
    const st = w.cw(['status', r.id, '--json']).json()[0];
    assert.strictEqual(st.supervisorAlive, true, 'status started a new supervisor');
    const done = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(done.result.text, 'adopted');
    assert.strictEqual(done.legs.length, 1);
    assert.strictEqual(w.runs(), 1, 'no second process was started');
    assert.notStrictEqual(done.supervisor.pid, sup);
  } finally { await w.cleanup(); }
});

test('SIGKILL the supervisor and the child: recover resumes the conversation (supervisor lost is not a crash)', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: LONG, 2: OK } });
    const r = w.start();
    const s = await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    w.kill9(s.supervisor.pid); w.kill9(fakePid(w, 1));
    await sleep(300);
    const rec = w.cw(['recover', '--json']).json();
    assert.strictEqual(rec[r.id], 'respawned');
    const done = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(done.legs.length, 2);
    assert.strictEqual(done.legs[0].endReason, 'supervisor-lost');
    assert.strictEqual(done.crashStreak || 0, 0);
    const c = workerCalls(w)[1];
    assert.strictEqual(c.args[c.args.indexOf('--resume') + 1], done.legs[0].sessionId);
    assert.strictEqual(c.acct === 'home' ? 'home' : c.acct, workerCalls(w)[0].acct, 'resumed on the same account');
  } finally { await w.cleanup(); }
});

test('SIGKILL the child: retried on the same account, then on another; a result ends it', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: LONG, 2: LONG, 3: OK } });
    const r = w.start();
    await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    w.kill9(fakePid(w, 1));
    await runningWith(w, r.id, 2);
    await w.waitFor(r.id, () => fakePid(w, 2));
    w.kill9(fakePid(w, 2));
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs.length, 3);
    assert.deepStrictEqual(s.legs.slice(0, 2).map(l => l.endReason), ['crash', 'crash']);
    assert.strictEqual(s.legs[1].account, s.legs[0].account, 'first retry: same account');
    assert.notStrictEqual(s.legs[2].account, s.legs[1].account, 'second retry: another account');
    assert.match(s.legs[1].why, /same account/);
    assert.match(s.legs[2].why, /another account/);
    assert.match(s.legs[0].exit, /signal SIGKILL/);
  } finally { await w.cleanup(); }
});

test('two legs in a row that die without progress: failed with the reason', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'sleep', ms: 30000 }] });
    const r = w.start();
    await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    w.kill9(fakePid(w, 1));
    await runningWith(w, r.id, 2);
    await w.waitFor(r.id, () => fakePid(w, 2));
    w.kill9(fakePid(w, 2));
    const s = await w.waitFor(r.id, s => s.state === 'failed', 30000);
    assert.match(s.reason, /two legs in a row made no progress/);
    assert.strictEqual(s.legs.length, 2);
    assert.strictEqual(s.onDisk.git, true);
  } finally { await w.cleanup(); }
});

test('exit 0 with no result event is not success', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'I think I am done' }, { t: 'exit', code: 0 }], 2: OK } });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.legs[0].endReason, 'crash');
    assert.strictEqual(s.legs[0].exit, 'exit 0');
    assert.strictEqual(s.result.text, 'finished');
    assert.match(workerCalls(w)[1].prompt, /Check the working tree/);
  } finally { await w.cleanup(); }
});

test('a stream cut off mid-line every time: never success, five legs at most', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'raw', text: '{"type":"result","subtype":"succ' }, { t: 'exit', code: 0 }] });
    const r = w.start();
    const s = await w.waitFor(r.id, s => ['done', 'failed'].includes(s.state), 60000);
    assert.strictEqual(s.state, 'failed');
    assert.match(s.reason, /gave up after 5 legs/);
    assert.strictEqual(s.legs.length, 5);
    assert.strictEqual(w.runs(), 5);
    assert.ok(s.legs.every(l => l.endReason === 'crash'));
    assert.strictEqual(w.cw(['result', r.id]).code, 1);
  } finally { await w.cleanup(); }
});

test('a complete result line that only lacks its newline counts', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'raw', text: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'tail', session_id: 's' }) }, { t: 'exit', code: 0 }] });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(s.result.text, 'tail');
    assert.strictEqual(s.legs.length, 1);
  } finally { await w.cleanup(); }
});

test('the five-leg cap also holds across mixed failures (limits and crashes)', async () => {
  const w = world({ CLAUDE_WORKER_WAIT_PROBE_MS: '200', CLAUDE_WORKER_COOL_FLOOR_MS: '200' });
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'limit' }] });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'failed', 90000);
    assert.match(s.reason, /gave up after 5 legs/);
    assert.strictEqual(s.legs.length, 5);
  } finally { await w.cleanup(); }
});

test('corrupt state.json: the previous copy is used; a finished worker is not brought back to life', async () => {
  const w = world();
  try {
    const r = w.start();
    await w.waitFor(r.id, s => s.state === 'done');
    const f = path.join(w.home, 'w', r.id, 'state.json');
    fs.writeFileSync(f, '{"id": "' + r.id + '", "legs": [ trunc');
    const st = w.cw(['status', r.id, '--json']).json()[0];
    assert.strictEqual(st.state, 'done');
    assert.strictEqual(w.cw(['result', r.id]).stdout.trim(), 'ok');
    fs.writeFileSync(f + '.prev', 'garbage');
    assert.strictEqual(w.cw(['wait', r.id, '--json']).json().workers[0].state, 'done');
    await sleep(500);
    assert.strictEqual(w.runs(), 1, 'nothing was run again');
  } finally { await w.cleanup(); }
});

test('both state files destroyed mid-run: state is rebuilt from the leg files and the child is adopted', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 3000 }, { t: 'result', text: 'rebuilt-ok' }] });
    const r = w.start();
    const s = await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    w.kill9(s.supervisor.pid);
    const d = path.join(w.home, 'w', r.id);
    fs.writeFileSync(path.join(d, 'state.json'), '\u0000\u0000not json');
    fs.writeFileSync(path.join(d, 'state.json.prev'), '');
    w.cw(['recover']);
    const done = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(done.rebuilt, true);
    assert.strictEqual(done.result.text, 'rebuilt-ok');
    assert.strictEqual(w.runs(), 1);
  } finally { await w.cleanup(); }
});

test('worker folder with no readable spec or state: marked failed, nothing crashes', async () => {
  const w = world();
  try {
    const r = w.start();
    await w.waitFor(r.id, s => s.state === 'done');
    const d = path.join(w.home, 'w', r.id);
    for (const f of ['state.json', 'state.json.prev', 'spec.json', 'final.json']) fs.rmSync(path.join(d, f), { force: true });
    const rr = w.cw(['status', '--json']);
    assert.strictEqual(rr.code, 0, rr.stderr);
    assert.strictEqual(rr.json()[0].state, 'failed');
    assert.match(rr.json()[0].reason, /unreadable/);
    assert.strictEqual(w.cw(['recover']).code, 0);
  } finally { await w.cleanup(); }
});

test('SIGKILL a writer in the middle of a state write: the state stays readable (many tries)', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 6000 }, { t: 'result', text: 'x' }] });
    const r = w.start(['--account', 'alpha']);
    await runningWith(w, r.id);
    const stateMod = path.resolve(__dirname, '../lib/state');
    const { spawn } = require('child_process');
    for (let i = 0; i < 15; i++) {
      // A rogue writer hammers update() on the same worker, and is killed at a random moment.
      const script = `Object.assign(process.env, ${JSON.stringify(w.env)});const st=require(${JSON.stringify(stateMod)});for(;;){st.update(${JSON.stringify(r.id)},s=>{s.pad='z'.repeat(300000);});}`;
      const c = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
      await sleep(30 + Math.floor(Math.random() * 150));
      c.kill('SIGKILL');
      await new Promise(res => c.on('exit', res));
      const raw = fs.readFileSync(path.join(w.home, 'w', r.id, 'state.json'), 'utf8');
      assert.doesNotThrow(() => JSON.parse(raw), 'whole after kill ' + i);
    }
    // a killed writer may have held the lock: the next update steals it from the dead owner
    const s = await w.waitFor(r.id, s => s.state === 'done', 40000);
    assert.strictEqual(s.result.text, 'x');
  } finally { await w.cleanup(); }
});

test('pid reuse: a supervisor record with a live pid but the wrong start time counts as dead', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: LONG, 2: OK } });
    const r = w.start();
    const s = await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    w.kill9(s.supervisor.pid); w.kill9(fakePid(w, 1));
    const stranger = w.sleeper();
    const f = path.join(w.home, 'w', r.id, 'state.json');
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    cur.supervisor = { pid: stranger, start: 'Mon Jan  1 00:00:00 2001', heartbeat: Date.now() };
    fs.writeFileSync(f, JSON.stringify(cur));
    assert.strictEqual(w.cw(['recover', '--json']).json()[r.id], 'respawned');
    const done = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(done.result.text, 'finished');
    assert.ok(alive(stranger), 'the stranger was left alone');
  } finally { await w.cleanup(); }
});

test('pid reuse: a leg pid that now belongs to a stranger is never killed by stop, and is not mistaken for the worker', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: LONG, 2: LONG } });
    const r = w.start();
    const s = await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    w.kill9(s.supervisor.pid); w.kill9(fakePid(w, 1));
    const stranger = w.sleeper();
    const f = path.join(w.home, 'w', r.id, 'state.json');
    const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
    cur.legs[0].pid = stranger; cur.legs[0].start = 'Mon Jan  1 00:00:00 2001';
    cur.supervisor = null;
    fs.writeFileSync(f, JSON.stringify(cur));
    const st = w.cw(['stop', r.id, '--json']).json();
    assert.strictEqual(st.state, 'stopped');
    assert.ok(alive(stranger), 'the stranger survived stop');
  } finally { await w.cleanup(); }
});

test('pid reuse: a slot whose owner pid is alive but with a different start time is swept', async () => {
  const w = world();
  try {
    const stranger = w.sleeper();
    fs.mkdirSync(path.join(w.home, 'slots', 'alpha'), { recursive: true });
    for (const n of ['w-aaaaaa', 'w-bbbbbb', 'w-cccccc', 'w-dddddd']) fs.writeFileSync(path.join(w.home, 'slots', 'alpha', n), JSON.stringify({ id: n, account: 'alpha', pid: stranger, start: 'Mon Jan  1 00:00:00 2001', at: Date.now() }));
    const a = w.cw(['accounts', '--json']).json().find(x => x.account === 'alpha');
    assert.strictEqual(a.slots, 0);
    assert.strictEqual(a.eligible, true);
  } finally { await w.cleanup(); }
});

test('slots: dead owners and abandoned claims are cleared, a fresh claim and a live owner count', async () => {
  const w = world({ CLAUDE_WORKER_SLOT_CLAIM_MS: '5000' });
  try {
    const dir = path.join(w.home, 'slots', 'alpha');
    fs.mkdirSync(dir, { recursive: true });
    const { pidStart } = require('../lib/proc');
    const live = w.sleeper();
    const write = (n, o) => fs.writeFileSync(path.join(dir, n), JSON.stringify({ id: n, account: 'alpha', ...o }));
    write('w-000001', { pid: 999999, start: 'x', at: Date.now() }); // dead
    write('w-000002', { at: Date.now() - 60_000 }); // claim never taken up
    write('w-000003', { at: Date.now() }); // fresh claim
    write('w-000004', { pid: live, start: pidStart(live), at: Date.now() }); // live
    fs.writeFileSync(path.join(dir, 'w-000005'), 'garbage'); // corrupt
    const a = w.cw(['accounts', '--json']).json().find(x => x.account === 'alpha');
    assert.strictEqual(a.slots, 2);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['w-000003', 'w-000004']);
  } finally { await w.cleanup(); }
});

test('wait with a dead supervisor does not hang: it recovers the worker and reports the outcome', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 2500 }, { t: 'result', text: 'after-wait' }] });
    const r = w.start();
    const s = await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    w.kill9(s.supervisor.pid);
    const t0 = Date.now();
    const waited = await w.cwAsync(['wait', r.id, '--json']);
    assert.strictEqual(waited.code, 0, waited.stderr);
    assert.strictEqual(waited.json().workers[0].state, 'done');
    assert.ok(Date.now() - t0 < 25000);
    assert.strictEqual(w.runs(), 1);
  } finally { await w.cleanup(); }
});

test('wait notices a supervisor that dies after wait began', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: LONG, 2: OK } });
    const r = w.start();
    const s = await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    const waiting = w.cwAsync(['wait', r.id, '--json']);
    await sleep(600);
    w.kill9(s.supervisor.pid); w.kill9(fakePid(w, 1));
    const out = await waiting;
    assert.strictEqual(out.code, 0, out.stderr);
    assert.strictEqual(out.json().workers[0].state, 'done');
  } finally { await w.cleanup(); }
});

test('two recovers at once do not resume the same worker twice', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: LONG, 2: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 1500 }, { t: 'result', text: 'once' }] } });
    const r = w.start();
    const s = await runningWith(w, r.id);
    await w.waitFor(r.id, () => fakePid(w, 1));
    w.kill9(s.supervisor.pid); w.kill9(fakePid(w, 1));
    await sleep(300);
    const outs = await Promise.all([
      w.cwAsync(['recover', '--json']), w.cwAsync(['recover', '--json']), w.cwAsync(['recover', '--json']), w.cwAsync(['recover', '--json']),
      w.cwAsync(['status', '--json']), w.cwAsync(['wait', r.id, '--timeout', '30']),
    ]);
    for (const o of outs) assert.ok([0, 1].includes(o.code), o.stderr);
    const done = await w.waitFor(r.id, s => s.state === 'done', 30000);
    await sleep(800);
    assert.strictEqual(w.runs(), 2, 'one original run, one resume');
    assert.strictEqual(done.legs.length, 2);
    assert.strictEqual(workerCalls(w).length, 2);
    const respawns = outs.slice(0, 4).map(o => o.json()[r.id]).filter(v => v === 'respawned').length;
    assert.ok(respawns <= 1, 'at most one recover started a supervisor (status or wait may have been first)');
    assert.strictEqual(done.recoveries, 1, 'the worker was revived exactly once');
  } finally { await w.cleanup(); }
});

test('a duplicate supervisor steps aside: two supervisors on one worker cannot both run it', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 2500 }, { t: 'result', text: 'solo' }] });
    const r = w.start();
    const s = await runningWith(w, r.id);
    // Start a second supervisor by hand while the first is alive.
    const { spawn } = require('child_process');
    const cli = path.resolve(__dirname, '../cli.js');
    const c = spawn(process.execPath, [cli, '__supervise', r.id], { env: w.env, stdio: 'ignore' });
    const code = await new Promise(res => c.on('exit', res));
    assert.strictEqual(code, 0);
    const done = await w.waitFor(r.id, s => s.state === 'done', 30000);
    assert.strictEqual(done.legs.length, 1);
    assert.strictEqual(w.runs(), 1);
    assert.strictEqual(done.supervisor.pid, s.supervisor.pid);
  } finally { await w.cleanup(); }
});
