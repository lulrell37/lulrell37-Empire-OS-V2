// node server/scripts/test-worker-tools.js — a code worker running J.A.R.V.I.S.'s tags
// (server/workerTools.js): bad/expired token rejected, a read tag runs, send/delete/ship
// tags become Confirm cards instead of running, the token never reaches the public issue.
process.env.WORKER_POLL_MS = '10';
const Module = require('module');
const assert = require('assert');
const settings = {};
const pending = [];
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === './db') return { query: async (sql, p) => { if (/INSERT INTO tg_pending/.test(sql)) pending.push({ id: p[0], persona: p[1], kind: p[2], label: p[3], payload: JSON.parse(p[5]) }); return { rows: [] }; } };
  if (req === './syncStore') return { getSetting: async (k, f) => (k in settings ? settings[k] : f), setSetting: async (k, v) => { settings[k] = String(v); }, newId: () => Math.random().toString(16).slice(2).padEnd(16, '0') };
  if (req === './redeploy') return { publicUrl: () => 'https://srv.example' };
  return load.call(this, req, parent, ...rest);
};
const WT = require('../workerTools');
const W = require('../workers');

const ran = [];
const cards = [];
// A stand-in for personaRuntime: findTags is the real scanner's contract ({name,arg}).
const runtime = {
  findTags: (t) => [...String(t).matchAll(/\[([A-Z_]+)(?::\s*([^\]]*))?\]/g)].map((m) => ({ name: m[1], arg: (m[2] || '').trim() })),
  runInjections: async (text) => { ran.push(['inj', text]); return /SEARCH_WEB/.test(text) ? 'SEARCH_WEB "gold":\nGold is 2650' : ''; },
  applyEffects: async (text) => { ran.push(['fx', text]); return { notes: [], warnings: [], confirms: /SEND_EMAIL/.test(text) ? [{ id: 'abc', label: 'Send email', detail: 'To: x' }] : [] }; },
};
WT._setDeps({ runtime, sendCard: async (c) => { cards.push(c); } });

(async () => {
  // Token: issued per worker, only that worker, expires, revoked at the end.
  const tok = await WT.grantTools({ id: 61 });
  assert.match(tok, /^[0-9a-f]{48}$/);
  assert.ok(await WT.toolGrant(tok, 61));
  assert.strictEqual(await WT.toolGrant(tok, 62), null, 'not another worker');
  assert.strictEqual(await WT.toolGrant('nope', 61), null, 'bad token');
  assert.strictEqual(await WT.toolGrant('', 61), null, 'no token');
  const g = JSON.parse(settings.worker_tool_grants); g[tok].exp = Date.now() - 1; settings.worker_tool_grants = JSON.stringify(g);
  assert.strictEqual(await WT.toolGrant(tok, 61), null, 'expired token');
  const tok2 = await WT.grantTools({ id: 61 });
  await WT.revoke(61);
  assert.strictEqual(await WT.toolGrant(tok2, 61), null, 'revoked when the worker ends');

  // The HTTP handler rejects before running anything.
  const mkRes = () => { const r = { code: 200, body: null, headersSent: false, status(c) { r.code = c; return r; }, json(b) { r.body = b; r.headersSent = true; return r; } }; return r; };
  const live = await WT.grantTools({ id: 61 });
  let res = mkRes();
  await WT.handler({ params: { id: '61' }, get: () => 'wrong', body: '[SEARCH_WEB: gold]' }, res);
  assert.strictEqual(res.code, 403); assert.strictEqual(ran.length, 0, 'bad token runs nothing');
  res = mkRes();
  await WT.handler({ params: { id: '61' }, get: () => live, body: '' }, res);
  assert.strictEqual(res.code, 400);

  // A read tag runs at once.
  res = mkRes();
  await WT.handler({ params: { id: '61' }, get: () => live, body: '[SEARCH_WEB: gold]' }, res);
  assert.strictEqual(res.code, 200);
  assert.match(res.body.receipts, /Gold is 2650/);
  assert.ok(ran.some((r) => r[0] === 'inj' && /SEARCH_WEB/.test(r[1])));
  assert.strictEqual(pending.length, 0);

  // Ship / trade / media tags never run: they become pending Confirm cards.
  ran.length = 0;
  const out = await WT.run(61, '[WORKER_SHIP: all] [SEND_PHOTO: https://x.test/a.png | hi] [TRADE_ENTER: XAUUSD | buy | 2600 | 2700]');
  assert.strictEqual(ran.length, 0, 'acting tags are not run directly');
  assert.strictEqual(pending.length, 3);
  assert.ok(pending.every((p) => p.kind === 'worker_tag' && p.payload.worker === 61));
  assert.deepStrictEqual(pending.map((p) => p.payload.name), ['WORKER_SHIP', 'SEND_PHOTO', 'TRADE_ENTER']);
  assert.strictEqual(pending[2].persona, 'talon');
  assert.strictEqual(cards.length, 3);
  assert.match(out, /waiting on Mr\. Burrus's Confirm tap/);
  assert.doesNotMatch(out, /✓/);

  // A tag with its own confirm (send email) runs through applyEffects and its card is sent.
  cards.length = 0;
  const out2 = await WT.run(61, '[SEND_EMAIL: a@b.c | Hi | body]');
  assert.match(out2, /waiting on Mr\. Burrus's Confirm tap: Send email/);
  assert.strictEqual(cards.length, 1);

  // Mixed: the read runs, the delete-class tag waits.
  ran.length = 0; cards.length = 0; pending.length = 0;
  const out3 = await WT.run(61, '[SEARCH_WEB: gold] [WORKER_SHIP: 12]');
  assert.match(out3, /Gold is 2650/); assert.match(out3, /WORKER_SHIP: waiting/);
  assert.ok(!ran.some((r) => /WORKER_SHIP/.test(r[1])));

  // Every call is logged with the worker id.
  assert.ok(JSON.parse(settings.worker_tool_log).every((l) => /worker #61/.test(l)));

  // The token is in the dispatch payload and never in the public issue.
  const dispatched = [], issues = {};
  let n = 70;
  W._setDeps({
    repo: () => ({ owner: 'o', repo: 'r' }), tell: async () => {},
    gh: async (p, o = {}) => {
      if (/\/issues$/.test(p) && o.method === 'POST') { assert.doesNotMatch(o.body.body, /[0-9a-f]{48}/, 'no token in the public issue'); const k = ++n; issues[k] = []; return { number: k, html_url: `https://gh/i/${k}` }; }
      if (/\/dispatches$/.test(p)) { dispatched.push(o.body.client_payload); return {}; }
      if (/\/actions\/runs\?/.test(p)) return { workflow_runs: [] };
      const m = /\/issues\/(\d+)\/comments/.exec(p); if (m) return issues[m[1]] || [];
      return {};
    },
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await W.start({ kind: 'code', title: 'tools check', task: 'use the tools' });
  for (let i = 0; i < 100 && !dispatched.length; i++) await sleep(10);
  assert.ok(dispatched.length, 'the worker was dispatched');
  const sent = dispatched[0];
  assert.match(sent.tools_token, /^[0-9a-f]{48}$/, 'worker-run payload carries the tools token');
  assert.ok(await WT.toolGrant(sent.tools_token, sent.worker), 'and it works for that worker');
  assert.strictEqual(await WT.toolGrant(sent.tools_token, sent.worker + 1), null, 'only that worker');
  for (const body of Object.values(issues)) assert.ok(!JSON.stringify(body).includes(sent.tools_token));

  // The workflow masks it and the CLI exists.
  // worker.yml itself can't be pushed by the worker app (no `workflows` permission), so the edit ships as a patch.
  const yml = require('fs').readFileSync(require('path').join(__dirname, '../../scripts/worker-yml-tools.patch'), 'utf8');
  assert.match(yml, /tools_token/); assert.match(yml, /add-mask::\$t[\s\S]*WORKER_TOOLS_TOKEN/); assert.match(yml, /scripts\/jarvis-tool\.js/);
  assert.ok(require('fs').existsSync(require('path').join(__dirname, '../../scripts/jarvis-tool.js')));
  console.log('worker-tools: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
