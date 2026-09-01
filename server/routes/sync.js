// Cross-device sync. Generic last-write-wins over a JSON row store.
//
//   POST /sync/push  { changes: { <table>: [ { sync_id, data, updated_at, deleted } ] } }
//   GET  /sync/pull?since=<ms>[&tables=a,b,c]  -> { changes: { <table>: [rows] }, serverTime }
//
// Tombstones travel as ordinary rows with deleted:true (data may be {}).
const express = require('express');
const { query } = require('../db');

const r = express.Router();
const MAX_PULL = 5000;

r.post('/push', async (req, res) => {
  const changes = (req.body && req.body.changes) || {};
  let applied = 0;
  try {
    for (const [table, rows] of Object.entries(changes)) {
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || !row.sync_id) continue;
        await query(
          `INSERT INTO sync_rows (table_name, sync_id, data, updated_at, deleted)
             VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (table_name, sync_id) DO UPDATE
             SET data = EXCLUDED.data,
                 updated_at = EXCLUDED.updated_at,
                 deleted = EXCLUDED.deleted
             WHERE sync_rows.updated_at < EXCLUDED.updated_at`,
          [
            String(table),
            String(row.sync_id),
            row.data || {},
            Number(row.updated_at) || Date.now(),
            !!row.deleted,
          ],
        );
        applied++;
      }
    }
    res.json({ ok: true, applied, serverTime: Date.now() });
  } catch (e) {
    console.error('push failed', e.message);
    res.status(500).json({ error: 'push failed: ' + e.message });
  }
});

r.get('/pull', async (req, res) => {
  const since = Number(req.query.since) || 0;
  const only = req.query.tables ? String(req.query.tables).split(',').map((s) => s.trim()).filter(Boolean) : null;
  try {
    const params = [since];
    let sql = `SELECT table_name, sync_id, data, updated_at, deleted
                 FROM sync_rows WHERE updated_at > $1`;
    if (only && only.length) {
      params.push(only);
      sql += ` AND table_name = ANY($2)`;
    }
    sql += ` ORDER BY updated_at ASC LIMIT ${MAX_PULL}`;
    const { rows } = await query(sql, params);
    const changes = {};
    let maxUpdated = since;
    for (const row of rows) {
      (changes[row.table_name] || (changes[row.table_name] = [])).push({
        sync_id: row.sync_id,
        data: row.data,
        updated_at: Number(row.updated_at),
        deleted: row.deleted,
      });
      if (Number(row.updated_at) > maxUpdated) maxUpdated = Number(row.updated_at);
    }
    res.json({
      changes,
      count: rows.length,
      cursor: maxUpdated,
      more: rows.length === MAX_PULL,
      serverTime: Date.now(),
    });
  } catch (e) {
    console.error('pull failed', e.message);
    res.status(500).json({ error: 'pull failed: ' + e.message });
  }
});

module.exports = r;
