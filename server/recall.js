// Look at memory before talking (owner, 2026-11-27: "can i have them look at memory
// before they talk for anything. even if something is passed to ara if its something
// we talked about she should have memory of our conversation instead of acting like
// its something new. should pertain to brief as well").
//
// One lookup, no AI call: Mem0's facts on the topic (this persona's, plus whoever
// passed it on), his Telegram messages with this persona that share the topic's
// words (older than the history the turn already loads), and optionally the last
// few lines of his chat with them. Used by direct turns (memoryBlock), relays
// (relayToPersona), A.R.A.'s voice on anything passed to her (araScript) and the
// morning brief's spoken script. Best-effort and time-capped: memory being slow or
// down never holds a reply up.
const { query } = require('./db');
const { mem0Search, mem0Line } = require('./mem0');

const TZ = 'America/New_York';
const STOP = new Set(('what when where which about that this with from have your were they them then than there their said tell '
  + 'remember talk talked know does dont didnt just like into over more some also back time last week month year ever been would '
  + 'could should here want need going yeah okay sure mr burrus please thanks thank really right make sure today tomorrow '
  + 'message says said says sent send ara talon wire atlas jarvis').split(' '));
const RECALL_MS = Number(process.env.RECALL_MS) || 6000;

function words(text, max = 8) {
  const ws = [...new Set(String(text || '').toLowerCase().replace(/https?:\S+/g, ' ').match(/[a-z0-9][a-z0-9'-]{3,}/g) || [])]
    .map((w) => w.replace(/'s$/, '')).filter((w) => !STOP.has(w) && !/^\d{1,3}$/.test(w));
  // Longer words carry the topic ("thanksgiving", "invoice") more than short ones.
  return ws.sort((a, b) => b.length - a.length).slice(0, max);
}

const when = (ms) => new Date(Number(ms)).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const nameOf = (id) => { try { return (require('./personas').ROSTER[id] || {}).name || id; } catch { return id; } };
const flat = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// Telegram lines with this persona that share 2+ of the topic's words (1 when the
// topic has only one). `skipNewest`: that many newest rows are already in the
// turn's history, so they're left out.
async function chatMatches(persona, ws, { skipNewest = 0, limit = 6 } = {}) {
  if (!ws.length) return [];
  const need = ws.length >= 3 ? 2 : 1;
  const params = [persona, skipNewest, ...ws.map((w) => `%${w}%`)];
  const { rows } = await query(
    `SELECT id, role, content, ts FROM tg_messages WHERE persona = $1
       AND id < COALESCE((SELECT MIN(id) FROM (SELECT id FROM tg_messages WHERE persona = $1 ORDER BY id DESC LIMIT $2) t), 9223372036854775807)
       AND (${ws.map((_, i) => `content ILIKE $${i + 3}`).join(' OR ')})
     ORDER BY id DESC LIMIT 120`, params,
  ).catch(() => ({ rows: [] }));
  return rows
    .map((r) => { const c = String(r.content || '').toLowerCase(); return { ...r, hits: ws.filter((w) => c.includes(w)).length }; })
    .filter((r) => r.hits >= need)
    .sort((a, b) => b.hits - a.hits || Number(b.ts) - Number(a.ts))
    .slice(0, limit)
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

// The last `n` messages of his chat with this persona within `hours`.
async function recentChat(persona, n, hours = 24) {
  if (!n) return [];
  const { rows } = await query('SELECT role, content, ts FROM tg_messages WHERE persona = $1 AND ts > $2 ORDER BY id DESC LIMIT $3',
    [persona, Date.now() - hours * 3600e3, n]).catch(() => ({ rows: [] }));
  return rows.reverse();
}

// His last few messages to this persona: a short follow-up ("what about that?")
// searches on what it follows, not on its own two words.
async function lastAsked(persona, n = 2) {
  const { rows } = await query("SELECT content FROM tg_messages WHERE persona = $1 AND role = 'user' ORDER BY id DESC LIMIT $2", [persona, n])
    .catch(() => ({ rows: [] }));
  return rows.map((r) => String(r.content || '').slice(0, 400)).join('\n');
}

function capped(p, ms) {
  let t;
  return Promise.race([p, new Promise((res) => { t = setTimeout(() => res(null), ms); })]).finally(() => clearTimeout(t));
}

// -> { facts: [{ who, line }], chats: [{ role, content, ts }], recent: [...] }
async function recall(persona, text, { also = [], skipNewest = 0, recent = 0, followUp = false, facts = 10, chats = 6, ms = RECALL_MS } = {}) {
  const empty = { facts: [], chats: [], recent: [] };
  const run = async () => {
    const q = `${followUp ? `${await lastAsked(persona)}\n` : ''}${String(text || '')}`.trim().slice(0, 2000);
    if (!q) return empty;
    const others = [...new Set(also)].filter((id) => id && id !== persona);
    const [mine, theirs, matched, last] = await Promise.all([
      mem0Search(persona, q, { topK: facts }).catch(() => []),
      Promise.all(others.map((id) => mem0Search(id, q, { topK: 5 }).then((xs) => xs.map((x) => ({ id, x }))).catch(() => []))),
      chatMatches(persona, words(q), { skipNewest, limit: chats }),
      recentChat(persona, recent),
    ]);
    const good = (f) => String((f && f.memory) || '').trim().length > 2;
    return {
      facts: [
        ...mine.filter(good).map((f) => ({ who: persona, line: mem0Line(f) })),
        ...theirs.flat().filter(({ x }) => good(x)).map(({ id, x }) => ({ who: id, line: mem0Line(x) })),
      ],
      chats: matched,
      recent: last,
    };
  };
  try { return (await capped(run(), ms)) || empty; } catch { return empty; }
}

// The prompt block. `self` is whose memory it is. Empty when nothing came back.
function recallBlock(r, self, { title = 'BEFORE YOU ANSWER — WHAT YOU AND MR. BURRUS ALREADY SAID ABOUT THIS' } = {}) {
  if (!r || (!r.facts.length && !r.chats.length && !r.recent.length)) return '';
  const me = nameOf(self);
  const L = [];
  if (r.facts.length) {
    L.push(`From memory (dated YYYY-MM-DD):\n${r.facts.map((f) => `  - ${f.who === self ? '' : `(${nameOf(f.who)}'s memory) `}${flat(f.line, 400)}`).join('\n')}`);
  }
  if (r.chats.length) {
    L.push(`Your earlier messages with him on this (Telegram, oldest first):\n${r.chats.map((c) => `  [${when(c.ts)}] ${c.role === 'user' ? 'Mr. Burrus' : me}: ${flat(c.content, 500)}`).join('\n')}`);
  }
  if (r.recent.length) {
    L.push(`Your chat with him in the last day (oldest first):\n${r.recent.map((c) => `  [${when(c.ts)}] ${c.role === 'user' ? 'Mr. Burrus' : me}: ${flat(c.content, 400)}`).join('\n')}`);
  }
  return `[${title} — you looked this up before talking. If what's in front of you connects to any of it, you remember it: pick up from there ("like we said Tuesday…", "that's the one you asked me about this morning"), build on what was decided, and don't ask him again for what he already told you. Never treat something you two already talked about as new. If none of it connects, ignore it, and never invent a past conversation.\n${L.join('\n')}\n]`;
}

module.exports = { recall, recallBlock, words, chatMatches };
