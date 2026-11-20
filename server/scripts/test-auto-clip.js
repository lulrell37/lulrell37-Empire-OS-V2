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
console.log('auto clip: all checks passed');
