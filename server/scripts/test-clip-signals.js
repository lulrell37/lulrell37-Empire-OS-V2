// node server/scripts/test-clip-signals.js — the clip scan's viewer signals
// (most-replayed peaks, comment timestamps, chat spikes, audio jumps, merging),
// on made-up data: nothing is downloaded.
const assert = require('assert');
const S = require('../clipSignals');

// Comments: timestamps inside the video, counted per 10 s, likes break ties.
assert.deepStrictEqual(S.commentTimestamps('4:32 I am dead 😂 and 1:02:05 too, 99:99 no, 3:00', 4000), [272, 3725, 180]);
assert.deepStrictEqual(S.commentTimestamps('at 12:30', 600), [], 'past the end is ignored');
const hits = S.commentHits([{ text: '4:32 lmao', like_count: 10 }, { text: 'the 4:35 part', like_count: 0 }, { text: '1:00', like_count: 5 }], 600);
assert.strictEqual(hits[0].t, 270); assert.strictEqual(hits[0].n, 2);

// Most replayed: the opening and the last 3% are ignored; peaks need 2x the median.
const heat = Array.from({ length: 100 }, (_, i) => ({ start_time: i * 10, end_time: i * 10 + 10, value: 0.1 }));
heat[0].value = 1; heat[40].value = 0.5; heat[70].value = 0.3; heat[99].value = 0.9;
const peaks = S.heatPeaks(heat);
assert.deepStrictEqual(peaks.map((p) => p.t), [400, 700]);
assert.strictEqual(peaks[0].value, 1); assert.strictEqual(peaks[0].x, 5);

// Chat replay: message counts and reaction words per 15 s, then spikes.
const line = (ms, text) => JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: String(ms), actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { message: { runs: [{ text }] } } } } }] } });
const lines = [];
for (let t = 0; t < 600; t += 5) lines.push(line(t * 1000, 'hi'));
for (let i = 0; i < 30; i++) lines.push(line(300000 + i * 300, i % 2 ? 'LMAOOO' : 'NO WAYYY 💀'));
const b = S.chatBuckets(lines);
assert.strictEqual(b.find((x) => x.t === 300).n, 33);
assert.ok(b.find((x) => x.t === 300).react >= 30);
const sp = S.spikes(b.map((x) => ({ t: x.t, v: x.n + 2 * x.react })), { floor: 3 });
assert.strictEqual(sp[0].t, 300);

// Audio: a 6 dB+ jump over the surrounding minute.
const db = Array.from({ length: 100 }, (_, i) => ({ t: i * 2, v: -30 }));
db[50].v = -20;
assert.deepStrictEqual(S.loudSpikes(db).map((x) => x.t), [100]);

// Merging: hits within 20 s become one window, and agreeing sources score higher.
const hot = S.hotspots({ replayed: [{ t: 400, value: 1, x: 5 }], comments: [{ t: 410, n: 3, likes: 100 }], loud: [{ t: 900, db: 8 }] });
assert.strictEqual(hot.length, 2);
assert.strictEqual(hot[0].start, 400); assert.strictEqual(hot[0].end, 410);
assert.ok(hot[0].score > 90 && /most replayed/.test(hot[0].why) && /3 comments/.test(hot[0].why));
assert.ok(hot[1].score < hot[0].score);
assert.deepStrictEqual(S.hotspots({}), []);

console.log('clip signals: all checks passed');
