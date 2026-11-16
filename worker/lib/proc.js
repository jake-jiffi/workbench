'use strict';
// Process identity and killing. A pid alone is not an identity (pids are reused), so every record keeps the
// process start time from `ps -o lstart=` beside it.
const { execFileSync } = require('child_process');

const PS_ENV = { PATH: '/bin:/usr/bin', LC_ALL: 'C' };

function pidStart(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: PS_ENV, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.trim() || null;
  } catch {
    return null;
  }
}

let own = null;
function selfStart() { if (!own) own = pidStart(process.pid); return own; }

/** True when pid exists and (if start is given) is the same process that was recorded. */
function isAlive(pid, start) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  if (!start) return true;
  const now = pidStart(pid);
  return now !== null && now === start;
}

/** [{pid, ppid, pgid}] for every process. */
function table() {
  try {
    const out = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { env: PS_ENV, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map(l => l.trim().split(/\s+/).map(Number)).filter(a => a.length === 3 && a.every(Number.isFinite)).map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
  } catch {
    return [];
  }
}

/**
 * Every pid in the tree below root (while root is alive), plus every pid in root's process group. A group cannot
 * outlive its members, so a pgid match is ours even after the leader has exited.
 */
function treeOf(root, rootAlive = true) {
  const t = table();
  const set = new Set();
  if (rootAlive) {
    set.add(root);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of t) if (set.has(p.ppid) && !set.has(p.pid)) { set.add(p.pid); grew = true; }
    }
  }
  for (const p of t) if (p.pgid === root) set.add(p.pid);
  return [...set];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function safeKill(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return;
  try { process.kill(pid, sig); } catch { /* gone */ }
}

/**
 * Stop a worker's whole tree: SIGTERM the group and every descendant, wait, then SIGKILL what is left.
 * root must be the child the caller started (a group leader). Returns the pids that were in the tree.
 */
async function killTree(root, graceMs = 5000, rootStart = null) {
  if (!Number.isInteger(root) || root <= 1) return [];
  const rootAlive = alive(root);
  // The pid is alive but is not the process we recorded: it was reused. Touch nothing.
  if (rootAlive && rootStart && pidStart(root) !== rootStart) return [];
  const pids = treeOf(root, rootAlive).filter(p => p !== process.pid);
  const send = sig => {
    safeKill(-root, sig);
    for (const p of pids) safeKill(p, sig);
  };
  send('SIGTERM');
  const t0 = Date.now();
  while (Date.now() - t0 < graceMs) {
    if (!pids.some(p => alive(p) && !isZombie(p))) return pids;
    await sleep(50);
  }
  send('SIGKILL');
  await sleep(100);
  return pids;
}

function isZombie(pid) {
  try {
    return execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { env: PS_ENV, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().startsWith('Z');
  } catch { return true; }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

module.exports = { pidStart, selfStart, isAlive, table, treeOf, killTree, alive, isZombie };
