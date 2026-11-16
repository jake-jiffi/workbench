'use strict';
// The account list comes from the private config (accounts[]: {label, dir}). Accounts are chosen only by the
// config-folder variable: the default account (dir ~/.claude) has it REMOVED, because pointing it at ~/.claude selects a
// different Keychain entry and loses the sign-in. No login file is ever opened here.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cfg } = require('./config');
const { UserError } = require('./errors');
const ws = require('./workspace');

const BASE_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * The PATH a child gets: the running node's own folder first (so the worker runs the same node as the supervisor),
 * per-shell fnm folders removed (they vanish when the parent shell exits), and the standard system folders always present.
 */
function nodeDir() {
  try { return path.dirname(fs.realpathSync(process.execPath)); } catch { return path.dirname(process.execPath); }
}

function childPath(parentPath = process.env.PATH || '', node = nodeDir()) {
  const keep = parentPath.split(':').filter(p => p && !p.includes('/fnm_multishells/'));
  const out = [];
  if (node) out.push(node);
  for (const p of [...keep, ...BASE_PATH]) if (!out.includes(p)) out.push(p);
  return out.join(':');
}

const ALLOWED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR', 'TERM'];

const defaultDir = () => path.join(os.homedir(), '.claude');
const sameDir = (a, b) => {
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
};

/** [{label, dir, home}] where home marks the account that runs with the variable unset. */
function listAccounts() {
  const override = process.env.CLAUDE_WORKER_ACCOUNTS; // tests: "name=dir,name2=home"
  if (override) {
    return override.split(',').map(s => s.trim()).filter(Boolean).map(p => {
      const [label, dir] = p.split('=');
      return dir === 'home' ? { label, dir: defaultDir(), home: true } : { label, dir, home: false };
    });
  }
  const conf = ws.readConfig();
  const raw = conf.accounts;
  if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return [{ label: 'main', dir: defaultDir(), home: true }];
  if (!Array.isArray(raw)) throw new UserError(`accounts in ${ws.configPath()} must be a list of {label, dir}`);
  const seen = new Set();
  return raw.map((a, i) => {
    if (!a || typeof a.label !== 'string' || !a.label.trim() || typeof a.dir !== 'string' || !a.dir.trim()) {
      throw new UserError(`accounts[${i}] in ${ws.configPath()} needs a label and a dir`);
    }
    const label = a.label.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(label)) throw new UserError(`accounts[${i}] label "${label}" may use letters, digits, . _ - only`);
    if (seen.has(label)) throw new UserError(`account label "${label}" appears twice in ${ws.configPath()}`);
    seen.add(label);
    const dir = path.resolve(ws.expandHome(a.dir.trim()));
    return { label, dir, home: sameDir(dir, defaultDir()) };
  });
}

function findAccount(label) {
  return listAccounts().find(a => a.label === label) || null;
}

/**
 * The environment a child gets: an allow-list, never a copy of ours. The parent session's CLAUDE_*, ANTHROPIC_*
 * and shell-exported secrets are not inherited. CLAUDE_WORKER_* settings are not secrets and pass through so a
 * recovered supervisor keeps the same home and tuning.
 */
function childEnv(acct, { supervisor = false } = {}) {
  const env = {};
  for (const k of ALLOWED_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.PATH = childPath();
  env.DISABLE_AUTOUPDATER = '1';
  if (supervisor) {
    for (const k of Object.keys(process.env)) if (k.startsWith('CLAUDE_WORKER_')) env[k] = process.env[k];
    return env;
  }
  if (acct && !acct.home) env.CLAUDE_CONFIG_DIR = acct.dir;
  return env;
}

/** Which account the calling session is on, or null if it is not a Claude session we can place. */
function callerAccount() {
  const list = listAccounts();
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir) {
    const norm = p => path.resolve(p);
    const m = list.find(a => !a.home && norm(a.dir) === norm(dir));
    return m ? m.label : null;
  }
  const named = process.env.CLAUDE_ACCOUNT;
  if (named && list.some(a => a.label === named)) return named;
  if (process.env.CLAUDECODE) return (list.find(a => a.home) || {}).label || null;
  return null;
}

module.exports = { childPath, listAccounts, findAccount, childEnv, callerAccount, ALLOWED_ENV, nodeDir, cfg };
