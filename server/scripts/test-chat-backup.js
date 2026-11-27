// node server/scripts/test-chat-backup.js — nightly conversation backup (server/chatBackup.js).
const assert = require('assert');
const cb = require('../chatBackup');

const day = (iso, h) => Date.parse(`${iso}T${String(h).padStart(2, '0')}:00:00-05:00`);
const rows = [
  { id: 1, persona: 'ara', role: 'user', content: 'what time is dinner?', ts: day('2026-11-25', 9) },
  { id: 2, persona: 'ara', role: 'assistant', content: 'Six.', ts: day('2026-11-25', 9) + 1000 },
  { id: 3, persona: 'ara', role: 'assistant', content: '[SENT ON YOUR OWN, Wed 9:30 AM ET — not a reply to him]\n📈 T.A.L.O.N. opened', ts: day('2026-11-25', 10) },
  { id: 4, persona: 'talon', role: 'assistant', content: "[YOU SENT THIS TO MR. BURRUS THROUGH A.R.A., Wed — it's yours]\nGold", ts: day('2026-11-25', 11) },
  { id: 5, persona: 'jarvis', role: 'user', content: 'push it', ts: day('2026-11-26', 23) },
  { id: 6, persona: 'ara', role: 'user', content: 'today, not backed up yet', ts: day('2026-11-27', 8) },
];
let settings = {};
const uploads = {};
const db = { query: async (sql, p) => {
  if (/^SELECT persona, role, content, ts FROM tg_messages WHERE ts > \$1/.test(sql)) return { rows: rows.filter((r) => r.ts > p[0] && r.ts < p[1]) };
  if (/^SELECT 1 FROM tg_messages/.test(sql)) return { rows: rows.filter((r) => r.persona === p[0] && r.role === p[1] && r.ts === p[2] && r.content === p[3]) };
  if (/^INSERT/.test(sql)) { rows.push({ id: rows.length + 1, persona: p[0], role: p[1], content: p[2], ts: p[3] }); return { rows: [] }; }
  throw new Error(`unexpected sql ${sql}`);
} };
const google = {
  accessToken: async () => 'tok',
  gapi: async (path, { query: q = {}, method } = {}) => {
    if (path === '/drive/v3/files/root') return { id: 'root' };
    if (method === 'POST') return { id: 'folder' };
    if (/mimeType='application\/vnd.google-apps.folder'/.test(q.q || '')) return { files: [{ id: 'folder' }] };
    if (/name contains 'Conversations '/.test(q.q || '')) return { files: Object.keys(uploads).map((n) => ({ id: n, name: n })) };
    const m = (q.q || '').match(/name='([^']+)'/);
    return { files: m && uploads[m[1]] ? [{ id: m[1] }] : [] };
  },
};
const store = { getSetting: async (k) => settings[k] || null, setSetting: async (k, v) => { settings[k] = v; } };
cb._set({ db, google, store });
global.fetch = async (url, opts = {}) => {
  if (/alt=media/.test(url)) { const id = decodeURIComponent(url.match(/files\/([^?]+)/)[1]); return { ok: true, arrayBuffer: async () => uploads[id] }; }
  const body = opts.body;
  const name = JSON.parse(body.toString('utf8').split('\r\n\r\n')[1].split('\r\n')[0]).name;
  const start = body.indexOf(Buffer.from('application/gzip\r\n\r\n')) + 'application/gzip\r\n\r\n'.length;
  uploads[name] = body.slice(start, body.lastIndexOf(Buffer.from('\r\n--')));
  return { ok: true, json: async () => ({ id: name }) };
};

(async () => {
  assert.strictEqual(new Date(cb.startOfTodayET(Date.parse('2026-11-27T15:00:00Z'))).toISOString(), '2026-11-27T05:00:00.000Z');
  assert.strictEqual(new Date(cb.startOfTodayET(Date.parse('2026-07-04T15:00:00Z'))).toISOString(), '2026-07-04T04:00:00.000Z');

  const r = await cb.tick({ now: day('2026-11-27', 12) });
  assert.strictEqual(r.backedUp, 2);
  assert.deepStrictEqual(Object.keys(uploads).sort(), ['Conversations 2026-11-25.json.gz', 'Conversations 2026-11-26.json.gz']);
  const d25 = cb.unpack(uploads['Conversations 2026-11-25.json.gz']);
  assert.deepStrictEqual(d25.messages.map((m) => m.content), ['what time is dinner?', 'Six.'], 'alerts and passed-on messages left out');
  assert(!Object.keys(uploads).some((n) => n.includes('2026-11-27')), "today waits for tomorrow's run");

  assert.strictEqual((await cb.tick({ now: day('2026-11-27', 13) })).backedUp, 0, 'nothing twice');
  assert(/through 2026-11-26/.test(await cb.status()));

  rows.splice(0, 2); // lost
  const dry = await cb.restore({ dry: true });
  assert.strictEqual(dry.added, 2);
  const back = await cb.restore();
  assert.strictEqual(back.added, 2);
  assert.strictEqual((await cb.restore()).added, 0, 'safe to run twice');
  console.log('chat backup ok');
})().catch((e) => { console.error(e); process.exit(1); });
