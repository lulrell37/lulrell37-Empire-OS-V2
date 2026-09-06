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

async function gapi(path, { query: q, raw = false } = {}) {
  const token = await accessToken();
  if (!token) throw new Error('google not linked');
  const url = new URL(`https://www.googleapis.com${path}`);
  if (q) for (const [k, v] of Object.entries(q)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`google ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return raw ? res.text() : res.json();
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

module.exports = { accessToken, googleLinked, readDriveNote };
