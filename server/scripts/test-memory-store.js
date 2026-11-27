// node server/scripts/test-memory-store.js — the server's copy of memory (server/memoryStore.js).
// Uses the real database (DATABASE_URL) under a throwaway persona, fake Mem0 and embeddings.
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const ms = require('../memoryStore');

const P = 'zz_memtest';
let facts = [
  { id: 'm1', memory: 'He is hosting Thanksgiving', metadata: { date: '2026-11-25' } },
  { id: 'm2', memory: 'Gold stops at $10 or more', created_at: '2026-11-20T10:00:00Z' },
];
let embedCalls = 0;
ms._set({
  db, roster: { [P]: {} },
  mem0: { mem0Enabled: () => true, apiAll: async () => facts },
  getSetting: async () => null, setSetting: async () => {},
  embedKey: () => 'k',
  fetch: async (url, o) => {
    const { input, dimensions } = JSON.parse(o.body); embedCalls += input.length;
    assert.strictEqual(dimensions, 512);
    return { ok: true, json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: Array(512).fill(i / 10) })) }) };
  },
});

(async () => {
  // Only the two new tables from schema.sql.
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await db.query(sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS memory_inputs')));
  const clean = () => Promise.all([db.query('DELETE FROM memories WHERE persona = $1', [P]), db.query('DELETE FROM memory_inputs WHERE persona = $1', [P])]);
  await clean();
  try {
    await ms.recordInput(P, 'YOU: what time is dinner\nA.R.A.: six', { source: 'telegram' });
    const inp = await db.query('SELECT text, meta FROM memory_inputs WHERE persona = $1', [P]);
    assert.strictEqual(inp.rows.length, 1);
    assert.strictEqual(inp.rows[0].meta.source, 'telegram');

    let r = await ms.tick();
    assert.deepStrictEqual([r.seen, r.added, r.changed, r.embedded], [2, 2, 0, 2], JSON.stringify(r));
    const rows = (await db.query('SELECT mem0_id, memory, date, embedding FROM memories WHERE persona = $1 ORDER BY mem0_id', [P])).rows;
    assert.strictEqual(rows[0].date, '2026-11-25');
    assert.strictEqual(rows[1].date, '2026-11-20');
    assert.strictEqual(rows[0].embedding.length, 512);

    r = await ms.tick();
    assert.deepStrictEqual([r.added, r.changed, r.embedded], [0, 0, 0], 'nothing twice');

    facts = [{ ...facts[0], memory: 'He is hosting Thanksgiving at 6' }, facts[1], { id: 'm3', memory: 'New fact' }];
    embedCalls = 0;
    r = await ms.tick();
    assert.deepStrictEqual([r.added, r.changed, r.embedded], [1, 1, 2], 'changed text gets a fresh vector');
    assert.strictEqual(embedCalls, 2);
    assert(/3 facts \(3 searchable\)/.test(await ms.status()) || /facts/.test(await ms.status()));
    console.log('memory store ok');
  } finally { await clean(); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
