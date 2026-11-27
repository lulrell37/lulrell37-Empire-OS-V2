// node server/scripts/test-chat-route.js — one thread per persona (routes/chat.js).
const assert = require('assert');
const r = require('../routes/chat')._test;

const rows = [];
let seq = 0;
r.setDb({ query: async (sql, p) => {
  if (/^INSERT/.test(sql) && !/RETURNING/.test(sql)) { rows.push({ id: ++seq, persona: p[0], role: p[1], content: p[2], ts: p[3] }); return { rows: [] }; }
  if (/^INSERT/.test(sql)) { const row = { id: ++seq, persona: p[0], role: p[1], content: p[2], ts: p[3] }; rows.push(row); return { rows: [{ id: row.id }] }; }
  if (/ts BETWEEN/.test(sql)) return { rows: rows.filter((x) => x.persona === p[0] && x.role === p[1] && x.content === p[2] && x.ts >= p[3] && x.ts <= p[4]) };
  if (/AND role = \$2 AND content = \$3/.test(sql)) return { rows: rows.filter((x) => x.persona === p[0] && x.role === p[1] && x.content === p[2] && x.ts > p[3]) };
  return { rows: rows.filter((x) => x.persona === p[0]).sort((a, b) => b.id - a.id).slice(0, p[1]) };
} });

(async () => {
  await r.add('ara', 'user', 'what time is dinner?');
  rows.push({ id: ++seq, persona: 'ara', role: 'assistant', content: '[SENT ON YOUR OWN, Thu 9:00 AM ET — not a reply to him]\n📈 **T.A.L.O.N. just opened a trade**', ts: Date.now() });
  rows.push({ id: ++seq, persona: 'ara', role: 'assistant', content: '[YOU SENT THIS TO MR. BURRUS THROUGH A.R.A., Thu 9:05 AM ET — it\'s yours]\nH.A.V.E.N. note', ts: Date.now() });
  await r.add('ara', 'assistant', 'Six, at your mom\'s.');
  const dup = await r.add('ara', 'assistant', 'Six, at your mom\'s.');
  assert(dup.dup, 'a retry is stored once');

  const t = await r.thread('ara', 40);
  assert.deepStrictEqual(t.map((m) => m.role), ['user', 'assistant'], 'alerts stay out of the chat');
  assert.strictEqual(t[0].content, 'what time is dinner?');

  const a = await r.alerts('ara', 30);
  assert.strictEqual(a.length, 2);
  assert(/^H\.A\.V\.E\.N\. note/.test(a[0].content) && /T\.A\.L\.O\.N\./.test(a[1].content), 'newest first, marker removed');
  assert.strictEqual(a[1].from, 'Talon');
  assert((await r.add('ara', 'user', '  ')).ok === false);
  // The phone's old history: own times, nothing twice, bad rows skipped.
  require('../chatBackup').redoDays = async (d) => { redone.push(...d); };
  const redone = [];
  const old = Date.parse('2026-10-02T14:00:00Z');
  const imp = await r.importMessages('ara', [
    { role: 'user', content: 'old app question', ts: old }, { role: 'assistant', content: 'old app answer', ts: old + 5000 },
    { role: 'user', content: 'what time is dinner?', ts: rows[0].ts + 1000 }, { role: 'x', content: 'bad', ts: old }, { role: 'user', content: '', ts: old },
  ]);
  assert.deepStrictEqual(imp, { added: 2, skipped: 3 });
  assert.deepStrictEqual((await r.importMessages('ara', [{ role: 'user', content: 'old app question', ts: old }])).added, 0, 'safe to re-send');
  assert.deepStrictEqual(redone, ['2026-10-02']);
  console.log('chat route ok');
})().catch((e) => { console.error(e); process.exit(1); });
