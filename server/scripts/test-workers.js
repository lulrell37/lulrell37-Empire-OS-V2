// node server/scripts/test-workers.js — J.A.R.V.I.S.'s workers: 3 at a time, the rest
// wait; progress is visible; every result wakes him; restarts re-run once; the live
// Telegram board (one silent message, edited in place, throttled). All stubbed.
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
    run: async () => '', spawnTurn: async ({ onProgress, brief }) => { assert.match(brief, /never push main/i); onProgress('Editing server/x.js'); await hold(); return { text: 'Built it on the branch, tests pass.' }; },
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
  assert.match(live, /#1 job 1 · \d+ min · step 1\n\s+Editing server\/x\.js/, 'number, title, minutes, step, action');
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
  console.log('workers: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
