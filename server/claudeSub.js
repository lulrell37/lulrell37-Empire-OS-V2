// Subscription-billed Claude, via the Claude Code CLI running headless.
//
// Instead of paying per token against ANTHROPIC_API_KEY, this drives the same
// `claude` binary the desktop/CLI app uses, authenticated with a long-lived
// OAuth token minted from a Claude Pro/Max account. Every call then draws down
// that subscription's usage pool.
//
//   Setup (once, on any machine logged into the Pro/Max account):
//     $ claude setup-token          # prints a token starting sk-ant-oat...
//   Then on the server set:
//     CLAUDE_SUBSCRIPTION=on
//     CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat...
//
// Scope: this only backs the interactive persona path (llm.js `chatAs` and the
// no-tool `claudeText` calls behind it — Telegram + relayed chat + memory
// recall). Anything that passes a `tools` array (web / deep research) and the
// cron jobs (daily briefing, council, scout) stay on the metered API so a burst
// can't drain the weekly limit. On any CLI error the caller falls back to the
// API automatically.
const path = require('path');
const { execFile } = require('child_process');

function enabled() {
  return process.env.CLAUDE_SUBSCRIPTION === 'on' && !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
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

// Flatten a [{role,content}] history (or a bare string) into a single prompt.
// The CLI takes one prompt string; the persona's system prompt is passed
// separately via --system-prompt.
function flatten(messages) {
  if (typeof messages === 'string') return messages;
  return (messages || [])
    .map((m) => {
      const who = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
      return `${who}: ${String(m.content == null ? '' : m.content)}`;
    })
    .join('\n\n');
}

const NO_TOOLS = [
  'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Task', 'NotebookEdit', 'TodoWrite',
];

// One-shot completion. Resolves to the reply text, or rejects on any failure
// (missing binary, auth, non-zero exit, unparseable output, model error).
function claudeSubText(system, messages, { model = 'claude-sonnet-5', timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', flatten(messages),
      '--model', model,
      '--system-prompt', String(system || ''),
      '--output-format', 'json',
      '--disallowed-tools', NO_TOOLS.join(' '),
      '--strict-mcp-config',
      '--no-session-persistence',
      '--setting-sources', '',
    ];
    // Drop ANTHROPIC_API_KEY from the child's env so the CLI uses the OAuth
    // token (subscription) rather than the metered key.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    execFile(resolveCli(), args, { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        return reject(new Error(`claude cli: ${err.message}${stderr ? ' — ' + String(stderr).slice(0, 200) : ''}`));
      }
      let d;
      try {
        d = JSON.parse(stdout);
      } catch {
        return reject(new Error(`claude cli: unparseable output — ${String(stdout).slice(0, 200)}`));
      }
      if (d.is_error || d.subtype !== 'success') {
        return reject(new Error(`claude cli: ${d.result || d.subtype || 'failed'}`));
      }
      resolve(String(d.result || '').trim());
    });
  });
}

module.exports = { claudeSubText, subscriptionEnabled: enabled };
