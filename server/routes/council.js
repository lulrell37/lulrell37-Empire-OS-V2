// Convene the Empire Council on demand, off its 5am schedule.
//
//   POST /council/run   -> { ok: true, started: true }
//
// A.R.A. emits [COUNCIL_CONVENE] in chat; the app force-syncs (so any notes /
// ideas just handed to her are on the server) and hits this. The meeting itself
// takes a few minutes and ~20+ model calls, so we kick it off and respond right
// away — the usual "the council met" push + transcript note land when it's done.
const express = require('express');
const { runCouncilMeeting } = require('../councilMeeting');

const r = express.Router();
let running = false;

r.post('/run', (req, res) => {
  if (running) return res.status(409).json({ error: 'a council run is already in progress' });
  running = true;
  res.json({ ok: true, started: true });
  runCouncilMeeting({ force: true })
    .then((out) => console.log('council (convened):', JSON.stringify(out)))
    .catch((e) => console.error('council (convened) failed:', e.message))
    .finally(() => { running = false; });
});

module.exports = r;
