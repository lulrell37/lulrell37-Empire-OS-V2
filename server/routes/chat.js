// One conversation per persona, app and Telegram alike (owner, 2026-11-27: "make the
// app like Telegram, all the stuff passed to A.R.A. and everything"; "if we have Mem0
// we wouldn't need conversations stored on the app"). The thread lives in
// tg_messages, the table every Telegram turn already reads, so the app shows and
// adds to the same thread instead of keeping its own copy. Anything a bot sent him
// on its own (desk alerts, briefs, things passed on through A.R.A.) is split out as
// alerts: the app shows those in the persona's ◈ activity tab, not the chat.
//
//   GET  /chat/:persona?limit=40          -> { messages: [{ id, role, content, ts }] }  newest last
//   GET  /chat/:persona/alerts?limit=30   -> { alerts:   [{ id, content, ts, from }] }  newest first
//   POST /chat/:persona { role, content } -> { ok, id, dup }  an app exchange, into the thread
//   POST /chat/:persona/import { messages: [{ role, content, ts }] } -> { added, skipped }
//        the phone's old chat history (step 3), with its own times; already there = skipped
// node server/scripts/test-chat-route.js.
const express = require('express');

const OWN = /^\[(SENT ON YOUR OWN|YOU SENT THIS TO MR\. BURRUS THROUGH A\.R\.A\.)[^\]]*\]\s*/;
const isAlert = (c) => OWN.test(String(c || ''));
const unmark = (c) => String(c || '').replace(OWN, '').trim();
const DUP_MS = 2 * 60 * 1000;

let db = null;
const q = (...a) => (db || require('../db')).query(...a);

function validPersona(id) {
  const { ROSTER } = require('../personas');
  return ROSTER[id] ? id : null;
}

// Newest `limit` conversation rows (alerts left out), oldest first.
async function thread(persona, limit = 40) {
  const { rows } = await q('SELECT id, role, content, ts FROM tg_messages WHERE persona = $1 ORDER BY ts DESC, id DESC LIMIT $2', [persona, limit * 3]);
  return rows.filter((r) => !isAlert(r.content)).slice(0, limit).reverse()
    .map((r) => ({ id: Number(r.id), role: r.role === 'user' ? 'user' : 'assistant', content: String(r.content || ''), ts: Number(r.ts) || 0 }));
}

async function alerts(persona, limit = 30) {
  const { rows } = await q('SELECT id, content, ts FROM tg_messages WHERE persona = $1 ORDER BY ts DESC, id DESC LIMIT $2', [persona, 400]);
  const { relayFrom } = require('../personaVoice');
  return rows.filter((r) => isAlert(r.content)).slice(0, limit).map((r) => {
    const content = unmark(r.content);
    return { id: Number(r.id), content, ts: Number(r.ts) || 0, from: relayFrom(content.replace(/\*\*/g, ''), true) || null };
  });
}

// An app exchange joins the thread. The same text from the same side within 2 min
// is the app retrying, not a new message, so it's stored once.
async function add(persona, role, content) {
  const r = role === 'user' ? 'user' : 'assistant';
  const text = String(content || '').trim(); // whole, never cut
  if (!text) return { ok: false, error: 'empty message' };
  const { rows } = await q('SELECT id FROM tg_messages WHERE persona = $1 AND role = $2 AND content = $3 AND ts > $4 LIMIT 1',
    [persona, r, text, Date.now() - DUP_MS]);
  if (rows.length) return { ok: true, id: Number(rows[0].id), dup: true };
  const ins = await q('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4) RETURNING id', [persona, r, text, Date.now()]);
  return { ok: true, id: Number(ins.rows[0] && ins.rows[0].id), dup: false };
}

// The phone's old history (step 3, owner 2026-11-27: "start on step 3"). Each message
// keeps its own time. One already in the thread (same side and text within 2 min of
// it, e.g. pushed live today) is skipped, so re-sending a batch is safe. Past days
// that got new messages are re-done by the nightly Drive backup.
async function importMessages(persona, messages) {
  let added = 0, skipped = 0;
  const days = new Set();
  for (const m of messages) {
    const role = m && m.role === 'user' ? 'user' : m && m.role === 'assistant' ? 'assistant' : null;
    const text = String((m && m.content) || '').trim();
    const ts = Number(m && m.ts);
    if (!role || !text || !Number.isFinite(ts) || ts <= 0 || ts > Date.now() + 60000) { skipped++; continue; }
    const { rows } = await q('SELECT 1 FROM tg_messages WHERE persona = $1 AND role = $2 AND content = $3 AND ts BETWEEN $4 AND $5 LIMIT 1',
      [persona, role, text, ts - DUP_MS, ts + DUP_MS]);
    if (rows.length) { skipped++; continue; }
    await q('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', [persona, role, text, ts]);
    added++;
    days.add(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ts)));
  }
  if (days.size) await require('../chatBackup').redoDays([...days]).catch((e) => console.error('chat failed: backup redo:', e.message));
  return { added, skipped };
}

const router = express.Router();
const lim = (v, d, max) => Math.max(1, Math.min(max, Number(v) || d));

router.get('/:persona/alerts', async (req, res) => {
  const p = validPersona(req.params.persona);
  if (!p) return res.status(404).json({ error: 'unknown persona' });
  try { res.json({ alerts: await alerts(p, lim(req.query.limit, 30, 100)) }); }
  catch (e) { console.error('chat failed: alerts:', e.message); res.status(500).json({ error: e.message }); }
});
router.post('/:persona/import', async (req, res) => {
  const p = validPersona(req.params.persona);
  if (!p) return res.status(404).json({ error: 'unknown persona' });
  const list = Array.isArray((req.body || {}).messages) ? req.body.messages : null;
  if (!list) return res.status(400).json({ error: 'messages: [{ role, content, ts }]' });
  if (list.length > 1000) return res.status(400).json({ error: 'at most 1000 per batch' });
  try { res.json(await importMessages(p, list)); }
  catch (e) { console.error('chat failed: import:', e.message); res.status(500).json({ error: e.message }); }
});
router.get('/:persona', async (req, res) => {
  const p = validPersona(req.params.persona);
  if (!p) return res.status(404).json({ error: 'unknown persona' });
  try { res.json({ messages: await thread(p, lim(req.query.limit, 40, 200)) }); }
  catch (e) { console.error('chat failed: thread:', e.message); res.status(500).json({ error: e.message }); }
});
router.post('/:persona', async (req, res) => {
  const p = validPersona(req.params.persona);
  if (!p) return res.status(404).json({ error: 'unknown persona' });
  try {
    const out = await add(p, (req.body || {}).role, (req.body || {}).content);
    res.status(out.ok ? 200 : 400).json(out);
  } catch (e) { console.error('chat failed: save:', e.message); res.status(500).json({ error: e.message }); }
});

router._test = { importMessages, isAlert, unmark, thread, alerts, add, setDb: (x) => { db = x; } };
module.exports = router;
