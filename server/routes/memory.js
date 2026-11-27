// The app's way to the server's own memory (server/memoryStore.js, step 2). The phone
// asks which engine is on; with 'server', its Mem0 calls come here instead, so the app
// and Telegram read and write the same memory.
//   GET  /memory/engine                         -> { engine: 'mem0' | 'server' }
//   POST /memory/search { persona, query, topK, threshold } -> { results }
//   GET  /memory/all?persona=                   -> { results }  every current fact
//   POST /memory/add { persona, text, meta }    -> { ok }  saved, facts pulled out, Mem0 too
const express = require('express');
const router = express.Router();
const ms = () => require('../memoryStore');
const valid = (id) => !!require('../personas').ROSTER[id];

router.get('/engine', async (req, res) => res.json({ engine: await ms().engine().catch(() => 'mem0') }));
router.post('/search', async (req, res) => {
  const { persona, query, topK, threshold } = req.body || {};
  if (!valid(persona)) return res.status(404).json({ error: 'unknown persona' });
  try { res.json({ results: await require('../mem0').mem0Search(persona, query, { topK: Number(topK) || 16, threshold: threshold == null ? 0.05 : Number(threshold) }) }); }
  catch (e) { console.error('server memory failed: app search:', e.message); res.status(500).json({ error: e.message }); }
});
router.get('/all', async (req, res) => {
  const persona = String(req.query.persona || '');
  if (!valid(persona)) return res.status(404).json({ error: 'unknown persona' });
  try { res.json({ results: await require('../mem0').mem0All(persona, { max: Infinity }) }); }
  catch (e) { console.error('server memory failed: app list:', e.message); res.status(500).json({ error: e.message }); }
});
router.post('/add', async (req, res) => {
  const { persona, text, meta } = req.body || {};
  if (!valid(persona)) return res.status(404).json({ error: 'unknown persona' });
  if (!String(text || '').trim()) return res.status(400).json({ error: 'empty' });
  try { await require('../mem0').mem0Remember(persona, String(text), { ...(meta || {}), source: (meta && meta.source) || 'app' }); res.json({ ok: true }); }
  catch (e) { console.error('server memory failed: app add:', e.message); res.status(500).json({ error: e.message }); }
});
module.exports = router;
