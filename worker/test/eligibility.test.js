'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { world, sleep } = require('./helpers');

const rows = w => Object.fromEntries(w.cw(['accounts', '--json']).json().map(r => [r.account, r]));

for (const [meter, other] of [['session', 'week'], ['week', 'session']]) {
  test(`eligibility boundary on the ${meter} meter: 89 takes a worker, 90 does not`, async () => {
    const w = world();
    try {
      w.usage('alpha', { [meter]: 89, [other]: 10 });
      assert.strictEqual(rows(w).alpha.eligible, true);
      w.usage('alpha', { [meter]: 90, [other]: 10 });
      fs.rmSync(path.join(w.home, 'readings'), { recursive: true, force: true });
      const r = rows(w).alpha;
      assert.strictEqual(r.eligible, false);
      assert.match(r.reason, meter === 'session' ? /5-hour at 90%/ : /weekly at 90%/);
      // and start refuses the pinned account without --force, accepts it with --force
      const bad = w.cw(['start', '--worktree', w.wt, '--brief', w.brief, '--account', 'alpha']);
      assert.strictEqual(bad.code, 2);
      assert.match(bad.stderr, /cannot take a worker/);
      const forced = w.start(['--account', 'alpha', '--force']);
      assert.strictEqual(forced.account, 'alpha');
    } finally { await w.cleanup(); }
  });
}

test('both meters at 100 and one at 89: the high one decides', async () => {
  const w = world();
  try {
    w.usage('alpha', { session: 89, week: 100 });
    w.usage('beta', { session: 100, week: 89 });
    const r = rows(w);
    assert.strictEqual(r.alpha.eligible, false);
    assert.strictEqual(r.beta.eligible, false);
  } finally { await w.cleanup(); }
});

test('a missing week line is unreadable and never has room, even with a low session line', async () => {
  const w = world();
  try {
    w.usage('alpha', { session: 1, week: null });
    const r = rows(w).alpha;
    assert.strictEqual(r.eligible, false);
    assert.match(r.reason, /unreadable/);
  } finally { await w.cleanup(); }
});

test('probe failing, returning garbage, signed out and hanging: each account is ineligible with a reason; the others still work', async () => {
  const w = world();
  try {
    w.usage('alpha', { mode: 'fail' });
    w.usage('beta', { mode: 'garbage' });
    w.usage('home', { mode: 'signedout' });
    let r = rows(w);
    assert.match(r.alpha.reason, /unreadable/);
    assert.match(r.beta.reason, /unreadable/);
    assert.match(r.gamma.reason, /not signed in/);
    assert.ok(Object.values(r).every(x => !x.eligible));
    w.usage('beta', { mode: 'hang' });
    fs.rmSync(path.join(w.home, 'readings'), { recursive: true, force: true });
    const t0 = Date.now();
    r = rows(w);
    assert.ok(Date.now() - t0 < 12_000, 'a hanging probe is cut off at the timeout');
    assert.match(r.beta.reason, /unreadable \(timeout\)/);
    w.usage('beta', { session: 10, week: 10 });
    await sleep(100);
    fs.rmSync(path.join(w.home, 'readings', 'beta.json'));
    assert.strictEqual(rows(w).beta.eligible, true);
  } finally { await w.cleanup(); }
});

test('a hung probe is killed, not left running', async () => {
  const w = world({ CLAUDE_WORKER_PROBE_TIMEOUT_MS: '700' });
  try {
    w.usage('alpha', { mode: 'hang' });
    rows(w);
    const hung = w.calls('usage').filter(c => c.acct === 'alpha');
    assert.ok(hung.length >= 1);
    await sleep(300);
    for (const c of hung) assert.throws(() => process.kill(c.pid, 0), 'hung probe process is gone');
  } finally { await w.cleanup(); }
});

test('a failed probe is not retried for every caller: it is remembered for the negative window', async () => {
  const w = world({ CLAUDE_WORKER_PROBE_NEGATIVE_MS: '60000' });
  try {
    w.usage('alpha', { mode: 'fail' });
    rows(w); rows(w); rows(w);
    assert.strictEqual(w.calls('usage').filter(c => c.acct === 'alpha').length, 1);
  } finally { await w.cleanup(); }
});

test('stale reading: a reading older than 5 minutes is probed again; one just inside is trusted', async () => {
  const w = world();
  try {
    rows(w); // seeds readings at 10%
    const f = path.join(w.home, 'readings', 'alpha.json');
    const r0 = JSON.parse(fs.readFileSync(f, 'utf8'));
    const before = () => w.calls('usage').filter(c => c.acct === 'alpha').length;
    // The truth moves to 95%, but the cached reading says 10% and is 4m50s old: trusted.
    w.usage('alpha', { session: 95, week: 10 });
    fs.writeFileSync(f, JSON.stringify({ ...r0, at: Date.now() - 290_000 }));
    const n0 = before();
    assert.strictEqual(rows(w).alpha.eligible, true);
    assert.strictEqual(before(), n0);
    // 5m10s old: probed again, and now the 95% shows.
    fs.writeFileSync(f, JSON.stringify({ ...r0, at: Date.now() - 310_000 }));
    const r = rows(w).alpha;
    assert.strictEqual(before(), n0 + 1);
    assert.strictEqual(r.eligible, false);
    assert.strictEqual(r.session, 95);
  } finally { await w.cleanup(); }
});

test('a reading dated in the future (clock moved) is not trusted', async () => {
  const w = world();
  try {
    rows(w);
    const f = path.join(w.home, 'readings', 'alpha.json');
    const r0 = JSON.parse(fs.readFileSync(f, 'utf8'));
    w.usage('alpha', { session: 95, week: 10 });
    fs.writeFileSync(f, JSON.stringify({ ...r0, at: Date.now() + 3600_000 }));
    assert.strictEqual(rows(w).alpha.eligible, false);
  } finally { await w.cleanup(); }
});

test('probes: one at a time per account, 12 concurrent callers cause one probe', async () => {
  const w = world({ });
  try {
    w.usage('alpha', { session: 10, week: 10, delay: 700 });
    const { spawn } = require('child_process');
    const { CLI } = require('./helpers');
    await Promise.all(Array.from({ length: 12 }, () => new Promise(res => {
      const c = spawn(process.execPath, [CLI, 'accounts', '--json'], { env: w.env, stdio: 'ignore' });
      c.on('exit', res);
    })));
    assert.strictEqual(w.calls('usage').filter(c => c.acct === 'alpha').length, 1);
  } finally { await w.cleanup(); }
});

test('the most headroom wins; the calling session account is last when another is eligible', async () => {
  const w = world();
  try {
    w.usage('alpha', { session: 5, week: 10 }); // headroom 90
    w.usage('beta', { session: 20, week: 30 }); // 70
    w.usage('home', { session: 60, week: 10 }); // 40
    assert.strictEqual(w.start().account, 'alpha');
    // Calling session is on alpha: pick beta even though alpha has more room.
    const callerEnv = { CLAUDE_CONFIG_DIR: path.join(w.acct, 'alpha') };
    assert.strictEqual(w.start([], callerEnv).account, 'beta');
    // Only alpha eligible: the caller's account is still used.
    w.usage('beta', { session: 95, week: 10 }); w.usage('home', { session: 95, week: 10 });
    fs.rmSync(path.join(w.home, 'readings'), { recursive: true, force: true });
    assert.strictEqual(w.start([], callerEnv).account, 'alpha');
  } finally { await w.cleanup(); }
});

test('the home account running the caller is also recognised when the folder variable is unset in a session', async () => {
  const w = world();
  try {
    w.usage('alpha', { session: 50, week: 50 });
    w.usage('beta', { session: 50, week: 50 });
    w.usage('home', { session: 5, week: 5 });
    assert.strictEqual(w.start().account, 'gamma');
    assert.strictEqual(w.start([], { CLAUDECODE: '1' }).account, 'alpha');
  } finally { await w.cleanup(); }
});
