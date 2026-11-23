// J.A.R.V.I.S.'s engine: a real Claude Code session.
//
// When Mr. Burrus talks to J.A.R.V.I.S. (app or Telegram), the message goes to
// Claude Code running headless in its own clone of the Empire OS repo, with its
// full toolset: read and edit code, run commands and tests, git, web. It keeps
// one ongoing session (resumed every turn), so it remembers the conversation
// and what it was working on. Its final message is what J.A.R.V.I.S. says: he
// stays himself (his persona is appended to Claude Code's own system prompt),
// Claude Code is the brain behind him.
//
//   JARVIS_ENGINE=off               back to the plain chat model
//   JARVIS_ENGINE_MODEL             default claude-opus-5-5
//   JARVIS_PERMISSION_MODE          default auto (Claude Code's auto mode: risky
//                                   actions are refused, not asked about)
//   JARVIS_WORKDIR                  default ~/jarvis-workspace
//   JARVIS_ENGINE_TIMEOUT_MIN       default 30
//
// A turn is never dropped without a word: every running turn is logged to
// <workdir>/turns.json, and the session id is saved the moment Claude Code
// reports it. If the server restarts mid-turn, recover() (run at boot) tells him
// on J.A.R.V.I.S.'s Telegram bot and resumes the work once in the same session.
// An app job keeps running when the app stops listening (he left the chat, sent
// something else, the phone slept): only the app's stop button cancels it, and
// a result nobody collected goes out on Telegram (routes/telegram.js
// jarvisOutOfBand), command tags and all.
//
// Auth is the Claude subscription (CLAUDE_CODE_OAUTH_TOKEN), else ANTHROPIC_API_KEY.
// Without GITHUB_TOKEN there is no clone to work in, so it runs read-only in the
// deployed checkout.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const MODEL = () => process.env.JARVIS_ENGINE_MODEL || 'claude-opus-5-5';
const PERMISSION = () => process.env.JARVIS_PERMISSION_MODE || 'auto';
const ROOT = () => process.env.JARVIS_WORKDIR || path.join(os.homedir(), 'jarvis-workspace');
const TIMEOUT_MS = () => (Number(process.env.JARVIS_ENGINE_TIMEOUT_MIN) || 30) * 60000;
// A fresh session after an hour with no turns (JARVIS_SESSION_GAP_MIN; owner's
// call, 2026-11-21): the prompt cache is cold by then anyway, so resuming would
// re-read the whole day's transcript at full price. The new session starts with
// the last few messages of the chat (`recent`), so a follow-up still lands.
const SESSION_IDLE_MS = () => (Number(process.env.JARVIS_SESSION_GAP_MIN) || 60) * 60000;
// …and a fresh session every night (owner's call, 2026-11-20): every turn resends
// the whole conversation, so a day-long session got heavy on his Max limit. What
// matters carries over anyway (Mem0, the owner profile, open threads, notes).
const dayET = (ms = Date.now()) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const READ_ONLY_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch';

function enabled() {
  if (process.env.JARVIS_ENGINE === 'off') return false;
  return !!(process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_SUBSCRIPTION === 'on');
}

function resolveCli() {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  try {
    const pkg = require.resolve('@anthropic-ai/claude-code/package.json');
    const { bin } = require(pkg);
    const rel = typeof bin === 'string' ? bin : bin && bin.claude;
    if (rel) return path.join(path.dirname(pkg), rel);
  } catch { /* not a dependency here */ }
  return 'claude';
}

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 180000, maxBuffer: 8 << 20, ...opts }, (e, stdout, stderr) => {
    if (e) return reject(new Error(`${cmd} ${args[0]}: ${String(stderr || e.message).replace(/x-access-token:[^@]+@/g, '***@').slice(0, 300)}`));
    resolve(String(stdout));
  });
});

// The repo clone Claude Code works in. Never reset: work in progress (a branch,
// uncommitted edits) carries over between turns, the way it would in a real
// checkout. Claude Code pulls/branches itself.
let workspaceReady = null;
async function workspace() {
  if (!process.env.GITHUB_TOKEN) return { dir: path.resolve(__dirname, '..'), readOnly: true };
  if (!workspaceReady) {
    workspaceReady = (async () => {
      const { REPO } = require('./buildAgent');
      const dir = path.join(ROOT(), 'repo');
      const remote = `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${REPO.owner}/${REPO.repo}.git`;
      fs.mkdirSync(ROOT(), { recursive: true });
      if (!fs.existsSync(path.join(dir, '.git'))) {
        await run('git', ['clone', '--quiet', remote, dir], { timeout: 600000 });
      } else {
        await run('git', ['remote', 'set-url', 'origin', remote], { cwd: dir }); // the token may have rotated
        await run('git', ['fetch', '--quiet', 'origin'], { cwd: dir }).catch((e) => console.warn('jarvis engine:', e.message));
      }
      await run('git', ['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'J.A.R.V.I.S. (Claude Code)'], { cwd: dir });
      await run('git', ['config', 'user.email', process.env.GIT_AUTHOR_EMAIL || 'noreply@anthropic.com'], { cwd: dir });
      return { dir, readOnly: false };
    })().catch((e) => { workspaceReady = null; throw e; });
  }
  return workspaceReady;
}

// One ongoing conversation, resumed every turn.
const sessionFile = () => path.join(ROOT(), 'session.json');
function loadSession(now = Date.now()) {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    if (s.id && now - (s.at || 0) < SESSION_IDLE_MS() && (s.day || dayET(s.at || 0)) === dayET(now)) return s.id;
  } catch { /* none yet */ }
  return null;
}
function saveSession(id) {
  try {
    let day = dayET();
    try { const old = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')); if (old.id === id && old.day) day = old.day; } catch {}
    fs.mkdirSync(ROOT(), { recursive: true });
    fs.writeFileSync(sessionFile(), JSON.stringify({ id, at: Date.now(), day }));
  } catch {}
}
function resetSession() { try { fs.unlinkSync(sessionFile()); } catch {} }

// Only what Claude Code needs: its login, git/GitHub, the basics. The server's
// other secrets (database, bot tokens, provider keys) stay out of its shell.
function childEnv() {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SHELL', 'TERM', 'NODE_OPTIONS'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.GITHUB_TOKEN) { env.GITHUB_TOKEN = process.env.GITHUB_TOKEN; env.GH_TOKEN = process.env.GITHUB_TOKEN; }
  return env;
}

// What sits on top of Claude Code's own system prompt: who is speaking for it,
// and the persona's prompt (with its live context and command tags).
function engineBrief(persona, { readOnly, dir }) {
  return `[J.A.R.V.I.S.'S ENGINE — read this first]
You are Claude Code, and you are the engine behind J.A.R.V.I.S. Mr. Burrus is talking to J.A.R.V.I.S. from his phone (the Empire OS app or J.A.R.V.I.S.'s Telegram bot); every message he sends him comes to you. Do the work exactly as you would in Claude Code: look at the real code and data, run what needs running, fix things properly, check your work. You are working in ${readOnly ? `the server's deployed checkout (${dir}), READ-ONLY: no GITHUB_TOKEN is set, so you can read and research but not edit, commit or push` : `your own clone of the Empire OS repo (${dir}). The repo's CLAUDE.md / AGENTS.md rules apply: "push it" means merge into main and push. Server changes go live with J.A.R.V.I.S.'s [REDEPLOY]; app changes ship in the APK main's push builds`}.

YOUR FINAL MESSAGE IS WHAT J.A.R.V.I.S. SAYS TO HIM. Write it as J.A.R.V.I.S., in his character below: it is shown in the chat and read aloud in his voice. Speakable text: no tables, no code blocks or long paths unless he asks for them; say what you did, what you found and what he needs to decide, as briefly as the answer allows. Never claim something is done that you didn't do and check.

FRONT DESK RULE (Mr. Burrus, 2026-11-22: "use them on any task, no matter the length; I want you always open to talk"): you are the front desk, not the workshop. When he gives you a task (anything that needs code changes, browsing, research, testing, more than a quick look), hand it to a worker with [WORKER_START] and reply at once: what you handed off, to which worker, and that its progress is on his notification strip. Split big jobs across several workers (3 run at once, hard cap; more wait in line). Code workers run on their own GitHub runners, not on the server. Do it yourself only when it is a straight answer, a quick read of one or two things, or a tag that runs in seconds. A browse worker never opens a drive.google.com or docs.google.com file link in the browser (it is refused): read Drive files yourself with the Drive tags ([READ_FILE_ID], [READ_NOTE], [SEARCH_DRIVE]) and hand the worker the contents. Workers' reports go straight to him on your bot and show up in your chat; you don't relay them. When he asks about one, read [WORKER_STATUS] or its issue link. Keep every one of your own turns short so he never waits on you.

His command tags below still work in your final message (the app or server runs them after you). Use them for app things (tasks, notes, HUD, calendar hand-offs to A.R.A.); do code work yourself rather than through [BUILD_REQUEST].

${persona}`;
}

// Tool calls, as one short line for the "working" status.
function describeTool(b) {
  const i = b.input || {};
  const f = (p) => String(p || '').replace(/^.*?\/repo\//, '');
  switch (b.name) {
    case 'Read': return `Reading ${f(i.file_path)}`;
    case 'Edit': case 'MultiEdit': return `Editing ${f(i.file_path)}`;
    case 'Write': return `Writing ${f(i.file_path)}`;
    case 'Grep': return `Searching for "${String(i.pattern || '').slice(0, 40)}"`;
    case 'Glob': return `Looking for ${i.pattern || 'files'}`;
    case 'Bash': return `Running: ${String(i.description || i.command || '').slice(0, 60)}`;
    case 'WebSearch': return `Searching the web: ${String(i.query || '').slice(0, 50)}`;
    case 'WebFetch': return `Reading ${String(i.url || '').slice(0, 60)}`;
    case 'Task': case 'Agent': return `Sending a helper: ${String(i.description || '').slice(0, 50)}`;
    default: return `Using ${b.name}`;
  }
}

// dir/brief/ownSession: a worker (server/workers.js) runs in its own worktree with
// its own brief and never touches his resumed session.
function spawnTurn({ prompt, persona, resume, onProgress, signal, dir = null, brief = null, ownSession = true, timeoutMs = null }) {
  return new Promise(async (resolve, reject) => {
    let ws;
    try { ws = dir ? { dir, readOnly: false } : await workspace(); } catch (e) { return reject(new Error(`couldn't set up the workspace: ${e.message}`)); }
    const briefFile = path.join(os.tmpdir(), `jarvis-brief-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(briefFile, brief || engineBrief(persona, ws), { mode: 0o600 });
    const args = [
      '-p',
      '--model', MODEL(),
      '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt-file', briefFile,
      '--system-prompt-snapshot', 'off', // his live context changes every turn
    ];
    if (ws.readOnly) args.push('--tools', READ_ONLY_TOOLS, '--permission-mode', 'dontAsk', '--allowedTools', READ_ONLY_TOOLS);
    else args.push('--permission-mode', PERMISSION());
    if (resume) args.push('--resume', resume);
    const child = spawn(resolveCli(), args, { cwd: ws.dir, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    let buf = '', stderr = '', result = null, sessionId = null, lastText = '', settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      try { fs.unlinkSync(briefFile); } catch {}
      fn();
    };
    const onAbort = () => { require('./claudeSub').killHard(child); done(() => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
    const limit = timeoutMs || TIMEOUT_MS();
    const timer = setTimeout(() => { require('./claudeSub').killHard(child); done(() => reject(Object.assign(new Error(`ran past ${Math.round(limit / 60000)} minutes`), { partial: lastText, sessionId }))); }, limit);
    const handle = (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id && ev.session_id !== sessionId) {
        sessionId = ev.session_id;
        if (ownSession) saveSession(sessionId); // now, not at the end: a restart mid-turn can then resume this session
      }
      if (ev.type === 'assistant' && !ev.parent_tool_use_id && ev.message && Array.isArray(ev.message.content)) {
        for (const b of ev.message.content) {
          if (b.type === 'tool_use' && onProgress) onProgress(describeTool(b));
          if (b.type === 'text' && b.text && b.text.trim()) lastText = b.text.trim();
        }
      } else if (ev.type === 'result') result = ev;
    };
    child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => done(() => reject(new Error(`claude code: ${e.message}`))));
    child.on('close', (code) => {
      if (buf.trim()) handle(buf);
      done(() => {
        if (result && !result.is_error && result.subtype === 'success') {
          return resolve({ text: String(result.result || lastText || '').trim(), sessionId: result.session_id || sessionId, costUsd: result.total_cost_usd, turns: result.num_turns });
        }
        const msg = (result && (result.result || (result.errors || []).join('; ') || result.subtype)) || stderr.slice(-300) || `exit ${code}`;
        reject(Object.assign(new Error(`claude code: ${String(msg).slice(0, 300)}`), { partial: lastText, sessionId, resumeFailed: !!resume && /no conversation found|session.*not found|could not resume/i.test(String(msg) + stderr) }));
      });
    });
  });
}

// Every turn still running, on disk, so a restart can say so and pick it up.
// { id: { id, text, source: 'app'|'telegram', startedAt, resumes } }
const turnsFile = () => path.join(ROOT(), 'turns.json');
function readTurns() { try { return JSON.parse(fs.readFileSync(turnsFile(), 'utf8')) || {}; } catch { return {}; } }
function writeTurns(t) { try { fs.mkdirSync(ROOT(), { recursive: true }); fs.writeFileSync(turnsFile(), JSON.stringify(t)); } catch (e) { console.warn('jarvis engine: turn log:', e.message); } }
function logTurn(entry) { const t = readTurns(); t[entry.id] = entry; writeTurns(t); }
function unlogTurn(id) { const t = readTurns(); if (t[id]) { delete t[id]; writeTurns(t); } }

// One turn at a time: they share a session and a working tree.
// `ownerText` is his own message (what a resume after a restart re-asks);
// `source` says where he asked; `resumes` counts restarts already survived.
let chain = Promise.resolve();
let busy = 0;
// The turn running right now (null when he's free): what he's on, since when, its
// latest step. The front desk (personaRuntime) answers new messages from it
// instead of queueing them.
let running = null;
const current = () => (running ? { ...running } : null);
async function turn(prompt, { persona = '', onProgress: progress, signal, source = 'telegram', ownerText, resumes = 0, recent = '' } = {}) {
  const id = crypto.randomUUID();
  const onProgress = (p) => { if (running && running.id === id) { running.step = p; } if (progress) progress(p); };
  const go = async () => {
    running = { id, what: String(ownerText || prompt).replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, 200), source, startedAt: Date.now(), step: 'Thinking' };
    logTurn({ id, text: String(ownerText || prompt).slice(0, 6000), source, startedAt: Date.now(), resumes });
    let release = () => {};
    try {
      // His own slot (claudeSub.cliSlot 'jarvis'): workers can't take it; it still
      // waits while the machine is low on memory rather than freezing it.
      release = await require('./claudeSub').cliSlot({ pool: 'jarvis', waitMs: 10 * 60000, signal });
      const resume = loadSession();
      // A new session hasn't seen the chat: give it the last few messages first.
      const fresh = recent ? `[NEW SESSION — your last messages with him, oldest first, so a follow-up like "push" or "do it" still lands. Check the repo (branches, git log) for what they refer to:\n${recent}\n]\n\n${prompt}` : prompt;
      let out;
      try {
        out = await spawnTurn({ prompt: resume ? prompt : fresh, persona, resume, onProgress, signal });
      } catch (e) {
        if (!e.resumeFailed) throw e;
        resetSession(); // the saved session is gone (new machine, cleared home) — start a new one
        out = await spawnTurn({ prompt: fresh, persona, resume: null, onProgress, signal });
      }
      if (out.sessionId) saveSession(out.sessionId);
      console.log(`jarvis engine: done in ${out.turns || '?'} turns${out.costUsd != null ? `, $${Number(out.costUsd).toFixed(3)}` : ''}`);
      return out.text;
    } finally {
      release();
      unlogTurn(id); // finished, failed or cancelled: it has been answered either way
      if (running && running.id === id) running = null;
      busy--;
    }
  };
  if (busy++ > 0 && progress) progress('Finishing the job before this one first');
  const p = chain.then(go, go);
  chain = p.catch(() => {});
  return p;
}

// Any turn running or queued (the redeploy wake-up skips itself then).
const isBusy = () => busy > 0;

// At boot: any turn still logged was cut off by the restart. Tell him, and pick
// it up once more in the same session (Claude Code checks where it got to). A
// turn already resumed once is only reported: two restarts in a row is
// something he should look at, not a loop.
async function recover() {
  const left = Object.values(readTurns());
  if (!left.length) return [];
  writeTurns({});
  if (!enabled()) return [];
  const { jarvisOutOfBand } = require('./routes/telegram');
  const out = [];
  for (const t of left) {
    const what = String(t.text || '').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, 220);
    const mins = Math.max(1, Math.round((Date.now() - (t.startedAt || Date.now())) / 60000));
    if ((t.resumes || 0) >= 1) {
      await jarvisOutOfBand('', { notice: `⚠️ Sir, a server restart cut me off again on "${what}". That's twice, so I've stopped rather than loop. Tell me to carry on once the server has settled.` }).catch((e) => console.error('jarvis recover:', e.message));
      out.push({ id: t.id, resumed: false });
      continue;
    }
    const ask = `[The server restarted about ${mins} minute${mins === 1 ? '' : 's'} into your last turn and cut you off before you answered. First check where the work got to (git status, the branch, what's committed and pushed), then finish it and answer him.${t.source === 'app' ? ' He asked in the app; this answer goes to him on Telegram.' : ''} His message was:]\n${t.text}`;
    // Not awaited: each goes through the engine's queue in order.
    jarvisOutOfBand(ask, { notice: `⏳ Sir, a server restart cut me off ${mins} min after you asked "${what}". Picking it back up now; I'll answer here.`, resumes: (t.resumes || 0) + 1 })
      .catch((e) => console.error('jarvis recover:', e.message));
    out.push({ id: t.id, resumed: true });
  }
  return out;
}

// Jobs, for the app: start one, poll it. A job outlives the HTTP request, so a
// half-hour piece of work doesn't depend on one connection staying open.
const jobs = new Map();
function startJob(prompt, persona) {
  const id = crypto.randomUUID();
  const ctrl = new AbortController();
  const job = { id, status: 'running', progress: 'Thinking', text: '', error: '', startedAt: Date.now(), seenAt: Date.now(), detached: false, ctrl, prompt };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (jobs.size > 30 && j.status !== 'running') jobs.delete(k);
  turn(prompt, { persona, signal: ctrl.signal, source: 'app', ownerText: prompt, onProgress: (p) => { job.progress = p; } })
    .then((text) => { job.status = 'done'; job.text = text; })
    .catch((e) => { job.status = e.name === 'AbortError' ? 'cancelled' : 'error'; job.error = e.message; job.text = e.partial || ''; })
    .finally(() => { job.endedAt = Date.now(); handOff(job); });
  return id;
}
// The app polls every 2s; quiet for this long means nobody is there to read it.
const UNWATCHED_MS = 45000;
const unwatched = (j) => j.detached || Date.now() - j.seenAt > UNWATCHED_MS;
// A finished app job nobody collected goes to him on Telegram, tags and all.
// If the app comes back and polls, it still gets the answer too.
function handOff(job) {
  if (job.status === 'running' || job.status === 'cancelled' || job.deliveredTo || !unwatched(job)) return;
  job.deliveredTo = 'pending';
  const { jarvisOutOfBand } = require('./routes/telegram');
  const send = job.status === 'done' && String(job.text || '').trim()
    ? jarvisOutOfBand(job.prompt, { reply: job.text, notice: '📲 Sir, the job you gave me in the app is finished. The app had stopped listening, so here it is:' })
    : jarvisOutOfBand('', { notice: `⚠️ Sir, the job you gave me in the app ("${String(job.prompt || '').replace(/\s+/g, ' ').slice(0, 160)}") didn't finish: ${String(job.error || 'it came back empty').slice(0, 300)}${job.text ? `\n\nWhere I'd got to: ${String(job.text).slice(0, 1500)}` : ''}` });
  send.then((ok) => { job.deliveredTo = ok ? 'telegram' : null; }).catch((e) => { job.deliveredTo = null; console.error('jarvis hand-off:', e.message); });
}
function jobStatus(id) {
  const j = jobs.get(id);
  if (!j) return null;
  j.seenAt = Date.now();
  j.detached = false;
  const { ctrl, prompt, ...pub } = j;
  return { ...pub, secs: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000) };
}
// Stop button only. Leaving the chat or sending something else detaches instead.
function cancelJob(id) { const j = jobs.get(id); if (j && j.status === 'running') j.ctrl.abort(); return !!j; }
// The app stopped listening: keep working and answer on Telegram when done.
function detachJob(id) { const j = jobs.get(id); if (j) { j.detached = true; handOff(j); } return !!j; }

function status() {
  return { enabled: enabled(), model: MODEL(), permissionMode: PERMISSION(), workdir: ROOT(), readOnly: !process.env.GITHUB_TOKEN, session: loadSession(), running: [...jobs.values()].filter((j) => j.status === 'running').length };
}

module.exports = {
  spawnTurn, workspace, run, ROOT, current, isBusy, loadSession, saveSession, enabled, turn, recover, startJob, jobStatus, cancelJob, detachJob, resetSession, status, engineBrief, describeTool };
