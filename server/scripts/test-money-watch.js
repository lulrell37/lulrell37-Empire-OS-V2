// node server/scripts/test-money-watch.js — the money watch's parsing (no AI, no Gmail).
const assert = require('assert');
const M = require('../moneyWatch');
const ids = new Set(['a', 'b', 'c']);
const out = M.parse('[{"id":"a","direction":"in","amount":24.5,"business":"Blessed Visionary Clothing","source":"Etsy","note":"order #1"},{"id":"b","direction":"out","amount":"0","source":"x"},{"id":"zz","direction":"in","amount":5},{"id":"c","direction":"out","amount":12,"currency":"EUR"}]', ids);
assert.deepStrictEqual(out.map((e) => e.id), ['a'], 'only real USD amounts on known messages');
assert.strictEqual(M.parse('nothing', ids).length, 0);
const biz = ['Blessed Visionary Clothing', 'YouTube Shorts', 'Trading'];
assert.strictEqual(M.matchBusiness('blessed visionary', biz), 'Blessed Visionary Clothing');
assert.strictEqual(M.matchBusiness('Netflix', biz), 'Personal');
const rep = M.dayReport([{ date: '2026-11-20', amount: 100, type: 'income', business: 'Trading', note: 'auto · PayPal' }, { date: '2026-11-20', amount: 40, type: 'expense', business: 'Personal', note: 'gas' }, { date: '2026-11-19', amount: 999, type: 'income' }], '2026-11-20');
assert.ok(/In \$100\.00 · Out \$40\.00 · Net \$60\.00\n/.test(rep), rep);
assert.ok(/nothing came in/.test(M.dayReport([], '2026-11-20')));
assert.ok(M.lastDayOfMonth('2026-11-30') && M.lastDayOfMonth('2026-12-31') && M.lastDayOfMonth('2028-02-29'));
assert.ok(!M.lastDayOfMonth('2026-11-20') && !M.lastDayOfMonth('2028-02-28'));
const mon = M.monthSummary([{ date: '2026-11-02', amount: 100, type: 'income', business: 'Trading' }, { date: '2026-11-20', amount: 40, type: 'expense' }, { date: '2026-10-30', amount: 999, type: 'income' }], '2026-11', 'total');
assert.ok(/Total: in \$100\.00, out \$40\.00, net \$60\.00/.test(mon), mon);
console.log('money watch: all checks passed');
