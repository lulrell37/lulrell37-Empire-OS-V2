// R.O.G.U.E.'s viral-moment scan — [CLIP_SCAN: drive link | focus].
//
// A LONG video (podcast, stream, long recording) goes in; a ranked set of short
// vertical clips comes out, without him scrubbing the source first:
//   Drive link -> download -> ffmpeg audio chunks -> Whisper (timestamps)
//   -> Claude picks the top 3-5 moments (filtered by `focus`) -> ffmpeg cuts each
//   and center-crops to 9:16 -> uploaded to his Drive -> ranked list back.
// Doesn't touch [EDIT_CLIP]: a clip from here can still go through it for
// captions, music and S.E.L.E.N.E.'s dress-up.
//
// Env: CLIP_SCAN=off to disable; CLIP_SCAN_MAX_GB (default 2) source size cap;
// CLIP_SCAN_MAX_MIN (default 180) longest source transcribed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { claudeText, transcribeSegments } = require('./llm');
const google = require('./google');

const CHUNK_SEC = 600; // 10 min of 32 kbps mono mp3 ≈ 2.4 MB, far under Whisper's 25 MB
const MIN_CLIP = 12;
const MAX_CLIP = 90;
const MAX_PICKS = 5;
const TG_VIDEO_MAX = 45 * 1024 * 1024; // Telegram's bot upload cap is 50 MB
const MAX_BYTES = (parseFloat(process.env.CLIP_SCAN_MAX_GB) || 2) * 1e9;
const MAX_SEC = (parseFloat(process.env.CLIP_SCAN_MAX_MIN) || 180) * 60;
const TRANSCRIPT_CHARS = 350000;

let running = false;

function enabled() { return String(process.env.CLIP_SCAN || '').toLowerCase() !== 'off'; }

function driveId(url) {
  const u = String(url || '');
  const m = u.match(/\/file\/d\/([\w-]{10,})/) || u.match(/[?&]id=([\w-]{10,})/) || u.match(/\/d\/([\w-]{10,})/);
  return m ? m[1] : null;
}

function run(args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let err = '';
    ff.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 || allowFail ? resolve(err) : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
  });
}

// Download a non-Drive direct link (any https file URL) to disk.
async function downloadUrl(url, dest) {
  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (EmpireOS clip scan)' } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('file is over the size limit');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return decodeURIComponent(new URL(url).pathname.split('/').pop() || 'video');
}

const mmss = (s) => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
};

async function duration(file) {
  const out = await run(['-hide_banner', '-i', file], { allowFail: true }); // no output file: ffmpeg exits 1 but prints the probe
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(out));
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

// Whole recording -> [{ start, end, text }] with absolute seconds.
async function transcribeVideo(src, dir) {
  await run(['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(CHUNK_SEC), '-reset_timestamps', '1', path.join(dir, 'a%03d.mp3')]);
  const chunks = fs.readdirSync(dir).filter((f) => /^a\d+\.mp3$/.test(f)).sort();
  if (!chunks.length) throw new Error('no audio track in that video');
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    const segs = await transcribeSegments(fs.readFileSync(path.join(dir, chunks[i])), chunks[i]);
    for (const s of segs) all.push({ start: s.start + i * CHUNK_SEC, end: s.end + i * CHUNK_SEC, text: s.text });
  }
  return all;
}

const PICK_SYSTEM = `You are R.O.G.U.E., the Empire's video editor, finding the moments in a long recording that would go viral as vertical short-form clips (Reels / TikTok / Shorts). You get a transcript with [mm:ss] timestamps. Pick the 3 to 5 best self-contained moments: a hook in the first seconds, a complete thought or story or punchline, an emotional or surprising or high-stakes beat, something a stranger would share. Each clip runs ${MIN_CLIP} to ${MAX_CLIP} seconds (ideal 25-60), starts where the thought starts and ends where it lands. Don't overlap clips. Use only timestamps that exist in the transcript. Reply with ONLY a JSON array, best first: [{"start": seconds, "end": seconds, "title": "3-6 word label", "reason": "one line on why it hits", "score": 1-100}]. Nothing else.`;

async function pickMoments(segments, focus, total) {
  let text = segments.map((s) => `[${mmss(s.start)}] ${s.text.trim()}`).join('\n');
  if (text.length > TRANSCRIPT_CHARS) text = text.slice(0, TRANSCRIPT_CHARS) + '\n[transcript truncated]';
  const prompt = `${focus ? `FOCUS: ${focus}. Only pick moments that fit this.\n\n` : ''}Recording length ${mmss(total)}.\n\nTRANSCRIPT:\n${text}`;
  const raw = await claudeText(PICK_SYSTEM, prompt, { maxTokens: 1500 });
  return sanitizePicks(parsePicks(raw), total);
}

function parsePicks(raw) {
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (!m) throw new Error('the model returned no clip list');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error('the model returned no clip list');
  return arr;
}

// Clamp to the recording and to clip length, drop overlaps, keep the best few in rank order.
function sanitizePicks(arr, total) {
  const out = [];
  const ranked = arr
    .map((p) => ({ start: Number(p.start), end: Number(p.end), title: String(p.title || '').slice(0, 60), reason: String(p.reason || '').slice(0, 240), score: Number(p.score) || 0 }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start)
    .sort((a, b) => b.score - a.score);
  for (const p of ranked) {
    p.start = Math.max(0, p.start);
    p.end = Math.min(total || p.end, p.end);
    if (p.end - p.start > MAX_CLIP) p.end = p.start + MAX_CLIP;
    if (p.end - p.start < MIN_CLIP) continue;
    if (out.some((q) => p.start < q.end && q.start < p.end)) continue;
    out.push(p);
    if (out.length >= MAX_PICKS) break;
  }
  return out;
}

// Cut [start,end] and center-crop to 9:16 (1080x1920). The crop clamps to the
// frame, so an already-vertical source isn't cropped wider than it is.
function cutVertical(src, start, end, dest) {
  return run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', start.toFixed(2), '-i', src, '-t', (end - start).toFixed(2),
    '-vf', "crop=w='min(iw,ih*9/16)':h='min(ih,iw*16/9)',scale=1080:1920:flags=lanczos,setsar=1",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', dest]);
}

// Run the whole scan. Returns { text, media }: `text` is the ranked list for
// the persona/owner, `media` are [SEND_VIDEO] items for Telegram (clips under
// the upload cap; bigger ones are Drive links only).
async function clipScan(url, focus = '', { onProgress = () => {} } = {}) {
  if (!enabled()) throw new Error('clip scan is switched off (CLIP_SCAN=off)');
  if (running) throw new Error('a clip scan is already running — one at a time; wait for it to finish');
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('needs a link to the video (the Drive link from EDIT CLIP)');
  running = true;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipscan-'));
  try {
    const src = path.join(dir, 'source');
    const id = driveId(url);
    onProgress('downloading');
    const name = id ? await google.driveDownloadTo(id, src, MAX_BYTES) : await downloadUrl(url, src);
    const total = await duration(src);
    if (!total) throw new Error('couldn\'t read that file as a video');
    if (total > MAX_SEC) throw new Error(`that video is ${mmss(total)} — the limit is ${mmss(MAX_SEC)}`);

    onProgress('transcribing');
    const audioDir = path.join(dir, 'audio');
    fs.mkdirSync(audioDir);
    const segments = await transcribeVideo(src, audioDir);
    if (!segments.length) throw new Error('no speech found in that video');

    onProgress('picking');
    const picks = await pickMoments(segments, String(focus || '').trim(), total);
    if (!picks.length) throw new Error('no moment in it was strong enough to cut' + (focus ? ` for "${focus}"` : ''));

    const base = String(name).replace(/\.[^.]+$/, '').slice(0, 60);
    const lines = [];
    const media = [];
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const range = `${mmss(p.start)}–${mmss(p.end)}`;
      onProgress(`cutting ${i + 1}/${picks.length}`);
      const out = path.join(dir, `clip${i + 1}.mp4`);
      try {
        await cutVertical(src, p.start, p.end, out);
        const size = fs.statSync(out).size;
        const up = await google.driveUploadFile(out, `Clip ${i + 1} — ${p.title || base} (${range}).mp4`);
        lines.push(`${i + 1}. ${range} (${Math.round(p.end - p.start)}s) — ${p.title ? `${p.title}: ` : ''}${p.reason}\n   ${up.link}`);
        if (size <= TG_VIDEO_MAX) media.push({ name: 'SEND_VIDEO', buffer: fs.readFileSync(out), filename: `clip${i + 1}.mp4`, caption: `${i + 1}. ${range} — ${p.reason}` });
      } catch (e) {
        lines.push(`${i + 1}. ${range} — ${p.reason}\n   ⚠️ couldn't render this one: ${e.message.slice(0, 160)}`);
      }
    }
    const head = `CLIP SCAN — "${base}" (${mmss(total)}), ${picks.length} moment${picks.length === 1 ? '' : 's'}${focus ? ` for "${focus}"` : ''}, best first. 9:16 center-crop, uploaded to his Drive:`;
    return { text: `${head}\n${lines.join('\n')}\nEach can still go through [EDIT_CLIP: <its link> | brief] for captions, music or S.E.L.E.N.E.'s dress-up.`, media };
  } finally {
    running = false;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Fire-and-forget for the app: runs the scan and delivers the result on
// Telegram through A.R.A. (list as text, then each clip as a video).
function scanInBackground(url, focus) {
  clipScan(url, focus).then(async ({ text, media }) => {
    const telegram = require('./telegram');
    const ara = telegram.botFor('ara');
    if (ara && ara.isConfigured()) {
      await ara.sendMessage(telegram.OWNER_ID, `🎬 **R.O.G.U.E. → A.R.A.**\n${text}`);
      for (const m of media) await ara.sendFile(telegram.OWNER_ID, 'video', m.buffer, { filename: m.filename, caption: m.caption }).catch((e) => console.error('clip-scan send failed:', e.message));
    }
    await require('./pushSender').pushAlert('clip-scan', 'R.O.G.U.E. found your clips', text.split('\n')[0], {}).catch(() => {});
  }).catch(async (e) => {
    console.error('clip-scan failed:', e.message);
    const telegram = require('./telegram');
    const ara = telegram.botFor('ara');
    if (ara && ara.isConfigured()) await ara.sendMessage(telegram.OWNER_ID, `🎬 R.O.G.U.E.'s clip scan failed: ${e.message}`).catch(() => {});
  });
}

const CLIP_TOOLS = ` - [CLIP_SCAN: drive link | focus] — for a LONG video (podcast, stream, full recording): you transcribe it, pick the 3-5 most viral moments (focus is optional, e.g. "funniest moments", "best trading calls"; blank = general virality), cut each to a 9:16 vertical short and upload them to his Drive. Takes several minutes; the ranked list (time range, why, link) and the clips themselves come back in this chat. Use it BEFORE [EDIT_CLIP] when the footage is long-form and he hasn't picked the moment; [EDIT_CLIP] on any one clip after that for captions, music, dress-up. One per turn, one scan at a time. Say it's done only from the result.`;

module.exports = { clipScan, scanInBackground, CLIP_TOOLS, driveId, parsePicks, sanitizePicks, mmss };
