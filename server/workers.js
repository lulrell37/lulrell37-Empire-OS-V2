// J.A.R.V.I.S.'s workers (owner's idea, 2026-11-22): he stays at the front desk
// and hands each task to a worker of its own, watches them all, and when one
// finishes the result comes back to him to check before Mr. Burrus hears it.
//
//   code    — a headless Claude Code run in its own git worktree on branch
//             worker/<id>, cut from main: it may commit and push that branch,
//             never main (his push rule stands).
//   browse  — a browser task on its own browser profile (worker-<id>), so it
//             never collides with his or A.R.A.'s browser; its result can be
//             saved straight to a Drive note.
//
// MAX_WORKERS (3, WORKERS_MAX) at once — they share the Claude subscription and
// the server's memory; the rest wait in line. Every step shows on his
// notification strip in the app (GET /workers → NudgeBar). A finished, failed
// or stuck worker wakes J.A.R.V.I.S. (jarvisOutOfBand) with what it found. State
// is app_settings.workers, so a restart re-runs what it cut off, once, and says
// so; nothing ends quietly. WORKERS=off stops it. Tags: [WORKER_START: code|browse
// | title | task | note title], [WORKER_STATUS], [WORKER_STOP: id].
// The same progress goes to Telegram as one live board message on J.A.R.V.I.S.'s
// bot (see "Telegram board" below; WORKER_TG_BOARD=off stops it).
// node server/scripts/test-workers.js.
const fs = require('fs');
const path = require('path');
const { getSetting, setSetting } = require('./syncStore');

const KEY = 'workers';
const MAX = () => Math.max(1, Number(process.env.WORKERS_MAX) || 3);
const CODE_TIMEOUT_MS = () => (Number(process.env.WORKER_CODE_MIN) || 90) * 60e3;
const KEEP_MS = 24 * 3600e3; // finished ones stay listed a day
const SHOW_DONE_MS = 15 * 60e3; // and on his strip for 15 minutes
const enabled = () => String(process.env.WORKERS || '').toLowerCase() !== 'off';

let list = null; // id -> worker
const ctrls = new Map(); // id -> AbortController
let deps = null; // swapped in by the test

function d() {
  return deps || {
    engine: require('./jarvisEngine'),
    browse: (persona, name, task, opts) => require('./browserAgent').browseRun(persona, name, task, opts),
    wake: (text) => require('./routes/telegram').jarvisOutOfBand(text, { quiet: /^\s*NOTHING\s*\.?\s*$/i }),
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

const nextId = () => String(1 + Math.max(0, ...Object.keys(list).map(Number).filter(Number.isFinite)));
const running = () => Object.values(list).filter((w) => w.status === 'running');
const queued = () => Object.values(list).filter((w) => w.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);

async function start({ kind = 'code', title, task, note = '' }) {
  if (!enabled()) throw new Error('workers are switched off (WORKERS=off)');
  kind = /^b/i.test(kind) ? 'browse' : 'code';
  if (!String(task || '').trim()) throw new Error('a worker needs its task');
  await load();
  const id = nextId();
  list[id] = { id, kind, title: String(title || task).slice(0, 80), task: String(task), note: String(note || ''), status: 'queued', createdAt: Date.now(), step: 0, progress: 'Waiting for a free slot', attempts: 0 };
  await save();
  boardKick();
  pump();
  return list[id];
}

function pump() {
  if (!list) return;
  while (running().length < MAX() && queued().length) launch(queued()[0]);
}

function update(w, patch) { Object.assign(w, patch, { updatedAt: Date.now() }); save(); boardKick(); }

// ── Progress ─────────────────────────────────────────────────────────────────
// Owner's ask, 2026-11-22: a real percentage, not a timer. A worker writes its own
// plan (code: PLAN_FILE in its worktree, steps ticked as it finishes them; browse:
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

function readPlanFile(w, dir) {
  let text;
  try { text = fs.readFileSync(path.join(dir, PLAN_FILE), 'utf8'); } catch { return; }
  const plan = parsePlan(text);
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
  update(w, { status: 'running', startedAt: Date.now(), attempts: (w.attempts || 0) + 1, progress: 'Starting' });
  let out;
  let release = () => {};
  try {
    // A worker is a whole Claude Code run or a Chrome (~400 MB each): it waits
    // for a heavy slot and free memory (claudeSub.cliSlot) so workers can't
    // freeze the 2 GB server the way 2026-11-22's did.
    update(w, { progress: 'Waiting for room on the server' });
    release = await require('./claudeSub').cliSlot({ pool: 'heavy', signal: ctrl.signal });
    update(w, { progress: 'Starting' });
    out = w.kind === 'browse' ? await runBrowse(w) : await runCode(w, ctrl.signal);
  } catch (e) {
    out = { status: ctrl.signal.aborted ? 'stopped' : 'failed', result: e.message };
    if (!ctrl.signal.aborted) console.error(`worker failed: #${w.id} ${w.title}: ${e.message}`);
  }
  release();
  ctrls.delete(w.id);
  update(w, { status: out.status, result: String(out.result || '').slice(0, 20000), branch: out.branch || w.branch, endedAt: Date.now(), progress: out.status === 'done' ? 'Finished' : out.status === 'needs_you' ? 'Needs Mr. Burrus' : out.status === 'stopped' ? 'Stopped' : 'Failed', ...(out.status === 'done' ? { percent: 100, current: '' } : {}) });
  if (w.status !== 'stopped') report(w);
  pump();
}

async function runBrowse(w) {
  const r = await d().browse(`worker-${w.id}`, `J.A.R.V.I.S.'s worker #${w.id}`, w.task, {
    ownerText: '',
    onStep: (n, line) => update(w, { step: n, progress: line.slice(0, 140) }),
    // The brain's plan and the plan step it's on: the ones before it are done.
    onPlan: (names, at) => update(w, planPatch(w, names.map((name, i) => ({ name, done: i < at - 1 })))),
  });
  const status = r.status === 'done' ? 'done' : r.status === 'ask' ? 'needs_you' : 'failed';
  let saved = '';
  if (w.note && r.result && status === 'done') {
    saved = await d().saveNote(w.note, `# ${w.note}\n_Collected by J.A.R.V.I.S.'s worker #${w.id}, ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET._\n\n${r.result}`)
      .then(() => `\n(Saved to his Drive as "${w.note}".)`).catch((e) => `\n(Couldn't save the Drive note "${w.note}": ${e.message})`);
  }
  return { status, result: `${r.text}${saved}` };
}

const WORKER_BRIEF = (w, branch) => `[YOU ARE ONE OF J.A.R.V.I.S.'S WORKERS — #${w.id}: "${w.title}"]
J.A.R.V.I.S. (the Empire OS engineer, running on Claude Code like you) handed you this one task so he can keep talking with Mr. Burrus. Do it fully and properly. If it is code: read the real code, change what's needed, run the tests that cover it, check your work. If it is research, a check or any other job: do it the same way, thoroughly, and report what you found with sources; you don't need to commit anything if nothing in the repo changes.
You are in your own git worktree of the Empire OS repo on branch ${branch}, cut from main. The repo's AGENTS.md / CLAUDE.md rules apply. Commit your work on this branch and push THIS branch to origin. Never merge into main and never push main: Mr. Burrus says "push" and J.A.R.V.I.S. ships it. Don't redeploy. Other workers may be editing other branches at the same time; stay on yours.
PROGRESS (Mr. Burrus watches it live as a percentage): before anything else, write your plan of 3 to 10 numbered steps to the file ${PLAN_FILE} at the root of your worktree, one per line, exactly like "1. [ ] Read the worker code" — short step names (under 60 characters) he can read on a phone. The moment you finish a step, change its [ ] to [x] in that file (one at a time as you go, never all at the end). If the plan changes, rewrite the file and keep the finished steps ticked. Don't commit it (it's gitignored).
Your final message is a report for J.A.R.V.I.S., not for Mr. Burrus: what you did, the branch and commits, test results, anything unfinished or that needs a decision. Plain and short.`;

async function runCode(w, signal) {
  const E = d().engine;
  const ws = await E.workspace();
  if (ws.readOnly) throw new Error('no GITHUB_TOKEN on the server, so a code worker has no repo to work in');
  const branch = w.branch || `worker/${w.id}-${String(w.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'task'}`;
  const dir = path.join(E.ROOT(), 'workers', w.id);
  update(w, { branch, progress: 'Setting up its own copy of the repo' });
  await E.run('git', ['fetch', '--quiet', 'origin'], { cwd: ws.dir }).catch(() => {});
  if (!fs.existsSync(path.join(dir, '.git'))) {
    await E.run('git', ['worktree', 'prune'], { cwd: ws.dir }).catch(() => {});
    const exists = await E.run('git', ['rev-parse', '--verify', '--quiet', branch], { cwd: ws.dir }).then(() => true, () => false);
    await E.run('git', ['worktree', 'add', ...(exists ? [dir, branch] : ['-b', branch, dir, 'origin/main'])], { cwd: ws.dir, timeout: 300000 });
  }
  // Its plan file is read on every step it reports and every 5 s between them.
  const poll = setInterval(() => readPlanFile(w, dir), (deps && deps.planPollMs) || 5000);
  if (poll.unref) poll.unref();
  try {
    const r = await E.spawnTurn({
      prompt: w.task, persona: '', dir, brief: WORKER_BRIEF(w, branch), ownSession: false, signal, timeoutMs: CODE_TIMEOUT_MS(),
      onProgress: (line) => { readPlanFile(w, dir); update(w, { step: (w.step || 0) + 1, progress: String(line).slice(0, 140) }); },
    });
    return { status: 'done', result: r.text, branch };
  } finally {
    clearInterval(poll);
    readPlanFile(w, dir); // its last ticks, before the folder goes
    // The branch (and anything pushed) stays; the folder goes, to keep the disk clear.
    await E.run('git', ['worktree', 'remove', '--force', dir], { cwd: ws.dir }).catch(() => {});
  }
}

// The result goes to J.A.R.V.I.S. first; he checks it, then tells Mr. Burrus.
function report(w) {
  const mins = Math.max(1, Math.round(((w.endedAt || Date.now()) - (w.startedAt || w.createdAt)) / 60000));
  const head = { done: 'finished', needs_you: 'stopped and needs Mr. Burrus', failed: 'FAILED' }[w.status] || w.status;
  const text = `[SENT ON YOUR OWN — your worker #${w.id} ("${w.title}", ${w.kind}${w.branch ? `, branch ${w.branch}` : ''}) ${head} after ${mins} min. Mr. Burrus did not send this. Check its work (for code: look at the branch, run its tests) before you tell him anything, then report to him in a few sentences. If it failed or stopped, say exactly why and what you're doing about it, or start a fresh worker if it's worth another try. If there is more of the same job queued for other workers, mention where the whole job stands. Its report:]\n${w.plan && w.plan.length ? `Its plan (${w.percent ?? 0}%): ${w.plan.map((p, i) => `${p.done ? '✓' : '○'} ${i + 1}. ${p.name}`).join(' · ')}\n` : ''}${String(w.result || '(empty)').slice(0, 12000)}`;
  Promise.resolve(d().wake(text)).catch((e) => console.error(`worker failed: couldn't hand #${w.id}'s result to J.A.R.V.I.S.: ${e.message}`));
}

async function stop(id) {
  await load();
  const w = list[String(id).replace(/^#/, '')];
  if (!w) return `no worker #${id}`;
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
    if ((w.attempts || 0) >= 2) {
      update(w, { status: 'failed', endedAt: Date.now(), progress: 'Failed', result: 'the server restarted in the middle of it twice, so it was not started a third time' });
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
    log: async (text) => { const { tg, persona } = pick(); await tg.logOwn(persona, tg.OWNER_ID, text); },
  };
}

const BOARD_MARK = { done: '✅', failed: '❌', needs_you: '✋', stopped: '⏹' };
const BOARD_STATE = { done: 'done', failed: 'failed', needs_you: 'needs you', stopped: 'stopped' };
function boardLine(w, now = Date.now()) {
  const mins = Math.max(0, Math.round(((w.endedAt || now) - (w.startedAt || w.createdAt)) / 60000));
  const title = String(w.title || '').slice(0, 60);
  if (w.status === 'running') return `🔧 #${w.id} ${title} · ${mins} min\n    ${progressLabel(w).slice(0, 90)}\n    ${String(w.progress || '').slice(0, 120)}`;
  if (w.status === 'queued') return `⏳ #${w.id} ${title} · waiting`;
  // An ended one keeps its last number: "failed at 40%", "stopped at 60%".
  const at = w.percent != null ? (w.status === 'done' ? ` · ${BAR(100)} 100%` : ` at ${w.percent}%`) : '';
  return `${BOARD_MARK[w.status] || '•'} #${w.id} ${title} · ${BOARD_STATE[w.status] || w.status}${at} · ${mins} min`;
}
function boardText(now = Date.now()) {
  const shown = Object.values(list)
    .filter((w) => ['running', 'queued'].includes(w.status) || (w.endedAt && now - w.endedAt < SHOW_DONE_MS))
    .sort((a, b) => a.createdAt - b.createdAt);
  const r = running().length, q = queued().length;
  const head = r || q ? `J.A.R.V.I.S.'s workers: ${r} running${q ? `, ${q} waiting` : ''}` : 'J.A.R.V.I.S.\'s workers: all done ✓';
  const time = new Date(now).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  return `${head}\n\n${shown.map((w) => boardLine(w, now)).join('\n')}\n\n${r || q ? 'Updated' : 'Finished'} ${time} ET`.slice(0, 4000);
}

let board; // undefined = not read yet; null = no live board
let boardLast = 0, boardTimer = null, boardBusy = false, boardAgain = false, boardRefresh = null;
async function loadBoard() {
  if (board !== undefined) return board;
  try { board = JSON.parse(await getSetting(BOARD_KEY, 'null')) || null; } catch { board = null; }
  if (board && !board.messageId) board = null;
  return board;
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
    const active = running().length + queued().length;
    if (!board && !active) return;
    const text = boardText();
    if (board && text === board.text) return;
    const B = d().board;
    if (!B || (B.ready && !B.ready())) return;
    boardLast = Date.now();
    if (!board) {
      const messageId = await B.send(text);
      board = { messageId, text, openedAt: Date.now() };
      await saveBoard();
      const first = [...running(), ...queued()].map((w) => `#${w.id} "${w.title}"`).join(', ');
      Promise.resolve(B.log(`[J.A.R.V.I.S.'s live worker board posted (${first}); it updates in place as they work]`)).catch(() => {});
    } else {
      try { await B.edit(board.messageId, text); } catch (e) {
        // Deleted by him, or too old to edit: start a fresh board next time.
        if (/not found|can't be edited|cannot be edited/i.test(e.message)) { board = null; await saveBoard(); boardAgain = true; return; }
        throw e;
      }
      board.text = text;
      if (!active) board = null; // the all-done edit: this board is finished
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
  return `#${w.id} ${w.kind} "${w.title}" — ${w.status}${w.status === 'running' ? `, ${mins} min, ${now}, step ${w.step || 0}: ${w.progress}` : w.percent != null ? `, ${w.percent}%` : ''}${w.branch ? ` (branch ${w.branch})` : ''}`;
}

async function statusText() {
  await load();
  const all = Object.values(list).sort((a, b) => a.createdAt - b.createdAt);
  if (!all.length) return 'No workers in the last day.';
  return `${running().length} running, ${queued().length} waiting (${MAX()} at once):\n${all.map(line).join('\n')}`;
}

// For the app's strip: what's working and what just finished.
async function forApp() {
  await load();
  const now = Date.now();
  return Object.values(list)
    .filter((w) => ['running', 'queued'].includes(w.status) || (w.endedAt && now - w.endedAt < SHOW_DONE_MS))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((w) => ({ id: w.id, kind: w.kind, title: w.title, status: w.status, step: w.step || 0, progress: w.progress || '', percent: w.percent ?? null, current: w.current || '', plan: w.plan || [], branch: w.branch || null, startedAt: w.startedAt || null, endedAt: w.endedAt || null }));
}

async function tag(name, arg) {
  if (name === 'WORKER_STATUS') return `WORKERS:\n${await statusText()}`;
  if (name === 'WORKER_STOP') return `WORKER_STOP: ${await stop(String(arg || '').trim())}`;
  const p = String(arg || '').split('|').map((x) => x.trim());
  let [kind, title, task, note] = p;
  if (!/^(code|browse)$/i.test(kind || '')) { note = task; task = title; title = kind; kind = 'code'; }
  if (!task) { task = title; title = String(title || '').slice(0, 60); }
  const w = await start({ kind, title, task, note });
  return `WORKER_START: ✓ worker #${w.id} (${w.kind}) "${w.title}" ${running().some((x) => x.id === w.id) ? 'is working on it now' : `is in line (${running().length} already running)`}. Its progress shows on his notification strip; the result comes back to you when it's done.`;
}

const WORKER_TOOLS = ` - [WORKER_START: code|browse | short title | the full task, self-contained | Drive note title (browse only, optional)] — hand a task to a worker of your own so you stay free to talk to him. code = its own Claude Code run in its own worktree on a worker/ branch (commits and pushes that branch only, never main); browse = a browser task on its own browser, its result saved to that Drive note. 3 run at once, the rest wait in line; several workers can split one big job (e.g. Canva pages 1-8, 9-16…). Each one's progress shows live on his notification strip. When one finishes, fails or gets stuck you're woken with its report: check it, then tell him. Use them for EVERY task, whatever its length (his standing order, 2026-11-22), so you are always free to talk to him: code is for any general job (code, research, checks, writing); browse is for anything on a website. Only straight answers and seconds-long lookups stay with you.
 - [WORKER_STATUS] — every worker: running, waiting, done, with its current step. [WORKER_STOP: id] — stop one.`;

module.exports = { start, stop, recover, statusText, forApp, tag, WORKER_TOOLS, enabled, _setDeps: (x) => { deps = x; list = null; board = undefined; boardLast = 0; }, _list: () => list, _boardText: () => boardText(), _tgBoardDeps: tgBoardDeps, parsePlan, percentOf, progressLabel, PLAN_FILE };
