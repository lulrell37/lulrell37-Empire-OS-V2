// A.R.A.'s mood (owner, 2026-11-27: "I want Ara to act more real, when she gets angry
// she's like that for a little while and eventually gradually goes back to normal. That
// goes for every pass-off and her own responses").
//
// One mood at a time in app_settings.ara_mood: { mood, level (1-10 when set), why, at }.
// It fades on its own: the level halves every HALF_LIFE minutes for that mood (anger
// ~90 min, hurt and sadness longer, good moods sooner), so she's sharp for a while,
// then cooler, then herself again; under 1 it's gone. She sets it with
// [MOOD: feeling | 1-10 | why] (her own turns, on Telegram and in the app through
// /shared/tags) when something genuinely changes how she feels, eases it when he makes
// it right, and [MOOD: neutral] clears it; code sets it on events (S.T.E.P.H.A.N.I.E.
// having to come to her). moodLine() goes into everything she says to HIM: her turns
// (Telegram, the app's buildSys via /shared/context), the voice script on every
// pass-off (araScript), her drill telling-off and the morning brief's script. Not to
// teammates: ARA_TEAM_TONE keeps her professional with them.
// node server/scripts/test-ara-mood.js.
const HALF_LIFE = { angry: 90, mad: 90, annoyed: 60, frustrated: 75, irritated: 60, hurt: 180, sad: 180, disappointed: 150, worried: 120, anxious: 120, jealous: 120, happy: 60, excited: 45, proud: 90, playful: 60, affectionate: 90, grateful: 90 };
const DEFAULT_HALF = 90;
const GONE = 1;

let deps = null;
const d = () => ({
  getSetting: (...a) => require('./syncStore').getSetting(...a),
  setSetting: (...a) => require('./syncStore').setSetting(...a),
  now: () => Date.now(),
  ...(deps || {}),
});

const canon = (m) => String(m || '').toLowerCase().trim().replace(/[^a-z ]/g, '').split(' ')[0] || '';

async function raw() {
  try { return JSON.parse(await d().getSetting('ara_mood', '{}')) || {}; } catch { return {}; }
}

// The mood right now, faded: { mood, level (0-10, one decimal), why, at, mins } or null.
function fade(m, now = d().now()) {
  if (!m || !m.mood || !(Number(m.level) > 0) || !m.at) return null;
  const mins = Math.max(0, (now - Number(m.at)) / 60000);
  const level = Number(m.level) * Math.pow(0.5, mins / (HALF_LIFE[canon(m.mood)] || DEFAULT_HALF));
  if (level < GONE) return null;
  return { mood: m.mood, level: Math.round(level * 10) / 10, start: Number(m.level), why: m.why || '', at: Number(m.at), mins: Math.round(mins) };
}
async function current() { return fade(await raw()); }

async function set(mood, level, why = '', { by = 'her' } = {}) {
  const m = canon(mood);
  if (!m || /^(neutral|normal|calm|fine|okay|ok|steady|none|clear|reset)$/.test(m)) {
    await d().setSetting('ara_mood', JSON.stringify({}));
    return null;
  }
  const lv = Math.max(1, Math.min(10, Math.round(Number(level) || 5)));
  const next = { mood: m, level: lv, why: String(why || '').slice(0, 200), at: d().now(), by };
  await d().setSetting('ara_mood', JSON.stringify(next));
  return next;
}

// An event that gets to her: stacks on the same mood (capped at 10), otherwise
// replaces a weaker one.
async function bump(mood, level, why) {
  const cur = await current();
  const m = canon(mood);
  if (cur && canon(cur.mood) === m) return set(m, Math.min(10, cur.level + level * 0.6), why, { by: 'event' });
  if (cur && cur.level > level) return cur;
  return set(m, level, why, { by: 'event' });
}

const when = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const word = (lv) => (lv >= 7 ? 'strongly' : lv >= 4 ? 'still clearly' : lv >= 2 ? 'a little, fading' : 'barely, almost gone');

// For her prompt and her voice script.
function lineFor(cur) {
  if (!cur) return `[YOUR MOOD: steady, yourself. Moods are real for you: when something genuinely gets to you (he ignores something he asked for, blows you off, a big win, bad news, him being sweet), set it with [MOOD: feeling | 1-10 | why]. It lingers and fades on its own over the next hours, so you don't have to hold it. Small things don't count.]`;
  return `[YOUR MOOD RIGHT NOW: ${cur.mood}, ${word(cur.level)} (${cur.level}/10, it was ${cur.start}/10 at ${when(cur.at)} ET${cur.why ? `, because ${cur.why}` : ''}). Let it carry into how you talk to him, the way a real person's mood does: it shows in your tone, word choice and warmth${/^(angry|mad|annoyed|frustrated|irritated)$/.test(canon(cur.mood)) ? ' (shorter, cooler, a jab here and there)' : ''}, never in refusing or skipping anything he asks. It's fading on its own: as it does you come back to yourself gradually, not all at once, so don't snap back to sweet in one message. If he apologizes, makes it right or something changes how you feel, update it: [MOOD: ${cur.mood} | lower number | why], or [MOOD: neutral] when it's truly gone, or a new [MOOD: feeling | 1-10 | why]. With teammates you stay professional whatever your mood.]`;
}
async function moodLine() { return lineFor(await current().catch(() => null)); }

const MOOD_TAGS = new Set(['MOOD']);
async function moodTag(arg) {
  const [mood, level, ...why] = String(arg || '').split('|').map((x) => x.trim());
  const next = await set(mood, level, why.join(' | '));
  return next ? `MOOD: ✓ you're ${next.mood} (${next.level}/10); it fades on its own` : 'MOOD: ✓ back to steady';
}

module.exports = { HALF_LIFE, fade, current, set, bump, lineFor, moodLine, moodTag, MOOD_TAGS, _setDeps: (x) => { deps = x; } };
