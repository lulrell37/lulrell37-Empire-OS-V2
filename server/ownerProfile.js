// "Learns you": a running profile of how Mr. Burrus works — his preferences,
// corrections, standing decisions and style — learned from his conversations with
// every persona and put into the prompts (server and app), so a correction he makes
// once sticks for the whole team (owner's request, 2026-11-20). Each line is tagged
// [all] or with the persona(s) it's for; each persona gets the [all] lines and its
// own (A.R.A. and J.A.R.V.I.S. get every line), and nothing rotates out (2026-11-22).
// Every 6 h (:45) one Claude call reads the last ~day of conversation (the same
// window as the open threads) and the current profile, and returns the updated
// profile; it's kept in app_settings.owner_profile (synced, so the app reads it
// too) and mirrored to the Drive note "How Mr. Burrus Works" for him to read or
// edit. OWNER_PROFILE=off stops it. node server/scripts/test-owner-profile.js.
const { getSetting, setSetting } = require('./syncStore');
const { claudeText } = require('./llm');

const KEY = 'owner_profile';
const NOTE = 'How Mr. Burrus Works';
// No rotation and no cap: a line leaves only when the model names it under
// REMOVED: (contradicted, finished, rewritten), so nothing is ever pushed out
// (owner's call, 2026-11-22). Past 150 lines the sentinel tells him to tidy it.
// His standing orders that must never drop out, whatever the model returns:
const PINNED = [
  '- [all] Nothing we build may shut down, stop or break quietly: if anything is failing or about to, A.R.A. tells him automatically, without being asked (2026-11-22)',
  '- [all] Anything a job needs that his email or notes hold (a code, a link, an account email, a login) comes from A.R.A. first; a persona comes to him only when it absolutely has to (2026-11-22)',
  '- [all] J.A.R.V.I.S.\'s workers are him: everything about them, their questions included, comes from J.A.R.V.I.S.\'s bot, so it reads as him doing all the work (this replaces routing worker sign-in questions through A.R.A.) (2026-11-22)',
  '- [all] The Empire works in unison: when a topic touches another persona\'s lane, that persona does its part automatically without him naming them, and each chains the next step (a new business or channel: S.A.G.E. researches what it earns, A.T.L.A.S. adds it to the business list with targets); anything that sends, posts, buys, deletes or trades still needs his OK (2026-11-23)',
];
// These see every line: A.R.A. runs the team and J.A.R.V.I.S. builds for all of it.
// Mirrored in src/services/aiService.js (profileFor).
const SEES_ALL = new Set(['ara', 'jarvis']);

function enabled() { return String(process.env.OWNER_PROFILE || '').toLowerCase() !== 'off'; }

const ids = () => Object.keys(require('./personas').ROSTER);

const system = () => `You keep the profile of how Mr. Burrus works, so a team of AI personas can serve him the way he wants without him repeating himself. You get the current profile and his latest conversations with the team. Today is ${new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}.

Return the full updated profile, one line each, every line starting "- [who] ", where who is "all" or the persona id(s) the line is for, comma-separated. Use "all" only for what every persona needs: his name, how he likes to be talked to, how he wants work done and reported, team-wide rules. A line about one desk's job goes to that desk alone (a trading rule → talon, a money report → atlas, a clip or editing rule → rogue, an app, server or build rule → jarvis, a calendar or notification rule → ara). Persona ids: ${ids().join(', ')}. Who owns what: ${require('./personas').ARA_ROUTE}.

Only include what HE said or clearly showed (a correction, an instruction, a decision, a repeated frustration, a choice between options) — never guesses about him, never one-off task details, never anything the personas said about themselves. Keep each line short, concrete and in plain words, dated (YYYY-MM-DD, the day he said it) when it's a decision. There is no length limit: never drop a line to make room. Keep every line that still holds, word for word. A line goes only when he contradicts it, it's finished, or you rewrite or merge it — and then add "REMOVED: <the old line exactly>" at the end for each one, or it stays. If nothing changes, return the current profile unchanged. No preamble, only the lines.`;

// A line's text without its "- [who]" prefix, for matching.
const body = (l) => String(l).replace(/^-\s+(\[[^\]]*\]\s*)?/, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Clean one line to "- [who] text": who checked against the roster (untagged or
// unknown → all), and the 2024 dates the old prompt produced put right.
function cleanLine(l, known = ids()) {
  const m = /^-\s+(?:\[([^\]]*)\]\s*)?(\S.*)$/.exec(String(l).trim());
  if (!m) return '';
  const who = String(m[1] || 'all').toLowerCase().split(/[\s,]+/).map((w) => w.replace(/\./g, '')).filter((w) => w === 'all' || known.includes(w));
  const tag = who.length && !who.includes('all') ? [...new Set(who)].join(', ') : 'all';
  // The profile began 2026-11-20, so no decision in it is older than 2026.
  const text = m[2].replace(/\b20(1\d|2[0-5])-(\d\d-\d\d)\b/g, '2026-$2');
  return `- [${tag}] ${text}`;
}

// The model's output, plus every line of `prev` it left out without a REMOVED:.
function normalize(raw, prev = '') {
  const lines = String(raw || '').split('\n').map((l) => l.trim());
  const removed = new Set(lines.filter((l) => /^REMOVED:/i.test(l)).map((l) => body(l.replace(/^REMOVED:\s*/i, ''))));
  const out = []; const seen = new Set();
  const add = (l) => { const c = cleanLine(l); const b = c && body(c); if (b && !seen.has(b) && !removed.has(b)) { seen.add(b); out.push(c); } };
  PINNED.forEach((l) => { const b = body(l); if (!seen.has(b)) { seen.add(b); out.push(l); } });
  lines.filter((l) => /^-\s+\S/.test(l)).forEach(add);
  String(prev || '').split('\n').map((l) => l.trim()).filter((l) => /^-\s+\S/.test(l)).forEach(add);
  return out.join('\n');
}

// The lines persona `id` gets: the [all] ones and its own (every line for SEES_ALL).
function linesFor(profile, id) {
  const all = String(profile || '').split('\n').map((l) => l.trim()).filter((l) => /^-\s+\S/.test(l));
  if (!id || SEES_ALL.has(id)) return all.join('\n');
  return all.filter((l) => {
    const m = /^-\s+\[([^\]]*)\]/.exec(l);
    if (!m) return true;
    const who = m[1].toLowerCase().split(/[\s,]+/);
    return who.includes('all') || who.includes(id);
  }).map((l) => l.replace(/^-\s+\[[^\]]*\]\s*/, '- ')).join('\n');
}

async function current() { return String((await getSetting(KEY, '')) || '').trim(); }

async function tick({ force = false } = {}) {
  if (!enabled()) return { skipped: 'off' };
  const last = Number(await getSetting('owner_profile_last', '0')) || 0;
  const convo = await require('./openThreads').recentLines(Date.now() - 26 * 3600e3);
  if (!convo.count) return { skipped: 'no conversation' };
  if (!force && convo.newest <= last) return { skipped: 'nothing new' };
  const now = await current();
  const raw = await claudeText(system(), `CURRENT PROFILE:\n${now || '(empty)'}\n\nHIS LATEST CONVERSATIONS (oldest first):\n${convo.text}`, { maxTokens: 6000 });
  // An empty answer is a failed call, not "delete everything".
  if (!String(raw || '').trim()) return { unchanged: true };
  const next = normalize(raw, now);
  await setSetting('owner_profile_last', String(convo.newest));
  if (!next || next === now) return { unchanged: true };
  await setSetting(KEY, next);
  const g = require('./google');
  if (await g.googleLinked().catch(() => false)) {
    await g.saveDriveNote(NOTE, `# ${NOTE}\n_What the team has learned about how you like things done. Lines marked [all] go to every persona; the rest go only to the persona(s) named (A.R.A. and J.A.R.V.I.S. see every line). Nothing rotates out. Updated ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET. Edit or delete any line by telling J.A.R.V.I.S. or A.R.A._\n\n${next}\n`).catch(() => {});
  }
  return { saved: true, items: next.split('\n').length };
}

// The block persona `id`'s prompt carries.
async function profileBlock(id) {
  const p = linesFor(normalize('', await current().catch(() => '')), id);
  return p ? `[HOW MR. BURRUS WORKS — learned from his conversations with the whole team; follow it without being told again. If he contradicts a line, he wins and the profile updates:\n${p}\n]` : '';
}

module.exports = { PINNED, tick, profileBlock, normalize, linesFor, cleanLine, current, NOTE, KEY, enabled, SEES_ALL };
