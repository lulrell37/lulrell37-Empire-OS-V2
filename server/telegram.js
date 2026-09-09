// Telegram Bot API client. The bot is a headless front door to the A.R.A.
// persona (server/araRuntime.js) — one private chat with the owner, locked to
// his numeric Telegram id. Nothing here does anything unless TELEGRAM_BOT_TOKEN
// and TELEGRAM_OWNER_ID are both set.
const crypto = require('crypto');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID || '').trim();
const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// Unguessable path segment + secret_token header for the webhook, derived from
// SYNC_TOKEN so there's no extra secret to set. Telegram echoes the secret_token
// back in the X-Telegram-Bot-Api-Secret-Token header on every delivery.
const WEBHOOK_SECRET = process.env.SYNC_TOKEN
  ? crypto.createHash('sha256').update('telegram-webhook:' + process.env.SYNC_TOKEN).digest('hex').slice(0, 40)
  : 'unset';

const isConfigured = () => !!(API && OWNER_ID);
const isOwner = (id) => OWNER_ID && String(id) === OWNER_ID;

async function tg(method, params) {
  if (!API) throw new Error('TELEGRAM_BOT_TOKEN not set');
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

// Telegram caps a message at 4096 chars. Send plain text (no parse_mode) so
// nothing in A.R.A.'s reply can break the send; split on paragraph / line
// boundaries when it's long.
function chunk(text, max = 3900) {
  const s = String(text || '').trim();
  if (s.length <= max) return s ? [s] : [];
  const out = [];
  let buf = '';
  for (const line of s.split('\n')) {
    if (buf.length + line.length + 1 > max) {
      if (buf) out.push(buf);
      buf = '';
      if (line.length > max) { // a single very long line — hard-split it
        for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max));
        continue;
      }
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf) out.push(buf);
  return out;
}

async function sendMessage(chatId, text, opts = {}) {
  const parts = chunk(text);
  if (!parts.length) return;
  for (const part of parts) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: part,
      disable_web_page_preview: true,
      ...opts,
    });
  }
}

// Send an OGG/Opus buffer as a Telegram voice note.
async function sendVoice(chatId, oggBuffer, opts = {}) {
  if (!API) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('voice', new Blob([oggBuffer], { type: 'audio/ogg' }), 'ara.ogg');
  if (opts.caption) form.append('caption', opts.caption);
  const res = await fetch(`${API}/sendVoice`, { method: 'POST', body: form });
  const d = await res.json().catch(() => ({}));
  if (!d.ok) throw new Error(`telegram sendVoice: ${d.description || res.status}`);
  return d.result;
}

// Download a file the user sent (voice note, etc.) by its file_id -> Buffer.
async function downloadFile(fileId) {
  const f = await tg('getFile', { file_id: fileId });
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.file_path}`);
  if (!res.ok) throw new Error(`telegram file download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Fire-and-forget DM to the owner — used by the nightly council and the nudge
// sender to reach him on Telegram alongside the Expo push. Never throws.
async function notifyOwner(text) {
  if (!isConfigured()) return { skipped: 'telegram not configured' };
  try {
    await sendMessage(OWNER_ID, text);
    return { sent: true };
  } catch (e) {
    console.error('telegram notifyOwner failed:', e.message);
    return { error: e.message };
  }
}

async function setWebhook(baseUrl) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}/telegram/webhook/${WEBHOOK_SECRET}`;
  const result = await tg('setWebhook', {
    url,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ['message'],
    drop_pending_updates: false,
  });
  return { url, result };
}

module.exports = {
  TOKEN, OWNER_ID, WEBHOOK_SECRET,
  isConfigured, isOwner, tg, sendMessage, sendVoice, sendChatAction, downloadFile, notifyOwner, setWebhook,
  getMe: () => tg('getMe'),
  getWebhookInfo: () => tg('getWebhookInfo'),
};
