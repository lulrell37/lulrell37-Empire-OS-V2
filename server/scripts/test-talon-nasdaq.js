// node server/scripts/test-talon-nasdaq.js — the Nasdaq desk's triggers, stop, size and day stops (no broker).
const assert = require('assert');
const N = require('../talonNasdaq');

// A weekday session: Mon Nov 23 2026, 9:30 ET = 14:30 UTC.
const open = Date.UTC(2026, 10, 23, 14, 30);
const bar = (i, o, h, l, c) => ({ t: open + i * 60e3, o, h, l, c, v: 0 });
// 15 opening-range bars between 20000 and 20020, then quiet just under the high.
const bars = [];
for (let i = 0; i < 15; i++) bars.push(bar(i, 20010, 20020, 20000, 20010));
for (let i = 15; i < 20; i++) bars.push(bar(i, 20012, 20018, 20008, 20015));
const now = (n) => open + n * 60e3 + 5000;

// Opening range read off the first 15 bars.
assert.deepStrictEqual(N.openingRange(N.sessionBars(bars, now(20))), { high: 20020, low: 20000 });

// A close above the range high fires a buy (break), and the stop sits past it.
const up = [...bars, bar(20, 20016, 20030, 20015, 20028)];
const sess = N.sessionBars(up, now(21));
const sig = N.signal(up, sess, {});
assert.ok(sig && sig.side === 'buy' && /opening-range/.test(sig.trigger), JSON.stringify(sig));
// Once taken, the same break doesn't fire again that day.
const again = N.signal(up, sess, { buy: true });
assert.ok(!again || !/opening-range/.test(again.trigger));

// Stop: past the trigger and the candle's low, at least 10 points; 2R target.
const p = N.plan(sig, 8);
assert.strictEqual(p.side, 'buy');
assert.ok(p.stop < Math.min(sig.level, 20015) && p.entry - p.stop >= 10, JSON.stringify(p));
assert.ok(Math.abs((p.target - p.entry) - 2 * (p.entry - p.stop)) < 0.02);
// Too wide → skip.
assert.ok(N.plan({ ...sig, level: 19900, bar: { ...sig.bar, l: 19900 } }, 8).skip);

// Size: $50 at the stop. 13 pts × $1 contract → 3.84 lots; × $20 → 0.19; unknown → 0.
assert.strictEqual(N.lotsFor(13, 1), 3.84);
assert.strictEqual(N.lotsFor(13, 20), 0.19);
assert.strictEqual(N.lotsFor(13, 0), 0);

// VWAP without volume = running mean of typical price.
const vw = N.vwapSeries([bar(0, 1, 3, 1, 2), bar(1, 2, 4, 2, 3)]);
assert.ok(Math.abs(vw[1] - (2 + 3) / 2) < 1e-9);

// A bar crossing VWAP down fires a sell.
const flat = [];
for (let i = 0; i < 20; i++) flat.push(bar(i, 20010, 20012, 20008, 20010));
const dn = [...flat, bar(20, 20010, 20011, 19990, 19992)];
const s2 = N.signal(dn, N.sessionBars(dn, now(21)), { sell: true });
assert.ok(s2 && s2.side === 'sell' && /VWAP/.test(s2.trigger), JSON.stringify(s2));

// Day stops read from the journal.
const day = '2026-11-23';
const closedAt = open + 3600e3;
const t = (pl, outcome) => ({ setup: N.SETUP, status: 'closed', closed_at: closedAt, realized_pl: pl, outcome });
assert.deepStrictEqual(N.dayTally([t(120, 'win'), t(-40, 'loss'), t(90, 'win'), { ...t(999, 'win'), setup: 'quick' }], day), { net: 170, losses: 1, count: 3 });
console.log('nasdaq desk: all checks passed');
