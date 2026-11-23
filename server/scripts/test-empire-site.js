// node server/scripts/test-empire-site.js — his website (site/empire): every link
// between pages lands on a page, every media file a page uses is in the release list
// (site/empire/media.json), and the form endpoint takes good input and refuses bad.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..', '..', 'site', 'empire');
const media = JSON.parse(fs.readFileSync(path.join(ROOT, 'media.json'), 'utf8'));
const pages = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
assert.ok(pages.length >= 30, 'the pages are there');
for (const f of pages) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const [, href] of html.matchAll(/href="([^"#]+)"/g)) {
    if (/^(https?:|tel:|mailto:|\/\/)/.test(href) || /fonts\.g/.test(href) || /^media\/|\.css$/.test(href)) continue;
    const target = href === './' ? 'index.html' : href;
    assert.ok(fs.existsSync(path.join(ROOT, target)), `${f} links to ${href}, which isn't a page`);
  }
  for (const [, m] of html.matchAll(/media\/([A-Za-z0-9_.-]+)/g)) assert.ok(media[m], `${f} uses media/${m}, which isn't in media.json (upload it to the release)`);
  assert.ok(html.includes('id="formdlg"') && html.includes('app.js'), `${f} has the form`);
}
const sent = [];
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === '../syncStore') return { upsertSyncRow: async (t, id, d) => { sent.push({ t, d }); }, newId: () => 'x' };
  if (req === '../telegram') return { OWNER_ID: 1, botFor: () => ({ isConfigured: () => true, sendMessage: async (c, t) => { sent.push({ t }); } }) };
  return load.call(this, req, parent, ...rest);
};
const { router, SAFE } = require('../routes/empireSite');
assert.ok(SAFE.test('MAG_nndPcYQ.webp') && !SAFE.test('../x.webp') && !SAFE.test('a.html'));
const express = require('express');
const app = express();
app.use('/empire', router);
const srv = app.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}/empire`;
  const post = (b) => fetch(`${base}/api/form`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    let r = await fetch(`${base}/motivation`); assert.strictEqual(r.status, 200);
    r = await fetch(base, { redirect: 'manual' }); assert.strictEqual(r.status, 301);
    r = await post({ kind: 'contact', topic: 'RSVP — Financial Literacy', name: 'Jay', phone: '240-555-0100', message: 'Two seats' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(sent[0].t, 'site_leads');
    assert.match(sent[1].t, /RSVP — Financial Literacy[\s\S]*Jay[\s\S]*240-555-0100[\s\S]*Two seats/);
    assert.strictEqual((await post({ kind: 'contact', name: 'No way to reach' })).status, 400);
    assert.strictEqual((await post({ kind: 'newsletter', email: 'bad' })).status, 400);
    const n = sent.length;
    assert.strictEqual((await post({ kind: 'contact', name: 'bot', email: 'b@x.co', website: 'spam' })).status, 200);
    assert.strictEqual(sent.length, n, 'the hidden field drops bots quietly');
    for (let i = 0; i < 6; i++) await post({ kind: 'newsletter', email: `a${i}@x.co` });
    assert.strictEqual((await post({ kind: 'newsletter', email: 'z@x.co' })).status, 429, 'rate limited');
    console.log('empire site: all checks passed');
    srv.close(); process.exit(0);
  } catch (e) { console.error(e); srv.close(); process.exit(1); }
});
