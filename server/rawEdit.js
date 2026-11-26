// R.O.G.U.E.'s raw-footage editor: he records, she edits. A Drive link (or an
// Instagram / TikTok / YouTube link) to his raw talking-head footage comes back
// as a finished 9:16 video:
//   1. the clean cut — Whisper word timestamps, one Claude call keeps the best
//      take of each line (the last full take of anything said twice), drops false
//      starts, stumbles and "let me redo that", and every stretch of dead air is
//      cut TAIL seconds (about 2 frames) after he stops talking
//   2. his style — [STYLE_LEARN: instagram handle or reel links] watches his past
//      edits (frames through the vision chain, pacing off the transcript) and keeps
//      a style profile (app_settings.rogue_style); [STYLE_NOTE: correction] adds to
//      it, and every edit follows it
//   3. motion graphics — word-by-word captions (clipLayout's ASS), punch-in zooms
//      on the lines that land, a hook up top and title cards where he names
//      something
//   4. batches — several links in one [RAW_EDIT] are edited two at a time and each
//      goes out as it finishes
//   Music: a song from the Drive folder MUSIC_FOLDER ("R.O.G.U.E. Music", or
//   app_settings.rogue_music_folder), picked by the plan to fit, mixed low under
//   his voice. No folder yet = no music, and the result says so.
// Results reach him on Telegram from A.R.A. and land in his Drive.
// RAW_EDIT=off stops it. node server/scripts/test-raw-edit.js.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { getSetting, setSetting } = require('./syncStore');

const W = 1080, H = 1920;
const TAIL = 0.08;      // kept after the last word: ~2 frames at 30fps
const LEAD = 0.06;      // kept before the first word
const GAP_CUT = 0.45;   // a pause longer than this inside a line is cut too
const ZOOM = 1.15;
const MAX_MIN = Number(process.env.RAW_EDIT_MAX_MIN || 20);
const PARALLEL = 2;
const STYLE_KEY = 'rogue_style';
// Named profiles (app_settings.rogue_style_<name>) sit beside his own default one.
// A name alone is only a profile when it's one of these or already saved, so a bare
// Instagram handle still works.
const KNOWN_PROFILES = ['tate'];
const profileSlug = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
const keyFor = (name) => (profileSlug(name) ? `${STYLE_KEY}_${profileSlug(name)}` : STYLE_KEY);
// "tate: link, link" / "tate | link" -> { name: 'tate', rest: 'link, link' }; no name -> { name: '', rest: arg }.
function splitProfile(arg) {
  const a = String(arg || '').trim();
  const m = !/^https?:/i.test(a) && a.match(/^([a-z][a-z0-9_-]{1,19})\s*[:|]\s*([\s\S]*)$/i);
  if (m) return { name: profileSlug(m[1]), rest: m[2].trim() };
  if (KNOWN_PROFILES.includes(a.toLowerCase())) return { name: a.toLowerCase(), rest: '' };
  return { name: '', rest: a };
}

function enabled() { return String(process.env.RAW_EDIT || '').toLowerCase() !== 'off'; }

function run(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, args);
    let err = '';
    ff.stderr.on('data', (c) => { err = (err + c).slice(-4000); });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
  });
}

// --- the cut (pure) -------------------------------------------------------------

// Words -> lines: a new line after a sentence end or a pause over 0.7 s.
function lines(words) {
  const out = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], prev = words[i - 1];
    if (cur.length && (/[.!?]$/.test(prev.word) || w.start - prev.end > 0.7)) { out.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out.map((ws, id) => ({ id, start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.word).join(' '), words: ws }));
}

// The plan's JSON, cleaned: ids that exist, in order. Nothing usable = keep everything.
function parsePlan(raw, count) {
  let o = null;
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  try { o = m ? JSON.parse(m[0]) : null; } catch { o = null; }
  const ids = (a) => [...new Set((Array.isArray(a) ? a : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < count))].sort((x, y) => x - y);
  const keep = o ? ids(o.keep) : [];
  return {
    keep: keep.length ? keep : [...Array(count).keys()],
    zoom: o ? ids(o.zoom) : [],
    titles: (o && Array.isArray(o.titles) ? o.titles : []).map((t) => ({ id: Number(t.id), text: String(t.text || '').trim().slice(0, 40) })).filter((t) => keep.includes(t.id) && t.text).slice(0, 6),
    hook: String((o && o.hook) || '').replace(/["“”]/g, '').trim().slice(0, 70),
    keywords: (o && Array.isArray(o.keywords) ? o.keywords : []).map((k) => String(k).trim()).filter((k) => k && !/\s/.test(k)).slice(0, 8),
    title: String((o && o.title) || '').trim().slice(0, 60),
    music: String((o && o.music) || '').trim(),
    planned: !!o,
  };
}

// Kept lines -> source segments, dead air cut: each line from just before its
// first word to TAIL after its last, split wherever he paused over GAP_CUT, and
// touching pieces merged. -> [{ start, end, zoom }]
function segments(ls, keep, zoom = []) {
  const keepSet = new Set(keep), zoomSet = new Set(zoom);
  const out = [];
  for (const l of ls) {
    if (!keepSet.has(l.id)) continue;
    let piece = null;
    for (let i = 0; i < l.words.length; i++) {
      const w = l.words[i];
      if (piece && w.start - l.words[i - 1].end > GAP_CUT) { out.push(piece); piece = null; }
      if (!piece) piece = { start: Math.max(0, w.start - LEAD), end: w.end + TAIL, zoom: zoomSet.has(l.id) };
      piece.end = w.end + TAIL;
    }
    if (piece) out.push(piece);
  }
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.02 && s.zoom === last.zoom) last.end = Math.max(last.end, s.end);
    else if (last && s.start < last.end) merged.push({ ...s, start: last.end });
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.end - s.start > 0.05);
}

// Source time -> time in the cut video (null when that moment was cut).
function remap(t, segs) {
  let acc = 0;
  for (const s of segs) {
    if (t >= s.start && t <= s.end) return acc + (t - s.start);
    acc += s.end - s.start;
  }
  return null;
}
const cutLength = (segs) => segs.reduce((n, s) => n + (s.end - s.start), 0);

// The video filter: CFR, keep the segments, fill 9:16, punch-in on zoom lines.
function videoChain(segs, size) {
  const sel = segs.map((s) => `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`).join('+');
  const fill = size && size.w > size.h
    ? `crop=ih*${W}/${H}:ih,scale=${W}:${H}` // landscape: the 9:16 middle
    : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  let acc = 0;
  const zr = [];
  for (const s of segs) { if (s.zoom) zr.push(`between(it,${acc.toFixed(3)},${(acc + s.end - s.start).toFixed(3)})`); acc += s.end - s.start; }
  const zoom = zr.length ? `,zoompan=z='if(${zr.join('+')},${ZOOM},1)':x='iw/2-(iw/zoom/2)':y='max(0,ih*0.45-(ih/zoom/2))':d=1:s=${W}x${H}:fps=30` : '';
  return `[0:v]fps=30,select='${sel}',setpts=N/30/TB,${fill},setsar=1${zoom}`;
}
function audioChain(segs) {
  const sel = segs.map((s) => `between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})`).join('+');
  return `[0:a]aselect='${sel}',asetpts=N/SR/TB`;
}

// Title cards: an ASS style + events appended to clipLayout's caption file.
function titleAss(ass, titles) {
  if (!titles.length) return ass;
  const style = `Style: Title,Anton,92,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&HA0000000&,0,0,0,0,100,100,2,0,3,22,0,8,80,80,0,1`;
  const esc = (s) => String(s).replace(/[{}\\]/g, '').toUpperCase();
  const t = (x) => { const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = x % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };
  const ev = titles.map((x) => `Dialogue: 2,${t(x.at)},${t(x.at + 2.2)},Title,,0,0,0,,{\\pos(${W / 2},620)\\fad(120,160)\\fscx80\\fscy80\\t(0,160,\\fscx100\\fscy100)}${esc(x.text)}`);
  return ass.replace(/(Style: Hook[^\n]*\n)/, `$1${style}\n`).replace(/\n*$/, '\n') + ev.join('\n') + '\n';
}

// --- style profile ---------------------------------------------------------------

async function style(name = '') {
  try { const raw = await getSetting(keyFor(name), ''); return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch { return null; }
}
function styleText(s) {
  if (!s) return 'No style profile yet ([STYLE_LEARN] builds one from his past edits). Default: big word-by-word captions, a hook up top, punch-ins on the lines that land, tight cuts.';
  return `${s.summary || ''}${s.notes && s.notes.length ? `\nHis corrections (newest last, these win):\n${s.notes.map((n) => `- ${n}`).join('\n')}` : ''}`;
}
// Rendering switches the profile can set.
function renderPrefs(s) {
  const p = (s && s.prefs) || {};
  return { captions: p.captions !== false, hook: p.hook !== false, zooms: p.zooms !== false, titles: p.titles !== false, captionY: p.caption_position === 'middle' ? 1100 : 1380 };
}

// [STYLE_LEARN: handle or reel links] — watch up to 5 of his past edits.
// [STYLE_LEARN: tate: x.com/… links] builds the named profile "tate" instead of his own (X and other video links work).
const learnStyle = (arg) => jobs.run('rogue', `Style learn: ${String(arg || '').slice(0, 45)}`, ['List his edits', 'Watch each edit', 'Build the profile'], (job) => learnStyleInner(arg, job), { kind: 'style_learn', args: { arg: String(arg || '') }, to: 'rogue' });

async function learnStyleInner(argIn, job = NOJOB) {
  const { name: profile, rest: arg } = splitProfile(argIn);
  const clip = require('./clipScan');
  const { transcribeWords } = require('./llm');
  const { lookAtImages } = require('./vision');
  job.step('List his edits');
  const links = String(arg || '').match(/https?:\/\/\S+/g) || [];
  let urls = links;
  if (!urls.length && profile) {
    // A named profile has no Instagram account to list: relearn from the links it was built from, or ask for links.
    const cur = await style(profile);
    urls = (cur && cur.from) || [];
    if (!urls.length) throw new Error(`needs links to the ${profile} videos to learn from (X posts with a video, Instagram, TikTok or YouTube links), e.g. [STYLE_LEARN: ${profile}: link, link]`);
  }
  if (!urls.length) {
    const handle = String(arg || '').replace(/^@/, '').trim();
    if (!/^[\w.]{2,30}$/.test(handle)) throw new Error('needs his Instagram handle or links to his reels');
    const out = await clip.ytdlp(['--flat-playlist', '--print', 'url', '--playlist-items', '1-8', `https://www.instagram.com/${handle}/reels/`])
      .catch((e) => { throw new Error(`Instagram wouldn't list @${handle}'s reels (${e.message.slice(0, 140)}). It needs a logged-in session, INSTAGRAM_COOKIES on the server, or send me links to a few of his reels instead`); });
    urls = out.split('\n').map((x) => x.trim()).filter((x) => /^https?:/.test(x));
  }
  if (!urls.length) throw new Error('found no reels to learn from');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rogue-style-'));
  const seen = [];
  try {
    const watch = urls.slice(0, 5);
    job.plan(['List his edits', ...watch.map((_, i) => `Watch edit ${i + 1}`), 'Build the profile'], 1);
    for (const [i, u] of watch.entries()) {
      job.step(`Watch edit ${i + 1}`);
      try {
        const d = path.join(dir, String(i)); fs.mkdirSync(d);
        const { file } = await clip.downloadYouTube(u, d);
        const total = await clip.duration(file);
        const frames = [];
        for (const f of [0.2, 0.5, 0.8]) {
          const img = path.join(d, `f${f}.jpg`);
          await run(['-hide_banner', '-loglevel', 'error', '-y', '-ss', (total * f).toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=540:-2', img]);
          frames.push({ mime: 'image/jpeg', data: fs.readFileSync(img) });
        }
        const a = path.join(d, 'a.mp3');
        await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', a]);
        const words = await transcribeWords(fs.readFileSync(a), 'a.mp3', { job: 'raw edit' }).catch(() => []);
        const gaps = words.slice(1).map((w, j) => w.start - words[j].end).filter((g) => g > 0);
        const look = await lookAtImages(frames, `Three frames from one ${profile ? `of the ${profile} reference videos` : 'of his edited short videos'}. Describe the EDITING STYLE only, in 4-6 short lines: captions (on/off, position, size, font feel, colors, how many words at a time), framing (tight/wide, centered), zooms or punch-ins, on-screen titles or graphics, color grade, anything else distinctive. No guesses about what is said.`);
        seen.push({ url: u, secs: Math.round(total), wps: words.length && total ? (words.length / total).toFixed(2) : '?', pause: gaps.length ? (gaps.reduce((x, y) => x + y, 0) / gaps.length).toFixed(2) : '?', look });
      } catch (e) { if (jobs.isCancel(e)) throw e; seen.push({ url: u, error: e.message.slice(0, 120) }); }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const ok = seen.filter((x) => !x.error);
  if (!ok.length) throw new Error(`couldn't watch any of them (${seen.map((x) => x.error).join('; ').slice(0, 300)})`);
  job.step('Build the profile');
  const { claudeText } = require('./llm');
  const raw = await claudeText('You build an editing style profile for a short-form video editor from notes on several of his own finished videos. Return JSON only: {"summary": "8-12 short lines describing his style, concrete enough to edit by: pacing, captions, framing, zooms, titles, grade, length", "prefs": {"captions": true|false, "caption_position": "lower"|"middle", "hook": true|false, "zooms": true|false, "titles": true|false}}. Only what the notes show; where they disagree, go with the majority.',
    ok.map((x, i) => `VIDEO ${i + 1} (${x.secs}s, ${x.wps} words/sec, average pause ${x.pause}s):\n${x.look}`).join('\n\n'), { maxTokens: 900 });
  const m = String(raw).match(/\{[\s\S]*\}/);
  let prof; try { prof = JSON.parse(m[0]); } catch { prof = { summary: String(raw).slice(0, 1500), prefs: {} }; }
  const cur = await style(profile);
  const next = { summary: String(prof.summary || '').slice(0, 2500), prefs: prof.prefs || {}, notes: (cur && cur.notes) || [], from: ok.map((x) => x.url), at: Date.now() };
  await setSetting(keyFor(profile), JSON.stringify(next));
  return `${profile ? `The "${profile}" style profile` : 'Style profile'} built from ${ok.length} of his edits${seen.length > ok.length ? ` (${seen.length - ok.length} couldn't be read)` : ''}:\n${next.summary}`;
}

async function addStyleNote(textIn) {
  const { name: profile, rest } = splitProfile(textIn);
  const t = String(profile ? rest : textIn || '').trim().slice(0, 300);
  if (!t) throw new Error('needs the correction');
  const cur = (await style(profile)) || { summary: '', prefs: {}, notes: [] };
  cur.notes = [...(cur.notes || []), t].slice(-30);
  if (/no captions|without captions|captions off/i.test(t)) cur.prefs = { ...cur.prefs, captions: false };
  if (/captions (back )?on|add captions/i.test(t)) cur.prefs = { ...cur.prefs, captions: true };
  if (/no zoom|stop zoom/i.test(t)) cur.prefs = { ...cur.prefs, zooms: false };
  if (/no hook/i.test(t)) cur.prefs = { ...cur.prefs, hook: false };
  await setSetting(keyFor(profile), JSON.stringify(cur));
  return `Noted for ${profile ? `every ${profile}-style edit` : 'every edit'} from now on: "${t}"`;
}

// --- one edit ----------------------------------------------------------------------

async function musicFiles() {
  const name = (await getSetting('rogue_music_folder', '').catch(() => '')) || process.env.MUSIC_FOLDER || 'R.O.G.U.E. Music';
  try { return { name, files: (await require('./google').driveFolderAudio(name)) || [] }; } catch { return { name, files: [] }; }
}

async function plan(ls, prof, notes, songs) {
  const { claudeText } = require('./llm');
  const sys = `You are R.O.G.U.E., the video editor, cutting Mr. Burrus's raw talking-head footage into a finished short. The transcript is numbered lines with times. Return JSON only:
{"keep":[line ids to keep, in order],"zoom":[ids of the lines that land hardest, a punch-in on each, about one in four kept lines],"titles":[{"id":line id,"text":"2-4 word title card when he names a thing, a number or a list item"}],"hook":"the strongest opening line as on-screen text, under 9 words","keywords":["single words to color in the captions"],"title":"a short name for the video","music":"exact file name from the music list that fits the tone, or empty"}
Rules: when he says a line more than once, keep only the LAST complete take. Drop false starts, stumbles, repeated words he restarts, "let me redo that"/"cut that" and the line it refers to, and off-script chatter. Keep everything else in order; never reorder or rewrite. His style:
${styleText(prof)}${notes ? `\nHis notes for this video: ${notes}` : ''}${songs.length ? `\nMusic list: ${songs.map((s) => s.name).join(' | ')}` : '\nNo music list.'}`;
  return claudeText(sys, ls.map((l) => `${l.id} [${l.start.toFixed(1)}-${l.end.toFixed(1)}] ${l.text}`).join('\n').slice(0, 60000), { maxTokens: 1500 });
}

// Live progress (server/jobProgress.js): each edit / style learn is one tracked job.
const jobs = require('./jobProgress');
const NOJOB = { step() {}, note() {}, onCancel() {}, checkpoint() {} };
const EDIT_STEPS = ['Download footage', 'Transcribe', 'Plan the cut', 'Render', 'Upload'];
const editOne = (link, notes = '', profile = '') => jobs.run('rogue', `Raw edit: ${String(link).replace(/^https?:\/\/(www\.)?/, '').slice(0, 45)}`, EDIT_STEPS, (job) => editOneInner(link, notes, job, profile), { kind: 'raw_edit', args: { link, notes, profile }, to: 'rogue' });

// Checkpoints (same idea as the clip scan's): the downloaded footage and its word
// transcript are kept in a directory keyed by the link until the edit succeeds, so a
// restart's resume skips both; pruned after 2 days.
const EDIT_DIR = process.env.RAW_EDIT_JOBS_DIR || path.join(os.homedir(), '.empire-bin', 'raw-edit-jobs');
const editDirFor = (link) => path.join(EDIT_DIR, require('crypto').createHash('sha1').update(String(link).trim()).digest('hex').slice(0, 16));

async function editOneInner(link, notes = '', job = NOJOB, profile = '') {
  const clip = require('./clipScan');
  const layout = require('./clipLayout');
  const google = require('./google');
  const { transcribeWords } = require('./llm');
  clip.pruneJobDirs(EDIT_DIR);
  const dir = editDirFor(link);
  fs.mkdirSync(dir, { recursive: true });
  const meta = path.join(dir, 'state.json');
  const words_f = path.join(dir, 'words.json');
  let ok = false;
  if (job.onCancel) job.onCancel(() => fs.rmSync(dir, { recursive: true, force: true })); // a cancelled edit leaves nothing to resume
  try {
    let src = path.join(dir, 'raw'), name;
    job.step('Download footage');
    const id = clip.driveId(link);
    let saved = null; try { saved = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { /* none */ }
    if (saved && saved.file && fs.existsSync(path.join(dir, saved.file)) && (await clip.duration(path.join(dir, saved.file)).catch(() => 0)) > 0) {
      src = path.join(dir, saved.file); name = saved.name; // resumed: the footage was already down
    } else {
      for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
      if (id) name = await google.driveDownloadTo(id, src, clip.MAX_BYTES);
      else if (clip.isYouTube(link) || clip.isSocialVideo(link)) ({ file: src, name } = await clip.downloadYouTube(link, dir));
      else throw new Error('needs a Google Drive link to the raw footage (or an Instagram, TikTok, X or YouTube link)');
      fs.writeFileSync(meta, JSON.stringify({ file: path.basename(src), name }));
    }
    const total = await clip.duration(src);
    if (!total) throw new Error("couldn't read that file as a video");
    if (total > MAX_MIN * 60) throw new Error(`that's ${clip.mmss(total)} of footage; the limit is ${MAX_MIN} minutes a video`);
    job.step('Transcribe');
    let words = null; try { words = JSON.parse(fs.readFileSync(words_f, 'utf8')); } catch { /* none */ }
    if (!Array.isArray(words) || !words.length) {
      const a = path.join(dir, 'a.mp3');
      await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', a]);
      words = await transcribeWords(fs.readFileSync(a), 'raw.mp3', { job: 'raw edit' });
      if (!words.length) throw new Error('no speech found in it');
      fs.writeFileSync(words_f, JSON.stringify(words));
    }
    job.step('Plan the cut');
    const ls = lines(words);
    const [prof, music] = await Promise.all([style(profile), musicFiles()]);
    const pl = parsePlan(await plan(ls, prof, notes, music.files).catch(() => ''), ls.length);
    const prefs = renderPrefs(prof);
    const segs = segments(ls, pl.keep, prefs.zooms ? pl.zoom : []);
    if (!segs.length) throw new Error('nothing was left after the cut');
    const dur = cutLength(segs);
    const size = await layout.videoSize(src);
    // Captions on the cut's clock.
    const cutWords = words.map((w) => ({ ...w, start: remap(w.start, segs), end: remap(w.end, segs) })).filter((w) => w.start != null && w.end != null);
    let ass = layout.buildAss({ words: prefs.captions ? cutWords : [], hook: prefs.hook ? pl.hook : '', keywords: pl.keywords, duration: dur, captionY: prefs.captionY, hookY: 230 });
    const titles = prefs.titles ? pl.titles.map((t) => ({ text: t.text, at: remap(ls[t.id].start, segs) })).filter((t) => t.at != null) : [];
    ass = titleAss(ass, titles);
    const assFile = path.join(dir, 'edit.ass');
    fs.writeFileSync(assFile, ass);
    const fontsDir = await layout.ensureFont().catch(() => null);
    const subs = `ass=${assFile.replace(/[:\\']/g, '\\$&')}${fontsDir ? `:fontsdir=${String(fontsDir).replace(/[:\\']/g, '\\$&')}` : ''}`;
    // Music, low under his voice, faded out at the end.
    let song = null;
    if (pl.music && music.files.length) song = music.files.find((f) => f.name === pl.music) || music.files.find((f) => f.name.toLowerCase().includes(pl.music.toLowerCase()));
    let songFile = null;
    if (song) { songFile = path.join(dir, 'song'); await google.driveDownloadTo(song.id, songFile, 50e6).catch(() => { songFile = null; }); }
    job.step('Render');
    const out = path.join(dir, 'edit.mp4');
    const v = `${videoChain(segs, size)},${subs}[v]`;
    const aud = `${audioChain(segs)}[voice]`;
    const mix = songFile ? `;[1:a]volume=0.12,atrim=0:${dur.toFixed(2)},afade=t=out:st=${Math.max(0, dur - 1.5).toFixed(2)}:d=1.5[m];[voice][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]` : ';[voice]anull[a]';
    const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
    const inputs = ['-i', src, ...(songFile ? ['-stream_loop', '-1', '-i', songFile] : [])];
    const notesOut = [];
    try { await run(['-hide_banner', '-loglevel', 'error', '-y', ...inputs, '-filter_complex', `${v};${aud}${mix}`, '-map', '[v]', '-map', '[a]', ...enc, out]); }
    catch (e) {
      job.checkpoint();
      notesOut.push(`the styled render failed (${e.message.slice(-120)}), so this is the clean cut without graphics`);
      await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-filter_complex', `${videoChain(segs.map((s) => ({ ...s, zoom: false })), size)}[v];${aud}`, '-map', '[v]', '-map', '[voice]', ...enc, out]);
    }
    const base = (pl.title || String(name).replace(/\.[^.]+$/, '')).slice(0, 60);
    job.step('Upload');
    const up = await google.driveUploadFile(out, `Edit — ${base}.mp4`);
    const cutLines = ls.length - pl.keep.length;
    const summary = [
      `"${base}": ${clip.mmss(total)} of raw footage cut to ${clip.mmss(dur)}`,
      `${pl.planned ? `${cutLines} line${cutLines === 1 ? '' : 's'} dropped (retakes, stumbles)` : 'the take picker failed, so every line was kept'}, dead air cut`,
      [prefs.captions && cutWords.length ? 'captions' : '', prefs.hook && pl.hook ? `hook "${pl.hook}"` : '', segs.some((s) => s.zoom) ? `${segs.filter((s) => s.zoom).length} punch-ins` : '', titles.length ? `${titles.length} title card${titles.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(', '),
      song && songFile ? `music: ${song.name}` : music.files.length ? 'no music (none fit)' : `no music (no "${music.name}" folder in his Drive yet)`,
      prof ? `cut to ${profile ? `the ${profile}` : 'his'} style profile` : `no ${profile ? `${profile} ` : ''}style profile yet`,
      ...notesOut,
      up.link,
    ].filter(Boolean).join('\n   ');
    const size2 = fs.statSync(out).size;
    const res = { summary, media: size2 <= 45 * 1024 * 1024 ? [{ name: 'SEND_VIDEO', buffer: fs.readFileSync(out), filename: 'edit.mp4', caption: base }] : [] };
    ok = true;
    return res;
  } finally { if (ok) fs.rmSync(dir, { recursive: true, force: true }); } // a failure keeps the footage + transcript for a rerun
}

// [RAW_EDIT: link, link, … | notes] — in the background, two at a time; each goes
// out from A.R.A.'s bot as it finishes.
let active = 0;
// Out from A.R.A.'s bot: text, then each video.
async function sendAra(text, media = []) {
  const telegram = require('./telegram');
  const ara = telegram.botFor('ara');
  if (!ara || !ara.isConfigured()) return;
  await ara.sendMessage(telegram.OWNER_ID, text, { remember: true }).catch(() => {});
  for (const m of media) await ara.sendFile(telegram.OWNER_ID, 'video', m.buffer, { filename: m.filename, caption: m.caption }).catch((e) => console.error('raw edit send failed:', e.message));
}
// Boot resume (server/jobProgress.js): rerun one cut-off edit / style learn with its saved arguments.
async function resumeEdit({ link, notes = '', profile = '' }) {
  try { const r = await editOne(link, notes, profile); await sendAra(`🎬 **R.O.G.U.E. → A.R.A.** Edit ready (resumed after the restart):\n   ${r.summary}`, r.media); }
  catch (e) { if (jobs.isCancel(e)) return; console.error(`raw edit failed: ${e.message}`); await sendAra(`🎬 R.O.G.U.E.'s resumed edit didn't work: ${e.message}`); }
}
async function resumeStyleLearn({ arg }) {
  try { await sendAra(`🎬 **R.O.G.U.E. → A.R.A.** Style learn finished (resumed after the restart):\n${String(await learnStyle(arg)).slice(0, 3500)}`); }
  catch (e) { if (jobs.isCancel(e)) return; console.error(`raw edit failed: style learn: ${e.message}`); await sendAra(`🎬 R.O.G.U.E.'s resumed style learn didn't work: ${e.message}`); }
}
function editBatch(arg) {
  if (!enabled()) throw new Error('the editor is switched off (RAW_EDIT=off)');
  const [list, ...n] = String(arg || '').split('|');
  const links = [...new Set(list.match(/https?:\/\/[^\s,]+/g) || [])].slice(0, 10);
  if (!links.length) throw new Error('needs a link to the raw footage (a Google Drive link works best)');
  if (active) throw new Error('an edit batch is already running; send these when it finishes');
  let notes = n.join('|').trim();
  // "style: tate" (or "tate style") in the notes cuts it to that named profile.
  let profile = '';
  const sm = notes.match(/^\s*(?:style\s*[:=]\s*([a-z][\w-]{1,19})|([a-z][\w-]{1,19}) style)\b[\s,;.:-]*/i);
  if (sm) { profile = profileSlug(sm[1] || sm[2]); notes = notes.slice(sm[0].length).trim(); }
  const queue = links.map((l, i) => ({ l, i }));
  active = links.length;
  const telegram = require('./telegram');
  const send = async (text, media = []) => {
    const ara = telegram.botFor('ara');
    if (!ara || !ara.isConfigured()) return;
    await ara.sendMessage(telegram.OWNER_ID, text, { remember: true }).catch(() => {});
    for (const m of media) await ara.sendFile(telegram.OWNER_ID, 'video', m.buffer, { filename: m.filename, caption: m.caption }).catch((e) => console.error('raw edit send failed:', e.message));
  };
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const tag = links.length > 1 ? ` (${job.i + 1} of ${links.length})` : '';
      try {
        const r = await editOne(job.l, notes, profile);
        await send(`🎬 **R.O.G.U.E. → A.R.A.** Edit ready${tag}:\n   ${r.summary}`, r.media);
      } catch (e) {
        if (jobs.isCancel(e)) { console.warn('raw edit cancelled by him'); continue; }
        console.error(`raw edit failed: ${e.message}`);
        await send(`🎬 R.O.G.U.E.'s edit${tag} didn't work: ${e.message}`);
      } finally { active--; }
    }
  };
  for (let k = 0; k < Math.min(PARALLEL, links.length); k++) worker();
  return `editing ${links.length} video${links.length === 1 ? '' : 's'} now${links.length > 1 ? `, ${PARALLEL} at a time` : ''}; each comes to him from A.R.A. on Telegram, and to his Drive, as it finishes (a few minutes each)`;
}

const RAW_EDIT_TOOLS = ` - [RAW_EDIT: Drive link to his raw footage (several links, comma-separated, for a batch) | notes for this edit] — R.O.G.U.E. edits his own recordings into finished 9:16 videos: best take of each line, retakes and stumbles dropped, dead air cut, word-by-word captions, a hook, punch-in zooms, title cards, music from his Drive folder, all to his style profile. Runs in the background; each one comes to him from A.R.A. and lands in his Drive. Say it's started, never that it's done.
 - [STYLE_LEARN: his Instagram handle, or links to his reels] — watch his past edits and build the style profile every edit follows. [STYLE_LEARN: tate: link, link] builds a separate named profile (here "tate") from videos he hand-picks (X posts with a video, Instagram, TikTok, YouTube links); a [RAW_EDIT: link | style: tate, notes] is then cut to that profile instead of his own. [STYLE_NOTE: a correction he gave] — add one of his style corrections ("no zooms", "captions in the middle", "shorter hooks"); [STYLE_NOTE: tate: correction] goes to the named profile.`;

async function tag(name, arg) {
  if (name === 'RAW_EDIT') return editBatch(arg);
  if (name === 'STYLE_LEARN') return learnStyle(arg);
  if (name === 'STYLE_NOTE') return addStyleNote(arg);
  return '';
}

module.exports = { resumeEdit, resumeStyleLearn, editDirFor, splitProfile, keyFor, tag, lines, parsePlan, segments, remap, cutLength, videoChain, audioChain, titleAss, renderPrefs, styleText, RAW_EDIT_TOOLS, enabled, TAIL };
