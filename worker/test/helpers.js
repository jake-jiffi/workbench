'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn, execFileSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', '..', 'bin', 'claude-worker');
const FAKE = path.resolve(__dirname, 'fake-claude.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A throwaway world: state home, fake binary, three accounts, a git worktree, guard hooks. */
function world(extraEnv = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-')));
  const w = { root, fake: path.join(root, 'fake'), home: path.join(root, 'home'), wt: path.join(root, 'wt'), hooks: path.join(root, 'hooks'), acct: path.join(root, 'acct') };
  for (const d of [w.fake, w.wt, w.hooks, path.join(w.acct, 'alpha'), path.join(w.acct, 'beta')]) fs.mkdirSync(d, { recursive: true });
  w.bin = path.join(root, 'claude');
  fs.writeFileSync(w.bin, `#!/usr/bin/env node\nglobal.FAKE_DIR = ${JSON.stringify(w.fake)};\nrequire(${JSON.stringify(FAKE)});\n`, { mode: 0o755 });
  for (const g of ['guard-git.sh', 'guard-release.sh']) fs.writeFileSync(path.join(w.hooks, g), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  execFileSync('git', ['init', '-q', '-b', 'base', w.wt]);
  execFileSync('git', ['-C', w.wt, '-c', 'user.email=a@b', '-c', 'user.name=x', 'commit', '-q', '--allow-empty', '-m', 'init']);
  w.brief = path.join(root, 'brief.md');
  fs.writeFileSync(w.brief, 'Do the thing.\n');
  w.env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm',
    CLAUDE_WORKER_HOME: w.home, CLAUDE_WORKER_BIN: w.bin, CLAUDE_WORKER_HOOKS_DIR: w.hooks,
    CLAUDE_WORKER_ACCOUNTS: `alpha=${path.join(w.acct, 'alpha')},beta=${path.join(w.acct, 'beta')},gamma=home`,
    CLAUDE_WORKER_TICK_MS: '40', CLAUDE_WORKER_STAGGER_MS: '0', CLAUDE_WORKER_HEARTBEAT_MS: '300', CLAUDE_WORKER_KILL_GRACE_MS: '800',
    CLAUDE_WORKER_WAIT_POLL_MS: '100', CLAUDE_WORKER_LIMIT_GRACE_MS: '400', CLAUDE_WORKER_WAIT_BASE_MS: '300', CLAUDE_WORKER_WAIT_MAX_MS: '600',
    CLAUDE_WORKER_PROBE_EVERY_MS: '300', CLAUDE_WORKER_MIN_LEG_MS: '0', CLAUDE_WORKER_PROBE_TIMEOUT_MS: '3000',
    ...extraEnv,
  };
  w.usage = (label, u) => { fs.mkdirSync(path.join(w.fake, 'usage'), { recursive: true }); fs.writeFileSync(path.join(w.fake, 'usage', label + '.json'), JSON.stringify(u)); };
  w.scenario = s => fs.writeFileSync(path.join(w.fake, 'scenario.json'), JSON.stringify(s));
  for (const a of ['alpha', 'beta', 'home']) w.usage(a, { session: 10, week: 10 });
  // The fake names the home account "home" (no config dir); the world calls it gamma.
  w.label = l => (l === 'gamma' ? 'home' : l);
  w.usageOf = (label, u) => w.usage(w.label(label), u);
  w.cw = (args, env = {}) => cw(w, args, env);
  w.start = (extra = [], env = {}) => {
    const r = cw(w, ['start', '--worktree', w.wt, '--brief', w.brief, '--json', ...extra], env);
    if (r.code !== 0) throw new Error('start failed: ' + r.stderr + r.stdout);
    return JSON.parse(r.stdout);
  };
  w.state = id => { try { return JSON.parse(fs.readFileSync(path.join(w.home, 'w', id, 'state.json'), 'utf8')); } catch { return null; } };
  w.calls = (mode) => {
    const d = path.join(w.fake, 'calls');
    let names = []; try { names = fs.readdirSync(d); } catch { /* none */ }
    return names.map(n => JSON.parse(fs.readFileSync(path.join(d, n), 'utf8'))).filter(c => !mode || c.mode === mode);
  };
  w.waitFor = (id, pred, ms = 20000) => waitFor(() => { const s = w.state(id); return s && pred(s) ? s : null; }, ms);
  w.runs = () => { try { return fs.readdirSync(path.join(w.fake, 'runs')).length; } catch { return 0; } };
  w.sleepers = [];
  w.sleeper = () => { const c = spawn('/bin/sleep', ['300'], { stdio: 'ignore', detached: true }); c.unref(); w.sleepers.push(c.pid); return c.pid; };
  w.kill9 = (pid) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };
  w.cwAsync = (args, env = {}) => new Promise(res => {
    const c = spawn(process.execPath, [CLI, ...args], { env: { ...w.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
    c.on('exit', code => res({ code, stdout: out, stderr: err, json: () => JSON.parse(out) }));
  });
  w.stopAll = async () => {
    const ids = (() => { try { return fs.readdirSync(path.join(w.home, 'w')); } catch { return []; } })();
    await Promise.all(ids.filter(id => { const s = w.state(id); return s && !['done', 'failed', 'stopped'].includes(s.state); }).map(id => w.cwAsync(['stop', id])));
  };
  w.cleanup = async () => {
    for (const p of w.sleepers) w.kill9(p);
    await w.stopAll();
    try { for (const p of fs.readFileSync(path.join(w.fake, 'children.txt'), 'utf8').split('\n').filter(Boolean)) { try { process.kill(Number(p), 'SIGKILL'); } catch { /* gone */ } } } catch { /* none */ }
    fs.rmSync(root, { recursive: true, force: true });
  };
  return w;
}

function cw(w, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...w.env, ...env }, encoding: 'utf8', timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}

async function waitFor(fn, ms = 20000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await sleep(step);
  }
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const psStart = pid => { try { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/bin' } }).trim(); } catch { return null; } };
const groupMembers = pgid => execFileSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(a => a[1] === pgid).map(a => a[0]);

module.exports = { world, cw, waitFor, sleep, alive, psStart, groupMembers, CLI, spawn };
