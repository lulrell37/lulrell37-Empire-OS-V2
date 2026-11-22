// node server/scripts/test-workers.js — J.A.R.V.I.S.'s workers: 3 at a time, the rest
// wait; progress is visible; every result wakes him; restarts re-run once. All stubbed.
const Module = require('module');
const assert = require('assert');
const settings = {};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  return load.call(this, req, parent, ...rest);
};
const W = require('../workers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const woke = [], notes = [], releases = [];
const hold = () => new Promise((r) => releases.push(r));
W._setDeps({
  engine: {
    workspace: async () => ({ dir: '/tmp/x', readOnly: false }), ROOT: () => '/tmp/empire-workers-test',
    run: async () => '', spawnTurn: async ({ onProgress, brief }) => { assert.match(brief, /never push main/i); onProgress('Editing server/x.js'); await hold(); return { text: 'Built it on the branch, tests pass.' }; },
  },
  browse: async (persona, name, task, { onStep }) => { assert.match(persona, /^worker-\d+$/); onStep(1, 'opened canva'); await hold(); return { status: 'done', text: 'BROWSE — finished', result: 'Page 1: hello' }; },
  wake: async (t) => woke.push(t),
  saveNote: async (title, body) => notes.push({ title, body }),
});
(async () => {
  for (let i = 1; i <= 4; i++) await W.tag('WORKER_START', i === 4 ? 'browse | Canva 9-16 | read pages | Canva pages 9-16' : `code | job ${i} | do job ${i}`);
  await sleep(20);
  const app = await import('node:util').then(() => W.forApp());
  assert.strictEqual(app.filter((x) => x.status === 'running').length, 3, 'three at once');
  assert.strictEqual(app.find((x) => x.id === '4').status, 'queued', 'fourth waits');
  assert.match(app[0].progress, /Editing server\/x\.js/, 'progress visible');
  releases.shift()(); await sleep(30);
  assert.strictEqual(woke.length, 1); assert.match(woke[0], /worker #1 .*finished/); assert.match(woke[0], /Check its work/);
  assert.strictEqual((await W.forApp()).find((x) => x.id === '4').status, 'running', 'next in line starts');
  while (releases.length) { releases.shift()(); await sleep(30); }
  await sleep(30);
  assert.strictEqual(woke.length, 4, 'every result wakes him');
  assert.deepStrictEqual(notes.map((n) => n.title), ['Canva pages 9-16'], 'browse result saved to Drive');
  assert.match(await W.statusText(), /0 running, 0 waiting/);
  // a restart mid-run: queued again once, then reported
  const saved = JSON.parse(settings.workers); saved['1'].status = 'running'; saved['1'].attempts = 1; saved['2'].status = 'running'; saved['2'].attempts = 2;
  settings.workers = JSON.stringify(saved);
  W._setDeps({ engine: { workspace: async () => ({ readOnly: false, dir: '/tmp/x' }), ROOT: () => '/tmp/empire-workers-test', run: async () => '', spawnTurn: async () => ({ text: 'redone' }) }, browse: null, wake: async (t) => woke.push(t), saveNote: async () => {} });
  await W.recover(); await sleep(30);
  assert.ok(woke.some((t) => /#2 .*FAILED/.test(t) && /restarted/.test(t)), 'second cut-off is reported, not retried');
  assert.ok(woke.some((t) => /#1 .*finished/.test(t) && /redone/.test(t)), 'first cut-off re-runs');
  assert.match(await W.tag('WORKER_STOP', '99'), /no worker #99/);
  console.log('workers: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
