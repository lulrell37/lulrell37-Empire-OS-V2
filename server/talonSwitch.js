// T.A.L.O.N.'s off switch (owner, 2026-11-26: "I told A.R.A. to have Talon stop
// trading and hours later he starts again. If I say stop it should switch off until
// I say start again").
//
// Before this there was no tag for it: T.A.L.O.N. and A.R.A. could only say "okay",
// the synced `auto_trade` toggle stayed on, and his next cycle traded. W.I.R.E.'s news
// trades didn't check `auto_trade` at all.
//
// [TRADING_OFF] (A.R.A. and J.A.R.V.I.S. only, owner 2026-11-26; T.A.L.O.N. relays it to her) sets `talon_halt` = 1 and
// `auto_trade` = 0 and cancels his resting quick-scalp limits. While halted,
// tlPlaceOrder refuses every automatic order: setups, add-ons, quick scalps,
// re-entries, news trades and the Nasdaq desk. Only an order he gives by hand
// ([TRADE_ENTER], `manual: true`) goes through. Open positions keep their broker stop and target;
// closing them is [TRADE_CLOSE]. [TRADING_ON] runs only on his own message that says
// start / resume / turn on (never a wake-up, a loop or a persona's own idea).
//
// One market at a time (owner, 2026-11-26: "tell Ara to have Talon stop trading single
// pairs"): [TRADING_OFF: bitcoin] switches off only that market (`talon_halt_markets`);
// the others keep trading. [TRADING_ON: bitcoin] on his own words turns it back on.
//
// Done for the day after two losses (owner, 2026-11-26: "if we lose twice in a day he
// stops trading for that day"): two losing trades closed today (ET, all markets
// together; a scalp + swing pair or a setup with its add-ons counts once) stop every
// automatic order until midnight ET. Open trades keep being managed. A.R.A. tells him
// once. His own "start trading" lifts it for the rest of the day (two more losses stop
// it again). TALON_DAY_LOSSES (2) sets the number, TALON_DAY_STOP=off turns it off.
// node server/scripts/test-talon-switch.js.
const { getSetting, setSetting } = require('./syncStore');

let deps = null;
const base = () => ({
  getSetting, setSetting,
  trades: () => require('./tradeJournal').allTrades(),
  tell: (text) => require('./talonAlerts').araNote(text),
  cancelQuickLimits: async (only = null) => {
    const raw = await getSetting('talon_quick_pending', '[]').catch(() => '[]');
    let list = [];
    try { list = JSON.parse(raw || '[]') || []; } catch { list = []; }
    const hit = only ? list.filter((p) => only.includes(String(p.sym || p.symbol || '').toUpperCase())) : list;
    let n = 0;
    for (const p of hit) {
      try { await require('./tradeLocker').tlCancelOrder(p.orderId); n++; } catch (e) { console.error(`talon switch failed: cancelling limit ${p.orderId}: ${e.message}`); }
    }
    if (hit.length) await setSetting('talon_quick_pending', JSON.stringify(list.filter((p) => !hit.includes(p))));
    return n;
  },
});
const d = () => (deps ? { ...base(), ...deps } : base());

async function isHalted() {
  return String(await d().getSetting('talon_halt', '0')) === '1';
}

// His own words turning trading back on. Not "don't start", not a question.
const START = /\b(start|resume|restart|turn (it |him |trading |talon )?(back )?on|switch (it |him |trading )?(back )?on|back on|un-?pause|unhalt|let (him|talon) trade|go back to trading|start trading again)\b/i;
const NOT = /\b(don'?t|do not|never|no)\s+(start|resume|turn|switch)|\?\s*$/i;
const ownerStarts = (t) => START.test(String(t || '')) && !NOT.test(String(t || ''));

// --- one market ---------------------------------------------------------------
const MARKETS = {
  XAUUSD: ['gold', /\b(gold|xau(usd)?)\b/i],
  BTCUSD: ['Bitcoin', /\b(bitcoin|btc(usd)?|crypto)\b/i],
  NAS100: ['Nasdaq', /\b(nasdaq|nas ?100|us ?100|ustec|nq|ndx|the index)\b/i],
  EURUSD: ['EUR/USD', /\b(eur ?\/? ?usd|euro dollar|euro|fiber)\b/i],
  GBPUSD: ['GBP/USD', /\b(gbp ?\/? ?usd|pound|cable|sterling)\b/i],
  USDJPY: ['USD/JPY', /\b(usd ?\/? ?jpy|dollar[- ]yen|yen)\b/i],
};
const FOREX = /\b(forex|fx|currenc(y|ies)|currency pairs?)\b/i;
const marketName = (sym) => (MARKETS[sym] ? MARKETS[sym][0] : sym);
function marketsIn(text) {
  const t = String(text || '');
  const hit = Object.keys(MARKETS).filter((k) => MARKETS[k][1].test(t));
  // "forex" / "currencies" means all three pairs.
  if (FOREX.test(t)) for (const k of ['EURUSD', 'GBPUSD', 'USDJPY']) if (!hit.includes(k)) hit.push(k);
  return hit;
}
async function haltedMarkets() {
  try { return JSON.parse(await d().getSetting('talon_halt_markets', '{}')) || {}; } catch { return {}; }
}
const canon = (sym) => { const u = String(sym || '').toUpperCase(); return /^(NAS|US100|USTEC|NDX|NQ)/.test(u) ? 'NAS100' : u; };
async function marketHalted(sym) { return !!(await haltedMarkets())[canon(sym)]; }
async function marketOff(syms, { by = '', why = '' } = {}) {
  const h = await haltedMarkets();
  for (const k of syms) h[k] = { at: Date.now(), by, why: String(why).slice(0, 200) };
  await d().setSetting('talon_halt_markets', JSON.stringify(h));
  const n = await d().cancelQuickLimits(syms).catch((e) => { console.error(`talon switch failed: ${e.message}`); return 0; });
  const names = syms.map(marketName).join(' and ');
  const still = Object.keys(MARKETS).filter((k) => !h[k]).map(marketName);
  return `TRADING_OFF: ✓ T.A.L.O.N. is switched OFF on ${names} only, and stays off there until Mr. Burrus says start. ${still.length ? `${still.length > 2 ? `${still.slice(0, -1).join(', ')} and ${still[still.length - 1]}` : still.join(' and ')} still trade${still.length === 1 ? 's' : ''}.` : 'That is every market now.'}${n ? ` ${n} resting limit order${n === 1 ? '' : 's'} there cancelled.` : ''} Open ${names} positions keep their stops and targets.`;
}
async function marketOn(syms) {
  const h = await haltedMarkets();
  for (const k of syms) delete h[k];
  await d().setSetting('talon_halt_markets', JSON.stringify(h));
  const off = Object.keys(h).map(marketName);
  return `TRADING_ON: ✓ T.A.L.O.N. trades ${syms.map(marketName).join(' and ')} again from his next cycle.${off.length ? ` Still off: ${off.join(', ')}.` : ''}${(await isHalted()) ? ' But ALL trading is still switched off — he has to say start trading for that.' : ''}`;
}

// --- two losses, done for the day --------------------------------------------------
const DAY_LOSSES = () => Math.max(1, Number(process.env.TALON_DAY_LOSSES) || 2);
const etDay = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
// Losing trades closed today: each decision once (legs grouped by setup / pair).
function lossesToday(trades, day = etDay()) {
  const groups = new Map();
  for (const t of trades || []) {
    if (t.status !== 'closed' || !t.closed_at || etDay(Number(t.closed_at)) !== day) continue;
    const k = t.setup_id || t.pair_id || t.sync_id || t.id;
    (groups.get(k) || groups.set(k, []).get(k)).push(t);
  }
  const lost = [];
  for (const g of groups.values()) {
    const net = g.reduce((a, t) => a + (Number(t.realized_pl) || 0), 0);
    if (g.some((t) => t.outcome === 'loss') && net < 0) lost.push({ symbol: g[0].symbol, side: g[0].side, net: +net.toFixed(2), at: Math.max(...g.map((t) => Number(t.closed_at))) });
  }
  return lost.sort((a, b) => a.at - b.at);
}
async function dayStop(now = Date.now()) {
  if (process.env.TALON_DAY_STOP === 'off') return { stopped: false };
  const day = etDay(now);
  const lost = lossesToday(await d().trades(), day);
  let cleared = {};
  try { cleared = JSON.parse(await d().getSetting('talon_day_cleared', '{}')) || {}; } catch { cleared = {}; }
  const base = cleared.day === day ? Number(cleared.losses) || 0 : 0;
  return { stopped: lost.length - base >= DAY_LOSSES(), day, lost, count: lost.length };
}
// Called on every 5-min tick: trips it, tells him once, cancels resting limits.
async function checkDayStop() {
  const ds = await dayStop();
  if (!ds.stopped) return ds;
  if (String(await d().getSetting('talon_day_stop_told', '')) !== ds.day) {
    await d().setSetting('talon_day_stop_told', ds.day);
    await d().cancelQuickLimits().catch(() => 0);
    const list = ds.lost.map((l) => `${marketName(canon(l.symbol))} ${l.side} ${l.net < 0 ? '-' : '+'}$${Math.abs(l.net).toFixed(2)}`).join(', ');
    await Promise.resolve(d().tell(`🛑 T.A.L.O.N. → A.R.A.: that's ${ds.count} losses today (${list}), so I'm done trading for the day — no new trades on any market until tomorrow. Open trades keep their stops and targets. If you want me back in today, say start trading.`)).catch((e) => console.error(`talon switch failed: day stop note: ${e.message}`));
  }
  return ds;
}
async function clearDayStop() {
  const ds = await dayStop();
  if (!ds.stopped) return '';
  await d().setSetting('talon_day_cleared', JSON.stringify({ day: ds.day, losses: ds.count }));
  return ` The two-losses stop for today is lifted too (${ds.count} losses so far; ${DAY_LOSSES()} more and he stops again).`;
}

// Why an automatic order on `symbol` can't go out right now ('' = it can).
async function blocked(symbol) {
  if (await isHalted()) return 'T.A.L.O.N. is switched OFF by Mr. Burrus — no automatic trades until he says start';
  if (symbol && await marketHalted(symbol)) return `T.A.L.O.N. is switched OFF on ${marketName(canon(symbol))} by Mr. Burrus — no automatic ${marketName(canon(symbol))} trades until he says start`;
  const ds = await dayStop().catch((e) => { console.error(`talon switch failed: day stop check: ${e.message}`); return { stopped: false }; });
  if (ds.stopped) return `T.A.L.O.N. is done for the day — ${ds.count} losing trades today; no new trades until tomorrow`;
  return '';
}
const isBlockMessage = (msg) => /^T\.A\.L\.O\.N\. is (switched OFF|done for the day)/.test(String(msg || ''));

async function off({ by = '', why = '' } = {}) {
  await d().setSetting('talon_halt', '1');
  await d().setSetting('auto_trade', '0');
  await d().setSetting('talon_halt_at', JSON.stringify({ at: Date.now(), by, why: String(why).slice(0, 200) }));
  const n = await d().cancelQuickLimits().catch((e) => { console.error(`talon switch failed: ${e.message}`); return 0; });
  return `TRADING_OFF: ✓ T.A.L.O.N. is switched OFF and stays off until Mr. Burrus says start. No new trades of any kind (setups, add-ons, quick scalps, re-entries, news trades, Nasdaq)${n ? `; ${n} resting limit order${n === 1 ? '' : 's'} cancelled` : ''}. Open positions keep their stops and targets — close them with [TRADE_CLOSE] if he wants out.`;
}

async function on() {
  await d().setSetting('talon_halt', '0');
  await d().setSetting('auto_trade', '1');
  return 'TRADING_ON: ✓ T.A.L.O.N. is switched back ON — he trades again from his next cycle.';
}

// The tag, from runInjections. asked = his own message this turn ('' for loops / wake-ups).
// `arg` names the market(s) ("bitcoin", "gold and nasdaq"); none = all trading.
// Stopping with no market named stops everything (the safe side). Starting with no
// market named in the tag uses the markets his own words name, so "start Bitcoin
// again" never turns gold back on too.
const ALL_WORDS = /\b(all|everything|every market|all (of )?(the )?(markets|pairs))\b/i;
async function tag(name, persona, { asked = '', arg = '' } = {}) {
  if (!['ara', 'jarvis'].includes(persona) && name !== 'TRADING_STATUS') return `${name}: only A.R.A. and J.A.R.V.I.S. switch T.A.L.O.N. on or off — [RELAY_TO: ara | Mr. Burrus says: ${String(asked || '').slice(0, 200)}]. Nothing changed.`;
  let named = marketsIn(arg);
  if (!named.length && name === 'TRADING_ON' && !String(arg).trim() && !ALL_WORDS.test(String(asked))) named = marketsIn(asked);
  if (name === 'TRADING_OFF') return named.length ? marketOff(named, { by: persona, why: asked }) : off({ by: persona, why: asked });
  if (name === 'TRADING_ON') {
    if (/^\[(SENT ON YOUR OWN|The server restarted)/.test(String(asked || '')) || !ownerStarts(asked)) {
      return 'TRADING_ON refused: T.A.L.O.N. stays OFF — only Mr. Burrus\'s own words ("start trading", "turn Talon back on", "start trading Bitcoin again") switch him on. Nothing changed.';
    }
    if (named.length) return `${await marketOn(named)}${await clearDayStop()}`;
    // "Start trading" with no market: everything back on, single markets included.
    const was = Object.keys(await haltedMarkets()).map(marketName);
    await d().setSetting('talon_halt_markets', '{}');
    return `${await on()}${was.length ? ` ${was.join(' and ')} ${was.length === 1 ? 'is' : 'are'} back on too.` : ''}${await clearDayStop()}`;
  }
  if (name === 'TRADING_STATUS') return statusText();
  return '';
}

async function statusText() {
  const parts = [];
  if (await isHalted()) {
    let h = {};
    try { h = JSON.parse(await d().getSetting('talon_halt_at', '{}')) || {}; } catch { h = {}; }
    parts.push(`ALL trading OFF since ${h.at ? new Date(h.at).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' : 'earlier'} — waiting for him to say start`);
  } else parts.push(`ON (auto-trade ${String(await d().getSetting('auto_trade', '0')) === '1' ? 'on' : 'off in Settings'})`);
  const m = await haltedMarkets();
  if (Object.keys(m).length) parts.push(`switched off on: ${Object.keys(m).map(marketName).join(', ')}`);
  const ds = await dayStop().catch(() => ({ stopped: false, count: 0 }));
  parts.push(ds.stopped ? `DONE FOR TODAY after ${ds.count} losses (back tomorrow unless he says start)` : `${ds.count || 0} losing trade${ds.count === 1 ? '' : 's'} today (stops for the day at ${DAY_LOSSES()})`);
  return `TRADING_STATUS: ${parts.join('; ')}.`;
}

const SWITCH_TOOLS = ` - [TRADING_OFF] — switch T.A.L.O.N. OFF the moment Mr. Burrus says stop trading / stop Talon / pause trading: no new trades of any kind until he says start, and his resting limit orders are cancelled. Open positions stay with their stops (add [TRADE_CLOSE: all] only if he says close them). Never just say he stopped: it hasn't happened unless this tag ran.
 - [TRADING_OFF: bitcoin] (or gold, nasdaq, "gold and nasdaq") — when he names a market, only that one stops; the rest keep trading. Name exactly what he named.
 - [TRADING_ON] / [TRADING_ON: bitcoin] — switch him (or that market) back on, only when Mr. Burrus himself says start / resume / turn it back on. A plain "start trading" turns every market back on and lifts today's two-losses stop.
 - [TRADING_STATUS] — whether T.A.L.O.N. is on, which markets are off, and today's losses (two losing trades in a day and he's done until tomorrow, by code).`;

module.exports = { isHalted, off, on, tag, ownerStarts, SWITCH_TOOLS, MARKETS, marketsIn, marketHalted, haltedMarkets, marketOff, marketOn, lossesToday, dayStop, checkDayStop, blocked, isBlockMessage, statusText, _setDeps: (x) => { deps = x; } };
