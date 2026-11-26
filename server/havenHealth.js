// H.A.V.E.N. reads W.I.R.E.'s news for his health (owner, 2026-11-26: "I also want
// haven to look at wires news for health related things and pass to ara").
//
// Every W.I.R.E. brief (onWireBrief, like W.O.K.E. and A.T.L.A.S.) gets one Claude
// call as H.A.V.E.N.: only stories that touch his health or his family's (outbreaks,
// recalls, food/drug/water safety, air quality, heat or cold, health policy or
// insurance that affects him, anything local to the DMV first). NOTHING stays quiet.
// Otherwise her short take goes to him from A.R.A.'s bot, labeled as H.A.V.E.N.'s,
// and into both personas' memory. app_settings.haven_health_seen stops repeats.
// HAVEN_HEALTH=off stops it. node server/scripts/test-haven-health.js.
const { getSetting, setSetting, saveMemory } = require('./syncStore');

const NOTHING = /^\s*NOTHING\b/i;
const SEEN_MAX = 80;
let busy = false;

const enabled = () => process.env.HAVEN_HEALTH !== 'off';
const fp = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);

const SYSTEM = `You are H.A.V.E.N., Mr. Burrus's health and wellness persona. He lives in Waldorf, MD (the DC area). You read W.I.R.E.'s news brief for anything that touches his health or his family's: disease outbreaks, food / drug / product recalls, water or food safety, air quality, extreme heat or cold, a health risk in the DMV, a new study that changes advice he'd follow, health policy, insurance or drug-price changes that affect him. Politics, crime, markets and celebrity news are NOT health unless they carry a direct health risk to him.

If nothing qualifies, reply with exactly: NOTHING

Otherwise reply in this shape, short and plain:
STORIES: one line per story you're flagging, each its own key (e.g. "Salmonella recall — Costco chicken")
---
For each: what it is, whether it touches him (local? something he'd buy or do?), and the one thing to do about it. Under 120 words total. Only what's in the brief; don't invent numbers.`;

function parse(out) {
  const raw = String(out || '').trim();
  if (!raw || NOTHING.test(raw)) return null;
  const cut = raw.indexOf('---');
  const head = cut >= 0 ? raw.slice(0, cut) : '';
  const body = (cut >= 0 ? raw.slice(cut + 3) : raw).trim();
  const stories = head.replace(/^\s*STORIES:\s*/i, '').split('\n').map((l) => l.replace(/^[-•*\d.\s]+/, '').trim()).filter(Boolean);
  return body ? { stories, body } : null;
}

async function seen() {
  try { const a = JSON.parse(await getSetting('haven_health_seen', '[]')); return Array.isArray(a) ? a : []; } catch { return []; }
}

async function onWireBrief(brief, { ask = null, send = null } = {}) {
  if (!enabled() || busy) return { skipped: true };
  busy = true;
  try {
    const before = await seen();
    const call = ask || ((sys, prompt) => require('./llm').claudeText(sys, [{ role: 'user', content: prompt }], { maxTokens: 500 }));
    const out = await call(SYSTEM, `W.I.R.E.'S BRIEF:\n${String(brief).slice(0, 6000)}\n\nAlready flagged to him (leave out unless there's a real new development): ${before.slice(0, 30).join(' | ') || 'nothing yet'}`);
    const got = parse(out);
    if (!got) return { quiet: true };
    const fresh = got.stories.filter((s) => !before.includes(fp(s)));
    if (got.stories.length && !fresh.length) return { quiet: true, repeat: true };
    const text = `🩺 **H.A.V.E.N. → A.R.A. — health in the news**, Mr. Burrus.\n\n${got.body}`;
    const spoken = `Haven flagged something health-wise in the news. ${got.body.split(/(?<=[.!?])\s/)[0] || ''}`;
    const deliver = send || ((t, s) => require('./talonAlerts').sendFromAra(t, s));
    await deliver(text, spoken);
    await setSetting('haven_health_seen', JSON.stringify([...new Set([...got.stories.map(fp), ...before])].slice(0, SEEN_MAX))).catch(() => {});
    await saveMemory('haven', `[your health read of W.I.R.E.'s news, sent to him through A.R.A.] ${got.body}`.slice(0, 3000)).catch(() => {});
    await saveMemory('ara', `[H.A.V.E.N.'s health read of the news (her words, relayed to Mr. Burrus)] ${got.body}`.slice(0, 3000)).catch(() => {});
    return { sent: true, stories: got.stories };
  } catch (e) {
    console.error(`haven health failed: ${e.message}`);
    return { error: e.message };
  } finally {
    busy = false;
  }
}

module.exports = { onWireBrief, parse, SYSTEM, enabled };
