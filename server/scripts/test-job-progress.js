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


  // Resume: a cut-off job with saved arguments restarts once; a second cut-off is reported, not retried.
  {
    const told = [], ran = [];
    J._setDeps({ tell: async (t) => { told.push(t); }, resumers: { clip_scan: (a) => { ran.push(a); J.start('rogue', 'Clip scan: resumed', ['a', 'b'], { kind: 'clip_scan', args: a, to: 'rogue' }); } } });
    const boot = async () => { J._reset(); await J.load(); return J.recover(); };
    delete settings.jobs; J._reset(); await J.load();
    const r1 = J.start('rogue', 'Clip scan: big', ['Download audio', 'Transcribe', 'Pick moments'], { kind: 'clip_scan', args: { url: 'https://youtu.be/x', focus: 'funny', title: '' }, to: 'rogue' });
    J.step(r1, 'Transcribe');
    const plain = J.start('jarvis', 'Website: Joe', ['a', 'b']);
    await J._flush();
    errs.length = 0;
    let out = await boot(); // restart #1
    assert.deepStrictEqual(ran, [{ url: 'https://youtu.be/x', focus: 'funny', title: '' }], 'restarted once with its saved arguments');
    assert.deepStrictEqual(out.map((o) => o.resumed).sort(), [false, true]);
    assert.strictEqual(told.length, 2, 'A.R.A. is told about each cut-off job');
    assert.ok(told.some((t) => /R\.O\.G\.U\.E\.'s job "Clip scan: big" \(33% done, on "Transcribe"\).*Resuming it now/.test(t)), told.join('\n'));
    assert.ok(told.some((t) => /Website: Joe.*can't be resumed/.test(t)));
    assert.ok(!errs.some((e) => /Clip scan: big/.test(e)), 'a job being resumed isn\'t logged as failed');
    assert.ok(errs.some((e) => /^jobs failed: J\.A\.R\.V\.I\.S\. Website: Joe/.test(e)), 'the one that can\'t resume is');
    const again = Object.values(J._jobs()).find((j) => j.title === 'Clip scan: resumed');
    assert.strictEqual(again.attempts, 1, 'the rerun counts as attempt 1');
    await J._flush();
    // restart #2 while the resumed one runs: reported, not retried
    ran.length = 0; told.length = 0; errs.length = 0;
    out = await boot();
    assert.strictEqual(ran.length, 0, 'not retried a second time');
    assert.deepStrictEqual(out.map((o) => o.resumed), [false]);
    assert.ok(told.length === 1 && /again.*stopped rather than loop/.test(told[0]), told.join('\n'));
    assert.ok(errs.some((e) => /^jobs failed: R\.O\.G\.U\.E\. Clip scan: resumed/.test(e)));
    // handled jobs aren't acted on twice in one boot
    assert.deepStrictEqual(await J.recover(), []);
    // JOB_RESUME=off only reports
    delete settings.jobs; J._reset(); await J.load();
    J.start('ara', 'Deep research: x', ['a'], { kind: 'deep_research', args: { topic: 'x', persona: 'ara' }, to: 'ara' });
    await J._flush();
    process.env.JOB_RESUME = 'off'; ran.length = 0; told.length = 0;
    J._setDeps({ tell: async (t) => { told.push(t); }, resumers: { deep_research: () => { ran.push('x'); } } });
    out = await boot();
    assert.strictEqual(ran.length, 0); assert.deepStrictEqual(out.map((o) => o.resumed), [false]);
    assert.match(told[0], /JOB_RESUME=off/);
    delete process.env.JOB_RESUME;
    // the redeploy receipt names running jobs
    J._reset(); await J.load();
    J.start('rogue', 'Clip scan: live', ['a', 'b'], { kind: 'clip_scan', args: { url: 'u' } });
    J.start('ara', 'Odd job', ['a']);
    const lines = J.runningLines();
    assert.ok(/R\.O\.G\.U\.E\.'s "Clip scan: live" \(0%\) — resumes after the restart/.test(lines[0]) && /cannot resume/.test(lines[1]), lines.join('|'));
    assert.match(require('../redeploy').runningJobsNote(), /Running now and cut off by the restart: .*Clip scan: live/);
    J._setDeps({});
    delete settings.jobs; J._reset();
  }

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
