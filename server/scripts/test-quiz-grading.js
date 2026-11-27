// node server/scripts/test-quiz-grading.js — S.T.E.P.H.A.N.I.E. grades in code and goes over every miss.
const assert = require('assert');
const store = {};
require('../syncStore').getSetting = async (k, dflt) => (k in store ? store[k] : dflt);
require('../syncStore').setSetting = async (k, v) => { store[k] = v; };
const q = require('../stephanieQuiz');
const qs = [{ a: 7, b: 23, answer: 161 }, { a: 8, b: 47, answer: 376 }, { a: 12, b: 14, answer: 168 }, { a: 6, b: 38, answer: 228 }, { a: 15, b: 26, answer: 390 }];

assert.deepStrictEqual(q.readAnswers(qs, '161, 366, 168, 228, 380'), [161, 366, 168, 228, 380]);
assert.deepStrictEqual(q.readAnswers(qs, '1. 161\n2. 366\n3. 168'), [161, 366, 168, null, null]);
assert.deepStrictEqual(q.readAnswers(qs, '8 x 47 = 366, 7 × 23 = 161'), [161, 366, null, null, null]);
assert.deepStrictEqual(q.readAnswers(qs, '1,064 2 3'), [1064, 2, 3, null, null]);
assert.strictEqual(q.readAnswers(qs, 'call me at 5 about the 3 invoices for the client tomorrow'), null);
assert.strictEqual(q.breakdown(8, 47), '8 × 47 = 8 × 40 + 8 × 7 = 320 + 56 = 376');

(async () => {
  store.steph_quiz = JSON.stringify({ at: Date.now(), level: 1, questions: qs, graded: null });
  const block = await q.quizBlock('161, 366, 168, 228, 380');
  assert(/GRADED IN CODE/.test(block));
  assert(/8 × 47: he said 366 ✗ \(right answer 376; work it: 8 × 47 = 8 × 40 \+ 8 × 7/.test(block), block);
  assert(/GO OVER EVERY ✗/.test(block) && /one similar problem/.test(block));
  assert(/\[QUIZ_SCORE: 3\]/.test(block));
  const saved = JSON.parse(store.steph_quiz);
  assert.strictEqual(saved.graded, 3);
  assert.strictEqual(saved.missedToday.length, 2);

  // Later turn: the misses and his answers are still in front of her.
  const later = await q.quizBlock('go over the ones I got wrong');
  assert(/THE ONES HE GOT WRONG TODAY/.test(later) && /8 × 47 = 376 \(he said 366/.test(later), later);
  assert(/HIS ANSWERS TO THIS SET/.test(later));
  // Not graded twice.
  assert(!/GRADED IN CODE/.test(await q.quizBlock('161, 376, 168, 228, 390')));

  // All right.
  store.steph_quiz = JSON.stringify({ at: Date.now(), level: 1, questions: qs, graded: null });
  assert(/All right/.test(await q.quizBlock('161 376 168 228 390')));
  console.log('quiz grading ok');
})().catch((e) => { console.error(e); process.exit(1); });
