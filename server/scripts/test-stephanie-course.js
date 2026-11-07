// S.T.E.P.H.A.N.I.E.'s course tracker, no network: Drive, settings and Claude
// stubbed. node server/scripts/test-stephanie-course.js
const assert = require('assert');
const google = require('../google');
const store = require('../syncStore');
const llm = require('../llm');

const settings = {};
store.getSetting = async (k, d) => (k in settings ? settings[k] : d);
store.setSetting = async (k, v) => { settings[k] = v; };
// The roadmap as Drive exports it (plain text) — Week 1 done, listed twice.
let roadmap = 'PROGRESS:\n[x] Week 1: Basic Arithmetic & Number Systems\n---\nCOMPLETE ORDERED LEARNING ROADMAP\n[x] Week 1: Basic Arithmetic & Number Systems\n[ ] Week 2: Algebra Fundamentals\n[ ] Week 3: Geometry & Trigonometry\n[ ] Week 12: Genetics & DNA\n';
const notes = {};
const docEdits = [];
google.driveFindByName = async (n) => (/learning everything/i.test(n) ? { id: 'road', name: 'Learning Everything — ALL 1736 WEEKS', mimeType: 'application/vnd.google-apps.document' } : null);
google.driveRawText = async () => roadmap;
google.readDriveNote = async (t) => (notes[t] != null ? { name: t, text: notes[t] } : null);
google.saveDriveNote = async (t, c) => { notes[t] = c; return { name: t, link: `https://drive/${encodeURIComponent(t)}` }; };
google.gapi = async (url, o) => {
  docEdits.push({ url, requests: o.json.requests });
  // Apply it to the stub doc so later reads see the tick.
  let changed = 0;
  for (const r of o.json.requests) {
    const { text } = r.replaceAllText.containsText;
    while (roadmap.includes(text)) { roadmap = roadmap.replace(text, r.replaceAllText.replaceText); changed++; }
  }
  return { replies: [{ replaceAllText: { occurrencesChanged: changed } }] };
};
llm.claudeText = async (sys, msgs) => JSON.stringify(['Foundations', 'Core idea', 'Applications', 'Advanced']);

const c = require('../stephanieCourse');

(async () => {
  // The roadmap parses, escaped or not.
  const w = c.parseRoadmap(roadmap);
  assert.strictEqual(w.size, 4);
  assert.strictEqual(w.get(1).done, true);
  assert.strictEqual(w.get(12).title, 'Genetics & DNA');
  assert.strictEqual(c.parseRoadmap('\\[x\\] Week 7: Electricity & Magnetism').get(7).done, true);

  // Nothing running: the brief says so; a start picks a week not done, at random.
  assert.match(await c.briefSection(), /No course running/);
  const picks = new Set();
  for (let i = 0; i < 30; i++) {
    settings.stephanie_course = 'null';
    const out = await c.startCourse();
    const n = Number(out.match(/Week (\d+)/)[1]);
    assert.notStrictEqual(n, 1, 'never a week already done');
    picks.add(n);
  }
  assert.ok(picks.size > 1, 'random, not always the same week');

  // A specific week: note made with every lesson unchecked.
  settings.stephanie_course = 'null';
  const started = await c.startCourse(12);
  assert.match(started, /Week 12: Genetics & DNA/);
  const title = 'Course — Week 12: Genetics & DNA';
  assert.match(notes[title], /- \[ \] 1\. Foundations/);
  assert.match(notes[title], /- \[ \] 4\. Advanced/);
  assert.match(await c.startCourse(), /already running/, 'one course at a time');

  // Brief: where he stopped.
  assert.match(await c.briefSection(), /Current lesson: 1 of 4 — Foundations/);
  assert.match(await c.setLesson('1'), /Checked off lesson 1.*Next: Core idea/);
  assert.match(notes[title], /- \[x\] 1\. Foundations/);
  assert.match(await c.briefSection(), /Current lesson: 2 of 4 — Core idea \(1 done\)\nAfter that: Applications/);
  assert.match(await c.setLesson('applications'), /lesson 3/, 'by name');
  assert.match(await c.statusText(), /\[ \] 2\. Core idea {2}← current/);
  assert.match(await c.setLesson('nope'), /No lesson "nope"/);

  // Can't finish with lessons left.
  assert.match(await c.finishCourse(), /Not finished: 2 lesson/);
  assert.strictEqual(docEdits.length, 0);
  await c.setLesson('2'); 
  assert.match(await c.setLesson('4'), /last lesson.*ask him/i);
  assert.match(await c.briefSection(), /waiting on your word/);

  // Finish: roadmap ticked in place (Docs API), next week picked at random.
  const fin = await c.finishCourse();
  assert.match(fin, /COURSE COMPLETE: Week 12/);
  assert.match(fin, /Week 12 checked off in the roadmap/);
  assert.match(fin, /NEW COURSE \(picked at random/);
  assert.match(docEdits[0].url, /docs\.googleapis\.com\/v1\/documents\/road:batchUpdate/);
  assert.ok(roadmap.includes('[x] Week 12: Genetics & DNA'));
  const next = Number(fin.match(/NEW COURSE[^:]*: Week (\d+)/)[1]);
  assert.ok([2, 3].includes(next), `next is a week not done (${next})`);
  assert.deepStrictEqual(JSON.parse(settings.stephanie_done_weeks), [12]);

  // Ticking any week by hand.
  assert.match(await c.checkWeek('Week 3'), /Week 3: Geometry & Trigonometry checked off in the roadmap/);
  assert.ok(roadmap.includes('[x] Week 3:'));
  assert.match(await c.checkWeek('3', false), /unchecked in the roadmap/);
  assert.ok(roadmap.includes('[ ] Week 3:'));
  assert.match(await c.checkWeek('999'), /no Week 999/);

  // The tags: checks need his own message this turn.
  const { runInjections } = require('../personaRuntime');
  const cur = JSON.parse(settings.stephanie_course).week;
  const curTitle = `Course — Week ${cur}: ${c.parseRoadmap(roadmap).get(cur).title}`;
  let out = await runInjections('Great. [LESSON_DONE: 1]', 'stephanie', { asked: '' });
  assert.match(out, /only on Mr\. Burrus's own word/, 'no owner message = no check');
  assert.match(notes[curTitle], /- \[ \] 1\./);
  out = await runInjections('Great. [LESSON_DONE: 1]', 'stephanie', { asked: 'yes that one is complete' });
  assert.match(out, /Checked off lesson 1/);
  out = await runInjections('[LESSON_DONE: 2]', 'ara', { asked: 'yes' });
  assert.strictEqual(out, '', 'only S.T.E.P.H.A.N.I.E. checks lessons');
  out = await runInjections('[COURSE_STATUS]', 'ara', { asked: '' });
  assert.match(out, /Lessons \(1\/4 done\)/, 'A.R.A. can read where he is');
  console.log('stephanie course: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
