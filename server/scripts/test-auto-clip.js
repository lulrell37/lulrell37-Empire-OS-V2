// node server/scripts/test-auto-clip.js — R.O.G.U.E.'s auto clips: reading a
// channel's feed and deciding what's new (no network).
const assert = require('assert');
const A = require('../autoClip');

const entry = (id, title, iso, link) => `<entry><yt:videoId>${id}</yt:videoId><title>${title}</title><link rel="alternate" href="${link || `https://www.youtube.com/watch?v=${id}`}"/><published>${iso}</published></entry>`;
const xml = `<feed>${entry('aaaaaaaaaaa', 'Old one', '2026-11-10T10:00:00+00:00')}${entry('bbbbbbbbbbb', 'Kai &amp; Speed GTA', '2026-11-19T20:00:00+00:00')}${entry('ccccccccccc', 'a short', '2026-11-19T21:00:00+00:00', 'https://www.youtube.com/shorts/ccccccccccc')}</feed>`;
const feed = A.parseFeed(xml);
assert.deepStrictEqual(feed.map((v) => v.id), ['ccccccccccc', 'bbbbbbbbbbb', 'aaaaaaaaaaa'], 'newest first');
assert.strictEqual(feed[1].title, 'Kai & Speed GTA');
assert.strictEqual(feed[0].short, true);

const ch = { id: 'UCx', since: Date.parse('2026-11-15T00:00:00Z') };
const s = { queue: [], done: [] };
assert.deepStrictEqual(A.newUploads(feed, ch, s).map((v) => v.id), ['bbbbbbbbbbb'], 'only uploads after the mark, Shorts skipped');
assert.deepStrictEqual(A.newUploads(feed, ch, { queue: [{ id: 'bbbbbbbbbbb' }], done: [] }), [], 'not queued twice');
assert.deepStrictEqual(A.newUploads(feed, ch, { queue: [], done: [{ id: 'bbbbbbbbbbb' }] }), [], 'not clipped twice');
assert.ok(/\[AUTO_CLIP:/.test(A.AUTO_CLIP_TOOLS));
// topic filter
assert.deepStrictEqual(A.splitArg('https://youtube.com/@kai | GTA'), { link: 'https://youtube.com/@kai', topic: 'GTA' });
assert.deepStrictEqual(A.splitArg('https://youtube.com/@kai'), { link: 'https://youtube.com/@kai', topic: '' });
assert.deepStrictEqual(A.topicTerms('any'), []);
assert.ok(A.matchesTopic('', { title: 'anything' }), 'no topic = everything');
assert.ok(A.matchesTopic('GTA', { title: 'GTA 5 RP with Speed' }));
assert.ok(A.matchesTopic('GTA', { title: 'Heists', tags: ['Grand Theft Auto V'] }), 'alias in tags');
assert.ok(A.matchesTopic('GTA', { title: 'Ranked lobby', tags: ['gta', 'funny'] }));
assert.ok(!A.matchesTopic('GTA', { title: 'Minecraft hardcore', tags: ['minecraft'] }), 'other game skipped');
assert.ok(!A.matchesTopic('GTA', { title: 'Gtalking about food' }), 'whole words only');
assert.ok(A.matchesTopic('gta, fortnite', { title: 'Fortnite finals' }), 'any of several');
assert.ok(/AUTO_CLIP_TOPIC/.test(A.AUTO_CLIP_TOOLS));
const C = require('../clipScan');
assert.ok(C.isBotCheck('yt-dlp: ERROR: [youtube] KAgxDihEu4M: Sign in to confirm you’re not a bot. This helps protect our community.'));
assert.ok(!C.isBotCheck('yt-dlp: ERROR: Video unavailable'));
delete process.env.YOUTUBE_COOKIES; delete process.env.YOUTUBE_COOKIES_FILE;
assert.deepStrictEqual(C.cookieArgs('https://www.youtube.com/watch?v=KAgxDihEu4M'), [], 'no cookies set, none passed');
process.env.YOUTUBE_COOKIES_FILE = '/tmp/yt.txt';
assert.deepStrictEqual(C.cookieArgs('https://www.youtube.com/watch?v=KAgxDihEu4M'), ['--cookies', '/tmp/yt.txt']);
assert.deepStrictEqual(C.cookieArgs('https://www.youtube.com/@FanumLive/videos'), ['--cookies', '/tmp/yt.txt'], 'channel lookups too');
assert.deepStrictEqual(C.cookieArgs('https://www.tiktok.com/@x/video/123'), [], 'YouTube cookies stay on YouTube');
delete process.env.YOUTUBE_COOKIES_FILE;
console.log('auto clip: all checks passed');
