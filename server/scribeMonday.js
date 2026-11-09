// S.C.R.I.B.E.'s Monday scripts. Mondays at 8 AM ET, an hour after S.E.L.E.N.E.'s
// Instagram watch, he picks 7 areas from Mr. Burrus's "Instagram Content Areas" Drive note,
// creates a video for each in the form it calls for (a montage is a shot list, not a
// monologue; checkScript enforces it) then R.O.G.U.E. plans the
// cut and S.E.L.E.N.E. dresses each up (his words stay his) and they go to A.R.A. Each one is filed to Drive as "Script — <title>" (the same names
// the app's [SCRIPT_OPEN] reads), or the app's Notes if Drive is down. A.R.A. only
// tells him they came in, with links: she never reads them out, and a script goes
// in the message only if it couldn't be filed anywhere. Once a week.
// MONDAY_SCRIPTS=off stops it.
const { chatAs, webResearch } = require('./llm');
const { ROSTER } = require('./personas');
const { getSetting, setSetting, saveMemory, todayET } = require('./syncStore');
const { saveNote } = require('./personaTools');
const { readDriveNote } = require('./google');
const { sendFromAra } = require('./talonAlerts');

const COUNT = 7;
const AREAS_NOTE = 'Instagram Content Areas';
const AREAS_FALLBACK = 'My life movie scenes, random thoughts, Video "reactions", Talking heads, current events, montages, God, Empire OS';
const FRESH_BRIEF = 8 * 86400e3;

// "=== SCRIPT 1: Title ===" blocks -> [{ title, body }]. Pure.
function parseScripts(raw) {
  const out = [];
  const re = /^\s*={2,}\s*SCRIPT\s*\d+\s*[:—-]\s*(.+?)\s*={2,}\s*$/gim;
  const heads = [...String(raw || '').matchAll(re)];
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : raw.length;
    const body = raw.slice(h.index + h[0].length, end).trim();
    if (h[1] && body) out.push({ title: h[1].replace(/[*_#]/g, '').trim(), body });
  });
  return out;
}

async function recentTitles() {
  const raw = await getSetting('scribe_recent_titles', '[]').catch(() => '[]');
  try { const a = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

// The kind of video something is, from a TYPE line or an area name. Pure.
function typeOf(text) {
  const t = String(text || '').toLowerCase();
  if (/talking/.test(t)) return 'talking head';
  if (/montage/.test(t)) return 'montage';
  if (/movie|scene/.test(t)) return 'movie scene';
  if (/react/.test(t)) return 'reaction';
  if (/random|thought/.test(t)) return 'random thought';
  return null;
}

const wordsIn = (body, tag) => (String(body).match(new RegExp(`^\\s*${tag}\\b.*$`, 'gim')) || [])
  .join(' ').replace(new RegExp(`\\b${tag}\\b:?`, 'gi'), ' ').split(/\s+/).filter(Boolean).length;
const countOf = (body, tag) => (String(body).match(new RegExp(`^\\s*${tag}\\b`, 'gim')) || []).length;

// Is this actually the kind of video its area calls for? A montage written as a
// monologue comes back as { why } and gets rewritten. Pure.
function checkScript(body) {
  const area = (String(body).match(/^\s*AREA:\s*(.+)$/im) || [])[1];
  const type = typeOf((String(body).match(/^\s*TYPE:\s*(.+)$/im) || [])[1]);
  if (!area || !type) return { why: 'no AREA or TYPE line' };
  const must = typeOf(area);
  if (must && must !== type) return { why: `${area} has to be a ${must}, not a ${type}` };
  const shots = countOf(body, 'SHOT');
  const vo = wordsIn(body, 'VO');
  if (type === 'montage' && (shots < 5 || vo > 40)) return { why: `a montage needs 5+ shots and almost no talking (${shots} shots, ${vo} spoken words)` };
  if (type === 'movie scene' && (shots < 3 || vo > 60)) return { why: `a movie scene needs 3+ shots and few words (${shots} shots, ${vo} spoken words)` };
  if (type === 'reaction' && (!countOf(body, 'CLIP') || !countOf(body, 'REACT'))) return { why: 'a reaction needs CLIP and REACT lines' };
  if ((type === 'talking head' || type === 'random thought') && shots >= 3) return { why: `a ${type} is him talking, not a shot list` };
  return { ok: true, area: area.replace(/[*_]/g, '').trim(), type };
}

// Which style S.E.L.E.N.E. cuts a video in. Pure.
function styleFor({ area, type }) {
  if (/empire\s*os/i.test(area)) return 'lab';
  if (/god|faith/i.test(area) || /movie|react|current/i.test(area)) return null;
  return ['talking head', 'random thought', 'montage'].includes(type) ? 'tate' : null;
}

const EDIT_STYLE = {
  tate: 'TATE STYLE. Hard, confident, nothing wasted. Talking: tight jump cuts with every breath gone, punch-ins on the hardest lines, the key words slammed on screen. Montage: hard fast cuts on the beat, dark and high contrast, heavy music, one or two hard lines on screen. Take the energy only; never suggest faking money, cars or a lifestyle.',
  lab: "IRON MAN LAB STYLE. A lab at night: blue-lit, slow push-ins, the HUD and screens filling the frame, interface sounds and low electronic score, tension while it fails, the music opening up the moment it works. Take the feeling only: no footage, lines or music from the films.",
};

// What's really trending on Reels this week, from web reports (Instagram has no
// public feed for it). One search a run, shared by all seven videos.
async function trendingAudio() {
  try {
    const out = await webResearch(`Trending Instagram Reels audio right now, as of ${todayET()}. Search recent creator and marketing reports. List up to 15 real sounds with the exact sound name and artist, its mood and pace, what kind of Reels are using it, and the source and date of the report. Include motivational, cinematic, dark, electronic and faith-friendly options if they are really trending. Only sounds reported as trending in the last few weeks; leave out anything older or unconfirmed.`);
    return String(out || '').slice(0, 6000);
  } catch (e) { console.error('monday scripts: trending audio search failed —', e.message); return ''; }
}

const EDIT_TAGS = ['OPENING', 'CUT', 'SOUND'];
const DRESS_TAGS = ['MUSIC', 'TEXT', 'FINISH', 'CAPTION'];

// Does a pass have every part it owes? Pure.
function checkEdit(text, tags) {
  const has = (tag) => new RegExp(`^\\s*\\**${tag}\\b`, 'im').test(String(text));
  const missing = tags.filter((t) => !has(t));
  return missing.length ? { why: `missing ${missing.join(', ')}` } : { ok: true };
}

// One persona's pass over a video, retried once. Null if it never comes back whole.
async function pass(who, sys, s, material, tags) {
  const p = ROSTER[who];
  for (let i = 0; i < 2; i++) {
    try {
      const raw = String(await chatAs(p.api, p.model, sys, [{ role: 'user', content: `"${s.title}"\n\n${material}` }], { maxTokens: 900 })).trim();
      const c = checkEdit(raw, tags);
      if (c.ok) return raw;
      console.error(`monday scripts: ${p.name} redoing "${s.title}" — ${c.why}`);
    } catch (e) { console.error(`monday scripts: ${p.name} failed on "${s.title}" —`, e.message); }
  }
  return null;
}

const styleLine = (s) => EDIT_STYLE[styleFor(s)] || 'No set style for this one: let the idea decide, and keep it honest to him. No flexing on a video about faith.';

// R.O.G.U.E., the video editor: how the footage gets cut once he's recorded it.
function editPlan(s) {
  const sys = `You are R.O.G.U.E., the Empire's video editor. S.C.R.I.B.E. wrote this video for Mr. Burrus. He'll record it, then you cut it. This is your edit plan, ready before he films, so he knows what footage you need.

Don't rewrite S.C.R.I.B.E.'s words or change the idea. Work moment by moment from his actual lines and shots. Filmed by one man with a phone and his setup. Music, on-screen text and the final look are S.E.L.E.N.E.'s, not yours.

Your clip editor does clean cuts, captions, vertical reframe and music. Animated captions, transitions and motion graphics need a human finish in CapCut, so mark any of those (CapCut).

STYLE: ${styleLine(s)}

Reply with only these, nothing before or after. Each label starts its own line:
OPENING: what the first 2 seconds look like, to stop the scroll
CUT: the cuts and pacing, moment by moment (as many CUT lines as it needs)
SOUND: sound effects and when
FILM: anything extra he should capture while recording`;
  return pass('rogue', sys, s, s.body, EDIT_TAGS);
}

// S.E.L.E.N.E. dresses it up: music, on-screen text, the look, the post.
function dressUp(s, cuts, audio) {
  const sys = `You are S.E.L.E.N.E., the Empire's brand and creative director. S.C.R.I.B.E. wrote this video for Mr. Burrus and R.O.G.U.E. planned the cut. You dress it up: the music, on-screen text, the look and how it's posted.

Don't rewrite S.C.R.I.B.E.'s words or change R.O.G.U.E.'s cuts. Build on them.

STYLE: ${styleLine(s)}

MUSIC: it has to be good, actually trending, and actually fit THIS video. Choose from the research below: the sound whose mood, pace and meaning match this video's idea and style. Trending never beats fitting: if nothing below fits, say so and give the feel, tempo and what to search for instead. Never name a sound that isn't in the research as trending, and never invent one. A song whose lyrics fight the message is out, and a God video gets something reverent or nothing.

TRENDING AUDIO RESEARCH (web reports, not Instagram's own data):
${audio || '(none came back this week: say no verified trending pick, and give the feel, tempo and what to search for)'}

Never attack women or any group, and no invented numbers or claims.

Reply with only these, nothing before or after. Each label starts its own line:
MUSIC: the sound and artist, why it fits this video, and exactly where it drops, builds or cuts out
TEXT: the on-screen words, when, and how they look (as many TEXT lines as it needs)
FINISH: color, look and how it ends
COVER: the cover frame and its words
CAPTION: the Instagram caption`;
  return pass('selene', sys, s, `${s.body}\n\nR.O.G.U.E.'S CUT:\n${cuts || '(not ready: work from the script)'}`, DRESS_TAGS);
}

// His note, live; the last copy we read if Drive is down, then the note as written.
async function contentAreas() {
  try {
    const n = await readDriveNote(AREAS_NOTE);
    if (n?.text) { await setSetting('scribe_content_areas', n.text).catch(() => {}); return n.text; }
  } catch (e) { console.error('monday scripts: content note unreadable —', e.message); }
  return (await getSetting('scribe_content_areas', '').catch(() => '')) || AREAS_FALLBACK;
}

async function write(have, brief, recent, areas) {
  const p = ROSTER.scribe;
  const need = COUNT - have.length;
  const sys = `You are S.C.R.I.B.E., the Empire's script writer. You report to S.E.L.E.N.E.

${p.voice}

THIS WEEK'S JOB: pick ${COUNT} different areas from his Instagram Content Areas note and create one video for each. The note decides what gets made. Think like a storyteller first: what would this actually be on his feed, what's the one feeling or idea, and what would make someone stop scrolling. Then write only what that video needs. A video that isn't a talking head must not read like one.

YOUR JOB IS THE CONTENT: the idea, the words and what happens. He records what you write, R.O.G.U.E. edits it and S.E.L.E.N.E. dresses it up: cuts, pacing, music, sound, on-screen text are theirs. Don't write any of that.

THE TONE, two separate styles for separate videos. Never blend them in one video:
- TATE STYLE, for talking videos (talking head and random thought) and Montages: the confrontational self-improvement creators, Andrew Tate being the one he named. Total certainty, high status, blunt, a little provocative, says the thing people avoid, challenges the viewer directly, never asks permission. In a montage that's him training, working, moving through his day like nothing can stop him. Status comes from what he really has and does; never fake money, cars or a lifestyle that isn't his. Take the energy and confidence only. No copied lines, and none of the attacks on women or any group: he's a man of faith and the target is always the viewer's excuses. His own voice above still comes first.
- IRON MAN LAB STYLE, for Empire OS videos, whatever their TYPE: the workshop scenes in Iron Man. A genius alone in a lab at night, testing something, it fails, he tries again, dry back-and-forth with his AI, then the moment it works. His real HUD and AI team are his version of that. Take the feeling only: no lines from the films.
- Everything else (My life movie scenes, Video reactions, God, Current events) uses neither: his own voice and the note decide. A talking video about God stays faith first, with his conviction, not the Tate persona.

KINDS OF VIDEO (TYPE):
- talking head: to camera, 30-60 seconds, 80-150 spoken words. Hook in the first line.
- montage: NO monologue. 5 or more SHOT lines saying what happens in each moment, telling a little story with a turn in it, and at most one or two short VO lines. Give him concrete ideas for what to film.
- movie scene: a moment from his real life told like a film. 3 or more SHOT lines: where he is and what he's doing, with a beginning, a turn and an end. Hardly any words.
- reaction: CLIP says what kind of video to go find and exactly what to search for; never invent a specific video or link. REACT lines give what happens at each moment: when he pauses it, what he says, the take that flips it.
- random thought: loose and unpolished, one thought in his words, 15-30 seconds, like it just hit him.

AREAS: Talking heads, Montages, My life movie scenes, Video reactions and Random thoughts are that TYPE, always. God, Current events and Empire OS: pick whichever TYPE fits the idea best, and an Empire OS idea in the note that says montage, reaction or talking head is that type.
- Current events: only something in S.E.L.E.N.E.'s brief below. If nothing in it is real and worth his take, pick a different area.
- God: faith at the center, not a motivational speech with a verse on the end. Quote scripture only when you are sure of the wording, and name the verse.
- Empire OS: only what the note and these real parts of it show: the HUD, task tracking, calendar pulls, revenue dashboards, the AI persona team. Never invent a feature or a revenue number; a figure on screen is his real one or blurred.

Everything is something he can really film by himself with a phone and his setup. Never invent personal stories, facts or numbers about him: where a real story of his belongs, write (your story here: <what kind>). Each video has a different idea and a different opening move from the others.

Format exactly, nothing before or after. The lines inside depend on the TYPE:
=== SCRIPT 1: Short title ===
AREA: the area, as named in the note
TYPE: talking head | montage | movie scene | reaction | random thought
IDEA: one line on what this video is and why it stops the scroll
then the spoken lines for a talking head or random thought, with any delivery notes in (parentheses);
or SHOT 1: ... SHOT 2: ... each on its own line saying what happens, with VO: for any spoken line;
or CLIP: ... then REACT: ... lines for a reaction.
=== SCRIPT 2: Short title ===
...`;
  const taken = have.map((s) => s.area);
  const user = `Create ${need} video${need > 1 ? 's' : ''} for this week, ${todayET()}.\n\nHIS INSTAGRAM CONTENT AREAS NOTE:\n${areas}\n\nS.E.L.E.N.E.'S BRIEF:\n${brief || '(no brief this week: skip Current events)'}\n\nAREAS ALREADY DONE THIS WEEK, pick others: ${taken.join(' | ') || 'none'}\n\nALREADY WRITTEN, don't repeat these topics: ${[...recent, ...have.map((s) => s.title)].join(' | ') || 'none'}`;
  const out = [];
  for (const s of parseScripts(await chatAs(p.api, p.model, sys, [{ role: 'user', content: user }], { maxTokens: 1000 + need * 700 }))) {
    const c = checkScript(s.body);
    if (!c.ok) { console.error(`monday scripts: rewriting "${s.title}" — ${c.why}`); continue; }
    const key = c.area.toLowerCase();
    if ([...taken, ...out.map((x) => x.area)].some((a) => a.toLowerCase() === key)) continue;
    out.push({ ...s, area: c.area, type: c.type });
  }
  return out;
}

async function runMondayScripts({ force = false } = {}) {
  const week = todayET();
  if (!force && (await getSetting('scribe_monday_date', '')) === week) return { skipped: 'already sent today' };
  let brief = '';
  try {
    const b = JSON.parse(await getSetting('selene_trend_brief', '{}') || '{}');
    if (Date.now() - Number(b.at || 0) < FRESH_BRIEF) brief = String(b.body || '');
  } catch { /* no brief: he writes from the voice alone */ }
  const recent = await recentTitles();
  const areas = await contentAreas();

  // More tries if he comes back short or a video was the wrong kind.
  let scripts = [];
  for (let i = 0; i < 3 && scripts.length < COUNT; i++) {
    scripts = [...scripts, ...(await write(scripts, brief, recent, areas))].slice(0, COUNT);
  }
  if (!scripts.length) throw new Error('no scripts came back');
  await setSetting('scribe_monday_date', week);

  const audio = await trendingAudio();
  // Each script goes to R.O.G.U.E., then S.E.L.E.N.E.; one that misses a pass still gets filed, marked.
  const passes = await Promise.all(scripts.map(async (x) => {
    const cuts = await editPlan(x);
    return { cuts, dress: await dressUp(x, cuts, audio) };
  }));
  const noEdit = passes.filter((e) => !e.cuts).length, noDress = passes.filter((e) => !e.dress).length;
  const finished = scripts.map((x, i) => ({ ...x, body: `${x.body}\n\n━━━ R.O.G.U.E.'S EDIT PLAN ━━━\n${passes[i].cuts || "(R.O.G.U.E. didn't get to this one.)"}\n\n━━━ S.E.L.E.N.E.'S DRESS-UP ━━━\n${passes[i].dress || "(S.E.L.E.N.E. didn't get to this one.)"}` }));
  const filed = await Promise.all(finished.map((s) => saveNote(`Script — ${s.title}`, s.body, 'scribe').catch((e) => ({ lost: e.message }))));
  const short = `${scripts.length < COUNT ? ` He only got ${scripts.length} of ${COUNT} written.` : ''}${noEdit ? ` R.O.G.U.E. missed the edit plan on ${noEdit}.` : ''}${noDress ? ` S.E.L.E.N.E. missed the dress-up on ${noDress}.` : ''}`;
  const lines = finished.map((s, i) => {
    const r = filed[i];
    if (r.lost) return `**${i + 1}. ${s.title}** (couldn't be filed, so here it is)\n${s.body}`;
    const link = String(r.ok || '').match(/\[[^\]]+\]\([^)]+\)/);
    return `${i + 1}. ${link ? link[0] : `${s.title} (in the app's Notes)`} · ${s.area}, ${s.type}`;
  });
  const check = audio ? "\n\nThe trending sounds come from web reports, so check each one still shows the trending arrow in Instagram before you use it." : "\n\nNo verified trending sounds came back this week, so the music notes describe the feel instead.";
  const text = `🎬 **S.C.R.I.B.E., R.O.G.U.E. + S.E.L.E.N.E. → A.R.A.: this week's videos are ready for you to record**, Mr. Burrus.${short}\n\n${lines.join('\n')}${check}`;
  const spoken = `S.C.R.I.B.E., R.O.G.U.E. and S.E.L.E.N.E. → A.R.A.: this week's ${scripts.length} videos are ready for you to record, Mr. Burrus.${filed.every((r) => r.ok) ? " They're in your Drive." : ' The message says where each one landed.'}${short}`;
  const sent = await sendFromAra(text, spoken);
  await setSetting('scribe_recent_titles', JSON.stringify([...scripts.map((s) => s.title), ...recent].slice(0, 30))).catch(() => {});
  await saveMemory('scribe', `[Monday scripts ${week}] ${scripts.map((s) => s.title).join(' | ')}`).catch(() => {});
  await saveMemory('rogue', `[Monday edit plans ${week} for S.C.R.I.B.E.'s scripts, in notes as "Script — <title>"; you cut them once he records] ${scripts.map((x) => x.title).join(' | ')}`).catch(() => {});
  await saveMemory('ara', `[S.C.R.I.B.E. wrote, R.O.G.U.E. planned the edit, S.E.L.E.N.E. dressed up, and you handed on, this week's video scripts; you sent them to Mr. Burrus. They're in notes as "Script — <title>"] ${scripts.map((s) => s.title).join(' | ')}`).catch(() => {});
  return { sent, count: scripts.length, titles: scripts.map((s) => s.title) };
}

module.exports = { runMondayScripts, parseScripts, checkScript, checkEdit, styleFor, typeOf, EDIT_TAGS, DRESS_TAGS };
