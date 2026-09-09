// Telegram Bot API — one bot per persona, each a headless front door to that
// persona's server-side runtime (server/personaRuntime.js). Every bot is a
// single private chat with the owner, locked to his numeric Telegram id.
//
// A persona's bot is live only when its token env var is set:
//   ara       -> TELEGRAM_BOT_TOKEN            (the original)
//   stephanie -> TELEGRAM_BOT_TOKEN_STEPHANIE
//   haven     -> TELEGRAM_BOT_TOKEN_HAVEN
//   jarvis    -> TELEGRAM_BOT_TOKEN_JARVIS
//   selene    -> TELEGRAM_BOT_TOKEN_SELENE
// TELEGRAM_OWNER_ID is shared across all of them.
const crypto = require('crypto');

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || '').trim();
const SYNC_TOKEN = process.env.SYNC_TOKEN || '';

// personaId -> token env var. Add a row here (and a BotFather bot + env token) to
// put another persona on Telegram.
const BOT_TOKENS = {
  ara: process.env.TELEGRAM_BOT_TOKEN || '',
  stephanie: process.env.TELEGRAM_BOT_TOKEN_STEPHANIE || '',
  haven: process.env.TELEGRAM_BOT_TOKEN_HAVEN || '',
  jarvis: process.env.TELEGRAM_BOT_TOKEN_JARVIS || '',
  selene: process.env.TELEGRAM_BOT_TOKEN_SELENE || '',
};

const isOwner = (id) => OWNER_ID && String(id) === OWNER_ID;

// Per-bot webhook secret — unguessable path segment + secret_token header,
// derived from SYNC_TOKEN so there's no extra secret to set. Namespaced by
// persona so each bot has a distinct one.
function secretFor(personaId) {
  return SYNC_TOKEN
    ? crypto.createHash('sha256').update(`telegram-webhook:${personaId}:${SYNC_TOKEN}`).digest('hex').slice(0, 40)
    : 'unset';
}

// Telegram caps a message at 4096 chars. Send plain text (no parse_mode) so
// nothing in a reply can break the send; split on line boundaries when long.
function chunk(text, max = 3900) {
  const s = String(text || '').trim();
  if (s.length <= max) return s ? [s] : [];
  const out = [];
  let buf = '';
  for (const line of s.split('\n')) {
    if (buf.length + line.length + 1 > max) {
      if (buf) out.push(buf);
      buf = '';
      if (line.length > max) {
        for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
        continue;
      }
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) out.push(buf);
  return out;
}

// Build the API surface for one bot token.
function makeBot(personaId, token) {
  const API = token ? `https://api.telegram.org/bot${token}` : null;
  const secret = secretFor(personaId);

  async function tg(method, params) {
    if (!API) throw new Error(`telegram bot "${personaId}" has no token`);
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params || {}),
    });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) throw new Error(`telegram ${method}: ${d.description || res.status}`);
    return d.result;
  }

  async function sendChatAction(chatId, action = 'typing') {
    try { await tg('sendChatAction', { chat_id: chatId, action }); } catch {}
  }

  async function sendMessage(chatId, text, opts = {}) {
    for (const part of chunk(text)) {
      await tg('sendMessage', { chat_id: chatId, text: part, disable_web_page_preview: true, ...opts });
    }
  }

  async function sendVoice(chatId, oggBuffer, opts = {}) {
    if (!API) throw new Error(`telegram bot "${personaId}" has no token`);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('voice', new Blob([oggBuffer], { type: 'audio/ogg' }), `${personaId}.ogg`);
    if (opts.caption) form.append('caption', opts.caption);
    const res = await fetch(`${API}/sendVoice`, { method: 'POST', body: form });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) throw new Error(`telegram sendVoice: ${d.description || res.status}`);
    return d.result;
  }

  async function downloadFile(fileId) {
    const f = await tg('getFile', { file_id: fileId });
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`);
    if (!res.ok) throw new Error(`telegram file download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async function setWebhook(baseUrl) {
    const url = `${String(baseUrl).replace(/\/+$/, '')}/telegram/webhook/${personaId}/${secret}`;
    const result = await tg('setWebhook', {
      url, secret_token: secret,
      allowed_updates: ['message'],
      drop_pending_updates: false,
    });
    return { persona: personaId, url, result };
  }

  return {
    personaId, token, secret,
    isConfigured: () => !!(API && OWNER_ID),
    tg, sendMessage, sendVoice, sendChatAction, downloadFile, setWebhook,
    getMe: () => tg('getMe'),
    getWebhookInfo: () => tg('getWebhookInfo'),
  };
}

// personaId -> bot. Every persona in BOT_TOKENS gets an entry; unconfigured ones
// report isConfigured() === false and no-op.
const bots = {};
for (const [personaId, token] of Object.entries(BOT_TOKENS)) {
  bots[personaId] = makeBot(personaId, token);
}

const configuredBots = () => Object.values(bots).filter((b) => b.isConfigured());
const botFor = (personaId) => bots[personaId] || null;

// Any bot live at all? (index.js uses this to decide whether to auto-register.)
const isConfigured = () => configuredBots().length > 0;

// Fire-and-forget DM to the owner from A.R.A.'s bot — the nightly council and the
// nudge sender use this. Never throws.
async function notifyOwner(text) {
  const ara = bots.ara;
  if (!ara || !ara.isConfigured()) return { skipped: 'telegram not configured' };
  try {
    await ara.sendMessage(OWNER_ID, text);
    return { sent: true };
  } catch (e) {
    console.error('telegram notifyOwner failed:', e.message);
    return { error: e.message };
  }
}

// Register the webhook for every configured bot. Returns one result per bot.
async function setWebhook(baseUrl) {
  const out = [];
  for (const b of configuredBots()) {
    try { out.push(await b.setWebhook(baseUrl)); }
    catch (e) { out.push({ persona: b.personaId, error: e.message }); }
  }
  return out;
}

module.exports = {
  OWNER_ID, isOwner,
  bots, botFor, configuredBots, isConfigured,
  notifyOwner, setWebhook,
};
