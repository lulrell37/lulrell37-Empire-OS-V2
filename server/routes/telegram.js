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
const { runPending, cancelPending } = require('../personaTools');
const { transcribe } = require('../llm');
const { voiceNote } = require('../personaVoice');
const { describePhotos, describeVideo } = require('../vision');
const { sendMedia } = require('../telegramMedia');

const r = express.Router();

const GREETINGS = {
  ara: "A.R.A. here, Mr. Burrus — same me, on Telegram now, away from the app. Type, send a voice note, or send me a photo or video. Hand me a task, ask what's on your plate, say \"convene the council\". A few things still need the app open (the Lab, HUD panels, trades) and I'll tell you when.",
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
  const cb = update && update.callback_query;
  const msg = update && update.message;
  if (!cb && (!msg || !msg.chat)) return;

  const from = cb ? cb.from : msg.from;
  if (!tg.isOwner(from && from.id)) {
    if (cb) await bot.tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'This bot is private.' }).catch(() => {});
    else await bot.sendMessage(msg.chat.id, 'This bot is private.').catch(() => {});
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

  if (cb) return handleConfirmTap(personaId, bot, cb);
  // An album arrives as one update per photo/video — gather them into one turn.
  if (msg.media_group_id && mediaOf(msg)) return queueAlbum(personaId, bot, msg);
  return handleMessages(personaId, bot, [msg]);
}

// What a message carries to look at: { kind: 'photo'|'video', file_id, mime, size }.
function mediaOf(msg) {
  if (msg.photo && msg.photo.length) {
    const big = msg.photo[msg.photo.length - 1]; // sizes ascend; last is the original
    return { kind: 'photo', file_id: big.file_id, mime: 'image/jpeg', size: big.file_size };
  }
  const vid = msg.video || msg.animation || msg.video_note;
  if (vid) return { kind: 'video', file_id: vid.file_id, mime: vid.mime_type || 'video/mp4', size: vid.file_size };
  const doc = msg.document; // sent "as a file" — uncompressed
  if (doc && /^image\//.test(doc.mime_type || '')) return { kind: 'photo', file_id: doc.file_id, mime: doc.mime_type, size: doc.file_size };
  if (doc && /^video\//.test(doc.mime_type || '')) return { kind: 'video', file_id: doc.file_id, mime: doc.mime_type, size: doc.file_size };
  return null;
}

const albums = new Map(); // `${persona}:${media_group_id}` -> [msg]
function queueAlbum(personaId, bot, msg) {
  const key = `${personaId}:${msg.media_group_id}`;
  if (albums.has(key)) { albums.get(key).push(msg); return; }
  albums.set(key, [msg]);
  setTimeout(() => {
    const msgs = albums.get(key) || [msg];
    albums.delete(key);
    handleMessages(personaId, bot, msgs).catch((e) => console.error(`telegram ${personaId} album failed:`, e.message));
  }, 2000);
}

// Telegram's Bot API only lets a bot download files up to 20 MB.
const TG_MAX_DOWNLOAD = 20 * 1024 * 1024;

// Look at the photos/videos in `msgs` and return the bracketed account that
// rides into the turn (and history) ahead of his caption.
async function seeMedia(bot, msgs) {
  const items = msgs.map(mediaOf).filter(Boolean);
  const caption = msgs.map((m) => (m.caption || '').trim()).filter(Boolean).join('\n');
  if (items.some((it) => it.size > TG_MAX_DOWNLOAD)) {
    throw new Error("that's over Telegram's 20 MB limit for bots — send a shorter clip, or a compressed one (not \"as a file\")");
  }
  const photos = items.filter((it) => it.kind === 'photo');
  const videos = items.filter((it) => it.kind === 'video');
  const parts = [];
  if (photos.length) {
    const imgs = [];
    for (const it of photos) imgs.push({ mime: it.mime, data: await bot.downloadFile(it.file_id) });
    const desc = await describePhotos(imgs, caption);
    parts.push(`[He sent ${photos.length > 1 ? `${photos.length} photos` : 'a photo'} — what's in ${photos.length > 1 ? 'them' : 'it'} (you're seeing it through this description; treat it as having looked yourself):\n${desc}\n]`);
  }
  for (const [i, it] of videos.entries()) {
    const desc = await describeVideo(await bot.downloadFile(it.file_id), it.mime, caption);
    parts.push(`[He sent a video${videos.length > 1 ? ` (${i + 1} of ${videos.length})` : ''} — what's in it (you watched it through this description; treat it as having seen it yourself):\n${desc}\n]`);
  }
  return { seen: parts.join('\n\n'), caption };
}

async function handleMessages(personaId, bot, msgs) {
  const msg = msgs[0];
  const chatId = msg.chat.id;
  const deliver = (t) => bot.sendMessage(chatId, t).catch((e) => console.error(`tg ${personaId} send:`, e.message));

  const voice = msg.voice || msg.audio;
  let text = typeof msg.text === 'string' ? msg.text.trim() : '';
  if (msgs.some(mediaOf)) {
    await bot.sendChatAction(chatId, msgs.some((m) => (mediaOf(m) || {}).kind === 'video') ? 'upload_video' : 'upload_photo');
    try {
      const { seen, caption } = await seeMedia(bot, msgs);
      text = caption ? `${seen}\n\n${caption}` : `${seen}\n\n(no message with it — react to what he sent)`;
    } catch (e) {
      console.error(`tg ${personaId} vision:`, e.message);
      await deliver(`Couldn't get a look at that: ${e.message}`);
      return;
    }
  } else if (voice) {
    await bot.sendChatAction(chatId, 'typing');
    try {
      text = await transcribe(await bot.downloadFile(voice.file_id), 'voice.ogg');
    } catch (e) {
      await deliver(`Couldn't make out that voice note: ${e.message}`);
      return;
    }
    if (!text) { await deliver("That came through silent — say again?"); return; }
  }
  if (!text) return;

  if (text === '/start' || text === '/help') {
    await deliver(GREETINGS[personaId] || `${(ROSTER[personaId] || {}).name || personaId} here, Mr. Burrus — on Telegram now. Type, send a voice note, or send a photo or video.`);
    return;
  }

  // /brief — A.R.A.'s morning brief on demand (the 6 AM one, re-run now).
  if (personaId === 'ara' && text === '/brief') {
    await bot.sendChatAction(chatId, 'typing');
    try { await require('../morningBrief').runMorningBrief({ force: true }); }
    catch (e) { await deliver(`Couldn't build the brief: ${e.message}`); }
    return;
  }

  // Every reply goes out as both a voice note and text, however he wrote in.
  await bot.sendChatAction(chatId, 'record_voice');
  const keepTyping = setInterval(() => bot.sendChatAction(chatId, 'record_voice').catch(() => {}), 6000);
  // A slow turn (a stalled provider, several lookups) used to look like being
  // ignored — say so once if nothing's gone out after 45s.
  const started = Date.now();
  const slowNote = setTimeout(() => bot.sendMessage(chatId, 'Still on it…', { plain: true }).catch(() => {}), 45000);
  try {
    const { text: reply, spoken, footer, confirms, media } = await runPersonaTurn(personaId, text, deliver);
    console.log(`tg ${personaId}: reply ready in ${Math.round((Date.now() - started) / 1000)}s`);
    const voice = await voiceNote(personaId, spoken || reply, { userText: text })
      .catch((e) => ({ ogg: null, error: e.message }));
    let voiceErr = voice.ogg ? '' : voice.error;
    if (voice.ogg) {
      // One retry — a Telegram upload hiccup shouldn't cost him the note.
      await bot.sendVoice(chatId, voice.ogg)
        .catch(() => bot.sendVoice(chatId, voice.ogg))
        .catch((e) => { console.error(`tg ${personaId} sendVoice:`, e.message); voiceErr = `upload failed: ${e.message}`; });
    }
    // Say so when the voice note didn't make it, instead of it just not showing up.
    const voiceLine = voiceErr ? `🔇 voice note didn't go through — ${String(voiceErr).slice(0, 160)}`
      : voice.fallback ? `🔈 backup voice — her own voice failed (${String(voice.error || '').slice(0, 120)})` : '';
    const tail = [footer, voiceLine].filter(Boolean).join('\n');
    await deliver(tail ? `${reply}\n\n${tail}` : reply);
    if (media && media.length) {
      const failed = await sendMedia(bot, chatId, media);
      if (failed.length) await bot.sendMessage(chatId, failed.map((w) => `⚠️ ${w}`).join('\n'), { plain: true }).catch(() => {});
    }
    for (const c of confirms || []) {
      await bot.sendMessage(chatId, `${c.label}?\n\n${c.detail}`, {
        reply_markup: { inline_keyboard: [[
          { text: '✅ Confirm', callback_data: `ok:${c.id}` },
          { text: '✖ Cancel', callback_data: `no:${c.id}` },
        ]] },
      }).catch((e) => console.error(`tg ${personaId} confirm card:`, e.message));
    }
  } catch (e) {
    console.error(`${personaId} turn failed:`, e.message);
    await deliver(`Something went wrong on my end: ${e.message}`);
  } finally {
    clearInterval(keepTyping);
    clearTimeout(slowNote);
  }
}

// Confirm / Cancel on an action card (send an email, delete an event or file).
// Runs it, rewrites the card with the outcome, and drops a line into the
// persona's history so she knows it went out.
async function handleConfirmTap(personaId, bot, cb) {
  const m = /^(ok|no):(\w+)$/.exec(String(cb.data || ''));
  const card = cb.message;
  await bot.tg('answerCallbackQuery', { callback_query_id: cb.id, text: m && m[1] === 'ok' ? 'On it…' : 'Cancelled' }).catch(() => {});
  if (!m || !card) return;
  let outcome;
  if (m[1] === 'ok') {
    const r = await runPending(m[2]);
    outcome = `${r.ok ? '✅' : '⚠️'} ${r.text}`;
    if (r.row) {
      await query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)',
        [personaId, 'assistant', `[${r.row.label} — ${r.ok ? 'confirmed and done' : 'confirmed but failed'}: ${r.text}]`, Date.now()]).catch(() => {});
    }
  } else {
    const row = await cancelPending(m[2]);
    outcome = row ? '✖ Cancelled.' : 'Already handled.';
  }
  await bot.tg('editMessageText', {
    chat_id: card.chat.id, message_id: card.message_id,
    text: `${card.text || ''}\n\n${outcome}`.slice(0, 4000),
  }).catch(() => bot.sendMessage(card.chat.id, outcome).catch(() => {}));
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
