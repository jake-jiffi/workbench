'use strict';
const fs = require('fs');
const path = require('path');
const { cfg } = require('./config');
const fsx = require('./fsx');
const proc = require('./proc');
const accounts = require('./accounts');
const select = require('./select');
const state = require('./state');
const launch = require('./launch');
const { findRoot } = require('./workspace');
const sup = require('./supervisor');

const sleep = fsx.sleep;

const { UserError } = require('./errors');

// ---- recovery ----
/** Make sure a live supervisor owns this worker. Safe to run from several processes at once. */
function recoverOne(id) {
  const c = cfg();
  return fsx.withLockSync(state.file(id, 'recover.lock'), () => {
    const st = state.load(id);
    if (!st) { state.update(id, () => {}); return 'unreadable'; }
    if (state.isTerminal(st.state)) return 'finished';
    const sv = st.supervisor;
    if (sv && proc.isAlive(sv.pid, sv.start)) return 'alive';
    if ((st.recoveries || 0) >= 20) { sup.finish(id, 'failed', 'supervisor died 20 times; giving up'); return 'gave-up'; }
    const pid = sup.spawnSupervisor(id);
    if (!pid) { state.update(id, s => { s.recoveries = (s.recoveries || 0) + 1; }); return 'spawn-failed'; }
    const start = proc.pidStart(pid);
    state.update(id, s => {
      if (state.isTerminal(s.state)) return;
      s.supervisor = { pid, start, spawnedAt: Date.now(), recovered: true };
      s.recoveries = (s.recoveries || 0) + 1;
    });
    return 'respawned';
  }, { timeoutMs: 10_000 });
}

function recoverAll(ids) {
  const out = {};
  for (const id of ids || state.listIds()) {
    try {
      const st = state.load(id);
      if (st && state.isTerminal(st.state)) continue;
      out[id] = recoverOne(id);
    } catch (e) { out[id] = 'error: ' + e.message; }
  }
  return out;
}

// ---- start ----
async function start(o) {
  state.init();
  if (!o.worktree) throw new UserError('start needs --worktree <path>');
  if (!o.brief) throw new UserError('start needs --brief <file>');
  const worktree = path.resolve(o.worktree);
  if (!fs.existsSync(worktree) || !fs.statSync(worktree).isDirectory()) throw new UserError(`worktree not found: ${worktree}`);
  let briefText;
  try { briefText = fs.readFileSync(o.brief, 'utf8'); } catch { throw new UserError(`cannot read brief: ${o.brief}`); }
  if (!briefText.trim()) throw new UserError('the brief is empty');
  launch.guardSettings(); // throws if the guard hooks are missing
  if (o.account && !accounts.findAccount(o.account)) throw new UserError(`no such account: ${o.account} (accounts: ${accounts.listAccounts().map(a => a.label).join(', ')})`);
  let agentDef = null;
  let agent = o.agent && o.agent !== 'none' ? o.agent : null;
  if (agent) {
    const a = launch.findAgent(agent, worktree);
    if (!a) throw new UserError(`agent definition not found: ${agent}`);
    agentDef = a.def;
  } else if (!o.agent) {
    // No --agent: use the project's `builder` when it has one (worktree or workspace), else a plain session.
    const a = launch.findAgent(launch.DEFAULT_AGENT, worktree, { userDir: false });
    if (a) { agent = launch.DEFAULT_AGENT; agentDef = a.def; }
  }
  const root = findRoot(worktree);
  const spec = {
    name: o.name || null, worktree, agent, agentDef,
    model: o.model || (agent ? null : 'sonnet'), pin: o.account || null, force: !!o.force,
    caller: accounts.callerAccount(),
  };
  const id = state.create(spec);
  // Until the supervisor exists, this process is its owner, so a concurrent `status` does not start a second one.
  state.update(id, s => { s.supervisor = { pid: process.pid, start: proc.selfStart(), starter: true }; });
  fsx.atomicWrite(state.file(id, 'brief.md'), briefText);
  let pick;
  try {
    pick = await select.pickAndReserve({ id, pin: o.account, force: !!(o.account && o.force) });
  } catch (e) {
    fs.rmSync(state.dirOf(id), { recursive: true, force: true });
    throw e;
  }
  if (o.account && !pick.account) {
    fs.rmSync(state.dirOf(id), { recursive: true, force: true });
    throw new UserError(`${o.account} cannot take a worker: ${pick.why[o.account]} (use --force to override)`);
  }
  state.update(id, s => {
    s.account = pick.account ? pick.account.label : null;
    s.plan = { kind: 'first', reason: 'start', avoid: [], prefer: pick.account ? 'same' : null };
    s.reason = pick.account ? `starting on ${s.account}` : 'queued: ' + Object.entries(pick.why).map(([k, v]) => `${k}: ${v}`).join('; ');
  });
  const pid = sup.spawnSupervisor(id);
  const start_ = pid ? proc.pidStart(pid) : null;
  state.update(id, s => { s.supervisor = pid ? { pid, start: start_, spawnedAt: Date.now() } : null; });
  const note = root ? undefined : `no workbench.json found above ${worktree}: no workspace folder, so only the worktree's own .claude/agents and ~/.claude/agents are searched for agents`;
  return { id, name: spec.name, ...(note ? { note } : {}), account: pick.account ? pick.account.label : null, state: pick.account ? 'starting' : 'waiting', reason: pick.account ? undefined : 'no account has room yet; queued' };
}

// ---- reading ----
function summary(id) {
  const st = state.load(id);
  const spec = state.readSpec(id) || {};
  if (!st) return { id, name: spec.name, state: 'unreadable' };
  const sv = st.supervisor;
  const open = st.legs[st.legs.length - 1];
  return {
    id, name: spec.name || null, state: st.state, reason: st.reason, account: st.account, worktree: spec.worktree,
    legs: st.legs.map(l => ({ n: l.n, account: l.account, session: l.sessionId, why: l.why, end: l.endReason || (l.endedAt ? 'ended' : 'running'), progress: l.progress, exit: l.exit })),
    session: st.sessionId, supervisorAlive: !!(sv && proc.isAlive(sv.pid, sv.start)),
    heartbeatAgeSec: sv && sv.heartbeat ? Math.round((Date.now() - sv.heartbeat) / 1000) : null,
    updatedAt: st.updatedAt, finishedAt: st.finishedAt || null, onDisk: st.onDisk || null, result: st.result ? { subtype: st.result.subtype, costUsd: st.result.costUsd } : null,
    openLegPid: open && !open.endedAt ? open.pid : null, rebuilt: !!st.rebuilt, waiting: st.waiting || null,
  };
}

function status(ref) {
  const ids = ref ? [needId(ref)] : state.listIds();
  recoverAll(ids);
  return ids.map(summary);
}

function needId(ref) {
  const id = state.resolve(ref);
  if (!id) throw new UserError(`no such worker: ${ref}`);
  return id;
}

function result(ref) {
  const id = needId(ref);
  recoverAll([id]);
  const st = state.load(id);
  if (!st) throw new UserError('state is unreadable');
  if (!state.isTerminal(st.state)) return { id, state: st.state, finished: false };
  let text = null;
  if (st.state === 'done') { try { text = fs.readFileSync(state.file(id, 'result.txt'), 'utf8'); } catch { text = st.result ? st.result.text : null; } }
  return { id, state: st.state, finished: true, reason: st.reason, text, onDisk: st.onDisk };
}

// ---- wait ----
async function wait(refs, { timeoutMs } = {}) {
  const c = cfg();
  const ids = refs.map(needId);
  const t0 = Date.now();
  for (;;) {
    recoverAll(ids);
    const sums = ids.map(summary);
    if (sums.every(s => state.isTerminal(s.state))) return { timedOut: false, workers: sums };
    if (timeoutMs && Date.now() - t0 > timeoutMs) return { timedOut: true, workers: sums };
    await sleep(c.waitPollMs);
  }
}

// ---- stop ----
async function stop(ref) {
  const c = cfg();
  const id = needId(ref);
  let st = state.load(id);
  if (st && state.isTerminal(st.state)) return summary(id);
  fsx.atomicWrite(sup.stopFile(id), JSON.stringify({ at: Date.now() }));
  const deadline = Date.now() + c.killGraceMs + 10_000;
  while (Date.now() < deadline) {
    st = state.load(id);
    if (st && state.isTerminal(st.state)) return summary(id);
    const sv = st && st.supervisor;
    if (!(sv && proc.isAlive(sv.pid, sv.start))) break; // nobody left to do it
    await sleep(100);
  }
  // The supervisor is gone or stuck: do it here.
  st = state.load(id);
  if (st && !state.isTerminal(st.state)) {
    const sv = st.supervisor;
    if (sv && proc.isAlive(sv.pid, sv.start) && sv.pid !== process.pid) { try { process.kill(sv.pid, 'SIGTERM'); } catch { /* gone */ } }
    const l = sup.openLeg(st);
    if (l && l.pid) await proc.killTree(l.pid, c.killGraceMs, l.start);
    sup.finish(id, 'stopped', 'stopped on request');
  }
  return summary(id);
}

// ---- send ----
async function send(ref, o) {
  const id = needId(ref);
  if (!o.file) throw new UserError('send needs --file <follow-up>');
  let text;
  try { text = fs.readFileSync(o.file, 'utf8'); } catch { throw new UserError(`cannot read ${o.file}`); }
  if (!text.trim()) throw new UserError('the follow-up is empty');
  recoverAll([id]);
  const st0 = state.load(id);
  if (!st0) throw new UserError('state is unreadable');
  if (!state.isTerminal(st0.state)) throw new UserError(`${id} is ${st0.state}; send continues a finished worker`);
  if (!st0.sessionId) throw new UserError(`${id} has no recorded conversation to continue`);
  if (o.account && !accounts.findAccount(o.account)) throw new UserError(`no such account: ${o.account}`);
  const n = st0.legs.length + 1;
  fsx.atomicWrite(state.file(id, `send-${n}.md`), text);
  const pick = await select.pickAndReserve({ id, pin: o.account, force: !!(o.account && o.force), prefer: st0.account });
  if (!pick.account) {
    throw new UserError(o.account ? `${o.account} cannot take it: ${pick.why[o.account]} (use --force to override)` : 'no account has room right now: ' + Object.entries(pick.why).map(([k, v]) => `${k}: ${v}`).join('; '));
  }
  try { fs.unlinkSync(sup.stopFile(id)); } catch { /* none */ }
  try { fs.unlinkSync(state.file(id, 'final.json')); } catch { /* none */ }
  state.update(id, s => {
    s.history = (s.history || []).concat([{ state: s.state, reason: s.reason, result: s.result || null, finishedAt: s.finishedAt }]).slice(-10);
    s.state = 'waiting'; s.reason = `follow-up on ${pick.account.label}`; s.account = pick.account.label; s.result = null; s.finishedAt = null; s.onDisk = null;
    s.legBase = s.legs.length; s.crashStreak = 0; s.noProgress = 0; s.stallCount = 0; s.sentFollowUp = true;
    s.plan = { kind: 'resume', reason: 'follow-up', promptFile: state.file(id, `send-${n}.md`), avoid: [], prefer: 'same' };
    s.supervisor = { pid: process.pid, start: proc.selfStart(), starter: true };
  });
  const pid = sup.spawnSupervisor(id);
  const start_ = pid ? proc.pidStart(pid) : null;
  state.update(id, s => { s.supervisor = pid ? { pid, start: start_, spawnedAt: Date.now() } : null; });
  return { id, account: pick.account.label, state: 'starting' };
}

module.exports = { start, status, result, wait, stop, send, recoverOne, recoverAll, summary, UserError, needId };
