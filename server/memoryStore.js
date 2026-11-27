// The server's own copy of every memory, alongside Mem0 (step 1 of moving memory onto
// the server; owner, 2026-11-27: "push it and start step 1"). Nothing reads from it
// yet, so Mem0 stays the memory every persona uses; this makes sure nothing in it
// exists only at Mem0.
//
//   memory_inputs: everything the server hands Mem0 to remember (mem0Remember), word
//     for word, saved first, even with no Mem0 key or when Mem0 refuses it. The app's
//     own adds go from the phone straight to Mem0; the mirror below picks those up.
//   memories: Mem0's extracted facts for every persona, copied every 6 h (:20,
//     `MEMORY_MIRROR=off`, spoken switch `memory_mirror`) and kept up to date by Mem0's
//     id, each with a 512-number search vector (OpenAI text-embedding-3-small,
//     OPENAI_API_KEY; without it the facts are copied and vectors wait). Step 2 adds
//     the search and switches the personas over.
// A failure logs `memory mirror failed: …` for the sentinel (SCHEDULED).
// node server/scripts/test-memory-store.js.
const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIMS = 512;
const EMBED_BATCH = 100;

let deps = null;
const d = () => ({
  db: require('./db'), mem0: require('./mem0'), roster: require('./personas').ROSTER,
  embedKey: () => process.env.OPENAI_API_KEY || '', fetch: (...a) => fetch(...a),
  getSetting: (...a) => require('./syncStore').getSetting(...a),
  setSetting: (...a) => require('./syncStore').setSetting(...a),
  llm: (system, prompt, opts) => require('./llm').claudeText(system, prompt, opts),
  ...(deps || {}),
});

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Saved before Mem0 ever sees it. Never throws.
async function recordInput(persona, text, meta = {}) {
  const t = String(text || '').trim();
  if (!persona || !t) return;
  try {
    await d().db.query('INSERT INTO memory_inputs (persona, text, meta, ts) VALUES ($1, $2, $3, $4)',
      [persona, t, JSON.stringify({ date: today(), ...meta }), Date.now()]);
  } catch (e) { console.error('memory mirror failed: saving an input:', e.message); }
}

// texts -> vectors (null when there's no key). Throws on an API error.
async function embed(texts) {
  const key = d().embedKey();
  if (!key || !texts.length) return null;
  const res = await d().fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => String(t).slice(0, 8000)), dimensions: EMBED_DIMS }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = await res.json();
  return (j.data || []).sort((a, b) => a.index - b.index).map((x) => x.embedding);
}

const factDate = (f) => {
  const md = f && f.metadata && /^\d{4}-\d{2}-\d{2}/.test(String(f.metadata.date || '')) ? String(f.metadata.date).slice(0, 10) : '';
  return md || String((f && (f.created_at || f.updated_at)) || '').slice(0, 10) || null;
};

// One persona's Mem0 facts -> memories (new ones added, changed text updated; a
// changed fact gets a fresh vector). -> { seen, added, changed }
// With the server's memory on, facts Mem0 made from the server's own adds
// (metadata.via 'server') are skipped: the server made its own from the same text.
// The app's direct adds (an older APK) still come over.
async function mirrorPersona(persona) {
  // Everything, no cap: the copy has to be complete before step 2 can rely on it.
  const facts = await d().mem0.apiAll(persona, { max: Infinity });
  const serverOn = await useServer();
  let added = 0, changed = 0;
  for (const f of facts) {
    const memory = String((f && f.memory) || '').trim();
    if (!f || !f.id || !memory) continue;
    if (serverOn && f.metadata && f.metadata.via === 'server') continue;
    const { rows } = await d().db.query(
      `INSERT INTO memories (persona, mem0_id, memory, date, meta, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (mem0_id) DO ${serverOn ? 'NOTHING' : `UPDATE SET memory = EXCLUDED.memory, date = EXCLUDED.date, meta = EXCLUDED.meta, updated_at = EXCLUDED.updated_at,
         embedding = CASE WHEN memories.memory = EXCLUDED.memory THEN memories.embedding ELSE NULL END
       WHERE memories.memory IS DISTINCT FROM EXCLUDED.memory OR memories.date IS DISTINCT FROM EXCLUDED.date`}
       RETURNING (xmax = 0) AS inserted`,
      [persona, String(f.id), memory, factDate(f), JSON.stringify({ categories: f.categories || [], metadata: f.metadata || {} }), Date.now()],
    );
    if (rows[0]) rows[0].inserted ? added++ : changed++;
  }
  return { seen: facts.length, added, changed };
}

// Vectors for every fact that has none yet. -> count embedded
async function embedMissing({ max = 2000 } = {}) {
  if (!d().embedKey()) return 0;
  let done = 0;
  while (done < max) {
    const { rows } = await d().db.query('SELECT id, memory FROM memories WHERE embedding IS NULL ORDER BY id LIMIT $1', [EMBED_BATCH]);
    if (!rows.length) break;
    const vecs = await embed(rows.map((r) => r.memory));
    if (!vecs || vecs.length !== rows.length) throw new Error('embeddings came back short');
    for (let i = 0; i < rows.length; i++) await setVector(rows[i].id, vecs[i]);
    done += rows.length;
  }
  return done;
}

async function tick() {
  if (String(process.env.MEMORY_MIRROR || '').toLowerCase() === 'off') return { skipped: 'MEMORY_MIRROR=off' };
  if (!d().mem0.mem0Enabled()) return { skipped: 'no MEM0_API_KEY: only the inputs are being saved' };
  const out = { personas: 0, seen: 0, added: 0, changed: 0, embedded: 0, failed: [] };
  for (const id of Object.keys(d().roster)) {
    try {
      const r = await mirrorPersona(id);
      out.personas++; out.seen += r.seen; out.added += r.added; out.changed += r.changed;
    } catch (e) { out.failed.push(`${id}: ${e.message}`); }
  }
  // A fact whose text changed lost its vector above; clear its indexed copy too.
  if (await vectorReady()) await d().db.query('UPDATE memories SET vec = NULL WHERE embedding IS NULL AND vec IS NOT NULL').catch(() => {});
  try { out.embedded = await embedMissing(); } catch (e) { out.failed.push(`vectors: ${e.message}`); }
  if (out.failed.length) console.error(`memory mirror failed: ${out.failed.join('; ').slice(0, 400)}`);
  if (!d().embedKey()) out.note = 'no OPENAI_API_KEY: facts copied, search vectors wait';
  return out;
}

async function status() {
  const { rows } = await d().db.query(`SELECT
      (SELECT count(*) FROM memory_inputs) AS inputs,
      (SELECT count(*) FROM memories) AS facts,
      (SELECT count(*) FROM memories WHERE embedding IS NOT NULL) AS vectors,
      (SELECT max(updated_at) FROM memories) AS last`);
  const r = rows[0] || {};
  return `Server memory copy: ${r.facts || 0} facts (${r.vectors || 0} searchable), ${r.inputs || 0} saved inputs${r.last ? `, last copied ${new Date(Number(r.last)).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET` : ''}.`;
}


// ---------------------------------------------------------------------------
// Step 2: the server's own memory (owner, 2026-11-27: "yes start on step 2").
// app_settings.memory_engine: 'mem0' (default, Mem0 answers every search) or
// 'server' (this file does: search, the whole history, and pulling facts out of
// each exchange). Mem0 still gets every add either way, as the safety net, until
// its key is removed. [MEMORY_ENGINE: server|mem0] (J.A.R.V.I.S., his own message)
// flips it; [MEMORY_CHECK] compares the copy with Mem0 before he does.
// Facts are never deleted: one that's replaced or contradicted is kept, marked
// superseded (deleted = true, superseded_by), so nothing is ever lost.

let engineCache = { at: 0, v: 'mem0' };
async function engine() {
  if (Date.now() - engineCache.at < 30000) return engineCache.v;
  const env = String(process.env.MEMORY_ENGINE || '').toLowerCase();
  let v = env === 'server' || env === 'mem0' ? env : String((await d().getSetting('memory_engine').catch(() => null)) || 'mem0').toLowerCase();
  if (v !== 'server') v = 'mem0';
  engineCache = { at: Date.now(), v };
  return v;
}
async function useServer() { return (await engine()) === 'server'; }
async function setEngine(v) {
  const next = String(v || '').toLowerCase() === 'server' ? 'server' : 'mem0';
  await d().setSetting('memory_engine', next);
  if (next === 'server') {
    // Exchanges before this moment were already turned into facts by Mem0 (and
    // copied); only newer ones are pulled out here.
    const prev = Number(await d().getSetting('memory_engine_since').catch(() => 0)) || 0;
    if (!prev) await d().setSetting('memory_engine_since', String(Date.now()));
  }
  engineCache = { at: 0, v: next };
  return next;
}

// pgvector when the database has it (fast, indexed); otherwise vectors are compared
// in code. Checked once per process.
let vecReady = null;
async function vectorReady() {
  if (vecReady !== null) return vecReady;
  try {
    await d().db.query('CREATE EXTENSION IF NOT EXISTS vector');
    await d().db.query(`ALTER TABLE memories ADD COLUMN IF NOT EXISTS vec vector(${EMBED_DIMS})`);
    await d().db.query('UPDATE memories SET vec = embedding::vector WHERE vec IS NULL AND embedding IS NOT NULL');
    await d().db.query('CREATE INDEX IF NOT EXISTS memories_vec_idx ON memories USING hnsw (vec vector_cosine_ops)');
    vecReady = true;
  } catch (e) {
    console.warn(`server memory: no pgvector (${e.message}); searching in code`);
    vecReady = false;
  }
  return vecReady;
}
async function setVector(id, v) {
  await d().db.query('UPDATE memories SET embedding = $1 WHERE id = $2', [v, id]);
  if (await vectorReady()) await d().db.query('UPDATE memories SET vec = embedding::vector WHERE id = $1', [id]);
}

const asFact = (r, score) => ({
  id: String(r.mem0_id || `s${r.id}`), memory: r.memory, score,
  metadata: { ...((r.meta && r.meta.metadata) || {}), date: r.date || undefined },
  categories: (r.meta && r.meta.categories) || [], created_at: r.date || '',
});
const cosine = (a, b) => { let x = 0, y = 0, z = 0; for (let i = 0; i < a.length; i++) { x += a[i] * b[i]; y += a[i] * a[i]; z += b[i] * b[i]; } return y && z ? x / Math.sqrt(y * z) : 0; };
const STOPW = new Set('what when where which about that this with from have your were they them then than there their tell know does just like into over more some also been would could should'.split(' '));

// Same shape as Mem0's search results.
async function search(persona, query, { topK = 16, threshold = 0.05 } = {}) {
  const q = String(query || '').trim();
  if (!persona || !q) return [];
  const vec = d().embedKey() ? (await embed([q.slice(0, 8000)]).catch((e) => { console.error(`server memory failed: query vector: ${e.message}`); return null; })) : null;
  if (vec && vec[0]) {
    if (await vectorReady()) {
      const { rows } = await d().db.query(
        `SELECT id, mem0_id, memory, date, meta, 1 - (vec <=> $2::vector) AS score FROM memories
         WHERE persona = $1 AND NOT deleted AND vec IS NOT NULL ORDER BY vec <=> $2::vector LIMIT $3`,
        [persona, `[${vec[0].join(',')}]`, topK]);
      const hits = rows.filter((r) => Number(r.score) >= threshold).map((r) => asFact(r, Number(r.score)));
      if (hits.length) return hits;
    } else {
      const { rows } = await d().db.query('SELECT id, mem0_id, memory, date, meta, embedding FROM memories WHERE persona = $1 AND NOT deleted AND embedding IS NOT NULL', [persona]);
      const hits = rows.map((r) => ({ r, s: cosine(vec[0], r.embedding) })).filter((x) => x.s >= threshold)
        .sort((a, b) => b.s - a.s).slice(0, topK).map((x) => asFact(x.r, x.s));
      if (hits.length) return hits;
    }
  }
  // No vectors (no key, or none made yet): the facts sharing the most words.
  const words = [...new Set(q.toLowerCase().match(/[a-z0-9]{4,}/g) || [])].filter((w) => !STOPW.has(w)).slice(0, 8);
  if (!words.length) return [];
  const { rows } = await d().db.query(
    `SELECT id, mem0_id, memory, date, meta FROM memories WHERE persona = $1 AND NOT deleted AND (${words.map((_, i) => `memory ILIKE $${i + 2}`).join(' OR ')}) LIMIT 500`,
    [persona, ...words.map((w) => `%${w}%`)]);
  return rows.map((r) => ({ r, n: words.filter((w) => r.memory.toLowerCase().includes(w)).length }))
    .sort((a, b) => b.n - a.n || String(b.r.date || '').localeCompare(String(a.r.date || ''))).slice(0, topK)
    .map((x) => asFact(x.r, x.n / words.length));
}

// Every current fact, newest first by date (same shape as Mem0's list). No cap by default.
async function all(persona, { max = Infinity } = {}) {
  const { rows } = await d().db.query(
    `SELECT id, mem0_id, memory, date, meta FROM memories WHERE persona = $1 AND NOT deleted ORDER BY date DESC NULLS LAST, id DESC${Number.isFinite(max) ? ` LIMIT ${Math.max(1, max | 0)}` : ''}`, [persona]);
  return rows.map((r) => asFact(r));
}

// Pulling facts out of one exchange: one AI call, given the related facts it may
// update. JSON back: {"ops":[{"op":"add","fact":"…"},{"op":"update","id":12,"fact":"…"},{"op":"remove","id":7}]}.
const EXTRACT_SYSTEM = `You keep the long-term memory of one persona on Mr. Burrus's team (his AI assistants). Read the new text and write down every durable fact worth remembering about him, his life, his businesses, his people, his plans, decisions, preferences, commitments, dates and numbers. Write each fact as one short third-person sentence ("He is hosting Thanksgiving at 6 PM at his house."), keeping every name, number, date, time, place and amount exactly. One fact per thing: split a message about five things into five facts. Skip small talk and anything that only matters for a few minutes.
Lines from a persona, a desk alert or anything marked NOT his words are not his decisions: record them as what that persona said or reported ("T.A.L.O.N. reported a gold stop at 4215"), never as his choice.
You also get EXISTING facts that may be related, each with an id. If the new text changes one (a new time, a different decision), "update" it with the full corrected fact. If it shows one is no longer true, "remove" it (it is kept on record as superseded, never lost). Never add a fact that is already there in other words.
Reply with JSON only: {"ops":[{"op":"add","fact":"..."},{"op":"update","id":12,"fact":"..."},{"op":"remove","id":7}]}. Nothing worth keeping: {"ops":[]}.`;

function parseOps(text) {
  const t = String(text || '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('no JSON in the reply');
  const j = JSON.parse(t.slice(s, e + 1));
  return (Array.isArray(j.ops) ? j.ops : []).filter((o) => o && ['add', 'update', 'remove'].includes(o.op));
}

async function addFact(persona, fact, date, inputId) {
  const { rows } = await d().db.query(
    "INSERT INTO memories (persona, memory, date, meta, origin, source_input, created_at, updated_at) VALUES ($1, $2, $3, $4, 'server', $5, $6, $6) RETURNING id",
    [persona, fact, date, JSON.stringify({ metadata: { date } }), inputId, Date.now()]);
  return rows[0].id;
}

// -> { added, updated, removed }
async function extractOne(row) {
  const date = (row.meta && row.meta.date) || today();
  const related = (await search(row.persona, row.text, { topK: 12, threshold: 0.3 }).catch(() => []));
  const ids = new Map();
  const existing = related.map((f, i) => { ids.set(i + 1, f.id); return `${i + 1}. (${(f.metadata && f.metadata.date) || ''}) ${f.memory}`; }).join('\n');
  const { splitForMem0 } = d().mem0;
  const pieces = splitForMem0 ? splitForMem0(row.text, 30000) : [row.text];
  const out = { added: 0, updated: 0, removed: 0 };
  for (const piece of pieces) {
    const reply = await d().llm(EXTRACT_SYSTEM, `PERSONA: ${row.persona}\nDATE: ${date}\n\nEXISTING FACTS (ids for update/remove):\n${existing || '(none)'}\n\nNEW TEXT:\n${piece}`, { maxTokens: 1500 });
    for (const o of parseOps(reply)) {
      const fact = String(o.fact || '').replace(/\s+/g, ' ').trim();
      const target = o.id != null ? ids.get(Number(o.id)) : null;
      const oldId = target ? (await d().db.query('SELECT id FROM memories WHERE persona = $1 AND (mem0_id = $2 OR id::text = $3) AND NOT deleted LIMIT 1', [row.persona, target, String(target).replace(/^s/, '')])).rows[0] : null;
      if (o.op === 'add' && fact) {
        const id = await addFact(row.persona, fact, date, row.id); out.added++;
        const v = await embed([fact]).catch(() => null); if (v && v[0]) await setVector(id, v[0]);
      } else if (o.op === 'update' && fact && oldId) {
        const id = await addFact(row.persona, fact, date, row.id);
        await d().db.query('UPDATE memories SET deleted = true, superseded_by = $1, updated_at = $2 WHERE id = $3', [id, Date.now(), oldId.id]);
        const v = await embed([fact]).catch(() => null); if (v && v[0]) await setVector(id, v[0]);
        out.updated++;
      } else if (o.op === 'remove' && oldId) {
        await d().db.query('UPDATE memories SET deleted = true, updated_at = $1 WHERE id = $2', [Date.now(), oldId.id]);
        out.removed++;
      }
    }
  }
  return out;
}

// Every saved input since the switch that hasn't been pulled apart yet, oldest
// first, a few at a time. Runs on each new input and every 2 minutes, so one cut
// off by a restart is picked up again. A failed one is retried on the next pass
// (up to 5 tries, then logged and left on record, never dropped silently).
let extracting = false;
async function extractTick({ max = 20 } = {}) {
  if (!(await useServer()) || extracting) return { skipped: true };
  extracting = true;
  const out = { done: 0, failed: 0, added: 0, updated: 0, removed: 0 };
  try {
    const since = Number(await d().getSetting('memory_engine_since').catch(() => 0)) || 0;
    const { rows } = await d().db.query('SELECT id, persona, text, meta, tries FROM memory_inputs WHERE extracted_at IS NULL AND ts >= $1 AND COALESCE(tries, 0) < 5 ORDER BY id LIMIT $2', [since, max]);
    for (const r of rows) {
      try {
        const x = await extractOne(r);
        await d().db.query('UPDATE memory_inputs SET extracted_at = $1 WHERE id = $2', [Date.now(), r.id]);
        out.done++; out.added += x.added; out.updated += x.updated; out.removed += x.removed;
      } catch (e) {
        out.failed++;
        await d().db.query('UPDATE memory_inputs SET tries = COALESCE(tries, 0) + 1 WHERE id = $1', [r.id]).catch(() => {});
        console.error(`server memory failed: pulling facts from input #${r.id} (${r.persona}, try ${(r.tries || 0) + 1} of 5): ${e.message}`);
      }
    }
  } finally { extracting = false; }
  return out;
}
let kickTimer = null;
function kick() {
  if (kickTimer) return;
  kickTimer = setTimeout(() => { kickTimer = null; extractTick().catch((e) => console.error(`server memory failed: ${e.message}`)); }, 3000);
  if (kickTimer.unref) kickTimer.unref();
}

// Before switching: per persona, how many facts Mem0 has vs the server's copy.
async function check() {
  const lines = [];
  let ok = true;
  for (const id of Object.keys(d().roster)) {
    let m0 = null;
    try { m0 = (await d().mem0.apiAll(id, { max: Infinity })).filter((f) => f && f.id && String(f.memory || '').trim()); }
    catch (e) { lines.push(`${id}: couldn't read Mem0 (${e.message})`); ok = false; continue; }
    const { rows } = await d().db.query("SELECT mem0_id, embedding IS NOT NULL AS v FROM memories WHERE persona = $1 AND origin = 'mem0'", [id]);
    const have = new Set(rows.map((r) => r.mem0_id));
    const missing = m0.filter((f) => !have.has(String(f.id))).length;
    const noVec = rows.filter((r) => !r.v).length;
    if (!m0.length && !rows.length) continue;
    if (missing || noVec) ok = false;
    lines.push(`${id}: Mem0 ${m0.length}, copied ${rows.length}${missing ? `, ${missing} NOT copied yet` : ''}${noVec ? `, ${noVec} without search vectors` : ''}`);
  }
  const head = ok ? '✅ The server\'s copy matches Mem0 for every persona.' : '⚠️ The server\'s copy doesn\'t match Mem0 yet.';
  return { ok, text: `${head}\n${lines.join('\n') || '(no memories anywhere yet)'}\nMemory engine now: ${await engine()}.` };
}

// [MEMORY_ENGINE: server|mem0] / [MEMORY_CHECK] (J.A.R.V.I.S.; A.R.A. can check).
const MEMORY_TOOLS = ` - MEMORY ENGINE: [MEMORY_CHECK] compares the server's own copy of memory with Mem0, persona by persona. [MEMORY_ENGINE: server] switches every persona to the server's own memory (search, history, and pulling facts out of each conversation itself; Mem0 still gets every add as a safety net); [MEMORY_ENGINE: mem0] switches back. Switch only on his own message asking for it, and run [MEMORY_CHECK] first: if it doesn't match, tell him what's missing instead of switching.`;
async function memoryTag(name, arg, asked = '') {
  if (name === 'MEMORY_CHECK') return (await check()).text;
  if (name === 'MEMORY_ENGINE') {
    if (!String(asked || '').trim()) return 'not done — only on his own message';
    const want = String(arg || '').trim().toLowerCase();
    if (!['server', 'mem0'].includes(want)) return 'say server or mem0';
    if (want === 'server') {
      const c = await check();
      if (!c.ok && !/\bforce\b|anyway/i.test(asked)) return `not switched — the copy isn't complete:\n${c.text}\n(He can say to switch anyway.)`;
    }
    const v = await setEngine(want);
    if (v === 'server') kick();
    return v === 'server' ? '✓ every persona now uses the server\'s own memory (Mem0 still gets every add as the safety net)' : '✓ back on Mem0 for memory (the server keeps its copy)';
  }
  return '';
}
const MEMORY_TAGS = new Set(['MEMORY_CHECK', 'MEMORY_ENGINE']);

module.exports = {
  recordInput, embed, mirrorPersona, embedMissing, tick, status, EMBED_DIMS,
  engine, useServer, setEngine, search, all, extractOne, extractTick, kick, check, parseOps,
  MEMORY_TOOLS, MEMORY_TAGS, memoryTag, EXTRACT_SYSTEM,
  _set: (x) => { deps = x; vecReady = null; engineCache = { at: 0, v: 'mem0' }; },
};
