// Server-side Google, minimal. Trades the stored refresh token for an access
// token (the app registers a NATIVE Android OAuth client, which has no secret —
// PKCE clients refresh with the client_id alone), caches it until ~1 min before
// expiry, and exposes the one Drive read the crons need: the owner's "Council
// Brief" note, which A.R.A. reads to the room at the nightly Empire Council.
//
// The refresh token arrives via POST /google/token (routes/google.js) from the
// app whenever the owner connects Google. Nothing here does anything until then.
const { query } = require('./db');

// Same Android OAuth client id the app ships (src/services/googleAuth.js). Public
// by design; override with GOOGLE_ANDROID_CLIENT_ID if the app's client changes.
const CLIENT_ID = process.env.GOOGLE_ANDROID_CLIENT_ID
  || '766739048614-4af9ehee2qnrfj6suf1khehfoun7628v.apps.googleusercontent.com';

let cache = { token: null, exp: 0 };

async function storedRefreshToken() {
  const { rows } = await query('SELECT refresh_token FROM google_tokens WHERE id = 1');
  return (rows[0] && rows[0].refresh_token) || null;
}

// True once the app has sent up a refresh token.
async function googleLinked() {
  return (await storedRefreshToken()) != null;
}

async function accessToken() {
  if (cache.token && Date.now() < cache.exp - 60000) return cache.token;
  const rt = await storedRefreshToken();
  if (!rt) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: rt }),
  });
  if (!res.ok) {
    const t = (await res.text()).slice(0, 160);
    // invalid_grant = the stored refresh token was revoked or expired (an OAuth
    // app still in "Testing" mode expires them after 7 days). Only a fresh
    // connect from the app fixes that — say so instead of a raw 400.
    if (/invalid_grant/.test(t)) throw new Error('Google sign-in expired or was revoked — reconnect Google in the app (Settings → GOOGLE) with the backend linked');
    throw new Error(`google token ${res.status}: ${t}`);
  }
  const d = await res.json();
  cache = { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return cache.token;
}

// { linked, ok, error } — whether Google actually works right now, not just
// whether a token is stored. A failed check is cached briefly so a persona
// turn doesn't re-hit the token endpoint on every message while it's broken.
let statusCache = { at: 0, value: null };
async function googleStatus() {
  if (statusCache.value && !statusCache.value.ok && Date.now() - statusCache.at < 120000) return statusCache.value;
  let value;
  try {
    const linked = await googleLinked();
    if (!linked) value = { linked: false, ok: false, error: 'no Google account linked to the backend' };
    else { await accessToken(); value = { linked: true, ok: true, error: null }; }
  } catch (e) {
    value = { linked: true, ok: false, error: e.message };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

async function gapi(path, { query: q, raw = false, method = 'GET', json, body, headers } = {}) {
  const token = await accessToken();
  if (!token) throw new Error('google not linked');
  const url = new URL(path.startsWith('http') ? path : `https://www.googleapis.com${path}`);
  if (q) {
    for (const [k, v] of Object.entries(q)) {
      if (v == null) continue;
      for (const x of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(x));
    }
  }
  const h = { Authorization: `Bearer ${token}`, ...(headers || {}) };
  let payload = body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
  const res = await fetch(url, { method, headers: h, body: payload });
  if (!res.ok) throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 160)}`);
  if (res.status === 204) return null;
  if (raw) return res.text();
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Notes are .md files (so an Obsidian vault can read them), created straight
// into My Drive; [MOVE_NOTE] files them into folders on request.
const mdName = (t) => (/\.md$/i.test(t) ? t : `${String(t || '').trim()}.md`);
const baseName = (n) => String(n || '').replace(/\.md$/i, '').trim();

// Create-or-update a Drive note by title — write the first time, edit in place
// after. Mirrors the app's [SAVE_NOTE] path. Returns { name, id, created, link }.
// Only ever touches a NOTE (markdown / text / Google Doc) — the old loose "name
// contains" match could land on a folder or a Sheet with the same name and the
// write failed; a Google Doc is written as plain text (Drive converts it), since
// pushing text/markdown into a Doc is refused. New notes go straight into My
// Drive — no folder; he files them where he wants with [MOVE_NOTE].
const qEsc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const DOC_MIME = 'application/vnd.google-apps.document';
async function saveDriveNote(title, content) {
  if (!(await googleLinked())) throw new Error('google not linked');
  const clean = baseName(title);
  if (!clean) throw new Error('a note needs a title');
  const list = await gapi('/drive/v3/files', {
    query: {
      q: `trashed=false and ${NOTE_MIME_Q} and name contains '${qEsc(clean)}'`,
      pageSize: 20, fields: 'files(id,name,mimeType,parents,webViewLink)',
    },
  });
  const want = clean.toLowerCase();
  const exact = ((list && list.files) || []).filter((f) => baseName(f.name).toLowerCase() === want);
  const hit = exact[0];
  if (hit) {
    await gapi(`/upload/drive/v3/files/${hit.id}`, {
      method: 'PATCH', query: { uploadType: 'media' },
      headers: { 'Content-Type': hit.mimeType === DOC_MIME ? 'text/plain; charset=UTF-8' : 'text/markdown; charset=UTF-8' }, body: content || '',
    });
    return { name: hit.name, id: hit.id, created: false, link: hit.webViewLink || null };
  }
  const meta = { name: mdName(clean), mimeType: 'text/markdown' };
  const boundary = 'empireos' + Math.random().toString(36).slice(2);
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content || ''}\r\n--${boundary}--`;
  const made = await gapi('/upload/drive/v3/files', {
    method: 'POST', query: { uploadType: 'multipart', fields: 'id,name,webViewLink' },
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  });
  if (!made || !made.id) throw new Error('Drive accepted the upload but returned no file');
  return { name: made.name, id: made.id, created: true, link: made.webViewLink || null };
}

// [MOVE_NOTE: note | folder] — file a note into a Drive folder. "Business/Plans"
// walks nested folders, creating any that don't exist; a single name uses an
// existing folder of that name anywhere in Drive first; "My Drive" = the top.
// Mirrors driveMoveNote in src/services/googleClient.js.
const ROOT_WORDS = /^(my drive|root|home|top)$/i;
async function driveMoveNote(ref, folder) {
  const r = String(ref || '').trim();
  const file = /^[A-Za-z0-9_-]{20,}$/.test(r)
    ? await gapi(`/drive/v3/files/${encodeURIComponent(r)}`, { query: { fields: 'id,name,parents' } })
    : await (async () => {
      const list = await gapi('/drive/v3/files', { query: { q: `trashed=false and ${NOTE_MIME_Q} and name contains '${qEsc(baseName(r))}'`, pageSize: 20, fields: 'files(id,name,parents)' } });
      const files = (list && list.files) || [];
      return files.find((f) => baseName(f.name).toLowerCase() === baseName(r).toLowerCase()) || files[0] || null;
    })();
  if (!file) throw new Error(`no note named "${r}"`);
  const target = String(folder || '').trim();
  if (!target) throw new Error('move it where? give a folder name');
  const rootId = (await gapi('/drive/v3/files/root', { query: { fields: 'id' } })).id;
  let parent = rootId;
  const made = [];
  if (!ROOT_WORDS.test(target)) {
    const segs = target.split('/').map((s) => s.trim()).filter(Boolean);
    for (const seg of segs) {
      const folderQ = `trashed=false and mimeType='application/vnd.google-apps.folder' and name='${qEsc(seg)}'`;
      let hit = await gapi('/drive/v3/files', { query: { q: `${folderQ} and '${parent}' in parents`, pageSize: 1, fields: 'files(id)' } });
      let id = hit && hit.files && hit.files[0] && hit.files[0].id;
      if (!id && segs.length === 1) {
        hit = await gapi('/drive/v3/files', { query: { q: folderQ, pageSize: 1, fields: 'files(id)' } });
        id = hit && hit.files && hit.files[0] && hit.files[0].id;
      }
      if (!id) {
        id = (await gapi('/drive/v3/files', { method: 'POST', json: { name: seg, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }, query: { fields: 'id' } })).id;
        made.push(seg);
      }
      parent = id;
    }
  }
  const where = ROOT_WORDS.test(target) ? 'My Drive' : `"${target}"`;
  if ((file.parents || []).includes(parent)) return `Drive: "${baseName(file.name)}" is already in ${where}.`;
  const from = (file.parents || []).join(',');
  await gapi(`/drive/v3/files/${file.id}`, { method: 'PATCH', json: {}, query: { addParents: parent, ...(from ? { removeParents: from } : {}), fields: 'id' } });
  return `Drive: "${baseName(file.name)}" moved to ${ROOT_WORDS.test(target) ? 'My Drive' : `"${target}"`}${made.length ? ` (new folder${made.length > 1 ? 's' : ''}: ${made.join(', ')})` : ''}.`;
}

// Read a Drive note (a text/plain file or a Google Doc) by exact title, matching
// the app's driveFindByName: Drive's loose "contains" search, then prefer an
// exact case-insensitive title match. Returns { name, text } or null when the
// account isn't linked or no such note exists.
async function readDriveNote(title) {
  if (!(await googleLinked())) return null;
  const esc = String(title).replace(/'/g, "\\'");
  const list = await gapi('/drive/v3/files', {
    query: { q: `trashed=false and name contains '${esc}'`, pageSize: 5, fields: 'files(id,name,mimeType)' },
  });
  const files = (list && list.files) || [];
  const file = files.find((f) => baseName(f.name).toLowerCase() === baseName(title).toLowerCase()) || files[0];
  if (!file) return null;
  const raw = file.mimeType === 'application/vnd.google-apps.document'
    ? await gapi(`/drive/v3/files/${file.id}/export`, { query: { mimeType: 'text/plain' }, raw: true })
    : await gapi(`/drive/v3/files/${file.id}`, { query: { alt: 'media' }, raw: true });
  // The brief rides in every persona's context on every round — keep it sane.
  const CAP = Math.max(500, Math.min(20000, Number(process.env.COUNCIL_BRIEF_MAX_CHARS) || 8000));
  let text = (raw || '').trim();
  if (text.length > CAP) text = `${text.slice(0, CAP)}\n\n[brief truncated at ${CAP} chars]`;
  return { name: file.name, text };
}

// Send a plain-text email as the owner — used by the server-side S.C.O.U.T.
// outreach cron for cold opens + follow-ups. The stored refresh token already
// carries gmail.send (granted at OAuth time alongside drive/gmail.readonly/
// calendar/tasks — see src/services/googleAuth.js SCOPES), so no re-auth is
// needed for this to start working.
function utf8Bytes(str) {
  return Buffer.from(String(str || ''), 'utf8');
}
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function gmailSend({ to, subject, body }) {
  if (!(await googleLinked())) throw new Error('google not linked');
  const raw = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${utf8Bytes(subject || '').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    String(body || ''),
  ].join('\r\n');
  return gapi('/gmail/v1/users/me/messages/send', { method: 'POST', json: { raw: b64url(utf8Bytes(raw)) } });
}

// --- Everything else a persona can do with Google over Telegram --------------
// Server-side ports of src/services/googleClient.js — Gmail, Calendar, Drive,
// Sheets and Google Tasks — shaped as the same LLM-facing strings the app's
// googleCommands.js feeds back. Times are read and written in Mr. Burrus's zone
// (the server runs in UTC, so a bare "2026-06-01T14:00" must not be read as UTC).
const TZ = 'America/New_York';

// A wall-clock time in TZ ("2026-06-01T14:00", "2026-06-01") -> a real Date.
// Anything carrying its own offset / Z is taken as-is.
function zonedDate(str) {
  const s = String(str || '').trim();
  if (!s) return new Date(NaN);
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
  if (!m) return new Date(s);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const inTz = new Date(new Date(guess).toLocaleString('en-US', { timeZone: TZ }));
  const inUtc = new Date(new Date(guess).toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(guess + (inUtc - inTz));
}
const fmtWhen = (d, opts) => d.toLocaleString('en-US', { timeZone: TZ, ...opts });

// --- Gmail ---
const INBOX_Q = 'is:unread in:inbox';
async function gmailList({ q = INBOX_Q, max = 10 } = {}) {
  const list = await gapi('/gmail/v1/users/me/messages', { query: { q, maxResults: max } });
  const ids = ((list && list.messages) || []).map((m) => m.id);
  if (!ids.length) return q === INBOX_Q ? 'Inbox: no unread messages.' : `Gmail: nothing matches "${q}".`;
  const rows = [];
  for (const id of ids) {
    try {
      const m = await gapi(`/gmail/v1/users/me/messages/${id}`, { query: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] } });
      const hdr = {};
      for (const x of (m.payload && m.payload.headers) || []) hdr[x.name.toLowerCase()] = x.value;
      rows.push(`• ${hdr.from || '?'} — ${hdr.subject || '(no subject)'}${hdr.date ? ` (${hdr.date})` : ''}\n  ${(m.snippet || '').slice(0, 150)}  [id:${id}]`);
    } catch {}
  }
  return `${q === INBOX_Q ? `Inbox — ${rows.length} unread` : `Gmail "${q}" — ${rows.length}`}:\n${rows.join('\n')}`;
}

function gmailBodyText(payload) {
  if (!payload) return '';
  const dec = (d) => Buffer.from(String(d || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) return dec(payload.body.data);
  for (const part of payload.parts || []) {
    const t = gmailBodyText(part);
    if (t) return t;
  }
  if (payload.mimeType === 'text/html' && payload.body && payload.body.data) {
    return dec(payload.body.data).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s{2,}/g, ' ');
  }
  return '';
}

async function gmailRead(id) {
  if (!id) throw new Error('no message id');
  const m = await gapi(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, { query: { format: 'full' } });
  const hdr = {};
  for (const x of (m.payload && m.payload.headers) || []) hdr[x.name.toLowerCase()] = x.value;
  const body = gmailBodyText(m.payload).trim().slice(0, 8000);
  return `Email [id:${id}]\nFrom: ${hdr.from || '?'}\nTo: ${hdr.to || '?'}\nDate: ${hdr.date || '?'}\nSubject: ${hdr.subject || '(no subject)'}\n\n${body || m.snippet || '(no text body)'}`;
}

// --- Calendar ---
async function calendarList({ startISO, days = 7 } = {}) {
  const start = startISO ? zonedDate(startISO) : new Date();
  if (isNaN(start)) throw new Error(`bad start date: ${startISO}`);
  const end = new Date(start.getTime() + days * 86400000);
  const data = await gapi('/calendar/v3/calendars/primary/events', {
    query: { timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: 25 },
  });
  const items = (data && data.items) || [];
  if (!items.length) return `Calendar: nothing scheduled in the next ${days} days.`;
  return `Calendar (next ${days} days):\n` + items.map((e) => {
    const allDay = !(e.start && e.start.dateTime);
    const when = allDay
      ? `${new Date(`${e.start.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} (all day)`
      : fmtWhen(new Date(e.start.dateTime), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `• ${when} — ${e.summary || '(no title)'}${e.location ? ` @ ${e.location}` : ''}  [id:${e.id}]`;
  }).join('\n');
}

// His "today" in Eastern time, for parseWhen.
function todayParts() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' })
    .formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
const pad2 = (n) => String(n).padStart(2, '0');
// Whatever the persona wrote -> { start: Date, allDay, date: 'YYYY-MM-DD' }.
// A string carrying its own offset is taken as-is; anything else is read in his time.
function resolveWhen(text) {
  const s = String(text || '').trim();
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return { start: new Date(s), allDay: false };
  const w = require('./when').parseWhen(s, todayParts());
  if (!w) throw new Error(`couldn't read "${s}" as a date/time — use e.g. 2026-11-06T15:00 or "Friday 3pm"`);
  const date = `${w.y}-${pad2(w.m)}-${pad2(w.d)}`;
  if (w.allDay) return { start: zonedDate(date), allDay: true, date };
  return { start: zonedDate(`${date}T${pad2(w.hh)}:${pad2(w.mm)}`), allDay: false, date };
}

async function calendarCreate({ title, startISO, minutes = 60, location, notes }) {
  if (!title || !startISO) throw new Error('need a title and a start time');
  const w = resolveWhen(startISO);
  if (isNaN(w.start)) throw new Error(`bad start time: ${startISO}`);
  const ev = { summary: title };
  if (location) ev.location = location;
  if (notes) ev.description = notes;
  if (w.allDay) {
    const next = new Date(Date.parse(`${w.date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    ev.start = { date: w.date };
    ev.end = { date: next };
  } else {
    const end = new Date(w.start.getTime() + (minutes || 60) * 60000);
    ev.start = { dateTime: w.start.toISOString(), timeZone: TZ };
    ev.end = { dateTime: end.toISOString(), timeZone: TZ };
  }
  const made = await gapi('/calendar/v3/calendars/primary/events', { method: 'POST', json: ev });
  const when = w.allDay
    ? `${new Date(`${w.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} (all day)`
    : fmtWhen(w.start, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `Calendar: "${title}" set for ${when}${minutes && !w.allDay && minutes !== 60 ? `, ${minutes} min` : ''}${made && made.htmlLink ? ` — [open](${made.htmlLink})` : ''}.`;
}

// Find an event by id, or by title among the next 60 days (and the past 7).
async function calendarFind(ref) {
  const r = String(ref || '').trim();
  if (!r) throw new Error('which event? give its id or title');
  if (/^[a-z0-9_]{10,}$/i.test(r) && !/\s/.test(r)) {
    try { return await gapi(`/calendar/v3/calendars/primary/events/${encodeURIComponent(r)}`); } catch { /* not an id — search by title */ }
  }
  const data = await gapi('/calendar/v3/calendars/primary/events', {
    query: { q: r, timeMin: new Date(Date.now() - 7 * 86400000).toISOString(), timeMax: new Date(Date.now() + 60 * 86400000).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: 10 },
  });
  const items = (data && data.items) || [];
  const want = r.toLowerCase();
  const hit = items.find((e) => String(e.summary || '').toLowerCase() === want)
    || items.find((e) => new Date(e.end?.dateTime || e.end?.date || 0) >= new Date() && String(e.summary || '').toLowerCase().includes(want))
    || items[0];
  if (!hit) throw new Error(`no event matching "${r}" in the next 60 days`);
  return hit;
}

// Edit an event in place. `changes`: title, start ("2026-11-05T15:00" Eastern,
// or a bare date for all-day), minutes (length; kept when only start moves),
// location, notes (description).
async function calendarUpdate(ref, changes = {}) {
  const ev = await calendarFind(ref);
  const patch = {};
  if (changes.title) patch.summary = changes.title;
  if (changes.location != null) patch.location = changes.location;
  if (changes.notes != null) patch.description = changes.notes;
  const wasAllDay = !(ev.start && ev.start.dateTime);
  const oldStart = wasAllDay ? zonedDate(ev.start.date) : new Date(ev.start.dateTime);
  const oldEnd = wasAllDay ? zonedDate(ev.end.date) : new Date(ev.end.dateTime);
  const oldMin = Math.max(15, Math.round((oldEnd - oldStart) / 60000));
  if (changes.start || changes.minutes) {
    const w = changes.start ? resolveWhen(changes.start) : null;
    if (w && w.allDay) {
      const days = wasAllDay ? Math.max(1, Math.round((oldEnd - oldStart) / 86400000)) : 1;
      patch.start = { date: w.date, dateTime: null };
      patch.end = { date: new Date(Date.parse(`${w.date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10), dateTime: null };
    } else {
      const start = w ? w.start : oldStart;
      if (isNaN(start)) throw new Error(`bad start time: ${changes.start}`);
      const mins = parseInt(changes.minutes, 10) || (wasAllDay ? 60 : oldMin);
      patch.start = { dateTime: start.toISOString(), timeZone: TZ, date: null };
      patch.end = { dateTime: new Date(start.getTime() + mins * 60000).toISOString(), timeZone: TZ, date: null };
    }
  }
  if (!Object.keys(patch).length) throw new Error('nothing to change — give title=, start=, minutes=, location= or notes=');
  const out = await gapi(`/calendar/v3/calendars/primary/events/${encodeURIComponent(ev.id)}`, { method: 'PATCH', json: patch });
  const s2 = out.start && out.start.dateTime
    ? fmtWhen(new Date(out.start.dateTime), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : `${out.start && out.start.date} (all day)`;
  return `Calendar: "${out.summary || ev.summary}" updated — now ${s2}${out.location ? ` @ ${out.location}` : ''}.`;
}

async function calendarDelete(eventId) {
  if (!eventId) throw new Error('no event id');
  await gapi(`/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
  return 'Calendar: event deleted.';
}

// --- Drive ---
const NOTE_MIME_Q = "(mimeType='text/plain' or mimeType='text/markdown' or mimeType='application/vnd.google-apps.document')";

const noteDate = (f) => (f.modifiedTime ? String(f.modifiedTime).slice(0, 10) : '');

// arg: a count ("50"), or a start date ("2026-07-01" / "since 2026-07-01") for
// every note modified from then on — newest first, each with its date, so a
// persona can tell how far back a listing actually reaches.
async function driveList(arg = 30) {
  const since = String(arg || '').match(/(\d{4}-\d{2}-\d{2})/);
  const max = since ? 300 : Math.max(1, Math.min(300, parseInt(arg, 10) || 30));
  const q = `trashed=false and ${NOTE_MIME_Q}` + (since ? ` and modifiedTime >= '${since[1]}T00:00:00'` : '');
  const data = await gapi('/drive/v3/files', {
    query: { q, orderBy: 'modifiedTime desc', pageSize: max, fields: 'files(id,name,modifiedTime)' },
  });
  const files = (data && data.files) || [];
  if (!files.length) return since ? `Drive: no notes modified since ${since[1]}.` : 'Drive: no notes found.';
  const span = `${noteDate(files[files.length - 1])} → ${noteDate(files[0])}`;
  const more = files.length >= max ? ` — only the ${max} newest; older notes exist: [LIST_NOTES: 200] lists more, [LIST_NOTES: 2026-06-01] everything since a date, [SEARCH_DRIVE: keyword] searches all of Drive` : '';
  return `Drive notes (${files.length}, modified ${span}${more}):\n` + files.map((f) => `• ${noteDate(f)}  ${f.name}  [id:${f.id}]`).join('\n');
}

async function driveSearch(kw) {
  if (!kw) throw new Error('no search term');
  const esc = String(kw).replace(/'/g, "\\'");
  const data = await gapi('/drive/v3/files', {
    query: { q: `trashed=false and (name contains '${esc}' or fullText contains '${esc}')`, pageSize: 40, fields: 'files(id,name,modifiedTime)' },
  });
  const files = (data && data.files) || [];
  if (!files.length) return `Drive: nothing matches "${kw}".`;
  return `Drive matches for "${kw}":\n` + files.map((f) => `• ${noteDate(f)}  ${f.name}  [id:${f.id}]`).join('\n');
}

async function driveFindByName(name) {
  const clean = baseName(name);
  const esc = clean.replace(/'/g, "\\'");
  const data = await gapi('/drive/v3/files', {
    query: { q: `trashed=false and name contains '${esc}'`, pageSize: 10, fields: 'files(id,name,mimeType)' },
  });
  const files = (data && data.files) || [];
  return files.find((f) => baseName(f.name).toLowerCase() === clean.toLowerCase()) || files[0] || null;
}

// Long documents come back a page at a time, same contract as the app's sliceDoc.
const PAGE_CHARS = 16000;
const ALL_CAP = 60000;
function sliceDoc(header, full, page, ref) {
  const total = full.length;
  if (String(page).toLowerCase() === 'all') {
    const tail = total > ALL_CAP ? `\n\n[--- truncated at ${ALL_CAP} of ${total} chars ---]` : '';
    return `${header} — full document, ${total} chars:\n${full.slice(0, ALL_CAP)}${tail}`;
  }
  const p = Math.max(1, parseInt(page, 10) || 1);
  const start = (p - 1) * PAGE_CHARS;
  const pages = Math.max(1, Math.ceil(total / PAGE_CHARS));
  if (start >= total && total > 0) return `${header} — page ${p} is past the end (${pages} page(s)).`;
  const body = full.slice(start, start + PAGE_CHARS);
  const remaining = Math.max(0, total - (start + body.length));
  const foot = pages > 1
    ? (remaining > 0
      ? `\n\n[--- page ${p}/${pages}, ${remaining} chars remain. Re-issue the read for "${ref}" with " | ${p + 1}" for the next page, or " | all". ---]`
      : `\n\n[--- page ${p}/${pages} — end of document ---]`)
    : '';
  return `${header}${pages > 1 ? ` — page ${p}/${pages}` : ''}:\n${body}${foot}`;
}

// A Drive file's metadata by id.
async function driveFile(fileId) {
  return gapi(`/drive/v3/files/${encodeURIComponent(fileId)}`, { query: { fields: 'id,name,mimeType' } });
}

// A Drive file's full text (plain/markdown file, or a Google Doc exported).
async function driveRawText(file) {
  const text = file.mimeType === 'application/vnd.google-apps.document'
    ? await gapi(`/drive/v3/files/${file.id}/export`, { query: { mimeType: 'text/plain' }, raw: true })
    : await gapi(`/drive/v3/files/${file.id}`, { query: { alt: 'media' }, raw: true });
  return String(text || '');
}

async function driveRead({ name, fileId, page = 1 }) {
  let file;
  if (fileId) file = await gapi(`/drive/v3/files/${encodeURIComponent(fileId)}`, { query: { fields: 'id,name,mimeType' } });
  else if (name) {
    file = await driveFindByName(name);
    if (!file) throw new Error(`no Drive note named "${name}"`);
  } else throw new Error('need a note name or file id');
  const text = file.mimeType === 'application/vnd.google-apps.document'
    ? await gapi(`/drive/v3/files/${file.id}/export`, { query: { mimeType: 'text/plain' }, raw: true })
    : await gapi(`/drive/v3/files/${file.id}`, { query: { alt: 'media' }, raw: true });
  return sliceDoc(`Note "${file.name}" [id:${file.id}]`, text || '', page, name || file.name);
}

async function driveUpdate({ fileId, content }) {
  if (!fileId) throw new Error('no file id');
  await gapi(`/upload/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH', query: { uploadType: 'media' }, headers: { 'Content-Type': 'text/markdown' }, body: content || '',
  });
  return 'Drive: note updated.';
}

// Trash rather than hard-delete — recoverable from Drive's bin for 30 days.
async function driveTrash(fileId) {
  if (!fileId) throw new Error('no file id');
  await gapi(`/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'PATCH', json: { trashed: true } });
  return 'Drive: file moved to trash.';
}

// --- Sheets (the drive scope covers the Sheets API) ---
async function sheetCreate({ title, columns = [], values = [] }) {
  const ss = await gapi('https://sheets.googleapis.com/v4/spreadsheets', { method: 'POST', json: { properties: { title: title || 'Untitled' } } });
  const rows = [];
  if (columns.length) rows.push(columns);
  if (values.length) rows.push(values);
  if (rows.length) {
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${ss.spreadsheetId}/values/A1:append`, {
      method: 'POST', query: { valueInputOption: 'USER_ENTERED' }, json: { values: rows },
    });
  }
  return `Sheets: "${title}" created — ${ss.spreadsheetUrl}`;
}

// --- Google Tasks ---
async function gTasksList() {
  const data = await gapi('/tasks/v1/lists/@default/tasks', { query: { showCompleted: 'false', maxResults: 100 } });
  const items = ((data && data.items) || []).filter((t) => t.status !== 'completed');
  if (!items.length) return 'Google Tasks: none open.';
  return 'Google Tasks:\n' + items.map((t) => `• ${t.title}${t.due ? ` (due ${t.due.slice(0, 10)})` : ''}`).join('\n');
}
async function findGTask(title) {
  const data = await gapi('/tasks/v1/lists/@default/tasks', { query: { showCompleted: 'false', maxResults: 100 } });
  const q = String(title || '').toLowerCase();
  return ((data && data.items) || []).find((t) => (t.title || '').toLowerCase().includes(q)) || null;
}
async function gTaskCreate({ title, notes, due }) {
  if (!title) throw new Error('no title');
  const json = { title };
  if (notes) json.notes = notes;
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) json.due = `${due}T00:00:00.000Z`;
  await gapi('/tasks/v1/lists/@default/tasks', { method: 'POST', json });
  return `Google Tasks: "${title}" added.`;
}
// Title-matched; null when nothing open matches.
async function gTaskComplete(title) {
  const t = await findGTask(title);
  if (!t) return null;
  await gapi(`/tasks/v1/lists/@default/tasks/${t.id}`, { method: 'PATCH', json: { status: 'completed' } });
  return `Google Tasks: "${t.title}" done.`;
}
async function gTaskDelete(title) {
  const t = await findGTask(title);
  if (!t) return null;
  await gapi(`/tasks/v1/lists/@default/tasks/${t.id}`, { method: 'DELETE' });
  return `Google Tasks: "${t.title}" deleted.`;
}

module.exports = {
  calendarFind, calendarUpdate, driveMoveNote,
  accessToken, googleLinked, googleStatus, readDriveNote, saveDriveNote, gmailSend,
  gmailList, gmailRead, calendarList, calendarCreate, calendarDelete,
  driveList, driveSearch, driveRead, driveFindByName, driveFile, driveRawText, driveUpdate, driveTrash, sheetCreate,
  gTasksList, gTaskCreate, gTaskComplete, gTaskDelete, zonedDate,
};
