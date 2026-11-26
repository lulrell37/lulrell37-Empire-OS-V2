// Two of his standing rules, checked on every persona's Telegram reply
// (owner, 2026-11-26), the way promisedHandoffs checks "relaying it to Atlas now":
//
// 1. "If a persona says they will check something they must come back; I shouldn't
//    have to say anything else." promisedCheck() finds "I'll check / let me look /
//    I'll get back to you". runPersonaTurn then gives the persona one more round to
//    actually do it now with its tools. If the reply still promises it (the work
//    really runs longer), a follow-up turn is scheduled (scheduleFollowUp) that runs
//    the check and sends him the answer on that persona's bot without him asking.
//
// 2. "I only hear about what actually needs me" — for every persona, not just
//    J.A.R.V.I.S.'s workers. asksOwner() finds a reply asking him for something
//    (send me, what's your email, can you share…) that isn't onlyHim (a code texted
//    to his phone, a phone approval, his ID or card, his OK to act, a decision that's
//    his). The persona gets one round to get it from whoever on the team has it
//    ([RELAY_TO], its own tags) and carry on; the question reaches him only if that fails.
//
// node server/scripts/test-follow-through.js.

const PROMISE = /\b(?:i'?ll|i will|i'?m going to|let me|lemme|gonna|i can)\s+(?:go\s+|quickly\s+|just\s+|now\s+|double-?\s?)?(?:check|look(?: into| up| at| through)?|find out|dig(?: into)?|pull(?: up)?|verify|confirm|see (?:if|what|whether|where|when|why|how)|get back to you|report back|circle back|follow up|update you|let you know|ask|search|investigate|review|figure out|track (?:it|that|this) down)\b|\b(?:checking|looking into|digging into|on it)\b(?:\s+(?:now|it|that|this|for you))?[.!—-]|\bgive me (?:a|one) (?:sec|second|minute|moment|min)\b|\bi'?ll have (?:an answer|it|that) (?:for you|shortly|soon)\b|\bstand by\b/i;
// Offers, questions and conditionals aren't promises ("want me to check?", "if you'd like, I can look").
const NOT_PROMISE = /\b(?:want me to|should i|shall i|would you like me to|do you want me to|if you(?:'d)? (?:like|want)|happy to|i can also)\b/i;

function promisedCheck(text) {
  const lines = String(text || '').split(/(?<=[.!?\n])\s+/);
  for (const l of lines) {
    if (PROMISE.test(l) && !NOT_PROMISE.test(l) && !/\?\s*$/.test(l.trim())) return l.trim().slice(0, 300);
  }
  return '';
}

// Asking him for something (info, a file, a login, a link, a code, an answer someone else has).
const ASKS = /\b(?:can|could|would) you\s+(?:please\s+)?(?:send|share|give|provide|forward|upload|drop|paste|tell me|confirm|check|look up|find|get me|dm|text)\b|\b(?:please|pls)\s+(?:send|share|provide|forward|upload|paste|confirm)\b|\bsend (?:me|over)\b|\bi(?:'ll)? need (?:you to|your|from you|the (?:login|password|email|code|link|file|details|account))\b|\bwhat(?:'s| is) (?:your|the) (?:email|e-mail|password|login|username|user name|code|account|address|phone|number|link)\b|\bdo you have (?:the|a|your)\b|\bwhere (?:is|are|can i find) (?:the|your)\b|\bonce you (?:send|share|give|provide|confirm)\b|\bjust need you to\b|\bwaiting on you (?:to|for)\b/i;

function asksOwner(text) {
  const { onlyHim } = require('./workers');
  const lines = String(text || '').split(/(?<=[.!?\n])\s+/);
  for (const l of lines) {
    if (ASKS.test(l) && !onlyHim(l) && !DECISION.test(l)) return l.trim().slice(0, 300);
  }
  return '';
}
// A choice that is his to make is a fair question ("which do you prefer", "should I go ahead").
const DECISION = /\b(?:which (?:one|do you|would you)|prefer|your call|up to you|do you want|would you like|should (?:i|we)|okay to|ok to|go ahead|approve|sign off|your (?:ok|okay|go-?ahead|permission))\b/i;

const CHECK_ROUND = (said) => `[You told Mr. Burrus "${said}". His rule: when you say you'll check something, you come back with it; he never has to ask again. Do it now, in this turn: use your tags ([SEARCH_WEB], [READ_…], [MEMORY_QUERY], [RELAY_TO: whoever has it], [TRADE_POSITIONS], …) to get the answer, then give him the answer itself. If it truly can't finish in this turn (a worker or a long job is on it), say exactly what is running and that the result comes to him by itself. Don't promise to check again.]`;

const ASK_ROUND = (said) => `[Your reply asks Mr. Burrus: "${said}". His rule (every persona): he only hears about what only he can give. If anyone on the team has it or can get it — A.R.A.: his email, calendar, notes, codes and links; S.E.L.E.N.E.: designs and looks; S.C.R.I.B.E.: copy; T.A.L.O.N.: trades; A.T.L.A.S.: money; J.A.R.V.I.S.: code, logins, building a tool you're missing — get it now with [RELAY_TO: id | exactly what you need] or your own tags, and carry on with it. Only if it truly needs him (a code texted to his phone, a phone approval, his ID or card, his OK to send / post / buy / delete, or a decision that's his) keep the question, and say who already tried.]`;

// A follow-up turn that delivers what the persona promised, on its own bot. Once per
// turn, never from a follow-up itself (no loops), at most FOLLOW_MAX (3) pending.
const pending = new Map();
const FOLLOW_MAX = 3;
const DELAY_MS = () => (Number(process.env.FOLLOW_UP_DELAY_S) || 120) * 1000;
const FOLLOW_PREFIX = '[SENT ON YOUR OWN — a follow-up you promised him';
function scheduleFollowUp(persona, said, ownerText, { run = null, delayMs = DELAY_MS() } = {}) {
  if (process.env.FOLLOW_THROUGH === 'off') return false;
  if (String(ownerText || '').startsWith(FOLLOW_PREFIX) || /^\[SENT ON YOUR OWN/.test(String(ownerText || ''))) return false;
  if (pending.size >= FOLLOW_MAX) return false;
  const key = `${persona}:${said}`;
  if (pending.has(key)) return false;
  const text = `${FOLLOW_PREFIX}. A little while ago you told him: "${said}". He asked: "${String(ownerText || '').slice(0, 600)}". Come back to him with the answer now: run whatever it takes (your tags, [RELAY_TO], a worker's or job's result if one was running) and tell him what you found, plainly. If it's still running, say what it's at and when the result comes. Not his message — he didn't ask again.]`;
  const t = setTimeout(() => {
    pending.delete(key);
    const go = run || ((p, m) => require('./routes/telegram').personaOutOfBand(p, m));
    Promise.resolve(go(persona, text)).catch((e) => console.error(`follow through failed: ${persona}: ${e.message}`));
  }, delayMs);
  if (t.unref) t.unref();
  pending.set(key, t);
  return true;
}

const enabled = () => process.env.FOLLOW_THROUGH !== 'off';

module.exports = { promisedCheck, asksOwner, CHECK_ROUND, ASK_ROUND, scheduleFollowUp, FOLLOW_PREFIX, enabled, _pending: pending };
