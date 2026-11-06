// Moving T.A.L.O.N. between accounts, with the database and broker faked. Run:
// node server/scripts/test-account-switch.js
const assert = require('assert');
const path = require('path');

const settings = {};
const trades = [];
let slots = {};
const calls = [];

function stub(file, exports) {
  const id = require.resolve(path.join('..', file));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

stub('db', {
  query: async (sql, args) => {
    if (/FROM trade_creds WHERE id = ANY/.test(sql)) {
      const [ids, slot] = args;
      const rows = ids.map((i) => slots[i]).filter(Boolean).sort((a, b) => (b.id === slot) - (a.id === slot) || a.id - b.id);
      return { rows };
    }
    if (/SELECT env FROM trade_creds WHERE id/.test(sql)) return { rows: slots[args[0]] ? [slots[args[0]]] : [] };
    if (/INSERT INTO tg_pending/.test(sql)) { calls.push('card'); return { rows: [] }; }
    return { rows: [] };
  },
});
stub('syncStore', {
  getSetting: async (k, f) => (k in settings ? settings[k] : f),
  setSetting: async (k, v) => { settings[k] = String(v); },
  syncedRows: async (t) => (t === 'trades' ? trades : []),
  syncedRow: async () => null,
  upsertSyncRow: async (table, id, row) => {
    const i = trades.findIndex((x) => x.sync_id === id);
    if (i >= 0) trades[i] = { ...row, sync_id: id }; else trades.push({ ...row, sync_id: id });
  },
  newId: () => `id${Math.random()}`,
  saveMemory: async () => {},
  todayET: () => '2026-11-06',
});
stub('talonAlerts', new Proxy({}, { get: () => () => {} }));

// The two brokers. Each has its own positions; the live one shouldn't get orders.
const open = { live: [['p1', 1, 1, 'buy', 0.02, 4000, 0, 0, Date.now(), 12, 0]], demo: [] };
const orders = [];
global.fetch = async (url, opts = {}) => {
  const env = /live\.tradelocker/.test(url) ? 'live' : 'demo';
  const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body });
  if (/auth\/jwt\/token/.test(url)) return ok({ accessToken: `t-${env}`, refreshToken: 'r' });
  if (/all-accounts/.test(url)) return ok({ accounts: [{ id: `${env}-acct`, accNum: 1, accountBalance: 1000 }] });
  if (/\/positions/.test(url)) return ok({ d: { positions: open[env] } });
  if (/\/instruments/.test(url)) return ok({ d: { instruments: [{ name: 'XAUUSD', tradableInstrumentId: 1, pricePrecision: 2, routes: [{ type: 'TRADE', id: 1 }, { type: 'INFO', id: 2 }] }] } });
  if (/\/orders/.test(url) && opts.method === 'POST') { orders.push(env); return ok({ d: { orderId: 'o1' } }); }
  if (/\/orders/.test(url)) return ok({ d: { ordersHistory: [] } });
  if (/\/quotes/.test(url)) return ok({ d: { bp: 4000, ap: 4000.5 } });
  if (/\/history/.test(url)) return ok({ d: { barDetails: [] } });
  return ok({ d: {} });
};

const login = (id, env) => ({ id, email: `${env}@x`, password: 'p', server: 's', env });
const tl = require('../tradeLocker');
const cmd = require('../talonCommands');
const { allTrades } = require('../tradeJournal');

const reset = () => {
  Object.keys(settings).forEach((k) => delete settings[k]);
  trades.length = 0;
  calls.length = 0;
  orders.length = 0;
  tl.tlReset();
};
const goLive = async () => {
  settings.talon_account = 'live';
  settings.talon_live = '1';
  await tl.tlConnect();
  assert.strictEqual(tl.tlStatus().env, 'live');
};
const order = () => tl.tlPlaceOrder({ symbol: 'XAUUSD', side: 'buy', stopLoss: 3950, takeProfit: 4100, minStop: false });

(async () => {
  // Both logins saved: demo runs at once from live, with no Confirm card.
  reset();
  slots = { 1: login(1, 'live'), 2: login(2, 'demo'), 3: login(3, 'live') };
  await goLive();
  trades.push({ sync_id: 'live-trade', persona: 'talon', status: 'open', position_id: 'p1', symbol: 'XAUUSD' });
  let r = await cmd.writeTag({ name: 'TRADE_ACCOUNT', arg: 'demo' });
  assert.ok(!r.confirm, 'going to demo must not wait on a tap');
  assert.ok(!calls.includes('card'));
  assert.match(r.ok, /now on the DEMO account/);
  assert.match(r.ok, /1 position is still open on LIVE/, 'he has to be told about what stays on live');
  assert.strictEqual(tl.tlStatus().env, 'demo');
  assert.strictEqual(settings.talon_live, '0');
  await order();
  assert.deepStrictEqual(orders, ['demo']);
  // The live trade isn't visible from demo, and mustn't get booked as closed.
  assert.strictEqual((await allTrades()).length, 0, 'a parked trade is hidden on demo');
  assert.strictEqual(trades[0].status, 'open');

  // Going back to live needs the tap, and the trade comes back into view after it.
  r = await cmd.writeTag({ name: 'TRADE_ACCOUNT', arg: 'live' });
  assert.ok(r.confirm, 'going live always waits on a tap');
  assert.strictEqual(settings.talon_live, '0', 'nothing changes until he taps');
  await cmd.runAction('account', { env: 'live' });
  assert.strictEqual(tl.tlStatus().env, 'live');
  assert.strictEqual((await allTrades()).length, 1, 'parked trade is managed again back on its account');

  // No demo login saved: he can't reach demo, but live trading still stops.
  reset();
  slots = { 1: login(1, 'live'), 3: login(3, 'live') };
  await goLive();
  r = await cmd.writeTag({ name: 'TRADE_ACCOUNT', arg: 'demo' });
  assert.strictEqual(settings.talon_live, '0', 'must disarm even with no demo login');
  assert.match(r.ok, /LIVE trading is OFF/);
  assert.match(r.ok, /NOT on demo/, 'must not claim he moved');
  await assert.rejects(order(), /isn't armed/);
  assert.deepStrictEqual(orders, []);

  // The order-level gate holds for a path that skipped every other check.
  reset();
  slots = { 1: login(1, 'live'), 3: login(3, 'live') };
  await goLive();
  settings.talon_live = '0';
  await assert.rejects(order(), /isn't armed/);
  assert.deepStrictEqual(orders, []);
  settings.talon_live = '1';
  await order();
  assert.deepStrictEqual(orders, ['live'], 'an armed live account still trades');

  // A switch that only reached the setting (the app's sync) is followed before an order.
  reset();
  slots = { 1: login(1, 'live'), 2: login(2, 'demo'), 3: login(3, 'live') };
  await goLive();
  settings.talon_account = 'demo';
  settings.talon_live = '0';
  await order();
  assert.deepStrictEqual(orders, ['demo'], 'order follows the saved choice, not the stale session');

  console.log('account switch: all passed');
})().catch((e) => { console.error(e); process.exit(1); });

// A.R.A.'s script pass knows whose message it's passing on, with the right pronouns.
{
  const { relayHint } = require('../personaVoice');
  const woke = relayHint('Woke → Ara: Talon is long gold and the story is thin.');
  assert.match(woke, /Woke's message to you, in HIS words/);
  assert.match(woke, /Truth Analyst, a man \(he\/him\)/);
  assert.match(woke, /not you, not Mr\. Burrus, and not any other persona/);
  assert.match(woke, /his name, not the ordinary word/);
  assert.match(relayHint('Atlas → Ara: NVDA'), /in HER words.*a woman \(she\/her\)/);
  assert.strictEqual(relayHint('just a normal reply'), '');
  // Every persona on the roster, in both spellings, with their own pronouns.
  const { ROSTER, pronouns } = require('../personas');
  const { speakNames } = require('../voiceCues');
  for (const [id, p] of Object.entries(ROSTER)) {
    if (id === 'ara') continue;
    for (const opener of [`${p.name} → A.R.A.: hello`, `${speakNames(p.name).replace(/\.$/, '')} to Ara: hello`, speakNames(`${p.name} → A.R.A.: hello`)]) {
      const hint = relayHint(opener);
      assert.ok(hint.includes(`(${pronouns(id)})`), `${id} not recognized from "${opener}"`);
    }
  }
}
