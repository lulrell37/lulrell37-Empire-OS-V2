// node server/scripts/test-site-desk.js — the website desk's pure parts: reading
// an old site, picking the email, ranking Google Maps results, finishing and
// checking a page (no network, no database).
const assert = require('assert');
const path = require('path');
const stub = (rel, exports) => { const f = require.resolve(path.join(__dirname, '..', rel)); require.cache[f] = { id: f, filename: f, loaded: true, exports }; };
stub('db.js', { query: async () => ({ rows: [] }), pool: null, init: async () => {} });
stub('llm.js', { claudeText: async () => '', webResearch: async () => '', CLAUDE_MODEL: 'test' });
const D = require('../siteDesk');

const old = D.readOldSite(`<html><head><title>Joe's Cuts | Barber</title><meta name="description" content="Fresh cuts in Waldorf">
<meta property="og:image" content="/img/shop.jpg"><style>.a{color:#B8860B}.b{color:#b8860b}.c{background:#222222}</style></head>
<body><img src="/img/logo.png" alt="Joe's logo"><img data-src="https://cdn.x.com/fade.jpg" alt="fade"><img src="/pixel.gif"><img src="icon.svg">
<a href="/about">About</a><a href="https://facebook.com/joescuts">FB</a><a href="mailto:joe@joescuts.com">Email</a>
<p>Walk-ins welcome. © 2014 Joe's Cuts</p><script>var x=1</script></body></html>`, 'https://www.joescuts.com/');
assert.strictEqual(old.title, "Joe's Cuts | Barber");
assert.strictEqual(old.description, 'Fresh cuts in Waldorf');
assert.deepStrictEqual(old.images.map((i) => i.url), ['https://www.joescuts.com/img/shop.jpg', 'https://www.joescuts.com/img/logo.png', 'https://cdn.x.com/fade.jpg'], 'real images only, made absolute');
assert.strictEqual(old.logo, 'https://www.joescuts.com/img/logo.png');
assert.strictEqual(old.colors[0], '#b8860b', 'most-used color first, case folded');
assert.strictEqual(old.email, 'joe@joescuts.com');
assert.strictEqual(old.copyrightYear, 2014);
assert.ok(old.links.includes('https://www.joescuts.com/about'));
assert.ok(!/var x/.test(old.text), 'scripts left out of the text');

assert.strictEqual(D.pickEmail('write info@sentry.io or noreply@shop.com or shop@gmail.com', ''), 'shop@gmail.com', 'junk and no-reply skipped');
assert.strictEqual(D.pickEmail('a@gmail.com b@bestplumbing.com', 'https://bestplumbing.com'), 'b@bestplumbing.com', 'own domain wins');
assert.strictEqual(D.pickEmail('nothing here', ''), '');

const ranked = D.rankCandidates([
  { name: 'Great Clips', ratings: 300, placeId: 'a' },
  { name: 'Old Site Barber', website: 'https://oldsite.com', ratings: 80, placeId: 'b' },
  { name: 'No Site Barber', ratings: 40, placeId: 'c' },
  { name: 'FB Only Barber', website: 'https://facebook.com/fbonly', ratings: 20, placeId: 'd' },
  { name: 'Brand New', ratings: 2, placeId: 'e' },
  { name: 'Done Already', ratings: 90, placeId: 'f' },
], ['donealready']);
assert.deepStrictEqual(ranked.map((b) => b.name), ['No Site Barber', 'FB Only Barber', 'Old Site Barber'], 'no site first; chains, tiny and done ones out');
assert.strictEqual(ranked[1].website, '', 'a Facebook page is not a website');

const page = D.finishHtml(`Here you go:\n<!doctype html><html><head><title>x</title></head><body><h1>Joe's Cuts</h1>
<img src="https://cdn.x.com/fade.jpg"><img src="https://stock.example.org/fake.jpg"><img src="GEN:barber chair close up">
<script src="https://evil.js"></script><form action="/x"><input></form><a href="tel:3015551234">Call</a></body></html>\nhope you like it`, { name: "Joe's Cuts", images: old.images });
assert.ok(page.startsWith('<!doctype html>') && page.endsWith('</html>'), 'chatter around the page cut off');
assert.ok(page.includes('name="robots" content="noindex'), 'never indexed');
assert.ok(page.includes('id="empire-preview"'), 'says it is a preview');
assert.ok(page.includes('https://cdn.x.com/fade.jpg'), 'their real image kept');
assert.ok(!page.includes('stock.example.org'), 'an image we did not give it is replaced');
assert.ok(!page.includes('GEN:') && page.includes('image.pollinations.ai/prompt/barber%20chair'), 'GEN: becomes a generated photo');
assert.ok(!page.includes('evil.js'), 'outside scripts removed');
assert.ok(page.includes('<form onsubmit="return false">'), 'forms post nowhere');
assert.throws(() => D.finishHtml('sorry, I could not', { name: 'x' }), /no complete HTML/);

const long = `<html><body>${"Joe's Cuts ".repeat(500)} call (301) 645-2210</body></html>`;
assert.deepStrictEqual(D.checkHtml(long, { name: "Joe's Cuts", phone: '(301) 645-2210' }), []);
assert.ok(D.checkHtml(long, { name: "Joe's Cuts", phone: '(240) 111-2222' }).some((b) => /phone/.test(b)), 'wrong phone caught');
assert.ok(D.checkHtml(`${long} lorem ipsum`, { name: "Joe's Cuts" }).some((b) => /placeholder/.test(b)));
assert.ok(D.checkHtml('<html>tiny</html>', { name: 'Tiny' }).some((b) => /short/.test(b)));
assert.ok(/^joe-s-cuts-[0-9a-f]{6}$/.test(D.slugFor("Joe's Cuts")));
for (const t of ['SITE_DESK', 'SITE_APPROVE', 'SITE_REVISE', 'SITE_DROP', 'SITE_OFFER']) assert.ok(D.SITE_TAGS.has(t) && D.SITE_TOOLS.includes(`[${t}`), t);
console.log('site desk: all checks passed');
