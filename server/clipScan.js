// R.O.G.U.E.'s viral-moment scan — [CLIP_SCAN: drive link or YouTube URL | focus].
//
// A LONG video (podcast, stream, long recording) goes in; a ranked set of short
// vertical clips comes out, without him scrubbing the source first:
//   Drive link (or YouTube URL, fetched with yt-dlp) -> download -> ffmpeg audio chunks -> Whisper (timestamps)
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
const signals = require('./clipSignals');
const layout = require('./clipLayout');
const judge = require('./clipJudge');
const LAYOUT_WORDS = { facecam: 'face cam on top, gameplay below', talking: 'vertical crop on the speaker', wide: 'full frame over a blurred background', vertical: 'already vertical' };
const google = require('./google');

const CHUNK_SEC = 600; // 10 min of 32 kbps mono mp3 ≈ 2.4 MB, far under Whisper's 25 MB
const MIN_CLIP = 12;
const MAX_CLIP = 90;
const MAX_PICKS = 5;
const MAX_CANDIDATES = 12;   // the picker's longer list; the vision check cuts it to MAX_PICKS
const TG_VIDEO_MAX = 45 * 1024 * 1024; // Telegram's bot upload cap is 50 MB
const MAX_BYTES = (parseFloat(process.env.CLIP_SCAN_MAX_GB) || 2) * 1e9;
const MAX_SEC = (parseFloat(process.env.CLIP_SCAN_MAX_MIN) || 180) * 60;
const TRANSCRIPT_CHARS = 350000;

// The lock: who holds it ({ jid, title, url, startedAt }) or null. Taken and released inside clipScan only.
let holder = null;
const heldBy = (h) => `${h.title || h.url}${h.jid ? `, job ${h.jid}` : ''}, running ${mmss((Date.now() - h.startedAt) / 1000)}`;
// A holder whose job is no longer running in jobProgress is an orphan (nothing is working on it).
function orphan(h) {
  if (!h || !h.jid) return false; // still starting up, or job tracking is off: can't tell, so it counts as live
  try { return !require('./jobProgress').live().some((j) => String(j.id) === String(h.jid)); } catch { return false; }
}

// Checkpoints (owner, 2026-11-23: a restart must not cost a scan its download and
// transcript). Work happens in a directory keyed by the video, outside $TMPDIR's
// per-run folders: the downloaded audio/video, the transcript, the picks and each
// finished clip's upload are saved as they complete, and a rerun (the boot resume
// in server/jobProgress.js, or the same link sent again) skips every step whose
// output is already there and valid. Removed when the scan finishes; ones untouched
// for 2 days are pruned (`pruneJobDirs`).
const JOBS_DIR = process.env.CLIP_JOBS_DIR || path.join(os.homedir(), '.empire-bin', 'clip-jobs');
const JOB_DIR_MAX_AGE_MS = 2 * 24 * 3600e3;
function jobKey(url, focus = '') {
  const u = String(url).trim();
  const id = driveId(u) || (/youtu/.test(u) && (u.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/) || [])[1]);
  const h = require('crypto').createHash('sha1').update(`${u}|${String(focus || '').trim().toLowerCase()}`).digest('hex').slice(0, 10);
  return `${id ? String(id).replace(/[^\w-]/g, '') : 'x'}-${h}`; // the focus changes the picks, so it is part of the key
}
function pruneJobDirs(root = JOBS_DIR, now = Date.now()) {
  let n = 0;
  try {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d);
      try { if (now - fs.statSync(p).mtimeMs > JOB_DIR_MAX_AGE_MS) { fs.rmSync(p, { recursive: true, force: true }); n++; } } catch { /* gone already */ }
    }
  } catch { /* no directory yet */ }
  return n;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const writeJson = (f, v) => { try { fs.writeFileSync(f, JSON.stringify(v)); } catch (e) { console.warn(`clip scan: couldn't save a checkpoint (${e.message})`); } };

function enabled() { return String(process.env.CLIP_SCAN || '').toLowerCase() !== 'off'; }

function driveId(url) {
  const u = String(url || '');
  const m = u.match(/\/file\/d\/([\w-]{10,})/) || u.match(/[?&]id=([\w-]{10,})/) || u.match(/\/d\/([\w-]{10,})/);
  return m ? m[1] : null;
}

// youtube.com/watch, youtu.be, youtube.com/shorts (+ m./music./www.) -> true. One video only.
function isYouTube(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') return /^\/[\w-]{11}/.test(u.pathname);
  if (host !== 'youtube.com') return false;
  if (u.pathname === '/watch') return /^[\w-]{11}$/.test(u.searchParams.get('v') || '');
  return /^\/(shorts|live|embed)\/[\w-]{11}/.test(u.pathname);
}

// 'drive' | 'youtube' | null (neither: refused before any download).
function linkKind(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  if (driveId(u)) return 'drive';
  if (isYouTube(u)) return 'youtube';
  return null;
}

// yt-dlp's standalone Linux build (a self-contained binary — no Python needed,
// unlike the yt-dlp-exec npm package, whose install script needs Python and broke
// `npm ci` on the server). Fetched once on first YouTube use, cached in the tmp dir.
// YTDLP_PATH overrides; a yt-dlp already on PATH is the fallback.
const YTDLP_CACHE = path.join(os.tmpdir(), 'empire-bin', 'yt-dlp');
let ytdlpReady = null;
function ytdlpBin() {
  if (process.env.YTDLP_PATH) return Promise.resolve(process.env.YTDLP_PATH);
  if (!ytdlpReady) {
    ytdlpReady = (async () => {
      if (fs.existsSync(YTDLP_CACHE)) return YTDLP_CACHE;
      if (process.platform !== 'linux') return 'yt-dlp';
      const asset = process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
      const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
      if (!res.ok) throw new Error(`download ${res.status}`);
      fs.mkdirSync(path.dirname(YTDLP_CACHE), { recursive: true });
      const tmp = `${YTDLP_CACHE}.${process.pid}.part`;
      fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()), { mode: 0o755 });
      fs.renameSync(tmp, YTDLP_CACHE);
      return YTDLP_CACHE;
    })().catch((e) => { ytdlpReady = null; console.error('yt-dlp fetch failed:', e.message); return 'yt-dlp'; });
  }
  return ytdlpReady;
}

// Instagram (reels, posts, IGTV), TikTok and X (x.com / twitter.com status) links, also fetched with yt-dlp.
function isSocialVideo(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  if ((host === 'instagram.com' || host === 'instagr.am') && /^\/(?:[\w.]+\/)?(reel|reels|p|tv)\/[\w-]+/.test(u.pathname)) return 'instagram';
  if (['x.com', 'twitter.com', 'mobile.twitter.com', 'fxtwitter.com', 'vxtwitter.com'].includes(host) && /^\/(?:\w+\/status(?:es)?\/\d+|i\/(?:web\/)?status\/\d+)/.test(u.pathname)) return 'x';
  if ((host === 'tiktok.com' || host.endsWith('.tiktok.com')) && (/\/video\/\d+/.test(u.pathname) || /^(vm|vt)\./.test(host))) return 'tiktok';
  return null;
}

// Instagram often wants a logged-in session, and YouTube refuses logged-out
// downloads from the server's datacenter IP ("Sign in to confirm you're not a
// bot"). A cookies.txt for each is passed to yt-dlp when set:
// INSTAGRAM_COOKIES_FILE / YOUTUBE_COOKIES_FILE (a path) or INSTAGRAM_COOKIES /
// YOUTUBE_COOKIES (the cookies.txt text itself).
function cookieFile(name) {
  if (process.env[`${name}_FILE`]) return process.env[`${name}_FILE`];
  if (!process.env[name]) return null;
  const f = path.join(os.tmpdir(), 'empire-bin', `${name.toLowerCase()}.txt`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, process.env[name].replace(/\\n/g, '\n'), { mode: 0o600 });
  return f;
}
// Any youtube.com / youtu.be link: videos, channels, feeds.
const isYouTubeAny = (url) => /^https?:\/\/([\w-]+\.)?(youtube\.com|youtu\.be)\//i.test(String(url || '').trim());
// The site a link needs a login for: 'youtube' | 'instagram' | null.
const loginSite = (url) => (isSocialVideo(url) === 'instagram' ? 'instagram' : isSocialVideo(url) === 'x' ? 'x' : isYouTubeAny(url) ? 'youtube' : null);
// A cookies.txt he set wins; otherwise the one J.A.R.V.I.S.'s browser keeps signed in (siteLogins.js).
function cookieArgs(url) {
  const site = loginSite(url);
  const f = site === 'instagram' ? cookieFile('INSTAGRAM_COOKIES') : site === 'youtube' ? cookieFile('YOUTUBE_COOKIES') : site === 'x' ? cookieFile('X_COOKIES') : null;
  const g = f || (site && site !== 'x' ? require('./siteLogins').cookieFor(site) : null);
  return g ? ['--cookies', g] : [];
}
const hasYouTubeCookies = () => !!(process.env.YOUTUBE_COOKIES_FILE || process.env.YOUTUBE_COOKIES || require('./siteLogins').cookieFor('youtube') || require('./siteLogins').hasAccount('youtube'));
const isLoginWall = (msg) => /login required|log in|rate.?limit|empty media|checkpoint|cookies/i.test(String(msg || ''));
const isBotCheck = (msg) => /confirm you.?re not a bot|sign in to confirm/i.test(String(msg || ''));
function botCheckError(last) {
  const L = require('./siteLogins');
  return new Error(L.hasAccount('youtube') || L.cookieFor('youtube') || process.env.YOUTUBE_COOKIES || process.env.YOUTUBE_COOKIES_FILE
    ? `YouTube still blocked the server as a bot with a login in place, and signing back in didn't clear it (yt-dlp: ${last.slice(0, 120)})`
    : `YouTube blocked the server as a bot (it refuses logged-out downloads from datacenter IPs). A YouTube account on the server (YOUTUBE_LOGIN_EMAIL and YOUTUBE_LOGIN_PASSWORD, which J.A.R.V.I.S.'s browser signs in with), or a cookies.txt as YOUTUBE_COOKIES, fixes it (yt-dlp: ${last.slice(0, 120)})`);
}

// Every YouTube / Instagram read (channel lookups, length checks, downloads)
// carries the login. Refused for a login: J.A.R.V.I.S.'s browser signs in again
// (siteLogins.ensureLogin) and it's tried once more with the fresh one.
async function ytdlp(args, { retried = false } = {}) {
  const url = args.find((a) => loginSite(a));
  const site = url ? loginSite(url) : null;
  let full = args;
  if (url && !args.includes('--cookies')) full = [...cookieArgs(url), ...args];
  try { return await ytdlpOnce(full); } catch (e) {
    const wall = site === 'youtube' ? isBotCheck(e.raw || e.message) : site === 'instagram' && isLoginWall(e.raw || e.message);
    if (!wall || retried || args.includes('--cookies')) throw e;
    if (!(await require('./siteLogins').ensureLogin(site).catch(() => false))) throw e;
    // The fresh login, even if an older cookies.txt he set would normally win.
    const fresh = require('./siteLogins').cookieFor(site);
    return fresh ? ytdlpOnce(['--cookies', fresh, ...args]) : ytdlp(args, { retried: true });
  }
}
async function ytdlpOnce(args) {
  const bin = await ytdlpBin();
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['--no-playlist', '--no-warnings', '--ffmpeg-location', ffmpegPath, ...args]);
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    p.on('error', (e) => reject(new Error(`yt-dlp isn't available on this server (${e.message})`)));
    p.on('close', (code) => {
      if (code === 0) return resolve(out);
      const last = (err.trim().split('\n').pop() || `exit ${code}`).slice(0, 240);
      const err2 = isBotCheck(last) ? botCheckError(last) : new Error(`yt-dlp: ${last}`);
      err2.raw = last;
      reject(err2);
    });
  });
}

// YouTube URL -> local file at `dir`/source.<ext>. Checks duration before
// downloading and the size cap during it. Returns { file, name }.
async function downloadYouTube(url, dir) {
  let meta;
  try { meta = (await ytdlp(['--skip-download', '--print', '%(duration)s\n%(title)s', url])).split('\n'); }
  catch (e) {
    if (isSocialVideo(url) === 'instagram' && !cookieArgs(url).length && /login|cookie|empty media|rate.?limit|not available|private/i.test(e.message)) throw new Error(`Instagram wouldn't hand the video over without a login (${e.message.slice(0, 140)}). An Instagram account on the server (INSTAGRAM_LOGIN_USER and INSTAGRAM_LOGIN_PASSWORD, which J.A.R.V.I.S.'s browser signs in with) fixes that`);
    if (isSocialVideo(url) === 'x' && !cookieArgs(url).length && /login|log in|cookie|sign in|guest token|age.?restrict|nsfw|protected|not authorized|rate.?limit|no video|not available|status code 40[13]/i.test(e.message)) throw new Error(`X wouldn't hand the video over without a login (${e.message.slice(0, 140)}), or that post has no video. Set X_COOKIES (the cookies.txt text of a logged-in x.com session) or X_COOKIES_FILE (a path to it) on the server`);
    throw e;
  }
  const secs = Number(meta[0]);
  const name = (meta.slice(1).join(' ').trim() || (isSocialVideo(url) === 'instagram' ? 'Instagram video' : isSocialVideo(url) === 'tiktok' ? 'TikTok video' : isSocialVideo(url) === 'x' ? 'X video' : 'YouTube video'));
  if (Number.isFinite(secs) && secs > MAX_SEC) throw new Error(`that video is ${mmss(secs)} — the limit is ${mmss(MAX_SEC)}`);
  await ytdlp(['-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4', '--max-filesize', String(Math.floor(MAX_BYTES)),
    '-o', path.join(dir, 'source.%(ext)s'), url]);
  const file = fs.readdirSync(dir).find((f) => /^source\.(?!part|ytdl)/.test(f) && !f.endsWith('.part'));
  if (!file) throw new Error('the video is over the size limit or couldn\'t be downloaded');
  const full = path.join(dir, file);
  if (fs.statSync(full).size > MAX_BYTES) throw new Error('file is over the size limit');
  return { file: full, name };
}

// YouTube, the light way: the audio alone (a small fraction of the video) for the
// transcript and the loudness signal, then only the picked stretches as video.
// A multi-hour stream used to come down whole for a few minutes of clips.
// Over MAX_SEC (a 6-hour stream): only the MAX_SEC stretch viewers replayed most
// (signals.bestWindow; the start without a graph) comes down, and the scan runs on
// that. -> { file, name, offset, full } — offset = where the window starts.
async function downloadYouTubeAudio(url, dir, heatmap = null, deps = {}) {
  let meta;
  try { meta = (await (deps.ytdlp || ytdlp)(['--skip-download', '--print', '%(duration)s\n%(title)s', url])).split('\n'); } catch (e) { throw e; }
  const secs = Number(meta[0]);
  const name = meta.slice(1).join(' ').trim() || 'YouTube video';
  const win = Number.isFinite(secs) && secs > MAX_SEC ? signals.bestWindow(heatmap, secs, MAX_SEC, deps.chat) : null;
  const get = (extra, base = 'audio-src') => (deps.ytdlp || ytdlp)(['-f', 'ba[ext=m4a]/ba/b', '--max-filesize', String(Math.floor(MAX_BYTES)),
    ...extra, '-o', path.join(dir, `${base}.%(ext)s`), url]);
  const find = (base) => fs.readdirSync(dir).find((f) => new RegExp(`^${base}\\.(?!part|ytdl)`).test(f) && !f.endsWith('.part'));
  const dur = deps.duration || duration;
  let note = '';
  if (win && !(win.end > win.start)) throw new Error(`the stretch to scan came out empty (${win.start}-${win.end}s)`);
  if (!win) await get([]);
  else {
    // A section download of a long stream's audio can come back as an almost empty
    // file (Whisper then refuses it: "shorter than 0.1 seconds"). Check what came
    // down; if it's short, fetch the audio whole and cut the stretch with ffmpeg.
    const want = win.end - win.start;
    try { await (deps.proxy || withFfmpegProxy)((px) => get(['--download-sections', `*${win.start.toFixed(0)}-${win.end.toFixed(0)}`, ...px])); }
    catch (e) { note = `section download failed: ${e.message}`; }
    const f1 = find('audio-src');
    const got = f1 ? await dur(path.join(dir, f1)).catch(() => 0) : 0;
    if (!(got >= 0.9 * want)) {
      note = note || `section download returned ${f1 ? `${got.toFixed(1)}s` : 'no file'} of the ${Math.round(want)}s asked for`;
      if (f1) fs.rmSync(path.join(dir, f1), { force: true });
      await get([], 'audio-full');
      const ff = find('audio-full');
      if (!ff) throw new Error(`the video's audio couldn't be downloaded (${note})`);
      const full = path.join(dir, ff);
      const out = path.join(dir, `audio-src${path.extname(ff) || '.m4a'}`);
      await (deps.run || run)(['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(win.start), '-t', String(want), '-i', full, '-vn', '-c:a', 'copy', out]);
      fs.rmSync(full, { force: true });
      const cut = await dur(out).catch(() => 0);
      if (!(cut >= 0.9 * want)) throw new Error(`the audio for the ${mmss(want)} stretch at ${mmss(win.start)} came out ${cut.toFixed(1)}s long (${note}; cutting it from the whole audio gave ${cut.toFixed(1)}s)`);
    }
  }
  const file = find('audio-src');
  if (!file) throw new Error("the video's audio couldn't be downloaded");
  return { file: path.join(dir, file), name, offset: win ? win.start : 0, full: Number.isFinite(secs) ? secs : null, by: win ? win.by : null };
}
// --download-sections makes yt-dlp hand the stream URLs to ffmpeg itself, and the
// bundled ffmpeg-static (a static glibc build) segfaults on any hostname lookup on
// this VM: exit -11 before a byte is read (2026-11-22, every clip of a scan failed).
// So for those calls ffmpeg only dials 127.0.0.1: a local proxy, open just for
// that call, does the DNS and tunnels the connection (CONNECT for https).
async function withFfmpegProxy(fn) {
  const http = require('http');
  const net = require('net');
  const server = http.createServer((req, res) => { // plain http: absolute-URI requests
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400); return res.end(); }
    const up = http.request(u, { method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('connect', (req, sock, head) => {
    const i = req.url.lastIndexOf(':');
    const up = net.connect(Number(req.url.slice(i + 1)) || 443, req.url.slice(0, i).replace(/^\[|\]$/g, ''), () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  const sockets = new Set();
  server.on('connection', (c) => { sockets.add(c); c.on('close', () => sockets.delete(c)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    return await fn(['--downloader-args', `ffmpeg_i:-http_proxy http://127.0.0.1:${server.address().port}`]);
  } finally {
    server.close();
    for (const c of sockets) c.destroy();
  }
}
const SECTION_PAD = 3;
// The forced-keyframe cut re-encodes the whole stretch, and x264's default preset
// took ~8 min for 36 s of 720p60 on this VM. The render re-encodes it anyway, so
// this copy only has to be fast and near-lossless.
const SECTION_ENCODE = 'ffmpeg_o:-c:v libx264 -preset ultrafast -crf 18 -c:a aac';
// One stretch of a YouTube video, cut at exactly start-pad (keyframes forced at
// the cut), so the clip sits at SECTION_PAD seconds in. -> { file, offset }
async function downloadSection(url, start, end, dir, tag) {
  const from = Math.max(0, start - SECTION_PAD);
  const to = end + SECTION_PAD;
  await withFfmpegProxy((px) => ytdlp(['-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4', '--download-sections', `*${from.toFixed(2)}-${to.toFixed(2)}`,
    '--force-keyframes-at-cuts', ...px, '--downloader-args', SECTION_ENCODE, '-o', path.join(dir, `${tag}.%(ext)s`), url]));
  const file = fs.readdirSync(dir).find((f) => f.startsWith(`${tag}.`) && !/\.(part|ytdl)$/.test(f));
  if (!file) throw new Error("that stretch of the video couldn't be downloaded");
  return { file: path.join(dir, file), offset: start - from };
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

const MIN_CHUNK_SEC = 0.5; // shorter chunks are skipped, not sent to Whisper
// Whole recording -> [{ start, end, text }] with absolute seconds.
async function transcribeVideo(src, dir, opts) {
  await run(['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k',
    '-f', 'segment', '-segment_time', String(CHUNK_SEC), '-reset_timestamps', '1', path.join(dir, 'a%03d.mp3')]);
  const chunks = fs.readdirSync(dir).filter((f) => /^a\d+\.mp3$/.test(f)).sort();
  if (!chunks.length) throw new Error('no audio track in that video');
  const all = [];
  for (let i = 0; i < chunks.length; i++) {
    // An exact multiple of CHUNK_SEC leaves a trailing stub with no audio in it (measured: 512 bytes, no
    // duration); Whisper rejects it (audio_too_short) and that aborted the whole scan. Offsets keep the chunk index.
    const len = await duration(path.join(dir, chunks[i])).catch(() => 0);
    if (len < MIN_CHUNK_SEC) { console.warn(`clip scan: skipping ${chunks[i]}, only ${len.toFixed(2)}s of audio`); continue; }
    const segs = await transcribeSegments(fs.readFileSync(path.join(dir, chunks[i])), chunks[i], opts);
    for (const s of segs) all.push({ start: s.start + i * CHUNK_SEC, end: s.end + i * CHUNK_SEC, text: s.text });
  }
  return all;
}

const MIN_FUNNY = 7;      // the model's own 1-10 funniness rating; under this a candidate is dropped
const PICK_SYSTEM = `You are R.O.G.U.E., the Empire's video editor. You find ONLY the genuinely FUNNY moments in a long recording and cut them as vertical short-form clips (Reels / TikTok / Shorts). People only share and comment on a clip that makes them laugh, so a moment that merely reads well, is dramatic, or is "interesting" is NOT enough. You get a transcript with [mm:ss] timestamps and usually VIEWER SIGNALS: chat laughter (LMAO / KEKW / 💀 / 😂), laughter heard in the audio, laughing written in the transcript, most-replayed peaks, comment timestamps and audio jumps.
LAUGHTER IS THE EVIDENCE. Start from the signals that carry laughter (chat laughing, audio laughter, laughing in the transcript), strongest first. A chat full of LMAO/KEKW/💀 beats everything; a signal that is only hype (W, omg, bro), only volume, or only a loud audio jump is NOT proof of funny. Signals fire AFTER the funny thing, so the setup is usually 10-30 seconds earlier. Use the transcript to find where the setup starts and where the payoff lands. Add a moment the signals missed only when the words clearly carry a joke, a fail or a story with a punchline.
REJECT, do not list: rants, complaints, anger with no laugh, stat or progress talk ("four heists, zero money", "chat rates my skill 2/10" is not a joke by itself), explaining the game, slow gameplay, small talk, inside jokes that need the stream's context, hype with nothing funny, repeating the same joke twice, a story whose payoff is cut off. Someone being mad is not funny unless chat or the room is clearly laughing at it.
Each clip must have: (1) a clear SETUP and PAYOFF both inside the clip, 15 to 45 seconds total (shorter is funnier if the payoff lands; never ${MAX_CLIP}+ unless truly needed; at least ${MIN_CLIP}); (2) a reaction peak (laughing, screaming, shock, chat exploding); (3) something a cold viewer who never saw the stream gets with no context; (4) a hook in the first 2 seconds, so start AT or just before the setup; (5) the end 1-3 seconds after the laugh. Don't overlap clips. Use only timestamps that exist in the transcript.
SCORE EVERY CANDIDATE: "funny" is an honest 1-10 (10 = people will quote it; 7 = a stranger would genuinely laugh; 5 = amusing to fans; 3 = interesting, not funny), "funny_why" is one line: the setup, the payoff and which laughter signal backs it. Only list candidates that are 7 or higher. FEWER IS BETTER: if only two moments are really funny, return two; if none is, return []. Never pad the list with weaker ones to reach a number (at most ${MAX_CANDIDATES}).
Reply with ONLY a JSON array, best first: [{"start": seconds, "end": seconds, "title": "3-6 word label", "reason": "one line: what the setup and payoff are, and which signal backs it", "funny": 1-10, "funny_why": "one line", "score": 1-100 (how likely a stranger laughs and shares), "hook": "the line shown at the top of the clip", "keywords": ["2-5 words said in the clip to color"]}]. The HOOK is the most important text: it makes a stranger need to see what happens ("Kai went ALL IN on one GTA stock", never "Kai plays GTA"). For each clip write five hooks in your head and give only the strongest: 3-9 words, plain words, no hashtags, no emoji, no quotation marks, never giving away the ending. KEYWORDS are 2-5 single words actually spoken in that clip that carry it (a number, a name, the punchline word). Nothing else.`;

async function pickMoments(segments, focus, total, hot = []) {
  let text = segments.map((s) => `[${mmss(s.start)}] ${s.text.trim()}`).join('\n');
  if (text.length > TRANSCRIPT_CHARS) text = text.slice(0, TRANSCRIPT_CHARS) + '\n[transcript truncated]';
  const sig = hot.length ? `VIEWER SIGNALS, strongest first (window, strength 0-100, evidence):\n${hot.map((h) => `- ${mmss(h.start)}${h.end > h.start ? `–${mmss(h.end)}` : ''} · ${h.score} · ${h.why}`).join('\n')}\n\n` : '';
  const prompt = `${focus ? `FOCUS: ${focus}. Only pick moments that fit this.\n\n` : ''}Recording length ${mmss(total)}.\n\n${sig}TRANSCRIPT:\n${text}`;
  const raw = await claudeText(PICK_SYSTEM, prompt, { maxTokens: 3500 });
  return funnyOnly(sanitizePicks(parsePicks(raw), total, MAX_CANDIDATES));
}

// The model rates each candidate 1-10; under MIN_FUNNY is dropped, the rest rank by that rating
// (a candidate with no rating, i.e. a model that ignored the field, counts as 5 and is dropped too).
function funnyOnly(picks, min = MIN_FUNNY) {
  return picks.filter((p) => (p.funny || 5) >= min).map((p) => ({ ...p, reason: `${p.reason}${p.funnyWhy ? ` · funny ${p.funny}/10: ${p.funnyWhy}` : ` · funny ${p.funny}/10`}`.slice(0, 300) })).sort((a, b) => (b.funny || 0) - (a.funny || 0) || b.score - a.score);
}

function parsePicks(raw) {
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (!m) throw new Error('the model returned no clip list');
  const arr = JSON.parse(m[0]);
  if (!Array.isArray(arr)) throw new Error('the model returned no clip list');
  return arr;
}

// Clamp to the recording and to clip length, drop overlaps, keep the best few in rank order.
function sanitizePicks(arr, total, limit = MAX_PICKS) {
  const out = [];
  const ranked = arr
    .map((p) => ({ start: Number(p.start), end: Number(p.end), title: String(p.title || '').slice(0, 60), reason: String(p.reason || '').slice(0, 240), score: Number(p.score) || 0, funny: Math.max(0, Math.min(10, Number(p.funny) || 0)), funnyWhy: String(p.funny_why || p.funnyWhy || '').slice(0, 200),
      hook: String(p.hook || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70),
      keywords: (Array.isArray(p.keywords) ? p.keywords : []).map((k) => String(k).trim()).filter((k) => k && !/\s/.test(k)).slice(0, 6) }))
    .filter((p) => Number.isFinite(p.start) && Number.isFinite(p.end) && p.end > p.start)
    .sort((a, b) => b.score - a.score);
  for (const p of ranked) {
    p.start = Math.max(0, p.start);
    p.end = Math.min(total || p.end, p.end);
    if (p.end - p.start > MAX_CLIP) p.end = p.start + MAX_CLIP;
    if (p.end - p.start < MIN_CLIP) continue;
    if (out.some((q) => p.start < q.end && q.start < p.end)) continue;
    out.push(p);
    if (out.length >= limit) break;
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
async function clipScan(url, focus = '', { onProgress = () => {}, title = '' } = {}) {
  if (!enabled()) throw new Error('clip scan is switched off (CLIP_SCAN=off)');
  if (holder && orphan(holder)) {
    console.error(`clip scan failed: stale lock released (held by ${heldBy(holder)}; its job is not running)`);
    holder = null;
  }
  if (holder) throw new Error(`a clip scan is already running (${heldBy(holder)}) — one at a time; wait for it to finish`);
  const kind = linkKind(url);
  if (!kind) throw new Error('needs a Google Drive link or a YouTube URL (youtube.com/watch, youtu.be, youtube.com/shorts)');
  const mine = holder = { jid: null, title: String(title || ''), url: String(url).trim(), startedAt: Date.now() };
  let dir, chatP = null, ok = false, jid = null, jobs = null, why = 'failed';
  console.log(`clip scan: start ${mine.url}`);
  try {
    pruneJobDirs();
    dir = path.join(JOBS_DIR, jobKey(url, focus));
    fs.mkdirSync(dir, { recursive: true });
    const stamp = () => { try { const t = new Date(); fs.utimesSync(dir, t, t); } catch { /* best effort */ } };
    stamp();
    const ck = (n) => path.join(dir, n);
    const state = readJson(ck('state.json')) || {};
    const saveState = (patch) => { Object.assign(state, patch); writeJson(ck('state.json'), state); stamp(); };
    // Stale leftovers from a cut-off run (half-downloaded sections, chunks) go; checkpoints stay.
    for (const f of fs.readdirSync(dir)) if (/^(cand|section)\d+\./.test(f) || /^a\d+\.mp3$/.test(f) || /^chat/.test(f) || /\.(part|ytdl)$/.test(f)) fs.rmSync(ck(f), { recursive: true, force: true });
    // Live progress (server/jobProgress.js): auto clips pass their own title.
    jobs = require('./jobProgress');
    jid = jobs.start('rogue', title || `Clip scan: ${String(url).replace(/^https?:\/\/(www\.)?/, '').slice(0, 45)}`, ['Download audio', 'Transcribe', 'Pick moments', 'Download sections', 'Render each clip', 'Upload'],
      { kind: 'clip_scan', args: { url: String(url).trim(), focus: String(focus || ''), title }, to: 'rogue' });
    mine.jid = jid;
    let src = path.join(dir, 'source');
    let name;
    // Viewer signals: metadata (most-replayed graph, top comments) before the download.
    let meta = null;
    const sigNotes = [];
    if (kind === 'youtube') {
      onProgress('reading viewer signals');
      meta = await signals.youtubeMeta(await ytdlpBin(), String(url).trim(), cookieArgs(url))
        .catch((e) => { sigNotes.push(`no YouTube metadata (${e.message})`); return null; });
    }
    chatP = meta ? signals.startChat({ ytdlpBin: await ytdlpBin(), url: String(url).trim(), dir, ytdlpArgs: cookieArgs(url), meta }) : null;
    // YouTube: audio only now, video only for the picked stretches (below).
    // SECTIONS=off goes back to downloading the whole video.
    const sections = kind === 'youtube' && String(process.env.CLIP_SECTIONS || '').toLowerCase() !== 'off';
    onProgress(sections ? 'downloading the audio' : 'downloading');
    jobs.step(jid, 'Download audio');
    let offset = 0, full = null, windowBy = null;
    const have = state.source && fs.existsSync(ck(state.source.file)) ? await duration(ck(state.source.file)).catch(() => 0) : 0;
    if (have > 0 && (!state.source.total || have >= 0.95 * state.source.total)) {
      // Resumed: the download finished before the restart.
      ({ name, offset, full } = state.source); src = ck(state.source.file);
      onProgress('download already done, resuming');
    } else {
      if (sections) {
        // A stream over the limit with no most-replayed graph: pick the 3 h by chat laughter, which
        // needs the chat read first (it started above; a partial read covers its first part only).
        let chat = null;
        if (chatP && meta && Number(meta.duration) > MAX_SEC && !(meta.heatmap && meta.heatmap.length)) {
          onProgress('reading the chat to find the funniest stretch');
          chat = await chatP.catch(() => null);
        }
        ({ file: src, name, offset, full, by: windowBy } = await downloadYouTubeAudio(String(url).trim(), dir, meta && meta.heatmap, { chat }));
      }
      else if (kind === 'youtube') ({ file: src, name } = await downloadYouTube(String(url).trim(), dir));
      else name = await google.driveDownloadTo(driveId(url), src, MAX_BYTES);
    }
    const total = await duration(src);
    if (total) saveState({ source: { file: path.basename(src), name, offset, full, total } });
    if (!total) throw new Error(`couldn't read that file as ${sections ? 'audio' : 'a video'}`);
    if (total > MAX_SEC + 60) throw new Error(`that video is ${mmss(total)} — the limit is ${mmss(MAX_SEC)}`);
    if (offset || (full && full > MAX_SEC)) sigNotes.push(`the video is ${mmss(full)}, over the ${mmss(MAX_SEC)} limit, so only ${mmss(offset)}–${mmss(offset + total)} was scanned${windowBy === 'chat laughter' ? ', the stretch with the most chat laughter' : meta && meta.heatmap && meta.heatmap.length ? ', the stretch viewers replayed most' : ', from the start (no most-replayed graph and no chat laughter found)'}`);

    onProgress('transcribing');
    jobs.step(jid, 'Transcribe');
    const audioDir = path.join(dir, 'audio');
    fs.rmSync(audioDir, { recursive: true, force: true });
    fs.mkdirSync(audioDir);
    let segments = readJson(ck('transcript.json'));
    if (Array.isArray(segments) && segments.length && state.transcriptOf === path.basename(src)) onProgress('transcript already done, resuming');
    else {
      segments = await transcribeVideo(src, audioDir, { prompt: '', job: /^Auto clip:/.test(title) ? 'auto clip' : 'clip scan' });
      if (!segments.length) throw new Error('no speech found in that video');
      writeJson(ck('transcript.json'), segments);
      saveState({ transcriptOf: path.basename(src) });
    }

    const sectionCache = new Map();   // "start-end" -> { file, offset }, reused by the render below
    let sig = { hot: [], used: [], notes: [] };
    let picks;
    if (Array.isArray(state.picks) && state.picks.length && state.transcriptOf === path.basename(src)) {
      // Resumed: the moments were already picked (and checked on video) before the restart.
      onProgress('moments already picked, resuming');
      picks = state.picks; sig = { hot: [], used: state.sigUsed || [], notes: [] }; sigNotes.push(...(state.sigNotes || []));
    } else {
      onProgress('reading viewer signals');
      sig = await signals.gather({ kind, segments, url: String(url).trim(), src, dir, ytdlpBin: await ytdlpBin(), ytdlpArgs: cookieArgs(url), total, meta, chat: chatP, offset, full: full || total })
        .catch((e) => ({ hot: [], used: [], notes: [`signals failed (${e.message})`] }));
      sigNotes.push(...sig.notes);

      onProgress('picking');
      jobs.step(jid, 'Pick moments');
      const cands = await pickMoments(segments, String(focus || '').trim(), total, sig.hot);
      // Viewer hot spots the model passed over come back as candidates (not under a focus: they can't be matched to it).
      if (!String(focus || '').trim()) cands.push(...judge.seedCandidates(sig.hot.filter((h) => h.laugh > 0), cands, segments, total).slice(0, Math.max(0, MAX_CANDIDATES - cands.length)));
      // Second opinion: frames of the top candidates through the vision chain (CLIP_VISION=off skips it).
      picks = cands.slice(0, MAX_PICKS);
      if (cands.length && String(process.env.CLIP_VISION || '').toLowerCase() !== 'off') {
        onProgress('checking the top moments');
        jobs.step(jid, 'Check moments');
        cands.sort((a, b) => b.score - a.score);
        const judgements = cands.map(() => null);
        let failed = '';
        for (let i = 0; i < Math.min(cands.length, judge.VISION_MAX) && !failed.startsWith('stop'); i++) {
          const c = cands[i];
          try {
            let file = src, from = c.start;
            if (sections) {
              const sec = await downloadSection(String(url).trim(), c.start + offset, c.end + offset, dir, `cand${i + 1}`);
              sectionCache.set(`${c.start}-${c.end}`, sec);
              file = sec.file; from = sec.offset;
            }
            const words = segments.filter((x) => x.end > c.start && x.start < c.end).map((x) => x.text.trim()).join(' ');
            judgements[i] = await judge.judgeCandidate(file, from, c, words, dir, `cand${i + 1}`);
          } catch (e) {
            failed = `${failed ? failed + '; ' : ''}${e.message.slice(0, 80)}`;
            if (/no vision/.test(e.message)) failed = 'stop: ' + failed;
          }
        }
        if (judgements.some(Boolean)) {
          picks = judge.rerank(cands, judgements, { max: MAX_PICKS });
          sigNotes.push(`${judgements.filter(Boolean).length} of ${cands.length} candidate moments checked on video for laughs and reactions`);
        } else if (failed) sigNotes.push(`video check skipped (${failed.replace(/^stop: /, '')})`);
        // Candidates that didn't make the cut: free their section files.
        for (const [k, sec] of sectionCache) if (!picks.some((p) => `${p.start}-${p.end}` === k)) { fs.rmSync(sec.file, { force: true }); sectionCache.delete(k); }
      }
      if (!picks.length) throw new Error('no moment in it was strong enough to cut' + (focus ? ` for "${focus}"` : ''));
      saveState({ picks, sigNotes: [...sigNotes], sigUsed: sig.used });

    }
    // One download / render / upload step per clip, so the percent moves clip by clip.
    jobs.plan(jid, ['Download audio', 'Transcribe', 'Pick moments', 'Check moments', ...picks.flatMap((_, i) => [...(sections ? [`Download section ${i + 1}`] : []), `Render clip ${i + 1}`, `Upload clip ${i + 1}`]), 'Finish'], 4);
    const base = String(name).replace(/\.[^.]+$/, '').slice(0, 60);
    const srcSize = sections ? null : await layout.videoSize(src);
    const lines = [];
    const media = [];
    for (let i = 0; i < picks.length; i++) {
      const p = picks[i];
      const range = `${mmss(p.start + offset)}–${mmss(p.end + offset)}`;
      onProgress(`cutting ${i + 1}/${picks.length}`);
      const out = path.join(dir, `clip${i + 1}.mp4`);
      const doneClip = state.clips && state.clips[i];
      if (doneClip && doneClip.range === range) {
        // Resumed: this clip was already uploaded before the restart.
        jobs.step(jid, `Upload clip ${i + 1}`);
        lines.push(doneClip.line);
        if (fs.existsSync(out) && fs.statSync(out).size <= TG_VIDEO_MAX) media.push({ name: 'SEND_VIDEO', buffer: fs.readFileSync(out), filename: `clip${i + 1}.mp4`, caption: `${i + 1}. ${p.hook || range} — ${p.reason}`.slice(0, 1000) });
        continue;
      }
      try {
        let look = '';
        // The clip's own source: just that stretch of the video, when sectioned.
        let clipSrc = src, cs = p.start, ce = p.end, clipSize = srcSize;
        if (sections) {
          onProgress(`downloading clip ${i + 1}/${picks.length}`);
          jobs.step(jid, `Download section ${i + 1}`);
          const sec = sectionCache.get(`${p.start}-${p.end}`) || await downloadSection(String(url).trim(), p.start + offset, p.end + offset, dir, `section${i + 1}`);
          clipSrc = sec.file; cs = sec.offset; ce = sec.offset + (p.end - p.start);
          clipSize = await layout.videoSize(clipSrc);
        }
        jobs.step(jid, `Render clip ${i + 1}`);
        try {
          const r = await layout.renderClip({ src: clipSrc, start: cs, end: ce, dest: out, dir, pick: p, size: clipSize,
            context: segments.filter((s) => s.end > p.start - 20 && s.start < p.end).map((s) => s.text.trim()).join(' ') });
          look = `${LAYOUT_WORDS[r.layout] || r.layout}${r.captions ? ', captions' : ''}${p.hook ? ', hook' : ''}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`;
        } catch (e) {
          await cutVertical(clipSrc, cs, ce, out);
          look = `plain crop (the styled render failed: ${e.message.slice(0, 120)})`;
        }
        if (sections) fs.rmSync(clipSrc, { force: true });
        const size = fs.statSync(out).size;
        jobs.step(jid, `Upload clip ${i + 1}`);
        const up = await google.driveUploadFile(out, `Clip ${i + 1} — ${p.title || base} (${range}).mp4`);
        lines.push(`${i + 1}. ${range} (${Math.round(p.end - p.start)}s) — ${p.title ? `${p.title}: ` : ''}${p.reason}${p.hook ? `\n   Hook: "${p.hook}"` : ''}\n   ${look}\n   ${up.link}`);
        saveState({ clips: Object.assign(state.clips || {}, { [i]: { range, line: lines[lines.length - 1] } }) });
        if (size <= TG_VIDEO_MAX) media.push({ name: 'SEND_VIDEO', buffer: fs.readFileSync(out), filename: `clip${i + 1}.mp4`, caption: `${i + 1}. ${p.hook || range} — ${p.reason}`.slice(0, 1000) });
      } catch (e) {
        lines.push(`${i + 1}. ${range} — ${p.reason}\n   ⚠️ couldn't render this one: ${e.message.slice(0, 160)}`);
      }
    }
    const head = `CLIP SCAN — "${base}" (${mmss(total)}), ${picks.length} moment${picks.length === 1 ? '' : 's'}${focus ? ` for "${focus}"` : ''}, best first. Picked from ${sig.used.length ? `${sig.used.join(', ')} + the transcript` : 'the transcript alone'}${sigNotes.length ? ` (${sigNotes.join('; ')})` : ''}. Each is a finished 9:16 clip (layout to the shot, word-by-word captions, hook on top), uploaded to his Drive:`;
    const out = { text: `${head}\n${lines.join('\n')}\nEach can still go through [EDIT_CLIP: <its link> | brief] for captions, music or S.E.L.E.N.E.'s dress-up.`, media };
    jobs.done(jid, `${picks.length} moment(s)`);
    ok = true;
    return out;
  } catch (e) {
    why = `failed: ${String((e && e.message) || e).slice(0, 200)}`;
    if (jobs && jid) jobs.fail(jid, e);
    throw e;
  } finally {
    if (holder === mine) holder = null;
    console.log(`clip scan: end ${mine.url} (job ${jid || 'none'}) ${ok ? 'ok' : why}`);
    if (chatP && chatP.stop) chatP.stop();
    // Done: nothing to resume. A failure keeps the checkpoints (the same link sent
    // again, or the boot resume, picks them up); pruneJobDirs clears them after 2 days.
    if (ok && dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Fire-and-forget for the app: runs the scan and delivers the result on
// Telegram through A.R.A. (list as text, then each clip as a video).
function scanInBackground(url, focus, opts = {}) {
  clipScan(url, focus, opts).then(async ({ text, media }) => {
    const telegram = require('./telegram');
    const ara = telegram.botFor('ara');
    if (ara && ara.isConfigured()) {
      await ara.sendMessage(telegram.OWNER_ID, `🎬 **R.O.G.U.E. → A.R.A.**\n${text}`, { remember: true });
      for (const m of media) await ara.sendFile(telegram.OWNER_ID, 'video', m.buffer, { filename: m.filename, caption: m.caption }).catch((e) => console.error('clip-scan send failed:', e.message));
    }
    await require('./pushSender').pushAlert('clip-scan', 'R.O.G.U.E. found your clips', text.split('\n')[0], {}).catch(() => {});
  }).catch(async (e) => {
    console.error('clip-scan failed:', e.message);
    const telegram = require('./telegram');
    const ara = telegram.botFor('ara');
    if (ara && ara.isConfigured()) await ara.sendMessage(telegram.OWNER_ID, `🎬 R.O.G.U.E.'s clip scan failed: ${e.message}`, { remember: true }).catch(() => {});
  });
}

const CLIP_TOOLS = ` - [CLIP_SCAN: drive link or YouTube URL | focus] — for a LONG video (podcast, stream, full recording): it reads what viewers already showed (YouTube's most-replayed graph, timestamps quoted in the comments, a past livestream's chat spikes, jumps in the audio), transcribes it, picks the 3-5 most viral moments (focus is optional, e.g. "funniest moments", "best trading calls"; blank = general virality), cut each into a finished 9:16 short (face cam on top and gameplay below for streams, a crop that follows the speaker for one person on camera, the full frame over a blurred background otherwise; word-by-word captions with key words colored; a hook line at the top) and upload them to his Drive. Takes several minutes; the ranked list (time range, why, link) and the clips themselves come back in this chat. Use it BEFORE [EDIT_CLIP] when the footage is long-form and he hasn't picked the moment; [EDIT_CLIP] on any one clip after that for captions, music, dress-up. One per turn, one scan at a time. Say it's done only from the result.`;

// Length and live state of one video, before deciding to scan it.
async function videoInfo(url) {
  const [d, live, tagsJson] = (await ytdlp(['--skip-download', '--print', '%(duration)s\n%(live_status)s\n%(tags)j', String(url).trim()])).split('\n').map((x) => x.trim());
  let tags = []; try { const j = JSON.parse(tagsJson || '[]'); if (Array.isArray(j)) tags = j.map(String); } catch {}
  return { duration: Number(d) || 0, live: /is_live|is_upcoming/.test(live || ''), tags };
}

module.exports = { _lock: { get: () => holder, set: (h) => { holder = h; } }, PICK_SYSTEM, MAX_CANDIDATES, MIN_FUNNY, funnyOnly, pickMoments, downloadYouTubeAudio, downloadSection, withFfmpegProxy, SECTION_PAD, ytdlp, cookieArgs, isBotCheck, hasYouTubeCookies, videoInfo, clipScan, scanInBackground, jobKey, pruneJobDirs, JOBS_DIR, CLIP_TOOLS, driveId, isYouTube, isSocialVideo, linkKind, downloadYouTube, transcribeVideo, duration, MIN_CHUNK_SEC, MAX_BYTES, MAX_SEC, parsePicks, sanitizePicks, mmss };
