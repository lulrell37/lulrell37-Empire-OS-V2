// node server/scripts/test-server-memory.js — step 2: the server's own memory
// (server/memoryStore.js): the switch, vector search, pulling facts out, nothing lost.
// Real database (DATABASE_URL), throwaway personas, fake Mem0 / embeddings / AI.
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const ms = require('../memoryStore');

const P = 'zz_srvmem', Q = 'zz_srvmem2';
const settings = {};
// A tiny meaning model: each topic word lights up its own dimension.
const TOPICS = ['thanksgiving', 'dinner', 'gold', 'stop', 'birthday', 'atlanta', 'invoice', 'mom'];
const vecFor = (t) => { const v = Array(512).fill(0.001); const l = String(t).toLowerCase(); TOPICS.forEach((w, i) => { if (l.includes(w)) v[i] = 1; }); return v; };
let llmReply = '{"ops":[]}', llmSeen = '';
let mem0Facts = [];
let who = P;
ms._set({
  db, roster: { [P]: {}, [Q]: {} },
  mem0: { mem0Enabled: () => true, apiAll: async (id) => (id === who ? mem0Facts : []), splitForMem0: require('../mem0').splitForMem0 },
  embedKey: () => 'k',
  fetch: async (url, o) => { const { input } = JSON.parse(o.body); return { ok: true, json: async () => ({ data: input.map((t, i) => ({ index: i, embedding: vecFor(t) })) }) }; },
  getSetting: async (k) => settings[k] ?? null, setSetting: async (k, v) => { settings[k] = v; },
  llm: async (sys, prompt) => { llmSeen = prompt; return llmReply; },
});

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await db.query(sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS memory_inputs')));
  const clean = () => Promise.all([P, Q].flatMap((p) => [db.query('DELETE FROM memories WHERE persona = $1', [p]), db.query('DELETE FROM memory_inputs WHERE persona = $1', [p])]));
  await clean();
  try {
    // Mem0 mode by default; the copy fills.
    assert.strictEqual(await ms.engine(), 'mem0');
    mem0Facts = [
      { id: 'a1', memory: 'He is hosting Thanksgiving dinner', metadata: { date: '2026-11-20' } },
      { id: 'a2', memory: 'He wants gold stops at $10 or more', metadata: { date: '2026-11-18' } },
      { id: 'a3', memory: 'His birthday trip is to Atlanta', metadata: { date: '2026-08-14' } },
    ];
    await ms.tick();

    // Search by meaning (pgvector when there, else in code).
    const hits = await ms.search(P, 'what time is thanksgiving dinner?', { topK: 2, threshold: 0.3 });
    assert.strictEqual(hits[0].memory, 'He is hosting Thanksgiving dinner', JSON.stringify(hits));
    assert.strictEqual(hits[0].metadata.date, '2026-11-20');
    assert.strictEqual((await ms.all(P)).length, 3);

    // The check matches; the switch needs his own message.
    { const c = await ms.check(); assert(c.ok, c.text); }
    assert(/only on his own message/.test(await ms.memoryTag('MEMORY_ENGINE', 'server', '')));
    mem0Facts.push({ id: 'a4', memory: 'Not copied yet' });
    assert(/not switched/.test(await ms.memoryTag('MEMORY_ENGINE', 'server', 'switch memory to the server')));
    mem0Facts.pop();
    assert(/✓ every persona now uses/.test(await ms.memoryTag('MEMORY_ENGINE', 'server', 'switch memory to the server')));
    assert(await ms.useServer());

    // Inputs from before the switch were Mem0's to pull apart; newer ones are ours.
    await db.query('INSERT INTO memory_inputs (persona, text, meta, ts) VALUES ($1, $2, $3, $4)', [P, 'old one', '{}', 1]);
    await ms.recordInput(P, 'YOU: move Thanksgiving dinner to 7 at my mom\'s\nA.R.A.: done', { source: 'telegram' });
    llmReply = 'Sure: {"ops":[{"op":"update","id":1,"fact":"He is hosting Thanksgiving dinner at 7 PM at his mom\'s house"},{"op":"add","fact":"His mom is hosting this year"}]}';
    let r = await ms.extractTick();
    assert.deepStrictEqual([r.done, r.added, r.updated], [1, 1, 1], JSON.stringify(r));
    assert(/1\. \(2026-11-20\) He is hosting Thanksgiving dinner/.test(llmSeen), 'related facts handed to the AI with ids');
    // Nothing lost: the old fact is kept, superseded.
    const old = (await db.query("SELECT deleted, superseded_by FROM memories WHERE persona = $1 AND mem0_id = 'a1'", [P])).rows[0];
    assert(old.deleted && old.superseded_by);
    const now = await ms.search(P, 'thanksgiving dinner', { topK: 3, threshold: 0.3 });
    assert(now.some((f) => /7 PM/.test(f.memory)) && !now.some((f) => f.memory === 'He is hosting Thanksgiving dinner'));
    assert.strictEqual((await ms.extractTick()).done, 0, 'nothing twice');

    // A bad AI reply is retried, then left on record, never dropped silently.
    await ms.recordInput(P, 'YOU: invoice for the gold client', {});
    llmReply = 'no json here';
    for (let i = 0; i < 5; i++) await ms.extractTick();
    const stuck = (await db.query("SELECT tries, extracted_at FROM memory_inputs WHERE persona = $1 AND text LIKE '%invoice%'", [P])).rows[0];
    assert.strictEqual(stuck.tries, 5); assert.strictEqual(stuck.extracted_at, null);

    // In server mode the copy skips Mem0's version of the server's own adds.
    mem0Facts = [{ id: 'b1', memory: 'Dup of a server add', metadata: { via: 'server' } }, { id: 'b2', memory: 'From the app directly', metadata: {} }];
    who = Q;
    await ms.mirrorPersona(Q);
    assert.deepStrictEqual((await ms.all(Q)).map((f) => f.memory), ['From the app directly']);

    // Back to Mem0.
    assert(/back on Mem0/.test(await ms.memoryTag('MEMORY_ENGINE', 'mem0', 'go back to mem0')));
    assert(!(await ms.useServer()));
    console.log('server memory ok');
  } finally { await clean(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
