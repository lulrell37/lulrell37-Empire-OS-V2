// What viewers already told us about a video, so R.O.G.U.E.'s clip scan doesn't
// pick from the transcript alone. Each source is optional and fails soft:
//   - replayed:  YouTube's "Most replayed" heatmap (yt-dlp's `heatmap`), only on
//                videos with enough views
//   - comments:  timestamps quoted in the top comments ("4:32 I'm dead")
//   - chat:      a past livestream's chat replay: message rate per 15 s and
//                reaction words (LMAO, 💀, W…), spikes against the rolling norm
//   - loud:      audio energy jumps (any video, his own uploads included)
// `hotspots()` merges them into ranked windows the picker is told to prefer;
// the transcript still decides where each clip starts and ends.
// node server/scripts/test-clip-signals.js.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const COMMENTS = Number(process.env.CLIP_SCAN_COMMENTS || 400);
const CHAT_BUCKET = 15;
const LOUD_BUCKET = 2;
const MAX_HOT = 15;

function runBin(bin, args, { timeout = 120e3, stdout = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = '', err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`timed out after ${Math.round(timeout / 1000)}s`)); }, timeout);
    if (stdout) p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err = (err + c).slice(-1500); });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(out) : reject(new Error((err.trim().split('\n').pop() || `exit ${code}`).slice(0, 200))); });
  });
}

// --- parsing (pure) -------------------------------------------------------

// "4:32", "1:02:05" inside a comment -> seconds (only ones inside the video).
function commentTimestamps(text, total) {
  const out = [];
  const re = /(?:^|[^\d:])((?:(\d{1,2}):)?(\d{1,2}):(\d{2}))(?![\d:])/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const s = (Number(m[2]) || 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
    if (Number(m[4]) < 60 && (!total || s < total)) out.push(s);
  }
  return [...new Set(out)];
}

// [{text, like_count}] -> [{t, n, likes}] per 10 s, most-cited first.
function commentHits(comments, total) {
  const b = new Map();
  for (const c of comments || []) {
    for (const s of commentTimestamps(c.text, total)) {
      const k = Math.floor(s / 10) * 10;
      const cur = b.get(k) || { t: k, n: 0, likes: 0 };
      cur.n++; cur.likes += Number(c.like_count) || 0;
      b.set(k, cur);
    }
  }
  return [...b.values()].sort((a, c) => (c.n + Math.log10(1 + c.likes)) - (a.n + Math.log10(1 + a.likes)));
}

// yt-dlp heatmap [{start_time,end_time,value}] -> peaks [{t, end, value}]. The
// opening always tops the graph (everyone starts there) and the end often jumps
// (skips to the end), so both are left out; a peak is a local high at least
// twice the graph's median, scored against the highest of the rest.
function heatPeaks(heatmap) {
  const h = (heatmap || []).filter((x) => Number.isFinite(x.value) && Number.isFinite(x.start_time));
  if (h.length < 5) return [];
  const total = h[h.length - 1].end_time || h[h.length - 1].start_time;
  const body = h.filter((x) => x.start_time >= Math.max(5, total * 0.02) && x.end_time <= total * 0.97);
  if (!body.length) return [];
  const sorted = body.map((x) => x.value).sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)], top = sorted[sorted.length - 1];
  const out = [];
  for (let i = 0; i < body.length; i++) {
    const v = body[i].value, prev = body[i - 1]?.value ?? 0, next = body[i + 1]?.value ?? 0;
    if (v >= 0.1 && v >= 2 * med && v >= prev && v >= next) out.push({ t: body[i].start_time, end: body[i].end_time, value: +(v / top).toFixed(2), x: +(v / Math.max(med, 1e-6)).toFixed(1) });
  }
  return out.sort((a, b) => b.value - a.value);
}

const REACT = /\b(lmf?ao+|lo+l+|ha(ha)+|omg+|no wa+y+|bro+|w+|clip (it|that)|wtf|yo+o+)\b|😂|🤣|💀|😭|🔥|😱|‼️|❗/gi;

// Live chat replay lines -> [{t, n, react}] per 15 s.
function chatBuckets(lines) {
  const b = new Map();
  for (const line of lines) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const a = j.replayChatItemAction;
    const ms = Number(a?.videoOffsetTimeMsec);
    if (!Number.isFinite(ms)) continue;
    const item = a.actions?.[0]?.addChatItemAction?.item?.liveChatTextMessageRenderer;
    if (!item) continue;
    const text = (item.message?.runs || []).map((r) => r.text || r.emoji?.shortcuts?.[0] || r.emoji?.emojiId || '').join('');
    const k = Math.floor(ms / 1000 / CHAT_BUCKET) * CHAT_BUCKET;
    const cur = b.get(k) || { t: k, n: 0, react: 0 };
    cur.n++; cur.react += (text.match(REACT) || []).length;
    b.set(k, cur);
  }
  return [...b.values()].sort((a, c) => a.t - c.t);
}

// Buckets [{t, v}] in time order -> spikes [{t, ratio}] where v is 2.5x+ the
// median of the surrounding ~5 minutes (and above a floor).
function spikes(series, { window = 20, ratio = 2.5, floor = 0 } = {}) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const near = series.slice(Math.max(0, i - window), i + window + 1).map((x) => x.v).sort((a, b) => a - b);
    const med = near[Math.floor(near.length / 2)] || 0;
    const v = series[i].v;
    if (v > floor && v >= ratio * Math.max(med, 1e-6) && (!series[i - 1] || v >= series[i - 1].v) && (!series[i + 1] || v >= series[i + 1].v)) {
      out.push({ t: series[i].t, ratio: +(v / Math.max(med, 1e-6)).toFixed(1) });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

// --- fetching (each fails soft) --------------------------------------------

// One yt-dlp call: metadata, heatmap and top comments.
async function youtubeMeta(ytdlpBin, url, extraArgs = []) {
  const args = [...extraArgs, '--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json'];
  if (COMMENTS > 0) args.push('--write-comments', '--extractor-args', `youtube:max_comments=${COMMENTS},all,0,0;comment_sort=top`);
  return JSON.parse(await runBin(ytdlpBin, [...args, url], { timeout: 150e3 }));
}

// A long stream's chat can take minutes to page through, so it runs alongside the
// download and transcription; if it's still going at the timeout, whatever part
// came in is used (and said so).
async function liveChat(ytdlpBin, url, dir, extraArgs = [], timeout = 600e3) {
  const cdir = path.join(dir, 'chat');
  fs.mkdirSync(cdir, { recursive: true });
  let partial = false;
  try {
    await runBin(ytdlpBin, [...extraArgs, '--no-playlist', '--no-warnings', '--skip-download', '--write-subs', '--sub-langs', 'live_chat',
      '-o', path.join(cdir, 'chat.%(ext)s'), url], { timeout, stdout: false });
  } catch (e) {
    if (!/timed out/.test(e.message)) throw e;
    partial = true;
  }
  const f = fs.readdirSync(cdir).find((x) => /live_chat\.json(\.part)?$/.test(x));
  if (!f) { if (partial) throw new Error('timed out before any chat came in'); return null; }
  const b = chatBuckets(fs.readFileSync(path.join(cdir, f), 'utf8').split('\n'));
  b.partial = partial;
  return b;
}

// Start the chat read early (call right after the metadata); gather() awaits it.
function startChat({ ytdlpBin, url, dir, ytdlpArgs = [], meta }) {
  if (!meta || !(meta.was_live || meta.live_status === 'was_live')) return null;
  const pr = liveChat(ytdlpBin, url, dir, ytdlpArgs);
  pr.catch(() => {});
  return pr;
}

// Mono 8 kHz PCM from ffmpeg -> loudness (dB) per 2 s.
function loudness(src, timeout = 300e3) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const per = 8000 * LOUD_BUCKET;
    const out = [];
    let sum = 0, n = 0, carry = null;
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('audio read timed out')); }, timeout);
    p.stdout.on('data', (buf) => {
      if (carry) { buf = Buffer.concat([carry, buf]); carry = null; }
      const len = buf.length - (buf.length % 2);
      if (len < buf.length) carry = buf.subarray(len);
      for (let i = 0; i < len; i += 2) {
        const s = buf.readInt16LE(i) / 32768;
        sum += s * s; n++;
        if (n === per) { out.push({ t: out.length * LOUD_BUCKET, v: 10 * Math.log10(sum / n + 1e-10) }); sum = 0; n = 0; }
      }
    });
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}

// dB series -> spikes: 6 dB+ over the surrounding minute's median.
function loudSpikes(series) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const near = series.slice(Math.max(0, i - 30), i + 31).map((x) => x.v).sort((a, b) => a - b);
    const med = near[Math.floor(near.length / 2)];
    const d = series[i].v - med;
    if (d >= 6 && series[i].v > -40 && (!series[i - 1] || series[i].v >= series[i - 1].v) && (!series[i + 1] || series[i].v >= series[i + 1].v)) out.push({ t: series[i].t, db: +d.toFixed(1) });
  }
  return out.sort((a, b) => b.db - a.db);
}

// --- merging ---------------------------------------------------------------

// Every source's hits -> up to MAX_HOT windows, each with a 0-100 strength and
// the evidence in words. Hits within 20 s merge into one window.
function hotspots({ replayed = [], comments = [], chat = [], loud = [] }) {
  const hits = [];
  for (const p of replayed.slice(0, 10)) hits.push({ t: p.t, w: 40 + 50 * p.value, why: `most replayed (${p.x}x the video's norm)` });
  for (const c of comments.slice(0, 10)) if (c.n >= 1) hits.push({ t: c.t, w: Math.min(85, 30 + 15 * c.n + 5 * Math.log10(1 + c.likes)), why: `${c.n} comment${c.n === 1 ? '' : 's'} cite it${c.likes ? ` (${c.likes} likes)` : ''}` });
  for (const s of chat.slice(0, 12)) hits.push({ t: s.t, w: Math.min(85, 25 + 12 * s.ratio), why: `chat x${s.ratio}${s.react ? `, ${s.react} reactions` : ''}` });
  for (const l of loud.slice(0, 10)) hits.push({ t: l.t, w: Math.min(45, 15 + 3 * l.db), why: `audio +${l.db} dB` });
  hits.sort((a, b) => a.t - b.t);
  const wins = [];
  for (const h of hits) {
    const last = wins[wins.length - 1];
    if (last && h.t - last.end <= 20) { last.end = Math.max(last.end, h.t); last.parts.push(h); }
    else wins.push({ start: h.t, end: h.t, parts: [h] });
  }
  return wins.map((w) => {
    // Strongest signal plus a bonus for each other kind that agrees.
    const best = Math.max(...w.parts.map((p) => p.w));
    const kinds = new Set(w.parts.map((p) => p.why.split(' ')[0])).size;
    return { start: w.start, end: w.end, score: Math.round(Math.min(100, best + 8 * (kinds - 1))), why: [...new Set(w.parts.map((p) => p.why))].join('; ') };
  }).sort((a, b) => b.score - a.score).slice(0, MAX_HOT);
}

// The signals for one video. `kind` is the clip scan's link kind; `src` the
// downloaded file (for audio). Returns { hot, used: [...], notes: [...] }.
async function gather({ kind, url, src, dir, ytdlpBin, ytdlpArgs = [], total, meta, chat = undefined }) {
  const used = [], notes = [];
  const sig = {};
  if (kind === 'youtube' && meta) {
    sig.replayed = heatPeaks(meta.heatmap);
    if (sig.replayed.length) used.push('most-replayed graph'); else notes.push('no most-replayed graph (too few views yet)');
    sig.comments = commentHits(meta.comments, total);
    if (sig.comments.length) used.push(`timestamped comments (${sig.comments.reduce((a, c) => a + c.n, 0)})`);
    const chatP = chat !== undefined ? chat : startChat({ ytdlpBin, url, dir, ytdlpArgs, meta });
    if (chatP) {
      try {
        const b = await chatP;
        if (!b || !b.length) notes.push('no chat replay saved on that stream');
        else {
          const s = spikes(b.map((x) => ({ t: x.t, v: x.n + 2 * x.react })), { floor: 3 });
          sig.chat = s.map((x) => ({ ...x, react: (b.find((y) => y.t === x.t) || {}).react || 0 }));
          used.push(`chat replay (${b.reduce((a, x) => a + x.n, 0)} messages${b.partial ? `, first ${Math.round(b[b.length - 1].t / 60)} min only` : ''})`);
        }
      } catch (e) { notes.push(`chat replay unavailable (${e.message})`); }
    }
  }
  try {
    sig.loud = loudSpikes(await loudness(src));
    if (sig.loud.length) used.push('audio energy');
  } catch (e) { notes.push(`audio energy skipped (${e.message})`); }
  return { hot: hotspots(sig), used, notes };
}

module.exports = { gather, startChat, youtubeMeta, hotspots, commentTimestamps, commentHits, heatPeaks, chatBuckets, spikes, loudSpikes, loudness };
