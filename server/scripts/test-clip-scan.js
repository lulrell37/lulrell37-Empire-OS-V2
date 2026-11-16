// node server/scripts/test-clip-scan.js — pick parsing/clamping, Drive link ids, and a real ffmpeg 9:16 cut.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { parsePicks, sanitizePicks, driveId, mmss } = require('../clipScan');

assert.strictEqual(driveId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'), '1AbCdEfGhIjKlMnOp');
assert.strictEqual(driveId('https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOp&export=download'), '1AbCdEfGhIjKlMnOp');
assert.strictEqual(driveId('https://example.com/a.mp4'), null);
assert.strictEqual(mmss(75), '1:15');
assert.strictEqual(mmss(3725), '1:02:05');

const raw = 'Here:\n[{"start":10,"end":50,"reason":"a","score":80},{"start":40,"end":80,"reason":"overlaps","score":70},{"start":100,"end":105,"reason":"too short","score":99},{"start":200,"end":400,"reason":"too long","score":60},{"start":-5,"end":9999,"reason":"x","score":1}]';
const picks = sanitizePicks(parsePicks(raw), 600);
assert.deepStrictEqual(picks.map((p) => [p.start, p.end]), [[10, 50], [200, 290]]);
assert.throws(() => parsePicks('no json'));

// Real cut: landscape source -> 1080x1920.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cliptest-'));
try {
  const src = path.join(dir, 's.mp4'), out = path.join(dir, 'o.mp4');
  let r = spawnSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', src]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const vf = "crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=1080:1920:flags=lanczos,setsar=1";
  r = spawnSync(ffmpeg, ['-loglevel', 'error', '-y', '-ss', '1', '-i', src, '-t', '3', '-vf', vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', out]).stderr.toString();
  assert(/1080x1920/.test(probe), probe);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log('clip scan: ok');
