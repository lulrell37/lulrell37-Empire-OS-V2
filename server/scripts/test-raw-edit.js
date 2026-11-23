// node server/scripts/test-raw-edit.js — R.O.G.U.E.'s raw-footage editor: the
// cut (best take, dead air), the timeline remap and the filter graph (no ffmpeg).
const assert = require('assert');
const R = require('../rawEdit');

const w = (word, start, end) => ({ word, start, end });
const words = [
  w('So', 0.5, 0.7), w('today', 0.75, 1.1), w('uh', 1.2, 1.3), w('wait.', 1.35, 1.6),          // false start
  w('So', 4.0, 4.2), w('today', 4.25, 4.6), w('we', 4.65, 4.8), w('build.', 4.85, 5.3),         // the good take
  w('First', 7.0, 7.4), w('step', 8.2, 8.6), w('is', 8.65, 8.8), w('money.', 8.85, 9.4),        // a 0.8 s pause inside
];
const ls = R.lines(words);
assert.deepStrictEqual(ls.map((l) => l.text), ['So today uh wait.', 'So today we build.', 'First', 'step is money.']);

const p = R.parsePlan('here {"keep":[1,2,3,9],"zoom":[3],"titles":[{"id":2,"text":"Step one"},{"id":0,"text":"cut"}],"hook":"We build “today”","keywords":["money","two words"],"title":"Build","music":"calm.mp3"}', ls.length);
assert.deepStrictEqual(p.keep, [1, 2, 3], 'ids that exist only');
assert.deepStrictEqual(p.titles, [{ id: 2, text: 'Step one' }], 'titles only on kept lines');
assert.strictEqual(p.hook, 'We build today');
assert.deepStrictEqual(p.keywords, ['money']);
assert.deepStrictEqual(R.parsePlan('nonsense', 3).keep, [0, 1, 2], 'no plan = keep every line');

const segs = R.segments(ls, p.keep, p.zoom);
assert.strictEqual(segs.length, 3);
assert.ok(Math.abs(segs[0].start - 3.94) < 1e-9 && Math.abs(segs[0].end - (5.3 + R.TAIL)) < 1e-9, 'cut right before the first word, ~2 frames after the last');
assert.ok(Math.abs(segs[1].end - (7.4 + R.TAIL)) < 1e-9 && segs[2].start > 8.1, 'the pause before "step" is cut');
assert.strictEqual(segs[2].zoom, true);
const total = R.cutLength(segs);
assert.ok(total < 4, `9.4 s of footage cut to ${total.toFixed(2)} s`);
assert.strictEqual(R.remap(1.0, segs), null, 'the false start is gone');
assert.ok(Math.abs(R.remap(4.0, segs) - 0.06) < 1e-9);
assert.ok(Math.abs(R.remap(8.2, segs) - (segs[0].end - segs[0].start + segs[1].end - segs[1].start + 0.06)) < 1e-9);

const vc = R.videoChain(segs, { w: 1080, h: 1920 });
assert.ok(vc.startsWith("[0:v]fps=30,select='between(t,3.940,5.380)+") && /zoompan=z='if\(between\(it,/.test(vc), vc);
assert.ok(!/zoompan/.test(R.videoChain(segs.map((s) => ({ ...s, zoom: false })), { w: 1920, h: 1080 })));
assert.ok(/crop=ih\*1080\/1920:ih/.test(R.videoChain(segs, { w: 1920, h: 1080 })), 'landscape takes the 9:16 middle');
assert.ok(R.audioChain(segs).startsWith("[0:a]aselect='between(t,3.940"));

const ass = R.titleAss('[V4+ Styles]\nStyle: Caption,x\nStyle: Hook,x\n\n[Events]\nDialogue: 0,a\n', [{ text: 'step {one}', at: 1.5 }]);
assert.ok(/Style: Hook,x\nStyle: Title,/.test(ass) && /Title,,0,0,0,,.*STEP ONE$/m.test(ass), ass);
assert.deepStrictEqual(R.renderPrefs({ prefs: { captions: false, caption_position: 'middle' } }), { captions: false, hook: true, zooms: true, titles: true, captionY: 1100 });
assert.ok(/No style profile yet/.test(R.styleText(null)));
assert.ok(/\[RAW_EDIT:/.test(R.RAW_EDIT_TOOLS) && /\[STYLE_LEARN:/.test(R.RAW_EDIT_TOOLS));
console.log('raw edit: all checks passed');

// Named style profiles + X links (worker #31).
{
  const clipScan = require('../clipScan');
  assert.strictEqual(clipScan.isSocialVideo('https://x.com/Cobratate/status/1234567890'), 'x');
  assert.strictEqual(clipScan.isSocialVideo('https://twitter.com/i/status/99'), 'x');
  assert.strictEqual(clipScan.isSocialVideo('https://x.com/home'), null);
  assert.strictEqual(clipScan.isSocialVideo('https://www.instagram.com/reel/abc/'), 'instagram');
  assert.deepStrictEqual(clipScan.cookieArgs('https://x.com/a/status/1').length, 0); // no X_COOKIES set
  assert.deepStrictEqual(R.splitProfile('tate: https://x.com/a/status/1, https://x.com/b/status/2'), { name: 'tate', rest: 'https://x.com/a/status/1, https://x.com/b/status/2' });
  assert.deepStrictEqual(R.splitProfile('tate'), { name: 'tate', rest: '' });
  assert.deepStrictEqual(R.splitProfile('somehandle'), { name: '', rest: 'somehandle' });
  assert.deepStrictEqual(R.splitProfile('https://x.com/a/status/1'), { name: '', rest: 'https://x.com/a/status/1' });
  assert.strictEqual(R.keyFor(''), 'rogue_style');
  assert.strictEqual(R.keyFor('Tate'), 'rogue_style_tate');
  console.log('named profiles + X links ok');
}
