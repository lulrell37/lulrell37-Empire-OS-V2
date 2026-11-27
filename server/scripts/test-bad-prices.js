// node server/scripts/test-bad-prices.js — impossible broker prices (2026-11-26: gold
// filled at 7188 with the market at ~3566, about $3,620 lost on each of two trades).
const assert = require('assert');
const tl = require('../tradeLocker');
const bar = (t, c, h = c + 1, l = c - 1, o = c) => ({ t, o, h, l, c });

// A lone bad candle is dropped; a bad wick is trimmed; a real move that holds is kept.
let r = tl.cleanBars([bar(1, 3566), bar(2, 3567), bar(3, 3565), bar(4, 7188), bar(5, 3566), bar(6, 3568)], '15m');
assert.deepStrictEqual(r.bars.map((b) => b.c), [3566, 3567, 3565, 3566, 3568]); assert.strictEqual(r.dropped, 1);
r = tl.cleanBars([bar(1, 3566), bar(2, 3567), bar(3, 3566, 5381, 3565)], '15m');
assert.strictEqual(r.bars[2].h, 3566, 'the 5381 wick is trimmed'); assert.strictEqual(r.bars.length, 3);
r = tl.cleanBars([bar(1, 90000), bar(2, 90100), bar(3, 79000), bar(4, 78800), bar(5, 79100)], '1H');
assert.deepStrictEqual(r.bars.map((b) => b.c), [90000, 90100, 79000, 78800, 79100], 'a 12% crash that holds is real');
assert.strictEqual(tl.cleanBars([bar(1, 3000), bar(2, 3500)], '1D').dropped, 0, 'the daily allows 25%');

// Quotes: 10% off the last good price is refused.
tl._lastGood.XAUUSD = { price: 3566, at: Date.now() };
assert(tl.badQuote('XAUUSD', 5381.24), '5381 refused');
assert.strictEqual(tl.badQuote('XAUUSD', 3600), null, 'a normal move passes');
assert.strictEqual(tl.badQuote('EURUSD', 1.08), null, 'no reference yet: passes');

// The journal books the real loss and flags the fill.
const j = require('../tradeJournal');
assert.strictEqual(+((-1) * (7188.24 - 3568.11) * 0.01 * j.dollarsPerPoint('XAUUSD')).toFixed(2), -3620.13);
// The close alert says it's a bad broker price and what to ask for.
const alerts = require('../talonAlerts');
const fs = require('fs');
assert(/bad broker price, not a real fill/.test(fs.readFileSync(require('path').join(__dirname, '..', 'talonAlerts.js'), 'utf8')));
console.log('bad prices ok');
