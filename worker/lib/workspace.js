'use strict';
// Where things live: the workbench install, the private config, and the workspace folder above a worktree.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UserError } = require('./errors');

function workbenchHome() {
  return process.env.WORKBENCH_HOME || path.join(os.homedir(), '.workbench');
}

function configPath() {
  return process.env.WORKBENCH_CONFIG || path.join(os.homedir(), '.config', 'workbench', 'config.json');
}

/** "~" and "~/x" mean the home folder. Anything else is resolved as it stands. */
function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** The workspace folder: the first folder at or above `dir` that holds workbench.json, or null. */
function findRoot(dir) {
  let d = path.resolve(dir);
  for (let i = 0; i < 64; i++) {
    try { if (fs.statSync(path.join(d, 'workbench.json')).isFile()) return d; } catch { /* keep walking */ }
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return null;
}

/**
 * The private config, or {} when the file is absent. A file that exists but cannot be parsed is an error, not a
 * silent fallback: guessing the accounts would run workers on the wrong one.
 */
function readConfig() {
  const f = configPath();
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new UserError(`cannot read the config ${f}: ${e.code || e.message}`);
  }
  let j;
  try { j = JSON.parse(text); } catch (e) { throw new UserError(`the config ${f} is not valid JSON: ${e.message}`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new UserError(`the config ${f} must be a JSON object`);
  return j;
}

module.exports = { workbenchHome, configPath, expandHome, findRoot, readConfig };
