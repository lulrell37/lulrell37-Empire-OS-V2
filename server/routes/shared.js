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

const SHARED = new Set(['SWITCH_OFF', 'SWITCH_ON', 'SWITCHES', 'TRADING_OFF', 'TRADING_ON', 'TRADING_STATUS', 'BREAKING_NOW', 'NEWS_NOW', 'QUIZ_SCORE', 'QUIZ_OFF', 'QUIZ_ON', 'QUIZ_NOW']);
const FOLLOW_RULES = '[FOLLOW-THROUGH (his rules, 2026-11-26): if you say you\'ll check something, check it in this reply and give him the answer — never leave him to ask again. And never ask him for something the team has or can get (A.R.A.: email, calendar, notes, codes, links; S.E.L.E.N.E.: designs; S.C.R.I.B.E.: copy; J.A.R.V.I.S.: code, logins): get it with [RELAY_TO] and carry on. He is asked only for a code texted to his phone, a phone approval, his ID or card, his OK to send / post / buy / delete, or a decision that is his.]';

let deps = null;
const d = () => deps || { runtime: require('../personaRuntime'), ft: require('../followThrough') };

async function context(persona, asked = '') {
  const parts = [];
  const sw = require('../switches');
  const ts = require('../talonSwitch');
  if (persona === 'ara' || persona === 'jarvis') parts.push(sw.SWITCH_TOOLS, ts.SWITCH_TOOLS);
  else parts.push(sw.SWITCH_ASK);
  if (persona === 'ara') {
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

const r = express.Router();
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
module.exports.SHARED = SHARED;
module.exports._setDeps = (x) => { deps = x; };
