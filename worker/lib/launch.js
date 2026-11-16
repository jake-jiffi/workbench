'use strict';
// Building the claude command line and settings for one leg.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { cfg } = require('./config');
const fsx = require('./fsx');
const { UserError } = require('./errors');
const { findRoot } = require('./workspace');

/** Guard hooks that hold whatever the worktree's own settings say: --settings is merged on top of project settings. */
function guardSettings() {
  const c = cfg();
  const guards = ['guard-git.sh', 'guard-release.sh'].map(n => path.join(c.hooksDir, n));
  const missing = guards.filter(g => !fs.existsSync(g));
  if (missing.length) throw new UserError('guard hooks missing, refusing to start a worker without them: ' + missing.join(', '));
  return {
    disableAllHooks: false,
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: guards.map(g => ({ type: 'command', command: `'${g.replace(/'/g, `'\\''`)}'` })) }] },
  };
}

function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) { key = kv[1]; meta[key] = kv[2].trim().replace(/^["']|["']$/g, ''); if (meta[key] === '') meta[key] = []; continue; }
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && key && Array.isArray(meta[key])) meta[key].push(li[1].trim());
  }
  return { meta, body: m[2].trim() };
}

const DEFAULT_AGENT = 'builder';

/**
 * Find an agent definition: the worktree and every folder above it (.claude/agents), the workspace's (the folder
 * holding workbench.json), then the user's. Claude Code looks in the worktree's own project and the user folder only,
 * so a definition kept at the workspace would not load by name. With {userDir: false} the user's folder is skipped
 * (used for the default agent, which must come from the project, not from whatever the user keeps). Returns {file, def} or null.
 */
function findAgent(name, worktree, { userDir = true } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  const places = [];
  const root = findRoot(worktree);
  let d = path.resolve(worktree);
  if (userDir) {
    for (let i = 0; i < 12; i++) { places.push(path.join(d, '.claude', 'agents')); const p = path.dirname(d); if (p === d) break; d = p; }
  } else places.push(path.join(d, '.claude', 'agents'));
  if (root) places.push(path.join(root, '.claude', 'agents'));
  if (userDir) places.push(path.join(os.homedir(), '.claude', 'agents'));
  for (const dir of places) {
    const f = path.join(dir, name + '.md');
    try {
      const fm = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      if (!fm) continue;
      const def = { description: fm.meta.description || name, prompt: fm.body };
      if (fm.meta.model) def.model = fm.meta.model;
      if (fm.meta.tools && !Array.isArray(fm.meta.tools)) def.tools = fm.meta.tools.split(',').map(s => s.trim()).filter(Boolean);
      return { file: f, def };
    } catch { /* next */ }
  }
  return null;
}

/** The argument list for one leg. */
function buildArgs(spec, { settingsFile, resume, sessionId }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--settings', settingsFile];
  // With --agent and no --model, the agent definition's own model applies.
  if (spec.model) args.push('--model', spec.model);
  if (spec.agent) {
    args.push('--agent', spec.agent);
    if (spec.agentDef) args.push('--agents', JSON.stringify({ [spec.agent]: spec.agentDef }));
  }
  if (resume) args.push('--resume', resume); else args.push('--session-id', sessionId);
  return args;
}

function writeSettings(dir) {
  const f = path.join(dir, 'settings.json');
  fsx.atomicWrite(f, guardSettings());
  return f;
}

const CONTINUE = reason => `You were interrupted (${reason}) and this conversation has been moved so you can carry on. ` +
  'Check the working tree first (git status, git diff, git log) to see what is already done, then carry on with the original brief until it is finished. ' +
  'Do not redo finished work. When you are done, give your final report.';

module.exports = { DEFAULT_AGENT, guardSettings, findAgent, buildArgs, writeSettings, parseFrontmatter, CONTINUE };
