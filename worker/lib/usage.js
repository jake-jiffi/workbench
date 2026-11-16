'use strict';
// Reading an account's two meters, caching the reading, and remembering which accounts hit a limit.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { cfg } = require('./config');
const fsx = require('./fsx');
const accounts = require('./accounts');
const proc = require('./proc');

// Parses the two lines `claude -p /usage` prints (5-hour and weekly), with the regexes below.
const METER = /^\s*Current (session|week \(all models\))[^:\n]*:\s*(\d{1,3}(?:\.\d+)?)%\s*used(?:\s*[·•-]\s*resets\s+([^\n]+?))?\s*$/i;
const ERRORS = [
  { re: /credit|billing|payment|out of (?:extra )?usage|spend limit|plan limit/i, kind: 'billing_error' },
  { re: /log(?:ged)? ?in|sign(?:ed)? ?in|auth|expired|token|\b401\b/i, kind: 'authentication_failed' },
  { re: /rate.?limit|too many requests|\b429\b|overload/i, kind: 'rate_limit' },
];

/**
 * Parse `claude -p /usage`. Week is required: with no week line the reading is unreadable. A missing session line
 * with a week line present means no 5-hour window is open (seen on a real account), so the session counts as 0 and
 * is flagged `assumed`.
 */
function parseUsage(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = METER.exec(line);
    if (!m) continue;
    const meter = { percent: Math.min(100, Math.ceil(Number(m[2]))), resets: m[3] ? m[3].trim().slice(0, 48) : undefined };
    if (m[1].toLowerCase() === 'session') out.session = meter; else out.week = meter;
  }
  if (!out.week) {
    const t = String(text);
    out.error = !t.trim() ? 'unreadable' : (ERRORS.find(e => e.re.test(t)) || {}).kind || 'unreadable';
    delete out.session;
    return out;
  }
  if (!out.session) out.session = { percent: 0, assumed: true };
  return out;
}

function parseAuth(text) {
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== 'object') return null;
    return { loggedIn: d.loggedIn === true, org: typeof d.orgName === 'string' ? d.orgName.slice(0, 60) : undefined, plan: typeof d.subscriptionType === 'string' ? d.subscriptionType.slice(0, 20) : undefined };
  } catch {
    return null;
  }
}

function dirs() {
  const c = cfg();
  return { readings: path.join(c.home, 'readings'), cooling: path.join(c.home, 'cooling'), locks: path.join(c.home, 'locks'), probe: path.join(c.home, 'probe') };
}

/** Run the real binary with a timeout and a cap on output; the whole process group is killed on timeout. */
function runCapture(args, acct, timeoutMs) {
  const c = cfg();
  const d = dirs();
  fsx.ensureDir(d.probe);
  return new Promise(resolve => {
    let out = '';
    let done = false;
    let child;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try {
      child = spawn(c.bin, args, { cwd: d.probe, env: accounts.childEnv(acct), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      return resolve({ ok: false, why: 'spawn: ' + e.code });
    }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      finish({ ok: false, why: 'timeout', out });
    }, timeoutMs);
    const take = b => { if (out.length < 65_536) out += b.toString('utf8'); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', e => finish({ ok: false, why: 'spawn: ' + e.code }));
    child.on('close', code => finish({ ok: code === 0, why: code === 0 ? '' : `exit ${code}`, out }));
  });
}

async function probe(acct) {
  const c = cfg();
  const at = Date.now();
  // A config folder that does not exist is not signed in. Do not start claude on it: it would create the folder.
  if (!acct.home && !fs.existsSync(acct.dir)) return { account: acct.label, at, ok: false, error: `config folder not found: ${acct.dir}` };
  const u = await runCapture(['-p', '/usage', '--no-session-persistence'], acct, c.probeTimeoutMs);
  const reading = { account: acct.label, at, ok: false };
  if (u.why === 'timeout') { reading.error = 'timeout'; return reading; }
  const parsed = parseUsage(u.out || '');
  if (parsed.error || !u.out) { reading.error = parsed.error || 'unreadable'; reading.detail = u.why || undefined; }
  else { reading.ok = true; reading.session = parsed.session; reading.week = parsed.week; }
  // Org and plan, and a second opinion on the sign-in. Failure here never makes a good reading bad.
  const a = await runCapture(['auth', 'status', '--json'], acct, Math.min(c.probeTimeoutMs, 15_000));
  const auth = a.ok ? parseAuth(a.out || '') : null;
  if (auth) {
    reading.org = auth.org; reading.plan = auth.plan; reading.signedIn = auth.loggedIn;
    if (!auth.loggedIn) { reading.ok = false; reading.error = 'authentication_failed'; }
  } else {
    reading.signedIn = reading.ok ? true : undefined;
  }
  return reading;
}

function readingFile(label) { return path.join(dirs().readings, label + '.json'); }
function cachedReading(label) { return fsx.readJson(readingFile(label)); }

function isFresh(r, now = Date.now()) {
  if (!r || typeof r.at !== 'number') return false;
  const age = now - r.at;
  if (age < -60_000) return false; // from the future: clock moved, do not trust
  return age <= (r.ok ? cfg().freshMs : cfg().probeNegativeMs);
}

/**
 * A reading no older than the fresh window. Otherwise probe, one probe per account at a time: a second caller waits
 * on the lock, then finds the first caller's fresh reading and uses it.
 */
async function getReading(acct, { force = false, maxAgeMs } = {}) {
  const c = cfg();
  const d = dirs();
  const ok = (r, now) => r && (maxAgeMs !== undefined ? (r.ok && now - r.at <= maxAgeMs) || (!r.ok && isFresh(r, now)) : isFresh(r, now));
  let r = cachedReading(acct.label);
  if (!force && ok(r, Date.now())) return r;
  fsx.ensureDir(d.readings); fsx.ensureDir(d.locks);
  const startedWaiting = Date.now();
  try {
    return await fsx.withLock(path.join(d.locks, 'probe-' + acct.label), async () => {
      const again = cachedReading(acct.label);
      if (again && (force ? again.at >= startedWaiting : ok(again, Date.now()))) return again;
      const fresh = await probe(acct);
      fsx.atomicWrite(readingFile(acct.label), fresh);
      return fresh;
    }, { timeoutMs: c.probeTimeoutMs * 2 + 10_000, maxAgeMs: c.probeTimeoutMs * 4 });
  } catch {
    return cachedReading(acct.label) || { account: acct.label, at: 0, ok: false, error: 'unreadable' };
  }
}

// ---- cooling ----
function coolingFile(label) { return path.join(dirs().cooling, label + '.json'); }

/** Mark an account as having hit a limit (or an auth failure). until is an epoch in ms, or null for "until a probe says". */
function markCooling(label, kind, until, reason) {
  const now = Date.now();
  let u = typeof until === 'number' && until > now && until < now + 8 * 86_400_000 ? until : null;
  fsx.ensureDir(dirs().cooling);
  const prev = fsx.readJson(coolingFile(label));
  if (prev && prev.until && u && prev.until > u) u = prev.until;
  fsx.atomicWrite(coolingFile(label), { account: label, kind, since: now, until: u, reason: String(reason || '').slice(0, 200) });
  // The reading that led here is no longer to be trusted either way.
  try { fs.unlinkSync(readingFile(label)); } catch { /* none */ }
}

/**
 * {active, why}. A stated reset holds the account until then. With none, it is held for the floor, then until a
 * reading taken after the floor shows room (a probe, not a guess).
 */
function coolingStatus(label, reading, now = Date.now()) {
  const c = cfg();
  const f = coolingFile(label);
  const s = fsx.readJson(f);
  if (!s) return { active: false };
  if (s.until) {
    if (now < s.until) return { active: true, why: `${s.kind} until ${new Date(s.until).toISOString()}` };
    try { fs.unlinkSync(f); } catch { /* raced */ }
    try { fs.unlinkSync(readingFile(label)); } catch { /* none */ }
    return { active: false, expired: true };
  }
  if (now - s.since < c.coolFloorMs) return { active: true, why: `${s.kind}, no reset stated, held ${Math.ceil((c.coolFloorMs - (now - s.since)) / 1000)}s more` };
  if (reading && reading.ok && reading.at >= s.since + c.coolFloorMs && isFresh(reading, now) && meters(reading).every(p => p < c.eligibleBelow)) {
    try { fs.unlinkSync(f); } catch { /* raced */ }
    return { active: false };
  }
  return { active: true, needsProbe: !reading || !(reading.at >= s.since + c.coolFloorMs), why: `${s.kind}, waiting for a reading that shows room` };
}

function meters(r) { return [r.session.percent, r.week.percent]; }

module.exports = { parseUsage, parseAuth, probe, getReading, cachedReading, isFresh, markCooling, coolingStatus, meters, dirs };
