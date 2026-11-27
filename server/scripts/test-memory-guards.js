// node server/scripts/test-memory-guards.js — the memory copy can't take the server down
// (2026-11-27 crash): paged copy, repeated-page stop, low-memory stop, crash-loop breaker.
const assert = require('assert');
const ms = require('../memoryStore');
const mem0 = require('../mem0');

(async () => {
  // Mem0 handing back the same page forever: the list stops instead of looping 1,000 pages.
  process.env.MEM0_API_KEY = 'k';
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ next: 'more', results: Array.from({ length: 100 }, (_, i) => ({ id: `same${i}`, memory: 'x' })) }) }; };
  const pages = [];
  await mem0.apiAll('ara', { max: Infinity, onPage: async (b) => { pages.push(b.length); } });
  assert.strictEqual(calls, 2, `stopped on the repeat (${calls} calls)`);
  assert.deepStrictEqual(pages, [100]);

  // Pages are handed over, not kept.
  let n = 0;
  global.fetch = async (u, o) => { const { page } = JSON.parse(o.body); n++; const last = page === 3; return { ok: true, json: async () => ({ next: last ? null : 'more', results: Array.from({ length: last ? 7 : 100 }, (_, i) => ({ id: `p${page}-${i}`, memory: 'x' })) }) }; };
  let seen = 0;
  const kept = await mem0.apiAll('ara', { max: Infinity, onPage: async (b) => { seen += b.length; } });
  assert.strictEqual(seen, 207); assert.strictEqual(kept.length, 0);

  // Low memory: the guard throws (the copy stops there and resumes next run).
  process.env.MEMORY_MIRROR_MIN_FREE_MB = String(1e9);
  assert.throws(() => ms.memoryRoom(), /stopped to protect the server/);
  delete process.env.MEMORY_MIRROR_MIN_FREE_MB;
  assert.doesNotThrow(() => ms.memoryRoom());

  // Crash-loop breaker: a copy still marked running at boot switches the copy off and tells him.
  const settings = { memory_mirror_running: String(Date.now() - 60000) };
  const told = [];
  require('../loud').tellAra = async (k, t) => { told.push(t); };
  ms._set({ getSetting: async (k) => settings[k] ?? null, setSetting: async (k, v) => { settings[k] = v; } });
  const b = await ms.bootCheck();
  assert(b.paused);
  assert.strictEqual(settings.switch_memory_mirror, 'off');
  assert.strictEqual(settings.memory_mirror_running, '');
  assert(/switched the memory copy off/.test(told[0]) && /Mem0 is untouched/.test(told[0]));
  assert.deepStrictEqual(await ms.bootCheck(), { ok: true }, 'nothing to report next time');
  console.log('memory guards ok');
})().catch((e) => { console.error(e); process.exit(1); });
