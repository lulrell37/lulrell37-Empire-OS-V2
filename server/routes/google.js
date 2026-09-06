// Stores the Google OAuth refresh token so server-side crons can act as the
// owner's account. Today that's the nightly Empire Council reading the "Council
// Brief" Drive note (see server/google.js + server/councilMeeting.js). The app
// posts the token on Google connect / backend connect / app start, and deletes
// it here when Google is disconnected.
const express = require('express');
const { query } = require('../db');

const r = express.Router();

r.post('/token', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ error: 'refreshToken required' });
  }
  try {
    await query(
      `INSERT INTO google_tokens (id, refresh_token, updated_at)
         VALUES (1, $1, $2)
       ON CONFLICT (id) DO UPDATE
         SET refresh_token = EXCLUDED.refresh_token, updated_at = EXCLUDED.updated_at`,
      [refreshToken, Date.now()],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.delete('/token', async (req, res) => {
  try {
    await query('DELETE FROM google_tokens WHERE id = 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = r;
