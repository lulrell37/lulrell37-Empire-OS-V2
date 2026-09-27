// Subscription-billed Claude, via the Claude Code CLI running headless.
//
// Instead of paying per token against ANTHROPIC_API_KEY, this drives the
// `claude` binary authenticated with a long-lived OAuth token minted from a
// Claude Pro/Max account, so calls draw down that subscription's usage pool.
//
//   Setup (once, on any machine logged into the Pro/Max account):
//     $ claude setup-token          # prints a token starting sk-ant-oat...
//   Then on the server set:
//     CLAUDE_SUBSCRIPTION=on
//     CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
//
// Limit handling: the CLI reports the subscription's rate-limit state on every
// call (`rate_limit_event` — status + resetsAt). When it says "rejected" (usage
// limit hit), the subscription is parked until that reset time and every caller
// goes straight to the metered API; the first call after the reset tries the
// subscription again. Any other CLI failure falls back to the API for that one
// call only.
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const LIMIT_COOLDOWN_MS = 30 * 60000;   // when a limit is hit but no reset time came back
let limitedUntil = 0;

// CLAUDE_CODE_OAUTH_TOKEN is the normal way to authenticate on the server; a
// machine where `claude` is already logged in works without it.
function enabled() {
  return process.env.CLAUDE_SUBSCRIPTION === 'on';
}

// On, configured, and not parked on a usage limit.
function subscriptionAvailable() {
  if (!enabled()) return false;
  if (limitedUntil && Date.now() >= limitedUntil) {
    console.log('claude subscription: usage window reset — back on the subscription');
    limitedUntil = 0;
  }
  return !limitedUntil;
}

function markLimited(resetsAtMs) {
  const until = resetsAtMs && resetsAtMs > Date.now() ? resetsAtMs : Date.now() + LIMIT_COOLDOWN_MS;
  if (until > limitedUntil) {
    limitedUntil = until;
    console.warn(`claude subscription: usage limit hit — on the metered API until ${new Date(until).toISOString()}`);
  }
}

function status() {
  return { enabled: enabled(), limited: !!limitedUntil && Date.now() < limitedUntil, limitedUntil: limitedUntil || null };
}

// Locate the `claude` executable: explicit override, then the installed
// package, then whatever is on PATH.
let cliPath;
function resolveCli() {
  if (cliPath) return cliPath;
  if (process.env.CLAUDE_CLI_PATH) return (cliPath = process.env.CLAUDE_CLI_PATH);
  try {
    const pkgJson = require.resolve('@anthropic-ai/claude-code/package.json');
    const { bin } = require(pkgJson);
    const rel = typeof bin === 'string' ? bin : (bin && bin.claude);
    if (rel) return (cliPath = path.join(path.dirname(pkgJson), rel));
  } catch {
    /* not installed as a dependency — fall through */
  }
  return (cliPath = 'claude');
}

// Anthropic content (string or block array) -> plain text. Returns null if it
// carries anything the CLI prompt can't (images, documents).
function blockText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return String(c);
  let out = '';
  for (const b of c) {
    if (b.type === 'text') out += b.text || '';
    else if (b.type === 'tool_result') out += blockText(b.content);
    else return null;
  }
  return out;
}

// System (string or cache_control block array) + messages -> the CLI's
// --system-prompt and single prompt string. Returns null when the request
// can't be expressed that way (images etc.), so the caller uses the API.
function toCliPrompt(system, messages) {
  const sys = blockText(system);
  if (sys == null) return null;
  const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : (messages || []);
  const parts = [];
  for (const m of msgs) {
    const t = blockText(m.content);
    if (t == null) return null;
    parts.push(msgs.length === 1 ? t : `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${t}`);
  }
  let prompt = parts.join('\n\n');
  if (msgs.length > 1) prompt = `Conversation so far — reply as the Assistant to the last User message. Output only your reply.\n\n${prompt}`;
  return { system: sys, prompt };
}

const LIMIT_RE = /usage limit|hit your limit|rate.?limit|limit reached|out of (?:extra )?usage/i;

// One completion on the subscription. `onText(delta)` streams text as it comes.
// Resolves to the full reply text; rejects on any failure. `search` gives the
// model the WebSearch tool (standing in for the API's web_search tool).
function claudeSubRun(system, messages, { model = 'claude-sonnet-5', search = false, onText, signal, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const p = toCliPrompt(system, messages);
    if (!p) return reject(new Error('claude cli: request has non-text content'));
    const args = [
      '-p', p.prompt,
      '--model', model,
      '--system-prompt', p.system,
      '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--tools', search ? 'WebSearch' : '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--setting-sources', '',
    ];
    if (search) args.push('--allowedTools', 'WebSearch');
    // Drop the metered key from the child's env so the CLI authenticates with the
    // OAuth token (subscription), never the API key.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    // Neutral cwd so no CLAUDE.md or project settings leak into the persona.
    const child = spawn(resolveCli(), args, { env, cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let buf = '';
    let stderr = '';
    let result = null;
    let rejected = false;   // the CLI reported the usage limit (with its reset time)
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn();
    };
    const onAbort = () => { child.kill('SIGTERM'); finish(() => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))); };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(() => reject(new Error('claude cli: timed out'))); }, timeoutMs || (search ? 240000 : 150000));

    const handle = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
        const e = ev.event || {};
        if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta' && e.delta.text) {
          text += e.delta.text;
          if (onText) onText(e.delta.text);
        } else if (e.type === 'message_start' && text && search) {
          // A new assistant message after a search round — keep paragraphs apart.
          text += '\n\n';
          if (onText) onText('\n\n');
        }
      } else if (ev.type === 'rate_limit_event') {
        const info = ev.rate_limit_info || {};
        if (info.status === 'rejected') { rejected = true; markLimited(info.resetsAt ? info.resetsAt * 1000 : 0); }
      } else if (ev.type === 'result') {
        result = ev;
      }
    };
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finish(() => reject(new Error(`claude cli: ${e.message}`))));
    child.on('close', (code) => {
      if (buf.trim()) handle(buf);
      finish(() => {
        if (result && !result.is_error && result.subtype === 'success') {
          return resolve(String(text || result.result || '').trim());
        }
        const msg = (result && (result.result || (result.errors || []).join('; ') || result.subtype)) || stderr.slice(0, 200) || `exit ${code}`;
        if (!rejected && LIMIT_RE.test(msg)) markLimited(0);
        reject(Object.assign(new Error(`claude cli: ${String(msg).slice(0, 240)}`), { partial: text }));
      });
    });
  });
}

module.exports = { claudeSubRun, subscriptionAvailable, subscriptionEnabled: enabled, subscriptionStatus: status, toCliPrompt };
