// S.T.E.P.H.A.N.I.E.'s course tracker, off his "Learning Everything" roadmap
// (a Google Doc: one "[ ] Week N: Topic" checklist line per week, 1736 of them).
//
//   - One course at a time: a week from the roadmap. Starting one writes a Drive
//     note "Course — Week N: Topic" listing every lesson under that topic as a
//     checklist. The note is the tracker: she checks each lesson off in it.
//   - A lesson is checked off only when he says it's complete ([LESSON_DONE]);
//     the course is finished only when every lesson is checked AND he says he's
//     ready to move on ([COURSE_DONE]). Then the week is checked off in the
//     roadmap itself and the next week is picked AT RANDOM from the weeks not
//     done yet, with its own note.
//   - [ROADMAP_CHECK: N] / [ROADMAP_UNCHECK: N] tick any week in the roadmap by
//     hand (something he learned on his own).
//   - Where he left off goes in A.R.A.'s morning brief (briefSection).
//
// State: app_settings.stephanie_course (the course running) and
// stephanie_done_weeks (every week finished, kept here too in case a roadmap
// edit fails). Done = checked in the roadmap OR in that list.
const { getSetting, setSetting } = require('./syncStore');

const ROADMAP = 'Learning Everything';
const COURSE_KEY = 'stephanie_course';
const DONE_KEY = 'stephanie_done_weeks';
const WEEK_RE = /^\s*\\?\[\s*([xX✓✔]?)\s*\\?\]\s*Week\s+(\d+)\s*:\s*(.+?)\s*$/;
const LESSON_RE = /^\s*[-*]\s*\[\s*([xX]?)\s*\]\s*(?:\d+[.)]\s*)?(.+?)\s*$/;

const parseJson = (raw, d) => { try { const v = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw; return v == null ? d : v; } catch { return d; } };
const google = () => require('./google');

// --- the roadmap ---------------------------------------------------------

// Every week in the roadmap: Map n -> { n, title, done }. A week listed twice
// (the PROGRESS section repeats finished ones) is done if either line is.
function parseRoadmap(text) {
  const weeks = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(WEEK_RE);
    if (!m) continue;
    const n = Number(m[2]);
    const prev = weeks.get(n);
    weeks.set(n, { n, title: prev ? prev.title : m[3].replace(/\\/g, ''), done: !!(m[1] || (prev && prev.done)) });
  }
  return weeks;
}

async function roadmapFile() {
  const file = await google().driveFindByName(ROADMAP);
  if (!file) throw new Error(`no "${ROADMAP}" note in Drive`);
  return file;
}

async function loadRoadmap() {
  const file = await roadmapFile();
  const weeks = parseRoadmap(await google().driveRawText(file));
  if (!weeks.size) throw new Error(`couldn't find any "[ ] Week N: topic" lines in "${file.name}"`);
  const extra = new Set(parseJson(await getSetting(DONE_KEY, '[]'), []).map(Number));
  for (const n of extra) { const w = weeks.get(n); if (w) w.done = true; }
  return { file, weeks };
}

// Tick (or untick) "Week N" in the roadmap. A Google Doc is edited in place
// with the Docs API (its formatting stays); a plain note is rewritten.
async function setRoadmapWeek(n, done = true) {
  const file = await roadmapFile();
  const from = done ? ['[ ]', '[  ]', '[]', '☐'] : ['[x]', '[X]', '[✓]', '[✔]', '☑'];
  const to = done ? '[x]' : '[ ]';
  if (file.mimeType === 'application/vnd.google-apps.document') {
    const requests = from.map((f) => ({ replaceAllText: { containsText: { text: `${f} Week ${n}:`, matchCase: true }, replaceText: `${to} Week ${n}:` } }));
    const r = await google().gapi(`https://docs.googleapis.com/v1/documents/${file.id}:batchUpdate`, { method: 'POST', json: { requests } });
    return (r?.replies || []).reduce((a, x) => a + (x?.replaceAllText?.occurrencesChanged || 0), 0);
  }
  const text = await google().driveRawText(file);
  let changed = 0;
  const out = text.split(/\r?\n/).map((line) => {
    const m = line.match(WEEK_RE);
    if (!m || Number(m[2]) !== n || !!m[1] === done) return line;
    changed++;
    return line.replace(/\\?\[\s*[xX✓✔]?\s*\\?\]/, to);
  }).join('\n');
  if (changed) await google().driveUpdate({ fileId: file.id, content: out });
  return changed;
}

async function markWeek(n, done = true) {
  const list = new Set(parseJson(await getSetting(DONE_KEY, '[]'), []).map(Number));
  if (done) list.add(n); else list.delete(n);
  await setSetting(DONE_KEY, JSON.stringify([...list].sort((a, b) => a - b)));
  let edited = 0, err = null;
  try { edited = await setRoadmapWeek(n, done); } catch (e) { err = e.message; }
  return { edited, err };
}

// --- the course note ------------------------------------------------------

const noteTitle = (w) => `Course — Week ${w.n}: ${w.title}`.replace(/[/\\]/g, '-');

function parseLessons(text) {
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(LESSON_RE);
    if (m) items.push({ title: m[2], done: !!m[1] });
  }
  return items;
}

function renderNote(course, items) {
  const done = items.filter((i) => i.done).length;
  return [
    `# Course — Week ${course.week}: ${course.title}`,
    '',
    `From the Learning Everything roadmap. S.T.E.P.H.A.N.I.E. checks each lesson off when Mr. Burrus says it's complete; the week is checked off in the roadmap when every lesson is done and he's ready to move on.`,
    '',
    `Started: ${new Date(course.startedAt).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' })} · Progress: ${done}/${items.length}`,
    '',
    '## Lessons',
    '',
    ...items.map((it, i) => `- [${it.done ? 'x' : ' '}] ${i + 1}. ${it.title}`),
    '',
  ].join('\n');
}

// Every lesson under a week's topic, in teaching order (one Claude call).
async function lessonsFor(w) {
  const raw = await require('./llm').claudeText(
    'You are S.T.E.P.H.A.N.I.E., Mr. Burrus\'s personal educator. Break one week of his learning roadmap into its lessons: every subtopic someone has to learn to genuinely understand the main topic, in the order to teach them, from foundations to the most advanced. 8 to 14 lessons, each a short specific title (no numbering, no descriptions). Reply with ONLY a JSON array of strings.',
    [{ role: 'user', content: `Week ${w.n}: ${w.title}` }], { maxTokens: 700 });
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  const list = parseJson(m ? m[0] : null, []);
  const lessons = (Array.isArray(list) ? list : []).map((x) => String(x || '').replace(/[[\]\n]/g, ' ').trim()).filter(Boolean).slice(0, 20);
  if (lessons.length < 3) throw new Error('couldn\'t write the lesson list');
  return lessons;
}

async function readCourse() {
  const course = parseJson(await getSetting(COURSE_KEY, 'null'), null);
  if (!course || !course.week) return null;
  const note = await google().readDriveNote(course.note);
  if (!note) return { course, items: [], missing: true };
  return { course, items: parseLessons(note.text) };
}

async function writeCourse(course, items) {
  const saved = await google().saveDriveNote(course.note, renderNote(course, items));
  return saved.link || null;
}

// --- actions ---------------------------------------------------------------

// Start a course: week `n`, or a random week not done yet.
async function startCourse(n = null, { force = false } = {}) {
  const running = await readCourse();
  if (running && !force) return `A course is already running: Week ${running.course.week}: ${running.course.title}. Finish it ([COURSE_DONE] once every lesson is checked and he's said he's ready) before starting another.`;
  const { weeks } = await loadRoadmap();
  let w;
  if (n != null) {
    w = weeks.get(Number(n));
    if (!w) return `There's no Week ${n} in the roadmap.`;
  } else {
    const open = [...weeks.values()].filter((x) => !x.done && x.n !== running?.course?.week);
    if (!open.length) return 'Every week in the roadmap is checked off. Nothing left to pick.';
    w = open[Math.floor(Math.random() * open.length)];
  }
  const lessons = await lessonsFor(w);
  const course = { week: w.n, title: w.title, note: noteTitle(w), startedAt: Date.now() };
  const link = await writeCourse(course, lessons.map((title) => ({ title, done: false })));
  await setSetting(COURSE_KEY, JSON.stringify({ ...course, link }));
  return `NEW COURSE${n == null ? ' (picked at random from the weeks not done yet)' : ''}: Week ${w.n}: ${w.title}. Note "${course.note}" created${link ? ` (${link})` : ''} with ${lessons.length} lessons:\n${lessons.map((l, i) => `${i + 1}. ${l}`).join('\n')}\nStart with lesson 1.`;
}

function findLesson(items, ref) {
  const r = String(ref || '').trim().toLowerCase();
  if (!r) return items.findIndex((i) => !i.done);
  if (/^\d+$/.test(r)) { const i = Number(r) - 1; return i >= 0 && i < items.length ? i : -1; }
  let i = items.findIndex((x) => x.title.toLowerCase() === r);
  if (i < 0) i = items.findIndex((x) => x.title.toLowerCase().includes(r) || r.includes(x.title.toLowerCase()));
  return i;
}

async function setLesson(ref, done = true) {
  const st = await readCourse();
  if (!st) return 'No course is running. [COURSE_START] picks one.';
  if (st.missing) return `The course note "${st.course.note}" isn't in Drive anymore.`;
  const i = findLesson(st.items, ref);
  if (i < 0) return `No lesson "${ref}" in Week ${st.course.week}. The lessons: ${st.items.map((x, k) => `${k + 1}. ${x.title}`).join('; ')}`;
  st.items[i].done = done;
  await writeCourse(st.course, st.items);
  const left = st.items.filter((x) => !x.done);
  if (!done) return `Unchecked lesson ${i + 1}: ${st.items[i].title}.`;
  return `Checked off lesson ${i + 1}: ${st.items[i].title} (${st.items.length - left.length}/${st.items.length} done). `
    + (left.length ? `Next: ${left[0].title}.` : `That was the last lesson of Week ${st.course.week}: ${st.course.title}. Ask him if the whole topic is complete and he's ready to move on; only on his yes, [COURSE_DONE].`);
}

// Finish the running course: every lesson checked, the week ticked in the
// roadmap, and the next week picked at random.
async function finishCourse() {
  const st = await readCourse();
  if (!st) return 'No course is running.';
  const left = st.items.filter((x) => !x.done);
  if (left.length) return `Not finished: ${left.length} lesson(s) still unchecked — ${left.map((x) => x.title).join('; ')}. Check each off when he says it's complete first.`;
  const { edited, err } = await markWeek(st.course.week, true);
  await setSetting(COURSE_KEY, 'null');
  const roadmap = edited ? `Week ${st.course.week} checked off in the roadmap.` : `Week ${st.course.week} recorded as done${err ? `, but the roadmap edit failed (${err})` : ', but its line in the roadmap wasn\'t found to tick'}.`;
  return `COURSE COMPLETE: Week ${st.course.week}: ${st.course.title}. ${roadmap}\n${await startCourse(null, { force: true })}`;
}

async function checkWeek(arg, done = true) {
  const n = parseInt(String(arg || '').replace(/\D+/g, ' ').trim(), 10);
  if (!n) return 'Which week? Give its number.';
  const { weeks } = await loadRoadmap();
  const w = weeks.get(n);
  if (!w) return `There's no Week ${n} in the roadmap.`;
  const { edited, err } = await markWeek(n, done);
  return `Week ${n}: ${w.title} ${done ? 'checked off' : 'unchecked'}${edited ? ' in the roadmap' : err ? ` (recorded, but the roadmap edit failed: ${err})` : ' (recorded; it was already that way in the roadmap)'}.`;
}

// --- reads ----------------------------------------------------------------------

async function statusText() {
  const st = await readCourse();
  let total = 0, done = 0;
  try { const { weeks } = await loadRoadmap(); total = weeks.size; done = [...weeks.values()].filter((w) => w.done).length; } catch { /* roadmap unreadable */ }
  const road = total ? `Roadmap: ${done} of ${total} weeks done.` : '';
  if (!st) return `No course running. ${road} [COURSE_START] picks the next week at random.`.trim();
  if (st.missing) return `Course: Week ${st.course.week}: ${st.course.title}, but its note "${st.course.note}" is missing from Drive. ${road}`;
  const cur = st.items.findIndex((x) => !x.done);
  return [
    `Course: Week ${st.course.week}: ${st.course.title} — note "${st.course.note}"${st.course.link ? ` (${st.course.link})` : ''}.`,
    `Lessons (${st.items.filter((x) => x.done).length}/${st.items.length} done):`,
    ...st.items.map((x, i) => `${x.done ? '[x]' : '[ ]'} ${i + 1}. ${x.title}${i === cur ? '  ← current' : ''}`),
    cur < 0 ? 'Every lesson is checked: ask him if the topic is complete and he\'s ready to move on.' : '',
    road,
  ].filter(Boolean).join('\n');
}

// A.R.A.'s morning brief: where he stopped.
async function briefSection() {
  const label = '🎓 S.T.E.P.H.A.N.I.E. — WHERE YOU LEFT OFF';
  const st = await readCourse();
  if (!st) return `${label}\nNo course running right now; she'll pick the next week from the roadmap when you're ready.`;
  if (st.missing) return `${label}\nWeek ${st.course.week}: ${st.course.title} (its course note is missing from Drive).`;
  const cur = st.items.findIndex((x) => !x.done);
  const done = st.items.filter((x) => x.done).length;
  if (cur < 0) return `${label}\nWeek ${st.course.week}: ${st.course.title} — all ${st.items.length} lessons done; she's waiting on your word that you're ready to move on.`;
  const next = st.items.slice(cur + 1).find((x) => !x.done);
  return `${label}\nWeek ${st.course.week}: ${st.course.title}\nCurrent lesson: ${cur + 1} of ${st.items.length} — ${st.items[cur].title} (${done} done)${next ? `\nAfter that: ${next.title}` : ''}`;
}

module.exports = { parseRoadmap, parseLessons, renderNote, findLesson, startCourse, setLesson, finishCourse, checkWeek, statusText, briefSection, readCourse };
