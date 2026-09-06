// Convene the Empire Council on demand, off its 5am schedule, and report live
// meeting status.
//
//   POST /council/run     -> { ok: true, started: true }
//   GET  /council/status  -> { active, phase, round, rounds, speaking, spoke, progress, headline, ... }
//
// A.R.A. emits [COUNCIL_CONVENE] in chat; the app force-syncs (so any notes /
// ideas just handed to her are on the server) and hits /run. The meeting itself
// takes a few minutes and ~20+ model calls, so we kick it off and respond right
// away. While it runs the app fast-polls /status to drive the notification
// banner and the gold "speaking now" glow on the galaxy orbs.
const express = require('express');
const { runCouncilMeeting, getCouncilLive, endCouncilLive } = require('../councilMeeting');

const r = express.Router();
let running = false;

r.post('/run', (req, res) => {
  if (running) return res.status(409).json({ error: 'a council run is already in progress' });
  running = true;
  res.json({ ok: true, started: true });
  runCouncilMeeting({ force: true })
    .then((out) => console.log('council (convened):', JSON.stringify(out)))
    .catch((e) => {
      console.error('council (convened) failed:', e.message);
      endCouncilLive(e.message).catch(() => {});
    })
    .finally(() => { running = false; });
});

r.get('/status', (req, res) => {
  getCouncilLive()
    .then((s) => res.json(s || { active: false }))
    .catch(() => res.json({ active: false }));
});

module.exports = r;
