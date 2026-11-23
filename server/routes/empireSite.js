// /empire — "Welcome to The Empire", Tarell's own website, rebuilt from his Canva
// design (owner, 2026-11-23; how it was built and how to change it: site/empire/README.md).
// Public. The pages are static files in site/empire. Media (his photos and videos,
// ~32 MB) lives in the GitHub release `empire-site-media`, not in the repo, so the
// server's tarball stays small: each file is fetched once into a disk cache and
// served from there (Range requests work, so the videos stream).
// POST /empire/api/form takes every "Contact me / Apply / RSVP / Reserve your seat"
// form and the newsletter sign-up: saved in the synced `site_leads` table and sent to
// him from A.R.A.'s bot right away (nothing dies in silence: if that fails, loud.tellAra).
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

const router = express.Router();
const ROOT = path.join(__dirname, '..', '..', 'site', 'empire');
const CACHE = () => process.env.EMPIRE_SITE_CACHE || path.join(os.homedir(), '.empire-bin', 'site-media');
const MEDIA_URL = () => process.env.EMPIRE_SITE_MEDIA_URL || 'https://github.com/lulrell37/lulrell37-Empire-OS-V2/releases/download/empire-site-media';
const SAFE = /^[A-Za-z0-9_-]{1,40}\.(webp|svg|mp4|png|jpg)$/;
const TYPES = { webp: 'image/webp', svg: 'image/svg+xml', mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg' };

const fetching = new Map();
async function ensureMedia(name) {
  const file = path.join(CACHE(), name);
  if (fs.existsSync(file)) return file;
  if (!fetching.has(name)) {
    fetching.set(name, (async () => {
      const r = await fetch(`${MEDIA_URL()}/${name}`, { redirect: 'follow' });
      if (!r.ok) throw new Error(`media ${name}: ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(CACHE(), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
      return file;
    })().finally(() => fetching.delete(name)));
  }
  return fetching.get(name);
}

// Fetch every file the pages use once, a few minutes after boot, so the first
// visitor isn't the one waiting on GitHub.
function prewarm() {
  let names = [];
  try {
    for (const f of fs.readdirSync(ROOT).filter((x) => x.endsWith('.html'))) {
      const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
      for (const m of html.matchAll(/media\/([A-Za-z0-9_-]+\.(?:webp|svg|mp4|png|jpg))/g)) names.push(m[1]);
    }
  } catch { return; }
  names = [...new Set(names)];
  (async () => {
    let failed = 0;
    for (const n of names) await ensureMedia(n).catch(() => { failed++; });
    if (failed) console.error(`empire site failed: ${failed} of ${names.length} media files couldn't be fetched from the release`);
  })();
}

router.get('/media/:name', async (req, res) => {
  const name = req.params.name;
  if (!SAFE.test(name)) return res.status(404).end();
  try {
    const file = await ensureMedia(name);
    res.set('Cache-Control', 'public, max-age=604800');
    res.type(TYPES[name.split('.').pop()]);
    res.sendFile(file);
  } catch (e) {
    console.error('empire site failed: media', e.message);
    res.status(404).end();
  }
});

// The forms.
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 6;
}
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

router.post('/api/form', express.json({ limit: '20kb' }), async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // the hidden field: a bot filled it
  if (limited(req.ip)) return res.status(429).json({ error: 'too many tries — wait a few minutes' });
  const kind = b.kind === 'newsletter' ? 'newsletter' : 'contact';
  const lead = {
    kind, topic: clip(b.topic, 160), name: clip(b.name, 120), email: clip(b.email, 160), phone: clip(b.phone, 40),
    message: clip(b.message, 3000), page: clip(b.page, 120), created_at: Date.now(),
  };
  if (lead.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) return res.status(400).json({ error: 'that email doesn\'t look right' });
  if (kind === 'newsletter' && !lead.email) return res.status(400).json({ error: 'an email is needed' });
  if (kind === 'contact' && !lead.name) return res.status(400).json({ error: 'a name is needed' });
  if (kind === 'contact' && !lead.email && !lead.phone) return res.status(400).json({ error: 'an email or phone is needed' });
  try {
    const { upsertSyncRow, newId } = require('../syncStore');
    await upsertSyncRow('site_leads', newId(), lead);
  } catch (e) {
    console.error('empire site failed: saving a form:', e.message);
  }
  const text = kind === 'newsletter'
    ? `📰 New newsletter sign-up on your Empire site: ${lead.email}`
    : `🏰 Someone filled out "${lead.topic || 'Contact me'}" on your Empire site:\n\nName: ${lead.name}${lead.email ? `\nEmail: ${lead.email}` : ''}${lead.phone ? `\nPhone: ${lead.phone}` : ''}${lead.message ? `\n\n"${lead.message}"` : ''}`;
  try {
    const tg = require('../telegram');
    const bot = tg.botFor('ara');
    if (!bot || !bot.isConfigured() || !tg.OWNER_ID) throw new Error('A.R.A.\'s bot isn\'t set up');
    await bot.sendMessage(tg.OWNER_ID, text); // sendMessage escapes it for Telegram
  } catch (e) {
    console.error('empire site failed: telling him about a form:', e.message);
    require('../loud').tellAra(`empire-form-${lead.created_at}`, text);
  }
  res.json({ ok: true });
});

router.get('/', (req, res, next) => {
  if (!req.originalUrl.endsWith('/') && !req.originalUrl.includes('?')) return res.redirect(301, `${req.originalUrl}/`);
  next();
});
router.use(express.static(ROOT, { extensions: ['html'], index: 'index.html', maxAge: '10m' }));

module.exports = { router, prewarm, ensureMedia, SAFE };
