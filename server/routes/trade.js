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
    // Keep one login per account type (2 = demo, 3 = live) so T.A.L.O.N. can
    // be switched between them from Telegram. The app re-posts its login on
    // every start — the same login again leaves that choice alone; a login he
    // just connected (new or changed) becomes the one he trades on, as before.
    const e = env === 'live' ? 'live' : 'demo';
    const slot = e === 'live' ? 3 : 2;
    const { rows: had } = await query('SELECT email, password, server FROM trade_creds WHERE id = $1', [slot]);
    const same = had[0] && had[0].email === email && had[0].password === password && had[0].server === server;
    await query(
      `INSERT INTO trade_creds (id, email, password, server, env, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, password = EXCLUDED.password,
         server = EXCLUDED.server, env = EXCLUDED.env, updated_at = EXCLUDED.updated_at`,
      [slot, email, password, server, e, Date.now()],
    );
    if (!same) await require('../syncStore').setSetting('talon_account', e);
    // Drop the old session so the next call logs in on the new login — a
    // demo -> live switch otherwise keeps refreshing the demo token.
    require('../tradeLocker').tlReset();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

r.delete('/creds', async (req, res) => {
  try {
    await query('DELETE FROM trade_creds');
    await require('../syncStore').setSetting('talon_account', '');
    require('../tradeLocker').tlReset();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Can T.A.L.O.N. trade with the app closed? (creds on file, toggle, last cycle, last error)
r.get('/status', async (req, res) => {
  try { res.json(await require('../talonAutoTrade').status()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = r;
