// node server/scripts/test-talon-strategies.js — T.A.L.O.N.'s strategies per market
// (server/talonStrategies.js) and forex sizing.
const assert = require('assert');
const st = require('../talonStrategies');
const settings = {};
st._setDeps({ getSetting: async (k, dflt) => settings[k] ?? dflt, setSetting: async (k, v) => { settings[k] = v; } });

(async () => {
  // --- reading his words ---
  assert.deepStrictEqual(st.parseHours('3am-6am'), { from: 180, to: 360 });
  assert.deepStrictEqual(st.parseHours('9:30am to 11'), { from: 570, to: 660 });
  assert.deepStrictEqual(st.parseHours('8pm-2am'), { from: 1200, to: 120 });
  assert.strictEqual(st.parseHours('all day'), null);
  assert.strictEqual(st.parseHours('sometime'), undefined);
  assert.strictEqual(st.strategyIn('the london breakout'), 'london_breakout');
  assert.strictEqual(st.strategyIn('ema cross'), 'trend_cross');
  assert.strictEqual(st.strategyIn('go back to the current one'), 'playbook');

  // --- the switch ---
  assert(/only on his own message/.test(await st.tag('TALON_STRATEGY', 'bitcoin | donchian', { asked: '' })));
  assert(/✓ BTCUSD now on Donchian/.test(await st.tag('TALON_STRATEGY', 'bitcoin | donchian', { asked: 'put bitcoin on donchian' })));
  assert.strictEqual(st.activeIn(JSON.parse(settings.talon_strategies), 'BTCUSD'), 'donchian');
  assert.strictEqual(st.activeIn(JSON.parse(settings.talon_strategies), 'XAUUSD'), 'playbook', 'other markets untouched');
  // London breakout is for gold and forex only.
  assert(/is for XAUUSD, EURUSD, GBPUSD, USDJPY only/.test(await st.tag('TALON_STRATEGY', 'bitcoin | london breakout', { asked: 'x' })));
  // A window: gold on London breakout 3-6 AM ET, playbook the rest of the day.
  const r = await st.tag('TALON_STRATEGY', 'gold | london breakout | 3am-6am', { asked: 'gold london 3 to 6' });
  assert(/from 3 AM to 6 AM ET/.test(r) && /no stable edge/.test(r));
  const cfg = JSON.parse(settings.talon_strategies);
  assert.strictEqual(st.activeIn(cfg, 'XAUUSD', Date.parse('2026-11-27T09:00:00Z')), 'london_breakout', '4 AM ET');
  assert.strictEqual(st.activeIn(cfg, 'XAUUSD', Date.parse('2026-11-27T15:00:00Z')), 'playbook', '10 AM ET');
  // "forex" sets all three pairs; "playbook" puts a market back and clears its hours.
  assert(/EURUSD, GBPUSD, USDJPY now on trend cross/.test(await st.tag('TALON_STRATEGY', 'forex | trend cross', { asked: 'x' })));
  await st.tag('TALON_STRATEGY', 'gold | playbook', { asked: 'x' });
  assert.deepStrictEqual(JSON.parse(settings.talon_strategies).XAUUSD, { base: 'playbook', windows: [] });
  assert(/XAUUSD: the playbook/.test(await st.tag('TALON_STRATEGIES', '', {})));

  // --- signals on made-up candles ---
  const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
  // Donchian: 20 quiet bars, then a close above their high.
  const h1 = Array.from({ length: 30 }, (_, i) => bar(i * 3600e3, 100, 101, 99, 100));
  h1.push(bar(31 * 3600e3, 100, 103, 100, 102.5));
  const dn = st.donchian(h1);
  assert.strictEqual(dn.side, 'buy'); assert.strictEqual(dn.stopLoss, 99);
  assert.strictEqual(+(dn.takeProfit - dn.entry).toFixed(6), +(2 * (dn.entry - dn.stopLoss)).toFixed(6), '2R');
  assert.strictEqual(st.donchian(h1.slice(0, 30)), null, 'no break, no trade');
  // Trend cross: a long drift down then a sharp turn up crosses EMA 9 over 21.
  const m15 = [];
  for (let i = 0; i < 230; i++) { const p = 100 + i * 0.05; m15.push(bar(i * 900e3, p, p + 0.05, p - 0.05, p)); }
  for (let i = 0; i < 12; i++) { const p = 111.5 - i * 0.25; m15.push(bar((230 + i) * 900e3, p, p + 0.05, p - 0.3, p - 0.25)); }
  let sig = null;
  for (let i = 0; i < 12 && !sig; i++) { const p = 108.5 + i * 0.4; m15.push(bar((242 + i) * 900e3, p, p + 0.45, p - 0.05, p + 0.4)); sig = st.trendCross(m15); }
  assert(sig && sig.side === 'buy' && sig.stopLoss < sig.entry, JSON.stringify(sig));

  // --- each signal handled once ---
  const placed = [];
  st._setDeps({ getSetting: async (k, dflt) => settings[k] ?? dflt, setSetting: async (k, v) => { settings[k] = v; }, history: async () => h1 });
  settings.talon_strategies = JSON.stringify({ BTCUSD: { base: 'donchian', windows: [] } });
  require('../marketStructure').closedBars = (b) => b;
  const place = async (sym, strategy, s) => { placed.push([sym, strategy, s.side]); return { entered: true }; };
  await st.strategyTick({ syms: ['BTCUSD', 'XAUUSD'], place });
  await st.strategyTick({ syms: ['BTCUSD', 'XAUUSD'], place });
  assert.deepStrictEqual(placed, [['BTCUSD', 'donchian', 'buy']], 'one order per signal, playbook markets left alone');

  // --- forex sizing: never more than $40 at the stop ---
  const t = require('../tradeLocker');
  const loss = (sym, dist, lots, px) => lots * dist * (sym === 'USDJPY' ? 100000 / px : 100000);
  for (const [sym, dist, px] of [['EURUSD', 0.0020, 1.08], ['GBPUSD', 0.0030, 1.27], ['USDJPY', 0.25, 156], ['EURUSD', 0.0005, 1.08]]) {
    const lots = t.riskLots(sym, dist, t.FX_MAX_QTY, undefined, px);
    assert(lots > 0 && loss(sym, dist, lots, px) <= 40 + 1e-9, `${sym} ${dist}: ${lots} lots loses ${loss(sym, dist, lots, px)}`);
  }
  assert.strictEqual(t.riskLots('XAUUSD', 15), 0.02, 'gold unchanged');
  assert.strictEqual(require('../marketStructure').roundPrice(1.083456), 1.08346);
  assert.strictEqual(require('../marketStructure').roundPrice(4215.376), 4215.38, 'gold rounding unchanged');
  console.log('talon strategies ok');
})().catch((e) => { console.error(e); process.exit(1); });
