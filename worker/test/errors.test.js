'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { world } = require('./helpers');

const L = n => require('../lib/' + n);
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'real-limit.jsonl'), 'utf8');
const OK = [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'result', text: 'recovered' }];
const workerCalls = w => w.calls('worker').sort((a, b) => a.run - b.run);
const track = text => { const t = new (L('stream').StreamTracker)(); t.feed(text); t.finish(); return t; };
const result = o => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, session_id: 's', ...o }) + '\n';

test('the real limit sequence: one limit, the reset from the rate_limit_event, no success', () => {
  const t = track(FIXTURE);
  assert.strictEqual(t.succeeded, false);
  const limits = t.errors.filter(e => e.kind === 'limit');
  assert.ok(limits.length >= 2, 'seen in the event and again in the result');
  assert.strictEqual(limits[0].resetAt, 1794808800 * 1000);
  assert.ok(t.errors.every(e => e.kind === 'limit'));
  assert.strictEqual(t.sessionId, '0b1f3c1e-6c63-4e55-9a39-1d2f0f7a9a10');
});

test('the real limit sequence, result alone: api_error_status 429 and usage_limit_reached decide it', () => {
  const t = track(result({ api_error_status: 429, api_error: 'usage_limit_reached', result: 'whatever the text says' }));
  assert.strictEqual(t.errors[0].kind, 'limit');
});

test('structured fields beat the text: a 400 whose text says "weekly limit" is not an account problem', () => {
  assert.strictEqual(track(result({ api_error_status: 400, api_error: 'invalid_request_error', result: "You've hit your weekly limit" })).errors.length, 0);
  assert.strictEqual(track(result({ api_error_status: 529, api_error: 'overloaded_error', result: 'rate limit 429 usage limit' })).errors[0].kind, 'transient');
  assert.strictEqual(track(result({ api_error_status: 401, result: 'x' })).errors[0].kind, 'auth');
  assert.strictEqual(track(result({ api_error: 'authentication_error', result: 'x' })).errors[0].kind, 'auth');
});

test('text is only a fallback, and a bare number is never enough', () => {
  const { classifyText } = L('classify');
  for (const prose of ['I fixed the 401 handling and the 429 retry', 'HTTP codes 401 and 429 are covered by the tests', 'upgraded to node 24.401.1', 'processed 500 rows', 'there were 529 items']) {
    assert.strictEqual(classifyText(prose), null, prose);
    assert.strictEqual(track(result({ result: prose })).errors.length, 0, 'in a failed result: ' + prose);
  }
  assert.strictEqual(classifyText('API Error: 401 {"type":"error"}'), 'auth');
  assert.strictEqual(classifyText('API Error: 429 Too Many Requests'), 'limit');
  assert.strictEqual(classifyText('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'), 'transient');
  assert.strictEqual(classifyText('API Error: 503 Service Unavailable'), 'transient');
  assert.strictEqual(classifyText('Request timed out'), 'transient');
  assert.strictEqual(classifyText('connect ETIMEDOUT 1.2.3.4:443'), 'transient');
  assert.strictEqual(classifyText("You've hit your weekly limit"), 'limit');
  assert.strictEqual(classifyText('Invalid API key · Please run /login'), 'auth');
});

test('a non-error result that mentions all of it is not classified at all', () => {
  const t = track(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Added 401, 429 and 529 handling; API Error: 401 is now friendly; usage limit reached text', session_id: 's' }) + '\n');
  assert.strictEqual(t.errors.length, 0);
  assert.strictEqual(t.succeeded, true);
});

test('the real limit sequence end to end: the account cools until the stated reset and the work moves', async () => {
  const w = world();
  try {
    const reset = Math.ceil(Date.now() / 1000) + 600;
    const lines = FIXTURE.trim().split('\n').map(l => JSON.parse(l)).slice(1).map(e => (e.type === 'rate_limit_event' ? { ...e, rate_limit_info: { ...e.rate_limit_info, resetsAt: reset } } : e));
    w.usage('alpha', { session: 5, week: 5 });
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'lines', lines }, { t: 'exit', code: 1 }], 2: OK } });
    const r = w.start();
    assert.strictEqual(r.account, 'alpha');
    const s = await w.waitFor(r.id, s => s.state === 'done');
    assert.strictEqual(s.legs[0].endReason, 'limit');
    assert.notStrictEqual(s.legs[1].account, 'alpha');
    const cool = JSON.parse(fs.readFileSync(path.join(w.home, 'cooling', 'alpha.json'), 'utf8'));
    assert.strictEqual(cool.until, reset * 1000);
  } finally { await w.cleanup(); }
});

test('a worker that merely mentions 401 and 429 in a failed result does not cool its account', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'apierr', text: 'I could not finish: the 401 and 429 tests still fail' }] });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'failed');
    assert.match(s.reason, /worker reported an error/);
    assert.strictEqual(s.legs.length, 1);
    assert.ok(!fs.existsSync(path.join(w.home, 'cooling')) || fs.readdirSync(path.join(w.home, 'cooling')).length === 0);
  } finally { await w.cleanup(); }
});

test('transient API errors (529, 500, timeout): backoff, same account once, then another; no cooling', async () => {
  const w = world({ CLAUDE_WORKER_TRANSIENT_BACKOFF_MS: '400' });
  try {
    w.usage('alpha', { session: 5, week: 5 });
    w.scenario({ runs: {
      1: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'apierr', status: 529, error: 'overloaded_error', text: 'Overloaded' }],
      2: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'apierr', text: 'API Error: 500 Internal server error' }],
      3: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'stderr', text: 'Request timed out\n' }, { t: 'exit', code: 1 }],
      4: OK } });
    const r = w.start();
    const t0 = Date.now();
    const s = await w.waitFor(r.id, s => s.state === 'done', 40000);
    assert.strictEqual(s.legs.length, 4);
    assert.deepStrictEqual(s.legs.slice(0, 3).map(l => l.endReason), ['transient', 'transient', 'transient']);
    assert.strictEqual(s.legs[1].account, s.legs[0].account, 'first retry: same account');
    assert.notStrictEqual(s.legs[2].account, s.legs[1].account, 'second retry: another account');
    assert.ok(s.legs[1].startedAt - s.legs[0].endedAt >= 350, 'backed off');
    assert.ok(s.legs[2].startedAt - s.legs[1].endedAt >= 700, 'backoff doubles');
    assert.ok(!fs.existsSync(path.join(w.home, 'cooling')) || fs.readdirSync(path.join(w.home, 'cooling')).length === 0, 'no account was cooled');
    assert.ok(Date.now() - t0 < 30000);
  } finally { await w.cleanup(); }
});

test('transient errors still respect the five-leg cap', async () => {
  const w = world({ CLAUDE_WORKER_TRANSIENT_BACKOFF_MS: '50' });
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'apierr', status: 503, error: 'api_error', text: 'Service Unavailable' }] });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'failed', 60000);
    assert.match(s.reason, /gave up after 5 legs/);
    assert.strictEqual(s.legs.length, 5);
  } finally { await w.cleanup(); }
});

test('child PATH: the running node first, per-shell fnm folders dropped, system folders present', () => {
  const A = L('accounts');
  const nd = A.nodeDir();
  assert.strictEqual(nd, path.dirname(fs.realpathSync(process.execPath)));
  const p = A.childPath('/Users/x/.local/state/fnm_multishells/123_456/bin:/opt/homebrew/bin:/custom/bin').split(':');
  assert.strictEqual(p[0], nd, "node's own folder is first");
  assert.ok(!p.some(x => x.includes('fnm_multishells')));
  assert.ok(p.includes('/custom/bin'));
  for (const d of ['/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/sbin', '/opt/homebrew/bin']) assert.ok(p.includes(d));
  assert.strictEqual(new Set(p).size, p.length, 'no duplicates');
  // the child's `node` is the running node
  const v = require('child_process').spawnSync('node', ['-v'], { env: { PATH: A.childPath('') }, encoding: 'utf8' }).stdout.trim();
  assert.strictEqual(v, process.version);
  // an empty or hostile parent PATH still yields the system folders
  assert.ok(A.childPath('').split(':').includes('/usr/bin'));
  assert.ok(A.childPath(':::').split(':').every(Boolean));
});

test('child PATH has no hard-coded node folder', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'accounts.js'), 'utf8');
  assert.ok(!/node@\d/.test(src));
});

test('the worker really gets that PATH', async () => {
  const w = world();
  try {
    const r = w.start();
    await w.waitFor(r.id, s => s.state === 'done');
    const p = workerCalls(w)[0].env.PATH.split(':');
    assert.ok(!p.some(x => x.includes('fnm_multishells')));
    assert.strictEqual(p[0], L('accounts').nodeDir());
  } finally { await w.cleanup(); }
});
