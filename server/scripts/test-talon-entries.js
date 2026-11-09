// T.A.L.O.N.'s entry fixes, no network: the playbook's 1H location gate
// (entryLocation) and the quick scalps' limit back at the zone (limitPlan +
// pendingTick). node server/scripts/test-talon-entries.js
const assert = require('assert');

// Stubs go in before talonQuick loads (it destructures these at require time).
const tl = require('../tradeLocker');
const store = require('../syncStore');
const journal = require('../tradeJournal');
const alerts = require('../talonAlerts');
const settings = {};
store.getSetting = async (k, d) => (k in settings ? settings[k] : d);
store.setSetting = async (k, v) => { settings[k] = v; };
store.saveMemory = async () => {};
const opened = [], cancelled = [], alerted = [];
journal.recordTradeOpen = async (t) => { opened.push(t); return 'id'; };
alerts.tradeOpened = (t) => { alerted.push(t); };
const ended = [];
alerts.limitEnded = (t) => { ended.push(t); };
let orderState = async () => ({ state: 'pending' });
let quote = { mid: 4000 };
tl.tlOrderState = (...a) => orderState(...a);
let cancelOrder = async (id) => { cancelled.push(id); return { cancelled: id }; };
tl.tlCancelOrder = (...a) => cancelOrder(...a);
tl.tlQuote = async () => quote;

const { entryLocation } = require('../talonBrain');
const { limitPlan, pendingTick } = require('../talonQuick');

(async () => {
  // --- direction: any side, but against the big picture it's scalp only ---
  {
    const { tradeContext } = require('../talonBrain');
    const snap = { candles: { '1D': { trend: 'up' }, '4H': { trend: 'up' } } };
    assert.strictEqual(tradeContext({ side: 'buy', snap }).scalpOnly, false, 'with everything: full setup');
    const sell = tradeContext({ side: 'sell', daily: 'pullback', snap });
    assert(sell.against4H && sell.scalpOnly, 'a sell against the 4H is allowed, scalp only');
    assert.strictEqual(tradeContext({ side: 'sell', daily: 'reversal', snap }).scalpOnly, true, 'still scalp only while the 4H is against it');
    const turned = { candles: { '1D': { trend: 'up' }, '4H': { trend: 'down' } } };
    assert.strictEqual(tradeContext({ side: 'sell', daily: 'reversal', snap: turned }).scalpOnly, false, 'a called daily reversal with the 4H: full pair');
    assert.strictEqual(tradeContext({ side: 'sell', snap: turned }).scalpOnly, true, 'against the 1D uncalled: scalp only');
    // A trend line zone is somewhere to enter, on its own side only.
    const zone = { candles: { '1H': { atr14: 10, sma20: 3000 } }, structure: { '1H': { events: [], fvgs: [], orderBlocks: [], trendLines: [{ dir: 1, kind: 'support', now: 3100, zone: 2.5 }] } } };
    assert(entryLocation({ side: 'buy', entry: 3104, snap: zone }).ok, 'buy at rising support zone');
    assert(entryLocation({ side: 'sell', entry: 3104, snap: zone }).skip, 'support is no place to sell');
  }

  // --- entryLocation (playbook rule 2) ---
  const snap = {
    candles: { '1H': { atr14: 20, sma20: 3980 } },
    structure: { '1H': {
      events: [{ type: 'BOS', dir: 1, level: 3950 }, { type: 'BOS', dir: -1, level: 4100 }],
      range: { low: 3900, high: 4060, ote: [3934, 3961] },
      fvgs: [{ dir: 1, low: 3990, high: 3996, status: 'open' }, { dir: -1, low: 4030, high: 4040, status: 'open' }],
      orderBlocks: [],
    } },
  };
  assert.ok(entryLocation({ side: 'buy', entry: 3985, snap }).ok, 'at the SMA20 / FVG');
  assert.match(entryLocation({ side: 'buy', entry: 3955, snap }).at, /OTE|broken high/);
  const chase = entryLocation({ side: 'buy', entry: 4030, snap });
  assert.ok(chase.skip && /chase/.test(chase.skip) && /FVG 3990–3996/.test(chase.skip), chase.skip);
  // A bearish FVG doesn't count as value for a buy, and vice versa.
  assert.ok(entryLocation({ side: 'sell', entry: 4035, snap }).ok, 'sell into the bearish FVG');
  assert.ok(entryLocation({ side: 'sell', entry: 3972, snap }).ok, 'sell at the SMA20 still counts');
  assert.ok(entryLocation({ side: 'sell', entry: 4012, snap }).skip, 'sell mid-range refused');
  assert.ok(entryLocation({ side: 'buy', entry: 4000, snap: { candles: {} } }).skip, 'no data = no trade');

  // --- limitPlan (quick scalp rule 6) ---
  const setup = { dir: 1, entry: 4006, stopLoss: 3998, atr: 3, ema: 4002, dist: 8 };
  let p = limitPlan({ sym: 'XAUUSD', setup, takeProfit: 4020 });
  assert.strictEqual(p.limit, 4002, 'limit at the 5m EMA20, not the close');
  assert.strictEqual(p.entry, 4002);
  assert.strictEqual(p.stopLoss, 3998, 'stop stays beyond the zone (4 = over the $3 floor)');
  assert.strictEqual(p.takeProfit, 4014, 'target capped at 3R from the limit');
  p = limitPlan({ sym: 'XAUUSD', setup: { ...setup, stopLoss: 4000 }, takeProfit: 4020 });
  assert.strictEqual(p.stopLoss, 3999, 'a better price can\'t bring the stop under the $3 floor');
  p = limitPlan({ sym: 'XAUUSD', setup: { ...setup, entry: 4002.3 }, takeProfit: 4020 });
  assert.strictEqual(p.limit, null, 'still at the EMA20 → market');
  assert.ok(limitPlan({ sym: 'XAUUSD', setup, takeProfit: 4005 }).skip, 'under 1.5R from the limit');
  const sell = limitPlan({ sym: 'XAUUSD', setup: { dir: -1, entry: 3994, stopLoss: 4003, atr: 3, ema: 3998 }, takeProfit: 3980 });
  assert.strictEqual(sell.limit, 3998);
  assert.ok(sell.takeProfit < sell.entry && sell.stopLoss > sell.entry);

  // --- pendingTick: a resting limit's life ---
  const base = { orderId: 'o1', sym: 'XAUUSD', side: 'buy', qty: 0.02, limit: 4002, stopLoss: 3998, takeProfit: 4014, rationale: 'quick 5m — test', setupId: 's', placedAt: Date.now(), expiresAt: Date.now() + 600e3 };
  settings.talon_quick_pending = JSON.stringify([base]);
  quote = { mid: 4005 };
  assert.strictEqual((await pendingTick()).length, 1, 'still waiting');
  assert.strictEqual(opened.length + cancelled.length, 0);

  orderState = async () => ({ state: 'filled', avgPrice: 4002.1 });
  assert.strictEqual((await pendingTick()).length, 0);
  assert.strictEqual(opened.length, 1, 'journaled on fill');
  assert.strictEqual(opened[0].entry, 4002.1);
  assert.strictEqual(opened[0].orderId, 'o1');
  assert.strictEqual(opened[0].setup, 'quick');
  assert.strictEqual(alerted.length, 1, 'opened alert on the fill');
  assert.strictEqual(alerted[0].limitFilled, true);

  orderState = async () => ({ state: 'pending' });
  settings.talon_quick_pending = JSON.stringify([{ ...base, expiresAt: Date.now() - 1 }]);
  assert.strictEqual((await pendingTick()).length, 0);
  assert.deepStrictEqual(cancelled, ['o1'], 'cancelled after its 3 bars');
  assert.ok(ended.length === 1 && /not filled in 3 bars/.test(ended[0].why), 'he hears it was cancelled');

  cancelled.length = 0; quote = { mid: 4015 };
  settings.talon_quick_pending = JSON.stringify([base]);
  await pendingTick();
  assert.deepStrictEqual(cancelled, ['o1'], 'cancelled when price ran to the target without it');

  cancelled.length = 0; quote = { mid: 3997 };
  settings.talon_quick_pending = JSON.stringify([base]);
  await pendingTick();
  assert.deepStrictEqual(cancelled, ['o1'], 'cancelled when price hit the stop first');

  cancelled.length = 0; quote = { mid: 4005 };
  cancelOrder = async () => { throw new Error('busy'); };
  settings.talon_quick_pending = JSON.stringify([{ ...base, expiresAt: Date.now() - 1 }]);
  assert.strictEqual((await pendingTick()).length, 1, 'a failed cancel keeps it to look again');

  orderState = async () => ({ state: 'gone', status: 'Rejected' });
  ended.length = 0;
  assert.strictEqual((await pendingTick()).length, 0, 'gone unfilled is dropped');
  assert.ok(ended.length === 1 && /rejected/.test(ended[0].why), 'he hears the broker ended it');
  assert.strictEqual(opened.length, 1, 'and never journaled');

  // The messages he gets: real alert text, Telegram stubbed.
  {
    const sent = [];
    const telegram = require('../telegram');
    const pv = require('../personaVoice');
    telegram.botFor = () => ({ isConfigured: () => true, sendVoice: async () => {}, sendMessage: async (_, t) => { sent.push(t); } });
    pv.voiceNote = async () => ({ ogg: null });
    const real = require('../talonAlerts');
    delete require.cache[require.resolve('../talonAlerts')];
    const A = require('../talonAlerts');
    require.cache[require.resolve('../talonAlerts')].exports = real;
    A.limitPlaced({ symbol: 'XAUUSD', side: 'buy', qty: 0.02, limit: 4002, marketPrice: 4006, stopLoss: 3998, takeProfit: 4014, rationale: 'quick 5m — EMA20 hold', minutes: 15 });
    A.limitEnded({ symbol: 'XAUUSD', side: 'buy', limit: 4002, why: 'cancelled, not filled in 3 bars' });
    A.tradeOpened({ symbol: 'XAUUSD', side: 'buy', qty: 0.02, entry: 4002.1, stopLoss: 3998, takeProfit: 4014, setup: 'quick', limitFilled: true });
    await new Promise((r) => setTimeout(r, 50));
    assert.match(sent[0], /pending order/); assert.match(sent[0], /BUY LIMIT/); assert.match(sent[0], /4,?002/); assert.match(sent[0], /15 minutes/); assert.match(sent[0], /EMA20 hold/);
    assert.match(sent[1], /is off/); assert.match(sent[1], /No position was opened/);
    assert.match(sent[2], /filled on his limit/);
  }
  console.log('talon entries: all passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
