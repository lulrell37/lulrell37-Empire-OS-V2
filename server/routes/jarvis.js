// J.A.R.V.I.S.'s engine (server/jarvisEngine.js) for the app.
//
//   GET  /jarvis/engine            -> engine status ({ enabled, model, readOnly, … })
//   POST /jarvis/ask { text, system } -> { id }   start a Claude Code turn
//   GET  /jarvis/ask/:id           -> { status: running|done|error|cancelled, progress, text, error, secs }
//   POST /jarvis/ask/:id/cancel    -> { ok }   the stop button: kill the turn
//   POST /jarvis/ask/:id/detach    -> { ok }   the app stopped listening: keep going,
//                                               answer on Telegram if nobody collects it
//
// `system` is the app's own J.A.R.V.I.S. prompt for that turn (persona, live
// context, command tags), appended to Claude Code's system prompt.
const express = require('express');
const engine = require('../jarvisEngine');

const r = express.Router();

r.get('/engine', (req, res) => res.json(engine.status()));

r.post('/ask', (req, res) => {
  if (!engine.enabled()) return res.status(503).json({ error: 'the J.A.R.V.I.S. engine is off on this server' });
  const { text = '', system = '' } = req.body || {};
  if (!String(text).trim()) return res.status(400).json({ error: 'nothing to ask' });
  res.json({ id: engine.startJob(String(text), String(system)) });
});

r.get('/ask/:id', (req, res) => {
  const j = engine.jobStatus(req.params.id);
  if (!j) return res.status(404).json({ error: 'no such job (the server may have restarted)' });
  res.json(j);
});

r.post('/ask/:id/cancel', (req, res) => res.json({ ok: engine.cancelJob(req.params.id) }));
r.post('/ask/:id/detach', (req, res) => res.json({ ok: engine.detachJob(req.params.id) }));

module.exports = r;
