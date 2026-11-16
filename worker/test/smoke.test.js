'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { world, sleep } = require('./helpers');

test('a worker runs to a result', async () => {
  const w = world();
  try {
    const r = w.start(['--name', 'one']);
    assert.ok(r.id && r.account);
    const s = await w.waitFor(r.id, s => s.state === 'done');
    assert.strictEqual(s.result.text, 'ok');
    const res = w.cw(['result', r.id]);
    assert.strictEqual(res.stdout.trim(), 'ok');
  } finally { await w.cleanup(); }
});
