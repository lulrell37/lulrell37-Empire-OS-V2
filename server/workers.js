// J.A.R.V.I.S.'s workers (owner's idea, 2026-11-22): he stays at the front desk
// and hands each task to a worker of its own, so he is free to talk 100% of the time.
//
//   code    — its own Claude Code on its own GitHub Actions runner
//             (.github/workflows/worker.yml), NOT on the server: the server opens
//             an issue holding the task (label `worker`), fires repository_dispatch
//             `worker-run`, and polls the issue for the job's report. The job works
//             on branch worker/<id> cut from main and pushes only that branch.
//             (Running them on the 2 GB server froze it, 2026-11-22.)
//   browse  — a browser task on the server, on its own browser profile
//             (worker-<id>); one at a time, behind the memory gate
//             (claudeSub.cliSlot 'heavy'), since each Chrome is ~400 MB.
//
// HARD CAP: 3 running at once, total, whatever WORKERS_MAX says (owner's order:
// "3 and 3 only"); the rest wait in line. He sees each by its slot ("Worker 2 of
// 3"), never the internal id, which only counts up (a "#16" read as 16 running).
// Browse workers share every browser's logins (browserAgent's shared cookie jar);
// one stuck on information gets it from A.R.A. (his email and notes, araFinds.js)
// first; only what nobody can supply reaches him, from J.A.R.V.I.S. (it's his work). Every result goes straight to Mr.
// Burrus on J.A.R.V.I.S.'s bot (logged in his chat history, so J.A.R.V.I.S. knows
// it) — no engine turn, so J.A.R.V.I.S. is never busy checking a worker when he
// wants to talk. The issue holds the task and the full report: the proof it ran.
// State: app_settings.workers (+ workers_seq); a restart picks code workers back
// up where they are (the runner keeps going) and re-runs a cut-off browse once.
// WORKERS=off stops it. Tags: [WORKER_START: code|browse | title | task | note
// title], [WORKER_STATUS], [WORKER_STOP: id].
// The same progress goes to Telegram as one live board message on J.A.R.V.I.S.'s
// bot ("Telegram board" below; WORKER_TG_BOARD=off stops it); each worker's plan
// gives a real percent ("Progress" below). node server/scripts/test-workers.js.
const { getSetting, setSetting } = require('./syncStore');

const KEY = 'workers';
const HARD_CAP = 3;
const MAX = () => Math.min(HARD_CAP, Math.max(1, Number(process.env.WORKERS_MAX) || HARD_CAP));
const BROWSE_MAX = 1; // Chrome on the 2 GB server: one at a time
const POLL_MS = () => Number(process.env.WORKER_POLL_MS) || 60e3;
const NO_RUN_MS = 6 * 60e3; // dispatched but GitHub never started it
const CODE_TIMEOUT_MS = () => (Number(process.env.WORKER_CODE_MIN) || 210) * 60e3; // per run; the job's own limit is 200
// Big jobs run as several runs on the same branch (CONTINUE or the time limit): up to this many.
const MAX_LEGS = () => Math.max(1, Math.min(6, Number(process.env.WORKER_MAX_RUNS) || 3));
const KEEP_MS = 24 * 3600e3; // finished ones stay listed a day
const SHOW_DONE_MS = 15 * 60e3; // and on his strip for 15 minutes
const enabled = () => String(process.env.WORKERS || '').toLowerCase() !== 'off';

let list = null; // id -> worker
const ctrls = new Map(); // id -> AbortController
let deps = null; // swapped in by the test

// ── Failures are always logged, with the cause ───────────────────────────────
// Owner's rule, 2026-11-22: nothing dies silently. Every failure prints
// "workers failed: #id title: reason" (the sentinel watches "<name> failed") and is
// appended to app_settings.worker_failures (last 50), which survives a restart
// where the in-memory server log doesn't.
const FAIL_KEY = 'worker_failures';
const FAIL_KEEP = 50;
let failLog = Promise.resolve();
function logFailure(w, reason) {
  const why = String(reason || '').trim() || 'no reason recorded';
  console.error(`workers failed: #${w.id} ${w.title}: ${why.slice(0, 500)}`);
  const entry = { at: new Date().toISOString(), id: w.id, title: w.title, kind: w.kind, reason: why.slice(0, 1000) };
  failLog = failLog.then(async () => {
    let rows;
    try { rows = JSON.parse(await getSetting(FAIL_KEY, '[]')); } catch { rows = []; }
    if (!Array.isArray(rows)) rows = [];
    await setSetting(FAIL_KEY, JSON.stringify([...rows, entry].slice(-FAIL_KEEP)));
  }).catch((e) => console.error('workers failed: saving the failure log:', e.message));
  return failLog;
}

// A Drive/Docs file link must never be opened in a browser worker: Drive files are
// read with the Drive tags.
const DRIVE_LINK = /https?:\/\/(?:drive|docs)\.google\.com\/\S*/i;
const DRIVE_REFUSAL = 'a browse worker must not open a Google Drive / Docs file link (drive.google.com, docs.google.com): Drive files are read with the Drive tags ([READ_FILE_ID], [READ_NOTE], [SEARCH_DRIVE]), not a browser';

function d() {
  return deps || {
    gh: (p, o) => require('./buildAgent').gh(p, o),
    repo: () => require('./buildAgent').REPO,
    slot: (o) => require('./claudeSub').cliSlot({ pool: 'heavy', ...o }),
    browse: (persona, name, task, opts) => require('./browserAgent').browseRun(persona, name, task, opts),
    find: (q, o) => require('./araFinds').findForJob(q, o),
    tell: async (text) => {
      const tg = require('./telegram');
      const id = tg.botFor('jarvis') && tg.botFor('jarvis').isConfigured() ? 'jarvis' : 'ara';
      const bot = tg.botFor(id);
      if (!bot || !bot.isConfigured() || !tg.OWNER_ID) throw new Error('no Telegram bot to send it on');
      await bot.sendMessage(tg.OWNER_ID, id === 'jarvis' ? text : `J.A.R.V.I.S.:\n${text}`);
    },
    voice: async (spoken) => {
      const tg = require('./telegram');
      const bot = tg.botFor('jarvis');
      if (!bot || !bot.isConfigured() || !tg.OWNER_ID) return false; // no J.A.R.V.I.S. bot: the text path decides where it goes
      const { ogg, error } = await require('./personaVoice').voiceNote('jarvis', spoken);
      if (!ogg) throw new Error(error || 'no audio');
      await bot.sendVoice(tg.OWNER_ID, ogg);
      return true;
    },
    onDone: (w) => (w.purpose === 'autofix' ? require('./autoFix').finish(w) : w.purpose === 'feature' ? require('./featureRequests').finish(w) : null),
    saveNote: (title, body) => require('./google').saveDriveNote(title, body),
    board: tgBoardDeps(),
    boardGapMs: BOARD_GAP_MS,
  };
}

async function load() {
  if (list) return list;
  try { list = JSON.parse(await getSetting(KEY, '{}')) || {}; } catch { list = {}; }
  return list;
}
let saving = Promise.resolve();
function save() {
  const now = Date.now();
  for (const [id, w] of Object.entries(list)) if (w.endedAt && now - w.endedAt > KEEP_MS) delete list[id];
  const snap = JSON.stringify(list);
  saving = saving.then(() => setSetting(KEY, snap)).catch((e) => console.error('workers failed: saving state:', e.message));
  return saving;
}

let seq = 0;
let seqLoad = null;
// Parallel starts (three [WORKER_START] tags in one reply run under Promise.all) must each get
// their own id: the counter is loaded once and bumped with no await in between.
async function nextId() {
  if (!seq) { seqLoad = seqLoad || getSetting('workers_seq', 0).then((v) => Number(v) || 0); const base = await seqLoad; seqLoad = null; seq = Math.max(seq, base); }
  seq = Math.max(seq, ...Object.keys(list).map(Number).filter(Number.isFinite)) + 1;
  const id = String(seq);
  await setSetting('workers_seq', id);
  return id;
}
const running = () => Object.values(list).filter((w) => w.status === 'running');
const queued = () => Object.values(list).filter((w) => w.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);

async function start({ kind = 'code', title, task, note = '', purpose = '' }) {
  if (!enabled()) throw new Error('workers are switched off (WORKERS=off)');
  kind = /^b/i.test(kind) ? 'browse' : 'code';
  if (!String(task || '').trim()) throw new Error('a worker needs its task');
  if (kind === 'browse' && DRIVE_LINK.test(String(task))) {
    logFailure({ id: '-', title: String(title || task).slice(0, 80), kind }, `refused: ${DRIVE_REFUSAL}`);
    throw new Error(`refused: ${DRIVE_REFUSAL}`);
  }
  await load();
  const id = await nextId();
  list[id] = { id, kind, purpose, title: String(title || task).slice(0, 80), task: String(task), note: String(note || ''), status: 'queued', createdAt: Date.now(), step: 0, progress: 'Waiting for a free slot', attempts: 0 };
  await save();
  boardKick();
  pump();
  return list[id];
}

// Next in line that may start: total under 3, and browse only while no other browse runs.
function pump() {
  if (!list) return;
  for (;;) {
    const run = running();
    if (run.length >= MAX()) return;
    const browsing = run.filter((w) => w.kind === 'browse').length;
    const next = queued().find((w) => w.kind !== 'browse' || browsing < BROWSE_MAX);
    if (!next) return;
    launch(next);
  }
}

function update(w, patch) { Object.assign(w, patch, { updatedAt: Date.now() }); save(); boardKick(); }

// ── Progress ─────────────────────────────────────────────────────────────────
// Owner's ask, 2026-11-22: a real percentage, not a timer. A worker writes its own
// plan (code: PLAN_FILE on its runner, mirrored into an issue comment, steps ticked as it finishes them; browse:
// the browser brain's "plan" + "planStep"), and percent = steps done / steps,
// held at 95 until the run really ends, 100 only on success. A failed or stopped
// one keeps its last number. No plan yet → percent null ("planning").
const PLAN_FILE = '.worker-plan.md';
const MAX_PLAN = 20;

// "1. [x] Read the code" / "- [ ] Run the tests" → [{ name, done }], or null.
function parsePlan(text) {
  const steps = [];
  for (const l of String(text || '').split('\n')) {
    const m = l.match(/^\s*(?:\d+[.)]|[-*])\s*\[([ xX✓✔]?)\]\s*(.+?)\s*$/);
    if (m && steps.length < MAX_PLAN) steps.push({ name: m[2].replace(/^~~|~~$/g, '').slice(0, 80), done: m[1].trim() !== '' });
  }
  return steps.length ? steps : null;
}

function percentOf(plan, status) {
  if (status === 'done') return 100;
  if (!plan || !plan.length) return null;
  return Math.min(95, Math.round((100 * plan.filter((s) => s.done).length) / plan.length));
}

// The patch for a new plan: percent, the step it's on now (first unticked).
function planPatch(w, plan) {
  if (!plan) return {};
  const cur = plan.find((s) => !s.done);
  return { plan, percent: percentOf(plan, w.status), current: cur ? cur.name : plan[plan.length - 1].name };
}

// A code worker runs on a GitHub runner, so its plan reaches the server as an issue
// comment marked <!-- worker-plan --> (worker.yml mirrors PLAN_FILE into it every
// 15 s); the newest one wins. Read in the same poll as the result comment.
function readPlanComment(w, comments) {
  const c = [...(comments || [])].reverse().find((x) => /<!-- worker-plan/.test((x && x.body) || ''));
  if (!c) return;
  const plan = parsePlan(String(c.body).replace(/<!--[^>]*-->/g, ''));
  if (plan && JSON.stringify(plan) !== JSON.stringify(w.plan)) update(w, planPatch(w, plan));
}

const BAR = (p) => { const n = Math.max(0, Math.min(10, Math.round((p || 0) / 10))); return '▓'.repeat(n) + '░'.repeat(10 - n); };
// "▓▓▓▓▓░░░░░ 50% · Run the tests", "planning", or "step 4" for a browse run with no plan.
function progressLabel(w) {
  if (w.percent != null) return `${BAR(w.percent)} ${w.percent}%${w.status === 'running' && w.current ? ` · ${w.current}` : ''}`;
  if (w.kind === 'browse' && w.step) return `step ${w.step}`;
  return 'planning';
}

async function launch(w) {
  const ctrl = new AbortController();
  ctrls.set(w.id, ctrl);
  const resuming = w.kind === 'code' && w.issue; // a restart: the runner kept going, just watch it again
  // Which of the 3 slots it holds: what he sees ("Worker 2 of 3"), not its running count.
  const taken = new Set(running().filter((x) => x.id !== w.id).map((x) => x.slot));
  w.slot = [1, 2, 3].find((n) => !taken.has(n)) || 1;
  update(w, { status: 'running', startedAt: w.startedAt && resuming ? w.startedAt : Date.now(), attempts: (w.attempts || 0) + (resuming ? 0 : 1), progress: resuming ? 'Watching it again after a server restart' : 'Starting' });
  let out;
  let release = () => {};
  try {
    if (w.kind === 'browse') {
      update(w, { progress: 'Waiting for room on the server' });
      release = await d().slot({ signal: ctrl.signal });
      update(w, { progress: 'Starting' });
      out = await runBrowse(w, ctrl.signal);
    } else out = await runCode(w, ctrl.signal);
  } catch (e) {
    out = { status: ctrl.signal.aborted ? 'stopped' : 'failed', result: e.message };
  }
  release();
  ctrls.delete(w.id);
  require('./workerTools').revoke(w.id).catch(() => {}); // its tool token ends with it
  if (w.kind === 'code') out = codeStatus(out);
  if (out.status === 'failed') logFailure(w, out.result); // every failed worker, whichever way it failed
  update(w, { status: out.status, result: String(out.result || '').slice(0, 20000), branch: out.branch || w.branch, pushed: out.pushed || '', endedAt: Date.now(), partial: !!out.partial, progress: out.status === 'done' ? 'Finished' : out.partial ? 'Partly done — needs Mr. Burrus' : out.status === 'needs_you' ? 'Needs Mr. Burrus' : out.status === 'stopped' ? 'Stopped' : 'Failed', ...(out.status === 'done' ? { percent: 100, current: '' } : {}) });
  report(w);
  pump();
}

const BLOCKED = /\b(blocked|could ?n[o']t|cannot|can't|unable to|no account (?:has been|was|exists|yet)|no (?:api )?key (?:exists|was|has)|not (?:been )?(?:created|completed|finished|successful)|(?:did|does|do) not (?:finish|complete|succeed|work)|failed|stuck at|stopped at)\b/i;
const WAITING = /\b(verif\w*|e-?mail|inbox|code|sign[ -]?in|log[ -]?in|captcha|phone|text message|sms|approv\w*|needs? (?:you|mr|him)|waiting (?:on|for))\b/i;
// What a finished browse run really is: done | needs_you | failed.
// What only he can give: a code texted to his phone, an approval on his phone or an
// authenticator, his ID / face / card, or his OK before something acts in the world.
const ONLY_HIM = /\b(sms|text(ed)? (message|code)|texted|sent to (your|his) (phone|number)|phone number ending|on (your|his) phone|authenticator|2fa app|push notification|approve (it |the sign[ -]?in )?on|government id|photo id|selfie|face (scan|verification)|credit card|debit card|card (number|details)|payment (method|details)|billing|captcha|i'?m not a robot|(approve|ok|okay|permission|go[ -]ahead) (to|before) (send|post|buy|book|pay|delete|submit|connect|publish)|should i (send|post|buy|book|pay|delete|submit|connect|publish))\b/i;
const onlyHim = (q) => ONLY_HIM.test(String(q || ''));
function browseStatus(r) {
  if (r.status === 'ask') return 'needs_you';
  if (r.status !== 'done') return 'failed';
  const text = `${r.reason || ''} ${r.text || ''}`;
  const unfilled = /\{\{\s*\w+\s*\}\}/.test(String(r.text || ''));
  const notDone = r.success === false || (r.success !== true && BLOCKED.test(String(r.text || ''))) || unfilled;
  if (!notDone) return 'done';
  return !unfilled && WAITING.test(text) && /\b(waiting|needs? (?:you|mr|him)|ask|verification|captcha|code)\b/i.test(text) ? 'needs_you' : 'failed';
}
// A code worker's report that says it didn't finish: FAILED -> failed, PARTLY DONE -> needs_you (partial, still shippable).
function codeStatus(out) {
  if (out.status !== 'done') return out;
  const first = String(out.result || '').trim();
  if (/^FAILED\b/i.test(first)) return { ...out, status: 'failed' };
  if (/^PARTLY DONE\b/i.test(first)) return { ...out, status: 'needs_you', partial: true };
  return out;
}

const ASK_ROUNDS = 6; // stops one browse worker works through before he hears
const FIND_MAX = 4;   // A.R.A. lookups per worker
async function runBrowse(w, signal) {
  const onStep = (n, line) => update(w, { step: n, progress: line.slice(0, 140) });
  // The brain's plan and the plan step it's on: the ones before it are done.
  const onPlan = (names, at) => update(w, planPatch(w, names.map((name, i) => ({ name, done: i < at - 1 }))));
  if (DRIVE_LINK.test(w.task)) return { status: 'failed', result: `refused: ${DRIVE_REFUSAL}` };
  let r = await d().browse(`worker-${w.id}`, `J.A.R.V.I.S.'s worker`, w.task, { ownerText: '', onStep, onPlan, signal, noMail: true });
  // Stopped for something (a sign-in, an account email, a code, a fresh link…):
  // A.R.A. looks in his email and notes first and it carries on with what she finds
  // (owner, 2026-11-22). Nothing she can find → J.A.R.V.I.S. answers his worker, or it
  // decides it itself (owner, 2026-11-26: "don't come to me unless you need me"). Every
  // new stop goes round again, so a second "get me the newest email" goes to her, not
  // him (it used to reach him once her two tries were used, 2026-11-26). He hears only
  // what only he has (onlyHim), or after ASK_ROUNDS stops in one job.
  let made = '';
  let finds = 0, decides = 0;
  const browseOn = (extra, secrets) => d().browse(`worker-${w.id}`, `J.A.R.V.I.S.'s worker`, `${w.task}${extra}`, { ownerText: '', onStep, onPlan, signal, noMail: true, secrets });
  for (let round = 0; round < ASK_ROUNDS && r.status === 'ask' && !(signal && signal.aborted); round++) {
    const q = String(r.result || r.text);
    if (onlyHim(q)) break;
    if (finds < FIND_MAX && d().find && require('./araFinds').asksForInfo(q)) {
      finds++;
      update(w, { progress: 'Getting what it needs from A.R.A. (his email and notes)' });
      const got = await d().find(q, { task: w.task, site: r.url || '' }).catch(() => null);
      if (got) {
        const shown = got.kind === 'link' ? '{{LINK}} (use it as the goto url exactly; it is filled in for you, same browser)' : got.secret ? '{{INFO}} (type exactly that; it is filled in for you)' : `"${got.value}" (also available as {{INFO}})`;
        r = await browseOn(`\n\n[A.R.A. FOUND WHAT YOU STOPPED FOR — ${got.what}: ${shown}. Carry on with the task from where the browser is.]`, got.kind === 'link' ? { LINK: got.value, INFO: got.value } : { INFO: got.value });
        continue;
      }
    }
    if (decides >= 2) break;
    decides++;
    // The phone line: J.A.R.V.I.S. answers his worker first (he can pull in A.R.A. or others).
    update(w, { progress: 'Asking J.A.R.V.I.S.' });
    const said = await (d().askJarvis || require('./workerTools').askJarvis)(w.id, q.slice(0, 800)).catch(() => '');
    const jarvis = said && !/NEEDS_HIM:/.test(said) ? `\n${said.slice(0, 2000)}\n` : '';
    update(w, { progress: 'Working it out without him' });
    made = made || require('crypto').randomBytes(12).toString('base64').replace(/[+/=]/g, '').slice(0, 14) + '!7a';
    r = await browseOn(`\n${jarvis}\n[YOU STOPPED TO ASK: "${q.slice(0, 400)}". Mr. Burrus is not asked for this — ${jarvis ? 'J.A.R.V.I.S. answered above; use it' : 'nobody on the team had it, so decide it yourself'} and carry on from where the browser is: a new password → type {{NEWPASS}} (it is made and saved for him); a choice between options → take the sensible default for his business; a sign-in method → "Continue with Google" or email; a code or sign-in link from his email → request it on the page and ask for it again (A.R.A. fetches the newest one); anything else → find another way on the page. Stop with "ask" again ONLY for something truly only he has: a code texted to his phone, an approval on his phone, his ID or payment card, or his OK before sending, posting, buying or deleting.]`, { NEWPASS: made });
  }
  if (made) {
    const used = /typed into[^\n]*\(a saved secret\)/.test(String(r.text || ''));
    if (used) await d().saveNote(`Login — ${w.title}`.slice(0, 90), `# Login — ${w.title}\n_Made by J.A.R.V.I.S.'s worker #${w.id}, ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET._\n\nSite: ${(/last page (\S+?)\)?:/.exec(String(r.text || '')) || [])[1] || '?'}\nPassword: ${made}\n`).catch((e) => console.error(`workers failed: #${w.id} saving the new password: ${e.message}`));
  }
  // A Groq API key in the result is saved straight to the server and masked in the report.
  let keyNote = '';
  const L = require('./llm');
  if (L.GROQ_KEY_RE && L.GROQ_KEY_RE.test(`${r.text || ''}`)) {
    const k = await L.saveGroqKey(r.text).catch((e) => ({ ok: false, text: `GROQ_KEY failed: ${e.message}` }));
    if (!k.ok) console.error(`workers failed: #${w.id} saving the Groq key: ${k.text}`);
    keyNote = `\n(${k.text})`;
    r = { ...r, text: String(r.text).replace(new RegExp(L.GROQ_KEY_RE.source, 'g'), (x) => `${x.slice(0, 8)}…`), result: String(r.result || '').replace(new RegExp(L.GROQ_KEY_RE.source, 'g'), (x) => `${x.slice(0, 8)}…`) };
  }
  if (signal && signal.aborted) return { status: 'stopped', result: `stopped on request. ${String(r.text || '').slice(0, 2000)}`.trim() };
  // Explicit verdict first (the brain's done {success, reason}), then the wording of
  // the result: a "done" that says it was blocked is never done (worker 57, 2026-11-24).
  const status = browseStatus(r);
  let saved = '';
  if (w.note && r.result && status === 'done') {
    saved = await d().saveNote(w.note, `# ${w.note}\n_Collected by J.A.R.V.I.S.'s worker #${w.id}, ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET._\n\n${r.result}`)
      .then(() => `\n(Saved to his Drive as "${w.note}".)`).catch((e) => `\n(Couldn't save the Drive note "${w.note}": ${e.message})`);
  }
  return { status, result: `${r.text}${saved}${keyNote}` };
}

const sleepFor = (ms, signal) => new Promise((r) => {
  const wake = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', wake); r(); };
  const t = setTimeout(wake, ms);
  if (signal) signal.addEventListener('abort', wake, { once: true });
});
const noMention = (t) => String(t).replace(/@claude/gi, '@ claude'); // claude.yml answers "@claude"

// Drive files named in a code worker's task download through the server
// (GET /worker-files/:id) with a token only that worker's runs get, for those files,
// for WORKER_FILES_H (12) hours. The task itself sits in a public issue, so the token
// never goes there: it rides in the dispatch payload and the job masks it.
const DRIVE_IDS = /(?:drive|docs)\.google\.com\/(?:file\/d\/|document\/d\/|spreadsheets\/d\/|presentation\/d\/|open\?id=|uc\?id=)([\w-]{20,})|\bdrive(?:[ _-]?file)?(?: id)?:\s*([\w-]{20,})/gi;
function driveIdsIn(text) {
  return [...new Set([...String(text || '').matchAll(DRIVE_IDS)].map((m) => m[1] || m[2]).filter(Boolean))].slice(0, 20);
}
async function grantFiles(w) {
  const ids = driveIdsIn(w.task);
  if (!ids.length) return '';
  const token = require('crypto').randomBytes(24).toString('hex');
  const { getSetting, setSetting } = require('./syncStore');
  let grants = {};
  try { grants = JSON.parse(await getSetting('worker_file_grants', '{}')) || {}; } catch { grants = {}; }
  const now = Date.now();
  for (const [k, g] of Object.entries(grants)) if (!g || g.exp < now) delete grants[k];
  grants[token] = { worker: w.id, ids, exp: now + (Number(process.env.WORKER_FILES_H) || 12) * 3600e3 };
  await setSetting('worker_file_grants', JSON.stringify(grants));
  return token;
}
async function fileGrant(token, id) {
  if (!token || !id) return null;
  const { getSetting } = require('./syncStore');
  let grants = {};
  try { grants = JSON.parse(await getSetting('worker_file_grants', '{}')) || {}; } catch { return null; }
  const g = grants[token];
  return g && g.exp > Date.now() && g.ids.includes(id) ? g : null;
}
async function dispatch(w, base, branch, leg) {
  const files_token = (w.leg ? null : await grantFiles(w).catch((e) => { console.error(`workers failed: #${w.id} file grant: ${e.message}`); return ''; })) || w.filesToken || '';
  // Same for J.A.R.V.I.S.'s command tags (server/workerTools.js): one token per worker, kept across runs.
  const tools_token = w.toolsToken || await require('./workerTools').grantTools(w).catch((e) => { console.error(`workers failed: #${w.id} tools grant: ${e.message}`); return ''; });
  const server_url = (() => { try { return require('./redeploy').publicUrl() || ''; } catch { return ''; } })();
  await d().gh(`${base}/dispatches`, { method: 'POST', body: { event_type: 'worker-run', client_payload: { worker: w.id, issue: w.issue, branch, title: w.title.slice(0, 60), leg, max_legs: MAX_LEGS(), server_url, files_token, tools_token } } });
  update(w, { dispatchedAt: Date.now(), leg, filesToken: files_token || undefined, toolsToken: tools_token || undefined });
}

// A code worker on its own GitHub runner (.github/workflows/worker.yml).
async function runCode(w, signal) {
  if (!process.env.GITHUB_TOKEN && !deps) throw new Error('no GITHUB_TOKEN on the server, so a code worker can\'t be started on GitHub');
  const R = d().repo();
  const base = `/repos/${R.owner}/${R.repo}`;
  const branch = w.branch || `worker/${w.id}-${String(w.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task'}`;
  if (!w.issue) {
    update(w, { branch, progress: 'Opening its GitHub issue' });
    const issue = await d().gh(`${base}/issues`, { method: 'POST', body: { title: `Worker #${w.id}: ${w.title}`.slice(0, 120), body: noMention(w.task), labels: ['worker'] } });
    update(w, { issue: issue.number, issueUrl: issue.html_url, progress: 'Starting its own Claude Code on GitHub' });
    await dispatch(w, base, branch, 1);
  }
  for (;;) {
    const deadline = (w.dispatchedAt || Date.now()) + CODE_TIMEOUT_MS(); // per run
    if (signal.aborted) {
      if (w.runId) await d().gh(`${base}/actions/runs/${w.runId}/cancel`, { method: 'POST' }).catch(() => {});
      return { status: 'stopped', result: 'stopped on request', branch };
    }
    const comments = await d().gh(`${base}/issues/${w.issue}/comments?per_page=100`).catch(() => null);
    const leg = w.leg || 1;
    const done = (comments || []).find((c) => /<!-- worker-result/.test(c.body || '') && ((/leg=(\d+)/.exec(c.body) || [0, '1'])[1] === String(leg)));
    if (done && /status=continue/.test(done.body) && leg < MAX_LEGS()) {
      // Too big for one run: the next run picks up on the same branch and issue.
      update(w, { leg: leg + 1, runId: null, runUrl: null, completedSeen: null, progress: `Continuing — run ${leg + 1} of up to ${MAX_LEGS()}` });
      await dispatch(w, base, branch, leg + 1);
      continue;
    }
    readPlanComment(w, comments); // its plan, mirrored into an issue comment by the job
    if (done) {
      const body = String(done.body);
      const ok = /status=(done|continue)/.test(body);
      const pushed = (/branch: ([^·\n]+)/.exec(body) || [])[1] || '';
      return { status: ok ? 'done' : 'failed', result: body.replace(/<!--[^>]*-->\n?/, '').trim(), branch, pushed: pushed.trim() };
    }
    if (!w.runId) {
      const runs = await d().gh(`${base}/actions/runs?event=repository_dispatch&per_page=30`).catch(() => null);
      const run = runs && (runs.workflow_runs || []).find((r) => String(r.name || '').startsWith(`Worker #${w.id} `) && Date.parse(r.created_at) >= (w.dispatchedAt || 0) - 120e3);
      if (run) update(w, { runId: run.id, runUrl: run.html_url, progress: 'Working on its own GitHub runner' });
      else if (Date.now() - (w.dispatchedAt || 0) > NO_RUN_MS) throw new Error('GitHub never started its run — check that .github/workflows/worker.yml is on main and the repo has the CLAUDE_CODE_OAUTH_TOKEN secret');
    } else {
      const run = await d().gh(`${base}/actions/runs/${w.runId}`).catch(() => null);
      if (run && run.status === 'completed') {
        // Give the report comment a minute to land, then call it.
        if (!w.completedSeen) update(w, { completedSeen: Date.now() });
        else if (Date.now() - w.completedSeen > 90e3) throw new Error(`its GitHub run ended (${run.conclusion}) without a report — ${run.html_url}`);
      } else if (run) {
        const mins = Math.round((Date.now() - (w.startedAt || Date.now())) / 60000);
        update(w, { progress: `Working on GitHub, ${mins} min in` });
      }
    }
    if (Date.now() > deadline) {
      if (w.runId) await d().gh(`${base}/actions/runs/${w.runId}/cancel`, { method: 'POST' }).catch(() => {});
      throw new Error(`ran past ${Math.round(CODE_TIMEOUT_MS() / 60000)} minutes, so it was stopped`);
    }
    await sleepFor(POLL_MS(), signal);
  }
}

// The result goes straight to Mr. Burrus on J.A.R.V.I.S.'s bot (and so into
// J.A.R.V.I.S.'s chat history): no engine turn, so he's never tied up by it.
function report(w) {
  if (w.status === 'stopped' && w.purpose !== 'feature') return; // a stopped build request still comes back to him
  Promise.resolve(d().onDone && d().onDone(w)).then((handled) => {
    if (handled) return;
    return defaultReport(w);
  }).catch((e) => {
    console.error(`workers failed: couldn't report #${w.id}: ${e.message}`);
    require('./loud').tellAra(`worker:${w.id}`, `J.A.R.V.I.S.'s worker #${w.id} ("${w.title}") ${w.status === 'done' ? 'finished' : w.status}, but its report couldn't be sent (${e.message.slice(0, 120)}).${w.issueUrl ? ` Full report: ${w.issueUrl}` : ''}`);
  });
}
function defaultReport(w) {
  {
    const mins = Math.max(1, Math.round(((w.endedAt || Date.now()) - (w.startedAt || w.createdAt)) / 60000));
    const icon = { done: '✅', needs_you: '✋', failed: '❌' }[w.status] || '•';
    const head = w.partial ? 'PARTLY DONE — needs you' : ({ done: 'finished', needs_you: 'stopped — it needs you', failed: 'FAILED' }[w.status] || w.status);
    const links = [w.pushed ? `Branch: ${w.pushed}` : (w.branch && w.kind === 'code' ? `Branch: ${w.branch} (nothing pushed)` : ''), w.issueUrl ? `Full report: ${w.issueUrl}` : ''].filter(Boolean).join('\n');
    const text = `${icon} Worker ${w.slot || '?'} of 3 ${head} — "${w.title}" (${w.kind}, ${mins} min)\n\n${String(w.result || '(no report)').slice(0, 3000)}${links ? `\n\n${links}` : ''}${w.kind === 'code' && (w.status === 'done' || w.partial) && w.pushed && /pushed/.test(w.pushed) ? '\n\nSay "push" to J.A.R.V.I.S. to ship it.' : ''}`;
    return voiceThenText(w, text);
  }
}

// ---- the voice note before the text (WORKER_VOICE=off to stop) ----
const VOICE_MAX = 600;
const VOICE_TIMEOUT_MS = 75e3;
const voiceEnabled = () => !/^(off|0|false|no)$/i.test(String(process.env.WORKER_VOICE || ''));

// Short, plain, no AI: slot + title, the outcome, a sentence or two of what it did or why
// it failed, and what he does next. Never URLs, branches, issue numbers or code.
function spokenReport(w) {
  const clean = (t) => String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:[\w.-]+\/)+[\w.-]+/g, ' ')            // paths and branch names
    .replace(/\b[0-9a-f]{7,40}\b/gi, ' ')                 // commit hashes
    .replace(/#\d+/g, ' ')                                // issue / PR numbers
    .replace(/[*_>#|]+/g, ' ')
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, ' ')
    .replace(/\s+/g, ' ').trim();
  const body = clean(String(w.result || '').replace(/^\s*(?:DONE|PARTLY DONE|FAILED|CONTINUE)\b[:.\-—\s]*/i, ''));
  const sentences = (body.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) || []).map((x) => x.trim()).filter((x) => x.length > 3);
  const outcome = { done: 'is done', failed: 'failed', needs_you: 'needs you', stopped: 'was stopped' }[w.status] || w.status;
  const partly = (w.status === 'done' || w.partial) && /^\s*PARTLY DONE/i.test(String(w.result || ''));
  const ask = w.status === 'failed' ? 'Tell me if you want it tried again.'
    : w.status === 'needs_you' ? 'It is waiting on you.'
    : w.kind === 'code' && (w.status === 'done' || w.partial) && w.pushed && /pushed/.test(w.pushed) ? 'Say push to ship it.' : '';
  const head = `Worker ${w.slot || ''}${w.slot ? ', ' : ' '}${clean(w.title)}, ${partly ? 'is partly done' : outcome}.`.replace(/\s+/g, ' ');
  let out = head;
  const room = VOICE_MAX - head.length - (ask ? ask.length + 1 : 0) - 1;
  let mid = '';
  for (const s of sentences.slice(0, 2)) { if ((mid + ' ' + s).trim().length <= room) mid = (mid + ' ' + s).trim(); else break; }
  if (!mid && sentences[0] && room > 40) mid = sentences[0].slice(0, room - 1).replace(/\s+\S*$/, '') + '.';
  if (mid) out += ' ' + mid;
  if (ask) out += ' ' + ask;
  return require('./voiceCues').speakNames(out).slice(0, VOICE_MAX);
}

// Voice first, then the text exactly as before. The voice can't hold the text back past its
// own timeout, and its failures are logged for the sentinel.
async function voiceThenText(w, text) {
  const send = d().voice;
  if (send && voiceEnabled()) {
    let timer, late = false;
    try {
      const job = Promise.resolve().then(() => send(spokenReport(w)));
      job.catch(() => {});
      await Promise.race([job, new Promise((_, rej) => { timer = setTimeout(() => { late = true; rej(new Error(`timed out after ${Math.round(VOICE_TIMEOUT_MS / 1000)}s`)); }, VOICE_TIMEOUT_MS); })]);
    } catch (e) {
      console.error(`workers failed: voice for #${w.id}: ${e.message}`);
    } finally { clearTimeout(timer); }
  }
  return d().tell(text);
}

async function get(id) { await load(); return list[String(id).replace(/^#/, '')] || null; }

// [WORKER_MESSAGE: slot | text] — the phone line to a running code worker: it lands in
// its inbox (workerTools.sendToWorker), which the worker reads between steps.
async function message(arg) {
  await load();
  const i = String(arg || '').indexOf('|');
  if (i < 0) return 'give the worker and the message: [WORKER_MESSAGE: 2 | use the Google sign-in instead]';
  const ref = arg.slice(0, i).replace(/^#|worker/gi, '').trim();
  const text = arg.slice(i + 1).trim();
  const w = running().find((x) => String(x.slot) === ref) || list[ref];
  if (!w) return `no worker ${ref} running`;
  if (w.status !== 'running' && w.status !== 'queued') return `worker ${w.slot || ref} isn't running (${w.status}) — start a new one instead`;
  if (w.kind !== 'code') return `worker ${w.slot} is a browse worker; those can't take messages mid-run — stop it and start it again with the change`;
  await require('./workerTools').sendToWorker(w.id, text);
  return `✓ sent to worker ${w.slot || '?'} ("${w.title}"); it reads its messages between steps and follows them.`;
}

async function stop(id) {
  await load();
  const ref = String(id).replace(/^#/, '').trim();
  // "2" means the worker in slot 2 while one is running there; otherwise its id.
  const w = running().find((x) => String(x.slot) === ref) || list[ref];
  if (!w) return `no worker ${id}`;
  if (w.status === 'queued') { update(w, { status: 'stopped', endedAt: Date.now(), progress: 'Stopped' }); return `#${w.id} taken out of the line`; }
  const c = ctrls.get(w.id);
  if (c) { c.abort(); return `#${w.id} stopping`; }
  return `#${w.id} isn't running (${w.status})`;
}

// At boot: anything the restart cut off runs again once; a second cut-off is reported.
async function recover() {
  if (!enabled()) return;
  await load();
  for (const w of Object.values(list)) {
    if (w.status !== 'running') continue;
    if (w.kind === 'code' && w.issue) { update(w, { status: 'queued', progress: 'Watching it again after a server restart' }); continue; }
    if ((w.attempts || 0) >= 2) {
      const why = 'the server restarted in the middle of it twice, so it was not started a third time';
      logFailure(w, why);
      update(w, { status: 'failed', endedAt: Date.now(), progress: 'Failed', result: why });
      report(w);
    } else update(w, { status: 'queued', progress: 'Restarting after a server restart' });
  }
  boardKick(); // a board left open before the restart is picked up and finished
  pump();
}

// ── Telegram board ───────────────────────────────────────────────────────────
// Owner's ask, 2026-11-22: the strip's worker chips, on Telegram. When a worker
// starts and no board is live, J.A.R.V.I.S.'s bot sends him ONE silent message
// listing every running and waiting worker; that message is then edited in place
// as steps change (at most once every 10 s, never with unchanged text). Finished,
// failed and stuck ones show as done / failed / needs you for 15 min, like the
// app. When nothing is running or waiting it gets a last all-done edit and stops;
// the next worker opens a new board. The message id is app_settings.workers_tg_board,
// so a restart keeps editing the same message. Edits aren't logged anywhere; the
// first send is one short line in his history. The wake-up reports are separate.
const BOARD_KEY = 'workers_tg_board';
const BOARD_GAP_MS = 10e3;
const BOARD_REFRESH_MS = 60e3; // keeps the minutes current between steps
const boardEnabled = () => String(process.env.WORKER_TG_BOARD || '').toLowerCase() !== 'off';
const pinEnabled = () => String(process.env.WORKER_TG_PIN || '').toLowerCase() !== 'off'; // WORKER_TG_PIN=off: never pin the board
const PIN_TRIES = 3; // a pin that keeps failing is given up on, not retried on every edit

function tgBoardDeps() {
  const pick = () => {
    const tg = require('./telegram');
    const persona = tg.botFor('jarvis') && tg.botFor('jarvis').isConfigured() ? 'jarvis' : 'ara';
    const bot = tg.botFor(persona);
    if (!bot || !bot.isConfigured()) throw new Error('no Telegram bot configured');
    return { tg, persona, bot };
  };
  return {
    ready: () => { try { pick(); return true; } catch { return false; } }, // no bot (dev): no board, no noise
    send: async (text) => { const { tg, bot } = pick(); const m = await bot.tg('sendMessage', { chat_id: tg.OWNER_ID, text, disable_notification: true }); return m.message_id; },
    edit: async (id, text) => { const { tg, bot } = pick(); await bot.editMessageText(tg.OWNER_ID, id, text); },
    pin: async (id) => { const { tg, bot } = pick(); await bot.pinChatMessage(tg.OWNER_ID, id); },
    unpin: async (id) => { const { tg, bot } = pick(); await bot.unpinChatMessage(tg.OWNER_ID, id); },
    log: async (text) => { const { tg, persona } = pick(); await tg.logOwn(persona, tg.OWNER_ID, text); },
  };
}

const BOARD_MARK = { done: '✅', failed: '❌', needs_you: '✋', stopped: '⏹' };
const BOARD_STATE = { done: 'done', failed: 'failed', needs_you: 'needs you', stopped: 'stopped' };
function boardLine(w, now = Date.now()) {
  const mins = Math.max(0, Math.round(((w.endedAt || now) - (w.startedAt || w.createdAt)) / 60000));
  const title = String(w.title || '').slice(0, 60);
  const who = w.slot ? `Worker ${w.slot}/3` : 'Worker';
  if (w.status === 'running') return `🔧 ${who} ${title} · ${mins} min\n    ${progressLabel(w).slice(0, 90)}\n    ${String(w.progress || '').slice(0, 120)}`;
  if (w.status === 'queued') return `⏳ Waiting: ${title}`;
  // An ended one keeps its last number: "failed at 40%", "stopped at 60%".
  const at = w.percent != null ? (w.status === 'done' ? ` · ${BAR(100)} 100%` : ` at ${w.percent}%`) : '';
  return `${BOARD_MARK[w.status] || '•'} ${who} ${title} · ${BOARD_STATE[w.status] || w.status}${at} · ${mins} min`;
}
function boardText(now = Date.now()) {
  const J = require('./jobProgress');
  const shown = Object.values(list)
    .filter((w) => ['running', 'queued'].includes(w.status) || (w.endedAt && now - w.endedAt < SHOW_DONE_MS))
    .sort((a, b) => a.createdAt - b.createdAt);
  const jobShown = J.shown(now);
  const jr = J.live().length;
  const r = running().length, q = queued().length;
  const head = jr ? `Live jobs: ${r + jr} running${q ? `, ${q} waiting` : ''}` : r || q ? `J.A.R.V.I.S.'s workers: ${r} running${q ? `, ${q} waiting` : ''}` : jobShown.length && !shown.length ? 'Live jobs: all done ✓' : 'J.A.R.V.I.S.\'s workers: all done ✓';
  const lines = [...shown.map((w) => [w.createdAt, boardLine(w, now)]), ...jobShown.map((j) => [j.startedAt, J.boardLine(j, now)])].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const time = new Date(now).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return `${head}\n\n${lines.join('\n')}\n\n${r || q || jr ? 'Updated' : 'Finished'} ${time} ET`.slice(0, 4000);
}

let board; // undefined = not read yet; null = no live board
let boardLast = 0, boardTimer = null, boardBusy = false, boardAgain = false, boardRefresh = null;
async function loadBoard() {
  if (board !== undefined) return board;
  try { board = JSON.parse(await getSetting(BOARD_KEY, 'null')) || null; } catch { board = null; }
  if (board && !board.messageId) board = null;
  return board;
}
// Pin / unpin the board message. Never throws: a failure is logged for the sentinel
// and the board carries on. `board.pinned` is saved with the id, so a restart or an
// edit never pins twice.
async function boardPin(B) {
  if (!board || board.pinned || !pinEnabled() || !B.pin || (board.pinTries || 0) >= PIN_TRIES) return;
  try { await B.pin(board.messageId); board.pinned = true; } catch (e) {
    board.pinTries = (board.pinTries || 0) + 1;
    console.error(`workers failed: telegram board pin: ${e.message}`);
  }
}
async function boardUnpin(B, b) {
  if (!b || !b.pinned || !pinEnabled() || !B.unpin) return;
  try { await B.unpin(b.messageId); } catch (e) {
    if (!/not found|not pinned|can't be edited/i.test(e.message)) console.error(`workers failed: telegram board pin: unpin: ${e.message}`);
  }
}
const saveBoard = () => setSetting(BOARD_KEY, JSON.stringify(board || null));

// Every state change kicks the board; edits wait out the 10 s gap.
function boardKick() {
  if (!boardEnabled() || !list || boardTimer) return;
  const gap = (deps && deps.boardGapMs) || BOARD_GAP_MS;
  boardTimer = setTimeout(() => { boardTimer = null; boardTick(); }, Math.max(0, boardLast + gap - Date.now()));
  if (boardTimer.unref) boardTimer.unref();
}

async function boardTick() {
  if (boardBusy) { boardAgain = true; return; }
  boardBusy = true;
  try {
    await loadBoard();
    const active = running().length + queued().length + require('./jobProgress').live().length;
    if (!board && !active) return;
    const text = boardText();
    if (board && text === board.text) return;
    const B = d().board;
    if (!B || (B.ready && !B.ready())) return;
    boardLast = Date.now();
    if (!board) {
      const messageId = await B.send(text);
      board = { messageId, text, openedAt: Date.now() };
      await boardPin(B);
      await saveBoard();
      const first = [...[...running(), ...queued()].map((w) => `${w.slot ? `worker ${w.slot}` : 'a waiting worker'} "${w.title}"`), ...require('./jobProgress').live().map((j) => `${j.persona} job "${j.title}"`)].join(', ');
      Promise.resolve(B.log(`[J.A.R.V.I.S.'s live worker board posted (${first}); it updates in place as they work]`)).catch(() => {});
    } else {
      try { await B.edit(board.messageId, text); } catch (e) {
        // Deleted by him, or too old to edit: start a fresh board next time.
        if (/not found|can't be edited|cannot be edited/i.test(e.message)) { const old = board; board = null; await boardUnpin(B, old); await saveBoard(); boardAgain = true; return; }
        throw e;
      }
      board.text = text;
      if (!active) { await boardUnpin(B, board); board = null; }
      else await boardPin(B); // the all-done edit: this board is finished
      await saveBoard();
    }
  } catch (e) {
    console.error(`workers failed: telegram board: ${e.message}`);
  } finally {
    boardBusy = false;
    if (boardAgain) { boardAgain = false; boardKick(); }
    clearTimeout(boardRefresh); boardRefresh = null;
    if (board) { boardRefresh = setTimeout(boardKick, (deps && deps.boardRefreshMs) || BOARD_REFRESH_MS); if (boardRefresh.unref) boardRefresh.unref(); }
  }
}

function line(w) {
  const mins = Math.max(0, Math.round((Date.now() - (w.startedAt || w.createdAt)) / 60000));
  const now = w.percent != null ? `${w.percent}%${w.current ? ` (${w.current})` : ''}` : progressLabel(w);
  return `${w.slot && w.status === 'running' ? `Worker ${w.slot} of 3` : w.status === 'queued' ? 'Waiting' : 'Done'} (id ${w.id}) ${w.kind} "${w.title}" — ${w.status}${w.status === 'running' ? `, ${mins} min, ${now}: ${w.progress}` : w.percent != null ? `, ${w.percent}%` : ''}${w.branch ? ` (branch ${w.branch})` : ''}${w.issueUrl ? ` ${w.issueUrl}` : ''}${['failed', 'stopped', 'needs_you'].includes(w.status) ? ` — ${w.status === 'failed' ? 'reason' : 'note'}: ${String(w.result || '').trim().slice(0, 200) || 'no reason recorded'}` : ''}`;
}

async function statusText() {
  await load();
  const all = Object.values(list).sort((a, b) => a.createdAt - b.createdAt);
  if (!all.length) return 'No workers in the last day.';
  return `${running().length} of ${MAX()} running, ${queued().length} waiting (3 at once, hard cap):\n${all.map(line).join('\n')}`;
}

// For the app's strip: what's working and what just finished.
async function forApp() {
  await load();
  const now = Date.now();
  return Object.values(list)
    .filter((w) => ['running', 'queued'].includes(w.status) || (w.endedAt && now - w.endedAt < SHOW_DONE_MS))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((w) => ({ id: w.id, kind: w.kind, title: w.title, status: w.status, step: w.step || 0, progress: w.progress || '', percent: w.percent ?? null, current: w.current || '', plan: w.plan || [], branch: w.branch || null, startedAt: w.startedAt || null, endedAt: w.endedAt || null, url: w.runUrl || w.issueUrl || null, slot: w.status === 'running' ? w.slot || null : null }));
}

// [WORKER_SHIP: id | all] — his "push" for workers' work (owner, 2026-11-23: every
// J.A.R.V.I.S. task goes to a worker, so shipping is done by the server, not by his
// engine): each finished code worker's branch is merged into main through GitHub
// (a merge commit; nothing to merge is fine; a conflict is reported and the branch is
// left alone), and if server files changed the server redeploys a minute later, once
// this reply has gone out. App files ship in the APK main's push builds.
const NO_APK = /^(server\/|docs\/|site\/|scripts\/canva-site\/)|\.md$|^\.github\/workflows\/(server-check|claude|worker)\.yml$/;
async function ship(ref) {
  await load();
  const want = String(ref || 'all').trim().toLowerCase();
  const done = Object.values(list).filter((w) => w.kind === 'code' && (w.status === 'done' || w.partial) && w.branch && !w.shipped && !/no commits/i.test(w.pushed || ''));
  const pick = want === 'all' || !want ? done : done.filter((w) => w.id === want.replace(/^#/, '') || w.branch === want || String(w.title).toLowerCase().includes(want));
  // Not a worker's: any other branch on GitHub ships the same way (pushing code is his job).
  if (!pick.length && want !== 'all' && /^[\w./-]+$/.test(String(ref).trim())) {
    pick.push({ id: '', title: String(ref).trim(), branch: String(ref).trim(), createdAt: 0, external: true });
  }
  if (!pick.length) return 'nothing to ship: no finished worker with an unmerged branch' + (want !== 'all' ? ` matches "${ref}"` : '');
  const { owner, repo } = d().repo();
  const lines = [];
  let server = false, app = false;
  for (const w of pick.sort((a, b) => a.createdAt - b.createdAt)) {
    try {
      const cmp = await d().gh(`/repos/${owner}/${repo}/compare/main...${encodeURIComponent(w.branch)}`).catch(() => null);
      const files = ((cmp && cmp.files) || []).map((f) => f.filename);
      const r = await d().gh(`/repos/${owner}/${repo}/merges`, { method: 'POST', body: { base: 'main', head: w.branch, commit_message: w.external ? `Ship ${w.branch}` : `Ship worker #${w.id}: ${w.title}` } });
      if (!w.external) update(w, { shipped: Date.now() });
      if (!r || !r.sha) { lines.push(`"${w.title}": already in main`); continue; }
      if (files.some((f) => /^server\//.test(f) || /^site\//.test(f))) server = true;
      if (files.some((f) => !NO_APK.test(f))) app = true;
      lines.push(`"${w.title}": merged into main (${files.length} file${files.length === 1 ? '' : 's'})`);
    } catch (e) {
      const conflict = /409|conflict/i.test(e.message);
      lines.push(`"${w.title}": NOT merged — ${conflict ? 'it conflicts with main; start a worker to rebase its branch ' + w.branch + ' onto main, then ship again' : e.message}`);
      if (!conflict && !w.external) logFailure(w, `ship failed: ${e.message}`);
    }
  }
  if (server) {
    setTimeout(() => require('./redeploy').requestRedeploy('ship').catch((e) => {
      console.error(`workers failed: redeploy after shipping: ${e.message}`);
      require('./loud').tellAra('ship-redeploy', `J.A.R.V.I.S. shipped workers' work to main, but the redeploy couldn't start: ${e.message}. Say "redeploy" to J.A.R.V.I.S.`);
    }), 60000).unref();
  }
  return `${lines.join('; ')}.${server ? ' Server code changed: the server redeploys in about a minute and A.R.A. confirms when it is live.' + require('./redeploy').runningJobsNote() : ''}${app ? ' App files changed: the new APK builds from main now.' : ''}`;
}

async function tag(name, arg) {
  if (name === 'WORKER_STATUS') return `WORKERS:\n${await statusText()}`;
  if (name === 'WORKER_STOP') return `WORKER_STOP: ${await stop(String(arg || '').trim())}`;
  if (name === 'WORKER_MESSAGE') return `WORKER_MESSAGE: ${await message(arg)}`;
  if (name === 'WORKER_SHIP') return `WORKER_SHIP: ${await ship(arg)}`;
  const p = String(arg || '').split('|').map((x) => x.trim());
  let [kind, title, task, note] = p;
  if (!/^(code|browse)$/i.test(kind || '')) { note = task; task = title; title = kind; kind = 'code'; }
  if (!task) { task = title; title = String(title || '').slice(0, 60); }
  const w = await start({ kind, title, task, note });
  const on = running().find((x) => x.id === w.id);
  return `WORKER_START: ✓ ${on ? `worker ${on.slot} of 3` : 'a worker'} (${w.kind}) "${w.title}" ${on ? 'is working on it now' : `is in line (all 3 slots busy)`}${w.kind === 'code' ? ', on its own GitHub runner' : ''}. Its progress shows on his notification strip; its report goes straight to him on your bot when it's done (you'll see it in this chat).`;
}

// No worker starts before he and J.A.R.V.I.S. agree on the problem and the plan
// (owner, 2026-11-26: "instead of talking to find what we can do, Jarvis jumps and
// puts a worker on it when we didn't agree what the problem was"). [WORKER_START]
// runs at once only on his own message that is a clear go: "go", "do it", "yes",
// "fix it", "put a worker on it", or an order that starts with a verb ("make me…",
// "build…", "sign me up for…"). A problem report or a question ("X keeps failing",
// "why did…") starts nothing: J.A.R.V.I.S. tells him what he thinks is wrong and
// how he'd fix it, and the task waits on a Start card (tg_pending `worker_start`)
// or on his next "go". Code-driven workers (auto-fix, feature requests, A.R.A.
// finds) don't use the tag and aren't gated.
const SYSTEM_TURN = /^\[(SENT ON YOUR OWN|The server restarted|REDEPLOY|WAKE|OUT OF BAND|A\.R\.A\. FOUND)/i;
const GO = /\b(go( ahead| for it)?|do (it|that|this|both|all)|yes|yeah|yep|yup|sure|ok(ay)?|approved?|proceed|start (it|that|on it|the worker)|run (it|with it)|fix (it|that|them|this)|build (it|that)|make it so|ship it|(let'?s|let us|lets)\s+(do|go|try|run|start|fix|build|use|make|just)|(we|you) can (do|try) (that|it|this)|try (that|it|this) (way|again)|sounds good|send (it|that) to a worker|put (a |the )?(worker|bot)s? on|get (a |the )?(worker|bot)s? on|hand it (off|to a worker))\b/i;
const ORDER = /^(please\s+)?(make|create|set ?up|build|write|draft|design|get|find|research|sign (me )?up|register|open|start|run|fix|update|change|add|put|prepare|handle|finish|redo|retry|try|rebuild|install|connect|look into|check|compare|transcribe|clip|edit|scan|send)\b/i;
const QUESTION = /^(why|what|how|when|where|who|which|is|are|was|were|did|does|do|has|have|should|would)\b|\?\s*$/i;
function ownerGo(text) {
  const t = String(text || '').replace(/^\[HE IS REPLYING TO[^\]]*\]\s*/i, '').trim();
  if (!t || SYSTEM_TURN.test(t)) return false;
  return goWords(t.replace(/^\[[^\]]{0,40}\]\s*/, '')); // a "[Mon 3:00 PM]" stamp in front
}
// His way into an order (owner, 2026-11-26: "try the sign up again" got Start cards
// when it came as "Jarvis, try…" / "tell him to try…"): a name or filler in front, or
// handing it to the worker, is still his order.
const LEAD_IN = /^(?:(?:hey|yo|ok(?:ay)?|alright|all right|so|now|and|but|then|well|please|sir|jarvis|j\.a\.r\.v\.i\.s\.?)(?:[\s,.!:-]+|$))+/i;
const HAND_OVER = /^(?:i (?:want|need) (?:you|him|them|the workers?|a worker|your workers?) to|tell (?:him|them|the workers?|jarvis|your workers?) to|have (?:him|them|the workers?|a worker|your workers?|jarvis)|let (?:him|them|the workers?)|get (?:him|them|the workers?) to|go ahead and|just)\s+/i;
// "try … again", "retry", "one more time": a retry of something already agreed.
const AGAIN = /\b(?:try|retry|redo|run|do|give)\b[^.?!\n]{0,60}\b(?:again|another (?:go|shot|try))\b|\bretry\b|\bone more (?:try|time|shot)\b/i;
function goWords(t) {
  if (!t) return false;
  if (GO.test(t)) return true;
  // A retry or agreement anywhere in a short, non-question message ("new code, try groq again").
  if (t.length <= 200 && !/\?\s*$/.test(t) && !QUESTION.test(t.replace(LEAD_IN, '')) && AGAIN.test(t)) return true;
  let first = t.split(/(?<=[.!?\n])\s+/).map((x) => x.replace(LEAD_IN, '').trim()).find(Boolean) || '';
  first = first.replace(HAND_OVER, '');
  if (/^(can|could|will|would) you\b/i.test(first) && ORDER.test(first.replace(/^(can|could|will|would) you\s+(please\s+)?/i, ''))) return true;
  if (QUESTION.test(first)) return false;
  return AGAIN.test(first) || ORDER.test(first);
}
async function startGate(arg, { asked = '', depth = 0 } = {}) {
  if (depth === 0 && ownerGo(asked)) return { run: true };
  const p = String(arg || '').split('|').map((x) => x.trim());
  const title = (p[1] || p[2] || 'a task').slice(0, 80);
  const q = (d().query || require('./db').query);
  const id = require('./syncStore').newId().slice(0, 12);
  const label = `Start worker: ${title}?`;
  const detail = `${String(p[2] || arg).slice(0, 1200)}\n\nJ.A.R.V.I.S. wants a ${p[0] === 'browse' ? 'browse' : 'code'} worker on this. Nothing starts until you tap Confirm (or tell him "go").`;
  await q('INSERT INTO tg_pending (id, persona, kind, label, detail, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, 'jarvis', 'worker_start', label, detail, JSON.stringify({ arg }), Date.now()]);
  return { run: false, confirm: { id, label, detail },
    text: `WORKER_START: NOT STARTED — his message wasn't a go-ahead, so no worker is running. Tell him in plain words what you think the problem is (with the evidence) and how you'd go about it, then ask if he wants a worker on it. It starts when he taps Start on the card or says go.` };
}

const WORKER_TOOLS = ` - [WORKER_START: code|browse | short title | the full task, self-contained | Drive note title (browse only, optional)] — hand a task to a worker of your own so you stay free to talk to him. code = its own Claude Code on its own GitHub runner (not the server), on a worker/ branch cut from main: it commits, the job pushes that branch only, never main; good for any general job (code, research, checks, writing), big ones included: a code worker has Chrome, ffmpeg, ImageMagick and Python, keeps large media in GitHub releases, and a job too big for one run (about 3 h) carries on in up to 3 runs on the same branch by itself. Put any Google Drive file it needs in the task as its link (drive.google.com/file/d/…, docs.google.com/…) or "drive: <id>": the worker downloads it through the server, however big. browse = a browser task on the server, its result saved to that Drive note; one browse at a time. Every browser shares the same saved logins, so a site you or A.R.A. are signed in to works for a worker too. A file in his Google Drive is read with your Drive tags ([READ_NOTE], [SEARCH_DRIVE], [READ_FILE_ID]), not a browse worker. HARD CAP: 3 workers running at once, total; the rest wait in line. Call them by their slot, "worker 1, 2 or 3", never by a running count; [WORKER_STOP: 2] stops the one in slot 2. [WORKER_MESSAGE: 2 | the message] talks to the code worker in slot 2 while it runs (a correction, an answer, a change of plan); it reads it between steps. Your workers also call you mid-job with questions: they reach you here as "ONE OF YOUR OWN WORKERS IS ASKING" — answer so they keep going. A browse worker stuck on information (a sign-in, an account email, a code) gets it from A.R.A., who searches his email and notes, and carries on; only what nobody can supply comes to him, from you. Each one's progress shows live on his notification strip, and its report goes straight to him on your bot when it ends (you'll see it in this chat), so you don't need to relay it; if he asks, read [WORKER_STATUS]. A code worker's work ships when he says push / ship / merge: [WORKER_SHIP: id] (or all, or any branch name) — the server merges it into main and redeploys if server code changed; never merge by hand. Use them for EVERY task, whatever its length (his standing order, 2026-11-22), so you are always free to talk to him — but only once you and he agree on the problem and the plan: when he reports a problem or asks why, first tell him what you think is wrong (with evidence) and how you'd fix it, and ask; [WORKER_START] on anything but his clear go becomes a Start card and starts nothing. Only straight answers and seconds-long lookups stay with you.
 - [WORKER_STATUS] — every worker: running, waiting, done, with its current step and GitHub link. [WORKER_STOP: id] — stop one (a GitHub run is cancelled).`;

// Persona jobs (jobProgress.js) share this one board: load the workers, then update it.
async function kick() { await load(); boardKick(); }

module.exports = { get, message, onlyHim, ownerGo, startGate, spokenReport, VOICE_MAX, kick, start, stop, ship, driveIdsIn, fileGrant, MAX_LEGS, recover, statusText, forApp, tag, WORKER_TOOLS, enabled, _setDeps: (x) => { deps = x; list = null; board = undefined; boardLast = 0; }, _list: () => list, _boardText: () => boardText(), logFailure, browseStatus, codeStatus, FAIL_KEY, _tgBoardDeps: tgBoardDeps, parsePlan, percentOf, progressLabel, readPlanComment, PLAN_FILE };
