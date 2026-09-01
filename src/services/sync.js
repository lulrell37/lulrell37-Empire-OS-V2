// Cross-device sync client. Pushes local changes (rows whose updated_at moved,
// plus tombstones) to the backend and pulls everyone else's back, last-write-
// wins by updated_at. Does nothing at all until a backend is configured in
// Settings, so the app is unchanged for anyone not using it.
//
// Pull ordering is by the server's own monotonic `server_seq`, so device clock
// skew can't hide rows. During apply, `sync_meta.mute` is set so the DB triggers
// don't re-stamp the rows we just received.
import { getDb, SYNC_TABLE_NAMES } from './database';
import { loadBackend } from './keyStore';

const PUSH_LIMIT = 2000;

let inFlight = null;
let listeners = [];
let status = { configured: false, running: false, lastSync: 0, error: null };
const colCache = {};

export function syncStatus() { return status; }
export function onSyncChange(fn) {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}
function emit() { for (const f of listeners) { try { f(status); } catch {} } }
function set(patch) { status = { ...status, ...patch }; emit(); }

async function meta() {
  return (await getDb().getFirstAsync('SELECT * FROM sync_meta WHERE id=1')) || {};
}
async function setMeta(patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  await getDb().runAsync(
    `UPDATE sync_meta SET ${keys.map((k) => k + '=?').join(',')} WHERE id=1`,
    keys.map((k) => patch[k]),
  );
}
async function columns(table) {
  if (!colCache[table]) {
    const info = await getDb().getAllAsync(`PRAGMA table_info(${table})`);
    colCache[table] = info.map((c) => c.name);
  }
  return colCache[table];
}

// Unauthenticated reachability + version check for the Settings screen. Returns
// the /health payload on success; throws a human-readable error otherwise.
export async function pingBackend(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  if (!clean) throw new Error('Enter a backend URL');
  let res;
  try {
    res = await fetch(clean + '/health', { method: 'GET' });
  } catch (e) {
    throw new Error('Cannot reach ' + clean);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json || !json.ok) throw new Error(`Unexpected response (HTTP ${res.status})`);
  if (json.service !== 'empire-os-backend') throw new Error('That URL is not an Empire OS backend');
  return json;
}

async function api(be, method, path, body) {
  const res = await fetch(be.url + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + be.token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ---- push -----------------------------------------------------------------

const INTERNAL_SETTING = /^_?sync_/;

async function pushChanges(be) {
  const db = getDb();
  const cursor = (await meta()).push_cursor || 0;
  const changes = {};
  let maxTs = cursor;

  for (const t of SYNC_TABLE_NAMES) {
    const rows = await db.getAllAsync(
      `SELECT * FROM ${t} WHERE updated_at > ? ORDER BY updated_at ASC LIMIT ${PUSH_LIMIT}`,
      [cursor],
    );
    if (!rows.length) continue;
    const out = [];
    for (const r of rows) {
      if (t === 'app_settings' && INTERNAL_SETTING.test(r.sync_id || r.key || '')) continue;
      const { id, sync_id, updated_at, ...data } = r;
      out.push({ sync_id, updated_at, deleted: false, data });
      if (updated_at > maxTs) maxTs = updated_at;
    }
    if (out.length) changes[t] = out;
  }

  const tombs = await db.getAllAsync(
    'SELECT * FROM tombstones WHERE deleted_at > ? ORDER BY deleted_at ASC LIMIT 4000',
    [cursor],
  );
  for (const tb of tombs) {
    if (!SYNC_TABLE_NAMES.includes(tb.table_name)) continue;
    (changes[tb.table_name] || (changes[tb.table_name] = [])).push({
      sync_id: tb.sync_id, updated_at: tb.deleted_at, deleted: true, data: {},
    });
    if (tb.deleted_at > maxTs) maxTs = tb.deleted_at;
  }

  if (!Object.keys(changes).length) return;
  await api(be, 'POST', '/sync/push', { changes });
  await setMeta({ push_cursor: maxTs });
}

// ---- pull -----------------------------------------------------------------

async function applyRow(db, table, cols, row) {
  const data = row.data || {};
  const fields = Object.keys(data).filter((k) => cols.includes(k) && k !== 'id' && k !== 'sync_id' && k !== 'updated_at');
  // hud_state is a singleton keyed by id=1
  const extraCols = table === 'hud_state' ? ['id'] : [];
  const extraVals = table === 'hud_state' ? [1] : [];
  const allCols = [...extraCols, ...fields, 'sync_id', 'updated_at'];
  const vals = [...extraVals, ...fields.map((k) => data[k]), row.sync_id, row.updated_at];
  const ph = allCols.map(() => '?').join(',');
  const upd = [...fields, 'updated_at'].map((k) => `${k}=excluded.${k}`).join(',');
  await db.runAsync(
    `INSERT INTO ${table} (${allCols.join(',')}) VALUES (${ph})
     ON CONFLICT(sync_id) DO UPDATE SET ${upd}`,
    vals,
  );
}

async function pullChanges(be) {
  const db = getDb();
  let cursor = (await meta()).pull_cursor || 0;
  let guard = 0;
  for (;;) {
    const res = await api(be, 'GET', `/sync/pull?since=${cursor}`);
    const changes = res.changes || {};
    await db.runAsync('UPDATE sync_meta SET mute=1 WHERE id=1');
    try {
      for (const [table, rows] of Object.entries(changes)) {
        if (!SYNC_TABLE_NAMES.includes(table)) continue;
        const cols = await columns(table);
        for (const row of rows) {
          const local = await db.getFirstAsync(
            `SELECT updated_at FROM ${table} WHERE sync_id=?`, [row.sync_id],
          );
          if (local && Number(local.updated_at) >= Number(row.updated_at)) continue; // local is newer
          if (row.deleted) {
            await db.runAsync(`DELETE FROM ${table} WHERE sync_id=?`, [row.sync_id]);
            await db.runAsync('DELETE FROM tombstones WHERE table_name=? AND sync_id=?', [table, row.sync_id]);
          } else {
            await applyRow(db, table, cols, row);
          }
        }
      }
    } finally {
      await db.runAsync('UPDATE sync_meta SET mute=0 WHERE id=1');
    }
    cursor = Number(res.cursor) || cursor;
    await setMeta({ pull_cursor: cursor });
    if (!res.more || ++guard > 20) break;
  }
}

// ---- orchestration -------------------------------------------------------

export async function runSync(opts = {}) {
  const be = await loadBackend();
  if (!be) { set({ configured: false, running: false }); return status; }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    set({ configured: true, running: true, error: null });
    try {
      if (opts.full) await setMeta({ push_cursor: 0, pull_cursor: 0 });
      await pushChanges(be);
      await pullChanges(be);
      await pushChanges(be); // catch local edits made during the pull
      const now = Date.now();
      await setMeta({ last_sync: now, last_error: null });
      set({ running: false, lastSync: now, error: null });
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      await setMeta({ last_error: msg }).catch(() => {});
      set({ running: false, error: msg });
    } finally {
      inFlight = null;
    }
    return status;
  })();
  return inFlight;
}

let debounceTimer = null;
export function scheduleSync(delay = 4000) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; runSync(); }, delay);
}

export async function initSyncStatus() {
  const be = await loadBackend();
  const m = await meta().catch(() => ({}));
  set({ configured: !!be, lastSync: m.last_sync || 0, error: m.last_error || null });
  return status;
}
