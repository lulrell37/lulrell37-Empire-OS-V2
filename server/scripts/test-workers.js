// node server/scripts/test-workers.js — J.A.R.V.I.S.'s workers: 3 at a time, the rest
// wait; progress is visible; every result wakes him; restarts re-run once; the live
// Telegram board (one silent message, edited in place, throttled); the real percentage
// from each worker's own plan. All stubbed.
process.env.TELEGRAM_BOT_TOKEN_JARVIS = 'test-token';
process.env.TELEGRAM_OWNER_ID = '1';
const Module = require('module');
const assert = require('assert');
const settings = {};
const dbRows = [];
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './db') return { query: async (q, v) => { dbRows.push(v); } };
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  return load.call(this, req, parent, ...rest);
};
const W = require('../workers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const woke = [], notes = [], releases = [];
const hold = () => new Promise((r) => releases.push(r));
// The board, stubbed: every send / edit with its time and text.
const GAP = 40;
const tgCalls = [], boardLogs = [];
let editFail = null;
const board = {
  ready: () => true,
  send: async (text) => { tgCalls.push({ op: 'send', text, at: Date.now() }); return 500 + tgCalls.filter((c) => c.op === 'send').length; },
  edit: async (id, text) => { if (editFail) throw new Error(editFail); tgCalls.push({ op: 'edit', id, text, at: Date.now() }); },
  log: async (t) => boardLogs.push(t),
};
const boardSaved = () => JSON.parse(settings.workers_tg_board || 'null');
W._setDeps({
  engine: {
    workspace: async () => ({ dir: '/tmp/x', readOnly: false }), ROOT: () => '/tmp/empire-workers-test',
    run: async () => '', spawnTurn: async ({ onProgress, brief }) => { assert.match(brief, /never push main/i); assert.ok(brief.includes(W.PLAN_FILE) && /3 to 10 numbered steps/.test(brief) && /\[x\]/.test(brief), 'brief asks for the plan file'); onProgress('Editing server/x.js'); await hold(); return { text: 'Built it on the branch, tests pass.' }; },
  },
  browse: async (persona, name, task, { onStep }) => { assert.match(persona, /^worker-\d+$/); onStep(1, 'opened canva'); await hold(); return { status: 'done', text: 'BROWSE — finished', result: 'Page 1: hello' }; },
  wake: async (t) => woke.push(t),
  saveNote: async (title, body) => notes.push({ title, body }),
  board, boardGapMs: GAP, boardRefreshMs: 60e3,
});
(async () => {
  for (let i = 1; i <= 4; i++) await W.tag('WORKER_START', i === 4 ? 'browse | Canva 9-16 | read pages | Canva pages 9-16' : `code | job ${i} | do job ${i}`);
  await sleep(20);
  const app = await import('node:util').then(() => W.forApp());
  assert.strictEqual(app.filter((x) => x.status === 'running').length, 3, 'three at once');
  assert.strictEqual(app.find((x) => x.id === '4').status, 'queued', 'fourth waits');
  assert.match(app[0].progress, /Editing server\/x\.js/, 'progress visible');
  await sleep(GAP * 2);
  // One silent board for all of them, not one message per worker.
  assert.strictEqual(tgCalls.filter((c) => c.op === 'send').length, 1, 'one board message');
  const live = tgCalls[tgCalls.length - 1].text;
  assert.match(live, /3 running, 1 waiting/);
  assert.match(live, /#1 job 1 · \d+ min\n\s+planning\n\s+Editing server\/x\.js/, 'number, title, minutes, planning (no plan yet), action');
  assert.match(live, /#4 Canva 9-16 · waiting/, 'queued shown as waiting');
  assert.strictEqual(boardSaved().messageId, 501, 'board id saved for restarts');
  assert.strictEqual(boardLogs.length, 1, 'first send logged once'); assert.ok(boardLogs[0].length < 200, 'as one short line');
  releases.shift()(); await sleep(30);
  assert.strictEqual(woke.length, 1); assert.match(woke[0], /worker #1 .*finished/); assert.match(woke[0], /Check its work/);
  assert.strictEqual((await W.forApp()).find((x) => x.id === '4').status, 'running', 'next in line starts');
  while (releases.length) { releases.shift()(); await sleep(30); }
  await sleep(30);
  assert.strictEqual(woke.length, 4, 'every result wakes him');
  await sleep(GAP * 3);
  const last = tgCalls[tgCalls.length - 1];
  assert.strictEqual(last.op, 'edit'); assert.strictEqual(last.id, 501, 'edited in place');
  assert.match(last.text, /all done ✓/, 'final all-done edit');
  assert.match(last.text, /✅ #1 job 1 · done/, 'finished ones stay listed');
  assert.strictEqual(boardSaved(), null, 'board closed once nothing is left');
  assert.strictEqual(tgCalls.filter((c) => c.op === 'send').length, 1, 'still the same one message');
  for (let i = 1; i < tgCalls.length; i++) {
    assert.ok(tgCalls[i].at - tgCalls[i - 1].at >= GAP - 5, 'edits throttled');
    assert.notStrictEqual(tgCalls[i].text, tgCalls[i - 1].text, 'no edit with unchanged text');
  }
  assert.strictEqual(boardLogs.length, 1, 'edits never logged');
  const nCalls = tgCalls.length;
  await sleep(GAP * 3);
  assert.strictEqual(tgCalls.length, nCalls, 'a closed board stops updating');
  assert.deepStrictEqual(notes.map((n) => n.title), ['Canva pages 9-16'], 'browse result saved to Drive');
  assert.match(await W.statusText(), /0 running, 0 waiting/);
  // a restart mid-run: queued again once, then reported
  const saved = JSON.parse(settings.workers); saved['1'].status = 'running'; saved['1'].attempts = 1; saved['2'].status = 'running'; saved['2'].attempts = 2;
  settings.workers = JSON.stringify(saved);
  settings.workers_tg_board = JSON.stringify({ messageId: 77, text: 'board from before the restart' });
  tgCalls.length = 0;
  W._setDeps({ engine: { workspace: async () => ({ readOnly: false, dir: '/tmp/x' }), ROOT: () => '/tmp/empire-workers-test', run: async () => '', spawnTurn: async () => ({ text: 'redone' }) }, browse: null, wake: async (t) => woke.push(t), saveNote: async () => {}, board, boardGapMs: GAP, boardRefreshMs: 60e3 });
  await W.recover(); await sleep(GAP * 4);
  assert.strictEqual(tgCalls.filter((c) => c.op === 'send').length, 0, 'a restart keeps the same board');
  assert.ok(tgCalls.length && tgCalls.every((c) => c.id === 77), 'and edits message 77');
  assert.match(tgCalls[tgCalls.length - 1].text, /all done/); assert.match(tgCalls[tgCalls.length - 1].text, /❌ #2 job 2 · failed/);
  assert.strictEqual(boardSaved(), null);
  assert.ok(woke.some((t) => /#2 .*FAILED/.test(t) && /restarted/.test(t)), 'second cut-off is reported, not retried');
  assert.ok(woke.some((t) => /#1 .*finished/.test(t) && /redone/.test(t)), 'first cut-off re-runs');
  assert.match(await W.tag('WORKER_STOP', '99'), /no worker #99/);

  // The next worker opens a new board; a failed edit is logged for the sentinel.
  tgCalls.length = 0;
  const errs = []; const realErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  let free; const gate = new Promise((r) => { free = r; });
  W._setDeps({ engine: { workspace: async () => ({ readOnly: false, dir: '/tmp/x' }), ROOT: () => '/tmp/empire-workers-test', run: async () => '', spawnTurn: async ({ onProgress }) => { await gate; onProgress('next step'); await sleep(GAP * 2); return { text: 'ok' }; } }, browse: null, wake: async () => {}, saveNote: async () => {}, board, boardGapMs: GAP, boardRefreshMs: 60e3 });
  await W.tag('WORKER_START', 'code | new job | do it'); await sleep(GAP);
  assert.strictEqual(tgCalls.filter((c) => c.op === 'send').length, 1, 'new board for the next worker');
  editFail = 'telegram editMessageText: Bad Gateway'; free(); await sleep(GAP * 2);
  assert.ok(errs.some((e) => /^workers failed: telegram board/.test(e)), 'failure logged for the sentinel');
  editFail = null; await sleep(GAP * 4);
  console.error = realErr;
  assert.match(tgCalls[tgCalls.length - 1].text, /all done/, 'recovers after a failed edit');

  // WORKER_TG_BOARD=off: no board at all.
  process.env.WORKER_TG_BOARD = 'off'; tgCalls.length = 0;
  await W.tag('WORKER_START', 'code | quiet job | do it'); await sleep(GAP * 3);
  assert.strictEqual(tgCalls.length, 0, 'kill switch');
  delete process.env.WORKER_TG_BOARD;

  // The real Telegram side: silent send, edit in place, "not modified" is fine, nothing in tg_messages but the one line.
  const sent = [];
  global.fetch = async (url, o) => {
    const method = String(url).split('/').pop(); const body = JSON.parse(o.body); sent.push({ method, body });
    if (method === 'editMessageText' && body.text === 'same') return { status: 400, json: async () => ({ ok: false, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' }) };
    return { status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
  };
  const real = W._tgBoardDeps();
  dbRows.length = 0;
  assert.strictEqual(real.ready(), true);
  assert.strictEqual(await real.send('board'), 9);
  assert.deepStrictEqual(sent[0], { method: 'sendMessage', body: { chat_id: '1', text: 'board', disable_notification: true } }, 'silent, on J.A.R.V.I.S.\'s bot');
  await real.edit(9, 'new text');
  assert.deepStrictEqual(sent[1], { method: 'editMessageText', body: { chat_id: '1', message_id: 9, text: 'new text' } });
  await real.edit(9, 'same'); // must not throw
  assert.strictEqual(dbRows.length, 0, 'sends and edits not logged');
  await real.log('[board posted]');
  assert.strictEqual(dbRows.length, 1); assert.strictEqual(dbRows[0][0], 'jarvis');

  // ── Percent from the worker's own plan ──
  assert.deepStrictEqual(W.parsePlan('Plan:\n1. [x] Read the code\n2) [ ] Change it\n- [X] Tick\n3. not a step'), [{ name: 'Read the code', done: true }, { name: 'Change it', done: false }, { name: 'Tick', done: true }]);
  assert.strictEqual(W.parsePlan('no plan here'), null);
  const P = (d, n) => Array.from({ length: n }, (_, i) => ({ name: 's' + i, done: i < d }));
  assert.strictEqual(W.percentOf(null, 'running'), null, 'no plan, no number');
  assert.strictEqual(W.percentOf(P(1, 4), 'running'), 25);
  assert.strictEqual(W.percentOf(P(4, 4), 'running'), 95, 'every step ticked still caps at 95 until it ends');
  assert.strictEqual(W.percentOf(P(1, 4), 'done'), 100, '100 only on success');
  assert.strictEqual(W.progressLabel({ kind: 'code', status: 'running', percent: 50, current: 'Run the tests' }), '▓▓▓▓▓░░░░░ 50% · Run the tests');
  assert.strictEqual(W.progressLabel({ kind: 'code', status: 'running', percent: null }), 'planning');
  assert.strictEqual(W.progressLabel({ kind: 'browse', status: 'running', percent: null, step: 4 }), 'step 4', 'browse with no plan: step N');

  const fsx = require('fs'), pathx = require('path');
  const ROOT = '/tmp/empire-workers-test-plan';
  fsx.rmSync(ROOT, { recursive: true, force: true });
  const writePlan = (dir, text) => { fsx.mkdirSync(dir, { recursive: true }); fsx.writeFileSync(pathx.join(dir, W.PLAN_FILE), text); };
  const steps = [];
  const go = () => new Promise((r) => steps.push(r));
  const next = async () => { while (!steps.length) await sleep(5); steps.shift()(); await sleep(15); };
  tgCalls.length = 0;
  let mode = 'ok';
  W._setDeps({
    engine: {
      workspace: async () => ({ readOnly: false, dir: '/tmp/x' }), ROOT: () => ROOT, run: async () => '',
      spawnTurn: async ({ dir, onProgress, signal }) => {
        onProgress('Reading AGENTS.md'); await go();
        writePlan(dir, '1. [ ] Read the code\n2. [ ] Change it\n3. [ ] Run the tests\n'); onProgress('Writing the plan'); await go();
        writePlan(dir, '1. [x] Read the code\n2. [ ] Change it\n3. [ ] Run the tests\n'); await go(); // read by the 5 s poll, no onProgress
        writePlan(dir, '1. [x] Read the code\n2. [x] Change it\n3. [ ] Run the tests\n'); onProgress('Bash: node test.js');
        if (mode === 'stop') { await new Promise((r) => signal.addEventListener('abort', r)); throw new Error('aborted'); }
        await go();
        if (mode === 'fail') throw new Error('tests failed');
        writePlan(dir, '1. [x] Read the code\n2. [x] Change it\n3. [x] Run the tests\n');
        return { text: 'done' };
      },
    },
    browse: null, wake: async (t) => woke.push(t), saveNote: async () => {}, board, boardGapMs: GAP, boardRefreshMs: 60e3, planPollMs: 10,
  });
  const me = async (id) => (await W.forApp()).find((x) => x.id === id);
  const a = await W.start({ kind: 'code', title: 'plan job', task: 'do it' }); await sleep(15);
  let x = await me(a.id);
  assert.strictEqual(x.percent, null, 'before a plan: no number'); assert.deepStrictEqual(x.plan, []);
  await sleep(GAP * 2);
  assert.match(tgCalls[tgCalls.length - 1].text, new RegExp(`#${a.id} plan job · \\d+ min\\n\\s+planning`), 'board says planning');
  await next(); x = await me(a.id);
  assert.strictEqual(x.percent, 0); assert.strictEqual(x.current, 'Read the code'); assert.strictEqual(x.plan.length, 3);
  await next(); await sleep(30); x = await me(a.id);
  assert.strictEqual(x.percent, 33, 'the poll picks up a tick between steps'); assert.strictEqual(x.current, 'Change it');
  await next(); x = await me(a.id);
  assert.strictEqual(x.percent, 67); assert.strictEqual(x.current, 'Run the tests');
  assert.deepStrictEqual(x.plan.map((p) => p.done), [true, true, false], 'each step ticked or not for the tap view');
  const saved1 = JSON.parse(settings.workers)[a.id];
  assert.strictEqual(saved1.percent, 67, 'saved in app_settings.workers'); assert.strictEqual(saved1.current, 'Run the tests'); assert.strictEqual(saved1.plan.length, 3);
  await sleep(GAP * 2);
  assert.match(tgCalls[tgCalls.length - 1].text, /▓▓▓▓▓▓▓░░░ 67% · Run the tests\n\s+Bash: node test\.js/, 'text bar, percent and current step on the board');
  await next(); await sleep(20); x = await me(a.id);
  assert.strictEqual(x.status, 'done'); assert.strictEqual(x.percent, 100, '100 on success');
  assert.ok(x.plan.every((p) => p.done), 'its last ticks read before the folder goes');
  assert.ok(woke.some((t) => t.includes(`worker #${a.id}`) && /Its plan \(100%\): ✓ 1\. Read the code/.test(t)), 'J.A.R.V.I.S. sees the plan');
  assert.match(await W.statusText(), new RegExp(`#${a.id} code "plan job" — done, 100%`));
  await sleep(GAP * 2);
  assert.match(tgCalls[tgCalls.length - 1].text, new RegExp(`✅ #${a.id} plan job · done · ▓▓▓▓▓▓▓▓▓▓ 100%`));

  mode = 'fail';
  const f = await W.start({ kind: 'code', title: 'fail job', task: 'do it' });
  await next(); await next(); await sleep(30); await next(); await next(); await sleep(20);
  x = await me(f.id);
  assert.strictEqual(x.status, 'failed'); assert.strictEqual(x.percent, 67, 'a failed worker keeps its last percent');
  await sleep(GAP * 2);
  assert.match(tgCalls[tgCalls.length - 1].text, new RegExp(`❌ #${f.id} fail job · failed at 67%`));

  mode = 'stop';
  const st = await W.start({ kind: 'code', title: 'stop job', task: 'do it' });
  await next(); await next(); await sleep(30); await next(); await sleep(20);
  assert.match(await W.stop(st.id), /stopping/); await sleep(30);
  x = await me(st.id);
  assert.strictEqual(x.status, 'stopped'); assert.strictEqual(x.percent, 67, 'a stopped worker keeps its last percent');
  await sleep(GAP * 2);
  assert.match(tgCalls[tgCalls.length - 1].text, new RegExp(`⏹ #${st.id} stop job · stopped at 67%`));

  // Browse: the brain's plan and the plan step it's on.
  let bGo;
  W._setDeps({
    engine: null, wake: async () => {}, saveNote: async () => {}, board, boardGapMs: GAP, boardRefreshMs: 60e3,
    browse: async (persona, name, task, { onStep, onPlan }) => {
      onStep(1, 'opened canva'); await new Promise((r) => { bGo = r; });
      onPlan(['Open Canva', 'Find the design', 'Read pages', 'Write it up'], 3); onStep(2, 'clicked [4] "Design"'); await new Promise((r) => { bGo = r; });
      return { status: 'done', text: 'BROWSE — finished', result: 'ok' };
    },
  });
  const b = await W.start({ kind: 'browse', title: 'canva', task: 'read it' }); await sleep(20);
  x = await me(b.id); assert.strictEqual(x.percent, null); assert.strictEqual(W.progressLabel({ ...x, kind: 'browse' }), 'step 1', 'browse before a plan: step N');
  bGo(); await sleep(20); x = await me(b.id);
  assert.strictEqual(x.percent, 50, 'two of four plan steps behind it'); assert.strictEqual(x.current, 'Read pages');
  assert.deepStrictEqual(x.plan.map((p) => p.done), [true, true, false, false]);
  bGo(); await sleep(20); x = await me(b.id);
  assert.strictEqual(x.percent, 100);
  fsx.rmSync(ROOT, { recursive: true, force: true });

  console.log('workers: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
