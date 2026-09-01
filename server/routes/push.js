// Device push-token registration for scheduled nudges.
const express = require('express');
const { query } = require('../db');

const r = express.Router();

r.post('/register', async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'token required' });
  try {
    await query(
      `INSERT INTO devices (push_token, platform, registered_at)
         VALUES ($1, $2, $3)
       ON CONFLICT (push_token) DO UPDATE
         SET platform = EXCLUDED.platform, registered_at = EXCLUDED.registered_at`,
      [token, platform || null, Date.now()],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.post('/unregister', async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    await query('DELETE FROM devices WHERE push_token = $1', [token]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = r;
