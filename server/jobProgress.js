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
//
// Resume (owner, 2026-11-23): a job started with a `resume` ({ kind, args, to }) keeps
// what it takes to rerun it. At boot (recover(), ~60 s in) every job the restart cut
// off is restarted once with those arguments through RESUMERS (clip scan, raw edit,
// style learn, transcribe, deep research); A.R.A. tells him first, as text, which
// job, how far it got and that it's resuming. A job that was itself a resumption
// and is cut off again is only reported ("jobs failed: …"), not retried. A job with
// no resume info, or JOB_RESUME=off, is reported as cut off and left.
//
// Cancel (owner, 2026-11-23: "If I say cancel, it needs to get canceled … it better only cancel what I
// say to cancel"): every job has a cancel handle. cancel(id) aborts its AbortController (signal(id)),
// SIGKILLs every child process spawned inside the job's async context (yt-dlp, ffmpeg, the chat
// replay, Chrome — spawn/execFile are wrapped once so nothing has to opt in), runs the job's
// onCancel cleanups (temp files, locks like clipScan's `running`) at once, and marks it
// "cancelled" (not failed: no "jobs failed" line, no sentinel alert; a cancelled job is never resumed).
// step() throws JobCancelled in a cancelled job, so the work stops at the next step even if it was
// between children. Only [JOB_CANCEL] (tag(), below) cancels, one job at a time; nothing cancels
// automatically, and a new scan while one runs is refused, never replaces it.
const { AsyncLocalStorage } = require('async_hooks');
const cp = require('child_process');
const { getSetting, setSetting } = require('./syncStore');

const KEY = 'jobs';
const KEEP = 50;
const SHOW_DONE_MS = 15 * 60e3; // finished ones stay on the strip / board 15 min
const enabled = () => String(process.env.JOBS || '').toLowerCase() !== 'off';
const resumeOn = () => String(process.env.JOB_RESUME || '').toLowerCase() !== 'off';
const keyOf = (kind, args) => `${kind}:${JSON.stringify(args || {})}`;
const carry = new Map(); // keyOf(resume) -> attempts, set by recover() so the rerun's start() counts them
let deps = {}; // tests

let jobs = {}; // id -> job
const handles = new Map(); // id -> { ctl: AbortController, children: Set, cleanups: [] }
const als = new AsyncLocalStorage(); // the job id the current async chain belongs to

class JobCancelled extends Error {
  constructor(msg = 'cancelled by Mr. Burrus') { super(msg); this.name = 'JobCancelled'; this.cancelled = true; }
}
// A killed child makes the job throw some other error; once the job is cancelled, that's a cancel.
const asCancel = (id, e) => (isCancel(e) || !(id && jobs[id] && jobs[id].status === 'cancelled') ? e : new JobCancelled());
const isCancel = (e) => !!(e && (e.cancelled || e.name === 'JobCancelled'));

// Every child process started inside a job's async chain belongs to that job. Hooked on
// ChildProcess.prototype.spawn, which spawn / execFile / exec all go through, so it works
// however a module imported them.
if (!cp.ChildProcess.prototype.__jobsWrapped) {
  const origSpawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function (...a) {
    const ret = origSpawn.apply(this, a);
    try {
      const id = als.getStore();
      const j = id && jobs[id];
      if (j && this.pid) {
        if (j.status === 'cancelled') killChild(this); // started after the cancel: dead on arrival
        else { const h = handles.get(id); if (h) { h.children.add(this); this.once('close', () => h.children.delete(this)); } }
      }
    } catch { /* never block a spawn */ }
    return ret;
  };
  cp.ChildProcess.prototype.__jobsWrapped = true;
}
const killChild = (c) => { try { if (c.pid) { try { process.kill(-c.pid, 'SIGKILL'); } catch { c.kill('SIGKILL'); } } } catch { /* already gone */ } };
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
        j.cutOff = true;
        if (willResume(j)) console.warn(`jobs: ${personaName(j.persona)} ${j.title} was cut off by a restart, resuming it`);
        else console.error(`jobs failed: ${personaName(j.persona)} ${j.title}: ${j.reason}`);
      }
      jobs[id] = j;
    }
    seq = Math.max(seq, Number(saved.seq) || 0, ...Object.keys(jobs).map(Number).filter(Number.isFinite));
    save();
  })().catch((e) => { console.error(`jobs failed: loading state: ${e.message}`); });
  return loaded;
}

const willResume = (j) => resumeOn() && j.resume && j.resume.kind && RESUMERS[j.resume.kind] && !((j.attempts || 0) >= 1);

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

function start(persona, title, steps = [], resume = null) {
  if (!enabled()) return null;
  load();
  const id = String(++seq);
  let attempts = 0;
  if (resume && resume.kind) { const k = keyOf(resume.kind, resume.args); attempts = carry.get(k) || 0; carry.delete(k); }
  jobs[id] = { resume: resume && resume.kind ? { kind: resume.kind, args: resume.args || {}, to: resume.to || '' } : undefined, attempts, id, persona: String(persona || 'ara').toLowerCase(), title: String(title || 'job').slice(0, 80), steps: steps.map((s) => String(s).slice(0, 60)).slice(0, 30), doneCount: 0, current: '', status: 'running', progress: 'Starting', percent: 0, reason: '', startedAt: Date.now(), endedAt: null, updatedAt: Date.now() };
  jobs[id].percent = percentOf(jobs[id]);
  handles.set(id, { ctl: new AbortController(), children: new Set(), cleanups: [] });
  als.enterWith(id);
  save(); kick();
  return id;
}

// Working on `label` now: the steps before it are done. Unknown label → added.
function step(id, label, detail = '') {
  const j = id && jobs[id];
  if (j && j.status === 'cancelled') throw new JobCancelled();
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
  handles.delete(id);
  touch(j, { status: 'done', doneCount: j.steps.length, current: '', result: String(result || '').slice(0, 2000), endedAt: Date.now(), progress: 'Finished' });
}

function fail(id, reason) {
  const j = id && jobs[id];
  if (!j || j.status !== 'running') return;
  if (isCancel(reason)) return; // a cancel isn't a failure
  const why = String((reason && reason.message) || reason || 'unknown').replace(/\s+/g, ' ').slice(0, 300);
  console.error(`jobs failed: ${personaName(j.persona)} ${j.title}: ${why}`);
  handles.delete(id);
  touch(j, { status: 'failed', reason: why, endedAt: Date.now(), progress: 'Failed' }); // keeps its last number
}

// Track fn as one job. fn gets { id, step, note, plan }; its return value is the result;
// a throw fails the job and is rethrown. Tracking off → fn still runs.
async function run(persona, title, steps, fn, resume = null) {
  const id = start(persona, title, steps, resume);
  const h = { id, step: (l, d) => step(id, l, d), note: (t) => note(id, t), plan: (n, c) => plan(id, n, c), signal: signal(id), onCancel: (f) => onCancel(id, f), checkpoint: () => checkpoint(id) };
  try {
    const out = await als.run(id, () => fn(h));
    done(id, typeof out === 'string' ? out : '');
    return out;
  } catch (e) { const ce = asCancel(id, e); fail(id, ce); throw ce; }
}

// --- cancel -----------------------------------------------------------

const signal = (id) => { const h = handles.get(String(id)); return h ? h.ctl.signal : undefined; };
// Run fn when the job is cancelled (temp files, a lock). Runs at once if it already was.
function onCancel(id, fn) {
  const h = handles.get(String(id));
  if (h) h.cleanups.push(fn);
  else if (jobs[id] && jobs[id].status === 'cancelled') { try { fn(); } catch { /* best effort */ } }
}
// Throws JobCancelled if the job was cancelled; for long loops between steps.
function checkpoint(id) { id = id || als.getStore(); const j = id && jobs[id]; if (j && j.status === 'cancelled') throw new JobCancelled(); }
const currentId = () => als.getStore() || null;

// Cancel exactly this job. Returns the job, or null if it isn't running.
function cancel(id, by = 'owner') {
  id = String(id);
  const j = jobs[id];
  if (!j || j.status !== 'running') return null;
  const h = handles.get(id);
  handles.delete(id);
  j.status = 'cancelled'; j.endedAt = Date.now(); j.progress = 'Cancelled'; j.reason = `cancelled by ${by}`;
  j.updatedAt = Date.now();
  if (h) {
    try { h.ctl.abort(new JobCancelled()); } catch { /* ignore */ }
    for (const c of [...h.children]) killChild(c);
    for (const f of h.cleanups) { try { f(); } catch (e) { console.warn(`jobs: cleanup after cancel: ${e.message}`); } }
  }
  save(); kick();
  return j;
}

const mins = (j, now = Date.now()) => Math.max(0, Math.round((now - j.startedAt) / 60000));
const jobLine = (j) => `#${j.id} · ${personaName(j.persona)} · "${j.title}" · ${j.current || j.progress || 'starting'}${j.percent != null ? ` (${j.percent}%)` : ''} · ${mins(j)} min`;

async function listText() {
  await load();
  const l = live();
  if (!l.length) return 'JOBS: nothing is running right now.';
  return `JOBS RUNNING (${l.length}):\n${l.map(jobLine).join('\n')}`;
}

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NAME_ONLY = () => { try { const R = require('./personas').ROSTER; return new Set(Object.entries(R).flatMap(([k, v]) => [norm(k), norm(v.name), norm(v.name + 's'), norm(k + 's')])); } catch { return new Set(); } };

// Which running jobs does `arg` name? Exact id ("7", "#7", "job-7"), else words that all appear in
// a title. Never a persona name alone.
async function find(arg) {
  await load();
  const l = live();
  const a = String(arg || '').trim();
  const idm = /^(?:job[- ]?|#)?(\d+)$/i.exec(a);
  if (idm) { const j = l.find((x) => x.id === idm[1]); return { jobs: j ? [j] : [], how: 'id' }; }
  const w = norm(a);
  if (!w) return { jobs: [], how: 'empty' };
  if (NAME_ONLY().has(w) && !l.some((j) => norm(j.title).includes(w))) return { jobs: [], how: 'persona', persona: w };
  const exact = l.filter((j) => norm(j.title) === w);
  if (exact.length === 1) return { jobs: exact, how: 'title' };
  const words = w.split(' ');
  return { jobs: l.filter((j) => { const t = norm(j.title); return words.every((x) => t.includes(x)); }), how: 'words' };
}

const stillRunning = (except) => {
  const l = live().filter((j) => !except.includes(j.id));
  return l.length ? `Every other job is untouched and still running (${l.length}): ${l.map((j) => `#${j.id} "${j.title}"`).join('; ')}.` : 'There are no other jobs running.';
};

// [JOBS] and [JOB_CANCEL: id | words | all]. `asked` is his own message this turn.
async function tag(name, arg = '', { asked = '' } = {}) {
  if (name === 'JOBS') return listText();
  if (!enabled()) return 'JOB_CANCEL: job tracking is off (JOBS=off), so there is nothing to cancel here.';
  const a = String(arg || '').trim();
  if (!a) return `JOB_CANCEL: say which job: an id or the job's own words. Nothing cancelled.\n${await listText()}`;
  await load();
  if (/^(all|everything)$/i.test(a)) {
    if (!/\bcancel\s+(all|everything)\b/i.test(String(asked || '')) || /^\[(SENT ON YOUR OWN|The server restarted)/.test(String(asked || ''))) {
      return `JOB_CANCEL: all refused. It only runs when his own message literally says "cancel all" or "cancel everything". Nothing cancelled. Ask him which job, or whether he means all.\n${await listText()}`;
    }
    const l = live();
    if (!l.length) return 'JOB_CANCEL: all — nothing is running, so nothing was cancelled.';
    const done = l.map((j) => cancel(j.id)).filter(Boolean);
    return `JOB_CANCEL: all — he said so. Cancelled ${done.length}: ${done.map((j) => `#${j.id} "${j.title}"`).join('; ')}. (Worker jobs on GitHub are separate and untouched.)`;
  }
  const f = await find(a);
  if (f.how === 'persona') return `JOB_CANCEL: refused — a persona's name alone doesn't pick a job. Nothing cancelled. Which one?\n${await listText()}`;
  if (!f.jobs.length) return `JOB_CANCEL "${a}": nothing running matched. Nothing cancelled.\n${await listText()}`;
  if (f.jobs.length > 1) return `JOB_CANCEL "${a}": that matches ${f.jobs.length} running jobs, so I cancelled NONE. Ask him which one (say its id):\n${f.jobs.map(jobLine).join('\n')}`;
  const j = cancel(f.jobs[0].id);
  if (!j) return `JOB_CANCEL "${a}": that job had just finished, so nothing was cancelled.`;
  return `JOB_CANCEL: cancelled #${j.id} ${personaName(j.persona)}'s "${j.title}" (ran ${mins(j)} min): its work was killed and its temp files cleared. ${stillRunning([j.id])}`;
}

const JOB_TOOLS = ` - [JOBS] — every long job running right now (clip scans, raw edits, transcripts, research, website builds, browsing): id, who, title, step, minutes. Read it live; never guess what's running.
 - [JOB_CANCEL: id or the job's own words] — cancel EXACTLY ONE running job, only when he tells you to. Use the id from [JOBS]. Words must match one job's title; if they match several, nothing is cancelled and you ask him which. Never cancel by a persona's name. [JOB_CANCEL: all] works only when his own message says "cancel all" or "cancel everything". The receipt names what was cancelled and what is still running: report it as it is. A new CLIP_SCAN while one runs is refused, never replaces it: tell him which is running and ask whether to cancel it.`;

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
  if (j.status === 'cancelled') return `🛑 ${who} ${title} · cancelled · ${mins} min`;
  return `❌ ${who} ${title} · failed${j.percent != null ? ` at ${j.percent}%` : ''} · ${mins} min\n    ${String(j.reason || '').slice(0, 120)}`;
}

// For the app's strip: the same shape as a worker (workers.forApp), with kind 'job'
// and the persona's name so the chip can say whose it is.
async function forApp() {
  await load();
  return shown().map((j) => ({
    id: 'job-' + j.id, kind: 'job', persona: j.persona, personaName: personaName(j.persona), title: j.title, status: j.status,
    step: j.doneCount || 0, progress: j.status === 'failed' || j.status === 'cancelled' ? j.reason : j.progress || '', percent: j.percent ?? null, current: j.current || '',
    plan: j.steps.map((name, i) => ({ name, done: j.status === 'done' || i < (j.doneCount || 0) })),
    branch: null, startedAt: j.startedAt, endedAt: j.endedAt, url: null, slot: null,
  }));
}


// --- resume at boot ---------------------------------------------------

const send = (text) => (deps.tell || ((t) => require('./loud').tellAra(`job-cut:${text.length}:${text.slice(0, 40)}`, t)))(text);
const via = (persona) => {
  const tg = require('./telegram');
  const own = tg.botFor(persona);
  const bot = own && own.isConfigured() ? own : tg.botFor('ara');
  return bot && bot.isConfigured() ? { bot, owner: tg.OWNER_ID } : null;
};
const toOwner = async (persona, text) => { const b = via(persona); if (b) await b.bot.sendMessage(b.owner, text, { remember: true }); };

// kind -> (args, job) starts the same work again with the saved arguments; the result goes out as usual.
const RESUMERS = {
  clip_scan: (a) => require('./clipScan').scanInBackground(a.url, a.focus || '', { title: a.title || '' }),
  transcribe: (a) => require('./transcribe').transcribeInBackground(a.url, a.persona || 'ara'),
  raw_edit: (a) => require('./rawEdit').resumeEdit(a),
  style_learn: (a) => require('./rawEdit').resumeStyleLearn(a),
  deep_research: (a) => require('./personaRuntime').runDeepResearch(a.topic, async (t) => toOwner(a.persona || 'ara', t), a.persona || 'ara'),
};

const how = (j) => `${j.percent != null ? `${j.percent}%` : 'no steps'} done${j.current ? `, on "${j.current}"` : ''}`;

// Boot, once the server is healthy: restart each cut-off job once; report the rest.
async function recover() {
  await load();
  const cut = Object.values(jobs).filter((j) => j.cutOff && !j.handled);
  const out = [];
  for (const j of cut) {
    j.handled = true;
    const who = personaName(j.persona);
    const what = `${who}'s job "${j.title}" (${how(j)})`;
    let note;
    if (!j.resume || !j.resume.kind || !RESUMERS[j.resume.kind]) note = `A restart cut off ${what}. It can't be resumed (nothing saved to rerun it), so it needs asking again.`;
    else if (!resumeOn()) note = `A restart cut off ${what}. Resuming is switched off (JOB_RESUME=off), so it was not restarted.`;
    else if ((j.attempts || 0) >= 1) note = `A restart cut off ${what} again. It had already been resumed once, so I've stopped rather than loop. Ask again once the server has settled.`;
    else {
      carry.set(keyOf(j.resume.kind, j.resume.args), (j.attempts || 0) + 1);
      note = `A restart cut off ${what}. Resuming it now from where its saved work left off; the result comes as usual.`;
      try {
        const r = (deps.resumers || RESUMERS)[j.resume.kind](j.resume.args, j);
        if (r && r.catch) r.catch((e) => { console.error(`jobs failed: resuming ${who} ${j.title}: ${e.message}`); send(`Resuming ${who}'s job "${j.title}" failed: ${e.message}`).catch(() => {}); });
        j.handled = 'resumed'; out.push({ id: j.id, resumed: true });
      } catch (e) {
        carry.delete(keyOf(j.resume.kind, j.resume.args));
        console.error(`jobs failed: resuming ${who} ${j.title}: ${e.message}`);
        note = `A restart cut off ${what}, and resuming it failed: ${e.message}`;
      }
    }
    if (j.handled !== 'resumed') { console.error(`jobs failed: ${who} ${j.title}: cut off by a server restart, not resumed`); out.push({ id: j.id, resumed: false }); }
    await send(note).catch((e) => console.error(`jobs failed: telling him about ${j.title}: ${e.message}`));
  }
  if (cut.length) await save();
  return out;
}

// For the redeploy receipt: what persona jobs are running and will resume.
const runningLines = () => live().map((j) => `${personaName(j.persona)}'s "${j.title}" (${j.percent != null ? j.percent + '%' : 'starting'})${willResume(j) ? ' — resumes after the restart' : ' — cannot resume, ask again'}`);

module.exports = { asCancel, cancel, tag, find, listText, onCancel, signal, checkpoint, currentId, isCancel, JobCancelled, JOB_TOOLS, recover, runningLines, RESUMERS, resumeOn, _setDeps: (d) => { deps = d || {}; }, start, step, note, plan, done, fail, run, forApp, load, live, shown, boardLine, percentOf, enabled, KEEP, _reset: () => { handles.clear(); jobs = {}; seq = 0; loaded = null; saving = Promise.resolve(); }, _jobs: () => jobs, _flush: () => saving };
