'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { sleep } = require('./helpers');

const L = n => require('../lib/' + n);

// ---- usage parsing (fixtures copy the real output shape) ----
const REAL_TEAM = `You are currently using your subscription to power your Claude Code usage

Current session: 20% used · resets Nov 9 at 8:50pm (Australia/Sydney)
Current week (all models): 100% used · resets Nov 10 at 9am (Australia/Sydney)
Current week (Fable): 0% used · resets Nov 10 at 9am (Australia/Sydney)

What's contributing to your limits usage?
  100%  Give "x-builder" subagents a cheaper model
`;
const REAL_NO_SESSION = `You are currently using your subscription to power your Claude Code usage

Current week (all models): 7% used · resets Nov 16 at 4:59pm (Australia/Sydney)
Current week (Fable): 0% used · resets Nov 16 at 5pm (Australia/Sydney)
`;

test('parseUsage reads both meters from the real output shape', () => {
  const r = L('usage').parseUsage(REAL_TEAM);
  assert.strictEqual(r.session.percent, 20);
  assert.strictEqual(r.week.percent, 100);
  assert.match(r.week.resets, /Nov 10 at 9am/);
});

test('parseUsage: a week line with no session line means no 5-hour window is open (0, flagged)', () => {
  const r = L('usage').parseUsage(REAL_NO_SESSION);
  assert.strictEqual(r.session.percent, 0);
  assert.strictEqual(r.session.assumed, true);
  assert.strictEqual(r.week.percent, 7);
});

test('parseUsage: the Fable line is not mistaken for the weekly meter', () => {
  const r = L('usage').parseUsage('Current week (Fable): 99% used · resets Nov 10\nCurrent week (all models): 3% used\n');
  assert.strictEqual(r.week.percent, 3);
});

test('parseUsage: garbage, empty, sign-in text and no week line are all errors, never room', () => {
  const u = L('usage');
  assert.strictEqual(u.parseUsage('').error, 'unreadable');
  assert.strictEqual(u.parseUsage('\u0000 hello 12 widgets').error, 'unreadable');
  assert.strictEqual(u.parseUsage('Not logged in. Please run /login').error, 'authentication_failed');
  assert.strictEqual(u.parseUsage('Current session: 5% used\n').error, 'unreadable');
  assert.strictEqual(u.parseUsage('Current session: 5% used\n').week, undefined);
});

test('parseUsage clamps above 100 and rounds a fraction up (89.6 reads as 90, never as room)', () => {
  assert.strictEqual(L('usage').parseUsage('Current week (all models): 140% used\n').week.percent, 100);
  assert.strictEqual(L('usage').parseUsage('Current week (all models): 89.6% used\n').week.percent, 90);
  assert.strictEqual(L('usage').parseUsage('Current week (all models): 89% used\n').week.percent, 89);
});

// ---- stream tracker ----
test('stream: tools in flight come and go; subagent results settle too', () => {
  const { StreamTracker } = L('stream');
  const t = new StreamTracker();
  t.feed(JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash' }, { type: 'tool_use', id: 'b', name: 'Read' }] } }) + '\n');
  assert.strictEqual(t.inFlight, 2);
  t.feed(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }) + '\n');
  assert.strictEqual(t.inFlight, 1);
  assert.strictEqual(t.sessionId, 's1');
});

test('stream: a line cut mid-way is held; whole JSON without a newline is accepted only at finish()', () => {
  const { StreamTracker } = L('stream');
  const full = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' });
  const a = new StreamTracker();
  a.feed(full.slice(0, 30));
  a.finish();
  assert.strictEqual(a.result, null);
  assert.strictEqual(a.succeeded, false);
  const b = new StreamTracker();
  b.feed(full);
  assert.strictEqual(b.result, null);
  b.finish();
  assert.strictEqual(b.succeeded, true);
});

test('stream: errors are read from structured fields, not from prose that mentions a limit', () => {
  const { StreamTracker } = L('stream');
  const t = new StreamTracker();
  t.feed(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will add rate limit handling and a usage limit message' }] } }) + '\n');
  assert.strictEqual(t.errors.length, 0);
  t.feed(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', overageStatus: 'rejected' } }) + '\n');
  assert.strictEqual(t.errors.length, 0);
  t.feed(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1794808800 } }) + '\n');
  assert.strictEqual(t.errors[0].kind, 'limit');
  assert.strictEqual(t.errors[0].resetAt, 1794808800000);
});

test('stream: success needs a success result event with text; an error result is not success', () => {
  const { StreamTracker } = L('stream');
  const t = new StreamTracker();
  t.feed(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1794808800' }) + '\n');
  assert.strictEqual(t.succeeded, false);
  assert.strictEqual(t.errors[0].kind, 'limit');
  assert.strictEqual(t.errors[0].resetAt, 1794808800000);
});

test('classify: auth beats limit text; overload is transient, not a limit', () => {
  const { classifyText } = L('classify');
  assert.strictEqual(classifyText('Invalid API key · Please run /login'), 'auth');
  assert.strictEqual(classifyText('5-hour limit reached ∙ resets 3pm'), 'limit');
  assert.strictEqual(classifyText('API Error: 529 overloaded'), 'transient');
  assert.strictEqual(classifyText(''), null);
});

// ---- files ----
test('atomicWrite: SIGKILL a writer at random moments, 40 times; the file is always whole', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-atomic-'));
  const f = path.join(dir, 'state.json');
  fs.writeFileSync(f, JSON.stringify({ n: -1, pad: 'x' }));
  const script = `const {atomicWrite}=require(${JSON.stringify(path.resolve(__dirname, '../lib/fsx'))});
    const big='y'.repeat(2_000_000);
    for(let i=0;;i++){ atomicWrite(${JSON.stringify(f)}, JSON.stringify({n:i,pad:big}), {keepPrev:true}); }`;
  try {
    for (let i = 0; i < 40; i++) {
      const c = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
      await sleep(20 + Math.floor(Math.random() * 120));
      c.kill('SIGKILL');
      await new Promise(r => c.on('exit', r));
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.ok(Number.isInteger(parsed.n), 'whole file after kill ' + i);
    }
    const leftovers = fs.readdirSync(dir).filter(n => n.startsWith('.tmp-'));
    L('fsx').cleanTmp(dir, -1);
    assert.strictEqual(fs.readdirSync(dir).filter(n => n.startsWith('.tmp-')).length, 0, 'temp files cleaned (had ' + leftovers.length + ')');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('lock: a dead owner is stolen; a reused pid (right pid, wrong start) is also stale', () => {
  const fsx = L('fsx');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lock-'));
  const lock = path.join(dir, 'l');
  try {
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, start: 'Mon Jan  1 00:00:00 2001' }));
    let ran = false;
    fsx.withLockSync(lock, () => { ran = true; }, { timeoutMs: 2000 });
    assert.ok(ran);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, start: L('proc').selfStart() }));
    assert.throws(() => fsx.withLockSync(lock, () => {}, { timeoutMs: 200 }), /timed out/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('proc.isAlive: same pid with a different start time is a different process', () => {
  const proc = L('proc');
  assert.ok(proc.isAlive(process.pid, proc.selfStart()));
  assert.ok(!proc.isAlive(process.pid, 'Mon Jan  1 00:00:00 2001'));
  assert.ok(!proc.isAlive(999999, null));
});

test('killTree refuses a reused pid', async () => {
  const proc = L('proc');
  const c = spawn('/bin/sleep', ['30'], { stdio: 'ignore', detached: true });
  try {
    const killed = await proc.killTree(c.pid, 300, 'Mon Jan  1 00:00:00 2001');
    assert.deepStrictEqual(killed, []);
    assert.ok(proc.alive(c.pid));
  } finally { c.kill('SIGKILL'); }
});

// ---- config and accounts ----
test('state home defaults to ~/.claude/workers', () => {
  const saved = process.env.CLAUDE_WORKER_HOME;
  delete process.env.CLAUDE_WORKER_HOME;
  try { assert.strictEqual(L('config').cfg().home, path.join(os.homedir(), '.claude', 'workers')); } finally { if (saved) process.env.CLAUDE_WORKER_HOME = saved; }
});

/** Run fn with env overrides (undefined deletes), restoring the whole environment after. */
function withEnv(over, fn) {
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(over)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}
const tmp = p => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

test('accounts come from the private config; the default folder has CLAUDE_CONFIG_DIR removed even when the parent sets it', () => {
  const home = tmp('cw-home-');
  const cfgFile = path.join(home, 'config.json');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, 'acct-work'), { recursive: true });
  fs.mkdirSync(path.join(home, 'acct-side'), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({ owner: 'Sam', accounts: [{ label: 'main', dir: '~/.claude' }, { label: 'work', dir: '~/acct-work' }, { label: 'side', dir: path.join(home, 'acct-side') }] }));
  try {
    withEnv({ HOME: home, WORKBENCH_CONFIG: cfgFile, CLAUDE_WORKER_ACCOUNTS: undefined, CLAUDE_CONFIG_DIR: '/parent/session/dir', ANTHROPIC_API_KEY: 'sekrit-key', CLAUDE_CODE_OAUTH_TOKEN: 'sekrit-token', GH_TOKEN: 'sekrit-gh' }, () => {
      const A = L('accounts');
      const list = A.listAccounts();
      assert.deepStrictEqual(list.map(a => a.label), ['main', 'work', 'side']);
      const main = list[0];
      assert.ok(main.home);
      assert.strictEqual(main.dir, path.join(home, '.claude'), '~ expands against HOME');
      assert.ok(!list[1].home && !list[2].home);
      const me = A.childEnv(main);
      assert.ok(!('CLAUDE_CONFIG_DIR' in me));
      const we = A.childEnv(list[1]);
      assert.strictEqual(we.CLAUDE_CONFIG_DIR, path.join(home, 'acct-work'));
      assert.strictEqual(A.childEnv(list[2]).CLAUDE_CONFIG_DIR, path.join(home, 'acct-side'));
      for (const e of [me, we]) assert.ok(!/sekrit/.test(JSON.stringify(e)), 'no parent secrets');
      assert.ok(!Object.keys(we).some(k => k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_CODE')));
      assert.strictEqual(A.callerAccount(), null); // the parent dir matches no account
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('accounts: no config file means one account, the default folder, with the variable removed and never set to ~/.claude', () => {
  const home = tmp('cw-home-');
  try {
    withEnv({ HOME: home, WORKBENCH_CONFIG: path.join(home, 'absent.json'), CLAUDE_WORKER_ACCOUNTS: undefined, CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, () => {
      const A = L('accounts');
      const list = A.listAccounts();
      assert.deepStrictEqual(list, [{ label: 'main', dir: path.join(home, '.claude'), home: true }]);
      assert.ok(!('CLAUDE_CONFIG_DIR' in A.childEnv(list[0])));
    });
    // a config with no accounts key, or an empty list, is the same
    for (const body of ['{}', '{"accounts":[]}']) {
      fs.writeFileSync(path.join(home, 'c.json'), body);
      withEnv({ HOME: home, WORKBENCH_CONFIG: path.join(home, 'c.json'), CLAUDE_WORKER_ACCOUNTS: undefined }, () => {
        assert.deepStrictEqual(L('accounts').listAccounts().map(a => [a.label, a.home]), [['main', true]]);
      });
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('accounts: an explicit ~/.claude entry is the default folder even through a symlink or a trailing slash', () => {
  const home = tmp('cw-home-');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.symlinkSync(path.join(home, '.claude'), path.join(home, 'alias'));
  fs.writeFileSync(path.join(home, 'c.json'), JSON.stringify({ accounts: [{ label: 'a', dir: '~/alias' }, { label: 'b', dir: '~/.claude/' }] }));
  try {
    withEnv({ HOME: home, WORKBENCH_CONFIG: path.join(home, 'c.json'), CLAUDE_WORKER_ACCOUNTS: undefined }, () => {
      const list = L('accounts').listAccounts();
      assert.deepStrictEqual(list.map(a => a.home), [true, true]);
      for (const a of list) assert.ok(!('CLAUDE_CONFIG_DIR' in L('accounts').childEnv(a)));
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('accounts: a malformed or invalid config is a clear error, not a silent default', () => {
  const home = tmp('cw-home-');
  const f = path.join(home, 'c.json');
  const bad = [
    ['{ nope', /not valid JSON/],
    ['[]', /must be a JSON object/],
    ['{"accounts":"x"}', /must be a list/],
    ['{"accounts":[{"label":"a"}]}', /needs a label and a dir/],
    ['{"accounts":[{"label":"a b","dir":"/x"}]}', /letters, digits/],
    ['{"accounts":[{"label":"a","dir":"/x"},{"label":"a","dir":"/y"}]}', /appears twice/],
  ];
  try {
    for (const [body, re] of bad) {
      fs.writeFileSync(f, body);
      withEnv({ HOME: home, WORKBENCH_CONFIG: f, CLAUDE_WORKER_ACCOUNTS: undefined }, () => {
        assert.throws(() => L('accounts').listAccounts(), e => e instanceof require('../lib/errors').UserError && re.test(e.message), body);
      });
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('an account folder that does not exist is listed but not eligible, and no claude is started on it', async () => {
  const home = tmp('cw-home-');
  const f = path.join(home, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ accounts: [{ label: 'ghost', dir: '~/not-here' }] }));
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: home, WORKBENCH_CONFIG: f, CLAUDE_WORKER_HOME: path.join(home, 'state'), CLAUDE_WORKER_BIN: '/nonexistent/claude' });
  delete process.env.CLAUDE_WORKER_ACCOUNTS;
  try {
    const rows = await L('select').overview();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].eligible, false);
    assert.match(rows[0].reason, /config folder not found/);
    assert.ok(!fs.existsSync(path.join(home, 'not-here')), 'the folder was not created');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('callerAccount: matches by config folder, and an unset folder inside a session is the default account', () => {
  const home = tmp('cw-home-');
  fs.mkdirSync(path.join(home, 'acct-side'), { recursive: true });
  fs.writeFileSync(path.join(home, 'c.json'), JSON.stringify({ accounts: [{ label: 'main', dir: '~/.claude' }, { label: 'side', dir: '~/acct-side' }] }));
  try {
    withEnv({ HOME: home, WORKBENCH_CONFIG: path.join(home, 'c.json'), CLAUDE_WORKER_ACCOUNTS: undefined, CLAUDE_CONFIG_DIR: undefined, CLAUDECODE: undefined, CLAUDE_ACCOUNT: undefined }, () => {
      const A = L('accounts');
      assert.strictEqual(A.callerAccount(), null);
      process.env.CLAUDECODE = '1';
      assert.strictEqual(A.callerAccount(), 'main');
      process.env.CLAUDE_CONFIG_DIR = path.join(home, 'acct-side');
      assert.strictEqual(A.callerAccount(), 'side');
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ---- workspace, hooks, paths ----
test('findRoot walks up to workbench.json; none above means null', () => {
  const root = tmp('cw-ws-');
  fs.mkdirSync(path.join(root, 'worktrees', 'web', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workbench.json'), '{"workbench":1}');
  const outside = tmp('cw-nows-');
  try {
    const { findRoot } = L('workspace');
    assert.strictEqual(findRoot(path.join(root, 'worktrees', 'web', 'feat')), root);
    assert.strictEqual(findRoot(root), root);
    assert.strictEqual(findRoot(outside), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('guard hooks are looked up at $WORKBENCH_HOME/kit/hooks; start refuses when either is missing', () => {
  const wb = tmp('cw-wb-');
  fs.mkdirSync(path.join(wb, 'kit', 'hooks'), { recursive: true });
  try {
    withEnv({ WORKBENCH_HOME: wb, CLAUDE_WORKER_HOOKS_DIR: undefined }, () => {
      const launch = L('launch');
      assert.strictEqual(L('config').cfg().hooksDir, path.join(wb, 'kit', 'hooks'));
      assert.throws(() => launch.guardSettings(), /guard hooks missing.*guard-git\.sh.*guard-release\.sh/);
      fs.writeFileSync(path.join(wb, 'kit', 'hooks', 'guard-git.sh'), '#!/bin/bash\n', { mode: 0o755 });
      assert.throws(() => launch.guardSettings(), /guard hooks missing.*guard-release\.sh/);
      fs.writeFileSync(path.join(wb, 'kit', 'hooks', 'guard-release.sh'), '#!/bin/bash\n', { mode: 0o755 });
      const g = launch.guardSettings();
      assert.deepStrictEqual(g.hooks.PreToolUse[0].hooks.map(h => h.command), [`'${path.join(wb, 'kit', 'hooks', 'guard-git.sh')}'`, `'${path.join(wb, 'kit', 'hooks', 'guard-release.sh')}'`]);
      // Quoted for the shell: a folder with a space in it still runs the guard.
      const out = require('child_process').execSync(`sh -c ${JSON.stringify("printf '%s' " + g.hooks.PreToolUse[0].hooks[0].command)}`).toString();
      assert.strictEqual(out, path.join(wb, 'kit', 'hooks', 'guard-git.sh'));
    });
    // the default home is ~/.workbench
    withEnv({ WORKBENCH_HOME: undefined, CLAUDE_WORKER_HOOKS_DIR: undefined, HOME: wb }, () => {
      assert.strictEqual(L('config').cfg().hooksDir, path.join(wb, '.workbench', 'kit', 'hooks'));
    });
  } finally { fs.rmSync(wb, { recursive: true, force: true }); }
});

test('the scratch workspace the selftest builds is a workspace, with a local bare remote and a worktree', () => {
  const root = tmp('cw-scratch-');
  try {
    const sc = L('selftest').scratch(root);
    assert.strictEqual(L('workspace').findRoot(sc.wt), root);
    assert.ok(L('launch').findAgent('selftest-builder', sc.wt, { userDir: false }), 'scratch agent found from the worktree');
    assert.match(sc.refs(), /refs\/heads\/staging/);
    assert.ok(fs.existsSync(path.join(sc.wt, '.git')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('claude binary: CLAUDE_WORKER_BIN wins, else claude on PATH, else the bare name', () => {
  const d = tmp('cw-bin-');
  fs.writeFileSync(path.join(d, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  try {
    withEnv({ CLAUDE_WORKER_BIN: '/x/claude' }, () => assert.strictEqual(L('config').cfg().bin, '/x/claude'));
    withEnv({ CLAUDE_WORKER_BIN: undefined, PATH: d + ':/usr/bin' }, () => assert.strictEqual(L('config').cfg().bin, path.join(d, 'claude')));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ---- agents ----
test('findAgent: reads frontmatter from a folder above the worktree; model comes through', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-agent-'));
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'x-builder.md'), '---\nname: x-builder\ndescription: Builds x\nmodel: sonnet\nskills:\n  - build-then-break\n---\n\nYou build x.\n');
  try {
    const a = L('launch').findAgent('x-builder', path.join(root, 'a', 'b'));
    assert.strictEqual(a.def.model, 'sonnet');
    assert.strictEqual(a.def.prompt, 'You build x.');
    assert.strictEqual(L('launch').findAgent('../etc/passwd', root), null);
    assert.strictEqual(L('launch').findAgent('nope', root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('findAgent: the workspace folder is searched, and the default lookup skips the user folder', () => {
  const root = tmp('cw-agent-ws-');
  const home = tmp('cw-agent-home-');
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(root, 'worktrees', 'web', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workbench.json'), '{"workbench":1}');
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'builder.md'), '---\nname: builder\nmodel: sonnet\n---\n\nWorkspace builder.\n');
  fs.writeFileSync(path.join(home, '.claude', 'agents', 'mine.md'), '---\nname: mine\n---\n\nUser agent.\n');
  try {
    withEnv({ HOME: home }, () => {
      const wt = path.join(root, 'worktrees', 'web', 'feat');
      const L2 = L('launch');
      assert.strictEqual(L2.DEFAULT_AGENT, 'builder');
      assert.strictEqual(L2.findAgent('builder', wt, { userDir: false }).def.prompt, 'Workspace builder.');
      // the worktree's own definition wins over the workspace's
      fs.mkdirSync(path.join(wt, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(wt, '.claude', 'agents', 'builder.md'), '---\nname: builder\n---\n\nApp builder.\n');
      assert.strictEqual(L2.findAgent('builder', wt, { userDir: false }).def.prompt, 'App builder.');
      // the user folder serves explicit names only
      assert.ok(L2.findAgent('mine', wt));
      assert.strictEqual(L2.findAgent('mine', wt, { userDir: false }), null);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
});
