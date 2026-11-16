'use strict';
// Choosing an account for a worker. Eligible means: signed in, a fresh reading, both meters below 90, no recent
// limit error, and a free slot. An account that cannot be read never has room.
const { cfg } = require('./config');
const accounts = require('./accounts');
const usage = require('./usage');
const slots = require('./slots');

/** Why an account cannot take a new worker, or null when it can. Pure given its inputs. */
function ineligibleReason(reading, cooling, counts, acct, { exceptId, now = Date.now() } = {}) {
  const c = cfg();
  if (!reading || !reading.ok) {
    const e = reading && reading.error;
    if (e === 'authentication_failed') return 'not signed in';
    return `unreadable (${e || 'no reading'})`;
  }
  if (reading.signedIn === false) return 'not signed in';
  if (!usage.isFresh(reading, now)) return 'reading is stale';
  if (cooling && cooling.active) return `cooling: ${cooling.why}`;
  const s = reading.session.percent, w = reading.week.percent;
  if (s >= c.eligibleBelow) return `5-hour at ${s}%`;
  if (w >= c.eligibleBelow) return `weekly at ${w}%`;
  if ((counts.per[acct.label] || 0) >= c.perAccount) return `${counts.per[acct.label]} of ${c.perAccount} slots used`;
  if (counts.total >= c.maxTotal) return `fleet full (${counts.total} of ${c.maxTotal})`;
  return null;
}

/** Fresh readings for every account (concurrent), re-probing where cooling needs a newer reading. */
async function readAll(list, { force = false, maxAgeMs } = {}) {
  return Promise.all(list.map(async acct => {
    let reading = await usage.getReading(acct, { force, maxAgeMs });
    let cooling = usage.coolingStatus(acct.label, reading);
    if (cooling.expired || cooling.needsProbe) {
      reading = await usage.getReading(acct, { force: true });
      cooling = usage.coolingStatus(acct.label, reading);
    }
    return { acct, reading, cooling };
  }));
}

function headroom(r) { return 100 - Math.max(r.session.percent, r.week.percent); }

/** Best first: callers' own account last, then most headroom, then label for a stable order. */
function rank(rows, caller) {
  return rows.slice().sort((a, b) => {
    const ac = a.acct.label === caller ? 1 : 0, bc = b.acct.label === caller ? 1 : 0;
    if (ac !== bc) return ac - bc;
    const h = headroom(b.reading) - headroom(a.reading);
    return h !== 0 ? h : a.acct.label.localeCompare(b.acct.label);
  });
}

/**
 * Pick an account and reserve a slot for worker `id`, atomically. Readings are gathered first (probes are slow and
 * run outside the lock); the count, the choice and the reservation happen inside the slots lock.
 *   pin     only this account (first leg of `start --account`)
 *   force   with pin: skip the eligibility checks and the caps
 *   avoid   accounts that must not be chosen
 *   prefer  an account to take first if it is eligible
 * Returns {account, why} where account is null when nothing has room, and why lists each account's reason.
 */
async function pickAndReserve({ id, pin, force = false, avoid = [], prefer, forceProbe = false, maxAgeMs }) {
  const list = accounts.listAccounts();
  const caller = accounts.callerAccount();
  const rows = await readAll(pin ? list.filter(a => a.label === pin) : list, { force: forceProbe, maxAgeMs });
  if (pin && !rows.length) return { account: null, why: { [pin]: 'no such account' } };
  return slots.withSlots(() => {
    const live = slots.sweep();
    const counts = slots.counts(live, id);
    const why = {};
    const ok = [];
    for (const row of rows) {
      let r = ineligibleReason(row.reading, row.cooling, counts, row.acct);
      if (force && pin) {
        r = null;
      } else if (!r && avoid.includes(row.acct.label)) r = 'avoided for this move';
      why[row.acct.label] = r;
      if (!r) ok.push(row);
    }
    if (!ok.length) return { account: null, why };
    let ranked = rank(ok, caller);
    if (prefer) {
      const p = ranked.find(r => r.acct.label === prefer);
      if (p) ranked = [p, ...ranked.filter(r => r !== p)];
    }
    const chosen = ranked[0];
    for (const x of live) if (x.id === id && x.account !== chosen.acct.label) { try { require('fs').unlinkSync(x.file); } catch { /* ignore */ } }
    slots.write(chosen.acct.label, id, {});
    return { account: chosen.acct, why, reading: chosen.reading };
  });
}

/**
 * Could a running worker carry on at `label`? Used for resume on the same account: not cooling, a fresh reading,
 * and below the hand-over line (94), not the 90 line for new work.
 */
async function canContinueOn(label) {
  const c = cfg();
  const acct = accounts.findAccount(label);
  if (!acct) return false;
  const reading = await usage.getReading(acct, {});
  if (!reading.ok || reading.signedIn === false || !usage.isFresh(reading)) return false;
  if (usage.coolingStatus(label, reading).active) return false;
  return Math.max(reading.session.percent, reading.week.percent) < c.handoverAt;
}

/** Is there another account that could take this worker right now? Does not reserve. */
async function otherEligible(id, exclude) {
  const list = accounts.listAccounts().filter(a => !exclude.includes(a.label));
  const rows = await readAll(list, {});
  const counts = slots.counts(slots.snapshot().live, id);
  return rows.some(row => !ineligibleReason(row.reading, row.cooling, counts, row.acct));
}

/** The table `accounts` prints. */
async function overview() {
  const list = accounts.listAccounts();
  const rows = await readAll(list, {});
  const snap = slots.snapshot();
  const caller = accounts.callerAccount();
  return rows.map(({ acct, reading, cooling }) => {
    const reason = ineligibleReason(reading, cooling, snap, acct);
    return {
      account: acct.label,
      org: reading.org || null,
      plan: reading.plan || null,
      session: reading.ok ? reading.session.percent : null,
      sessionAssumed: reading.ok ? !!reading.session.assumed : null,
      week: reading.ok ? reading.week.percent : null,
      weekResets: reading.ok ? reading.week.resets || null : null,
      readingAgeSec: reading.at ? Math.max(0, Math.round((Date.now() - reading.at) / 1000)) : null,
      slots: snap.per[acct.label] || 0,
      eligible: reason === null,
      reason: reason,
      caller: acct.label === caller,
    };
  });
}

module.exports = { pickAndReserve, canContinueOn, otherEligible, overview, ineligibleReason, readAll, rank };
