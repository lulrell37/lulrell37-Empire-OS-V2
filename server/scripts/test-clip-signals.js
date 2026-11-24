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

// A stream over the limit: the most-replayed stretch, else the start.
(() => {
  const H = 3 * 3600, total = 6.5 * 3600;
  const hm = Array.from({ length: 100 }, (_, i) => ({ start_time: i * total / 100, end_time: (i + 1) * total / 100, value: i >= 60 && i < 85 ? 1 : 0.1 }));
  const w = S.bestWindow(hm, total, H);
  assert.strictEqual(w.end - w.start, H);
  assert.ok(w.start <= 0.6 * total && w.end >= 0.85 * total - 1, 'window covers the replayed stretch');
  assert.ok(w.end <= total);
  assert.deepStrictEqual(S.bestWindow([], total, H), { start: 0, end: H, by: 'start' });
  assert.deepStrictEqual(S.bestWindow(hm, 3600, H), { start: 0, end: 3600, by: 'start' });
  // no graph: the 3 h with the most chat LAUGHTER, not the start, and not just the busiest chat
  const chat = [];
  for (let t = 0; t < total; t += 15) chat.push({ t, n: t < 2 * 3600 ? 40 : 5, react: 2, laugh: 0 });   // loud, unfunny start
  for (let t = 4.5 * 3600; t < 4.6 * 3600; t += 15) chat.push({ t, n: 20, react: 18, laugh: 15 });      // the laughing
  const cw = S.bestWindow([], total, H, chat);
  assert.strictEqual(cw.by, 'chat laughter');
  assert.ok(cw.start > 0 && cw.start <= 4.5 * 3600 && cw.end >= 4.6 * 3600, `window covers the laughing: ${cw.start}-${cw.end}`);
  assert.strictEqual(S.bestWindow([], total, H, chat.map((x) => ({ ...x, laugh: 0 }))).by, 'start', 'no laughs anywhere -> start');
  assert.strictEqual(S.bestWindow(hm, total, H, chat).by, 'replays', 'a graph still wins');
})();

// Chat replay is read line by line and capped, never whole.
(async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')), 'c.json');
  const line = (ms, text) => JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: String(ms), actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { message: { runs: [{ text }] } } } } }] } });
  fs.writeFileSync(f, [line(1000, 'LMAO'), line(2000, 'hi'), 'not json', line(20000, 'W')].join('\n'));
  const b = await S.readChatFile(f);
  assert.deepStrictEqual(b.map((x) => [x.t, x.n]), [[0, 2], [15, 1]]);
  assert.strictEqual(b.capped, false);
  console.log('clip signals: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

// Laughter words outweigh hype in chat: a bucket of LMAO/KEKW/💀 spikes harder than one of W/bro.
{
  const S = require('../clipSignals');
  const line = (ms, text) => JSON.stringify({ replayChatItemAction: { videoOffsetTimeMsec: String(ms), actions: [{ addChatItemAction: { item: { liveChatTextMessageRenderer: { message: { runs: [{ text }] } } } } }] } });
  const lines = [];
  for (let i = 0; i < 6; i++) lines.push(line(15000 + i * 500, ['LMAOOO', 'KEKW', '💀💀', 'im dead', 'lol', 'bruh'][i]));
  for (let i = 0; i < 6; i++) lines.push(line(60000 + i * 500, ['W', 'bro', 'omg', 'W', 'nah', 'W'][i]));
  const b = S.chatBuckets(lines);
  const laughy = b.find((x) => x.t === 15), hype = b.find((x) => x.t === 60);
  assert(laughy.laugh >= 5, `laugh count ${laughy.laugh}`);
  assert.strictEqual(hype.laugh, 0);
  assert(S.chatWeight(laughy) > S.chatWeight(hype) + 10, 'laughter weighs more than hype');
  // hotspots: laughter lifts a chat window above an equal-ratio hype one and says so
  const h = S.hotspots({ chat: [{ t: 100, ratio: 4, react: 10, laugh: 8 }, { t: 400, ratio: 4, react: 10, laugh: 0 }] });
  assert.strictEqual(h[0].start, 100);
  assert(h[0].score > h[1].score && /laughing/.test(h[0].why) && h[0].laugh === 8, JSON.stringify(h));
  console.log('clip signals laughter weighting: ok');
}

// Laughter: in the audio (bursts), in the transcript, in chat (laugh-only spikes), and how hotspots weigh them.
(() => {
  // 0.1 s dB series: speech around -30 dB with slow swing; a 3 s laugh = 8 bursts at 2 Hz that peak -12 dB.
  const fine = Array.from({ length: 1200 }, (_, i) => -32 + 2 * Math.sin(i / 40));
  const laugh = fine.slice();
  for (let i = 600; i < 640; i++) laugh[i] = -30 + 18 * Math.max(0, Math.sin(((i - 600) / 2.5) * Math.PI));   // dips back to -30
  const L = S.laughBursts(laugh);
  assert.ok(L.length >= 1 && Math.abs(L[0].t - 60) <= 3 && L[0].bursts >= 4, `audio laughter found near 60 s: ${JSON.stringify(L[0])}`);
  assert.deepStrictEqual(S.laughBursts(fine), [], 'plain speech is not laughter');
  const shout = fine.slice(); for (let i = 600; i < 640; i++) shout[i] = -12;   // one sustained loud stretch, no bursts
  assert.deepStrictEqual(S.laughBursts(shout), [], 'a sustained shout is not laughter');

  const said = S.transcriptLaughs([{ start: 5, text: 'and then... haha hahaha oh no' }, { start: 9, text: 'He said [Laughter] wow' }, { start: 20, text: 'we have a hall full of ballast' }, { start: 30, text: 'LMAO' }]);
  assert.deepStrictEqual(said.map((x) => x.t), [5, 9, 30]);

  // a laugh-only spike in a chat that is busy all the time
  const b = Array.from({ length: 60 }, (_, i) => ({ t: i * 15, n: 50, react: 5, laugh: 1 }));
  b[30] = { t: 450, n: 52, react: 25, laugh: 20 };
  assert.ok(S.laughSpikes(b).some((x) => x.t === 450), 'laugh-only spike found');

  // hotspots: laughing chat outranks hype-only chat of the same ratio, audio laughter and said laughter count
  const hot = S.hotspots({ chat: [{ t: 100, ratio: 5, react: 20, laugh: 12 }, { t: 900, ratio: 5, react: 20, laugh: 0 }], laughAudio: [{ t: 102, bursts: 6, db: 8 }], said: [{ t: 98, laugh: 2 }] });
  assert.ok(hot[0].start <= 100 && hot[0].end >= 100 && hot[0].laugh >= 12 && /laughter in the audio/.test(hot[0].why) && /laughing in the transcript/.test(hot[0].why));
  const hype = hot.find((h) => h.start === 900);
  assert.ok(hype.score <= 60 && hot[0].score > hype.score + 25, `hype-only chat tops out low: ${hype.score} vs ${hot[0].score}`);
})();
console.log('clip signals: laughter ok');
