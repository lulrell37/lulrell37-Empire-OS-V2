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
const SESSION_IDLE_MS = 3 * 24 * 3600 * 1000; // a fresh session after 3 quiet days
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
function loadSession() {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    if (s.id && Date.now() - (s.at || 0) < SESSION_IDLE_MS) return s.id;
  } catch { /* none yet */ }
  return null;
}
function saveSession(id) {
  try { fs.mkdirSync(ROOT(), { recursive: true }); fs.writeFileSync(sessionFile(), JSON.stringify({ id, at: Date.now() })); } catch {}
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

function spawnTurn({ prompt, persona, resume, onProgress, signal }) {
  return new Promise(async (resolve, reject) => {
    let ws;
    try { ws = await workspace(); } catch (e) { return reject(new Error(`couldn't set up the workspace: ${e.message}`)); }
    const briefFile = path.join(os.tmpdir(), `jarvis-brief-${process.pid}-${crypto.randomBytes(6).toString('hex')}.txt`);
    fs.writeFileSync(briefFile, engineBrief(persona, ws), { mode: 0o600 });
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
    const onAbort = () => { child.kill('SIGTERM'); done(() => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))); };
    if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort); }
    const timer = setTimeout(() => { child.kill('SIGTERM'); done(() => reject(Object.assign(new Error(`ran past ${Math.round(TIMEOUT_MS() / 60000)} minutes`), { partial: lastText, sessionId }))); }, TIMEOUT_MS());
    const handle = (line) => {
      let ev; try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) sessionId = ev.session_id;
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

// One turn at a time: they share a session and a working tree.
let chain = Promise.resolve();
async function turn(prompt, { persona = '', onProgress, signal } = {}) {
  const go = async () => {
    const resume = loadSession();
    let out;
    try {
      out = await spawnTurn({ prompt, persona, resume, onProgress, signal });
    } catch (e) {
      if (!e.resumeFailed) throw e;
      resetSession(); // the saved session is gone (new machine, cleared home) — start a new one
      out = await spawnTurn({ prompt, persona, resume: null, onProgress, signal });
    }
    if (out.sessionId) saveSession(out.sessionId);
    console.log(`jarvis engine: done in ${out.turns || '?'} turns${out.costUsd != null ? `, $${Number(out.costUsd).toFixed(3)}` : ''}`);
    return out.text;
  };
  const p = chain.then(go, go);
  chain = p.catch(() => {});
  return p;
}

// Jobs, for the app: start one, poll it. A job outlives the HTTP request, so a
// half-hour piece of work doesn't depend on one connection staying open.
const jobs = new Map();
function startJob(prompt, persona) {
  const id = crypto.randomUUID();
  const ctrl = new AbortController();
  const job = { id, status: 'running', progress: 'Thinking', text: '', error: '', startedAt: Date.now(), ctrl };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (jobs.size > 30 && j.status !== 'running') jobs.delete(k);
  turn(prompt, { persona, signal: ctrl.signal, onProgress: (p) => { job.progress = p; } })
    .then((text) => { job.status = 'done'; job.text = text; })
    .catch((e) => { job.status = e.name === 'AbortError' ? 'cancelled' : 'error'; job.error = e.message; job.text = e.partial || ''; })
    .finally(() => { job.endedAt = Date.now(); });
  return id;
}
function jobStatus(id) {
  const j = jobs.get(id);
  if (!j) return null;
  const { ctrl, ...pub } = j;
  return { ...pub, secs: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000) };
}
function cancelJob(id) { const j = jobs.get(id); if (j && j.status === 'running') j.ctrl.abort(); return !!j; }

function status() {
  return { enabled: enabled(), model: MODEL(), permissionMode: PERMISSION(), workdir: ROOT(), readOnly: !process.env.GITHUB_TOKEN, session: loadSession(), running: [...jobs.values()].filter((j) => j.status === 'running').length };
}

module.exports = { enabled, turn, startJob, jobStatus, cancelJob, resetSession, status, engineBrief, describeTool };
