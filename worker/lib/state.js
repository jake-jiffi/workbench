'use strict';
// A worker's folder: <home>/w/<id>/. spec.json is written once and never changes; state.json is rewritten
// atomically (the previous copy is kept as state.json.prev); each leg has an immutable leg-N.json plus its stream.
// If both state copies are lost, state is rebuilt from the spec, the leg files and the streams.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { cfg } = require('./config');
const fsx = require('./fsx');
const { StreamTracker } = require('./stream');

const TERMINAL = new Set(['done', 'failed', 'stopped']);
const isTerminal = s => TERMINAL.has(s);

const wroot = () => path.join(cfg().home, 'w');
const dirOf = id => path.join(wroot(), id);
const file = (id, name) => path.join(dirOf(id), name);

function init() {
  const c = cfg();
  fsx.ensureDir(c.home);
  try { fs.chmodSync(c.home, 0o700); } catch { /* not ours */ }
  fsx.ensureDir(wroot());
}

function listIds() {
  try { return fs.readdirSync(wroot()).filter(n => /^w-[0-9a-f]{6}$/.test(n)).sort(); } catch { return []; }
}

function newId() {
  init();
  for (let i = 0; i < 50; i++) {
    const id = 'w-' + crypto.randomBytes(3).toString('hex');
    try { fs.mkdirSync(dirOf(id), { mode: 0o700 }); return id; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('could not allocate a worker id');
}

const readSpec = id => fsx.readJson(file(id, 'spec.json'));

function rebuild(id) {
  const spec = readSpec(id);
  if (!spec) return null;
  const legs = [];
  let names = [];
  try { names = fs.readdirSync(dirOf(id)); } catch { /* gone */ }
  const nums = names.map(n => /^leg-(\d+)\.json$/.exec(n)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b);
  let sessionId = null;
  for (const n of nums) {
    const meta = fsx.readJson(file(id, `leg-${n}.json`)) || { n };
    const t = new StreamTracker();
    try { t.feed(fs.readFileSync(file(id, `leg-${n}.out.jsonl`), 'utf8')); t.finish(); } catch { /* no stream */ }
    if (t.sessionId) sessionId = t.sessionId;
    legs.push({ ...meta, n, sessionId: t.sessionId || meta.sessionId || null, progress: t.progress, endedAt: null });
  }
  legs.forEach((l, i) => { if (i < legs.length - 1) { l.endedAt = Date.now(); l.endReason = 'rebuilt'; } });
  const last = legs[legs.length - 1];
  return {
    id, state: 'running', reason: 'state rebuilt from leg files', rebuilt: true,
    account: last ? last.account : null, sessionId: sessionId || spec.plannedSession || null,
    legs, legBase: 0, supervisor: null, plan: legs.length ? null : { kind: 'first', reason: 'rebuilt' },
    crashStreak: 0, noProgress: 0, stallCount: 0, createdAt: spec.createdAt, updatedAt: Date.now(),
  };
}

/** The current state, from state.json, else its previous copy, else rebuilt. null if nothing can be recovered. */
function load(id) {
  fsx.cleanTmp(dirOf(id));
  const s = fsx.readJson(file(id, 'state.json'));
  if (s && typeof s === 'object' && s.id === id && Array.isArray(s.legs)) return s;
  const p = fsx.readJson(file(id, 'state.json.prev'));
  let st = null;
  if (p && typeof p === 'object' && p.id === id && Array.isArray(p.legs)) st = { ...p, restoredFromPrev: true };
  else st = rebuild(id);
  // A recovered copy may predate the end of the worker. final.json is written before the last state change, so a
  // finished worker is never brought back to life by a damaged state file.
  const fin = st && fsx.readJson(file(id, 'final.json'));
  if (fin && fin.state && isTerminal(fin.state) && !isTerminal(st.state)) {
    Object.assign(st, { state: fin.state, reason: fin.reason, finishedAt: fin.finishedAt, result: fin.result || null, onDisk: fin.onDisk || null, plan: null });
    for (const l of st.legs) if (!l.endedAt) { l.endedAt = fin.finishedAt; l.endReason = l.endReason || fin.state; }
  }
  return st;
}

function save(id, st) {
  st.updatedAt = Date.now();
  fsx.atomicWrite(file(id, 'state.json'), st, { keepPrev: true });
}

/** Read-modify-write under the worker's lock. fn may mutate and return nothing, or return a replacement. */
function update(id, fn) {
  return fsx.withLockSync(file(id, 'lock'), () => {
    let st = load(id);
    if (!st) st = { id, state: 'failed', reason: 'state and spec are unreadable', legs: [], legBase: 0, createdAt: Date.now() };
    const r = fn(st);
    if (r) st = r;
    save(id, st);
    return st;
  });
}

function create(spec) {
  const id = newId();
  const dir = dirOf(id);
  fsx.atomicWrite(path.join(dir, 'spec.json'), { ...spec, id, createdAt: Date.now() });
  const st = { id, state: 'waiting', reason: 'starting', account: null, sessionId: null, legs: [], legBase: 0, supervisor: null, plan: { kind: 'first', reason: 'start' }, crashStreak: 0, noProgress: 0, stallCount: 0, createdAt: Date.now() };
  save(id, st);
  return id;
}

/** Resolve an id or a unique name (the newest worker with that name). */
function resolve(ref) {
  if (/^w-[0-9a-f]{6}$/.test(ref) && fs.existsSync(dirOf(ref))) return ref;
  let best = null;
  for (const id of listIds()) {
    const sp = readSpec(id);
    if (sp && sp.name === ref && (!best || sp.createdAt >= best.at)) best = { id, at: sp.createdAt };
  }
  return best ? best.id : null;
}

function git(wt, args) {
  try {
    return execFileSync('git', ['-C', wt, ...args], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** What is on disk in the worktree right now, recorded with every terminal state. */
function onDisk(wt) {
  const head = git(wt, ['rev-parse', 'HEAD']);
  if (head === null) return { worktree: wt, git: false };
  const dirty = (git(wt, ['status', '--porcelain']) || '').split('\n').filter(Boolean);
  return {
    worktree: wt, git: true, head, branch: git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']),
    subject: git(wt, ['log', '-1', '--format=%s']), dirtyCount: dirty.length, dirtyFiles: dirty.slice(0, 30),
  };
}

module.exports = { TERMINAL, isTerminal, init, dirOf, file, listIds, newId, readSpec, load, save, update, create, resolve, onDisk, rebuild };
