// node server/scripts/test-steph-handoff.js — S.T.E.P.H.A.N.I.E.'s drill hand-off to
// A.R.A. goes out as a pass-off (owner, 2026-11-27).
const assert = require('assert');
const store = {};
require('../syncStore').getSetting = async (k, dflt) => (k in store ? store[k] : dflt);
require('../syncStore').setSetting = async (k, v) => { store[k] = v; };
const sent = [], told = [];
require('../talonAlerts').sendFromAra = async (text, spoken, opts) => { sent.push({ text, spoken, opts }); return true; };
require('../loud').tellAra = async (k, t) => { told.push(t); };
require('../groupChat').relayAsked = async () => {};
let llmFails = false;
require('../llm').chatAs = async () => { if (llmFails) throw new Error('down'); return 'Mr. Burrus. Three reminders and nothing? You built this drill. Answer Stephanie now:\n1. 18 × 5'; };
require('../llm').claudeText = async () => { throw new Error('down too'); };
const q = require('../stephanieQuiz');
const qs = [{ a: 18, b: 5, answer: 90 }, { a: 8, b: 43, answer: 344 }, { a: 9, b: 17, answer: 153 }, { a: 8, b: 22, answer: 176 }, { a: 6, b: 41, answer: 246 }];
const at = Date.parse('2026-11-27T15:30:00Z');
(async () => {
  store.steph_quiz = JSON.stringify({ at, level: 1, questions: qs, graded: null, reminders: 3 });
  q._setDeps({ send: async () => {} });
  assert.deepStrictEqual(await q.tick({ now: new Date('2026-11-27T17:00:00Z') }), { escalated: true });
  assert.strictEqual(sent.length, 1, 'one pass-off');
  assert(/A\.R\.A\. — S\.T\.E\.P\.H\.A\.N\.I\.E\. came to me/.test(sent[0].text) && /Answer Stephanie now/.test(sent[0].text));
  assert.deepStrictEqual(sent[0].opts, { from: 'stephanie', ownVoice: true }, "Stephanie's history and memory; A.R.A.'s own voice");
  assert(!told.length);
  // No AI at all: the plain hand-off still reaches him.
  llmFails = true; sent.length = 0;
  store.steph_quiz = JSON.stringify({ at, level: 1, questions: qs, graded: null, reminders: 3 });
  await q.tick({ now: new Date('2026-11-27T17:30:00Z') });
  assert.strictEqual(sent.length, 0); assert(/hasn't answered/.test(told[0]));
  console.log('stephanie hand-off ok');
})().catch((e) => { console.error(e); process.exit(1); });
