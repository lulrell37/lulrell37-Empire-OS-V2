// node server/scripts/test-clip-layout.js — R.O.G.U.E.'s finished-clip layouts,
// captions and hook (no AI: layout and words are given), plus one real render.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const L = require('../clipLayout');

// The vision answer is checked before it's trusted.
assert.deepStrictEqual(L.parseLayout('{"layout":"facecam","facecam":{"x":0.02,"y":0.66,"w":0.22,"h":0.3}}').layout, 'facecam');
assert.strictEqual(L.parseLayout('{"layout":"facecam","facecam":{"x":0,"y":0,"w":1,"h":1}}').layout, 'wide', 'a "webcam" that is the whole frame is not one');
assert.strictEqual(L.parseLayout('{"layout":"talking","face_x":0.4}').face_x, 0.4);
assert.strictEqual(L.parseLayout('no idea').layout, 'wide');

// The second look's correction: a crop a box-height too high moves down onto the webcam, and stays in frame.
assert.deepStrictEqual(L.parseCheck('{"ok":false,"shift_y":1,"shift_x":0,"grow":0.2}'), { ok: false, sx: 0, sy: 1, grow: 0.2 });
assert.ok(Math.abs(L.adjustBox({ x: 0, y: 0.05, w: 0.2, h: 0.2 }, { sy: 1 }).y - 0.25) < 1e-9);
const grown = L.adjustBox({ x: 0.9, y: 0.9, w: 0.2, h: 0.2 }, { grow: 0.5 });
assert.ok(grown.x + grown.w <= 1 + 1e-9 && grown.y + grown.h <= 1 + 1e-9);
assert.ok(/Dialogue:.*0\.5/.test(L.gridAss(1280, 720)), 'grid labels');

// Captions: up to 3 words a phrase, new phrase after a pause or a sentence end.
const w = (word, start) => ({ word, start, end: start + 0.3 });
assert.deepStrictEqual(L.phrases([w('one', 0), w('two', 0.3), w('three', 0.6), w('four', 0.9), w('five.', 2), w('six', 2.3)]).map((p) => p.length), [3, 1, 1, 1]);
const ass = L.buildAss({ words: [w('all', 0), w('my', 0.3), w('money', 0.6)], hook: 'He bet it all 😳', keywords: ['money'], duration: 3, captionY: 1300, hookY: 200 });
assert.ok(/Hook,,0,0,0,,\{\\pos\(540,200\)\}He bet it all$/m.test(ass), 'hook line, emoji dropped');
assert.strictEqual((ass.match(/Caption,,/g) || []).length, 3, 'one event per word');
assert.ok(/\{\\c&H0050E04A&\}MONEY/.test(ass), 'keyword in green');
assert.ok(/\{\\c&H0000E5FF&\}ALL/.test(ass), 'spoken word in yellow');

// Every layout ends at 1080x1920.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layouttest-'));
try {
  const src = path.join(dir, 's.mp4');
  let r = spawnSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', src]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  for (const lay of [{ layout: 'facecam', facecam: { x: 0.05, y: 0.6, w: 0.25, h: 0.3 } }, { layout: 'talking', face_x: 0.7 }, { layout: 'wide' }]) {
    const g = L.layoutGraph(lay, 1280, 720);
    const out = path.join(dir, `${lay.layout}.png`);
    r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-i', src, '-filter_complex', g.graph, '-map', '[v]', '-frames:v', '1', out]);
    assert.strictEqual(r.status, 0, `${lay.layout}: ${r.stderr}`);
    const probe = String(spawnSync(ffmpeg, ['-hide_banner', '-i', out]).stderr);
    assert.ok(/1080x1920/.test(probe), `${lay.layout} is 1080x1920`);
  }
  const g = L.layoutGraph({}, 720, 1280);
  assert.ok(/pad=1080:1920/.test(g.graph), 'an already-vertical source is kept whole');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// playback speed: captions + hook rescaled by the same factor, clamp 1.0-1.5, default 1.1
{
  const ws = [{ word: 'all', start: 1.1, end: 1.4 }, { word: 'money', start: 2.2, end: 2.8 }];
  const times = (a) => a.split('\n').filter((l) => l.startsWith('Dialogue')).map((l) => l.split(',').slice(1, 3));
  const base = times(L.buildAss({ words: ws, hook: 'hi', duration: 3, captionY: 1300, hookY: 200 }));
  const fast = times(L.buildAss({ words: ws, hook: 'hi', duration: 3.3, captionY: 1300, hookY: 200, speed: 1.1 }));
  assert.deepStrictEqual(base[0], ['0:00:00.00', '0:00:03.00'], 'hook spans the clip at 1x');
  assert.deepStrictEqual(fast[0], ['0:00:00.00', '0:00:03.00'], 'hook spans the sped-up clip (3.3s / 1.1)');
  assert.strictEqual(fast[1][0], '0:00:01.00', 'word at 1.1s lands at 1.0s at 1.1x');
  assert.strictEqual(fast[2][0], '0:00:02.00', 'word at 2.2s lands at 2.0s at 1.1x');
  assert.strictEqual(L.parseSpeed(undefined, undefined), 1.5, 'default 1.5');
  assert.strictEqual(L.parseSpeed(L.legacySpeed('1.1'), undefined), 1.5, 'stored old default 1.1 ignored');
  assert.strictEqual(L.parseSpeed(L.legacySpeed('1.25'), undefined), 1.25, 'other stored values kept');
  assert.strictEqual(L.parseSpeed(L.legacySpeed('1.0'), undefined), 1, 'stored 1.0 = off kept');
  assert.strictEqual(L.parseSpeed('', '1.25'), 1.25, 'env used when no setting');
  assert.strictEqual(L.parseSpeed('1.3', '1.25'), 1.3, 'setting wins over env');
  assert.strictEqual(L.parseSpeed('3'), 1.5, 'clamped high');
  assert.strictEqual(L.parseSpeed('0.5'), 1, 'clamped low');
  assert.strictEqual(L.parseSpeed('1.0'), 1, '1.0 = off');
  assert.strictEqual(L.parseSpeed('abc', '1.2'), 1.2, 'junk setting falls to env');
}
console.log('clip layout: all checks passed');
