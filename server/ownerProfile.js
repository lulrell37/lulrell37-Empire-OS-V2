// "Learns you": a running profile of how Mr. Burrus works — his preferences,
// corrections, standing decisions and style — learned from his conversations with
// every persona and put into every persona's prompt (server and app), so a
// correction he makes once sticks for the whole team (owner's request, 2026-11-20).
// Every 6 h (:45) one Claude call reads the last ~day of conversation (the same
// window as the open threads) and the current profile, and returns the updated
// profile; it's kept in app_settings.owner_profile (synced, so the app reads it
// too) and mirrored to the Drive note "How Mr. Burrus Works" for him to read or
// edit. OWNER_PROFILE=off stops it. node server/scripts/test-owner-profile.js.
const { getSetting, setSetting } = require('./syncStore');
const { claudeText } = require('./llm');

const KEY = 'owner_profile';
const NOTE = 'How Mr. Burrus Works';
const MAX_ITEMS = 35;

function enabled() { return String(process.env.OWNER_PROFILE || '').toLowerCase() !== 'off'; }

const SYSTEM = `You keep the profile of how Mr. Burrus works, so a team of AI personas can serve him the way he wants without him repeating himself. You get the current profile and his latest conversations with the team.

Return the full updated profile: up to ${MAX_ITEMS} lines, each starting "- ", grouped loosely as preferences, standing decisions, corrections he has made, and how he likes things communicated. Only include what HE said or clearly showed (a correction, an instruction, a decision, a repeated frustration, a choice between options) — never guesses about him, never one-off task details, never anything the personas said about themselves. Keep each line short, concrete and in plain words, dated (YYYY-MM-DD) when it's a decision. When a newer statement contradicts an older line, replace the old one. Keep lines that still hold. If nothing in the conversation changes the profile, return the current profile unchanged. No preamble, only the lines.`;

function normalize(raw) {
  return String(raw || '').split('\n').map((l) => l.trim()).filter((l) => /^-\s+\S/.test(l)).slice(0, MAX_ITEMS).join('\n');
}

async function current() { return String((await getSetting(KEY, '')) || '').trim(); }

async function tick({ force = false } = {}) {
  if (!enabled()) return { skipped: 'off' };
  const last = Number(await getSetting('owner_profile_last', '0')) || 0;
  const convo = await require('./openThreads').recentLines(Date.now() - 26 * 3600e3);
  if (!convo.count) return { skipped: 'no conversation' };
  if (!force && convo.newest <= last) return { skipped: 'nothing new' };
  const now = await current();
  const next = normalize(await claudeText(SYSTEM, `CURRENT PROFILE:\n${now || '(empty)'}\n\nHIS LATEST CONVERSATIONS (oldest first):\n${convo.text}`, { maxTokens: 1600 }));
  await setSetting('owner_profile_last', String(convo.newest));
  if (!next || next === now) return { unchanged: true };
  await setSetting(KEY, next);
  const g = require('./google');
  if (await g.googleLinked().catch(() => false)) {
    await g.saveDriveNote(NOTE, `# ${NOTE}\n_What the team has learned about how you like things done — every persona reads this. Updated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET. Edit or delete any line by telling J.A.R.V.I.S. or A.R.A._\n\n${next}\n`).catch(() => {});
  }
  return { saved: true, items: next.split('\n').length };
}

// The block every persona prompt carries.
async function profileBlock() {
  const p = await current().catch(() => '');
  return p ? `[HOW MR. BURRUS WORKS — learned from his conversations with the whole team; follow it without being told again. If he contradicts a line, he wins and the profile updates:\n${p}\n]` : '';
}

module.exports = { tick, profileBlock, normalize, current, NOTE, KEY, enabled };
