// R.O.G.U.E.'s clip scan for the app: POST /clips/scan { url, focus } starts the
// scan in the background (it takes minutes) and the ranked list + clips arrive
// on Telegram from A.R.A. when it's done.
const express = require('express');
const clips = require('../clipScan');

const r = express.Router();

r.post('/scan', (req, res) => {
  const { url, focus = '' } = req.body || {};
  if (!/^https?:\/\//i.test(String(url || ''))) return res.status(400).json({ error: 'needs a link to the video' });
  clips.scanInBackground(String(url), String(focus || ''));
  res.status(202).json({ ok: true });
});

// [TRANSCRIBE: link] from the app: POST /clips/transcribe { url, persona } — runs in
// the background; the transcript lands on Telegram and in a Drive note.
r.post('/transcribe', (req, res) => {
  const { url, persona = 'ara' } = req.body || {};
  const t = require('../transcribe');
  if (!t.sourceOf(url)) return res.status(400).json({ error: 'needs a YouTube, Instagram, TikTok or Google Drive link to one video' });
  t.transcribeInBackground(String(url).trim(), String(persona || 'ara'));
  res.status(202).json({ ok: true });
});

module.exports = r;
