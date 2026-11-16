'use strict';
// One supervisor per worker. It launches each leg of the worker's conversation, watches the stream, and decides what
// happens when a leg ends: done, failed, or another leg (on this account or another). It is detached from whoever
// started it, so it outlives the main session and any account move. All state changes go through state.update.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { cfg } = require('./config');
const fsx = require('./fsx');
const proc = require('./proc');
const accounts = require('./accounts');
const usage = require('./usage');
const slots = require('./slots');
const select = require('./select');
const state = require('./state');
const launch = require('./launch');
const { StreamTracker } = require('./stream');
const { classifyText } = require('./classify');

const sleep = fsx.sleep;
const log = (id, msg) => process.stderr.write(`${new Date().toISOString()} ${id} ${msg}\n`);
const stopFile = id => state.file(id, 'stop');
const stopRequested = id => fs.existsSync(stopFile(id));
const openLeg = st => { const l = st.legs[st.legs.length - 1]; return l && !l.endedAt ? l : null; };
const legsUsed = st => st.legs.length - (st.legBase || 0);

// ---- finishing ----
function finish(id, stateName, reason, extra = {}) {
  const spec = state.readSpec(id) || {};
  const disk = state.onDisk(spec.worktree || '.');
  const cur = state.load(id);
  if (!cur || !state.isTerminal(cur.state) || extra.override) {
    fsx.atomicWrite(state.file(id, 'final.json'), { state: stateName, reason, finishedAt: Date.now(), onDisk: disk, result: extra.result || null });
  }
  const st = state.update(id, s => {
    if (state.isTerminal(s.state) && !(extra.override)) return;
    s.state = stateName; s.reason = reason; s.finishedAt = Date.now(); s.onDisk = disk; s.plan = null; s.waiting = null;
    if (extra.result) s.result = extra.result;
    const l = openLeg(s);
    if (l) { l.endedAt = Date.now(); l.endReason = l.endReason || stateName; }
  });
  if (extra.result && typeof extra.result.text === 'string') fsx.atomicWrite(state.file(id, 'result.txt'), extra.result.text);
  slots.releaseSlot(id);
  return st;
}

// ---- launching ----
async function stagger(label) {
  const c = cfg();
  if (!c.staggerMs) return;
  const dir = path.join(c.home, 'stagger');
  fsx.ensureDir(dir);
  const f = path.join(dir, label);
  const at = fsx.withLockSync(path.join(c.home, 'locks', 'stagger-' + label), () => {
    const last = Number(fsx.readJson(f)) || 0;
    const t = Math.max(Date.now(), last + c.staggerMs);
    fsx.atomicWrite(f, String(t));
    return t;
  });
  const wait = at - Date.now();
  if (wait > 0) await sleep(wait);
}

function promptFor(id, st, spec, plan, n) {
  const f = state.file(id, `leg-${n}.prompt.md`);
  let text;
  if (plan.promptFile) text = fs.readFileSync(plan.promptFile, 'utf8');
  else if (!st.sessionId || plan.kind === 'first') text = fs.readFileSync(state.file(id, 'brief.md'), 'utf8');
  else text = launch.CONTINUE(plan.reason || 'the previous run stopped');
  fsx.atomicWrite(f, text);
  return f;
}

/** Start one leg on acct. Returns {child, leg} (child is null if the process could not be started). */
async function launchLeg(id, st, spec, acct, plan) {
  const c = cfg();
  const n = st.legs.length + 1;
  const dir = state.dirOf(id);
  const resume = plan.kind !== 'first' && st.sessionId ? st.sessionId : null;
  const sessionId = resume ? null : crypto.randomUUID();
  const settingsFile = launch.writeSettings(dir);
  const promptFile = promptFor(id, st, spec, resume ? plan : { ...plan, kind: 'first' }, n);
  const outName = `leg-${n}.out.jsonl`, errName = `leg-${n}.err`;
  const args = launch.buildArgs(spec, { settingsFile, resume, sessionId });
  const meta = { n, account: acct.label, startedAt: Date.now(), why: plan.reason || plan.kind, kind: resume ? 'resume' : 'first', resumed: resume, plannedSession: sessionId, out: outName, err: errName, args: args.filter(a => a !== settingsFile) };
  fsx.atomicWrite(state.file(id, `leg-${n}.json`), meta);
  await stagger(acct.label);

  const outFd = fs.openSync(state.file(id, outName), 'a', 0o600);
  const errFd = fs.openSync(state.file(id, errName), 'a', 0o600);
  const inFd = fs.openSync(promptFile, 'r');
  const useCaf = c.caffeinate && fs.existsSync(c.caffeinate);
  const exe = useCaf ? c.caffeinate : c.bin;
  const argv = useCaf ? ['-i', c.bin, ...args] : args;
  let child = null;
  let spawnError = null;
  try {
    child = spawn(exe, argv, { cwd: spec.worktree, env: accounts.childEnv(acct), stdio: [inFd, outFd, errFd], detached: true });
    child.on('error', e => { spawnError = e; });
    child.unref();
  } catch (e) {
    spawnError = e;
  } finally {
    for (const fd of [inFd, outFd, errFd]) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  const pid = child && child.pid ? child.pid : null;
  const pstart = pid ? proc.pidStart(pid) : null;
  const leg = { ...meta, pid, start: pstart, sessionId: resume || null, progress: 0, endedAt: null };
  if (pid) fsx.atomicWrite(state.file(id, `leg-${n}.json`), { ...meta, pid, start: pstart });
  state.update(id, s => {
    s.legs.push(leg); s.account = acct.label; s.state = 'running'; s.plan = null; s.waiting = null;
    s.reason = `leg ${n} on ${acct.label}` + (plan.reason && plan.kind !== 'first' ? ` (${plan.reason})` : '');
    if (!pid) { leg.spawnError = String(spawnError && (spawnError.code || spawnError.message)); }
  });
  return { child: pid ? child : null, leg, spawnError };
}

// ---- watching a leg ----
function tail(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, bytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

async function monitor(ctx, id, spec, leg, child, launched) {
  const c = cfg();
  const outPath = state.file(id, leg.out);
  const errPath = state.file(id, leg.err);
  const tracker = new StreamTracker();
  const acctLabel = leg.account;
  const acct = accounts.findAccount(acctLabel);
  let offset = 0;
  let exited = null;
  let killedBy = null;
  let lastOutputAt = Date.now();
  let lastBeat = 0;
  let lastProbe = 0;
  let reading = null;
  let errSeenAt = null;
  let lastHandoverCheck = 0;
  const startedAt = leg.startedAt || Date.now();

  if (child) child.on('exit', (code, signal) => { exited = { code, signal }; });
  if (launched && launched.spawnError && !child) exited = { code: null, signal: null, spawnError: String(launched.spawnError.code || launched.spawnError.message) };
  // Adopting a leg whose process is not ours: dead unless it is alive with the start time we recorded.
  const adopted = !child && !exited;
  if (adopted && !(leg.pid && proc.isAlive(leg.pid, leg.start))) exited = { code: null, signal: null, unknown: true };

  const pump = () => {
    let fd;
    try { fd = fs.openSync(outPath, 'r'); } catch { return; }
    try {
      const size = fs.fstatSync(fd).size;
      while (offset < size) {
        const len = Math.min(size - offset, 1 << 20);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, offset);
        if (n <= 0) break;
        offset += n;
        tracker.feed(buf.slice(0, n).toString('utf8'));
        lastOutputAt = Date.now();
      }
    } finally { fs.closeSync(fd); }
  };

  const kill = async why => {
    killedBy = killedBy || why;
    await proc.killTree(leg.pid, c.killGraceMs, leg.start);
    if (child && !exited) { const t0 = Date.now(); while (!exited && Date.now() - t0 < 3000) await sleep(20); }
    if (!exited) exited = { code: null, signal: 'SIGKILL' };
  };

  for (;;) {
    pump();
    if (!exited && !child && !proc.alive(leg.pid)) exited = { code: null, signal: null, unknown: true };
    if (exited) break;
    if (ctx.exitNow || ctx.lost) return { detach: true };
    const now = Date.now();

    if (stopRequested(id)) { await kill('stop'); break; }

    if (now - lastBeat >= c.heartbeatMs) {
      lastBeat = now;
      const st = state.update(id, s => {
        if (s.supervisor && s.supervisor.pid !== process.pid) { ctx.lost = true; return; }
        s.supervisor = { ...(s.supervisor || {}), pid: process.pid, start: proc.selfStart(), heartbeat: now };
        const l = openLeg(s);
        if (l) { l.progress = tracker.progress; l.sessionId = tracker.sessionId || l.sessionId; l.inFlight = tracker.inFlight; l.lastOutputAt = lastOutputAt; }
        if (tracker.sessionId) s.sessionId = tracker.sessionId;
      });
      if (ctx.lost) return { detach: true };
      void st;
    }

    // An account problem seen in the stream: give the process a moment to exit by itself, then stop it.
    const acctErr = tracker.errors.find(e => e.kind === 'limit' || e.kind === 'auth');
    if (acctErr && !tracker.succeeded) {
      errSeenAt = errSeenAt || now;
      if (now - errSeenAt > c.limitGraceMs) { await kill('account-error'); break; }
    }

    // Stall.
    if (tracker.inFlight === 0 && now - lastOutputAt > c.stallIdleMs) { await kill('stall'); break; }
    const oldest = tracker.oldestToolAt;
    if (tracker.inFlight > 0 && oldest !== null && now - oldest > c.stallToolMs) { await kill('stall'); break; }

    // Keep the account's reading current, and hand over at a safe point once it reaches the line.
    if (acct && now - lastProbe >= c.probeEveryMs) {
      lastProbe = now;
      try { reading = await usage.getReading(acct, { maxAgeMs: c.probeEveryMs }); } catch { /* keep the old one */ }
    }
    if (reading && reading.ok && Math.max(reading.session.percent, reading.week.percent) >= c.handoverAt &&
        tracker.inFlight === 0 && now - startedAt >= c.minLegMsForHandover && now - lastHandoverCheck > 2000) {
      lastHandoverCheck = now;
      const st = state.load(id);
      if (st && legsUsed(st) < c.maxLegs && await select.otherEligible(id, [acctLabel])) {
        // Re-check at the moment of acting: a tool may have started while we were looking.
        pump();
        if (tracker.inFlight === 0) { await kill('handover'); break; }
      }
    }
    await sleep(c.tickMs);
  }

  // Final read, then clean up anything the leg left running in its group.
  await sleep(50);
  pump();
  tracker.finish();
  if (leg.pid) await proc.killTree(leg.pid, 1000, leg.start);
  return { tracker, exited, killedBy, adopted, errTail: tail(errPath, 4096), endedAt: Date.now() };
}

// ---- deciding what a leg's end means ----
function lastLine(t) { return String(t || '').trim().split('\n').pop().slice(0, 200); }

function afterLeg(ctx, id, spec, leg, out) {
  const c = cfg();
  const t = out.tracker;
  const exitDesc = out.exited ? (out.exited.signal ? `signal ${out.exited.signal}` : out.exited.unknown ? 'exit unknown' : out.exited.spawnError ? `spawn failed ${out.exited.spawnError}` : `exit ${out.exited.code}`) : 'exit unknown';

  const mark = (endReason, extra = {}) => state.update(id, s => {
    const l = s.legs.find(x => x.n === leg.n);
    if (l) { l.endedAt = out.endedAt; l.endReason = endReason; l.progress = t.progress; l.sessionId = t.sessionId || l.sessionId; l.exit = exitDesc; Object.assign(l, extra); }
    if (t.sessionId) s.sessionId = t.sessionId;
    s.supervisor = { ...(s.supervisor || {}), heartbeat: Date.now() };
  });

  if (out.killedBy === 'stop' || stopRequested(id)) {
    mark('stopped');
    finish(id, 'stopped', 'stopped on request', { override: true });
    return 'terminal';
  }
  if (t.succeeded) {
    mark('result');
    const r = t.result;
    finish(id, 'done', 'result event received', { result: { text: r.result, subtype: r.subtype, sessionId: r.session_id || t.sessionId, costUsd: r.total_cost_usd, turns: r.num_turns, durationMs: r.duration_ms } });
    return 'terminal';
  }

  const progressed = t.progress > 0;
  let kind = (t.errors.find(e => e.kind === 'limit' || e.kind === 'auth') || {}).kind || null;
  let transient = t.errors.some(e => e.kind === 'transient');
  let resetAt = (t.errors.find(e => e.resetAt) || {}).resetAt || null;
  if (!kind && !t.result && !out.killedBy) {
    const k = classifyText(out.errTail);
    if (k === 'transient') transient = true; else kind = k;
  }
  const endNote = `${exitDesc}${lastLine(out.errTail) ? '; ' + lastLine(out.errTail) : ''}`;

  let plan = null;
  let failure = null;
  const patch = { transientStreak: 0 };

  if (kind) {
    usage.markCooling(leg.account, kind, resetAt, `${kind} on leg ${leg.n}`);
    plan = { kind: 'resume', reason: kind === 'limit' ? `limit on ${leg.account}` : `sign-in problem on ${leg.account}`, avoid: [leg.account], prefer: null };
    patch.crashStreak = 0; patch.noProgress = progressed ? 0 : undefined;
    mark(kind === 'limit' ? 'limit' : 'auth');
  } else if (out.killedBy === 'handover') {
    plan = { kind: 'resume', reason: `moved off ${leg.account} at ${cfg().handoverAt}%`, avoid: [leg.account], prefer: null };
    patch.crashStreak = 0; patch.noProgress = 0;
    mark('handover');
  } else if (out.killedBy === 'stall') {
    const n = (ctx.snapshot.stallCount || 0) + 1;
    patch.stallCount = n;
    mark('stall');
    if (n > 1) failure = `stalled twice (no stream output ${Math.round(c.stallIdleMs / 60000)} min with no tool, or a tool over ${Math.round(c.stallToolMs / 60000)} min)`;
    else plan = { kind: 'resume', reason: 'stalled; killed and resumed once', avoid: [], prefer: 'same' };
  } else if (transient) {
    // 5xx, overloaded, timeouts: the service, not the account. Back off, same account once, then another.
    const n = (ctx.snapshot.transientStreak || 0) + 1;
    const delay = Math.min(c.transientMaxMs, c.transientBackoffMs * 2 ** (n - 1));
    patch.transientStreak = n; patch.crashStreak = 0; patch.noProgress = 0;
    mark('transient');
    plan = { kind: 'resume', reason: `transient API error (${exitDesc}); backing off ${Math.round(delay / 1000)}s, ${n % 2 === 1 ? 'same account' : 'another account'}`, avoid: n % 2 === 1 ? [] : [leg.account], prefer: n % 2 === 1 ? 'same' : 'other', notBefore: Date.now() + delay };
  } else if (t.result) {
    mark('worker-error');
    failure = `worker reported an error: ${t.result.subtype || 'error'}${typeof t.result.result === 'string' ? ': ' + t.result.result.slice(0, 200) : ''}`;
  } else if (out.adopted && out.exited && out.exited.unknown && !out.killedBy) {
    // Our supervisor died; this process was not ours to wait on. Not the worker's fault: no crash count.
    mark('supervisor-lost');
    plan = { kind: 'resume', reason: 'supervisor was lost; adopted and resumed', avoid: [], prefer: 'same' };
  } else {
    // Crash: no result event. Exit 0 with no result lands here too.
    const streak = (ctx.snapshot.crashStreak || 0) + 1;
    const np = progressed ? 0 : (ctx.snapshot.noProgress || 0) + 1;
    patch.crashStreak = streak; patch.noProgress = np;
    mark('crash');
    if (np >= 2) failure = `two legs in a row made no progress (last: ${endNote})`;
    else plan = { kind: 'resume', reason: `crash (${exitDesc}); ${streak % 2 === 1 ? 'retrying on the same account' : 'trying another account'}`, avoid: streak % 2 === 1 ? [] : [leg.account], prefer: streak % 2 === 1 ? 'same' : 'other' };
  }

  state.update(id, s => {
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) s[k] = v;
    if (!failure && legsUsed(s) >= c.maxLegs) failure = `gave up after ${c.maxLegs} legs (last: ${plan ? plan.reason : endNote})`;
    if (!failure) { s.plan = plan; s.reason = `between legs: ${plan.reason}`; }
  });
  if (failure) { finish(id, 'failed', failure); return 'terminal'; }
  // Leaving the account? Free its slot now so someone else can use it.
  if (plan.prefer !== 'same') slots.releaseSlot(id, leg.account);
  return 'next';
}

// ---- choosing an account for the next leg ----
async function acquire(ctx, id, spec, st, plan) {
  const c = cfg();
  const first = st.legs.length === 0;
  const since = (st.waiting && st.waiting.since) || Date.now();
  let attempt = (st.waiting && st.waiting.attempt) || 0;
  while (plan.notBefore && Date.now() < plan.notBefore) {
    if (stopRequested(id) || ctx.exitNow) return null;
    await sleep(Math.min(200, plan.notBefore - Date.now()));
  }
  for (;;) {
    if (stopRequested(id) || ctx.exitNow) return null;
    st = state.load(id) || st;
    if (plan.prefer === 'same' && st.account && !(plan.avoid || []).includes(st.account)) {
      if (await select.canContinueOn(st.account)) {
        slots.reserve(st.account, id, { force: true });
        return accounts.findAccount(st.account);
      }
    }
    const pin = first && !st.sentFollowUp ? spec.pin : undefined;
    const common = { id, pin, force: !!(first && spec.force), maxAgeMs: attempt ? c.waitProbeMs : undefined };
    // The avoid list only shapes the first look; after that, cooling and the meters decide.
    let pick = await select.pickAndReserve({ ...common, avoid: attempt ? [] : plan.avoid || [], prefer: plan.prefer === 'same' ? st.account : undefined });
    if (!pick.account && plan.prefer === 'other' && st.account) pick = await select.pickAndReserve({ ...common, avoid: [] });
    if (pick.account) return pick.account;

    const why = Object.entries(pick.why).map(([k, v]) => `${k}: ${v}`).join('; ');
    const waited = Date.now() - since;
    if (waited > c.waitGiveUpMs) { finish(id, 'failed', `no account: nothing eligible for ${Math.round(waited / 60000)} min (${why})`); return null; }
    slots.releaseSlot(id);
    state.update(id, s => {
      if (state.isTerminal(s.state)) return;
      s.state = 'waiting'; s.reason = `waiting for an account: ${why}`;
      s.waiting = { since, last: Date.now(), attempt: attempt + 1, why: pick.why };
    });
    const delay = Math.min(c.waitMaxMs, c.waitBaseMs * 2 ** attempt);
    attempt++;
    const until = Date.now() + delay;
    while (Date.now() < until) {
      if (stopRequested(id) || ctx.exitNow) return null;
      await sleep(Math.min(c.waitPollMs, 200));
    }
  }
}

// ---- the loop ----
async function supervise(id) {
  const c = cfg();
  state.init();
  const ctx = { exitNow: false, lost: false, snapshot: {} };
  let dup = false;
  state.update(id, st => {
    if (state.isTerminal(st.state)) { dup = true; return; }
    const sv = st.supervisor;
    if (sv && sv.pid !== process.pid && proc.isAlive(sv.pid, sv.start)) { dup = true; return; }
    st.supervisor = { pid: process.pid, start: proc.selfStart(), claimedAt: Date.now(), heartbeat: Date.now() };
  });
  if (dup) { log(id, 'another supervisor owns this worker, or it is finished; exiting'); return; }
  process.on('SIGTERM', () => { ctx.exitNow = true; });
  process.on('SIGINT', () => { ctx.exitNow = true; });
  process.on('SIGHUP', () => { /* detached; ignore */ });
  const spec = state.readSpec(id);
  if (!spec) { finish(id, 'failed', 'spec.json is unreadable'); return; }

  try {
    for (;;) {
      if (ctx.exitNow || ctx.lost) return;
      let st = state.load(id);
      if (!st || state.isTerminal(st.state)) return;
      if (stopRequested(id)) {
        const l = openLeg(st);
        if (l && l.pid) await proc.killTree(l.pid, c.killGraceMs, l.start);
        finish(id, 'stopped', 'stopped on request');
        return;
      }
      ctx.snapshot = st;
      const open = openLeg(st);
      if (open) {
        if (st.account) slots.reserve(st.account, id, { force: true, pid: process.pid, start: proc.selfStart() });
        const out = await monitor(ctx, id, spec, open, null, null);
        if (out.detach) return;
        ctx.snapshot = state.load(id) || st;
        if (afterLeg(ctx, id, spec, open, out) === 'terminal') return;
        continue;
      }
      const plan = st.plan || { kind: st.legs.length ? 'resume' : 'first', reason: 'recovered', avoid: [], prefer: 'same' };
      if (st.legs.length && legsUsed(st) >= c.maxLegs) { finish(id, 'failed', `gave up after ${c.maxLegs} legs`); return; }
      const acct = await acquire(ctx, id, spec, st, plan);
      if (!acct) { if (ctx.exitNow) return; const cur = state.load(id); if (cur && stopRequested(id)) { finish(id, 'stopped', 'stopped on request'); } return; }
      slots.stamp(acct.label, id, process.pid, proc.selfStart());
      st = state.load(id);
      const { child, leg, spawnError } = await launchLeg(id, st, spec, acct, plan);
      ctx.snapshot = state.load(id) || st;
      const out = await monitor(ctx, id, spec, leg, child, { spawnError });
      if (out.detach) return;
      ctx.snapshot = state.load(id) || st;
      if (afterLeg(ctx, id, spec, leg, out) === 'terminal') return;
    }
  } catch (e) {
    log(id, 'supervisor error: ' + (e && e.stack || e));
    let dead = false;
    try {
      state.update(id, s => { s.supCrashes = (s.supCrashes || 0) + 1; s.lastSupError = String(e && e.message || e).slice(0, 300); if (s.supCrashes >= 3) dead = true; });
      if (dead) finish(id, 'failed', 'the supervisor crashed three times: ' + String(e && e.message || e).slice(0, 200));
    } catch { /* nothing more to do */ }
    process.exitCode = 1;
  }
}

/** Start a detached supervisor for id. Returns its pid. The caller records it in state under the worker lock. */
function spawnSupervisor(id) {
  const c = cfg();
  const logFd = fs.openSync(state.file(id, 'supervisor.log'), 'a', 0o600);
  const entry = path.resolve(__dirname, '..', 'cli.js');
  const child = spawn(process.execPath, [entry, '__supervise', id], { detached: true, stdio: ['ignore', logFd, logFd], env: accounts.childEnv(null, { supervisor: true }), cwd: c.home });
  fs.closeSync(logFd);
  child.on('error', () => { /* a dead pid is picked up by recover */ });
  child.unref();
  return child.pid || null;
}

module.exports = { supervise, spawnSupervisor, finish, stopFile, stopRequested, openLeg };
