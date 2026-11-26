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
  const questions = makeQuiz(level);
  const bot = require('./telegram').botFor('stephanie');
  if (!bot || !bot.isConfigured()) throw new Error("S.T.E.P.H.A.N.I.E.'s Telegram bot isn't set up (TELEGRAM_BOT_TOKEN_STEPHANIE)");
  await bot.sendMessage(require('./telegram').OWNER_ID, quizText(questions));
  const unanswered = last.questions && last.graded == null && !last.skipped ? (last.unanswered || 0) + 1 : 0;
  await setSetting('steph_quiz', JSON.stringify({ at: now.getTime(), level, questions, graded: null, unanswered }));
  return { sent: true, level };
}

// For her prompt every turn: the last set and its answer key.
async function quizBlock() {
  const q = await load();
  if (!q.questions || !q.questions.length) return '';
  const key = q.questions.map((x, i) => `${i + 1}. ${x.a} × ${x.b} = ${x.answer}`).join('\n');
  const state = q.graded != null ? `already graded: ${q.graded}/5` : 'NOT graded yet';
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
const QUIZ_TOOLS = ` - MULTIPLICATION DRILL — you send him 5 multiplication questions every 30 min, 8 AM-10 PM ET, on your own. [QUIZ_SCORE: n] records how many he got right after you grade a set. [QUIZ_NOW] sends a new set now; [QUIZ_OFF] / [QUIZ_ON] pause and resume the drill — only when he asks.`;

module.exports = { makeQuiz, quizText, tick, quizBlock, quizTag, QUIZ_TAGS, QUIZ_TOOLS, inWindow, LEVELS, enabled };
