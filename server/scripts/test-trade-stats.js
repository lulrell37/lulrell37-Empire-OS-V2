// [TRADE_STATS] (tradeStats in server/tradeJournal.js): the journal cut by kind,
// side, session, daily trend and exit, worst first, so a losing market shows
// where it loses.   node server/scripts/test-trade-stats.js
const assert = require('assert');
const path = require('path');

// Stub the journal's storage and broker before tradeJournal loads them.
const stub = (rel, exports) => { const p = require.resolve(path.join('..', rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
const at = (iso) => Date.parse(iso);
let rows = [];
stub('syncStore', { syncedRows: async () => rows, upsertSyncRow: async () => {}, getSetting: async (k, d) => d, setSetting: async () => {} });
stub('tradeLocker', { tlActiveEnv: async () => 'demo' });
stub('talonAlerts', {});
const { tradeStats, statsParts } = require('../tradeJournal');

const now = Date.now();
const T = (o) => ({ persona: 'talon', symbol: 'XAUUSD', status: 'closed', qty: 0.02, closed_at: now - 3600000, ...o });
rows = [
  // a paired setup that lost both legs, against the daily, in Asia
  T({ sync_id: '1', side: 'sell', setup: 'scalp', pair_id: 'p1', setup_id: 's1', entry_ref: 4000, stop_loss: 4025, take_profit: 3975, exit_price: 4025, realized_pl: -50, r_multiple: -1, outcome: 'loss', opened_at: at('2026-11-16T03:00:00Z'), trend_at_entry: { d1: 'up', h4: 'down' } }),
  T({ sync_id: '2', side: 'sell', setup: 'swing', pair_id: 'p1', setup_id: 's1', entry_ref: 4000, stop_loss: 4025, take_profit: 3925, exit_price: 4025, realized_pl: -50, r_multiple: -1, outcome: 'loss', opened_at: at('2026-11-16T03:00:00Z'), trend_at_entry: { d1: 'up', h4: 'down' } }),
  // a paired setup whose scalp paid and swing went to break-even, London, with the daily
  T({ sync_id: '3', side: 'buy', setup: 'scalp', pair_id: 'p2', setup_id: 's2', entry_ref: 4100, stop_loss: 4080, take_profit: 4120, exit_price: 4120, realized_pl: 40, r_multiple: 1, outcome: 'win', opened_at: at('2026-11-17T09:00:00Z'), trend_at_entry: { d1: 'up', h4: 'up' } }),
  T({ sync_id: '4', side: 'buy', setup: 'swing', pair_id: 'p2', setup_id: 's2', entry_ref: 4100, stop_loss: 4100, take_profit: 4160, exit_price: 4100, realized_pl: 0, r_multiple: null, outcome: 'breakeven', opened_at: at('2026-11-17T09:00:00Z'), trend_at_entry: { d1: 'up', h4: 'up' } }),
  // a quick scalp stopped, a re-entry stopped, an old row with no trend
  T({ sync_id: '5', side: 'buy', setup: 'quick', setup_id: 'q1', entry_ref: 4050, stop_loss: 4045, take_profit: 4058, exit_price: 4044.5, realized_pl: -11, r_multiple: -1.1, outcome: 'loss', opened_at: at('2026-11-17T14:00:00Z') }),
  T({ sync_id: '6', side: 'sell', setup: 'scalp', pair_id: null, setup_id: 's1:re', entry_ref: 4030, stop_loss: 4050, take_profit: 3990, exit_price: 4050, realized_pl: -40, r_multiple: -1, outcome: 'loss', opened_at: at('2026-11-16T05:30:00Z'), trend_at_entry: { d1: 'up', h4: 'down' } }),
  // Bitcoin, and an old one outside the window: both left out of a 30-day XAUUSD read
  T({ sync_id: '7', symbol: 'BTCUSD', side: 'buy', setup: 'scalp', entry_ref: 90000, stop_loss: 89000, take_profit: 92000, exit_price: 92000, realized_pl: 40, outcome: 'win', opened_at: now }),
  T({ sync_id: '8', side: 'buy', setup: 'scalp', entry_ref: 3000, stop_loss: 2990, take_profit: 3020, exit_price: 2990, realized_pl: -20, outcome: 'loss', opened_at: now - 90 * 86400000, closed_at: now - 90 * 86400000 }),
];

(async () => {
  const { kindOf, exitOf, sessionOf, dailyOf } = statsParts;
  assert.strictEqual(kindOf(rows[0]), 'paired scalp');
  assert.strictEqual(kindOf(rows[5]), 're-entry scalp');
  assert.strictEqual(kindOf(rows[4]), 'quick scalp (5m)');
  assert.strictEqual(exitOf(rows[0]), 'stop');
  assert.strictEqual(exitOf(rows[2]), 'target');
  assert.strictEqual(exitOf(rows[4]), 'stop (slipped past it)');
  assert.strictEqual(sessionOf(at('2026-11-16T03:00:00Z')), 'Asia / overnight (6 PM-3 AM ET)'); // 10 PM ET
  assert.strictEqual(sessionOf(at('2026-11-17T09:00:00Z')), 'London (3-8 AM ET)'); // 4 AM ET
  assert.strictEqual(dailyOf(rows[0]), 'against the 1D');
  assert.strictEqual(dailyOf(rows[2]), 'with the 1D');
  assert.strictEqual(dailyOf(rows[4]), 'not recorded (older trades)');

  const out = await tradeStats({ symbol: 'XAUUSD', days: 30 });
  assert.match(out, /ALL: 6 trades, 1W-4L-1BE \(20%\), net -\$111\.00/);
  assert.match(out, /against the 1D: 3 trades, 0W-3L-0BE \(0%\), net -\$140\.00/);
  assert.match(out, /BY SETUP[^\n]*4 setups, 1 made money \(avg \+\$40\.00\), 3 lost/);
  assert.ok(!/BTCUSD/.test(out), 'other market left out');
  // Worst first inside a cut: Asia (-140 incl. re-entry at 12:30 AM ET) before London (+40).
  const sess = out.split('BY SESSION')[1];
  assert.ok(sess.indexOf('Asia') < sess.indexOf('London'));
  assert.match(await tradeStats({ symbol: 'XAUUSD', days: 1 / 24 / 60 }), /no closed trades/);
  console.log('trade stats: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
