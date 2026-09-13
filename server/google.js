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
  if (!res.ok) throw new Error(`google token ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const d = await res.json();
  cache = { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return cache.token;
}

async function gapi(path, { query: q, raw = false, method = 'GET', json, body, headers } = {}) {
  const token = await accessToken();
  if (!token) throw new Error('google not linked');
  const url = new URL(`https://www.googleapis.com${path}`);
  if (q) for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
  const h = { Authorization: `Bearer ${token}`, ...(headers || {}) };
  let payload = body;
  if (json !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(json); }
  const res = await fetch(url, { method, headers: h, body: payload });
  if (!res.ok) throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return raw ? res.text() : res.json();
}

// Notes live as .md files in a Drive folder called "Empire OS Notes" (so an
// Obsidian vault can sync to them) — same convention as the app's googleClient.
const NOTES_FOLDER = 'Empire OS Notes';
const mdName = (t) => (/\.md$/i.test(t) ? t : `${String(t || '').trim()}.md`);
const baseName = (n) => String(n || '').replace(/\.md$/i, '').trim();

async function notesFolderId() {
  const found = await gapi('/drive/v3/files', {
    query: {
      q: `trashed=false and mimeType='application/vnd.google-apps.folder' and name='${NOTES_FOLDER}'`,
      pageSize: 1, fields: 'files(id)',
    },
  });
  if (found.files && found.files[0]) return found.files[0].id;
  const made = await gapi('/drive/v3/files', {
    method: 'POST', json: { name: NOTES_FOLDER, mimeType: 'application/vnd.google-apps.folder' },
    query: { fields: 'id' },
  });
  return made.id;
}

// Create-or-update a Drive note by title — write the first time, edit in place
// after. Mirrors the app's [SAVE_NOTE] path. Returns { name, id, created }.
async function saveDriveNote(title, content) {
  if (!(await googleLinked())) throw new Error('google not linked');
  const clean = baseName(title);
  const esc = clean.replace(/'/g, "\\'");
  const list = await gapi('/drive/v3/files', {
    query: { q: `trashed=false and name contains '${esc}'`, pageSize: 10, fields: 'files(id,name,mimeType)' },
  });
  const want = clean.toLowerCase();
  const hit = ((list && list.files) || []).find((f) => baseName(f.name).toLowerCase() === want);
  if (hit) {
    await gapi(`/upload/drive/v3/files/${hit.id}`, {
      method: 'PATCH', query: { uploadType: 'media' },
      headers: { 'Content-Type': 'text/markdown' }, body: content || '',
    });
    return { name: hit.name, id: hit.id, created: false };
  }
  const folder = await notesFolderId().catch(() => null);
  const meta = { name: mdName(clean), mimeType: 'text/markdown' };
  if (folder) meta.parents = [folder];
  const boundary = 'empireos' + Math.random().toString(36).slice(2);
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: text/markdown\r\n\r\n${content || ''}\r\n--${boundary}--`;
  const made = await gapi('/upload/drive/v3/files', {
    method: 'POST', query: { uploadType: 'multipart', fields: 'id,name' },
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  });
  return { name: made.name, id: made.id, created: true };
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
  const file = files.find((f) => f.name.toLowerCase() === String(title).toLowerCase()) || files[0];
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

module.exports = { accessToken, googleLinked, readDriveNote, saveDriveNote, gmailSend };
