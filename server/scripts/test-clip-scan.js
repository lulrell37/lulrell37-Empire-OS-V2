// node server/scripts/test-clip-scan.js — pick parsing/clamping, Drive link ids, and a real ffmpeg 9:16 cut.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const { parsePicks, sanitizePicks, driveId, isYouTube, linkKind, clipScan, mmss } = require('../clipScan');

assert.strictEqual(driveId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view?usp=sharing'), '1AbCdEfGhIjKlMnOp');
assert.strictEqual(driveId('https://drive.google.com/uc?id=1AbCdEfGhIjKlMnOp&export=download'), '1AbCdEfGhIjKlMnOp');
assert.strictEqual(driveId('https://example.com/a.mp4'), null);
for (const u of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ?t=5', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=x']) {
  assert.strictEqual(linkKind(u), 'youtube', u);
}
for (const u of ['https://www.youtube.com/', 'https://www.youtube.com/watch?v=short', 'https://evil.com/?u=youtube.com/watch?v=dQw4w9WgXcQ', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'ftp://youtu.be/dQw4w9WgXcQ', 'https://example.com/a.mp4', 'dQw4w9WgXcQ', '']) {
  assert.strictEqual(linkKind(u), null, u);
}
assert.strictEqual(linkKind('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view'), 'drive');
assert.strictEqual(isYouTube('https://youtu.be/dQw4w9WgXcQ'), true);
assert.strictEqual(mmss(75), '1:15');
assert.strictEqual(mmss(3725), '1:02:05');

const raw = 'Here:\n[{"start":10,"end":50,"reason":"a","score":80},{"start":40,"end":80,"reason":"overlaps","score":70},{"start":100,"end":105,"reason":"too short","score":99},{"start":200,"end":400,"reason":"too long","score":60},{"start":-5,"end":9999,"reason":"x","score":1}]';
const picks = sanitizePicks(parsePicks(raw), 600);
assert.deepStrictEqual(picks.map((p) => [p.start, p.end]), [[10, 50], [200, 290]]);
assert.throws(() => parsePicks('no json'));

// Unrecognized links are refused before anything downloads (and don't take the lock).
(async () => {
  await assert.rejects(clipScan('https://example.com/a.mp4'), /Drive link or a YouTube URL/);
  await assert.rejects(clipScan('https://example.com/a.mp4'), /Drive link or a YouTube URL/); // lock wasn't left held
  console.log('clip scan routing: ok');
})().catch((e) => { console.error(e); process.exit(1); });

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

// ffmpeg-static segfaults (exit -11) on any hostname lookup on the VM, so every
// --download-sections call routes ffmpeg through withFfmpegProxy: ffmpeg dials
// 127.0.0.1 only and the proxy does the DNS. Here ffmpeg reads a file served as
// http://localhost:… through it, and an https-style CONNECT tunnel carries a request.
// CLIP_SCAN_NET=1 also cuts a real 20 s YouTube section with downloadSection.
(async () => {
  const http = require('http');
  const net = require('net');
  const { withFfmpegProxy, downloadSection } = require('../clipScan');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cliproxy-'));
  const src = path.join(d, 's.mp4');
  const made = spawnSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25', '-t', '4', '-c:v', 'libx264', src]);
  assert.strictEqual(made.status, 0, String(made.stderr));
  const body = fs.readFileSync(src);
  const origin = http.createServer((req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) { res.writeHead(200, { 'content-length': body.length, 'accept-ranges': 'bytes', 'content-type': 'video/mp4' }); return res.end(body); }
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : body.length - 1;
    res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${body.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes', 'content-type': 'video/mp4' });
    res.end(body.subarray(a, b + 1));
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const port = origin.address().port;
  try {
    let px;
    await withFfmpegProxy(async (args) => {
      px = args;
      assert.strictEqual(args[0], '--downloader-args');
      const proxy = /^ffmpeg_i:-http_proxy (http:\/\/127\.0\.0\.1:\d+)$/.exec(args[1]);
      assert(proxy, args[1]);
      const out = path.join(d, 'o.mp4');
      const { spawn } = require('child_process');
      const code = await new Promise((resolve) => {
        const p = spawn(ffmpeg, ['-loglevel', 'error', '-y', '-http_proxy', proxy[1], '-ss', '1', '-t', '2', '-i', `http://localhost:${port}/s.mp4`, '-c:v', 'libx264', '-preset', 'ultrafast', out]);
        p.on('close', (c, sig) => resolve(sig || c));
      });
      assert.strictEqual(code, 0, `ffmpeg through the proxy exited ${code}`);
      assert(fs.statSync(out).size > 0);
      const viaTunnel = await new Promise((resolve, reject) => {
        const s = net.connect(Number(proxy[1].split(':').pop()), '127.0.0.1', () => s.write(`CONNECT localhost:${port} HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`));
        let buf = '';
        s.on('data', (c) => {
          buf += c;
          if (/200 Connection Established\r\n\r\n$/.test(buf)) s.write(`GET /s.mp4 HTTP/1.1\r\nHost: localhost\r\nRange: bytes=0-9\r\nConnection: close\r\n\r\n`);
        });
        s.on('end', () => resolve(buf));
        s.on('error', reject);
      });
      assert(/206 Partial Content/.test(viaTunnel), viaTunnel.slice(0, 200));
    });
    // The proxy is closed once the call is done.
    const port2 = Number(px[1].split(':').pop());
    await assert.rejects(new Promise((resolve, reject) => { const s = net.connect(port2, '127.0.0.1', () => { s.destroy(); resolve(); }); s.on('error', reject); }));
    console.log('clip scan ffmpeg proxy: ok');

    if (process.env.CLIP_SCAN_NET === '1') {
      const t = Date.now();
      const sec = await downloadSection(process.env.CLIP_SCAN_NET_URL || 'https://www.youtube.com/watch?v=lmQTgODLWVU', 300, 314, d, 'live');
      const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', sec.file]).stderr.toString();
      assert(/Duration: 00:00:(19|20)\./.test(probe) && /Video: h264/.test(probe) && /Audio: aac/.test(probe), probe);
      console.log(`clip scan live section: ok (${Math.round((Date.now() - t) / 1000)}s)`);
    }
  } finally {
    origin.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
