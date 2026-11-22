// Nothing dies in silence (owner's standing rule, "How Mr. Burrus Works",
// 2026-11-22: "if anything dies, A.R.A. tells me"). The last resort for code whose
// own message to him failed: A.R.A.'s bot as plain text (no voice — that's often
// what broke), and if Telegram itself is down, a phone push. Never throws.
// Repeats of the same `key` within 30 min are dropped, so a stuck loop can't spam.
const recent = new Map();

async function tellAra(key, text) {
  const now = Date.now();
  if (recent.has(key) && now - recent.get(key) < 30 * 60e3) return;
  recent.set(key, now);
  console.warn(`loud: ${String(text).split('\n')[0].slice(0, 200)}`);
  try {
    const tg = require('./telegram');
    const bot = tg.botFor('ara');
    if (bot && bot.isConfigured() && tg.OWNER_ID) { await bot.sendMessage(tg.OWNER_ID, `⚠️ ${text}`); return; }
  } catch { /* fall through to the push */ }
  try { await require('./pushSender').pushAlert(`loud:${key}:${now}`, 'A.R.A. — something stopped', String(text).slice(0, 180), { kind: 'loud' }); }
  catch (e) { console.error(`loud failed: couldn't reach him at all: ${e.message}`); }
}

module.exports = { tellAra };
