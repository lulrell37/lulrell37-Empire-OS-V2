// node server/scripts/test-workers.js — J.A.R.V.I.S.'s workers: a hard cap of 3
// running (whatever WORKERS_MAX says), code workers on GitHub runners (issue +
// dispatch + report comment), one browse at a time on the server, every result
// straight to Mr. Burrus, ids that only count up, restarts pick code workers back
// up without re-running them. All stubbed.
process.env.WORKERS_MAX = '11'; // must still be 3
process.env.WORKER_POLL_MS = '10';
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
  // A worker that needs him (a sign-in) is reported from A.R.A., not J.A.R.V.I.S.
  settings.workers = '{}';
  const fromAra = [];
  const rel = [];
  W._setDeps({ gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, tell: async (t) => told.push(t), tellAra: async (t, spoken) => fromAra.push({ t, spoken }), saveNote: async () => {}, onDone: () => null,
    browse: async () => { await new Promise((r) => rel.push(r)); return { status: 'ask', text: 'BROWSE — paused, needs Mr. Burrus\nGoogle Drive is asking me to sign in.', result: '' }; } });
  await W.tag('WORKER_START', 'browse | Drive pages | read the pages');
  await sleep(20); rel.shift()(); await sleep(40);
  assert.strictEqual(fromAra.length, 1, 'needs-you goes through A.R.A.');
  assert.match(fromAra[0].t, /✋ Worker 1 of 3 stopped — it needs you/);
  assert.match(fromAra[0].spoken, /sign in/);
  // [WORKER_STOP: 1] stops the worker in slot 1
  W._setDeps({ gh: gh.call, repo: () => ({ owner: 'o', repo: 'r' }), slot: async () => () => {}, tell: async (t) => told.push(t), saveNote: async () => {}, onDone: () => null,
    browse: async () => new Promise(() => {}) });
  await W.tag('WORKER_START', 'browse | long one | a long task');
  await sleep(20);
  assert.match(await W.tag('WORKER_STOP', '1'), /stopping/);

  console.log('workers: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
