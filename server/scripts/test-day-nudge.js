// node server/scripts/test-day-nudge.js — the day nudge's parsing (no AI, no DB).
const assert = require('assert');
const D = require('../dayNudge');
assert.strictEqual(D.parse('NOTHING'), null);
const p = D.parse('Post the Fiverr gig today — sign-up is the only step left.\nKEYS: fiverr, gig');
assert.strictEqual(p.text, 'Post the Fiverr gig today — sign-up is the only step left.');
assert.deepStrictEqual(p.keys, ['fiverr', 'gig']);
assert.deepStrictEqual(D.dueTasks([{ title: 'APK', due_date: '2026-11-17' }, { title: 'later', due_date: '2026-12-01' }, { title: 'done', due_date: '2026-11-01', done: true }], '2026-11-20'), ['APK (overdue since 2026-11-17)']);
console.log('day nudge: all checks passed');
