// node server/scripts/test-talon-reentry.js — T.A.L.O.N.'s re-entry after a stop sweep.
const assert = require('assert');
const { reentryCheck, newWatches, stoppedOut } = require('../talonReentry');

const H = 3600e3, M15 = 15 * 60e3;
const now = Date.UTC(2026, 10, 17, 15, 0);
const closedAt = now - 2 * H;
const snap = (h4 = 'up') => ({ candles: { '1H': { atr14: 8, sma20: 2048, trend: 'up' }, '4H': { trend: h4 }, '1D': { trend: 'up' } }, structure: { '1H': { swings: [] } } });
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
const watch = { symbol: 'XAUUSD', side: 'buy', entry: 2055, stop: 2040, takeProfit: 2080, swingTakeProfit: 2140, closedAt, status: 'watching' };
const hitBar = Math.floor(closedAt / M15) * M15; // the 15m bar the stop was hit in

// 1. Sweep 3 under the stop (1H ATR 8), next 15m closes back above -> re-enter, stop past the sweep.
let d = reentryCheck({ watch, snap: snap(), price: 2044, now, bars: [bar(hitBar, 2045, 2046, 2037, 2041), bar(hitBar + M15, 2041, 2045, 2040, 2044)] });
assert(d.enter, `expected a re-entry, got ${JSON.stringify(d)}`);
assert(d.enter.sweep === 2037);
assert(d.enter.stopLoss < 2037, 'stop goes past the sweep low');
assert(Math.abs(2044 - d.enter.stopLoss) >= 10, 'main stop rule minimum (gold $10) still applies');
assert(d.enter.swingTakeProfit === 2140 && d.enter.takeProfit === 2080);

// 2. Price ran 12 past the stop (> 1x ATR) -> breakdown, watch ends.
d = reentryCheck({ watch, snap: snap(), price: 2044, now, bars: [bar(hitBar, 2045, 2046, 2028, 2030), bar(hitBar + M15, 2030, 2045, 2029, 2044)] });
assert.strictEqual(d.end, 'broke', JSON.stringify(d));

// 3. Swept but no 15m close back above the stop yet -> keep waiting.
d = reentryCheck({ watch, snap: snap(), price: 2039, now, bars: [bar(hitBar, 2045, 2046, 2037, 2038)] });
assert(d.wait, JSON.stringify(d));

// 4. Reclaimed, but the 4H has turned down -> no re-entry.
d = reentryCheck({ watch, snap: snap('down'), price: 2044, now, bars: [bar(hitBar, 2045, 2046, 2037, 2041), bar(hitBar + M15, 2041, 2045, 2040, 2044)] });
assert.strictEqual(d.end, 'trend', JSON.stringify(d));

// 5. Past the 4-hour window -> expired.
d = reentryCheck({ watch: { ...watch, closedAt: now - 5 * H }, snap: snap(), price: 2044, now, bars: [] });
assert.strictEqual(d.end, 'expired');

// 6. Sell side mirrors it: sweep above the stop, close back below.
const sell = { symbol: 'XAUUSD', side: 'sell', entry: 2045, stop: 2060, takeProfit: 2020, swingTakeProfit: 1960, closedAt, status: 'watching' };
d = reentryCheck({ watch: sell, snap: snap('down'), price: 2056, now, bars: [bar(hitBar, 2055, 2063, 2054, 2059), bar(hitBar + M15, 2059, 2060, 2055, 2056)] });
assert(d.enter && d.enter.stopLoss > 2063, JSON.stringify(d));

// 7. Which closes start a watch.
const t = (o) => ({ auto: 1, status: 'closed', outcome: 'loss', side: 'buy', symbol: 'XAUUSD', entry_fill: 2055, stop_loss: 2040, take_profit: 2080, exit_price: 2040, r_multiple: -1, closed_at: closedAt, setup: 'scalp', setup_id: 'S1', pair_id: 'P1', sync_id: Math.random().toString(36), ...o });
assert(stoppedOut(t()));
assert(!stoppedOut(t({ setup: 'quick' })), 'quick scalps: no re-entry');
assert(!stoppedOut(t({ setup: 'add' })), 'add-ons: no re-entry');
assert(!stoppedOut(t({ closed_by: 'owner' })), 'he closed it: no re-entry');
assert(!stoppedOut(t({ r_multiple: -0.2 })), 'closed near entry, not at the stop');
assert(!stoppedOut(t({ setup_id: 'S1:re' })), 'a re-entry never gets its own re-entry');

const scalp = t(), swing = t({ setup: 'swing', take_profit: 2140 });
let w = newWatches([scalp, swing], {}, now);
assert.strictEqual(w.length, 1, 'one watch per setup');
assert.strictEqual(w[0].watch.swingTakeProfit, 2140);
assert.strictEqual(w[0].watch.takeProfit, 2080);
assert.strictEqual(newWatches([scalp, { ...swing, status: 'open', outcome: null }], {}, now).length, 0, 'part of the setup still open: wait');
assert.strictEqual(newWatches([scalp, swing], { S1: { status: 'entered' } }, now).length, 0, 'already handled');
assert.strictEqual(newWatches([t({ closed_at: now - 5 * H })], {}, now).length, 0, 'too old');
assert.strictEqual(newWatches([t({ setup_id: 'S1:re' })], {}, now).length, 0, 're-entry trades start no watch');

console.log('talon re-entry: all checks passed');
