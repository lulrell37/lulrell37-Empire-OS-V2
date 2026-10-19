// Mem0 (hosted) on the server — the same memory store the app uses
// (src/services/mem0.js): each persona is a Mem0 `user_id`, so what a persona
// learns on Telegram and in the app lands in one place and either side can
// recall it. Needs MEM0_API_KEY (the same key as the app's Settings → KEYS).
// Best-effort throughout: no key or any failure returns nothing, and callers
// fall back to the synced persona_memory table.
const BASE = 'https://api.mem0.ai';

function key() { return process.env.MEM0_API_KEY || ''; }
function mem0Enabled() { return !!key(); }

// Last result of a read — what the personas' MEMORY line and GET /mem0/status
// report, so a broken Mem0 is said out loud instead of a persona quietly
// going digging through Drive.
let health = { ok: null, status: 0, at: 0 };
function note(ok, status) { health = { ok, status, at: Date.now() }; }
function mem0Health() {
  if (!key()) return { configured: false, ok: false, error: 'MEM0_API_KEY is not set on the backend' };
  if (health.ok === false) {
    const why = health.status === 401 || health.status === 403 ? 'key rejected'
      : health.status === 429 ? 'monthly limit hit' : `unreachable (${health.status || 'network error'})`;
    return { configured: true, ok: false, error: `Mem0 ${why}`, at: health.at };
  }
  return { configured: true, ok: true, checked: !!health.at, at: health.at };
}

// YYYY-MM-DD in his time zone — stamped on every memory so recall can date it.
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

// One fact as a prompt line, dated: "(2026-07-17) He wants …". Prefers the
// date the memory was originally made (metadata.date — set on every add, and
// on the backfill import) over Mem0's created_at, which for imported history
// is the import day.
function mem0Line(f) {
  const t = String((f && f.memory) || '').replace(/\s+/g, ' ').trim();
  const md = f && f.metadata && /^\d{4}-\d{2}-\d{2}/.test(String(f.metadata.date || '')) ? String(f.metadata.date).slice(0, 10) : '';
  const d = md || String((f && (f.created_at || f.updated_at)) || '').slice(0, 10);
  return d ? `(${d}) ${t}` : t;
}

const headers = (k) => ({ Authorization: `Token ${k}`, 'content-type': 'application/json', accept: 'application/json' });

// Store one exchange. Fire-and-forget, never throws.
async function mem0Remember(personaId, text, meta = {}) {
  const k = key();
  const t = String(text || '').trim();
  if (!k || !personaId || !t) return;
  try {
    const r = await fetch(`${BASE}/v3/memories/add/`, {
      method: 'POST',
      headers: headers(k),
      body: JSON.stringify({ user_id: personaId, messages: [{ role: 'user', content: t.slice(0, 12000) }], metadata: { app: 'empire-os', date: today(), ...meta } }),
    });
    if (!r.ok) console.warn(`mem0: add ${r.status}: ${(await r.text()).slice(0, 160)}`);
  } catch (e) {
    console.warn(`mem0: add failed: ${e.message}`);
  }
}

// The facts most relevant to `query` for this persona. [] on any failure.
// Each item: { id, memory, score, categories, created_at }.
async function mem0Search(personaId, query, { topK = 16, threshold = 0.05 } = {}) {
  const k = key();
  const q = String(query || '').trim();
  if (!k || !personaId || !q) return [];
  try {
    const r = await fetch(`${BASE}/v3/memories/search/`, {
      method: 'POST',
      headers: headers(k),
      body: JSON.stringify({ query: q.slice(0, 2000), filters: { user_id: personaId }, top_k: topK, threshold }),
    });
    if (!r.ok) {
      note(false, r.status);
      console.warn(`mem0: search ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return [];
    }
    const d = await r.json();
    note(true);
    return Array.isArray(d && d.results) ? d.results : [];
  } catch (e) {
    note(false, 0);
    console.warn(`mem0: search failed: ${e.message}`);
    return [];
  }
}

// Every memory Mem0 holds for this persona, newest first by the date it was
// made — the whole history, for recall questions a top-k search can't answer
// ("what did we talk about in August", "when did I …"). Capped at `max`.
async function mem0All(personaId, { max = 2000 } = {}) {
  const k = key();
  if (!k || !personaId) return [];
  const out = [];
  try {
    for (let page = 1; out.length < max && page <= 40; page++) {
      const r = await fetch(`${BASE}/v2/memories/`, {
        method: 'POST',
        headers: headers(k),
        body: JSON.stringify({ filters: { user_id: personaId }, page, page_size: 100 }),
      });
      if (!r.ok) {
        note(false, r.status);
        console.warn(`mem0: list ${r.status}: ${(await r.text()).slice(0, 160)}`);
        break;
      }
      note(true);
      const d = await r.json();
      const batch = Array.isArray(d) ? d : (d && d.results) || [];
      out.push(...batch);
      if (batch.length < 100 || (d && !Array.isArray(d) && !d.next)) break;
    }
  } catch (e) {
    note(false, 0);
    console.warn(`mem0: list failed: ${e.message}`);
  }
  const when = (f) => (mem0Line(f).match(/^\((\d{4}-\d{2}-\d{2})\)/) || [])[1] || '';
  return out.slice(0, max).sort((a, b) => when(b).localeCompare(when(a)));
}

module.exports = { mem0Enabled, mem0Remember, mem0Search, mem0All, mem0Line, mem0Health };
