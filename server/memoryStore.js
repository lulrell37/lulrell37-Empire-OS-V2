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
const d = () => deps || {
  db: require('./db'), mem0: require('./mem0'), roster: require('./personas').ROSTER,
  embedKey: () => process.env.OPENAI_API_KEY || '', fetch: (...a) => fetch(...a),
};

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// Saved before Mem0 ever sees it. Never throws.
async function recordInput(persona, text, meta = {}) {
  const t = String(text || '').trim();
  if (!persona || !t) return;
  try {
    await d().db.query('INSERT INTO memory_inputs (persona, text, meta, ts) VALUES ($1, $2, $3, $4)',
      [persona, t.slice(0, 12000), JSON.stringify({ date: today(), ...meta }), Date.now()]);
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
async function mirrorPersona(persona) {
  const facts = await d().mem0.mem0All(persona);
  let added = 0, changed = 0;
  for (const f of facts) {
    const memory = String((f && f.memory) || '').trim();
    if (!f || !f.id || !memory) continue;
    const { rows } = await d().db.query(
      `INSERT INTO memories (persona, mem0_id, memory, date, meta, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (mem0_id) DO UPDATE SET memory = EXCLUDED.memory, date = EXCLUDED.date, meta = EXCLUDED.meta, updated_at = EXCLUDED.updated_at,
         embedding = CASE WHEN memories.memory = EXCLUDED.memory THEN memories.embedding ELSE NULL END
       WHERE memories.memory IS DISTINCT FROM EXCLUDED.memory OR memories.date IS DISTINCT FROM EXCLUDED.date
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
    for (let i = 0; i < rows.length; i++) await d().db.query('UPDATE memories SET embedding = $1 WHERE id = $2', [vecs[i], rows[i].id]);
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

module.exports = { recordInput, embed, mirrorPersona, embedMissing, tick, status, EMBED_DIMS, _set: (x) => { deps = x; } };
