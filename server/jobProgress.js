// Shared live progress for every long job a persona runs (owner's ask, 2026-11-22),
// the same kind of tracker J.A.R.V.I.S.'s workers have: a real percent, the step
// it's on, the app strip's chip (GET /jobs, also read by fetchWorkers) and a line
// on the silent Telegram board (server/workers.js owns the one board; it asks this
// module for the job lines). Workers themselves keep their own tracking.
//
//   const id = jobs.start('rogue', 'Clip scan: <title>', ['Download audio', 'Transcribe', ...]);
//   jobs.step(id, 'Transcribe');   // the steps before it are done
//   jobs.done(id, result) | jobs.fail(id, reason)
//   await jobs.run('rogue', title, steps, async (job) => { job.step('…'); return result; })
//
// percent = steps done / steps, held at 95 until the job really ends, 100 only on
// success; a failed job keeps its last number and its reason, and logs
// "jobs failed: <persona> <title>: <reason>" so the sentinel sees it. A step
// name that isn't in the list is added (e.g. one "Render clip 2" per clip).
// State: app_settings.jobs — running ones plus the last 50 finished, so they
// survive a restart; a job found "running" at boot was cut off by it and is
// failed (and logged) then. JOBS=off turns tracking off (calls become no-ops).
const { getSetting, setSetting } = require('./syncStore');

const KEY = 'jobs';
const KEEP = 50;
const SHOW_DONE_MS = 15 * 60e3; // finished ones stay on the strip / board 15 min
const enabled = () => String(process.env.JOBS || '').toLowerCase() !== 'off';

let jobs = {}; // id -> job
let seq = 0;
let loaded = null;
let saving = Promise.resolve();

const personaName = (p) => {
  try { const r = require('./personas').ROSTER[String(p).toLowerCase()]; if (r && r.name) return r.name; } catch { /* no roster in a bare test */ }
  return String(p || 'job').toUpperCase();
};

function load() {
  if (loaded) return loaded;
  loaded = (async () => {
    let saved = {};
    try { saved = JSON.parse(await getSetting(KEY, '{}')) || {}; } catch { saved = {}; }
    for (const [id, j] of Object.entries(saved.jobs || {})) {
      if (jobs[id]) continue;
      if (j.status === 'running') { // the process that ran it is gone
        j.status = 'failed'; j.endedAt = Date.now(); j.reason = 'cut off by a server restart'; j.progress = 'Failed';
        console.error(`jobs failed: ${personaName(j.persona)} ${j.title}: ${j.reason}`);
      }
      jobs[id] = j;
    }
    seq = Math.max(seq, Number(saved.seq) || 0, ...Object.keys(jobs).map(Number).filter(Number.isFinite));
    save();
  })().catch((e) => { console.error(`jobs failed: loading state: ${e.message}`); });
  return loaded;
}

function save() {
  const fin = Object.values(jobs).filter((j) => j.status !== 'running').sort((a, b) => a.endedAt - b.endedAt);
  for (const j of fin.slice(0, Math.max(0, fin.length - KEEP))) delete jobs[j.id];
  const snap = JSON.stringify({ seq, jobs });
  saving = saving.then(() => setSetting(KEY, snap)).catch((e) => console.error(`jobs failed: saving state: ${e.message}`));
  return saving;
}

function kick() {
  try { require('./workers').kick().catch(() => {}); } catch { /* board is optional */ }
}

function percentOf(j) {
  if (j.status === 'done') return 100;
  if (!j.steps.length) return null;
  return Math.min(95, Math.round((100 * (j.doneCount || 0)) / j.steps.length));
}

function touch(j, patch) {
  Object.assign(j, patch, { updatedAt: Date.now() });
  j.percent = percentOf(j);
  save(); kick();
}

function start(persona, title, steps = []) {
  if (!enabled()) return null;
  load();
  const id = String(++seq);
  jobs[id] = { id, persona: String(persona || 'ara').toLowerCase(), title: String(title || 'job').slice(0, 80), steps: steps.map((s) => String(s).slice(0, 60)).slice(0, 30), doneCount: 0, current: '', status: 'running', progress: 'Starting', percent: 0, reason: '', startedAt: Date.now(), endedAt: null, updatedAt: Date.now() };
  jobs[id].percent = percentOf(jobs[id]);
  save(); kick();
  return id;
}

// Working on `label` now: the steps before it are done. Unknown label → added.
function step(id, label, detail = '') {
  const j = id && jobs[id];
  if (!j || j.status !== 'running') return;
  label = String(label).slice(0, 60);
  let i = j.steps.indexOf(label);
  if (i < 0) { j.steps.push(label); i = j.steps.length - 1; }
  touch(j, { doneCount: Math.max(j.doneCount || 0, i), current: label, progress: String(detail || label).slice(0, 140) });
}

// What it's doing inside the current step (shown under the percent); no step change.
function note(id, text) {
  const j = id && jobs[id];
  if (!j || j.status !== 'running') return;
  touch(j, { progress: String(text || '').slice(0, 140) });
}

// Replace the plan outright (browse runs, whose brain writes its own); keeps the
// step it's on by position: `doneCount` steps are done.
function plan(id, names, doneCount) {
  const j = id && jobs[id];
  if (!j || j.status !== 'running' || !Array.isArray(names) || !names.length) return;
  j.steps = names.map((s) => String(s).slice(0, 60)).slice(0, 30);
  const n = Math.max(0, Math.min(j.steps.length, Number(doneCount) || 0));
  touch(j, { doneCount: n, current: j.steps[Math.min(n, j.steps.length - 1)] || '' });
}

function done(id, result = '') {
  const j = id && jobs[id];
  if (!j || j.status !== 'running') return;
  touch(j, { status: 'done', doneCount: j.steps.length, current: '', result: String(result || '').slice(0, 2000), endedAt: Date.now(), progress: 'Finished' });
}

function fail(id, reason) {
  const j = id && jobs[id];
  if (!j || j.status !== 'running') return;
  const why = String((reason && reason.message) || reason || 'unknown').replace(/\s+/g, ' ').slice(0, 300);
  console.error(`jobs failed: ${personaName(j.persona)} ${j.title}: ${why}`);
  touch(j, { status: 'failed', reason: why, endedAt: Date.now(), progress: 'Failed' }); // keeps its last number
}

// Track fn as one job. fn gets { id, step, note, plan }; its return value is the result;
// a throw fails the job and is rethrown. Tracking off → fn still runs.
async function run(persona, title, steps, fn) {
  const id = start(persona, title, steps);
  const h = { id, step: (l, d) => step(id, l, d), note: (t) => note(id, t), plan: (n, c) => plan(id, n, c) };
  try {
    const out = await fn(h);
    done(id, typeof out === 'string' ? out : '');
    return out;
  } catch (e) { fail(id, e); throw e; }
}

const live = () => Object.values(jobs).filter((j) => j.status === 'running');
const shown = (now = Date.now()) => Object.values(jobs)
  .filter((j) => j.status === 'running' || (j.endedAt && now - j.endedAt < SHOW_DONE_MS))
  .sort((a, b) => a.startedAt - b.startedAt);

const BAR = (p) => { const n = Math.max(0, Math.min(10, Math.round((p || 0) / 10))); return '▓'.repeat(n) + '░'.repeat(10 - n); };

// One board line, prefixed with the persona's name.
function boardLine(j, now = Date.now()) {
  const mins = Math.max(0, Math.round(((j.endedAt || now) - j.startedAt) / 60000));
  const who = personaName(j.persona);
  const title = String(j.title).slice(0, 60);
  if (j.status === 'running') return `🔧 ${who} ${title} · ${mins} min\n    ${j.percent != null ? `${BAR(j.percent)} ${j.percent}%${j.current ? ` · ${j.current}` : ''}` : 'planning'}`.slice(0, 300);
  if (j.status === 'done') return `✅ ${who} ${title} · done · ${BAR(100)} 100% · ${mins} min`;
  return `❌ ${who} ${title} · failed${j.percent != null ? ` at ${j.percent}%` : ''} · ${mins} min\n    ${String(j.reason || '').slice(0, 120)}`;
}

// For the app's strip: the same shape as a worker (workers.forApp), with kind 'job'
// and the persona's name so the chip can say whose it is.
async function forApp() {
  await load();
  return shown().map((j) => ({
    id: 'job-' + j.id, kind: 'job', persona: j.persona, personaName: personaName(j.persona), title: j.title, status: j.status,
    step: j.doneCount || 0, progress: j.status === 'failed' ? j.reason : j.progress || '', percent: j.percent ?? null, current: j.current || '',
    plan: j.steps.map((name, i) => ({ name, done: j.status === 'done' || i < (j.doneCount || 0) })),
    branch: null, startedAt: j.startedAt, endedAt: j.endedAt, url: null, slot: null,
  }));
}

module.exports = { start, step, note, plan, done, fail, run, forApp, load, live, shown, boardLine, percentOf, enabled, KEEP, _reset: () => { jobs = {}; seq = 0; loaded = null; saving = Promise.resolve(); }, _jobs: () => jobs, _flush: () => saving };
