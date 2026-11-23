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

// Comedy-first picking: candidate list, vision judge, re-rank, seeds from viewer hot spots.
{
  const J = require('../clipJudge');
  const { PICK_SYSTEM, MAX_CANDIDATES } = require('../clipScan');
  assert(/FUNNIEST/.test(PICK_SYSTEM) && /setup and payoff/.test(PICK_SYSTEM) && /KEKW/.test(PICK_SYSTEM) && /8 to 12/.test(PICK_SYSTEM) && /PENALIZE/.test(PICK_SYSTEM));
  // the model can return up to MAX_CANDIDATES non-overlapping candidates; the old 5 cap is only for the final list
  const many = Array.from({ length: 14 }, (_, i) => ({ start: i * 100, end: i * 100 + 30, score: 90 - i }));
  assert.strictEqual(sanitizePicks(many, 5000, MAX_CANDIDATES).length, MAX_CANDIDATES);
  assert.strictEqual(sanitizePicks(many, 5000).length, 5);

  assert.strictEqual(J.parseJudge('nope'), null);
  assert.strictEqual(J.parseJudge('{"funny": "x"}'), null);
  const j = J.parseJudge('sure {"funny": 9, "visual": 8, "reaction": 9, "standalone": 8, "hook": "He \\"fell\\" off the stage", "note": "guy faceplants"}');
  assert.strictEqual(j.funny, 9); assert.strictEqual(j.hook, 'He fell off the stage');
  assert.strictEqual(J.parseJudge('{"funny": 40}').funny, 10, 'clamped');

  // Funny-on-video beats a good-looking transcript pick; flat ones are dropped; unjudged are discounted.
  const mk = (start, score) => ({ start, end: start + 30, title: 't', reason: 'r', score, hook: '', keywords: [] });
  const picks = [mk(0, 90), mk(100, 80), mk(200, 70), mk(300, 85), mk(400, 60)];
  const judg = [J.parseJudge('{"funny":1,"standalone":2}'), J.parseJudge('{"funny":9,"reaction":9,"standalone":9,"hook":"Wait for it"}'), J.parseJudge('{"funny":6,"standalone":6}'), null, null];
  const r = J.rerank(picks, judg, { max: 3 });
  assert.strictEqual(r[0].start, 100, 'the funniest on video ranks first');
  assert(!r.some((p) => p.start === 0), 'a flat judged pick is dropped');
  assert.strictEqual(r[0].hook, 'Wait for it', 'missing hook filled from the judge');
  assert.strictEqual(r.length, 3);
  // all judged flat and nothing else: still returns something rather than nothing
  assert.strictEqual(J.rerank([mk(0, 90)], [J.parseJudge('{"funny":0}')]).length, 1);

  // Seeds: laughter windows no candidate covers, setup ~20 s before the peak, snapped to speech.
  const segments = Array.from({ length: 40 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: `s${i}` }));
  const hot = [{ start: 205, end: 210, score: 60, laugh: 14, why: 'chat x4, 14 laughing' }, { start: 50, end: 50, score: 90, laugh: 0, why: 'audio +9 dB' }, { start: 120, end: 120, score: 30, laugh: 0, why: 'weak' }];
  const seeds = J.seedCandidates(hot, [mk(40, 80)], segments, 400);
  assert.strictEqual(seeds.length, 1, 'covered and weak windows are skipped');
  assert(seeds[0].start <= 185 && seeds[0].start >= 170 && seeds[0].end >= 218 && seeds[0].end - seeds[0].start <= 60 && seeds[0].end - seeds[0].start >= 12, JSON.stringify(seeds[0]));
  assert.strictEqual(J.seedCandidates(hot, [], segments, 400)[0].start < 190, true);
  assert.strictEqual(J.seedCandidates(hot, [], segments, 400)[0].start, J.seedCandidates(hot, [], segments, 400).sort(() => 0)[0].start);
  console.log('clip scan comedy ranking: ok');
}

// Long-video audio window: an almost empty section download is caught, re-fetched whole and cut locally.
(async () => {
  const { downloadYouTubeAudio, duration, MAX_SEC } = require('../clipScan');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-audio-'));
  const tone = (f, s) => spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', String(s), '-c:a', 'aac', f]);
  const total = MAX_SEC + 600;
  const mk = (sectionLen) => ({
    ytdlp: async (args) => {
      if (args.includes('--skip-download')) return `${total}\nBig stream`;
      const out = args[args.indexOf('-o') + 1].replace('%(ext)s', 'm4a');
      if (args.includes('--download-sections')) tone(out, sectionLen);
      else tone(out, 40); // stands in for the whole audio
      return '';
    },
    proxy: async (fn) => fn([]),
  });
  try {
    // window is MAX_SEC long; scale by faking duration() so a 40 s file reads as the right length
    let cutDone = false;
    const fake = () => async (f) => (cutDone ? MAX_SEC : 0.05);
    // empty section -> fallback cut
    let deps = { ...mk(0.05), duration: fake(), run: async (args) => { cutDone = true; fs.copyFileSync(args[args.indexOf('-i') + 1], args[args.length - 1]); } };
    let r = await downloadYouTubeAudio('https://www.youtube.com/watch?v=x', fs.mkdtempSync(path.join(d, 'a')), null, deps);
    assert(fs.existsSync(r.file) && /audio-src/.test(r.file), 'fallback produced the audio file');
    // good section -> no fallback
    let full = false;
    deps = { ...mk(40), duration: async () => MAX_SEC, run: async () => { full = true; } };
    r = await downloadYouTubeAudio('https://www.youtube.com/watch?v=x', fs.mkdtempSync(path.join(d, 'b')), null, deps);
    assert(!full && r.offset === 0, 'a full-length section is used as is');
    // both short -> clear error
    deps = { ...mk(0.05), duration: async () => 0.05, run: async (args) => { fs.copyFileSync(args[args.indexOf('-i') + 1], args[args.length - 1]); } };
    await assert.rejects(downloadYouTubeAudio('https://www.youtube.com/watch?v=x', fs.mkdtempSync(path.join(d, 'c')), null, deps), /came out 0\.1s long|section download returned/);
    // real duration() sees a real file
    const f = path.join(d, 't.m4a'); tone(f, 3);
    assert(Math.abs(await duration(f) - 3) < 0.5);
    console.log('clip scan audio window guard: ok');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });

// Exact-multiple split: a 1200 s file in 600 s chunks leaves an empty trailing stub that Whisper rejects
// (audio_too_short). transcribeVideo must skip it, keep offsets right, and the Whisper wrappers return [] on stubs.
(async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-split-'));
  try {
    const src = path.join(d, 'src.mp3');
    const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '1200', '-ac', '1', '-b:a', '32k', src]);
    assert.strictEqual(r.status, 0, 'made the 1200 s file');
    // stub Whisper: fail like the real API on anything tiny, otherwise return one segment per chunk
    const llm = require('../llm');
    const sent = [];
    require.cache[require.resolve('../llm')].exports = { ...llm, transcribeSegments: async (buf, name) => {
      sent.push([name, buf.length]);
      if (buf.length < 1024) throw new Error('whisper 400: audio_too_short');
      return [{ start: 1, end: 2, text: name }];
    } };
    delete require.cache[require.resolve('../clipScan')];
    const { transcribeVideo, MIN_CHUNK_SEC } = require('../clipScan');
    assert.strictEqual(MIN_CHUNK_SEC, 0.5);
    const work = path.join(d, 'w'); fs.mkdirSync(work);
    const segs = await transcribeVideo(src, work, {});
    const stubs = fs.readdirSync(work).filter((f) => /^a\d+\.mp3$/.test(f));
    assert.strictEqual(stubs.length, 3, 'ffmpeg writes a 3rd, empty chunk for an exact multiple');
    assert(sent.every(([, n]) => n >= 1024), 'no tiny chunk reached Whisper');
    assert.deepStrictEqual(segs.map((s) => [s.start, s.text]), [[1, 'a000.mp3'], [601, 'a001.mp3']], 'offsets stay right');
    // backstop in the wrappers themselves
    process.env.OPENAI_API_KEY = 'x';
    assert.deepStrictEqual(await llm.transcribeSegments(Buffer.alloc(512), 'a.mp3'), []);
    assert.deepStrictEqual(await llm.transcribeWords(Buffer.alloc(512), 'a.mp3'), []);
    console.log('clip scan exact-multiple split + tiny audio guard: ok');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
})().catch((e) => { console.error(e); process.exit(1); });
