// Stores the TradeLocker login so server-side crons (T.A.L.O.N. auto-trade,
// W.I.R.E.'s news-trade hand-off) can reach the account without the app open.
// The app posts this on TradeLocker connect / backend connect / app start
// (mirrors server/routes/google.js), and deletes it on disconnect.
const express = require('express');
const { query } = require('../db');

const r = express.Router();

r.post('/creds', async (req, res) => {
  const { email, password, server, env } = req.body || {};
  if (!email || !password || !server) {
    return res.status(400).json({ error: 'email, password and server are required' });
  }
  try {
    await query(
      `INSERT INTO trade_creds (id, email, password, server, env, updated_at)
         VALUES (1, $1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET email = EXCLUDED.email, password = EXCLUDED.password,
             server = EXCLUDED.server, env = EXCLUDED.env, updated_at = EXCLUDED.updated_at`,
      [email, password, server, env === 'live' ? 'live' : 'demo', Date.now()],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.delete('/creds', async (req, res) => {
  try {
    await query('DELETE FROM trade_creds WHERE id = 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = r;
