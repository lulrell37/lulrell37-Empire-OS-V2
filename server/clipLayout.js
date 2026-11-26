// R.O.G.U.E.'s finished clip: what turns a raw cut into something that looks
// like it came from a real clipping page. For each picked moment:
//   1. layout — one frame from the middle of the clip goes to the vision chain
//      (server/vision.js) to say what kind of shot it is:
//        facecam  a stream / gameplay with a webcam box -> face cam on top,
//                 gameplay underneath (the clipping-page standard)
//        talking  one person on camera -> 9:16 crop that follows their face
//        wide     anything else (two-shot podcast, screen, slides) -> the full
//                 frame in the middle over a blurred, darkened copy of itself
//      An already-vertical source is kept as it is. No vision answer -> wide.
//   2. captions — the clip's own audio goes back through Whisper for word
//      timestamps; captions show 1-3 words at a time, in caps, the word being
//      said in yellow and the picker's keywords in green.
//   3. hook — the picker's hook line sits at the top for the whole clip, black
//      on a white box.
// Rendered with ffmpeg + libass (ffmpeg-static has both); the font (Anton) is
// fetched once and cached like yt-dlp. Any step that fails drops back to a
// plainer clip rather than no clip, and says which.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const W = 1080, H = 1920;
const FACE_H = 700;               // face cam band on top; gameplay gets the rest
const FONT_URL = 'https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf';
const FONT_DIR = path.join(os.tmpdir(), 'empire-bin', 'fonts');
const FONT_NAME = 'Anton';

function run(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let err = '';
    ff.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
  });
}

let fontReady = null;
function ensureFont() {
  if (!fontReady) {
    fontReady = (async () => {
      const f = path.join(FONT_DIR, 'Anton-Regular.ttf');
      if (fs.existsSync(f)) return FONT_DIR;
      const res = await fetch(FONT_URL);
      if (!res.ok) throw new Error(`font download ${res.status}`);
      fs.mkdirSync(FONT_DIR, { recursive: true });
      fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
      return FONT_DIR;
    })().catch((e) => { fontReady = null; console.error('clip font fetch failed:', e.message); return null; });
  }
  return fontReady;
}

// Width x height of the first video stream.
async function videoSize(src) {
  const out = await new Promise((resolve) => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-i', src]);
    let err = '';
    ff.stderr.on('data', (c) => { err += c; });
    ff.on('close', () => resolve(err));
    ff.on('error', () => resolve(''));
  });
  const m = /Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(out);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

// --- 1. layout --------------------------------------------------------------

const LAYOUT_PROMPT = `This is one frame from a video that is being cut into a vertical (9:16) short. Say what kind of shot it is, as JSON only:
{"layout":"facecam"|"talking"|"wide","facecam":{"x":0-1,"y":0-1,"w":0-1,"h":0-1},"face_x":0-1}
- "facecam": gameplay, a screen or a stream with a separate small webcam box showing the streamer's face. Give that webcam box as fractions of the frame: x = its LEFT edge, y = its TOP edge, w = its width, h = its height. The frame has a yellow measuring grid drawn over it, a line every 0.05 with the value written on every 0.1 line along the top and left side (0.0 = left / top of the frame, 1.0 = right / bottom). Read the webcam's four edges off that grid; don't estimate. The box is cropped straight from your numbers, so if it's off the face gets cut.
- "talking": one person on camera fills most of the frame. Give face_x, the horizontal center of their face as a fraction of the width.
- "wide": anything else (two or more people side by side, slides, a screen with no webcam, scenery).
Only the JSON.`;

function parseLayout(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return { layout: 'wide' };
  let j; try { j = JSON.parse(m[0]); } catch { return { layout: 'wide' }; }
  const f = (v) => Math.min(1, Math.max(0, Number(v)));
  if (j.layout === 'facecam' && j.facecam) {
    const b = { x: f(j.facecam.x), y: f(j.facecam.y), w: f(j.facecam.w), h: f(j.facecam.h) };
    // A real webcam box is small and inside the frame; otherwise don't trust it.
    if (b.w >= 0.08 && b.h >= 0.08 && b.w <= 0.6 && b.h <= 0.7 && b.x + b.w <= 1.02 && b.y + b.h <= 1.02) return { layout: 'facecam', facecam: b };
    return { layout: 'wide' };
  }
  if (j.layout === 'talking' && Number.isFinite(Number(j.face_x))) return { layout: 'talking', face_x: f(j.face_x) };
  return { layout: 'wide' };
}

// A measuring grid over the frame (lines every 5%, values on every 10% line),
// drawn with libass since this ffmpeg has no drawtext: vision models misjudge
// positions badly by eye (Kai Cenat's webcam came back a whole box-height high),
// and read them well off a ruler.
function gridAss(w, h) {
  const L = ['[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${w}`, `PlayResY: ${h}`, 'ScaledBorderAndShadow: yes', '', '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: G,${FONT_NAME},22,&H0000FFFF&,&H0000FFFF&,&H00000000&,&H00000000&,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1`, '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'];
  for (let i = 1; i < 10; i++) {
    const v = (i / 10).toFixed(1);
    L.push(`Dialogue: 0,0:00:00.00,0:00:10.00,G,,0,0,0,,{\\pos(${Math.round(i * w / 10) + 3},2)}${v}`);
    L.push(`Dialogue: 0,0:00:00.00,0:00:10.00,G,,0,0,0,,{\\pos(3,${Math.round(i * h / 10) + 2})}${v}`);
  }
  return L.join('\n') + '\n';
}

async function gridFrame(src, at, dir, fontsDir) {
  const frame = path.join(dir, `frame-${Math.round(at * 10)}.jpg`);
  const ass = path.join(dir, `grid-${Math.round(at * 10)}.ass`);
  fs.writeFileSync(ass, gridAss(1280, 720));
  const esc = (x) => x.replace(/[:\\']/g, '\\$&');
  const vf = `scale=1280:720,drawgrid=w=iw/20:h=ih/20:t=1:c=yellow@0.45,drawgrid=w=iw/10:h=ih/10:t=2:c=yellow@0.8${fontsDir ? `,ass=${esc(ass)}:fontsdir=${esc(fontsDir)}` : ''}`;
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '3', frame]);
  return frame;
}

// The crop as it will be cut, for the second look.
async function cropFrame(src, at, dir, box) {
  const out = path.join(dir, `check-${Math.round(at * 10)}.jpg`);
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', src, '-frames:v', '1',
    '-vf', `crop=iw*${box.w.toFixed(4)}:ih*${box.h.toFixed(4)}:iw*${box.x.toFixed(4)}:ih*${box.y.toFixed(4)},scale=640:-2`, '-q:v', '3', out]);
  return out;
}

const CHECK_PROMPT = `This image is meant to be exactly one streamer's webcam, cropped out of a stream, to sit on top of a vertical clip. Is the whole webcam picture in it, with the person's whole head and face visible? JSON only:
{"ok":true|false,"shift_y":-1..1,"shift_x":-1..1,"grow":0..1}
shift_y: how far to move the crop, as a fraction of its own height; positive = move it DOWN (the webcam continues below the bottom edge), negative = UP. shift_x likewise, positive = right. grow: how much bigger the crop needs to be to fit the whole webcam (0 = fine). If there's no webcam or face in it at all, "ok":false and your best guess of the direction to it.`;

function parseCheck(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const c = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
    return { ok: j.ok === true, sx: c(j.shift_x, -1.5, 1.5), sy: c(j.shift_y, -1.5, 1.5), grow: c(j.grow, 0, 1) };
  } catch { return null; }
}

// Apply a correction (in box units) and keep the box inside the frame.
function adjustBox(b, { sx = 0, sy = 0, grow = 0 }) {
  const w = Math.min(1, b.w * (1 + grow)), h = Math.min(1, b.h * (1 + grow));
  const cx = b.x + b.w / 2 + sx * b.w, cy = b.y + b.h / 2 + sy * b.h;
  return { x: Math.min(Math.max(0, cx - w / 2), 1 - w), y: Math.min(Math.max(0, cy - h / 2), 1 - h), w, h };
}

async function detectLayout(src, at, dir, fontsDir) {
  const { lookAtImages } = require('./vision');
  const frame = await gridFrame(src, at, dir, fontsDir);
  const lay = parseLayout(await lookAtImages([{ data: fs.readFileSync(frame), mime: 'image/jpeg' }], LAYOUT_PROMPT));
  if (lay.layout !== 'facecam') return lay;
  // Second look: the crop itself. Up to two corrections; still wrong after that = no face cam layout.
  for (let i = 0; i < 3; i++) {
    const chk = parseCheck(await lookAtImages([{ data: fs.readFileSync(await cropFrame(src, at, dir, lay.facecam)), mime: 'image/jpeg' }], CHECK_PROMPT).catch(() => ''));
    if (!chk) break;
    if (chk.ok && chk.grow < 0.1 && Math.abs(chk.sx) < 0.1 && Math.abs(chk.sy) < 0.1) { lay.checked = true; break; }
    if (i === 2) return { layout: 'wide', note: 'the webcam crop never checked out' };
    lay.facecam = adjustBox(lay.facecam, chk);
  }
  return lay;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// The ffmpeg filter graph for a layout. Input [0:v] is the source at sw x sh.
// Ends in [v] at 1080x1920. Returns { graph, captionY, hookY } (hookY null = no room).
function layoutGraph(lay, sw, sh) {
  if (sh > sw) {
    return { graph: `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[v]`, captionY: 1380, hookY: 230 };
  }
  if (lay.layout === 'facecam') {
    // Face box trimmed to the band's shape (1080:700) around its center — trimmed,
    // not grown, so stream overlays next to the webcam (viewer count, alerts) stay out.
    // A webcam taller than the band keeps its full height and takes some of what's
    // beside it instead — trimming height is what cuts off heads.
    const b = lay.facecam;
    let bw = b.w * sw, bh = b.h * sh;
    const want = W / FACE_H;
    if (bw / bh > want) bw = bh * want; else bw = bh * want;
    bw = Math.min(bw, sw); bh = Math.min(bh, sh);
    const cx = (b.x + b.w / 2) * sw, cy = (b.y + b.h / 2) * sh;
    const fx = Math.min(Math.max(0, cx - bw / 2), sw - bw), fy = Math.min(Math.max(0, cy - bh / 2), sh - bh);
    // Gameplay: the center of the frame at the lower band's shape.
    const gh = H - FACE_H;
    let gw = Math.min(sw, sh * W / gh), gH = gw * gh / W;
    if (gH > sh) { gH = sh; gw = gH * W / gh; }
    return {
      graph: `[0:v]split=2[a][b];[a]crop=${even(bw)}:${even(bh)}:${even(fx)}:${even(fy)},scale=${W}:${FACE_H},setsar=1[top];` +
        `[b]crop=${even(gw)}:${even(gH)}:(iw-ow)/2:(ih-oh)/2,scale=${W}:${gh},setsar=1[bot];[top][bot]vstack=inputs=2[v]`,
      captionY: FACE_H + 170, hookY: 90,
    };
  }
  if (lay.layout === 'talking') {
    const cw = even(Math.min(sw, sh * W / H));
    const x = even(Math.min(Math.max(0, lay.face_x * sw - cw / 2), sw - cw));
    return { graph: `[0:v]crop=${cw}:${even(cw * H / W > sh ? sh : cw * H / W)}:${x}:(ih-oh)/2,scale=${W}:${H},setsar=1[v]`, captionY: 1380, hookY: 230 };
  }
  // wide: full frame centered over a blurred copy of itself.
  const fh = even(W * sh / sw);
  return {
    graph: `[0:v]split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,eq=brightness=-0.18,setsar=1[bg];` +
      `[b]scale=${W}:${fh},setsar=1[fg];[bg][fg]overlay=0:(H-h)/2[v]`,
    captionY: Math.min(H - 220, Math.round(H / 2 + fh / 2 + 150)), hookY: Math.max(140, Math.round(H / 2 - fh / 2 - 260)),
  };
}

// --- 2 + 3. captions and hook (ASS) -------------------------------------------

// The caption font has no emoji glyphs (they render as boxes), so they're dropped from on-screen text.
const assEsc = (s) => String(s).replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s{2,}/g, ' ').trim().replace(/\\/g, '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ');
function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}
const norm = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

// Words -> phrases of up to 3 words (a new phrase after a pause or sentence end).
function phrases(words) {
  const out = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = words[i - 1];
    if (cur.length && (cur.length >= 3 || w.start - prev.end > 0.6 || /[.!?]$/.test(prev.word))) { out.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out;
}

// The .ass file: a Hook style (black on a white box, top) and a Caption style
// (big white caps, thick black outline). One event per word: the whole phrase,
// with the spoken word yellow and keywords green.
function buildAss({ words = [], hook = '', keywords = [], duration, captionY, hookY, speed = 1 }) {
  // Playback speed: every time is on the clip's own clock, so divide by the factor to match the sped-up video.
  if (speed && speed !== 1) {
    words = words.map((w) => ({ ...w, start: w.start / speed, end: w.end / speed }));
    duration = duration / speed;
  }
  const keys = new Set((keywords || []).map(norm).filter(Boolean));
  const YELLOW = '&H0000E5FF&', GREEN = '&H0050E04A&', WHITE = '&H00FFFFFF&';
  const L = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${FONT_NAME},104,${WHITE},${WHITE},&H00000000&,&H80000000&,0,0,0,0,100,100,1,0,1,7,3,8,60,60,0,1`,
    `Style: Hook,${FONT_NAME},78,&H00111111&,&H00111111&,&H00FFFFFF&,&H00FFFFFF&,0,0,0,0,100,100,0,0,3,18,0,8,90,90,0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  if (hook && hookY != null) L.push(`Dialogue: 1,${assTime(0)},${assTime(duration)},Hook,,0,0,0,,{\\pos(${W / 2},${hookY})}${assEsc(hook)}`);
  for (const ph of phrases(words)) {
    const end = ph[ph.length - 1].end;
    for (let i = 0; i < ph.length; i++) {
      const s = ph[i].start, e = i + 1 < ph.length ? ph[i + 1].start : Math.max(end, s + 0.2);
      if (s >= duration) continue;
      const text = ph.map((w, j) => {
        const c = j === i ? YELLOW : keys.has(norm(w.word)) ? GREEN : WHITE;
        return `{\\c${c}}${assEsc(w.word.toUpperCase())}`;
      }).join(' ');
      const pop = i === 0 ? '{\\fscx92\\fscy92\\t(0,90,\\fscx100\\fscy100)}' : '';
      L.push(`Dialogue: 0,${assTime(s)},${assTime(Math.min(e, duration))},Caption,,0,0,0,,{\\pos(${W / 2},${captionY})}${pop}${text}`);
    }
  }
  return L.join('\n') + '\n';
}

// The clip's words. Cut cold at the clip's first frame, Whisper mishears the
// opening (half a word, no context), so it gets PRE_ROLL seconds of lead-in and
// the full transcript's text for this stretch as its prompt; the lead-in words
// are dropped and the rest shifted back to the clip's own clock.
const PRE_ROLL = 2;
// The prompt is vocabulary only: names and odd terms the full transcript spelled (capitalised mid-sentence,
// or with digits), never its running text. Whisper continues a prompt written as sentences, so 800 characters
// of the stretch before and around the clip could put those words, or the long transcript's own mishearings,
// into the captions (2026-11-23: "captions don't match the video").
function vocabPrompt(context, max = 300) {
  const seen = new Set(), out = [];
  const toks = String(context || '').split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const raw = toks[i];
    const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (w.length < 3 || w === 'I' || /^I'/.test(w)) continue;
    const afterStop = i === 0 || /[.!?]$/.test(toks[i - 1]);
    if (!(/\d/.test(w) || (/^\p{Lu}/u.test(w) && !afterStop))) continue;
    const k = w.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(w);
    if (out.join(', ').length > max) { out.pop(); break; }
  }
  return out.join(', ');
}
async function clipWords(src, start, end, dir, tag, context = '') {
  const { transcribeWords } = require('./llm');
  const a = path.join(dir, `${tag}-words.mp3`);
  const from = Math.max(0, start - PRE_ROLL), lead = start - from;
  await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', from.toFixed(2), '-i', src, '-t', (end - from).toFixed(2), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k', a]);
  const words = await transcribeWords(fs.readFileSync(a), `${tag}.mp3`, { prompt: vocabPrompt(context), job: 'clip captions' });
  return words.map((w) => ({ ...w, start: w.start - lead, end: w.end - lead })).filter((w) => w.end > 0.05).map((w) => ({ ...w, start: Math.max(0, w.start) }));
}

// --- the render ------------------------------------------------------------------

// Playback speed of finished clips: app_settings.rogue_clip_speed, then env CLIP_SPEED, default 1.5,
// clamped 1.0-1.5 (1.0 = off). Clip ranges reported to him stay in the source video's own time.
const DEFAULT_SPEED = 1.5;
function parseSpeed(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return Math.min(1.5, Math.max(1, n));
  }
  return DEFAULT_SPEED;
}
// 1.1 was the old default, so a stored 1.1 is almost certainly just that and is ignored (2026-11-23,
// default now 1.5); any other stored value (1.0 = off, 1.25...) is a real choice and still wins.
const legacySpeed = (v) => (Math.abs(Number(v) - 1.1) < 1e-9 ? '' : v);
async function clipSpeed() {
  let stored;
  try { stored = await require('./syncStore').getSetting('rogue_clip_speed', ''); } catch { /* no db: env/default */ }
  return parseSpeed(legacySpeed(stored), process.env.CLIP_SPEED);
}

// Cut [start,end] of src to dest as a finished 1080x1920 clip. pick = { hook, keywords }.
// Returns { layout, captions: bool, notes: [] }.
async function renderClip({ src, start, end, dest, dir, pick = {}, size, context = '' }) {
  const notes = [];
  const dur = end - start;
  const tag = path.basename(dest, '.mp4');
  size = size || await videoSize(src) || { w: 1920, h: 1080 };
  const fontP = ensureFont();
  const [lay, words, fontsDir] = await Promise.all([
    size.h > size.w ? Promise.resolve({ layout: 'vertical' })
      : fontP.then((fd) => detectLayout(src, start + dur / 2, dir, fd)).catch((e) => { notes.push(`layout read failed (${e.message.slice(0, 80)}), used the blurred frame`); return { layout: 'wide' }; }),
    clipWords(src, start, end, dir, tag, context).catch((e) => { notes.push(`no captions (${e.message.slice(0, 80)})`); return []; }),
    fontP,
  ]);
  if (lay.note) notes.push(lay.note);
  const g = layoutGraph(lay, size.w, size.h);
  if (!fontsDir) notes.push('caption font unavailable, used the system font');
  const speed = await clipSpeed();
  const ass = path.join(dir, `${tag}.ass`);
  fs.writeFileSync(ass, buildAss({ words, hook: pick.hook, keywords: pick.keywords, duration: dur, captionY: g.captionY, hookY: g.hookY, speed }));
  const fast = speed !== 1 ? `[v]setpts=PTS/${speed}[vf];` : '';
  const vin = speed !== 1 ? '[vf]' : '[v]';
  const af = speed !== 1 ? ['-af', `atempo=${speed}`] : [];
  const subs = `ass=${ass.replace(/[:\\']/g, '\\$&')}${fontsDir ? `:fontsdir=${fontsDir.replace(/[:\\']/g, '\\$&')}` : ''}`;
  const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart'];
  const base = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', start.toFixed(2), '-i', src, '-t', (dur / speed).toFixed(2)];
  try {
    await run([...base, '-filter_complex', `${g.graph};${fast}${vin}${subs}[out]`, '-map', '[out]', '-map', '0:a?', ...af, ...enc, dest]);
  } catch (e) {
    // Captions are the fragile part (fonts, odd characters) — the layout alone still beats a plain crop.
    notes.push(`captions failed to render (${e.message.slice(-120)})`);
    await run([...base, '-filter_complex', speed !== 1 ? `${g.graph};[v]setpts=PTS/${speed}[vf]` : g.graph, '-map', vin, '-map', '0:a?', ...af, ...enc, dest]);
    return { layout: lay.layout, captions: false, notes };
  }
  return { layout: lay.layout, captions: words.length > 0, notes };
}

module.exports = { vocabPrompt, gridAss, parseCheck, adjustBox, renderClip, layoutGraph, parseLayout, buildAss, parseSpeed, legacySpeed, clipSpeed, phrases, videoSize, ensureFont };
