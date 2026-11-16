'use strict';
// Real end-to-end checks against the real claude binary, on whichever accounts are eligible right now. It uses a
// throwaway state home, a scratch workspace (a workbench.json, an app checkout with a local bare remote, a worktree) and tiny briefs.
// Each check that cannot run says why and is reported as skipped, not passed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const fsx = require('./fsx');

const sleep = fsx.sleep;
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }).trim();

/**
 * A scratch workspace: root/workbench.json, the app's main checkout at root/apps/app (remote: a local bare repo), and a
 * worktree at root/worktrees/app/wt, so the guard hooks see the same layout a real workspace has. Also a scratch
 * agent definition at root/.claude/agents/selftest-builder.md.
 */
function scratch(root) {
  const bare = path.join(root, 'bare.git');
  const app = path.join(root, 'apps', 'app');
  const wt = path.join(root, 'worktrees', 'app', 'wt');
  fs.mkdirSync(path.dirname(app), { recursive: true });
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  fs.writeFileSync(path.join(root, 'workbench.json'), JSON.stringify({ workbench: 1, name: 'selftest', owner: 'selftest', apps: [{ name: 'app', repo: 'scratch/app', integration: 'staging', production: 'main' }], protectedBranches: ['main', 'staging'] }, null, 2));
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'selftest-builder.md'), '---\nname: selftest-builder\ndescription: Scratch agent for the selftest\nmodel: haiku\n---\n\nYou are the selftest builder, a scratch agent that only answers questions about itself. Your agent marker is WB-SELFTEST-MARKER: when asked for your agent marker, reply with it.\n');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', app]);
  const id = ['-c', 'user.email=selftest@example.invalid', '-c', 'user.name=selftest'];
  execFileSync('git', [...id, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: app });
  git(app, ['remote', 'add', 'origin', bare]);
  git(app, ['push', '-q', 'origin', 'main']);
  git(bare, ['branch', 'staging', 'main']);
  git(app, ['config', 'user.email', 'selftest@example.invalid']);
  git(app, ['config', 'user.name', 'selftest']);
  git(app, ['worktree', 'add', '-q', '--no-track', '-b', 'selftest/wt', wt, 'main']);
  return { bare, app, wt, refs: () => git(bare, ['for-each-ref', '--format=%(refname) %(objectname)']) };
}

async function run(o = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-worker-selftest-')));
  const saved = process.env.CLAUDE_WORKER_HOME;
  process.env.CLAUDE_WORKER_HOME = path.join(root, 'home');
  const model = o.model || 'haiku';
  const results = [];
  const want = n => !o.only || o.only.split(',').includes(n);
  const rec = (name, pass, detail, skipped) => results.push({ name, pass: !!pass, skipped: !!skipped, detail });
  const cmds = require('./commands');
  const select = require('./select');
  const state = require('./state');
  const ids = [];
  const brief = (name, text) => { const f = path.join(root, name + '.md'); fs.writeFileSync(f, text); return f; };
  const finishOf = async (id, ms = 300_000) => (await cmds.wait([id], { timeoutMs: ms })).workers[0];
  const resultText = id => { try { return fs.readFileSync(state.file(id, 'result.txt'), 'utf8'); } catch { return ''; } };

  try {
    const rows = await select.overview();
    const eligible = rows.filter(r => r.eligible).map(r => r.account);
    rec('accounts', true, rows.map(r => `${r.account} ${r.session === null ? '?' : r.session + '%'}/${r.week === null ? '?' : r.week + '%'} ${r.eligible ? 'eligible' : 'no: ' + r.reason}`).join('; '));
    if (!eligible.length) {
      for (const n of ['env-tools', 'finishes', 'guard', 'agent', 'survives', 'cross-account']) if (want(n)) rec(n, false, 'no account is eligible right now', true);
      return results;
    }
    const sc = scratch(root);

    if (want('env-tools')) {
      // What a real builder needs from the allow-listed environment, read-only, with token values scrubbed.
      const A = require('./accounts');
      const acct = A.findAccount(eligible[0]);
      const env = A.childEnv(acct);
      const run = (cmd, args) => { const r = require('child_process').spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 60_000 }); return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).replace(/(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/g, '***').replace(/\s+/g, ' ').trim().slice(0, 100) }; };
      const gh = run('gh', ['auth', 'status']); // reported only: a workspace may not use gh
      const ls = run('git', ['ls-remote', sc.bare, 'HEAD']);
      const node = run('node', ['-v']);
      rec('env-tools', ls.ok && node.out === process.version, `git ls-remote ${ls.ok ? 'ok' : 'FAILED: ' + ls.out}; node ${node.out} (supervisor ${process.version}); gh auth status ${gh.ok ? 'ok' : 'not ok (not required): ' + gh.out}`);
    }

    if (want('finishes')) {
      const r = await cmds.start({ worktree: sc.wt, brief: brief('pong', 'Reply with exactly the word PONG and nothing else. Do not use any tools.'), model, name: 'selftest-finish' });
      ids.push(r.id);
      const w = await finishOf(r.id);
      rec('finishes', w.state === 'done' && /PONG/.test(resultText(r.id)), `${w.state} on ${w.account}: ${JSON.stringify(resultText(r.id)).slice(0, 80)}`);
    }

    if (want('guard')) {
      const before = sc.refs();
      const b = brief('guard', 'Run these shell commands in order, each with the Bash tool, and then report exactly what each printed, word for word. Do not try anything else to get around an error.\n1. git checkout -b staging\n2. echo hello > hello.txt && git add hello.txt && git commit -m hello\n3. git push origin staging\n');
      const r = await cmds.start({ worktree: sc.wt, brief: b, model, name: 'selftest-guard' });
      ids.push(r.id);
      const w = await finishOf(r.id);
      const after = sc.refs();
      const text = resultText(r.id);
      rec('guard', w.state === 'done' && before === after && /Blocked by/i.test(text), `${w.state}; bare remote ${before === after ? 'unchanged' : 'CHANGED'}; reply ${/Blocked by/i.test(text) ? 'quotes the guard' : 'does not quote the guard: ' + JSON.stringify(text).slice(0, 120)}`);
    }

    if (want('agent')) {
      const launch = require('./launch');
      const name = o.agent || 'selftest-builder';
      const found = launch.findAgent(name, sc.wt);
      if (!found) rec('agent', false, `no definition named ${name} found from the scratch workspace or ~/.claude/agents`, true);
      else {
        // The scratch agent carries a marker only its own prompt holds, so the check proves the definition reached the run.
        // A named agent of the owner's has no marker: then its first six words must appear in the reply.
        const MARKER = 'WB-SELFTEST-MARKER';
        const hasMarker = found.def.prompt.includes(MARKER);
        const ask = hasMarker
          ? 'Do not use any tools, skills or subagents. What is your agent marker? Reply with it and nothing else.'
          : 'Do not use any tools, skills or subagents. Your agent instructions begin with a sentence about who you are or what you do. Quote its first six words exactly and nothing else.';
        const r = await cmds.start({ worktree: sc.wt, brief: brief('agent', ask), agent: name, name: 'selftest-agent' });
        ids.push(r.id);
        const w = await finishOf(r.id);
        const st = state.load(r.id);
        const out = fs.readFileSync(state.file(r.id, st.legs[0].out), 'utf8');
        const init = out.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).find(e => e && e.type === 'system' && e.subtype === 'init') || {};
        const modelSeen = String(init.model || '');
        const want_ = String(found.def.model || '');
        const six = found.def.prompt.split(/\s+/).slice(0, 6).join(' ');
        const reply = resultText(r.id).replace(/["'`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        const quoted = hasMarker ? reply.includes(MARKER.toLowerCase()) : reply.includes(six.toLowerCase());
        const ok = w.state === 'done' && (!want_ || modelSeen.includes(want_)) && quoted;
        rec('agent', ok, `${w.state}; definition ${found.file} model "${want_}"; run model "${modelSeen}"; ${hasMarker ? 'its marker' : 'its own first six words'} ${quoted ? 'quoted back' : 'NOT quoted back (' + JSON.stringify(resultText(r.id)).slice(0, 80) + ')'}`);
      }
    }

    if (want('survives')) {
      // The "main session" is a shell in its own group that runs start and then sits there; we kill its group.
      const out = path.join(root, 'survive.json');
      const cli = path.resolve(__dirname, '..', 'cli.js');
      const sh = spawn('/bin/bash', ['-c', `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} start --worktree ${JSON.stringify(sc.wt)} --brief ${JSON.stringify(brief('wait', 'Run the shell command `sleep 20` with the Bash tool, then reply with exactly the word SURVIVED.'))} --model ${model} --json > ${JSON.stringify(out)}; sleep 600`], { detached: true, stdio: 'ignore', env: process.env });
      let id = null;
      for (let i = 0; i < 100 && !id; i++) { try { id = JSON.parse(fs.readFileSync(out, 'utf8')).id; } catch { await sleep(100); } }
      if (!id) rec('survives', false, 'start did not return');
      else {
        ids.push(id);
        for (let i = 0; i < 600; i++) { const s = state.load(id); if (s && s.state === 'running' && s.legs[0] && s.legs[0].progress > 0) break; await sleep(500); }
        try { process.kill(-sh.pid, 'SIGKILL'); } catch { /* gone */ }
        const w = await finishOf(id);
        rec('survives', w.state === 'done' && /SURVIVED/.test(resultText(id)), `${w.state} after its starting shell was killed: ${JSON.stringify(resultText(id)).slice(0, 60)}`);
      }
    }

    if (want('cross-account')) {
      if (eligible.length < 2) rec('cross-account', false, `needs two eligible accounts; eligible now: ${eligible.join(', ') || 'none'}`, true);
      else {
        const [a, b] = eligible;
        const first = await cmds.start({ worktree: sc.wt, brief: brief('word', 'Remember the secret word MARMALADE-7. Reply with exactly: READY. Do not use any tools.'), model, account: a, name: 'selftest-cross' });
        ids.push(first.id);
        const w1 = await finishOf(first.id);
        const f = brief('recall', 'What was the secret word I told you to remember? Reply with just the word. Do not use any tools.');
        const sent = await cmds.send(first.id, { file: f, account: b });
        const w2 = await finishOf(first.id);
        const st = state.load(first.id);
        rec('cross-account', w1.state === 'done' && w2.state === 'done' && sent.account === b && st.legs[1].account === b && /MARMALADE-7/.test(resultText(first.id)), `leg 1 on ${a}, leg 2 on ${st.legs[1] && st.legs[1].account}: ${JSON.stringify(resultText(first.id)).slice(0, 60)}; session ${st.legs[0].sessionId === st.legs[1].sessionId ? 'same id' : 'new id on resume'}`);
      }
    }
  } catch (e) {
    rec('selftest', false, String(e && e.message || e));
  } finally {
    for (const id of ids) { try { await cmds.stop(id); } catch { /* ignore */ } }
    if (saved === undefined) delete process.env.CLAUDE_WORKER_HOME; else process.env.CLAUDE_WORKER_HOME = saved;
    if (!o.keep) fs.rmSync(root, { recursive: true, force: true });
  }
  return results;
}

module.exports = { run, scratch };
