// The sentinel: nothing in the Empire switches off without him hearing about it.
// Every 10 minutes (SENTINEL=off to stop) it checks each outside service and
// every loop, and when something goes from working to broken it tells him once:
// a text from A.R.A.'s bot (text only, no voice: voice is often what broke) and
// a phone push. It reminds every 12 h while it stays broken and says when it
// clears. The live list is GET /sentinel, which the app's top strip shows.
//
// Checks:
//   elevenlabs   the account's character balance (out, or under 10% left)
//   ai:<p>       the server's Anthropic / xAI / OpenAI key out of credits
//   claudesub    the Claude subscription at its limit or logged out
//   appai:<p>    the app's AI calls through /ai/<p> refused (401/402/403/429)
//   google       the linked Google account failing (Drive, Calendar, Gmail)
//   telegram:<p> a persona bot's webhook failing or missing
//   boot         the server fell back to an older copy on its last start
//   loop:<name>  any loop / cron / desk logging "... failed" (2+ times in 30 min)
//   push         no phone registered for push notifications
// State is app_settings.sentinel_state, so a restart doesn't repeat alerts.
const serverLog = require('./serverLog');
const { getSetting, setSetting } = require('./syncStore');

const REMIND_MS = 12 * 3600e3;
const LOOP_WINDOW_MS = 30 * 60e3;
let lastRun = 0;

const short = (s, n = 180) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

async function checkElevenLabs() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return [{ key: 'elevenlabs', label: 'ElevenLabs voice', msg: 'no ELEVENLABS_API_KEY on the server: every voice falls back' }];
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(15000) });
    const body = await res.text();
    if (res.status === 401 && /permission/i.test(body)) return []; // key can't read the balance; refused voice calls still show under appai/loop
    if (!res.ok) return [{ key: 'elevenlabs', label: 'ElevenLabs voice', msg: `ElevenLabs said ${res.status}: ${short(body, 120)}` }];
    const j = JSON.parse(body);
    const used = Number(j.character_count) || 0, limit = Number(j.character_limit) || 0;
    if (!limit) return [];
    const left = limit - used;
    if (left <= limit * 0.01) return [{ key: 'elevenlabs', label: 'ElevenLabs voice', msg: `out of characters (${used.toLocaleString()} of ${limit.toLocaleString()} used): every persona is on the phone voice until it's topped up` }];
    if (left <= limit * 0.1) return [{ key: 'elevenlabs_low', label: 'ElevenLabs credits low', severity: 'warn', msg: `${left.toLocaleString()} of ${limit.toLocaleString()} characters left` }];
    return [];
  } catch (e) { return []; } // network blip: not evidence of anything
}

function checkAi() {
  const out = [];
  const { creditStatus, subscriptionStatus } = require('./llm');
  const label = { anthropic: 'Anthropic API', xai: 'xAI (Grok)', openai: 'OpenAI', google: 'Gemini' };
  for (const [p, s] of Object.entries(creditStatus())) {
    if (s.outOfCreditUntil) out.push({ key: 'ai:' + p, label: label[p] || p, msg: 'out of credits: the server is skipping it' });
  }
  const sub = subscriptionStatus();
  if (sub.enabled && sub.authFailed) out.push({ key: 'claudesub', label: 'Claude subscription', msg: `logged out${sub.lastError ? ': ' + short(sub.lastError, 100) : ''}` });
  else if (sub.enabled && sub.limited) out.push({ key: 'claudesub', label: 'Claude subscription', severity: 'warn', msg: `at its usage limit${sub.limitedUntil ? ' until ' + new Date(sub.limitedUntil).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }) : ''}` });
  return out;
}

function checkAppAi(since) {
  const by = {};
  for (const c of serverLog.aiFailuresSince(since)) {
    if (![401, 402, 403, 429].includes(Number(c.status))) continue;
    (by[c.provider] = by[c.provider] || []).push(c);
  }
  const name = { elevenlabs: 'ElevenLabs voice', anthropic: 'Claude', xai: 'Grok', openai: 'OpenAI', google: 'Gemini' };
  return Object.entries(by).map(([p, calls]) => {
    const c = calls[calls.length - 1];
    return { key: p === 'elevenlabs' ? 'elevenlabs' : 'appai:' + p, label: `${name[p] || p} (app)`, msg: `${calls.length} call(s) refused, last ${c.status}: ${short(c.detail, 120)}` };
  });
}

async function checkGoogle() {
  try {
    const s = await require('./google').googleStatus();
    if (s.linked && !s.ok) return [{ key: 'google', label: 'Google (Drive, Calendar, Gmail)', msg: short(s.error, 140) }];
  } catch {}
  return [];
}

async function checkTelegram() {
  const out = [];
  let bots = [];
  try { bots = require('./telegram').configuredBots(); } catch { return out; }
  for (const b of bots) {
    try {
      const r = await b.getWebhookInfo();
      const info = r && r.result ? r.result : r;
      if (!info) continue;
      if (!info.url) out.push({ key: 'telegram:' + b.personaId, label: `${b.personaId.toUpperCase()}'s Telegram bot`, msg: 'no webhook set: messages to it go nowhere' });
      else if (info.last_error_date && Date.now() / 1000 - info.last_error_date < 1800) out.push({ key: 'telegram:' + b.personaId, label: `${b.personaId.toUpperCase()}'s Telegram bot`, msg: `webhook failing: ${short(info.last_error_message, 100)}` });
    } catch {}
  }
  return out;
}

function checkBoot() {
  try {
    const c = require('./redeploy').codeInfo();
    if (c.fell_back) return [{ key: 'boot', label: 'Server update', msg: `the latest code didn't start, so it's running an older copy: ${short(process.env.EMPIRE_FALLBACK_ERROR, 140)}` }];
  } catch {}
  return [];
}

// "<thing> failed: why" lines, grouped by thing. Two in the window = broken.
function checkLoops(now) {
  const by = {};
  for (const l of serverLog.errorLinesSince(now - LOOP_WINDOW_MS)) {
    const m = /^([\w .'\-/]{3,60}?)\s+(?:cron\s+)?failed\b[:\s-]*(.*)/i.exec(l.text);
    if (!m) continue;
    const name = m[1].trim().toLowerCase().replace(/\s+cron$/, '');
    (by[name] = by[name] || []).push(m[2] || l.text);
  }
  return Object.entries(by).filter(([, v]) => v.length >= 2).map(([name, v]) =>
    ({ key: 'loop:' + name.replace(/\W+/g, '_'), label: name, msg: `failed ${v.length}× in the last 30 min: ${short(v[v.length - 1], 140)}` }));
}

async function checkPush() {
  try {
    const { query } = require('./db');
    const { rows } = await query('SELECT COUNT(*)::int AS n FROM devices');
    if (!rows[0] || !rows[0].n) return [{ key: 'push', label: 'Phone notifications', severity: 'warn', msg: 'no phone registered, so alerts only reach Telegram' }];
  } catch {}
  return [];
}

async function loadState() {
  try { return JSON.parse(await getSetting('sentinel_state', '{}')) || {}; } catch { return {}; }
}

async function tell(text, pushTitle, pushKey) {
  try { await require('./telegram').notifyOwner(text); } catch {}
  try { await require('./pushSender').pushAlert(pushKey, pushTitle, text.replace(/[*_`]/g, '').slice(0, 200), { kind: 'sentinel' }); } catch {}
}

async function tick() {
  if (process.env.SENTINEL === 'off') return { skipped: 'off' };
  const now = Date.now();
  const since = lastRun || now - 15 * 60e3;
  lastRun = now;
  const groups = await Promise.all([checkElevenLabs(), checkAi(), checkAppAi(since), checkGoogle(), checkTelegram(), checkBoot(), checkLoops(now), checkPush()].map((p) => Promise.resolve(p).catch(() => [])));
  const found = {};
  for (const i of groups.flat()) if (!found[i.key]) found[i.key] = i;
  const state = await loadState();
  const next = {};
  for (const [key, i] of Object.entries(found)) {
    const prev = state[key];
    const item = { label: i.label, msg: i.msg, severity: i.severity || 'error', since: prev ? prev.since : now, told: prev ? prev.told : 0 };
    if (!prev || now - prev.told > REMIND_MS) {
      const again = prev ? ' (still broken)' : '';
      await tell(`⚠️ ${i.label}${again}: ${i.msg}`, `⚠️ ${i.label}`, `sentinel:${key}:${now}`);
      item.told = now;
    }
    next[key] = item;
  }
  // Recovered: an AI-refusal / loop alert clears once a full window passes clean;
  // the others clear as soon as their check passes.
  for (const [key, prev] of Object.entries(state)) {
    if (next[key]) continue;
    const sticky = /^(appai:|loop:)/.test(key) || (key === 'elevenlabs' && /refused/.test(prev.msg || ''));
    if (sticky && now - (prev.lastSeen || prev.since) < LOOP_WINDOW_MS) { next[key] = prev; continue; }
    await tell(`✅ ${prev.label}: working again.`, `✅ ${prev.label}`, `sentinel:${key}:ok:${now}`);
  }
  for (const key of Object.keys(found)) next[key].lastSeen = now;
  await setSetting('sentinel_state', JSON.stringify(next));
  return { checked: now, problems: Object.keys(next).length };
}

async function status() {
  const s = await loadState();
  return Object.entries(s).map(([key, v]) => ({ key, label: v.label, msg: v.msg, severity: v.severity, since: v.since }));
}

module.exports = { tick, status };
