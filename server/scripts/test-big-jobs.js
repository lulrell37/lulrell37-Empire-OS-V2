// node server/scripts/test-big-jobs.js — a code worker's job too big for one run
// carries on in the next run (same branch, same issue) up to WORKER_MAX_RUNS, and the
// Drive files named in its task get a token only it can use. All stubbed.
process.env.WORKER_POLL_MS = '10';
process.env.WORKER_MAX_RUNS = '3';
const Module = require('module');
const assert = require('assert');
const settings = {};
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './db') return { query: async () => ({ rows: [] }) };
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); } };
  if (req === './redeploy') return { publicUrl: () => 'https://srv.example' };
  return load.call(this, req, parent, ...rest);
};
const W = require('../workers');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ids = W.driveIdsIn('Build it from https://drive.google.com/file/d/1ocGyFcqi7vYL5JD9LTON82d3sBja2icv/view and docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit, also drive: 1ZZZZZZZZZZZZZZZZZZZZZZZZZZ');
  assert.deepStrictEqual(ids, ['1ocGyFcqi7vYL5JD9LTON82d3sBja2icv', '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', '1ZZZZZZZZZZZZZZZZZZZZZZZZZZ']);
  assert.deepStrictEqual(W.driveIdsIn('no files here'), []);

  const dispatched = [], issues = {};
  let n = 50, runId = 700;
  const runs = [];
  W._setDeps({
    repo: () => ({ owner: 'o', repo: 'r' }),
    tell: async () => {}, gh: async (p, o = {}) => {
      if (/\/issues$/.test(p) && o.method === 'POST') { assert.doesNotMatch(o.body.body, /[0-9a-f]{48}/, 'no token in the public issue'); const k = ++n; issues[k] = []; return { number: k, html_url: `https://gh/i/${k}` }; }
      if (/\/dispatches$/.test(p)) { const c = o.body.client_payload; dispatched.push(c); runs.push({ id: ++runId, name: `Worker #${c.worker} — ${c.title}`, created_at: new Date().toISOString(), status: 'in_progress', html_url: 'https://gh/run' }); return {}; }
      if (/\/actions\/runs\?/.test(p)) return { workflow_runs: runs };
      let m = /\/actions\/runs\/(\d+)$/.exec(p); if (m) return runs.find((r) => r.id === Number(m[1])) || {};
      m = /\/issues\/(\d+)\/comments/.exec(p); if (m) return issues[m[1]] || [];
      return {};
    },
  });
  const w = await W.start({ kind: 'code', title: 'Rebuild the website', task: 'Rebuild it from https://drive.google.com/file/d/1ocGyFcqi7vYL5JD9LTON82d3sBja2icv/view' });
  for (let i = 0; i < 100 && !dispatched.length; i++) await sleep(10);
  const first = dispatched[0];
  assert.strictEqual(first.leg, 1); assert.strictEqual(first.max_legs, 3); assert.strictEqual(first.server_url, 'https://srv.example');
  assert.match(first.files_token, /^[0-9a-f]{48}$/);
  assert.ok(await W.fileGrant(first.files_token, '1ocGyFcqi7vYL5JD9LTON82d3sBja2icv'), 'the worker can fetch its file');
  assert.strictEqual(await W.fileGrant(first.files_token, '1ZZZZZZZZZZZZZZZZZZZZZZZZZZ'), null, 'but not any other file');
  assert.strictEqual(await W.fileGrant('wrong', '1ocGyFcqi7vYL5JD9LTON82d3sBja2icv'), null);

  // Run 1 says CONTINUE → run 2 on the same issue and branch, same token.
  const issue = first.issue;
  issues[issue].push({ body: '<!-- worker-result status=continue leg=1 -->\n**Worker — continue**\nCONTINUE\n20 pages left' });
  for (let i = 0; i < 200 && dispatched.length < 2; i++) await sleep(10);
  assert.strictEqual(dispatched[1].leg, 2);
  assert.strictEqual(dispatched[1].issue, issue);
  assert.strictEqual(dispatched[1].branch, first.branch);
  assert.strictEqual(dispatched[1].files_token, first.files_token);
  // Run 2 finishes.
  issues[issue].push({ body: '<!-- worker-result status=done leg=2 -->\n**Worker — done** · branch: pushed `x` (9 commit(s) ahead of main)\nDONE\nAll 39 pages built.' });
  for (let i = 0; i < 200 && W._list()[w.id].status === 'running'; i++) await sleep(10);
  assert.strictEqual(W._list()[w.id].status, 'done');
  assert.match(W._list()[w.id].result, /All 39 pages built/);
  assert.strictEqual(dispatched.length, 2);

  // The last allowed run asking to continue just ends (done, with what's left in its report).
  const w2 = await W.start({ kind: 'code', title: 'Huge', task: 'huge job' });
  for (let i = 0; i < 100 && dispatched.length < 3; i++) await sleep(10);
  assert.strictEqual(dispatched[2].files_token, '', 'no Drive files, no token');
  const i2 = dispatched[2].issue;
  for (const leg of [1, 2]) {
    issues[i2].push({ body: `<!-- worker-result status=continue leg=${leg} -->\nCONTINUE` });
    for (let i = 0; i < 200 && dispatched.filter((x) => x.issue === i2).length < leg + 1; i++) await sleep(10);
  }
  assert.strictEqual(dispatched.filter((x) => x.issue === i2).length, 3, 'three runs, no more');
  issues[i2].push({ body: '<!-- worker-result status=done leg=3 -->\nPARTLY DONE\n2 videos left' });
  for (let i = 0; i < 200 && W._list()[w2.id].status === 'running'; i++) await sleep(10);
  // A PARTLY DONE report is never shown as done (worker 59): it waits on him, branch still shippable.
  assert.strictEqual(W._list()[w2.id].status, 'needs_you');
  assert.ok(W._list()[w2.id].partial && W._list()[w2.id].percent !== 100);
  console.log('big jobs: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
