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

module.exports = r;
