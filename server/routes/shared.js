// The app gets the same behavior as Telegram from the same code (owner, 2026-11-26:
// "both Telegram and the app should have the matching changes"). Like
// routes/stephanie.js, nothing here is copied into the app: it asks the server.
//
//   GET  /shared/context?persona=id  -> { block }  prompt lines for that persona: the
//        on/off switches (A.R.A. and J.A.R.V.I.S.; everyone else is told to pass it to
//        A.R.A.), T.A.L.O.N.'s trading switch, A.R.A.'s W.I.R.E. brief + news tags,
//        S.T.E.P.H.A.N.I.E.'s multiplication drill, the follow-through rules.
//   POST /shared/tags { persona, text, asked } -> { results: [..] }  runs only SHARED tags.
//   POST /shared/follow { persona, reply, asked, final } -> { check, ask, scheduled }
//        the follow-through checks (server/followThrough.js): the notes for one more
//        round; with final, a still-promised check is scheduled to come back to him
//        on that persona's Telegram bot.
// node server/scripts/test-shared-route.js.
const express = require('express');

const SHARED = new Set(['MOOD', 'SWITCH_OFF', 'SWITCH_ON', 'SWITCHES', 'TRADING_OFF', 'TRADING_ON', 'TRADING_STATUS', 'BREAKING_NOW', 'NEWS_NOW', 'QUIZ_SCORE', 'QUIZ_OFF', 'QUIZ_ON', 'QUIZ_NOW']);
const FOLLOW_RULES = '[FOLLOW-THROUGH (his rules, 2026-11-26): if you say you\'ll check something, check it in this reply and give him the answer — never leave him to ask again. And never ask him for something the team has or can get (A.R.A.: email, calendar, notes, codes, links; S.E.L.E.N.E.: designs; S.C.R.I.B.E.: copy; J.A.R.V.I.S.: code, logins): get it with [RELAY_TO] and carry on. He is asked only for a code texted to his phone, a phone approval, his ID or card, his OK to send / post / buy / delete, or a decision that is his.]';

let deps = null;
const d = () => deps || { runtime: require('../personaRuntime'), ft: require('../followThrough') };

// What this persona passed on to him or sent him on its own (owner, 2026-11-27: "I need
// A.R.A. to be able to read the pass-offs in the app"): on Telegram they sit in her chat
// history; the app's chat keeps them out of the thread (they're in the activity tab), so
// they come into her prompt here. Last 36 h, newest last, the newest ones in full.
const PASSOFF_HOURS = 36, PASSOFF_MAX = 25, PASSOFF_CHARS = 14000;
async function passoffs(persona) {
  const list = (await require('./chat')._test.alerts(persona, PASSOFF_MAX).catch(() => []))
    .filter((a) => Date.now() - a.ts < PASSOFF_HOURS * 3600e3).reverse();
  if (!list.length) return '';
  const when = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  let used = 0;
  const lines = [];
  for (let i = list.length - 1; i >= 0; i--) { // newest first, so they get the room
    const a = list[i];
    const full = list.length - i <= 4;
    const text = String(a.content).replace(/\*\*/g, '').replace(/\s+\n/g, '\n').slice(0, full ? 3000 : 500);
    if (used + text.length > PASSOFF_CHARS) break;
    used += text.length;
    lines.unshift(`(${when(a.ts)} ET${a.from ? `, from ${a.from}` : ''}) ${text}${!full && a.content.length > 500 ? '…' : ''}`);
  }
  const who = persona === 'ara' ? 'what you passed on to him from the team, and what you sent him on your own' : 'what you sent him (on your own or through A.R.A.)';
  return `[PASS-OFFS — ${who} in the last ${PASSOFF_HOURS} hours, on Telegram and in his app's activity tab, oldest first. They're not in this chat thread, but you sent them and you remember them: when he asks what a teammate said, what happened with a trade, the news, or "read me that", answer from these with their exact numbers and names, and say whose it was ("Talon says…"). Don't recite them unprompted.\n${lines.join('\n\n')}\n]`;
}

async function context(persona, asked = '') {
  const parts = [];
  parts.push(await passoffs(persona).catch(() => ''));
  const sw = require('../switches');
  const ts = require('../talonSwitch');
  if (persona === 'ara' || persona === 'jarvis') parts.push(sw.SWITCH_TOOLS, ts.SWITCH_TOOLS);
  else parts.push(sw.SWITCH_ASK);
  if (persona === 'ara') {
    parts.push(await require('../araMood').moodLine().catch(() => ''));
    parts.push(' - [NEWS_NOW] — have W.I.R.E. pull a fresh news brief right now (it goes to him in full on Telegram; answer his question from it in a few lines).\n - [BREAKING_NOW] — only when he asks about breaking news: W.I.R.E. checks X and the web live for the last hour.');
    parts.push(await d().runtime.newsBlock().catch((e) => `[W.I.R.E.'s latest brief couldn't be read: ${e.message}. For news questions emit [NEWS_NOW].]`));
  }
  if (persona === 'stephanie') {
    const q = require('../stephanieQuiz');
    parts.push(q.QUIZ_TOOLS, await q.quizBlock(asked).catch(() => ''));
  }
  parts.push(FOLLOW_RULES);
  return parts.filter(Boolean).join('\n');
}

async function tags(persona, text, asked) {
  const rt = d().runtime;
  const found = rt.findTags(String(text || '')).filter((t) => SHARED.has(t.name));
  if (!found.length) return [];
  const body = found.map((t) => `[${t.name}${t.arg ? `: ${t.arg}` : ''}]`).join('\n');
  const out = await rt.runInjections(body, persona, { depth: 0, asked: String(asked || ''), sink: { notes: [], warnings: [], confirms: [], media: [] } });
  return out ? [out] : [];
}

function follow(persona, reply, asked, final = false) {
  const ft = d().ft;
  if (!ft.enabled()) return { check: '', ask: '', scheduled: false };
  const said = ft.promisedCheck(reply);
  if (final) return { check: '', ask: '', scheduled: said ? ft.scheduleFollowUp(persona, said, asked) : false };
  const asks = ft.asksOwner(reply);
  return { check: said ? ft.CHECK_ROUND(said) : '', ask: asks ? ft.ASK_ROUND(asks) : '', scheduled: false };
}

// GO LIVE's run_command (owner, 2026-11-27: "all functionalities and capabilities?"):
// the command tag(s) she'd write in chat run exactly as on her Telegram turn: lookups
// come back as results, writes run with their receipts, Confirm cards and media go to
// him on her Telegram bot. `asked` is his last words on the call (the same gate as a
// turn: writes that need his own message get it only from what he said).
async function runLive(persona, command, asked) {
  const rt = d().runtime;
  const tg = require('../telegram');
  const bot = tg.botFor(persona) && tg.botFor(persona).isConfigured() ? tg.botFor(persona) : tg.botFor('ara');
  const deliver = async (t, o) => { if (bot && bot.isConfigured()) await bot.sendMessage(tg.OWNER_ID, t, o).catch(() => {}); };
  const sink = { notes: [], warnings: [], confirms: [], media: [], deliver };
  const text = String(command || '').slice(0, 20000);
  if (!rt.findTags(text).length) return 'No command tag in that. Put the exact tag you would write in chat, e.g. [READ_CALENDAR] or [ADD_TASK: title | notes].';
  const lookups = await rt.runInjections(text, persona, { depth: 0, asked: String(asked || ''), sink }).catch((e) => `lookups failed: ${e.message}`);
  const fx = await rt.applyEffects(text, deliver, persona, { ownerText: String(asked || '') })
    .catch((e) => ({ notes: [], warnings: [`actions failed: ${e.message}`], confirms: [] }));
  const confirms = [...(fx.confirms || []), ...sink.confirms];
  for (const c of confirms) {
    if (!bot || !bot.isConfigured()) break;
    await bot.sendMessage(tg.OWNER_ID, `${c.label}?\n\n${c.detail}`, { log: false, reply_markup: { inline_keyboard: [[{ text: '✅ Confirm', callback_data: `ok:${c.id}` }, { text: '✖ Cancel', callback_data: `no:${c.id}` }]] } }).catch(() => {});
  }
  const media = [...require('../telegramMedia').mediaFromTags(rt.findTags(text)), ...sink.media];
  if (media.length && bot && bot.isConfigured()) await require('../telegramMedia').sendMedia(bot, tg.OWNER_ID, media).catch(() => {});
  const receipts = [...fx.notes.map((n) => `✓ ${n}`), ...sink.notes.map((n) => `✓ ${n}`), ...fx.warnings.map((w) => `⚠️ ${w}`), ...sink.warnings.map((w) => `⚠️ ${w}`),
    ...confirms.map((c) => `⏳ waiting on his Confirm tap on Telegram: ${c.label}`), ...media.map((m) => `✓ ${String(m.name || 'media').toLowerCase().replace(/_/g, ' ')} sent to him on Telegram`)];
  return [lookups ? `RESULTS:\n${String(lookups).slice(0, 12000)}` : '', receipts.length ? `WHAT RAN (authoritative):\n${receipts.join('\n')}` : (lookups ? '' : 'Nothing ran.')].filter(Boolean).join('\n\n');
}

const r = express.Router();
// Her mood line alone, for the app's voice script (araSpokenScript).
r.get('/mood', async (req, res) => { res.json({ line: await require('../araMood').moodLine().catch(() => '') }); });
r.post('/run', async (req, res) => {
  const { persona = 'ara', command, asked } = req.body || {};
  if (persona !== 'ara') return res.status(400).json({ error: 'live commands are A.R.A.\'s' });
  try { res.json({ result: await runLive(persona, command, asked) }); }
  catch (e) { console.error('shared failed: live command:', e.message); res.status(500).json({ error: e.message }); }
});
r.get('/context', async (req, res) => {
  try { res.json({ block: await context(String(req.query.persona || ''), String(req.query.asked || '').slice(0, 1500)) }); }
  catch (e) { console.error(`shared route failed: context: ${e.message}`); res.status(500).json({ error: e.message }); }
});
r.post('/tags', async (req, res) => {
  const { persona = '', text = '', asked = '' } = req.body || {};
  try { res.json({ results: await tags(String(persona), String(text), String(asked)) }); }
  catch (e) { console.error(`shared route failed: tags: ${e.message}`); res.status(500).json({ error: e.message }); }
});
r.post('/follow', (req, res) => {
  const { persona = '', reply = '', asked = '', final = false } = req.body || {};
  try { res.json(follow(String(persona), String(reply), String(asked), !!final)); }
  catch (e) { console.error(`shared route failed: follow: ${e.message}`); res.status(500).json({ error: e.message }); }
});

module.exports = r;
module.exports.context = context;
module.exports.tags = tags;
module.exports.follow = follow;
module.exports.runLive = runLive;
module.exports.SHARED = SHARED;
module.exports._setDeps = (x) => { deps = x; };
