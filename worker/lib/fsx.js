'use strict';
// File helpers: atomic writes, tolerant reads, and directory locks that survive their owner dying.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const proc = require('./proc');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
const rand = () => crypto.randomBytes(4).toString('hex');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Temp file in the same folder, fsync, then rename. A reader sees the old file or the new one, never half. */
function atomicWrite(file, data, { keepPrev = false } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.tmp-${path.basename(file)}-${process.pid}-${rand()}`);
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    const buf = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (keepPrev) {
    const prev = file + '.prev';
    try { fs.unlinkSync(prev); } catch { /* none yet */ }
    try { fs.linkSync(file, prev); } catch { /* no current file yet */ }
  }
  fs.renameSync(tmp, file);
}

/** Parsed JSON, or undefined when the file is missing, empty or corrupt. */
function readJson(file) {
  try {
    const t = fs.readFileSync(file, 'utf8');
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Remove temp files a killed writer left behind. */
function cleanTmp(dir, olderMs = 60_000) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const n of names) {
    if (!n.startsWith('.tmp-')) continue;
    try {
      const p = path.join(dir, n);
      if (now - fs.statSync(p).mtimeMs > olderMs) fs.unlinkSync(p);
    } catch { /* raced */ }
  }
}

// ---- directory locks ----
// A lock is a directory holding owner.json {pid,start}. It is stale when the owner is dead (pid plus process
// start time, so a reused pid does not keep it alive) or when it is older than maxAge.
function ownerOf(lock) { return readJson(path.join(lock, 'owner.json')); }

function tryAcquire(lock, maxAgeMs) {
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const o = ownerOf(lock);
    let stale = false;
    let age = 0;
    try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch { return false; }
    if (!o) stale = age > 3000; // owner file not written yet: give the creator a moment
    else stale = !proc.isAlive(o.pid, o.start) || age > maxAgeMs;
    if (!stale) return false;
    const dead = `${lock}.dead-${process.pid}-${rand()}`;
    try { fs.renameSync(lock, dead); } catch { return false; } // only one stealer wins the rename
    try { fs.rmSync(dead, { recursive: true, force: true }); } catch { /* ignore */ }
    return false; // caller retries mkdir
  }
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, start: proc.selfStart(), at: Date.now() }), { mode: 0o600 });
  } catch { /* lock removed under us; the retry loop copes */ }
  return true;
}

function release(lock) { try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ } }

function withLockSync(lock, fn, { timeoutMs = 20_000, maxAgeMs = 120_000 } = {}) {
  const t0 = Date.now();
  while (!tryAcquire(lock, maxAgeMs)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for lock ${path.basename(lock)}`);
    sleepSync(10 + Math.floor(Math.random() * 20));
  }
  try { return fn(); } finally { release(lock); }
}

async function withLock(lock, fn, { timeoutMs = 20_000, maxAgeMs = 120_000 } = {}) {
  const t0 = Date.now();
  while (!tryAcquire(lock, maxAgeMs)) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for lock ${path.basename(lock)}`);
    await sleep(10 + Math.floor(Math.random() * 20));
  }
  try { return await fn(); } finally { release(lock); }
}

module.exports = { sleep, sleepSync, ensureDir, atomicWrite, readJson, cleanTmp, withLockSync, withLock, rand };
