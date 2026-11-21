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
console.log('money watch: all checks passed');
