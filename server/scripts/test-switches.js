// Spoken on/off switches (server/switches.js) and T.A.L.O.N.'s off switch (server/talonSwitch.js).
const assert = require('assert');
const store = {};
const fake = { getSetting: async (k, f) => (k in store ? store[k] : f), setSetting: async (k, v) => { store[k] = String(v); } };
const sw = require('../switches');
const ts = require('../talonSwitch');
sw._setDeps(fake);
let cancelled = 0;
let journal = [];
const told = [];
ts._setDeps({ ...fake, cancelQuickLimits: async () => { cancelled++; return 2; }, trades: async () => journal, tell: async (t) => { told.push(t); } });

(async () => {
  // Names he'd use find the right switch.
  assert.deepStrictEqual(sw.match('stock picks'), ['stock_desk']);
  assert.deepStrictEqual(sw.match('the multiplication quiz'), ['stephanie_quiz']);
  assert.deepStrictEqual(sw.match('breaking news'), ['breaking_watch']);
  assert.ok(sw.match('everything').length > 20 && !sw.match('everything').includes('sentinel'));
  assert.deepStrictEqual(sw.match('flux capacitor'), []);

  // Off and back on, only on his words.
  assert.match(await sw.tag('SWITCH_OFF', 'stock picks', { asked: 'stop the stock picks', persona: 'atlas' }), /only A\.R\.A\. and J\.A\.R\.V\.I\.S\./);
  assert.strictEqual(await sw.isOn('stock_desk'), true);
  assert.match(await sw.tag('SWITCH_OFF', 'stock picks', { asked: '', persona: 'ara' }), /refused/);
  assert.match(await sw.tag('SWITCH_OFF', 'stock picks', { asked: '[SENT ON YOUR OWN, 3 PM] x', persona: 'ara' }), /refused/);
  assert.match(await sw.tag('SWITCH_OFF', 'stock picks', { asked: 'stop the stock picks', persona: 'jarvis' }), /✓ OFF/);
  assert.strictEqual(await sw.isOn('stock_desk'), false);
  assert.match(await sw.list(), /OFF now: A\.T\.L\.A\.S\.'s stock picks/);
  assert.match(await sw.tag('SWITCH_ON', 'stock picks', { asked: 'turn the stock picks back on', persona: 'ara' }), /✓ ON/);
  assert.strictEqual(await sw.isOn('stock_desk'), true);

  // T.A.L.O.N.: stop sticks until he says start.
  assert.match(await ts.tag('TRADING_OFF', 'ara', { asked: 'tell talon to stop trading' }), /switched OFF/);
  assert.strictEqual(await ts.isHalted(), true);
  assert.strictEqual(store.auto_trade, '0');
  assert.strictEqual(cancelled, 1, 'resting limits cancelled');
  assert.match(await ts.tag('TRADING_ON', 'jarvis', { asked: '' }), /refused/);
  assert.match(await ts.tag('TRADING_ON', 'ara', { asked: 'how is gold doing?' }), /refused/);
  assert.match(await ts.tag('TRADING_OFF', 'talon', { asked: 'stop trading' }), /only A\.R\.A\. and J\.A\.R\.V\.I\.S\./);
  assert.match(await ts.tag('TRADING_ON', 'ara', { asked: "don't start trading yet" }), /refused/);
  assert.strictEqual(await ts.isHalted(), true);
  assert.strictEqual(await sw.isOn('trading'), false);
  assert.match(await sw.tag('SWITCH_ON', 'trading', { asked: 'turn the quiz on', persona: 'ara' }), /refused/);
  assert.match(await ts.tag('TRADING_ON', 'ara', { asked: 'ok start trading again' }), /back ON/);
  assert.strictEqual(await ts.isHalted(), false);
  assert.strictEqual(store.auto_trade, '1');
  assert.match(await ts.tag('TRADING_OFF', 'wire', { asked: 'stop' }), /only A\.R\.A\. and J\.A\.R\.V\.I\.S\./);

  // While halted, every automatic order is refused at tlPlaceOrder; a hand order passes the gate.
  await ts.off({ by: 'ara' });
  const tl = require('../tradeLocker');
  await assert.rejects(tl.tlPlaceOrder({ symbol: 'XAUUSD', side: 'buy', stopLoss: 1, takeProfit: 2 }), /switched OFF/);
  await tl.tlPlaceOrder({ symbol: 'XAUUSD', side: 'buy', stopLoss: 1, takeProfit: 2, manual: true })
    .then(() => {}, (e) => assert.doesNotMatch(e.message, /switched OFF/, 'a hand order is not blocked by the switch'));

  // One market at a time (owner, 2026-11-26).
  await ts.on();
  assert.deepStrictEqual(ts.marketsIn('stop trading bitcoin'), ['BTCUSD']);
  assert.deepStrictEqual(ts.marketsIn('gold and nasdaq'), ['XAUUSD', 'NAS100']);
  assert.match(await ts.tag('TRADING_OFF', 'ara', { asked: 'have talon stop trading bitcoin', arg: 'bitcoin' }), /OFF on Bitcoin only[\s\S]*gold, Nasdaq, EUR\/USD, GBP\/USD and USD\/JPY still trade/);
  assert.strictEqual(await ts.isHalted(), false, 'one market off is not all trading off');
  assert.strictEqual(await ts.marketHalted('BTCUSD'), true);
  assert.strictEqual(await ts.marketHalted('XAUUSD'), false);
  assert.match(await ts.blocked('BTCUSD'), /switched OFF on Bitcoin/);
  assert.strictEqual(await ts.blocked('XAUUSD'), '');
  assert.strictEqual(await sw.isOn('bitcoin'), false);
  assert.deepStrictEqual(sw.match('bitcoin trading'), ['bitcoin']);
  assert.deepStrictEqual(sw.match('talon'), ['trading']);
  // Starting gold doesn't start Bitcoin; a market named only in his words is honored.
  assert.match(await ts.tag('TRADING_OFF', 'ara', { asked: 'stop gold too', arg: 'gold' }), /OFF on gold only/);
  assert.match(await ts.tag('TRADING_ON', 'ara', { asked: 'start trading gold again' }), /trades gold again/);
  assert.strictEqual(await ts.marketHalted('BTCUSD'), true);
  assert.match(await ts.tag('TRADING_ON', 'ara', { asked: 'bitcoin?', arg: 'bitcoin' }), /refused/);
  // A stop with no market named stops everything (the safe side).
  assert.match(await ts.tag('TRADING_OFF', 'ara', { asked: 'stop trading, bitcoin is crazy' }), /switched OFF and stays off/);
  assert.strictEqual(await ts.isHalted(), true);
  // Plain "start trading" brings back every market.
  assert.match(await ts.tag('TRADING_ON', 'ara', { asked: 'start trading again' }), /back ON[\s\S]*Bitcoin is back on too/);
  assert.strictEqual(await ts.marketHalted('BTCUSD'), false);
  assert.match(await sw.tag('SWITCH_OFF', 'nasdaq', { asked: 'turn off nasdaq', persona: 'ara' }), /✓ OFF/);
  assert.strictEqual(await ts.marketHalted('NAS100'), true);
  assert.strictEqual(await ts.marketHalted('US100'), true, 'the broker\'s name for it counts');
  await ts.marketOn(['NAS100']);

  // Two losses in a day → done for the day (a scalp + swing pair counts once).
  const now = Date.now();
  journal = [
    { status: 'closed', closed_at: now - 6e5, outcome: 'loss', realized_pl: -20, symbol: 'XAUUSD', side: 'buy', pair_id: 'p1', setup_id: 's1' },
    { status: 'closed', closed_at: now - 6e5, outcome: 'loss', realized_pl: -20, symbol: 'XAUUSD', side: 'buy', pair_id: 'p1', setup_id: 's1' },
    { status: 'closed', closed_at: now - 5e5, outcome: 'win', realized_pl: 30, symbol: 'BTCUSD', side: 'sell', sync_id: 'x' },
    { status: 'closed', closed_at: now - 864e5 * 2, outcome: 'loss', realized_pl: -40, symbol: 'BTCUSD', side: 'sell', sync_id: 'old' },
  ];
  assert.strictEqual((await ts.dayStop()).stopped, false, 'one losing setup is not two');
  journal.push({ status: 'closed', closed_at: now - 1e5, outcome: 'loss', realized_pl: -15, symbol: 'NAS100', side: 'sell', sync_id: 'n1' });
  const ds = await ts.checkDayStop();
  assert.strictEqual(ds.stopped, true);
  assert.strictEqual(ds.count, 2);
  assert.match(told[0], /2 losses today[\s\S]*done trading for the day/);
  await ts.checkDayStop();
  assert.strictEqual(told.length, 1, 'told once');
  assert.match(await ts.blocked('XAUUSD'), /done for the day/);
  assert.strictEqual(ts.isBlockMessage(await ts.blocked('XAUUSD')), true);
  assert.match(await ts.tag('TRADING_STATUS', 'ara', {}), /DONE FOR TODAY after 2 losses/);
  // His "start trading" lifts it for today; two more losses stop it again.
  assert.match(await ts.tag('TRADING_ON', 'ara', { asked: 'let talon trade, start trading' }), /two-losses stop for today is lifted/);
  assert.strictEqual(await ts.blocked('XAUUSD'), '');
  journal.push({ status: 'closed', closed_at: now, outcome: 'loss', realized_pl: -10, symbol: 'XAUUSD', side: 'sell', sync_id: 'g2' });
  assert.strictEqual((await ts.dayStop()).stopped, false);
  journal.push({ status: 'closed', closed_at: now, outcome: 'loss', realized_pl: -10, symbol: 'BTCUSD', side: 'buy', sync_id: 'b2' });
  assert.strictEqual((await ts.dayStop()).stopped, true);

  // Break-evens don't count (owner, 2026-11-28): -$0.80 stop-out, break-even exits, and one real loss.
  delete store.talon_day_cleared;
  journal = [
    { status: 'closed', closed_at: now - 3e5, outcome: 'loss', realized_pl: -0.8, symbol: 'XAUUSD', side: 'buy', sync_id: 'be1' },
    { status: 'closed', closed_at: now - 2e5, outcome: 'loss', realized_pl: -7, entry_ref: 2000, stop_loss: 2000, take_profit: 1980, exit_price: 2000.005, side: 'sell', symbol: 'BTCUSD', sync_id: 'be2' },
    { status: 'closed', closed_at: now - 1e5, outcome: 'loss', realized_pl: -15, symbol: 'NAS100', side: 'sell', sync_id: 'real1' },
  ];
  let bs = await ts.dayStop();
  assert.strictEqual(bs.count, 1, 'two break-evens + one loss = one loss');
  assert.strictEqual(bs.breakeven.length, 2);
  assert.strictEqual(bs.stopped, false);
  assert.match(await ts.tag('TRADING_STATUS', 'ara', {}), /2 break-evens today, not counted/);
  journal.push({ status: 'closed', closed_at: now, outcome: 'loss', realized_pl: -12, symbol: 'XAUUSD', side: 'sell', sync_id: 'real2' });
  bs = await ts.dayStop();
  assert.strictEqual(bs.stopped, true, 'two real losses stop it');
  assert.strictEqual(ts.lossesToday([{ status: 'closed', closed_at: now, outcome: 'loss', realized_pl: -0.8, symbol: 'XAUUSD', side: 'buy', sync_id: 'z' }]).length, 0, '-$0.80 is break-even');

  // Every market sized so a position loses at most $40 at its stop.
  assert.strictEqual(tl.riskLots('XAUUSD', 20, 0.02), 0.02);
  assert.strictEqual(tl.riskLots('XAUUSD', 41, 0.02), 0);
  assert.strictEqual(tl.riskLots('BTCUSD', 1500, 0.02), 0.02);   // $30 at 0.02
  assert.strictEqual(tl.riskLots('BTCUSD', 3000, 0.02), 0.01);   // $60 at 0.02 → 0.01 = $30
  assert.strictEqual(tl.riskLots('BTCUSD', 4100, 0.02), 0);      // over $40 even at 0.01
  assert.strictEqual(tl.riskLots('NAS100', 100, 10, 1), 0.4);   // sized UP to $40 at $1/point
  assert.strictEqual(tl.riskLots('NAS100', 100, 10, 0), null);   // contract size unknown → no guess
  assert.strictEqual(tl.canonical('US100'), 'NAS100');
  const { guardStop, SYMBOLS } = require('../talonBrain');
  assert.ok(SYMBOLS.includes('NAS100'));
  const snap = { candles: { '1H': { atr14: 500, sma20: 90000 } }, structure: { '1H': { swings: [] } } };
  assert.match(guardStop({ symbol: 'BTCUSD', side: 'buy', entry: 92000, stopLoss: 87800, takeProfit: 101000, snap }).skip || '', /Bitcoin stop[\s\S]*\$40/);

  console.log('switches: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
