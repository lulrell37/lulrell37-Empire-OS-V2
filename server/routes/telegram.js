// Telegram webhook — the bot is a headless front door to the A.R.A. persona.
//
//   POST /telegram/webhook/:secret   Telegram delivers updates here. Guarded by
//                                    the secret path segment + the secret_token
//                                    header + the owner-id check. No bearer auth
//                                    (Telegram can't send one).
//   POST /telegram/set-webhook       { url } (or PUBLIC_URL) — register the
//                                    webhook. Owner bearer token.
//   GET  /telegram/info              bot + webhook status. Owner bearer token.
const express = require('express');
const { query } = require('../db');
const auth = require('../auth');
const tg = require('../telegram');
const { runAraTurn } = require('../araRuntime');
const { transcribe } = require('../llm');
const { synthesizeAraVoice } = require('../araVoice');

const r = express.Router();

r.post('/webhook/:secret', (req, res) => {
  if (req.params.secret !== tg.WEBHOOK_SECRET
      || req.get('x-telegram-bot-api-secret-token') !== tg.WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }
  res.sendStatus(200); // ack now — an A.R.A. turn can take 10-60s
  handleUpdate(req.body).catch((e) => console.error('telegram update failed:', e.message));
});

async function handleUpdate(update) {
  const msg = update && update.message;
  if (!msg || !msg.chat) return;
  if (!tg.isConfigured()) return;

  if (!tg.isOwner(msg.from && msg.from.id)) {
    await tg.sendMessage(msg.chat.id, 'This bot is private.').catch(() => {});
    return;
  }

  // De-dupe the occasional duplicate delivery.
  const ins = await query(
    'INSERT INTO tg_seen (update_id, seen_at) VALUES ($1, $2) ON CONFLICT (update_id) DO NOTHING',
    [update.update_id, Date.now()],
  ).catch(() => ({ rowCount: 1 }));
  if (!ins.rowCount) return;

  const chatId = msg.chat.id;
  const deliver = (t) => tg.sendMessage(chatId, t).catch((e) => console.error('tg send:', e.message));

  // A voice note / audio message — transcribe it and treat it like a typed
  // message, then reply out loud too.
  const voice = msg.voice || msg.audio || msg.video_note;
  let text = typeof msg.text === 'string' ? msg.text.trim() : '';
  let spokenInput = false;
  if (voice) {
    await tg.sendChatAction(chatId, 'typing');
    try {
      text = await transcribe(await tg.downloadFile(voice.file_id), 'voice.ogg');
      spokenInput = true;
    } catch (e) {
      await deliver(`Couldn't make out that voice note: ${e.message}`);
      return;
    }
    if (!text) { await deliver("That came through silent — say again?"); return; }
  }
  if (!text) return;

  if (text === '/start' || text === '/help') {
    await deliver("A.R.A. here, Mr. Burrus — same me, on Telegram now, away from the app. Type or send a voice note. Hand me a task, ask what's on your plate, say \"convene the council\". A few things still need the app open (the Lab, HUD panels, trades) and I'll tell you when.");
    return;
  }

  await tg.sendChatAction(chatId, spokenInput ? 'record_voice' : 'typing');
  const keepTyping = setInterval(() => tg.sendChatAction(chatId, spokenInput ? 'record_voice' : 'typing').catch(() => {}), 6000);
  try {
    const { text: reply } = await runAraTurn(text, deliver);
    if (spokenInput) {
      const ogg = await synthesizeAraVoice(reply, { userText: text });
      if (ogg) await tg.sendVoice(chatId, ogg).catch((e) => console.error('tg sendVoice:', e.message));
    }
    await deliver(reply);
  } catch (e) {
    console.error('ara turn failed:', e.message);
    await deliver(`Something went wrong on my end: ${e.message}`);
  } finally {
    clearInterval(keepTyping);
  }
}

r.post('/set-webhook', auth, express.json(), async (req, res) => {
  const base = (req.body && req.body.url) || process.env.PUBLIC_URL;
  if (!base) return res.status(400).json({ error: 'pass { "url": "https://…" } or set PUBLIC_URL' });
  try { res.json(await tg.setWebhook(base)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

r.get('/info', auth, async (req, res) => {
  try {
    res.json({
      configured: tg.isConfigured(),
      owner_id_set: !!tg.OWNER_ID,
      me: await tg.getMe().catch((e) => ({ error: e.message })),
      webhook: await tg.getWebhookInfo().catch((e) => ({ error: e.message })),
    });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = r;
