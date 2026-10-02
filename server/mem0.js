// Mem0 (hosted) on the server — the same memory store the app uses
// (src/services/mem0.js): each persona is a Mem0 `user_id`, so what a persona
// learns on Telegram and in the app lands in one place and either side can
// recall it. Needs MEM0_API_KEY (the same key as the app's Settings → KEYS).
// Best-effort throughout: no key or any failure returns nothing, and callers
// fall back to the synced persona_memory table.
const BASE = 'https://api.mem0.ai';

function key() { return process.env.MEM0_API_KEY || ''; }
function mem0Enabled() { return !!key(); }

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
      body: JSON.stringify({ user_id: personaId, messages: [{ role: 'user', content: t.slice(0, 12000) }], metadata: { app: 'empire-os', ...meta } }),
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
      console.warn(`mem0: search ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return [];
    }
    const d = await r.json();
    return Array.isArray(d && d.results) ? d.results : [];
  } catch (e) {
    console.warn(`mem0: search failed: ${e.message}`);
    return [];
  }
}

module.exports = { mem0Enabled, mem0Remember, mem0Search };
