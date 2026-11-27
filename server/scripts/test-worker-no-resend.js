// node server/scripts/test-worker-no-resend.js — a worker picked back up after a restart
// doesn't report again when its report is already in J.A.R.V.I.S.'s chat (2026-11-27, #91).
const assert = require('assert');
const workers = require('../workers');
const sent = [];
let history = [];
const db = { query: async (sql, p) => ({ rows: history.filter((h) => h.ts > p[0] && h.content.includes(p[1].replace(/%/g, ''))) }) };
workers._setDeps({ db, onDone: async (w) => { sent.push(w.id); return true; } });
const wait = () => new Promise((r) => setTimeout(r, 30));
(async () => {
  const url = 'https://github.com/x/y/issues/76';
  // Recovered, and the report is already in his chat: not sent again.
  history = [{ ts: 2000, content: `🛠 Auto-fix …\nFull report: ${url}` }];
  workers._report({ id: 91, status: 'done', recovered: true, issueUrl: url, startedAt: 1000 });
  await wait();
  assert.deepStrictEqual(sent, []);
  // Recovered but never reported: it goes out.
  history = [];
  workers._report({ id: 92, status: 'done', recovered: true, issueUrl: 'https://github.com/x/y/issues/77', startedAt: 1000 });
  await wait();
  assert.deepStrictEqual(sent, [92]);
  // Not a recovered worker: always reported (no history check).
  history = [{ ts: 2000, content: `Full report: ${url}` }];
  workers._report({ id: 93, status: 'done', issueUrl: url, startedAt: 1000 });
  await wait();
  assert.deepStrictEqual(sent, [92, 93]);
  console.log('worker no-resend ok');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
