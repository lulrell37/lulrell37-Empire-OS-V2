// A.I.S.H.A. breaks down the politics in W.I.R.E.'s news (owner, 2026-11-26: "let's
// have Aisha break down the political stuff that happens in the wire brief. It should
// be easy to understand what's going on and have her pass to Ara").
//
// Every W.I.R.E. brief (onWireBrief, like H.A.V.E.N. and W.O.K.E.) gets one Claude call
// as A.I.S.H.A., the Empire's legal counsel: each political story (Congress, the White
// House, the courts, elections, new laws and rules, Maryland / DC / Virginia
// government, foreign policy) in plain English — what happened, why it's happening,
// who's on each side and what they want, what happens next, and what it means for him.
// Neutral: both sides' case, no cheering. NOTHING stays quiet. Otherwise it goes to him
// from A.R.A.'s bot as "⚖️ A.I.S.H.A. → A.R.A.", and into both their memories and
// A.I.S.H.A.'s own chat history (sendFromAra's `from`), so he can pick it up with her
// one on one. app_settings.aisha_politics_seen stops repeats. AISHA_POLITICS=off, or
// the spoken switch aisha_politics. node server/scripts/test-news-desks.js.
const { getSetting, setSetting, saveMemory } = require('./syncStore');
const { parse } = require('./havenHealth');

const SEEN_MAX = 80;
let busy = false;

const enabled = () => process.env.AISHA_POLITICS !== 'off';
const fp = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);

const SYSTEM = `You are A.I.S.H.A., Mr. Burrus's legal counsel. He lives in Waldorf, MD (the DC area) and runs his own businesses. You read W.I.R.E.'s news brief and break down the POLITICAL stories so they're easy to understand: Congress, the White House, the courts and rulings, elections, new laws, rules and executive orders, taxes and budgets, Maryland / DC / Virginia government, foreign policy and wars. Markets, crime, weather, sports and celebrity news are NOT politics unless a government decision is the story.

If nothing qualifies, reply with exactly: NOTHING

Otherwise reply in this shape:
STORIES: one line per story, each its own short key (e.g. "Senate shutdown vote")
---
For each story, plain English, like explaining it to a smart friend who hasn't followed it:
**<the story in a few words>**
- What happened: one or two sentences.
- Why: what's behind it, the background he needs.
- The sides: who wants what, each side's real argument in a sentence, fairly. No cheering for either side.
- What's next: the next vote, deadline, ruling or step, with the date if the brief has it.
- What it means for you: his taxes, his businesses, Maryland, the DMV, prices — or "not much directly" if that's the truth.
Explain any legal or political term the first time you use it. Under 300 words total. Only what's in the brief; don't invent numbers, dates or quotes.`;

async function seen() {
  try { const a = JSON.parse(await getSetting('aisha_politics_seen', '[]')); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function onWireBrief(brief, { ask = null, send = null } = {}) {
  if (!enabled() || busy) return { skipped: true };
  busy = true;
  try {
    const before = await seen();
    const call = ask || ((sys, prompt) => require('./llm').claudeText(sys, [{ role: 'user', content: prompt }], { maxTokens: 900 }));
    const out = await call(SYSTEM, `W.I.R.E.'S BRIEF:\n${String(brief).slice(0, 6000)}\n\nAlready broken down for him (leave out unless there's a real new development): ${before.slice(0, 30).join(' | ') || 'nothing yet'}`);
    const got = parse(out);
    if (!got) return { quiet: true };
    const fresh = got.stories.filter((s) => !before.includes(fp(s)));
    if (got.stories.length && !fresh.length) return { quiet: true, repeat: true };
    const text = `⚖️ **A.I.S.H.A. → A.R.A. — the politics, made simple**, Mr. Burrus.\n\n${got.body}`;
    // A.R.A. voices the whole breakdown like W.I.R.E.'s brief (owner, 2026-11-27: "she
    // kinda just says here it is. it should be like the others"): her script pass gets
    // the full text, sees it's A.I.S.H.A.'s, and catches him up on every story in her own
    // words ("Aisha says…"), the numbers and names checked in code. The text is the same.
    const spoken = text;
    const deliver = send || ((t, s) => require('./talonAlerts').sendFromAra(t, s, { from: 'aisha' }));
    await deliver(text, spoken);
    await setSetting('aisha_politics_seen', JSON.stringify([...new Set([...got.stories.map(fp), ...before])].slice(0, SEEN_MAX))).catch(() => {});
    await saveMemory('aisha', `[your breakdown of the politics in W.I.R.E.'s news, sent to him through A.R.A.] ${got.body}`.slice(0, 4000)).catch(() => {});
    await saveMemory('ara', `[A.I.S.H.A.'s breakdown of the politics in the news (her words, relayed to Mr. Burrus)] ${got.body}`.slice(0, 4000)).catch(() => {});
    return { sent: true, stories: got.stories };
  } catch (e) {
    console.error(`aisha politics failed: ${e.message}`);
    return { error: e.message };
  } finally {
    busy = false;
  }
}

module.exports = { onWireBrief, SYSTEM, enabled };
