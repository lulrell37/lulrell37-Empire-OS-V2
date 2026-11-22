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
// "3 and 3 only"); the rest wait in line. Ids only ever count up (the 11th worker
// of the day is #11; that's not 11 running). Every result goes straight to Mr.
// Burrus on J.A.R.V.I.S.'s bot (logged in his chat history, so J.A.R.V.I.S. knows
// it) — no engine turn, so J.A.R.V.I.S. is never busy checking a worker when he
// wants to talk. The issue holds the task and the full report: the proof it ran.
// State: app_settings.workers (+ workers_seq); a restart picks code workers back
// up where they are (the runner keeps going) and re-runs a cut-off browse once.
// WORKERS=off stops it. Tags: [WORKER_START: code|browse | title | task | note
// title], [WORKER_STATUS], [WORKER_STOP: id]. node server/scripts/test-workers.js.
const fs = require('fs');
const path = require('path');
const { getSetting, setSetting } = require('./syncStore');

const KEY = 'workers';
const HARD_CAP = 3;
const MAX = () => Math.min(HARD_CAP, Math.max(1, Number(process.env.WORKERS_MAX) || HARD_CAP));
const BROWSE_MAX = 1; // Chrome on the 2 GB server: one at a time
const POLL_MS = () => Number(process.env.WORKER_POLL_MS) || 60e3;
const NO_RUN_MS = 6 * 60e3; // dispatched but GitHub never started it
const CODE_TIMEOUT_MS = () => (Number(process.env.WORKER_CODE_MIN) || 130) * 60e3; // the job's own limit is 120
const KEEP_MS = 24 * 3600e3; // finished ones stay listed a day
const SHOW_DONE_MS = 15 * 60e3; // and on his strip for 15 minutes
const enabled = () => String(process.env.WORKERS || '').toLowerCase() !== 'off';

let list = null; // id -> worker
const ctrls = new Map(); // id -> AbortController
let deps = null; // swapped in by the test

function d() {
  return deps || {
    gh: (p, o) => require('./buildAgent').gh(p, o),
    repo: () => require('./buildAgent').REPO,
    slot: (o) => require('./claudeSub').cliSlot({ pool: 'heavy', ...o }),
    browse: (persona, name, task, opts) => require('./browserAgent').browseRun(persona, name, task, opts),
    tell: async (text) => {
      const tg = require('./telegram');
      const id = tg.botFor('jarvis') && tg.botFor('jarvis').isConfigured() ? 'jarvis' : 'ara';
      const bot = tg.botFor(id);
      if (!bot || !bot.isConfigured() || !tg.OWNER_ID) throw new Error('no Telegram bot to send it on');
      await bot.sendMessage(tg.OWNER_ID, id === 'jarvis' ? text : `J.A.R.V.I.S.:\n${text}`);
    },
    onDone: (w) => (w.purpose === 'autofix' ? require('./autoFix').finish(w) : w.purpose === 'feature' ? require('./featureRequests').finish(w) : null),
    saveNote: (title, body) => require('./google').saveDriveNote(title, body),
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
async function nextId() {
  if (!seq) seq = Number(await getSetting('workers_seq', 0)) || 0;
  seq = Math.max(seq, ...Object.keys(list).map(Number).filter(Number.isFinite)) + 1;
  await setSetting('workers_seq', String(seq));
  return String(seq);
}
const running = () => Object.values(list).filter((w) => w.status === 'running');
const queued = () => Object.values(list).filter((w) => w.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);

async function start({ kind = 'code', title, task, note = '', purpose = '' }) {
  if (!enabled()) throw new Error('workers are switched off (WORKERS=off)');
  kind = /^b/i.test(kind) ? 'browse' : 'code';
  if (!String(task || '').trim()) throw new Error('a worker needs its task');
  await load();
  const id = await nextId();
  list[id] = { id, kind, purpose, title: String(title || task).slice(0, 80), task: String(task), note: String(note || ''), status: 'queued', createdAt: Date.now(), step: 0, progress: 'Waiting for a free slot', attempts: 0 };
  await save();
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

function update(w, patch) { Object.assign(w, patch, { updatedAt: Date.now() }); save(); }

async function launch(w) {
  const ctrl = new AbortController();
  ctrls.set(w.id, ctrl);
  const resuming = w.kind === 'code' && w.issue; // a restart: the runner kept going, just watch it again
  update(w, { status: 'running', startedAt: w.startedAt && resuming ? w.startedAt : Date.now(), attempts: (w.attempts || 0) + (resuming ? 0 : 1), progress: resuming ? 'Watching it again after a server restart' : 'Starting' });
  let out;
  let release = () => {};
  try {
    if (w.kind === 'browse') {
      update(w, { progress: 'Waiting for room on the server' });
      release = await d().slot({ signal: ctrl.signal });
      update(w, { progress: 'Starting' });
      out = await runBrowse(w);
    } else out = await runCode(w, ctrl.signal);
  } catch (e) {
    out = { status: ctrl.signal.aborted ? 'stopped' : 'failed', result: e.message };
    if (!ctrl.signal.aborted) console.error(`worker failed: #${w.id} ${w.title}: ${e.message}`);
  }
  release();
  ctrls.delete(w.id);
  update(w, { status: out.status, result: String(out.result || '').slice(0, 20000), branch: out.branch || w.branch, pushed: out.pushed || '', endedAt: Date.now(), progress: out.status === 'done' ? 'Finished' : out.status === 'needs_you' ? 'Needs Mr. Burrus' : out.status === 'stopped' ? 'Stopped' : 'Failed' });
  report(w);
  pump();
}

async function runBrowse(w) {
  const r = await d().browse(`worker-${w.id}`, `J.A.R.V.I.S.'s worker #${w.id}`, w.task, {
    ownerText: '',
    onStep: (n, line) => update(w, { step: n, progress: line.slice(0, 140) }),
  });
  const status = r.status === 'done' ? 'done' : r.status === 'ask' ? 'needs_you' : 'failed';
  let saved = '';
  if (w.note && r.result && status === 'done') {
    saved = await d().saveNote(w.note, `# ${w.note}\n_Collected by J.A.R.V.I.S.'s worker #${w.id}, ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET._\n\n${r.result}`)
      .then(() => `\n(Saved to his Drive as "${w.note}".)`).catch((e) => `\n(Couldn't save the Drive note "${w.note}": ${e.message})`);
  }
  return { status, result: `${r.text}${saved}` };
}

const sleepFor = (ms, signal) => new Promise((r) => {
  const wake = () => { clearTimeout(t); if (signal) signal.removeEventListener('abort', wake); r(); };
  const t = setTimeout(wake, ms);
  if (signal) signal.addEventListener('abort', wake, { once: true });
});
const noMention = (t) => String(t).replace(/@claude/gi, '@ claude'); // claude.yml answers "@claude"

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
    await d().gh(`${base}/dispatches`, { method: 'POST', body: { event_type: 'worker-run', client_payload: { worker: w.id, issue: issue.number, branch, title: w.title.slice(0, 60) } } });
    update(w, { dispatchedAt: Date.now() });
  }
  const deadline = (w.dispatchedAt || Date.now()) + CODE_TIMEOUT_MS();
  for (;;) {
    if (signal.aborted) {
      if (w.runId) await d().gh(`${base}/actions/runs/${w.runId}/cancel`, { method: 'POST' }).catch(() => {});
      return { status: 'stopped', result: 'stopped on request', branch };
    }
    const comments = await d().gh(`${base}/issues/${w.issue}/comments?per_page=100`).catch(() => null);
    const done = (comments || []).find((c) => /<!-- worker-result/.test(c.body || ''));
    if (done) {
      const body = String(done.body);
      const ok = /status=done/.test(body);
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
    console.error(`worker failed: couldn't report #${w.id}: ${e.message}`);
    require('./loud').tellAra(`worker:${w.id}`, `J.A.R.V.I.S.'s worker #${w.id} ("${w.title}") ${w.status === 'done' ? 'finished' : w.status}, but its report couldn't be sent (${e.message.slice(0, 120)}).${w.issueUrl ? ` Full report: ${w.issueUrl}` : ''}`);
  });
}
function defaultReport(w) {
  {
    const mins = Math.max(1, Math.round(((w.endedAt || Date.now()) - (w.startedAt || w.createdAt)) / 60000));
    const icon = { done: '✅', needs_you: '✋', failed: '❌' }[w.status] || '•';
    const head = { done: 'finished', needs_you: 'stopped — it needs you', failed: 'FAILED' }[w.status] || w.status;
    const links = [w.pushed ? `Branch: ${w.pushed}` : (w.branch && w.kind === 'code' ? `Branch: ${w.branch} (nothing pushed)` : ''), w.issueUrl ? `Full report: ${w.issueUrl}` : ''].filter(Boolean).join('\n');
    const text = `${icon} Worker #${w.id} ${head} — "${w.title}" (${w.kind}, ${mins} min)\n\n${String(w.result || '(no report)').slice(0, 3000)}${links ? `\n\n${links}` : ''}${w.kind === 'code' && w.status === 'done' && w.pushed && /pushed/.test(w.pushed) ? '\n\nSay "push" to J.A.R.V.I.S. to ship it.' : ''}`;
    return d().tell(text);
  }
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
    if (w.kind === 'code' && w.issue) { update(w, { status: 'queued', progress: 'Watching it again after a server restart' }); continue; }
    if ((w.attempts || 0) >= 2) {
      update(w, { status: 'failed', endedAt: Date.now(), progress: 'Failed', result: 'the server restarted in the middle of it twice, so it was not started a third time' });
      report(w);
    } else update(w, { status: 'queued', progress: 'Restarting after a server restart' });
  }
  pump();
}

function line(w) {
  const mins = Math.max(0, Math.round((Date.now() - (w.startedAt || w.createdAt)) / 60000));
  return `#${w.id} ${w.kind} "${w.title}" — ${w.status}${w.status === 'running' ? `, ${mins} min: ${w.progress}` : ''}${w.branch ? ` (branch ${w.branch})` : ''}${w.issueUrl ? ` ${w.issueUrl}` : ''}`;
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
    .map((w) => ({ id: w.id, kind: w.kind, title: w.title, status: w.status, step: w.step || 0, progress: w.progress || '', branch: w.branch || null, startedAt: w.startedAt || null, endedAt: w.endedAt || null, url: w.runUrl || w.issueUrl || null }));
}

async function tag(name, arg) {
  if (name === 'WORKER_STATUS') return `WORKERS:\n${await statusText()}`;
  if (name === 'WORKER_STOP') return `WORKER_STOP: ${await stop(String(arg || '').trim())}`;
  const p = String(arg || '').split('|').map((x) => x.trim());
  let [kind, title, task, note] = p;
  if (!/^(code|browse)$/i.test(kind || '')) { note = task; task = title; title = kind; kind = 'code'; }
  if (!task) { task = title; title = String(title || '').slice(0, 60); }
  const w = await start({ kind, title, task, note });
  return `WORKER_START: ✓ worker #${w.id} (${w.kind}) "${w.title}" ${running().some((x) => x.id === w.id) ? 'is working on it now' : `is in line (${running().length} of 3 already running)`}${w.kind === 'code' ? ', on its own GitHub runner' : ''}. Its progress shows on his notification strip; its report goes straight to him on your bot when it's done (you'll see it in this chat).`;
}

const WORKER_TOOLS = ` - [WORKER_START: code|browse | short title | the full task, self-contained | Drive note title (browse only, optional)] — hand a task to a worker of your own so you stay free to talk to him. code = its own Claude Code on its own GitHub runner (not the server), on a worker/ branch cut from main: it commits, the job pushes that branch only, never main; good for any general job (code, research, checks, writing). browse = a browser task on the server on its own browser, its result saved to that Drive note; one browse at a time. HARD CAP: 3 workers running at once, total; the rest wait in line. Ids count up all day (#11 is the eleventh, not eleven running). Each one's progress shows live on his notification strip, and its report goes straight to him on your bot when it ends (you'll see it in this chat), so you don't need to relay it; if he asks, read [WORKER_STATUS]. A code worker's work ships when he says push: merge its branch into main then. Use them for EVERY task, whatever its length (his standing order, 2026-11-22), so you are always free to talk to him. Only straight answers and seconds-long lookups stay with you.
 - [WORKER_STATUS] — every worker: running, waiting, done, with its current step and GitHub link. [WORKER_STOP: id] — stop one (a GitHub run is cancelled).`;

module.exports = { start, stop, recover, statusText, forApp, tag, WORKER_TOOLS, enabled, _setDeps: (x) => { deps = x; list = null; }, _list: () => list };
