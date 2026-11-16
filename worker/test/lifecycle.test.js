'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { world, sleep, alive, groupMembers, CLI } = require('./helpers');

const workerCalls = w => w.calls('worker').sort((a, b) => a.run - b.run);

test('worker env: allow-list only; home account has no CLAUDE_CONFIG_DIR even when the parent sets one; others get their folder', async () => {
  const w = world();
  try {
    const parent = { CLAUDE_CONFIG_DIR: '/parent/session', ANTHROPIC_API_KEY: 'sekrit-1', CLAUDE_CODE_OAUTH_TOKEN: 'sekrit-2', GH_TOKEN: 'sekrit-3', AWS_SECRET_ACCESS_KEY: 'sekrit-4', CLAUDECODE: '1', CLAUDE_ACCOUNT: 'alpha' };
    for (const acct of ['gamma', 'alpha', 'beta']) {
      const r = w.start(['--account', acct], parent);
      await w.waitFor(r.id, s => s.state === 'done');
    }
    const calls = [...workerCalls(w), ...w.calls('usage'), ...w.calls('auth')];
    assert.ok(calls.length >= 6);
    const allowed = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'PWD', 'SHLVL', '_', '__CF_USER_TEXT_ENCODING', 'LC_CTYPE', 'CFFIXED_USER_HOME', 'XPC_FLAGS', 'XPC_SERVICE_NAME', 'COMMAND_MODE', 'CAFFEINATE_PID']);
    for (const c of calls) {
      assert.ok(!/sekrit/.test(JSON.stringify(c.env)), 'no secret reaches ' + c.mode);
      for (const k of Object.keys(c.env)) assert.ok(allowed.has(k), `unexpected env var ${k} in a ${c.mode} call`);
      if (c.acct === 'home') assert.ok(!('CLAUDE_CONFIG_DIR' in c.env), 'home account: variable removed');
      else assert.strictEqual(c.env.CLAUDE_CONFIG_DIR, path.join(w.acct, c.acct));
      assert.ok(!('CLAUDECODE' in c.env));
    }
    assert.deepStrictEqual(new Set(workerCalls(w).map(c => c.acct)), new Set(['home', 'alpha', 'beta']));
  } finally { await w.cleanup(); }
});

test('worker launch: caffeinate, cwd, stdin brief, flags, guard hooks in --settings', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'sleep', ms: 1500 }, { t: 'result', text: 'x' }] });
    const r = w.start(['--account', 'alpha']);
    const running = await w.waitFor(r.id, s => s.state === 'running' && s.legs[0] && s.legs[0].pid);
    await sleep(300);
    // caffeinate hands the command its own pid and holds a sleep assertion on its behalf.
    const assertions = require('child_process').execFileSync('/usr/bin/pmset', ['-g', 'assertions'], { encoding: 'utf8' });
    assert.match(assertions, new RegExp(`caffeinate asserting on behalf of .*\\(pid ${running.legs[0].pid}\\)`));
    await w.waitFor(r.id, s => s.state === 'done');
    const c = workerCalls(w)[0];
    assert.strictEqual(fs.realpathSync(c.cwd), fs.realpathSync(w.wt));
    assert.strictEqual(c.prompt, 'Do the thing.\n');
    for (const f of ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--settings', '--session-id', '--model']) assert.ok(c.args.includes(f), f);
    assert.strictEqual(c.args[c.args.indexOf('--model') + 1], 'sonnet');
    const settings = JSON.parse(fs.readFileSync(c.args[c.args.indexOf('--settings') + 1], 'utf8'));
    const hook = settings.hooks.PreToolUse[0];
    assert.strictEqual(hook.matcher, 'Bash');
    assert.deepStrictEqual(hook.hooks.map(h => path.basename(h.command.replace(/^'|'$/g, ''))), ['guard-git.sh', 'guard-release.sh']);
    assert.strictEqual(settings.disableAllHooks, false);
    assert.ok(!c.args.includes('--agent'));
  } finally { await w.cleanup(); }
});

test('start refuses when the guard hooks are missing', async () => {
  const w = world();
  try {
    fs.rmSync(path.join(w.hooks, 'guard-release.sh'));
    const r = w.cw(['start', '--worktree', w.wt, '--brief', w.brief]);
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /guard hooks missing/);
    assert.ok(!fs.existsSync(path.join(w.home, 'w')) || fs.readdirSync(path.join(w.home, 'w')).length === 0);
  } finally { await w.cleanup(); }
});

test('start validates: worktree, brief, account, agent', async () => {
  const w = world();
  try {
    assert.match(w.cw(['start', '--worktree', '/nope', '--brief', w.brief]).stderr, /worktree not found/);
    assert.match(w.cw(['start', '--worktree', w.wt, '--brief', '/nope']).stderr, /cannot read brief/);
    assert.match(w.cw(['start', '--worktree', w.wt, '--brief', w.brief, '--account', 'zzz']).stderr, /no such account/);
    assert.match(w.cw(['start', '--worktree', w.wt, '--brief', w.brief, '--agent', 'ghost']).stderr, /agent definition not found/);
    assert.match(w.cw(['bogus']).stderr, /unknown command/);
  } finally { await w.cleanup(); }
});

test('--agent: the definition is found above the worktree and passed with its model; no --model overrides it', async () => {
  const w = world();
  try {
    fs.mkdirSync(path.join(w.root, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(w.root, '.claude', 'agents', 'x-builder.md'), '---\nname: x-builder\ndescription: Builds x\nmodel: sonnet\n---\n\nYou are the x builder.\n');
    const r = w.start(['--agent', 'x-builder']);
    await w.waitFor(r.id, s => s.state === 'done');
    const c = workerCalls(w)[0];
    assert.strictEqual(c.args[c.args.indexOf('--agent') + 1], 'x-builder');
    const defs = JSON.parse(c.args[c.args.indexOf('--agents') + 1]);
    assert.strictEqual(defs['x-builder'].model, 'sonnet');
    assert.match(defs['x-builder'].prompt, /x builder/);
    assert.ok(!c.args.includes('--model'), "the agent's own model applies");
    const r2 = w.start(['--agent', 'x-builder', '--model', 'haiku']);
    await w.waitFor(r2.id, s => s.state === 'done');
    const c2 = workerCalls(w)[1];
    assert.strictEqual(c2.args[c2.args.indexOf('--model') + 1], 'haiku');
  } finally { await w.cleanup(); }
});

test('no --agent: the default builder agent is used when the workspace has one; --agent none opts out', async () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.root, 'workbench.json'), '{"workbench":1}');
    fs.mkdirSync(path.join(w.root, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(w.root, '.claude', 'agents', 'builder.md'), '---\nname: builder\ndescription: Builds\nmodel: sonnet\n---\n\nYou are the builder.\n');
    const r = w.start();
    assert.ok(!('note' in r), 'inside a workspace there is no note');
    await w.waitFor(r.id, s => s.state === 'done');
    const c = workerCalls(w)[0];
    assert.strictEqual(c.args[c.args.indexOf('--agent') + 1], 'builder');
    assert.match(JSON.parse(c.args[c.args.indexOf('--agents') + 1]).builder.prompt, /the builder/);
    assert.ok(!c.args.includes('--model'), "the agent's own model applies");
    const r2 = w.start(['--agent', 'none']);
    await w.waitFor(r2.id, s => s.state === 'done');
    const c2 = workerCalls(w)[1];
    assert.ok(!c2.args.includes('--agent'));
    assert.strictEqual(c2.args[c2.args.indexOf('--model') + 1], 'sonnet');
  } finally { await w.cleanup(); }
});

test('a worktree outside any workspace still starts, with a note that no workbench.json was found, and runs with no agent', async () => {
  const w = world();
  try {
    const r = w.start();
    assert.match(r.note, /no workbench\.json found above/);
    await w.waitFor(r.id, s => s.state === 'done');
    const c = workerCalls(w)[0];
    assert.ok(!c.args.includes('--agent'));
    assert.strictEqual(c.args[c.args.indexOf('--model') + 1], 'sonnet');
    const plain = w.cw(['start', '--worktree', w.wt, '--brief', w.brief]);
    assert.match(plain.stderr, /note: no workbench\.json found above/);
    await w.waitFor(plain.stdout.split(/\s+/)[0], s => s.state === 'done');
  } finally { await w.cleanup(); }
});

test('state is private: home 700, files 600', async () => {
  const w = world();
  try {
    const r = w.start();
    await w.waitFor(r.id, s => s.state === 'done');
    const mode = p => fs.statSync(p).mode & 0o777;
    assert.strictEqual(mode(w.home), 0o700);
    const d = path.join(w.home, 'w', r.id);
    assert.strictEqual(mode(d), 0o700);
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isFile()) assert.strictEqual(mode(p), 0o600, f);
    }
    for (const f of fs.readdirSync(path.join(w.home, 'readings'))) assert.strictEqual(mode(path.join(w.home, 'readings', f)), 0o600);
  } finally { await w.cleanup(); }
});

test('heartbeat advances, supervisor pid and start time are recorded', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'sleep', ms: 2500 }, { t: 'result', text: 'x' }] });
    const r = w.start();
    const s1 = await w.waitFor(r.id, s => s.supervisor && s.supervisor.heartbeat && s.state === 'running');
    assert.ok(s1.supervisor.pid > 0 && s1.supervisor.start);
    const hb = s1.supervisor.heartbeat;
    const s2 = await w.waitFor(r.id, s => s.supervisor.heartbeat > hb + 200, 5000);
    assert.ok(s2.supervisor.heartbeat > hb);
    assert.ok(alive(s2.supervisor.pid));
  } finally { await w.cleanup(); }
});

test('a worker survives the main session exiting (its whole process group killed)', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'sleep', ms: 2500 }, { t: 'result', text: 'survived' }] });
    const sh = spawn('/bin/bash', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} start --worktree ${JSON.stringify(w.wt)} --brief ${JSON.stringify(w.brief)} --json > ${JSON.stringify(path.join(w.root, 'start.json'))}; sleep 600`], { env: w.env, detached: true, stdio: 'ignore' });
    const id = await (async () => { for (let i = 0; i < 200; i++) { try { return JSON.parse(fs.readFileSync(path.join(w.root, 'start.json'), 'utf8')).id; } catch { await sleep(50); } } throw new Error('no start'); })();
    await w.waitFor(id, s => s.state === 'running');
    process.kill(-sh.pid, 'SIGKILL');
    const s = await w.waitFor(id, s => s.state === 'done');
    assert.strictEqual(s.result.text, 'survived');
    assert.strictEqual(s.legs.length, 1);
  } finally { await w.cleanup(); }
});

test('stop kills the whole process group and its descendants, in any group, and leaves no orphans', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'child' }, { t: 'child', newgroup: true }, { t: 'text', text: 'busy' }, { t: 'hang' }] });
    const r = w.start();
    const kidsFile = path.join(w.fake, 'children.txt');
    const s = await w.waitFor(r.id, s => s.state === 'running' && s.legs[0] && s.legs[0].pid && fs.existsSync(kidsFile) && fs.readFileSync(kidsFile, 'utf8').split('\n').filter(Boolean).length === 2);
    const rootPid = s.legs[0].pid;
    const kids = fs.readFileSync(kidsFile, 'utf8').split('\n').filter(Boolean).map(Number);
    const fakePid = workerCalls(w)[0].pid;
    assert.ok(groupMembers(rootPid).length >= 3);
    assert.ok([...kids, fakePid, rootPid].every(alive));
    const st = w.cw(['stop', r.id, '--json']).json();
    assert.strictEqual(st.state, 'stopped');
    await sleep(200);
    for (const p of [...kids, fakePid, rootPid, s.supervisor.pid]) assert.ok(!alive(p), `pid ${p} is gone`);
    assert.deepStrictEqual(groupMembers(rootPid), []);
    assert.strictEqual(w.cw(['stop', r.id, '--json']).json().state, 'stopped');
    assert.deepStrictEqual(fs.readdirSync(path.join(w.home, 'slots', st.account)), []);
    assert.ok(w.state(r.id).onDisk.git);
  } finally { await w.cleanup(); }
});

test('stop a queued worker (waiting, no process yet)', async () => {
  const w = world();
  try {
    for (const a of ['alpha', 'beta', 'home']) w.usage(a, { session: 99, week: 99 });
    const r = w.start();
    assert.strictEqual(r.account, null);
    assert.strictEqual(w.cw(['stop', r.id, '--json']).json().state, 'stopped');
  } finally { await w.cleanup(); }
});

test('send continues a finished conversation: --resume with the recorded session, the follow-up on stdin', async () => {
  const w = world();
  try {
    w.scenario({ runs: { 1: [{ t: 'init' }, { t: 'text', text: 'a' }, { t: 'result', text: 'first' }], 2: [{ t: 'init' }, { t: 'result', text: 'second' }] } });
    const r = w.start(['--account', 'alpha']);
    const s1 = await w.waitFor(r.id, s => s.state === 'done');
    const sid = s1.sessionId;
    assert.ok(sid);
    const f = path.join(w.root, 'follow.md');
    fs.writeFileSync(f, 'Now do the follow-up.\n');
    const sent = w.cw(['send', r.id, '--file', f, '--json']);
    assert.strictEqual(sent.code, 0, sent.stderr);
    const s2 = await w.waitFor(r.id, s => s.state === 'done' && s.result && s.result.text === 'second');
    assert.strictEqual(s2.legs.length, 2);
    const c = workerCalls(w)[1];
    assert.strictEqual(c.args[c.args.indexOf('--resume') + 1], sid);
    assert.strictEqual(c.prompt, 'Now do the follow-up.\n');
    assert.strictEqual(w.cw(['result', r.id]).stdout.trim(), 'second');
    w.scenario({ default: [{ t: 'init' }, { t: 'hang' }] });
    assert.strictEqual(w.cw(['send', r.id, '--file', f]).code, 0);
    await w.waitFor(r.id, s => s.state === 'running' && s.legs.length === 3);
    assert.match(w.cw(['send', r.id, '--file', f]).stderr, /continues a finished worker/);
  } finally { await w.cleanup(); }
});

test('starts on one account are staggered', async () => {
  const w = world({ CLAUDE_WORKER_STAGGER_MS: '700' });
  try {
    const ids = [1, 2, 3].map(() => w.start(['--account', 'alpha']).id);
    for (const id of ids) await w.waitFor(id, s => s.state === 'done', 30000);
    const times = workerCalls(w).map(c => c.at).sort((a, b) => a - b);
    assert.strictEqual(times.length, 3);
    assert.ok(times[1] - times[0] >= 600, `gap ${times[1] - times[0]}`);
    assert.ok(times[2] - times[1] >= 600, `gap ${times[2] - times[1]}`);
  } finally { await w.cleanup(); }
});

test('terminal states record why and what is on disk', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'write', file: 'half-done.txt' }, { t: 'text', text: 'x' }, { t: 'result', text: 'bad', is_error: true, subtype: 'error_max_turns' }] });
    const r = w.start();
    const s = await w.waitFor(r.id, s => s.state === 'failed');
    assert.match(s.reason, /error_max_turns/);
    assert.strictEqual(s.onDisk.git, true);
    assert.deepStrictEqual(s.onDisk.dirtyFiles, ['?? half-done.txt']);
    assert.match(s.onDisk.head, /^[0-9a-f]{40}$/);
    const res = w.cw(['result', r.id]);
    assert.strictEqual(res.code, 1);
    assert.match(res.stderr, /failed/);
  } finally { await w.cleanup(); }
});

test('names work as ids; status lists everything; json is parseable', async () => {
  const w = world();
  try {
    const r = w.start(['--name', 'mine']);
    const waited = w.cw(['wait', 'mine', '--json']);
    assert.strictEqual(waited.code, 0);
    assert.strictEqual(waited.json().workers[0].id, r.id);
    assert.strictEqual(w.cw(['status', '--json']).json()[0].state, 'done');
    assert.match(w.cw(['status']).stdout, new RegExp(r.id));
    assert.strictEqual(w.cw(['result', 'mine']).stdout.trim(), 'ok');
    assert.strictEqual(w.cw(['wait', 'nobody']).code, 2);
  } finally { await w.cleanup(); }
});

test('wait exits non-zero when any worker failed, and honours --timeout', async () => {
  const w = world();
  try {
    w.scenario({ default: [{ t: 'init' }, { t: 'hang' }] });
    const r = w.start();
    const t = w.cw(['wait', r.id, '--timeout', '1']);
    assert.strictEqual(t.code, 124);
    w.cw(['stop', r.id]);
    assert.strictEqual(w.cw(['wait', r.id]).code, 1);
  } finally { await w.cleanup(); }
});
