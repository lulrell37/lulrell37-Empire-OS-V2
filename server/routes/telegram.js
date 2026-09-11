// Telegram webhooks — one bot per persona, each a headless front door to that
// persona (server/personaRuntime.js).
//
//   POST /telegram/webhook/:persona/:secret   Telegram delivers updates here.
//                                    Guarded by the persona-namespaced secret
//                                    path segment + the secret_token header +
//                                    the owner-id check. No bearer auth.
//   POST /telegram/set-webhook       { url } (or PUBLIC_URL) — register every
//                                    configured bot's webhook. Owner bearer token.
//   GET  /telegram/info              every configured bot + its webhook status.
const express = require('express');
const { query } = require('../db');
const auth = require('../auth');
const tg = require('../telegram');
const { ROSTER } = require('../personas');
const { runPersonaTurn } = require('../personaRuntime');
const { transcribe } = require('../llm');
const { synthesizePersonaVoice } = require('../personaVoice');

const r = express.Router();

const GREETINGS = {
  ara: "A.R.A. here, Mr. Burrus — same me, on Telegram now, away from the app. Type or send a voice note. Hand me a task, ask what's on your plate, say \"convene the council\". A few things still need the app open (the Lab, HUD panels, trades) and I'll tell you when.",
  stephanie: "S.T.E.P.H.A.N.I.E. — your personal university, on Telegram now. Ask me anything you want to actually understand. I can page through the \"Learning Everything\" curriculum, save notes, and pull in S.A.G.E. for deep research.",
  haven: "H.A.V.E.N. here — doctor and wellness, on Telegram. Training, recovery, sleep, stress, nutrition. I read the Batman Protocol live from the HUD. Not for emergencies — if it's urgent, get real care.",
  jarvis: "J.A.R.V.I.S., sir — on Telegram, away from the app. Operations, execution, systems, the build pipeline. I can check build status and read the HUD; editing it and filing builds still needs the app.",
  selene: "S.E.L.E.N.E. — Creative Director, on Telegram. Content strategy, positioning, copy, visual direction. I can brief S.C.R.I.B.E. and H.O.O.K. and fold their work back into a direction.",
};

r.post('/webhook/:persona/:secret', (req, res) => {
  const personaId = String(req.params.persona || '');
  const bot = tg.botFor(personaId);
  if (!bot || !bot.isConfigured()
      || req.params.secret !== bot.secret
      || req.get('x-telegram-bot-api-secret-token') !== bot.secret) {
    return res.sendStatus(403);
  }
  res.sendStatus(200); // ack now — a persona turn can take 10-60s
  handleUpdate(personaId, bot, req.body).catch((e) => console.error(`telegram ${personaId} update failed:`, e.message));
});

async function handleUpdate(personaId, bot, update) {
  const msg = update && update.message;
  if (!msg || !msg.chat) return;

  if (!tg.isOwner(msg.from && msg.from.id)) {
    await bot.sendMessage(msg.chat.id, 'This bot is private.').catch(() => {});
    return;
  }

  // De-dupe the occasional duplicate delivery — update_ids are per-bot, so the
  // key is namespaced by persona.
  const seenKey = `${personaId}:${update.update_id}`;
  const ins = await query(
    'INSERT INTO tg_seen (seen_key, seen_at) VALUES ($1, $2) ON CONFLICT (seen_key) DO NOTHING',
    [seenKey, Date.now()],
  ).catch(() => ({ rowCount: 1 }));
  if (!ins.rowCount) return;

  const chatId = msg.chat.id;
  const deliver = (t) => bot.sendMessage(chatId, t).catch((e) => console.error(`tg ${personaId} send:`, e.message));

  const voice = msg.voice || msg.audio || msg.video_note;
  let text = typeof msg.text === 'string' ? msg.text.trim() : '';
  let spokenInput = false;
  if (voice) {
    await bot.sendChatAction(chatId, 'typing');
    try {
      text = await transcribe(await bot.downloadFile(voice.file_id), 'voice.ogg');
      spokenInput = true;
    } catch (e) {
      await deliver(`Couldn't make out that voice note: ${e.message}`);
      return;
    }
    if (!text) { await deliver("That came through silent — say again?"); return; }
  }
  if (!text) return;

  if (text === '/start' || text === '/help') {
    await deliver(GREETINGS[personaId] || `${(ROSTER[personaId] || {}).name || personaId} here, Mr. Burrus — on Telegram now. Type or send a voice note.`);
    return;
  }

  await bot.sendChatAction(chatId, spokenInput ? 'record_voice' : 'typing');
  const keepTyping = setInterval(() => bot.sendChatAction(chatId, spokenInput ? 'record_voice' : 'typing').catch(() => {}), 6000);
  try {
    const { text: reply } = await runPersonaTurn(personaId, text, deliver);
    if (spokenInput) {
      const ogg = await synthesizePersonaVoice(personaId, reply, { userText: text });
      if (ogg) await bot.sendVoice(chatId, ogg).catch((e) => console.error(`tg ${personaId} sendVoice:`, e.message));
    }
    await deliver(reply);
  } catch (e) {
    console.error(`${personaId} turn failed:`, e.message);
    await deliver(`Something went wrong on my end: ${e.message}`);
  } finally {
    clearInterval(keepTyping);
  }
}

r.post('/set-webhook', auth, express.json(), async (req, res) => {
  const base = (req.body && req.body.url) || process.env.PUBLIC_URL;
  if (!base) return res.status(400).json({ error: 'pass { "url": "https://…" } or set PUBLIC_URL' });
  try { res.json({ registered: await tg.setWebhook(base) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

r.get('/info', auth, async (req, res) => {
  const out = {};
  for (const bot of tg.configuredBots()) {
    out[bot.personaId] = {
      me: await bot.getMe().catch((e) => ({ error: e.message })),
      webhook: await bot.getWebhookInfo().catch((e) => ({ error: e.message })),
    };
  }
  res.json({ owner_id_set: !!tg.OWNER_ID, bots: out });
});

module.exports = r;
