'use strict';
// Every tunable in one place. Read at call time so tests can set env per process.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { workbenchHome } = require('./workspace');

function num(key, dflt) {
  const v = process.env[key];
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** The claude binary: CLAUDE_WORKER_BIN, else `claude` on PATH, else the usual install folders. */
function findClaude() {
  if (process.env.CLAUDE_WORKER_BIN) return process.env.CLAUDE_WORKER_BIN;
  const dirs = (process.env.PATH || '').split(':').filter(Boolean)
    .concat(['.local/bin', '.claude/local', '.npm-global/bin'].map(d => path.join(os.homedir(), d)), ['/opt/homebrew/bin', '/usr/local/bin']);
  for (const d of dirs) {
    const f = path.join(d, 'claude');
    try { if (fs.statSync(f).isFile()) { fs.accessSync(f, fs.constants.X_OK); return f; } } catch { /* next */ }
  }
  return 'claude';
}

function cfg() {
  const home = process.env.CLAUDE_WORKER_HOME || path.join(os.homedir(), '.claude', 'workers');
  return {
    home,
    bin: findClaude(),
    caffeinate: process.env.CLAUDE_WORKER_CAFFEINATE !== undefined ? process.env.CLAUDE_WORKER_CAFFEINATE : '/usr/bin/caffeinate',
    hooksDir: process.env.CLAUDE_WORKER_HOOKS_DIR || path.join(workbenchHome(), 'kit', 'hooks'),
    // thresholds
    eligibleBelow: num('CLAUDE_WORKER_ELIGIBLE_BELOW', 90), // both meters must be strictly below this
    handoverAt: num('CLAUDE_WORKER_HANDOVER_AT', 94), // a running worker moves at or above this
    freshMs: num('CLAUDE_WORKER_FRESH_MS', 5 * 60_000),
    perAccount: num('CLAUDE_WORKER_PER_ACCOUNT', 4),
    maxTotal: num('CLAUDE_WORKER_MAX_TOTAL', 20),
    maxLegs: num('CLAUDE_WORKER_MAX_LEGS', 5),
    // probing
    probeTimeoutMs: num('CLAUDE_WORKER_PROBE_TIMEOUT_MS', 30_000),
    probeNegativeMs: num('CLAUDE_WORKER_PROBE_NEGATIVE_MS', 60_000),
    probeEveryMs: num('CLAUDE_WORKER_PROBE_EVERY_MS', 3 * 60_000),
    // timing
    staggerMs: num('CLAUDE_WORKER_STAGGER_MS', 2000),
    heartbeatMs: num('CLAUDE_WORKER_HEARTBEAT_MS', 15_000),
    tickMs: num('CLAUDE_WORKER_TICK_MS', 500),
    killGraceMs: num('CLAUDE_WORKER_KILL_GRACE_MS', 5000),
    limitGraceMs: num('CLAUDE_WORKER_LIMIT_GRACE_MS', 3000),
    slotClaimMs: num('CLAUDE_WORKER_SLOT_CLAIM_MS', 30_000),
    minLegMsForHandover: num('CLAUDE_WORKER_MIN_LEG_MS', 30_000),
    // stall
    stallIdleMs: num('CLAUDE_WORKER_STALL_IDLE_MS', 20 * 60_000),
    stallToolMs: num('CLAUDE_WORKER_STALL_TOOL_MS', 60 * 60_000),
    transientBackoffMs: num('CLAUDE_WORKER_TRANSIENT_BACKOFF_MS', 5000),
    transientMaxMs: num('CLAUDE_WORKER_TRANSIENT_MAX_MS', 60_000),
    // cooling and waiting
    coolDefaultMs: num('CLAUDE_WORKER_COOL_DEFAULT_MS', 15 * 60_000),
    coolFloorMs: num('CLAUDE_WORKER_COOL_FLOOR_MS', 5 * 60_000),
    waitBaseMs: num('CLAUDE_WORKER_WAIT_BASE_MS', 30_000),
    waitMaxMs: num('CLAUDE_WORKER_WAIT_MAX_MS', 5 * 60_000),
    waitGiveUpMs: num('CLAUDE_WORKER_WAIT_GIVE_UP_MS', 8 * 3600_000),
    waitProbeMs: num('CLAUDE_WORKER_WAIT_PROBE_MS', 60_000),
    waitPollMs: num('CLAUDE_WORKER_WAIT_POLL_MS', 1000),
  };
}

module.exports = { cfg, num };
