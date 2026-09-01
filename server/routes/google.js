// Stores the Google OAuth refresh token so the server can make Gmail / Calendar
// calls on a schedule later. Storage only for now — no server-side Google
// features are wired up yet.
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

module.exports = r;
