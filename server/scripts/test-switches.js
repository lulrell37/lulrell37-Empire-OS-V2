// Spoken on/off switches (server/switches.js) and T.A.L.O.N.'s off switch (server/talonSwitch.js).
const assert = require('assert');
const store = {};
const fake = { getSetting: async (k, f) => (k in store ? store[k] : f), setSetting: async (k, v) => { store[k] = String(v); } };
const sw = require('../switches');
const ts = require('../talonSwitch');
sw._setDeps(fake);
let cancelled = 0;
ts._setDeps({ ...fake, cancelQuickLimits: async () => { cancelled++; return 2; } });

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

  console.log('switches: all checks passed');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
