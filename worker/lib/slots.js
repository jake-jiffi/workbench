'use strict';
// Worker slots: how many workers each account is carrying. Reserving one is atomic (a lock around count-then-create)
// and a slot whose owner process is dead is cleared the next time anyone counts.
const fs = require('fs');
const path = require('path');
const { cfg } = require('./config');
const fsx = require('./fsx');
const proc = require('./proc');

function root() { return path.join(cfg().home, 'slots'); }
function lockPath() { return path.join(cfg().home, 'locks', 'slots'); }

function readAll() {
  const out = [];
  let accts = [];
  try { accts = fs.readdirSync(root()); } catch { return out; }
  for (const a of accts) {
    let ids = [];
    try { ids = fs.readdirSync(path.join(root(), a)); } catch { continue; }
    for (const id of ids) {
      if (id.startsWith('.tmp-')) continue;
      const f = path.join(root(), a, id);
      out.push({ account: a, id, file: f, ...(fsx.readJson(f) || { corrupt: true, at: 0 }) });
    }
  }
  return out;
}

function isLive(s) {
  const c = cfg();
  if (s.corrupt) return false;
  if (s.pid) return proc.isAlive(s.pid, s.start);
  return Date.now() - s.at < c.slotClaimMs; // claimed by `start`, supervisor not up yet
}

/** Live slots, with the dead ones removed. Call with the slots lock held when the answer decides a reservation. */
function sweep() {
  const live = [];
  for (const s of readAll()) {
    if (isLive(s)) live.push(s);
    else { try { fs.unlinkSync(s.file); } catch { /* raced */ } }
  }
  return live;
}

function withSlots(fn) {
  fsx.ensureDir(path.dirname(lockPath()));
  return fsx.withLockSync(lockPath(), fn);
}

function counts(live, exceptId) {
  const per = {};
  let total = 0;
  for (const s of live) {
    if (s.id === exceptId) continue;
    per[s.account] = (per[s.account] || 0) + 1;
    total++;
  }
  return { per, total };
}

function write(account, id, extra) {
  fsx.ensureDir(path.join(root(), account));
  fsx.atomicWrite(path.join(root(), account, id), { id, account, at: Date.now(), ...extra });
}

/** Take a slot for id on account. Returns false when the account or the fleet is full. force skips the caps. */
function reserve(account, id, { force = false, pid, start } = {}) {
  const c = cfg();
  return withSlots(() => {
    const live = sweep();
    const { per, total } = counts(live, id);
    if (!force && ((per[account] || 0) >= c.perAccount || total >= c.maxTotal)) return false;
    for (const s of live) if (s.id === id && s.account !== account) { try { fs.unlinkSync(s.file); } catch { /* ignore */ } }
    write(account, id, pid ? { pid, start } : {});
    return true;
  });
}

/** The supervisor takes over a slot the starter claimed. */
function stamp(account, id, pid, start) {
  withSlots(() => write(account, id, { pid, start }));
}

function releaseSlot(id, account) {
  const dirs = account ? [account] : (() => { try { return fs.readdirSync(root()); } catch { return []; } })();
  for (const a of dirs) { try { fs.unlinkSync(path.join(root(), a, id)); } catch { /* none */ } }
}

function snapshot() {
  return withSlots(() => {
    const live = sweep();
    return { live, ...counts(live) };
  });
}

module.exports = { write, reserve, stamp, releaseSlot, snapshot, sweep, withSlots, counts };
