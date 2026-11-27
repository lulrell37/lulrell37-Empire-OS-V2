// Nightly backup of every conversation to his Drive (owner, 2026-11-27: "lets do it just
// for conversation not stuff passed to ara"). The conversations live only in
// tg_messages (Telegram and, since routes/chat.js, the app too), so this is the copy
// he owns. One file per day, `Conversations YYYY-MM-DD.json.gz`, in Drive's
// "Empire OS Backups/Conversations": his messages and the personas' replies, every
// persona. Messages a bot sent on its own (desk alerts, briefs, things passed on
// through A.R.A.) are left out. Messages are only ever added, so the daily files
// together are the whole history and nothing is pruned.
//
// 3:10 AM ET (`CHAT_BACKUP=off`, spoken switch `chat_backup`): every finished ET day
// since the last backup, up to 120 per run (the first run catches up the rest over
// the next nights). State: app_settings.chat_backup { lastTs, lastDay, days, bytes }.
// A failure logs `chat backup failed: …` for the sentinel (one is enough: SCHEDULED).
// Restore: `node server/scripts/restore-conversations.js [--dry] [YYYY-MM-DD …]`
// puts back any message missing from tg_messages (matched on persona, role, time and
// text), so it is safe to run twice. node server/scripts/test-chat-backup.js.
const zlib = require('zlib');

const TZ = 'America/New_York';
const FOLDER = ['Empire OS Backups', 'Conversations'];
const MAX_DAYS = 120;
const OWN = /^\[(SENT ON YOUR OWN|YOU SENT THIS TO MR\. BURRUS THROUGH A\.R\.A\.)[^\]]*\]/;
const isAlert = (c) => OWN.test(String(c || ''));

let deps = null;
const d = () => deps || {
  db: require('./db'), google: require('./google'), store: require('./syncStore'),
};

const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
// Midnight ET today, as ms.
function startOfTodayET(now = Date.now()) {
  const day = etDay(now);
  // ET is UTC-4 or -5: try both and keep the one that lands on midnight of `day`.
  for (const h of [4, 5]) {
    const ms = Date.parse(`${day}T0${h}:00:00Z`);
    if (etDay(ms) === day && etDay(ms - 1) !== day) return ms;
  }
  return Date.parse(`${day}T05:00:00Z`);
}

// Rows -> { 'YYYY-MM-DD': [rows] }, alerts left out.
function byDay(rows) {
  const out = {};
  for (const r of rows) {
    if (isAlert(r.content)) continue;
    const day = etDay(Number(r.ts));
    (out[day] = out[day] || []).push({ persona: r.persona, role: r.role, content: String(r.content || ''), ts: Number(r.ts) });
  }
  return out;
}

const pack = (day, messages) => zlib.gzipSync(Buffer.from(JSON.stringify({ day, kind: 'empire-os conversations', version: 1, count: messages.length, messages })));
const unpack = (buf) => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

async function folderId() {
  const { gapi } = d().google;
  let parent = (await gapi('/drive/v3/files/root', { query: { fields: 'id' } })).id;
  for (const name of FOLDER) {
    const q = `trashed=false and mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and '${parent}' in parents`;
    const hit = await gapi('/drive/v3/files', { query: { q, pageSize: 1, fields: 'files(id)' } });
    parent = (hit && hit.files && hit.files[0] && hit.files[0].id)
      || (await gapi('/drive/v3/files', { method: 'POST', json: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }, query: { fields: 'id' } })).id;
  }
  return parent;
}

// One file into the folder; a file of that name already there is replaced.
async function upload(parent, name, buf) {
  const { gapi, accessToken } = d().google;
  const token = await accessToken();
  if (!token) throw new Error('google not linked');
  const q = `trashed=false and name='${name}' and '${parent}' in parents`;
  const hit = await gapi('/drive/v3/files', { query: { q, pageSize: 1, fields: 'files(id)' } });
  const existing = hit && hit.files && hit.files[0] && hit.files[0].id;
  const boundary = `empire${Date.now()}`;
  const meta = existing ? { name } : { name, parents: [parent], mimeType: 'application/gzip' };
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`),
    buf, Buffer.from(`\r\n--${boundary}--`),
  ]);
  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=multipart&fields=id`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id';
  const res = await fetch(url, { method: existing ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  if (!res.ok) throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()).id;
}

// ET day 'YYYY-MM-DD' -> [start, end) ms.
function dayBounds(day) {
  const start = startOfTodayET(Date.parse(`${day}T12:00:00Z`));
  return [start, startOfTodayET(start + 36 * 3600e3)];
}

// Past days that got messages after their file was made (the phone's imported
// history): the next run writes those days' files again, whole.
async function redoDays(days) {
  const state = await readState();
  const redo = [...new Set([...(state.redo || []), ...days])].sort();
  await d().store.setSetting('chat_backup', JSON.stringify({ ...state, redo }));
}

async function readState() {
  try { return JSON.parse((await d().store.getSetting('chat_backup')) || '{}') || {}; } catch { return {}; }
}

async function tick({ now = Date.now() } = {}) {
  if (String(process.env.CHAT_BACKUP || '').toLowerCase() === 'off') return { skipped: 'CHAT_BACKUP=off' };
  const state = await readState();
  const from = Number(state.lastTs) || 0;
  const until = startOfTodayET(now);
  const { rows } = await d().db.query('SELECT persona, role, content, ts FROM tg_messages WHERE ts > $1 AND ts < $2 ORDER BY ts ASC, id ASC', [from, until]);
  const days = byDay(rows);
  // Days to write again, whole (imported history), before today only.
  const today = etDay(now);
  const redo = (state.redo || []).filter((x) => x < today);
  for (const day of redo) {
    if (days[day]) continue;
    const [lo, hi] = dayBounds(day);
    const r = await d().db.query('SELECT persona, role, content, ts FROM tg_messages WHERE ts >= $1 AND ts < $2 ORDER BY ts ASC, id ASC', [lo, hi]);
    days[day] = byDay(r.rows)[day] || [];
  }
  const order = Object.keys(days).filter((x) => days[x].length).sort().slice(0, MAX_DAYS);
  // Days with only alerts still move the mark forward.
  if (!order.length) {
    const last = rows.length ? Number(rows[rows.length - 1].ts) : from;
    if (last > from || redo.length) await d().store.setSetting('chat_backup', JSON.stringify({ ...state, lastTs: Math.max(last, from), redo: (state.redo || []).filter((x) => !redo.includes(x)) }));
    return { backedUp: 0 };
  }
  const parent = await folderId();
  let bytes = Number(state.bytes) || 0, count = Number(state.days) || 0, lastTs = from, lastDay = state.lastDay || '';
  let pendingRedo = [...(state.redo || [])];
  for (const day of order) {
    const buf = pack(day, days[day]);
    await upload(parent, `Conversations ${day}.json.gz`, buf);
    bytes += buf.length; count += 1; lastDay = day;
    lastTs = Math.max(lastTs, ...days[day].map((m) => m.ts).filter((t) => t < until));
    lastDay = day > lastDay ? day : lastDay;
    pendingRedo = pendingRedo.filter((x) => x !== day);
    // Saved after each day, so a failure part way keeps what's done.
    await d().store.setSetting('chat_backup', JSON.stringify({ lastTs, lastDay, days: count, bytes, redo: pendingRedo, at: Date.now() }));
  }
  return { backedUp: order.length, lastDay, more: Object.keys(days).length > order.length };
}

// Every backup file in the folder (or just these days) -> missing messages put back.
async function restore({ days = [], dry = false } = {}) {
  const { gapi, accessToken } = d().google;
  const parent = await folderId();
  const list = await gapi('/drive/v3/files', { query: { q: `trashed=false and '${parent}' in parents and name contains 'Conversations '`, pageSize: 1000, fields: 'files(id,name)' } });
  const files = ((list && list.files) || []).filter((f) => !days.length || days.some((x) => f.name.includes(x))).sort((a, b) => a.name.localeCompare(b.name));
  const token = await accessToken();
  let added = 0, present = 0;
  for (const f of files) {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`google ${res.status} on ${f.name}`);
    const { messages = [] } = unpack(Buffer.from(await res.arrayBuffer()));
    for (const m of messages) {
      const { rows } = await d().db.query('SELECT 1 FROM tg_messages WHERE persona = $1 AND role = $2 AND ts = $3 AND content = $4 LIMIT 1', [m.persona, m.role, m.ts, m.content]);
      if (rows.length) { present += 1; continue; }
      if (!dry) await d().db.query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', [m.persona, m.role, m.content, m.ts]);
      added += 1;
    }
  }
  return { files: files.length, added, present, dry };
}

async function status() {
  const s = await readState();
  return s.lastDay
    ? `Conversations backed up through ${s.lastDay} (${s.days} day files, ${(s.bytes / 1024).toFixed(0)} KB) in Drive › ${FOLDER.join(' › ')}.`
    : 'No conversation backup has run yet.';
}

module.exports = { redoDays, dayBounds, tick, restore, status, byDay, pack, unpack, startOfTodayET, isAlert, FOLDER, _set: (x) => { deps = x; } };
