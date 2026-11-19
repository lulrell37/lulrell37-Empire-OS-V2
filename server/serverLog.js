// What the server itself saw — so J.A.R.V.I.S. (and anyone debugging) reads
// evidence instead of guessing. In memory only, since this process started:
//   - every console warn/error line (and the last plain log lines)
//   - every AI proxy call that failed (the app's /ai/<provider> path), with
//     status, request size, upload time and what the provider actually said
// Tags (J.A.R.V.I.S., A.R.A.): [SERVER_LOGS] / [SERVER_LOGS: filter],
// [AI_ERRORS], [HEALTH_CHECK]. Also GET /diag (auth) for the same data as JSON.
const MAX_LINES = 400;
const MAX_AI = 60;
const lines = [];
const aiCalls = [];
const aiTotals = {}; // provider -> { ok, failed }
const started = Date.now();

const et = (ts) => new Date(ts).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

function push(level, args) {
  let text;
  try { text = args.map((a) => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' '); } catch { text = String(args[0]); }
  lines.push({ ts: Date.now(), level, text: text.slice(0, 2000) });
  if (lines.length > MAX_LINES) lines.shift();
}

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { push(level, args); orig(...args); };
  }
  process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
}

// One finished /ai call. `failed` = non-2xx, or the proxy's own error.
function recordAi(rec) {
  const t = (aiTotals[rec.provider] = aiTotals[rec.provider] || { ok: 0, failed: 0 });
  if (rec.ok) { t.ok++; return; }
  t.failed++;
  aiCalls.push({ ts: Date.now(), ...rec });
  if (aiCalls.length > MAX_AI) aiCalls.shift();
}

function serverLogs(filter) {
  const f = String(filter || '').trim().toLowerCase();
  const pick = lines.filter((l) => (f ? l.text.toLowerCase().includes(f) : l.level !== 'log' || /fail|error|crash|refus|timeout|retry/i.test(l.text)));
  if (!pick.length) return f ? `no server log lines containing "${filter}" since ${et(started)}` : `no warnings or errors logged since this server started (${et(started)})`;
  return `${pick.length} line(s) since ${et(started)}${f ? ` containing "${filter}"` : ' (warnings/errors)'}, newest last:\n` +
    pick.slice(-60).map((l) => `${et(l.ts)} ${l.level.toUpperCase()} ${l.text}`).join('\n');
}

function aiErrors() {
  const totals = Object.entries(aiTotals).map(([p, t]) => `${p}: ${t.ok} ok, ${t.failed} failed`).join(' · ') || 'no app AI calls yet';
  if (!aiCalls.length) return `App AI calls through this server since ${et(started)}: ${totals}. None failed.`;
  return `App AI calls since ${et(started)}: ${totals}. Failed calls, newest last:\n` + aiCalls.slice(-25).map((c) =>
    `${et(c.ts)} ${c.provider} ${c.method} /${c.path} → ${c.status}${c.model ? ` · model ${c.model}` : ''} · ${c.bytes != null ? `${Math.round(c.bytes / 1024)} KB` : 'size ?'}` +
    `${c.uploadMs != null ? ` · upload ${(c.uploadMs / 1000).toFixed(1)}s` : ''} · total ${(c.ms / 1000).toFixed(1)}s${c.stream ? ' · stream' : ''}${c.via ? ` · ${c.via}` : ''}` +
    `${c.ua ? ` · client ${c.ua.slice(0, 40)}` : ''}\n   said: ${c.detail || '(no body)'}`).join('\n');
}

function healthCheck() {
  let info = {};
  try { info = require('./redeploy').codeInfo(); } catch (e) { info = { error: e.message }; }
  let ai = {};
  try { const { subscriptionStatus, creditStatus } = require('./llm'); ai = { claudeSubscription: subscriptionStatus(), credits: creditStatus() }; } catch (e) { ai = { error: e.message }; }
  const fb = process.env.EMPIRE_FALLBACK_ERROR;
  return [
    `Running ${info.source || '?'} @ ${info.sha || '?'}${info.supervised ? ' (supervised by boot.js)' : ''}, up since ${et(started)}.`,
    fb ? `FELL BACK — the newer code did not start:\n${fb}` : 'Not on a fallback: the code it wanted is the code running.',
    `Public URL: ${process.env.PUBLIC_URL || (process.env.REPLIT_DOMAINS ? `https://${String(process.env.REPLIT_DOMAINS).split(',')[0]}` : 'unknown')}`,
    `AI: ${JSON.stringify(ai)}`,
    aiErrors(),
  ].join('\n');
}

const DIAG_TAGS = new Set(['SERVER_LOGS', 'AI_ERRORS', 'HEALTH_CHECK']);
function diagTag(name, arg) {
  if (name === 'SERVER_LOGS') return serverLogs(arg);
  if (name === 'AI_ERRORS') return aiErrors();
  if (name === 'HEALTH_CHECK') return healthCheck();
  return '';
}

function diagJson() {
  return { started, lines: lines.slice(-200), aiCalls, aiTotals, fallbackError: process.env.EMPIRE_FALLBACK_ERROR || null };
}

// For the sentinel: warn/error lines and failed app AI calls newer than ts.
const errorLinesSince = (ts) => lines.filter((l) => l.ts > ts && l.level !== 'log');
const aiFailuresSince = (ts) => aiCalls.filter((c) => c.ts > ts);

module.exports = { install, recordAi, errorLinesSince, aiFailuresSince, serverLogs, aiErrors, healthCheck, DIAG_TAGS, diagTag, diagJson };
