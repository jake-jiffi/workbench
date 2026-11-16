'use strict';
// A scripted stand-in for the claude binary. A per-test wrapper sets FAKE_DIR, then requires this file.
// Modes: `-p /usage`, `auth status --json`, and a worker run (prompt on stdin, stream-json on stdout).
// Scenarios live in $FAKE_DIR/scenario.json: {runs:{"1":[steps]}, byAccount:{label:[steps]}, default:[steps]}.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = process.env.FAKE_DIR || global.FAKE_DIR;
const args = process.argv.slice(2);
const cfgDir = process.env.CLAUDE_CONFIG_DIR;
const acct = cfgDir ? path.basename(cfgDir) : 'home';
const rj = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const uniq = () => Date.now() + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 7);

function ppidComm() { try { return require('child_process').execFileSync('/bin/ps', ['-o', 'comm=', '-p', String(process.ppid)], { encoding: 'utf8' }).trim(); } catch { return ''; } }
function record(mode, extra) {
  fs.mkdirSync(path.join(dir, 'calls'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'calls', uniq() + '.json'), JSON.stringify({ mode, args, cwd: process.cwd(), env: process.env, acct, pid: process.pid, ppid: process.ppid, ppidComm: ppidComm(), at: Date.now(), ...extra }));
}

function usageMode() {
  record('usage');
  const u = rj(path.join(dir, 'usage', acct + '.json'));
  if (!u) { console.error('no usage file'); process.exit(1); }
  if (u.mode === 'hang') return setTimeout(() => {}, 3600_000);
  if (u.mode === 'fail') { console.error('boom'); process.exit(1); }
  if (u.mode === 'garbage') { console.log('\u0000\u0001 Welcome to nothing; 12 widgets'); process.exit(0); }
  if (u.mode === 'signedout') { console.log('Not logged in. Please run /login'); process.exit(0); }
  if (u.delay) return setTimeout(() => emitUsage(u), u.delay);
  emitUsage(u);
}
function emitUsage(u) {
  console.log('You are currently using your subscription to power your Claude Code usage\n');
  if (u.session !== null && u.session !== undefined) console.log(`Current session: ${u.session}% used · resets Nov 9 at 8:50pm (Australia/Sydney)`);
  if (u.week !== null && u.week !== undefined) console.log(`Current week (all models): ${u.week}% used · resets Nov 10 at 9am (Australia/Sydney)`);
  console.log('Current week (Fable): 0% used · resets Nov 10 at 9am (Australia/Sydney)');
  process.exit(0);
}

function authMode() {
  record('auth');
  const u = rj(path.join(dir, 'usage', acct + '.json')) || {};
  console.log(JSON.stringify({ loggedIn: u.mode !== 'signedout', orgName: u.org || 'Org ' + acct, subscriptionType: u.plan || 'max', email: 'x@example.com' }));
  process.exit(0);
}

function nextRun() {
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  for (let k = 1; ; k++) {
    try { fs.closeSync(fs.openSync(path.join(dir, 'runs', String(k)), 'wx')); return k; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
}

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function workerMode() {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) prompt += c;
  const iSid = args.indexOf('--session-id'), iRes = args.indexOf('--resume');
  const session = iSid >= 0 ? args[iSid + 1] : iRes >= 0 ? args[iRes + 1] : 'fake-' + uniq();
  const k = nextRun();
  record('worker', { prompt, run: k, session });
  const sc = rj(path.join(dir, 'scenario.json')) || {};
  const steps = (sc.runs && sc.runs[k]) || (sc.byAccount && sc.byAccount[acct]) || sc.default || [{ t: 'init' }, { t: 'text', text: 'working' }, { t: 'result', text: 'ok' }];
  let n = 0;
  for (const s of steps) {
    n++;
    switch (s.t) {
      case 'init': out({ type: 'system', subtype: 'init', session_id: session, model: s.model || 'fake-model', cwd: process.cwd() }); break;
      case 'text': out({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'text', text: s.text }] } }); break;
      case 'tool_use': out({ type: 'assistant', session_id: session, message: { role: 'assistant', content: [{ type: 'tool_use', id: s.id, name: s.name || 'Bash', input: {} }] } }); break;
      case 'tool_result': out({ type: 'user', session_id: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: s.id, content: 'ok' }] } }); break;
      case 'sleep': await sleep(s.ms); break;
      case 'result': out({ type: 'result', subtype: s.subtype || (s.is_error ? 'error_during_execution' : 'success'), is_error: !!s.is_error, result: s.text === undefined ? 'done' : s.text, session_id: session, total_cost_usd: 0.01, num_turns: 1 }); break;
      case 'limit':
        out({ type: 'assistant', session_id: session, error: 'rate_limit', message: { role: 'assistant', content: [{ type: 'text', text: `Claude AI usage limit reached${s.resetsAt ? '|' + s.resetsAt : ''}` }] } });
        if (s.result !== false) out({ type: 'result', subtype: 'success', is_error: true, result: `Claude AI usage limit reached${s.resetsAt ? '|' + s.resetsAt : ''}`, session_id: session });
        break;
      case 'apierr': // a failed result carrying the structured API error fields (any may be omitted)
        out({ type: 'result', subtype: 'success', is_error: true, result: s.text || 'API Error', session_id: session, ...(s.status !== undefined ? { api_error_status: s.status } : {}), ...(s.error !== undefined ? { api_error: s.error } : {}) });
        break;
      case 'lines': for (const l of s.lines) process.stdout.write(JSON.stringify(l) + '\n'); break;
      case 'autherr':
        out({ type: 'assistant', session_id: session, error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } });
        out({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: session });
        break;
      case 'ratelimit_event': out({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: s.resetsAt } }); break;
      case 'raw': process.stdout.write(s.text); break;
      case 'stderr': process.stderr.write(s.text); break;
      case 'write': fs.writeFileSync(path.join(process.cwd(), s.file), s.text || 'x'); break;
      case 'child': {
        const c = spawn('/bin/sleep', ['600'], { detached: !!s.newgroup, stdio: 'ignore' });
        c.unref();
        fs.appendFileSync(path.join(dir, 'children.txt'), c.pid + '\n');
        break;
      }
      case 'exit': process.exit(s.code || 0); break;
      case 'kill': process.kill(process.pid, s.sig || 'SIGKILL'); await sleep(5000); break;
      case 'hang': await sleep(3600_000); break;
      default: throw new Error('unknown step ' + s.t);
    }
  }
  process.exit(0);
}

const joined = args.join(' ');
if (args[0] === 'auth') authMode();
else if (args.includes('/usage')) usageMode();
else workerMode();
