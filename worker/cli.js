#!/usr/bin/env node
'use strict';
const cmds = require('./lib/commands');
const select = require('./lib/select');

const VALUE_FLAGS = new Set(['worktree', 'brief', 'agent', 'model', 'account', 'name', 'file', 'timeout', 'only']);
const BOOL_FLAGS = new Set(['json', 'force', 'help', 'keep']);

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = a.slice(2, eq < 0 ? undefined : eq);
      if (BOOL_FLAGS.has(k)) o[k] = true;
      else if (VALUE_FLAGS.has(k)) {
        const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
        if (v === undefined) throw new cmds.UserError(`--${k} needs a value`);
        o[k] = v;
      } else throw new cmds.UserError(`unknown flag --${k}`);
    } else o._.push(a);
  }
  return o;
}

const USAGE = `claude-worker: run Claude Code workers on any of your signed-in accounts

  accounts                         each account's org, plan, 5-hour %, weekly %, reading age, eligibility
  start --worktree P --brief F [--agent A|none] [--model M] [--account L] [--name N] [--force]
  status [id]                      all workers, or one
  result <id>                      the worker's final text
  wait <id...> [--timeout S]       block until all are finished
  stop <id>
  send <id> --file F [--account L] continue a finished worker's conversation
  recover                          adopt or resume workers whose supervisor died
  selftest [--only name]           real end-to-end checks on eligible accounts
Every command takes --json. An id may be a worker name.`;

const pad = (s, n) => String(s === null || s === undefined ? '-' : s).padEnd(n);
const out = (o, json, text) => console.log(json ? JSON.stringify(o, null, 2) : text);

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '__supervise') {
    await require('./lib/supervisor').supervise(argv[1]);
    return 0;
  }
  const o = parse(argv);
  const cmd = o._.shift();
  if (!cmd || cmd === 'help' || o.help) { console.log(USAGE); return cmd || o.help ? 0 : 2; }
  const json = !!o.json;
  switch (cmd) {
    case 'accounts': {
      const rows = await select.overview();
      out(rows, json, rows.map(r => `${pad(r.account, 15)} ${pad(r.org, 28)} ${pad(r.plan, 6)} 5h ${pad(r.session === null ? '?' : r.session + '%' + (r.sessionAssumed ? '*' : ''), 5)} week ${pad(r.week === null ? '?' : r.week + '%', 5)} read ${pad(r.readingAgeSec === null ? '-' : r.readingAgeSec + 's ago', 9)} slots ${r.slots}  ${r.eligible ? 'eligible' : 'NOT eligible: ' + r.reason}${r.caller ? '  (this session)' : ''}`).join('\n') + '\n* no 5-hour window is open, counted as 0%');
      return 0;
    }
    case 'start': {
      const r = await cmds.start(o);
      out(r, json, `${r.id}  ${r.account ? 'account ' + r.account : 'queued, no account has room yet'}`);
      if (r.note && !json) console.error('claude-worker: note: ' + r.note);
      return 0;
    }
    case 'status': {
      const rows = cmds.status(o._[0]);
      out(rows, json, rows.length ? rows.map(r => `${pad(r.id, 9)} ${pad(r.name, 14)} ${pad(r.state, 8)} ${pad(r.account, 15)} legs ${r.legs ? r.legs.length : 0}  ${r.supervisorAlive ? '' : (['done', 'failed', 'stopped'].includes(r.state) ? '' : '[no supervisor] ')}${r.reason || ''}`).join('\n') : 'no workers');
      return 0;
    }
    case 'result': {
      if (!o._[0]) throw new cmds.UserError('result needs an id');
      const r = cmds.result(o._[0]);
      if (json) { console.log(JSON.stringify(r, null, 2)); return r.state === 'done' ? 0 : 1; }
      if (!r.finished) { console.error(`${r.id} is ${r.state}, not finished`); return 2; }
      if (r.state !== 'done') { console.error(`${r.id} ${r.state}: ${r.reason}`); return 1; }
      process.stdout.write(r.text.endsWith('\n') ? r.text : r.text + '\n');
      return 0;
    }
    case 'wait': {
      if (!o._.length) throw new cmds.UserError('wait needs at least one id');
      const r = await cmds.wait(o._, { timeoutMs: o.timeout ? Number(o.timeout) * 1000 : undefined });
      out(r, json, r.workers.map(w => `${w.id} ${w.name ? '(' + w.name + ') ' : ''}${w.state}${w.account ? ' on ' + w.account : ''}: ${w.reason}`).join('\n') + (r.timedOut ? '\ntimed out; still running' : ''));
      if (r.timedOut) return 124;
      return r.workers.every(w => w.state === 'done') ? 0 : 1;
    }
    case 'stop': {
      if (!o._[0]) throw new cmds.UserError('stop needs an id');
      const r = await cmds.stop(o._[0]);
      out(r, json, `${r.id} ${r.state}: ${r.reason}`);
      return 0;
    }
    case 'send': {
      if (!o._[0]) throw new cmds.UserError('send needs an id');
      const r = await cmds.send(o._[0], o);
      out(r, json, `${r.id}  continuing on ${r.account}`);
      return 0;
    }
    case 'recover': {
      const r = cmds.recoverAll();
      out(r, json, Object.keys(r).length ? Object.entries(r).map(([k, v]) => `${k} ${v}`).join('\n') : 'nothing to recover');
      return 0;
    }
    case 'selftest': {
      const r = await require('./lib/selftest').run(o);
      out(r, json, r.map(x => `${x.pass ? 'PASS' : x.skipped ? 'SKIP' : 'FAIL'}  ${x.name}  ${x.detail || ''}`).join('\n'));
      return r.some(x => !x.pass && !x.skipped) ? 1 : 0;
    }
    default:
      throw new cmds.UserError(`unknown command: ${cmd}\n${USAGE}`);
  }
}

main().then(code => process.exit(code), e => {
  if (e instanceof cmds.UserError) { console.error('claude-worker: ' + e.message); process.exit(2); }
  console.error('claude-worker: ' + (e && e.stack || e));
  process.exit(1);
});
