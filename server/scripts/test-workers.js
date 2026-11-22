// node server/scripts/test-workers.js — J.A.R.V.I.S.'s workers: a hard cap of 3
// running (whatever WORKERS_MAX says), code workers on GitHub runners (issue +
// dispatch + report comment), one browse at a time on the server, every result
// straight to Mr. Burrus, ids that only count up, restarts pick code workers back
// up without re-running them; the live Telegram board (one silent message, edited
// in place, throttled) and the real percent from each worker's plan. All stubbed.
process.env.WORKERS_MAX = '11'; // must still be 3
process.env.WORKER_POLL_MS = '10';
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

// A fake GitHub: issues, dispatches, runs, comments.
function fakeGitHub() {
  const gh = { issues: {}, dispatched: [], runs: [], cancelled: [], n: 100 };
  gh.call = async (p, o = {}) => {
    if (/\/issues$/.test(p) && o.method === 'POST') {
      assert.doesNotMatch(o.body.body, /@claude/i, 'never wakes claude.yml');
      const number = ++gh.n; gh.issues[number] = { body: o.body.body, comments: [] };
      return { number, html_url: `https://github.com/x/y/issues/${number}` };
    }
    if (/\/dispatches$/.test(p)) {
      const c = o.body.client_payload; gh.dispatched.push(c);
      gh.runs.push({ id: 900 + gh.runs.length, name: `Worker #${c.worker} — ${c.title}`, created_at: new Date().toISOString(), status: 'in_progress', html_url: 'https://github.com/run', issue: c.issue });
      return {};
    }
    if (/\/actions\/runs\?/.test(p)) return { workflow_runs: gh.runs };
    let m = /\/actions\/runs\/(\d+)\/cancel$/.exec(p);
    if (m) { gh.cancelled.push(Number(m[1])); return {}; }
    m = /\/actions\/runs\/(\d+)$/.exec(p);
    if (m) return gh.runs.find((r) => r.id === Number(m[1]));
    m = /\/issues\/(\d+)\/comments/.exec(p);
    if (m) return gh.issues[m[1]].comments;
    throw new Error(`unexpected ${p}`);
  };
  gh.finish = (worker, status = 'done', text = 'DONE\nBuilt it, tests pass.') => {
    const c = gh.dispatched.find((x) => x.worker === String(worker));
    gh.issues[c.issue].comments.push({ body: `<!-- worker-result status=${status} -->\n**Worker #${worker} — ${status}** after 60s · branch: pushed \`${c.branch}\` (1 commit(s) ahead of main) · [run](x)\n\n${text}` });
    const r = gh.runs.find((x) => x.issue === c.issue); r.status = 'completed'; r.conclusion = status === 'done' ? 'success' : 'failure';
  };
  return gh;
}

(async () => {
  let gh = fakeGitHub();
  const told = [], notes = [], releases = [];
  let browsing = 0, maxBrowsing = 0;
  W._setDeps({
    gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {},
    browse: async (persona, name, task, { onStep }) => {
      assert.match(persona, /^worker-\d+$/);
      browsing++; maxBrowsing = Math.max(maxBrowsing, browsing);
      onStep(1, 'opened canva');
      await new Promise((r) => releases.push(r));
      browsing--;
      return { status: 'done', text: 'BROWSE — finished', result: 'Page 1: hello' };
    },
    tell: async (t) => told.push(t),
    saveNote: async (title, body) => notes.push({ title, body }),
    onDone: () => null,
  });

  for (let i = 1; i <= 4; i++) await W.tag('WORKER_START', `code | job ${i} | do job ${i}, @claude please`);
  await W.tag('WORKER_START', 'browse | Canva 1-8 | read pages | Canva pages 1-8');
  await W.tag('WORKER_START', 'browse | Canva 9-16 | read pages | Canva pages 9-16');
  await sleep(60);
  let app = await W.forApp();
  assert.strictEqual(app.filter((x) => x.status === 'running').length, 3, 'hard cap of 3, even with WORKERS_MAX=11');
  assert.strictEqual(gh.dispatched.length, 3, 'three runs started on GitHub');
  const slots = app.filter((x) => x.status === 'running').map((x) => x.slot).sort();
  assert.deepStrictEqual(slots, [1, 2, 3], 'he sees slots 1-3, never a running count');
  assert.ok(app.find((x) => x.id === '1').url, 'GitHub link on the strip');
  assert.match(app.find((x) => x.id === '1').progress, /GitHub/);

  gh.finish(1);
  await sleep(80);
  assert.strictEqual(told.length, 1, 'result straight to him');
  assert.match(told[0], /✅ Worker 1 of 3 finished/);
  assert.match(told[0], /Built it, tests pass/);
  assert.match(told[0], /Full report: https:\/\/github.com\/x\/y\/issues\/101/);
  app = await W.forApp();
  assert.strictEqual(app.filter((x) => x.status === 'running').length, 3, 'next in line starts');

  gh.finish(2, 'failed', 'FAILED\nThe tests would not run.');
  gh.finish(3);
  await sleep(80);
  app = await W.forApp();
  const run = app.filter((x) => x.status === 'running');
  assert.ok(run.length <= 3);
  assert.ok(told.some((t) => /❌ Worker [1-3] of 3 FAILED/.test(t)));
  // two browse workers queued: only one runs at a time
  await sleep(40);
  assert.strictEqual(maxBrowsing, 1, 'one browse at a time on the server');
  while (releases.length || (await W.forApp()).some((x) => x.status !== 'done' && x.status !== 'failed')) {
    if (releases.length) releases.shift()();
    for (const c of gh.dispatched) if (!gh.issues[c.issue].comments.length) gh.finish(c.worker);
    await sleep(40);
  }
  assert.strictEqual(maxBrowsing, 1);
  assert.strictEqual(told.length, 6, 'every worker reported');
  assert.ok(told.every((t) => /Worker [1-3] of 3/.test(t)), 'every report names a slot of 1-3');
  assert.deepStrictEqual(notes.map((n) => n.title).sort(), ['Canva pages 1-8', 'Canva pages 9-16'], 'browse results saved to Drive');
  assert.match(await W.statusText(), /0 of 3 running, 0 waiting/);

  // ids only count up, even after the day's list is pruned
  const saved = JSON.parse(settings.workers);
  settings.workers = '{}';
  W._setDeps({ gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, browse: null, tell: async (t) => told.push(t), saveNote: async () => {}, onDone: () => null });
  await W.tag('WORKER_START', 'code | later | another job');
  await sleep(30);
  assert.ok(Object.keys(W._list()).includes('7'), 'the next id is 7, not 1');
  gh.finish(7);
  await sleep(60);

  // A restart: a code worker still running on GitHub is watched again, not re-run.
  gh = fakeGitHub();
  saved['1'].status = 'running'; // was dispatched as issue 101
  gh.issues[101] = { body: 'x', comments: [] };
  gh.dispatched.push({ worker: '1', issue: 101, branch: saved['1'].branch });
  gh.runs.push({ id: saved['1'].runId, name: 'Worker #1 — job 1', created_at: new Date().toISOString(), status: 'in_progress', issue: 101, html_url: 'r' });
  settings.workers = JSON.stringify({ 1: saved['1'] });
  W._setDeps({ gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, browse: null, tell: async (t) => told.push(t), saveNote: async () => {}, onDone: () => null });
  await W.recover();
  await sleep(40);
  assert.strictEqual(Object.keys(gh.issues).length, 1, 'no new issue on a restart');
  assert.strictEqual(W._list()['1'].status, 'running');
  // and a stop cancels its GitHub run
  assert.match(await W.tag('WORKER_STOP', '1'), /stopping/);
  await sleep(40);
  assert.deepStrictEqual(gh.cancelled, [saved['1'].runId]);
  assert.strictEqual(W._list()['1'].status, 'stopped');

  // GitHub never starts the run → it fails and says why
  gh = fakeGitHub();
  const orig = gh.call;
  gh.call = async (p, o) => (/\/dispatches$/.test(p) ? {} : orig(p, o));
  settings.workers = '{}';
  W._setDeps({ gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, browse: null, tell: async (t) => told.push(t), saveNote: async () => {}, onDone: () => null });
  await W.tag('WORKER_START', 'code | lost | never starts');
  await sleep(20);
  const w = Object.values(W._list())[0];
  w.dispatchedAt = Date.now() - 7 * 60e3; // as if dispatched 7 min ago
  await sleep(60);
  assert.ok(told.some((t) => /FAILED/.test(t) && /never started its run/.test(t)), 'a run GitHub never started is reported');

  assert.match(await W.tag('WORKER_STOP', '99'), /no worker 99/);
  // Stopped for a sign-in: A.R.A. finds it in his email/notes and the worker carries on.
  settings.workers = '{}';
  const calls = [], asked = [];
  const askThenDone = async (persona, name, task, o) => {
    calls.push({ task, secrets: o.secrets });
    if (calls.length === 1) return { status: 'ask', text: 'BROWSE — paused, needs Mr. Burrus\nCanva is asking me to sign in — which email is the account under?', result: '', url: 'https://canva.com/login' };
    return { status: 'done', text: 'BROWSE — finished', result: 'Read all 16 pages.' };
  };
  W._setDeps({ gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, tell: async (t) => told.push(t), saveNote: async () => {}, onDone: () => null,
    browse: askThenDone, find: async (q, o) => { asked.push({ q, o }); return { what: 'the Canva account email', value: 'him@example.com', secret: false }; } });
  const before = told.length;
  await W.tag('WORKER_START', 'browse | Canva pages | read the pages');
  await sleep(60);
  assert.strictEqual(asked.length, 1, 'A.R.A. was asked first');
  assert.match(calls[1].task, /A\.R\.A\. FOUND WHAT YOU STOPPED FOR — the Canva account email/);
  assert.strictEqual(calls[1].secrets.INFO, 'him@example.com');
  assert.match(told[before], /✅ Worker 1 of 3 finished/, 'he only hears the result');
  // A.R.A. can't find it → J.A.R.V.I.S. (not A.R.A.) tells him it needs him.
  settings.workers = '{}';
  W._setDeps({ gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, tell: async (t) => told.push(t), saveNote: async () => {}, onDone: () => null,
    browse: async () => ({ status: 'ask', text: 'BROWSE — paused\nGoogle wants a code texted to his phone (verification).', result: '' }), find: async () => null });
  await W.tag('WORKER_START', 'browse | Drive | open drive');
  await sleep(60);
  assert.match(told[told.length - 1], /✋ Worker 1 of 3 stopped — it needs you/);
  // His OK to act is never fetched from email: that one goes straight to him.
  assert.strictEqual(require('../araFinds').asksForInfo('Should I send the email to the client? Approve?'), false);
  assert.strictEqual(require('../araFinds').asksForInfo('It needs the verification code emailed to him'), true);
  // [WORKER_STOP: 1] stops the worker in slot 1
  W._setDeps({ gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, tell: async (t) => told.push(t), saveNote: async () => {}, onDone: () => null,
    browse: async () => new Promise(() => {}) });
  await W.tag('WORKER_START', 'browse | long one | a long task');
  await sleep(20);
  assert.match(await W.tag('WORKER_STOP', '1'), /stopping/);

  // ── Live Telegram board + real percent from each worker's plan ──
  // Code workers run on GitHub, so their plan arrives as a <!-- worker-plan --> issue comment.
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
  const baseDeps = (g, extra = {}) => ({ gh: g.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, browse: null, tell: async (t) => told.push(t), saveNote: async () => {}, onDone: () => null, board, boardGapMs: GAP, boardRefreshMs: 60e3, ...extra });
  const me = async (id) => (await W.forApp()).find((x) => x.id === id);
  const setPlan = (g, worker, text) => { const c = g.dispatched.find((x) => x.worker === String(worker)); const cs = g.issues[c.issue].comments; const i = cs.findIndex((k) => /worker-plan/.test(k.body)); const body = `<!-- worker-plan -->\n${text}`; if (i >= 0) cs[i].body = body; else cs.push({ body }); };
  const P = (d, n) => Array.from({ length: n }, (_, i) => ({ name: 's' + i, done: i < d }));

  assert.deepStrictEqual(W.parsePlan('Plan:\n1. [x] Read the code\n2) [ ] Change it\n- [X] Tick\n3. not a step'), [{ name: 'Read the code', done: true }, { name: 'Change it', done: false }, { name: 'Tick', done: true }]);
  assert.strictEqual(W.parsePlan('no plan here'), null);
  assert.strictEqual(W.percentOf(null, 'running'), null, 'no plan, no number');
  assert.strictEqual(W.percentOf(P(1, 4), 'running'), 25);
  assert.strictEqual(W.percentOf(P(4, 4), 'running'), 95, 'every step ticked still caps at 95 until it ends');
  assert.strictEqual(W.percentOf(P(1, 4), 'done'), 100, '100 only on success');
  assert.strictEqual(W.progressLabel({ kind: 'code', status: 'running', percent: 50, current: 'Run the tests' }), '▓▓▓▓▓░░░░░ 50% · Run the tests');
  assert.strictEqual(W.progressLabel({ kind: 'code', status: 'running', percent: null }), 'planning');
  assert.strictEqual(W.progressLabel({ kind: 'browse', status: 'running', percent: null, step: 4 }), 'step 4', 'browse with no plan: step N');

  gh = fakeGitHub(); settings.workers = '{}'; delete settings.workers_tg_board;
  W._setDeps(baseDeps(gh));
  const a = await W.start({ kind: 'code', title: 'plan job', task: 'do it' }); await sleep(40);
  let x = await me(a.id);
  assert.strictEqual(x.percent, null, 'before a plan: no number'); assert.deepStrictEqual(x.plan, []);
  await sleep(GAP * 2);
  assert.strictEqual(tgCalls.filter((c) => c.op === 'send').length, 1, 'one board message');
  assert.match(tgCalls[tgCalls.length - 1].text, /1 running/);
  assert.match(tgCalls[tgCalls.length - 1].text, /🔧 Worker 1\/3 plan job · \d+ min\n\s+planning\n\s+Working on/, 'slot, title, minutes, planning, action — no running id');
  assert.doesNotMatch(tgCalls[tgCalls.length - 1].text, /#\d/, 'the board names slots, not ids');
  assert.strictEqual(boardSaved().messageId, 501, 'board id saved for restarts');
  assert.strictEqual(boardLogs.length, 1); assert.ok(boardLogs[0].length < 200, 'first send logged once, as one short line');
  setPlan(gh, a.id, '1. [ ] Read the code\n2. [ ] Change it\n3. [ ] Run the tests\n'); await sleep(40); x = await me(a.id);
  assert.strictEqual(x.percent, 0); assert.strictEqual(x.current, 'Read the code'); assert.strictEqual(x.plan.length, 3);
  setPlan(gh, a.id, '1. [x] Read the code\n2. [x] Change it\n3. [ ] Run the tests\n'); await sleep(40); x = await me(a.id);
  assert.strictEqual(x.percent, 67); assert.strictEqual(x.current, 'Run the tests');
  assert.deepStrictEqual(x.plan.map((p) => p.done), [true, true, false], 'each step ticked or not for the tap view');
  const saved1 = JSON.parse(settings.workers)[a.id];
  assert.strictEqual(saved1.percent, 67, 'saved in app_settings.workers'); assert.strictEqual(saved1.current, 'Run the tests'); assert.strictEqual(saved1.plan.length, 3);
  assert.match(await W.statusText(), /67%/);
  await sleep(GAP * 2);
  assert.match(tgCalls[tgCalls.length - 1].text, /▓▓▓▓▓▓▓░░░ 67% · Run the tests/, 'text bar, percent and current step on the board');
  setPlan(gh, a.id, '1. [x] Read the code\n2. [x] Change it\n3. [x] Run the tests\n'); await sleep(40); x = await me(a.id);
  assert.strictEqual(x.percent, 95, 'all ticked is still 95 until it ends');
  gh.finish(a.id); await sleep(60); x = await me(a.id);
  assert.strictEqual(x.status, 'done'); assert.strictEqual(x.percent, 100, '100 on success');
  await sleep(GAP * 3);
  const last = tgCalls[tgCalls.length - 1];
  assert.strictEqual(last.op, 'edit'); assert.strictEqual(last.id, 501, 'edited in place');
  assert.match(last.text, /all done ✓/, 'final all-done edit'); assert.match(last.text, /✅ Worker 1\/3 plan job · done · ▓▓▓▓▓▓▓▓▓▓ 100%/, 'finished ones stay listed');
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

  // failed and stopped keep their last percent
  tgCalls.length = 0;
  const f = await W.start({ kind: 'code', title: 'fail job', task: 'do it' }); await sleep(40);
  setPlan(gh, f.id, '1. [x] Read\n2. [ ] Change\n3. [ ] Test\n4. [ ] Ship\n'); await sleep(40);
  gh.finish(f.id, 'failed', 'FAILED\ntests would not run'); await sleep(60);
  x = await me(f.id);
  assert.strictEqual(x.status, 'failed'); assert.strictEqual(x.percent, 25, 'a failed worker keeps its last percent');
  await sleep(GAP * 2);
  assert.match(tgCalls[tgCalls.length - 1].text, /❌ Worker 1\/3 fail job · failed at 25%/);
  const st = await W.start({ kind: 'code', title: 'stop job', task: 'do it' }); await sleep(40);
  setPlan(gh, st.id, '1. [x] Read\n2. [x] Change\n3. [ ] Test\n'); await sleep(40);
  assert.match(await W.stop(String((await me(st.id)).slot)), /stopping/); await sleep(60);
  x = await me(st.id);
  assert.strictEqual(x.status, 'stopped'); assert.strictEqual(x.percent, 67, 'a stopped worker keeps its last percent');
  await sleep(GAP * 2);
  assert.match(tgCalls[tgCalls.length - 1].text, /⏹ Worker \d\/3 stop job · stopped at 67%/);

  // Browse: the brain's plan and the plan step it's on.
  let bGo;
  W._setDeps(baseDeps(gh, { browse: async (persona, name, task, { onStep, onPlan }) => {
    onStep(1, 'opened canva'); await new Promise((r) => { bGo = r; });
    onPlan(['Open Canva', 'Find the design', 'Read pages', 'Write it up'], 3); onStep(2, 'clicked [4] "Design"'); await new Promise((r) => { bGo = r; });
    return { status: 'done', text: 'BROWSE — finished', result: 'ok' };
  } }));
  const b = await W.start({ kind: 'browse', title: 'canva', task: 'read it' }); await sleep(30);
  x = await me(b.id); assert.strictEqual(x.percent, null); assert.strictEqual(W.progressLabel({ ...x, kind: 'browse' }), 'step 1', 'browse before a plan: step N');
  bGo(); await sleep(30); x = await me(b.id);
  assert.strictEqual(x.percent, 50, 'two of four plan steps behind it'); assert.strictEqual(x.current, 'Read pages');
  assert.deepStrictEqual(x.plan.map((p) => p.done), [true, true, false, false]);
  bGo(); await sleep(40); x = await me(b.id);
  assert.strictEqual(x.percent, 100);

  // A restart: the board in app_settings.workers_tg_board keeps being edited, never re-sent.
  gh = fakeGitHub(); tgCalls.length = 0;
  const cut = { 1: { id: '1', kind: 'code', title: 'cut off', task: 't', status: 'running', slot: 1, attempts: 2, createdAt: Date.now() - 6e4, startedAt: Date.now() - 6e4, step: 3, progress: 'x', percent: 40, plan: P(2, 5) } };
  settings.workers = JSON.stringify(cut);
  settings.workers_tg_board = JSON.stringify({ messageId: 77, text: 'board from before the restart' });
  W._setDeps(baseDeps(gh));
  await W.recover(); await sleep(GAP * 4);
  assert.strictEqual(tgCalls.filter((c) => c.op === 'send').length, 0, 'a restart keeps the same board');
  assert.ok(tgCalls.length && tgCalls.every((c) => c.id === 77), 'and edits message 77');
  assert.match(tgCalls[tgCalls.length - 1].text, /all done/); assert.match(tgCalls[tgCalls.length - 1].text, /❌ Worker 1\/3 cut off · failed at 40%/);
  assert.strictEqual(boardSaved(), null);

  // The next worker opens a new board; a failed edit is logged for the sentinel.
  tgCalls.length = 0; settings.workers = '{}';
  const errs = []; const realErr = console.error; console.error = (...a2) => errs.push(a2.join(' '));
  W._setDeps(baseDeps(gh));
  const n1 = await W.start({ kind: 'code', title: 'new job', task: 'do it' }); await sleep(GAP * 2);
  assert.strictEqual(tgCalls.filter((c) => c.op === 'send').length, 1, 'new board for the next worker');
  editFail = 'telegram editMessageText: Bad Gateway'; setPlan(gh, n1.id, '1. [x] a\n2. [ ] b\n'); await sleep(GAP * 3);
  assert.ok(errs.some((e) => /^workers failed: telegram board/.test(e)), 'failure logged for the sentinel');
  editFail = null; gh.finish(n1.id); await sleep(GAP * 5);
  console.error = realErr;
  assert.match(tgCalls[tgCalls.length - 1].text, /all done/, 'recovers after a failed edit');

  // Failures are always logged with the cause, and kept in app_settings.worker_failures.
  {
    const errs2 = []; const re = console.error; console.error = (...x) => errs2.push(x.join(' '));
    settings.workers = '{}'; delete settings.worker_failures; tgCalls.length = 0;
    W._setDeps(baseDeps(gh, { browse: async () => ({ status: 'failed', text: 'page never loaded' }) }));
    const bf = await W.start({ kind: 'browse', title: 'broken browse', task: 'open example.com' }); await sleep(GAP * 3);
    assert.ok(errs2.some((e) => e === `workers failed: #${bf.id} broken browse: page never loaded`), 'browse failure logged with cause');
    W._setDeps(baseDeps(gh, { browse: async () => { throw new Error('chrome crashed'); } }));
    const bt = await W.start({ kind: 'browse', title: 'throwing browse', task: 'open example.org' }); await sleep(GAP * 3);
    assert.ok(errs2.some((e) => e === `workers failed: #${bt.id} throwing browse: chrome crashed`), 'thrown failure logged');
    assert.ok(!errs2.some((e) => /^worker failed/.test(e)), 'never the singular prefix');
    // a report that can't be sent
    W._setDeps(baseDeps(gh, { browse: async () => ({ status: 'done', text: 'ok', result: '' }), tell: async () => { throw new Error('no bot'); } }));
    await W.start({ kind: 'browse', title: 'unsent', task: 'open example.net' }); await sleep(GAP * 3);
    assert.ok(errs2.some((e) => /^workers failed: couldn't report/.test(e)), 'report failure uses the plural prefix');
    // persisted log
    const saved = JSON.parse(settings.worker_failures);
    assert.ok(saved.length >= 2); const last = saved[saved.length - 1];
    assert.deepStrictEqual(Object.keys(last).sort(), ['at', 'id', 'kind', 'reason', 'title']);
    assert.strictEqual(last.reason, 'chrome crashed'); assert.strictEqual(last.kind, 'browse');
    // keeps the last 50
    for (let i = 0; i < 60; i++) await W.logFailure({ id: 900 + i, title: 't', kind: 'code' }, `r${i}`);
    const kept = JSON.parse(settings.worker_failures);
    assert.strictEqual(kept.length, 50); assert.strictEqual(kept[49].reason, 'r59'); assert.strictEqual(kept[0].reason, 'r10');
    // empty reason
    await W.logFailure({ id: 1, title: 'x', kind: 'code' }, '');
    assert.strictEqual(JSON.parse(settings.worker_failures).pop().reason, 'no reason recorded');
    // [WORKER_STATUS] shows why
    const l = W._list();
    l.s1 = { id: 's1', kind: 'code', title: 'F', status: 'failed', createdAt: 1, result: 'x'.repeat(300) };
    l.s2 = { id: 's2', kind: 'code', title: 'S', status: 'stopped', createdAt: 2, result: '' };
    l.s3 = { id: 's3', kind: 'browse', title: 'N', status: 'needs_you', createdAt: 3, result: 'needs a code' };
    const st = await W.statusText();
    assert.ok(st.includes(`reason: ${'x'.repeat(200)}`) && !st.includes('x'.repeat(201)), 'first 200 chars');
    assert.match(st, /"S" — stopped.*no reason recorded/); assert.match(st, /"N" — needs_you.*needs a code/);
    delete l.s1; delete l.s2; delete l.s3;
    // Drive file links are refused for browse workers (and logged), fine for code workers
    errs2.length = 0; let refused = '';
    await W.start({ kind: 'browse', title: 'drive', task: 'read https://docs.google.com/document/d/abc/edit' }).catch((e) => { refused = e.message; });
    assert.match(refused, /READ_FILE_ID/); assert.match(refused, /Drive tags/);
    assert.ok(errs2.some((e) => /^workers failed: .*drive.*READ_FILE_ID/.test(e)), 'refusal logged');
    refused = '';
    await W.start({ kind: 'browse', title: 'drive2', task: 'see https://drive.google.com/file/d/abc/view' }).catch((e) => { refused = e.message; });
    assert.match(refused, /Drive tags/);
    const okc = await W.start({ kind: 'code', title: 'mentions drive', task: 'summarise https://docs.google.com/document/d/abc' });
    assert.strictEqual(okc.kind, 'code');
    // a queued legacy browse worker with such a link fails at run time, never opens it
    let opened = false;
    W._setDeps(baseDeps(gh, { browse: async () => { opened = true; return { status: 'done', text: 'x' }; } }));
    settings.workers = JSON.stringify({ q1: { id: 'q1', kind: 'browse', title: 'old', task: 'go to https://drive.google.com/x', status: 'queued', createdAt: 1 } });
    await W.recover(); await sleep(GAP * 3);
    assert.strictEqual(opened, false); assert.match(String(W._list().q1.result), /READ_FILE_ID/); assert.strictEqual(W._list().q1.status, 'failed');
    console.error = re;
    assert.match(require('fs').readFileSync(require('path').join(__dirname, '..', 'jarvisEngine.js'), 'utf8'), /never opens a drive\.google\.com or docs\.google\.com file link[^]*READ_FILE_ID/, 'FRONT DESK carries the rule');
  }

  // WORKER_TG_BOARD=off: no board at all.
  process.env.WORKER_TG_BOARD = 'off'; tgCalls.length = 0;
  await W.start({ kind: 'code', title: 'quiet job', task: 'do it' }); await sleep(GAP * 3);
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
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
