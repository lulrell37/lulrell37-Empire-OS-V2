// S.T.E.P.H.A.N.I.E.'s multiplication drill (owner, 2026-11-26: "I want stephanie
// to send me 5 multiplication questions every 30 minutes").
//
// Every 30 min, 8 AM-10 PM ET, her own Telegram bot sends him 5 questions. Pure
// code, no AI: a mix from 1-digit × 2-digit up to 2-digit × 2-digit, a little
// harder each set he gets all right, a little easier after a miss. The last set
// (questions + answer key) is app_settings.steph_quiz; her prompt carries it every
// turn (quizBlock), so when he replies with answers she grades them.
// [QUIZ_OFF] / [QUIZ_ON] (her, on his own message) pause and resume it
// (app_settings.steph_quiz_on). STEPH_QUIZ=off stops the cron.
//
// Unanswered (owner, 2026-11-26: "I want Stephanie to know if I didn't answer the
// questions from before, so the next time she'd send more questions she'd just remind
// me, and continue to do so if I don't answer them; then after a few attempts she goes
// to Ara and Ara tells me, but she should be angry"): while the last set isn't graded,
// each 30-min turn re-sends THAT set as a reminder (firmer each time) instead of a new
// one. After REMIND_MAX (3) reminders the next turn hands it to A.R.A., who tells him
// off on her bot, angry (an out-of-band A.R.A. turn, posted in the group as the hand-off).
// Then she stays quiet until he answers; a new day starts with a fresh set.
// node server/scripts/test-stephanie-quiz.js.
const { getSetting, setSetting } = require('./syncStore');

const TZ = 'America/New_York';
const START_HOUR = 8;
const END_HOUR = 22; // last set goes out at 9:30 PM
const LEVELS = [
  // [a range, b range]
  [[2, 9], [11, 19]],
  [[3, 9], [12, 49]],
  [[4, 9], [21, 99]],
  [[11, 19], [11, 19]],
  [[12, 29], [13, 49]],
  [[13, 49], [21, 99]],
];

const enabled = () => process.env.STEPH_QUIZ !== 'off';
const hourET = (now = new Date()) => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now), 10) % 24;
const inWindow = (now = new Date()) => { const h = hourET(now); return h >= START_HOUR && h < END_HOUR; };
const timeET = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });

function between(rand, [lo, hi]) { return lo + Math.floor(rand() * (hi - lo + 1)); }

// 5 questions at a level (0..LEVELS.length-1). Pure apart from `rand`.
function makeQuiz(level = 0, rand = Math.random) {
  const lv = Math.max(0, Math.min(LEVELS.length - 1, level | 0));
  const out = [];
  const seen = new Set();
  while (out.length < 5) {
    // One a level easier, three at the level, one a level harder: a mix, not a wall.
    const at = out.length === 0 ? Math.max(0, lv - 1) : out.length === 4 ? Math.min(LEVELS.length - 1, lv + 1) : lv;
    const [ra, rb] = LEVELS[at];
    let a = between(rand, ra), b = between(rand, rb);
    if (a % 10 === 0 || b % 10 === 0) continue; // ×10s are too easy
    if (rand() < 0.5) [a, b] = [b, a];
    const k = `${Math.min(a, b)}x${Math.max(a, b)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ a, b, answer: a * b });
  }
  return out;
}

function quizText(qs) {
  return `🧮 **5 quick ones, Mr. Burrus** — no calculator.\n\n${qs.map((q, i) => `${i + 1}. ${q.a} × ${q.b} = ?`).join('\n')}\n\nReply with your answers (just the numbers, in order) and I'll grade them.`;
}

async function load() {
  try { return JSON.parse(await getSetting('steph_quiz', '{}')) || {}; } catch { return {}; }
}

const REMIND_MAX = Math.max(1, Number(process.env.STEPH_QUIZ_REMINDERS) || 3);
const dayET = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms));

function reminderText(qs, n, at) {
  const list = qs.map((q, i) => `${i + 1}. ${q.a} × ${q.b} = ?`).join('\n');
  const lead = n === 1
    ? `⏰ You haven't answered the ones I sent at ${timeET(at)}, Mr. Burrus. No new set until these are done:`
    : n < REMIND_MAX
      ? `⏰ Still waiting on these from ${timeET(at)}. Five numbers, that's all I need:`
      : `⏰ Last reminder. These have been sitting since ${timeET(at)}. Answer them, or the next one goes to A.R.A.:`;
  return `${lead}\n\n${list}\n\nJust the numbers, in order.`;
}

let deps = null;
const d = () => ({
  send: async (text) => {
    const bot = require('./telegram').botFor('stephanie');
    if (!bot || !bot.isConfigured()) throw new Error("S.T.E.P.H.A.N.I.E.'s Telegram bot isn't set up (TELEGRAM_BOT_TOKEN_STEPHANIE)");
    await bot.sendMessage(require('./telegram').OWNER_ID, text);
  },
  // A.R.A. tells him, angry, in her own words and voice. Falls back to a plain text from her bot.
  escalate: async (text, plain) => {
    require('./groupChat').relayAsked('stephanie', 'ara', plain.replace(/^.*?→ A\.R\.A\.:\s*/, '')).catch(() => {});
    const ok = await require('./routes/telegram').personaOutOfBand('ara', text).catch((e) => { console.error(`stephanie quiz failed: A.R.A. turn: ${e.message}`); return false; });
    if (ok === false) await require('./loud').tellAra('steph-quiz-ignored', `😤 ${plain}`);
  },
  ...(deps || {}),
});

async function isOn() { return (await getSetting('steph_quiz_on', '1').catch(() => '1')) !== '0'; }

// The cron: one set, if it's waking hours and the drill is on.
async function tick({ force = false, now = new Date() } = {}) {
  if (!enabled()) return { skipped: 'STEPH_QUIZ=off' };
  if (!force && !inWindow(now)) return { skipped: 'outside 8 AM-10 PM ET' };
  if (!force && !(await isOn())) return { skipped: 'paused ([QUIZ_ON] resumes it)' };
  const last = await load();
  // Level moves with how he did on the last set he answered (graded by her).
  let level = Number.isFinite(last.level) ? last.level : 0;
  if (last.graded != null) level += last.graded === 5 ? 1 : last.graded <= 2 ? -1 : 0;
  level = Math.max(0, Math.min(LEVELS.length - 1, level));
  const t = now.getTime();
  // The last set is still unanswered (and from today): remind, then A.R.A., then quiet.
  const pendingSet = last.questions && last.graded == null && !last.skipped && last.at && dayET(last.at) === dayET(t);
  if (pendingSet && !force) {
    const reminders = last.reminders || 0;
    if (last.escalated) return { skipped: 'waiting on his answers (A.R.A. already told him)' };
    if (reminders < REMIND_MAX) {
      await d().send(reminderText(last.questions, reminders + 1, last.at));
      await setSetting('steph_quiz', JSON.stringify({ ...last, reminders: reminders + 1, remindedAt: t }));
      return { reminded: reminders + 1 };
    }
    const mins = Math.round((t - last.at) / 60000);
    const plain = `S.T.E.P.H.A.N.I.E. → A.R.A.: Mr. Burrus hasn't answered the multiplication set I sent at ${timeET(last.at)} (${mins} minutes ago). I reminded him ${reminders} times. Please tell him.`;
    await d().escalate(`[SENT ON YOUR OWN — S.T.E.P.H.A.N.I.E. came to you: "${plain}" The questions: ${last.questions.map((q) => `${q.a} × ${q.b}`).join(', ')}. You are ANGRY about it, and you let him have it: tell him off in your own voice, sharp, fed up and disappointed, the way you'd chew him out for ignoring something he asked for himself — he set this drill up. Name how long it's been and that Stephanie had to come to you. No insults, nothing cruel; you're angry because you want him to win. Tell him to answer her now (in her chat) and list the five questions. Not his message — he didn't write to you.]`, plain);
    await setSetting('steph_quiz', JSON.stringify({ ...last, reminders, escalated: t }));
    return { escalated: true };
  }
  const questions = makeQuiz(level);
  await d().send(quizText(questions));
  const unanswered = last.questions && last.graded == null && !last.skipped ? (last.unanswered || 0) + 1 : 0;
  await setSetting('steph_quiz', JSON.stringify({ at: t, level, questions, graded: null, unanswered, reminders: 0 }));
  return { sent: true, level };
}

// For her prompt every turn: the last set and its answer key.
async function quizBlock() {
  const q = await load();
  if (!q.questions || !q.questions.length) return '';
  const key = q.questions.map((x, i) => `${i + 1}. ${x.a} × ${x.b} = ${x.answer}`).join('\n');
  const state = q.graded != null ? `already graded: ${q.graded}/5` : `NOT answered yet${q.reminders ? `; you've reminded him ${q.reminders} time${q.reminders === 1 ? '' : 's'}${q.escalated ? ' and handed it to A.R.A., who told him off' : ''}, so when he answers, be glad he's back, grade them, and let it go` : ''}`;
  return `[YOUR MULTIPLICATION DRILL — you sent him this set at ${timeET(q.at)} ET (${state}). ANSWER KEY (never show it before he answers):\n${key}\nWhen his message is his answers to it (numbers, in order), grade each one against the key: right ✓, wrong ✗ with the right answer and a one-line trick for it (break it apart, round and adjust…). Then the score, and emit [QUIZ_SCORE: n] with how many he got right (it sets the next set's difficulty). If he only answered some, grade those. Answers to an older set: say this is the newest one. [QUIZ_OFF] pauses the drill and [QUIZ_ON] resumes it, only when he asks.]`;
}

// [QUIZ_SCORE: n] / [QUIZ_OFF] / [QUIZ_ON] / [QUIZ_NOW]
async function quizTag(name, arg, asked = '') {
  if (name === 'QUIZ_SCORE') {
    const n = Math.max(0, Math.min(5, parseInt(arg, 10)));
    if (!Number.isFinite(n)) return 'give the number right, 0-5';
    const q = await load();
    if (!q.questions) return 'no drill on record';
    await setSetting('steph_quiz', JSON.stringify({ ...q, graded: n, unanswered: 0 }));
    return `✓ scored ${n}/5`;
  }
  if (!String(asked || '').trim()) return 'not done — only on his own message';
  if (name === 'QUIZ_OFF') { await setSetting('steph_quiz_on', '0'); return '✓ drill paused — no more sets until he says to start again'; }
  if (name === 'QUIZ_ON') { await setSetting('steph_quiz_on', '1'); return '✓ drill back on — a set every 30 min, 8 AM-10 PM ET'; }
  if (name === 'QUIZ_NOW') { const r = await tick({ force: true }); return r.sent ? '✓ a new set just went out (it\'s already in the chat, don\'t repeat it)' : `not sent: ${r.skipped}`; }
  return '';
}

const QUIZ_TAGS = new Set(['QUIZ_SCORE', 'QUIZ_OFF', 'QUIZ_ON', 'QUIZ_NOW']);
const QUIZ_TOOLS = ` - MULTIPLICATION DRILL — you send him 5 multiplication questions every 30 min, 8 AM-10 PM ET, on your own. If he hasn't answered a set, the next turns remind him of it instead of sending new ones (${REMIND_MAX} reminders), then you hand it to A.R.A. and she tells him; after that you wait for his answers. [QUIZ_SCORE: n] records how many he got right after you grade a set. [QUIZ_NOW] sends a new set now; [QUIZ_OFF] / [QUIZ_ON] pause and resume the drill — only when he asks.`;

module.exports = { REMIND_MAX, reminderText, _setDeps: (x) => { deps = x; }, makeQuiz, quizText, tick, quizBlock, quizTag, QUIZ_TAGS, QUIZ_TOOLS, inWindow, LEVELS, enabled };
