// R.O.G.U.E.'s second opinion on clip candidates (owner, 2026-11-22: other creators' clips weren't
// funny). The transcript can't show a reaction, a visual gag or timing, so the top candidates get a
// few frames each through the vision chain together with the window's words and the viewer evidence,
// and the model says how funny / reactive it really is. Pure parts (parseJudge, blendScore, rerank,
// seedCandidates) are tested in test-clip-scan.js. CLIP_VISION=off skips it.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const VISION_MAX = Number(process.env.CLIP_VISION_MAX || 6);   // candidates judged per scan
const FRAMES = 3;                                               // frames per candidate (small: 2 GB VM)
const MIN_FUNNY = 3;                                            // a judged candidate under this is dropped

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null; };

// The model's JSON -> { funny, visual, reaction, standalone, hook, note } (0-10), or null.
function parseJudge(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const funny = num(j.funny);
  if (funny === null) return null;
  return { funny, visual: num(j.visual) ?? 0, reaction: num(j.reaction) ?? 0, standalone: num(j.standalone) ?? 5,
    hook: String(j.hook || '').replace(/["“”]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70), note: String(j.note || '').slice(0, 160) };
}

// Half the text picker's score, half the vision check's funny rating; a clear reaction peak
// adds, a clip a cold viewer can't follow takes away.
function blendScore(score, j) {
  const s = 0.5 * (Number(score) || 0) + 5 * j.funny + (j.reaction >= 7 ? 5 : 0) - (j.standalone <= 3 ? 10 : 0);
  return Math.max(0, Math.min(100, Math.round(s)));
}

// picks + judgements ([j|null] aligned) -> best `max`. A judged pick under MIN_FUNNY is dropped
// (as long as `keepAtLeast` remain); unjudged picks keep their score, a little discounted.
function rerank(picks, judgements, { max = 5, keepAtLeast = 2 } = {}) {
  const rows = picks.map((p, i) => {
    const j = judgements[i];
    if (!j) return { ...p, score: Math.round(p.score * 0.9), judged: false };
    return { ...p, score: blendScore(p.score, j), judged: true, funny: j.funny, hook: p.hook || j.hook,
      reason: j.note ? `${p.reason} · eyes: ${j.note}`.slice(0, 240) : p.reason };
  }).sort((a, b) => b.score - a.score);
  const keep = rows.filter((r) => !r.judged || r.funny >= MIN_FUNNY);
  return (keep.length >= keepAtLeast ? keep : rows).slice(0, max);
}

// Windows the viewers lit up (laughter first) that no candidate covers -> extra candidates:
// from ~20 s before the peak (the setup) to ~8 s after it, snapped to transcript segments,
// 12-60 s. `hot` is clipSignals.hotspots(); `segments` [{start,end,text}].
function seedCandidates(hot, picks, segments, total, { want = 4, minScore = 45, minClip = 12, maxClip = 60 } = {}) {
  const out = [];
  const taken = picks.map((p) => [p.start, p.end]);
  const ranked = [...hot].filter((h) => h.score >= minScore).sort((a, b) => ((b.laugh || 0) > 0) - ((a.laugh || 0) > 0) || b.score - a.score);
  for (const h of ranked) {
    if (out.length >= want) break;
    let start = Math.max(0, h.start - 20), end = Math.min(total, h.end + 8);
    const before = segments.filter((s) => s.start <= start && s.end > start - 10).pop();
    if (before) start = Math.max(0, before.start);
    const after = segments.find((s) => s.end >= end);
    if (after) end = Math.min(total, after.end + 1);
    if (end - start > maxClip) end = start + maxClip;
    if (end - start < minClip) end = Math.min(total, start + minClip);
    if (end - start < minClip) continue;
    if (taken.some(([a, b]) => start < b && a < end)) continue;
    taken.push([start, end]);
    out.push({ start, end, title: 'Viewer hot spot', reason: `viewers lit up here: ${h.why}`.slice(0, 240), score: Math.round(h.score * 0.8), hook: '', keywords: [] });
  }
  return out;
}

function grab(src, at, dest) {
  return new Promise((resolve) => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at.toFixed(2), '-i', src, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '6', dest]);
    const t = setTimeout(() => p.kill('SIGKILL'), 30e3);
    p.on('error', () => { clearTimeout(t); resolve(false); });
    p.on('close', (c) => { clearTimeout(t); resolve(c === 0 && fs.existsSync(dest)); });
  });
}

// FRAMES small jpgs spread over [from, from+dur] of a video file.
async function framesOf(file, from, dur, dir, tag) {
  const out = [];
  for (let i = 0; i < FRAMES; i++) {
    const dest = path.join(dir, `${tag}-f${i}.jpg`);
    if (await grab(file, from + dur * (0.2 + 0.3 * i), dest)) { out.push({ mime: 'image/jpeg', data: fs.readFileSync(dest) }); fs.rmSync(dest, { force: true }); }
  }
  return out;
}

const judgePrompt = (pick, words) => `These are ${FRAMES} frames, in order, from a ${Math.round(pick.end - pick.start)}-second moment of a stream or video that might become a vertical short-form clip. Judge it as a stranger scrolling Reels who never saw the stream. What is said in it: "${String(words).slice(0, 900)}". Evidence from viewers: ${pick.reason || 'none'}.
Rate 0-10 and reply with ONLY JSON: {"funny": how funny or entertaining it really is (a visible laugh, a shocked or exaggerated face, a gag, a fail, a fight, an absurd moment = high; people just talking, menus, gameplay with nothing happening, an inside joke that needs the stream's context = low), "visual": how much the picture itself carries it, "reaction": how clear a reaction peak (laughing, screaming, shock) shows, "standalone": 10 if a cold viewer gets it with no context, "hook": "3-9 word line that makes a stranger need to watch, no emoji, no quotes, never giving away the ending", "note": "one short line on what you can see"}.`;

// Judge one candidate: file = a video holding it, from = where the candidate starts in that file.
async function judgeCandidate(file, from, pick, words, dir, tag) {
  const { lookAtImages } = require('./vision');
  const frames = await framesOf(file, from, pick.end - pick.start, dir, tag);
  if (frames.length < 2) return null;
  return parseJudge(await lookAtImages(frames, judgePrompt(pick, words)));
}

module.exports = { VISION_MAX, MIN_FUNNY, parseJudge, blendScore, rerank, seedCandidates, judgeCandidate, judgePrompt, framesOf };
