// Thin helpers over the sync_rows JSON store (the same generic last-write-wins
// table the app syncs to). councilMeeting.js and personaRuntime.js each carry
// their own copies of these for historical reasons; new server code should use
// this module.
const { query } = require('./db');

async function syncedRow(table, syncId) {
  const { rows } = await query(
    'SELECT data FROM sync_rows WHERE table_name = $1 AND sync_id = $2 AND deleted = false',
    [table, syncId],
  );
  return rows[0] ? rows[0].data || {} : null;
}

async function syncedRows(table) {
  const { rows } = await query(
    'SELECT sync_id, data FROM sync_rows WHERE table_name = $1 AND deleted = false',
    [table],
  );
  return rows.map((r) => ({ ...(r.data || {}), sync_id: r.sync_id }));
}

async function upsertSyncRow(table, syncId, data) {
  await query(
    `INSERT INTO sync_rows (table_name, sync_id, data, updated_at, deleted, server_seq)
       VALUES ($1, $2, $3, $4, false, nextval('sync_seq'))
     ON CONFLICT (table_name, sync_id) DO UPDATE
       SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at,
           deleted = false, server_seq = nextval('sync_seq')`,
    [table, syncId, JSON.stringify(data), Date.now()],
  );
}

async function getSetting(key, fallback) {
  const d = await syncedRow('app_settings', key);
  return d && d.value !== undefined ? d.value : fallback;
}

async function setSetting(key, value) {
  await upsertSyncRow('app_settings', key, { key, value: String(value) });
}

module.exports = { syncedRow, syncedRows, upsertSyncRow, getSetting, setSetting };
