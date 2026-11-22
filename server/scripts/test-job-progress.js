// node server/scripts/test-job-progress.js — the shared live progress tracker
// (server/jobProgress.js): real percent (held at 95, 100 only on success), a failed
// job keeps its number and reason and logs "jobs failed: …" for the sentinel,
// state survives a restart (last 50 finished kept), the strip's items, and one
// Telegram board (server/workers.js) listing workers and persona jobs together.
process.env.TELEGRAM_BOT_TOKEN_JARVIS = 'test-token';
process.env.TELEGRAM_OWNER_ID = '1';
const Module = require('module');
const assert = require('assert');
const settings = {};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './db') return { query: async () => {} };
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  return load.call(this, req, parent, ...rest);
};
const J = require('../jobProgress');
const W = require('../workers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errs = [];
const origErr = console.error;
console.error = (...a) => errs.push(a.join(' '));

(async () => {
  // Percent: steps done / steps, 95 max until it ends, 100 only on success.
  W._setDeps({ gh: null, board: null, boardGapMs: 5, slot: async () => () => {} });
  let id = J.start('rogue', 'Clip scan: x', ['Download audio', 'Transcribe', 'Pick moments', 'Render']);
  assert.strictEqual(J._jobs()[id].percent, 0);
  J.step(id, 'Transcribe');
  assert.strictEqual(J._jobs()[id].percent, 25, 'one of four steps done');
  J.step(id, 'Render');
  assert.strictEqual(J._jobs()[id].percent, 75);
  J.step(id, 'Render 2'); // an unknown step is added
  assert.strictEqual(J._jobs()[id].steps.length, 5);
  assert.strictEqual(J._jobs()[id].percent, 80);
  J.plan(id, ['a', 'b'], 2);
  assert.strictEqual(J._jobs()[id].percent, 95, 'every step done still holds at 95');
  J.done(id, 'ok');
  assert.strictEqual(J._jobs()[id].percent, 100);
  assert.strictEqual(J._jobs()[id].status, 'done');
  J.step(id, 'late'); assert.strictEqual(J._jobs()[id].percent, 100, 'a finished job ignores steps');

  // Failure: keeps its last number and reason, logs "jobs failed: persona title: reason".
  errs.length = 0;
  id = J.start('transcribe-test', 'Transcribe: y', ['Download', 'Transcribe', 'Save']);
  J.step(id, 'Transcribe');
  J.fail(id, new Error('the video is private'));
  const f = J._jobs()[id];
  assert.strictEqual(f.status, 'failed'); assert.strictEqual(f.percent, 33); assert.strictEqual(f.reason, 'the video is private');
  assert.deepStrictEqual(errs, ['jobs failed: TRANSCRIBE-TEST Transcribe: y: the video is private']);
  assert.match(errs[0], /^([\w .'\-/:]{3,60}?)\s+failed\b/i, 'the sentinel regex reads it');
  J.fail(id, 'again'); assert.strictEqual(errs.length, 1, 'a finished job fails once');

  // run(): success returns, a throw fails and rethrows, null id (tracking off) is a no-op.
  assert.strictEqual(await J.run('ara', 'Deep research: z', ['a'], async (j) => { j.step('a'); return 'brief'; }), 'brief');
  errs.length = 0;
  await assert.rejects(J.run('ara', 'Deep research: q', ['a'], async () => { throw new Error('no credits'); }), /no credits/);
  assert.match(errs[0], /^jobs failed: A\.R\.A\. Deep research: q: no credits$/);
  J.step(null, 'x'); J.done(null); J.fail(null, 'x');

  // Persistence: last 50 finished kept, running ones saved; a restart fails the cut-off one.
  J._reset();
  for (let i = 0; i < 60; i++) { const k = J.start('rogue', 'j' + i, ['a']); J.done(k); }
  const live = J.start('jarvis', 'Website: Joe', ['a', 'b']); J.step(live, 'b');
  await J._flush();
  const saved = JSON.parse(settings.jobs);
  const fin = Object.values(saved.jobs).filter((j) => j.status !== 'running');
  assert.strictEqual(fin.length, J.KEEP, 'last 50 finished jobs kept');
  assert.ok(!fin.some((j) => j.title === 'j0') && fin.some((j) => j.title === 'j59'), 'the oldest dropped');
  const runningSaved = Object.values(saved.jobs).filter((j) => j.status === 'running');
  assert.strictEqual(runningSaved.length, 1);
  errs.length = 0;
  J._reset(); // "restart"
  await J.load();
  const back = Object.values(J._jobs());
  assert.strictEqual(back.length, 50, 'finished jobs survive a restart (cap 50 incl. the cut-off one)');
  const cut = back.find((j) => j.title === 'Website: Joe');
  assert.strictEqual(cut.status, 'failed'); assert.match(cut.reason, /restart/); assert.strictEqual(cut.percent, 50, 'keeps its number');
  assert.match(errs[0], /^jobs failed: J\.A\.R\.V\.I\.S\. Website: Joe: cut off by a server restart/);
  const nid = J.start('ara', 'after', []); assert.ok(Number(nid) > 60, 'ids keep counting up after a restart');

  // The strip's items.
  delete settings.jobs; J._reset(); await J.load();
  const a = J.start('rogue', 'Clip scan: a', ['one', 'two']); J.step(a, 'two');
  const items = await J.forApp();
  assert.strictEqual(items.length, 1);
  assert.deepStrictEqual({ kind: items[0].kind, persona: items[0].persona, personaName: items[0].personaName, percent: items[0].percent, current: items[0].current, status: items[0].status }, { kind: 'job', persona: 'rogue', personaName: 'R.O.G.U.E.', percent: 50, current: 'two', status: 'running' });
  assert.deepStrictEqual(items[0].plan, [{ name: 'one', done: true }, { name: 'two', done: false }]);
  assert.notStrictEqual(items[0].id, '1', 'job ids never collide with worker ids');

  // The board: one text for workers and persona jobs, each job line starts with the persona's name.
  const sent = [], edits = [];
  W._setDeps({ gh: null, repo: () => ({}), slot: async () => () => {}, tell: async () => {}, saveNote: async () => {}, onDone: () => null, boardGapMs: 5, boardRefreshMs: 60e3,
    board: { ready: () => true, send: async (t) => { sent.push(t); return 55; }, edit: async (id, t) => { edits.push({ id, t }); }, log: async () => {} } });
  const b = J.start('jarvis', 'Website: Joe\'s Pizza', ['Gather photos', 'Build the page', 'Publish']); J.step(b, 'Build the page');
  await sleep(60);
  assert.strictEqual(sent.length, 1, 'one board message');
  assert.match(sent[0], /Live jobs: 2 running/);
  assert.match(sent[0], /🔧 R\.O\.G\.U\.E\. Clip scan: a · \d+ min\n {4}▓▓▓▓▓░░░░░ 50% · two/);
  assert.match(sent[0], /🔧 J\.A\.R\.V\.I\.S\. Website: Joe's Pizza · \d+ min\n {4}▓▓▓░░░░░░░ 33% · Build the page/);
  J.fail(a, 'download refused'); J.done(b, 'ok');
  await sleep(60);
  assert.ok(edits.length >= 1 && edits.every((e) => e.id === 55), 'edited in place, never re-sent');
  const last = edits[edits.length - 1].t;
  assert.match(last, /Live jobs: all done ✓/);
  assert.match(last, /❌ R\.O\.G\.U\.E\. Clip scan: a · failed at 50% · \d+ min\n {4}download refused/);
  assert.match(last, /✅ J\.A\.R\.V\.I\.S\. Website: Joe's Pizza · done · ▓▓▓▓▓▓▓▓▓▓ 100%/);
  assert.strictEqual(sent.length, 1);

  // JOBS=off: no tracking, calls are no-ops.
  process.env.JOBS = 'off';
  assert.strictEqual(J.start('ara', 'x', []), null);
  assert.strictEqual(await J.run('ara', 'x', [], async () => 7), 7);
  delete process.env.JOBS;

  console.error = origErr;
  console.log('job progress: all checks passed');
  process.exit(0);
})().catch((e) => { console.error = origErr; console.error(e); process.exit(1); });
