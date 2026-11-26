// T.A.L.O.N.'s Nasdaq desk (owner's request, 2026-11-20): the Nasdaq 100 index
// CFD on the same TradeLocker account, traded off the 1-minute chart with the
// three triggers from Nicholas Fischer's day-trading bots (his reel, transcript
// "Transcript — Video by nickafischer"):
//   1. a 1m candle closes across VWAP (anchored at the 9:30 ET open)
//   2. a 1m candle closes across the 50 EMA
//   3. a 1m candle closes outside the first 15 minutes' range (9:30-9:45 ET),
//      the first break each way each day
// Close above → buy, close below → sell. His bots buy 1-day options, which
// TradeLocker doesn't have, so this trades the index itself, and an index trade
// needs a stop the option never did:
//   - STOP past the trigger level and the signal candle's far end, plus 0.25×
//     the 1m ATR14, at least NAS_MIN_STOP (10) points; over NAS_MAX_STOP (60) → skip
//   - SIZE: the lots that lose NAS_MAX_LOSS ($50) at the stop, from the
//     instrument's contract size (no contract size → no trade, says so)
//   - TARGET 2R. One position at a time. Flat by 3:58 PM ET.
//   - DAY STOPS: NAS_DAILY_GOAL ($200) made → done for the day (his bots' "stop at
//     a set amount"); 3 losses in a day → done (ours, for choppy days).
//   - Regular session only, 9:30-3:55 ET weekdays; no triggers before 9:31.
//   - Trades whichever account T.A.L.O.N. is on, live included (owner, 2026-11-20);
//     tlPlaceOrder's live arming still applies. NAS_LIVE=0 holds it to demo.
// Pure code, no AI calls. Runs every minute in market hours, only while the app's
// auto-trade toggle is on. TALON_NASDAQ=off stops it. State: app_settings.talon_nasdaq.
// node server/scripts/test-talon-nasdaq.js.
const { getSetting, setSetting } = require('./syncStore');

const CANDIDATES = (process.env.NAS_SYMBOL ? [process.env.NAS_SYMBOL] : []).concat(['NAS100', 'US100', 'USTEC', 'NAS100USD', 'NDX100', 'NQ100', 'US100.cash', 'NAS100.cash']);
const DAILY_GOAL = Number(process.env.NAS_DAILY_GOAL || 200);
const MAX_LOSS = Number(process.env.NAS_MAX_LOSS || 50);
const MAX_LOSSES = Number(process.env.NAS_MAX_LOSSES || 3);
const MIN_STOP = Number(process.env.NAS_MIN_STOP || 10);
const MAX_STOP = Number(process.env.NAS_MAX_STOP || 60);
const TARGET_R = 2;
const KEY = 'talon_nasdaq';
const SETUP = 'nasdaq';

// Retired (owner, 2026-11-26: "stop trading Nasdaq … put the same strategy we already
// use"): Nasdaq trades on the gold/Bitcoin playbook now (talonBrain.js SYMBOLS).
// TALON_NASDAQ=on brings this 1m desk back.
function enabled() { return String(process.env.TALON_NASDAQ || '').toLowerCase() === 'on'; }

function etParts(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
}
const etDay = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));
const OPEN = 9 * 60 + 30, OR_END = 9 * 60 + 45, LAST_ENTRY = 15 * 60 + 55, FLAT = 15 * 60 + 58;

// --- the strategy (pure) --------------------------------------------------------

// Today's regular-session 1m bars (closed only), oldest first.
function sessionBars(bars, now = Date.now()) {
  const day = etDay(now);
  return (bars || []).filter((b) => Number(b.t) + 60e3 <= now && etDay(Number(b.t)) === day && etParts(Number(b.t)).min >= OPEN && etParts(Number(b.t)).min < 16 * 60);
}

// VWAP per bar from the open; CFD feeds often carry no real volume, so with
// none it's the running mean of the typical price.
function vwapSeries(bars) {
  let pv = 0, vol = 0, n = 0, tp = 0;
  const hasVol = bars.some((b) => Number(b.v) > 0);
  return bars.map((b) => {
    const typ = (b.h + b.l + b.c) / 3;
    if (hasVol) { pv += typ * (Number(b.v) || 0); vol += Number(b.v) || 0; return vol ? pv / vol : typ; }
    tp += typ; n += 1; return tp / n;
  });
}

function emaSeries(bars, len = 50) {
  const k = 2 / (len + 1); let e = null;
  return bars.map((b, i) => { e = i === 0 ? b.c : b.c * k + e * (1 - k); return i >= len - 1 ? e : null; });
}

function atr14(bars) {
  const tr = bars.slice(-15).map((b, i, a) => (i ? Math.max(b.h - b.l, Math.abs(b.h - a[i - 1].c), Math.abs(b.l - a[i - 1].c)) : b.h - b.l)).slice(1);
  return tr.length ? tr.reduce((s, x) => s + x, 0) / tr.length : 0;
}

// The first 15 minutes' high and low, once those bars are all in.
function openingRange(sess) {
  const or = sess.filter((b) => etParts(Number(b.t)).min < OR_END);
  if (or.length < 15) return null;
  return { high: Math.max(...or.map((b) => b.h)), low: Math.min(...or.map((b) => b.l)) };
}

// What the bar that just closed triggered, if anything: { side, trigger, level }.
// `all` = the last day or so of 1m bars (for the 50 EMA), `sess` = today's session.
// `orUsed` = { buy, sell } breaks already taken today.
function signal(all, sess, orUsed = {}) {
  if (sess.length < 2) return null;
  const b = sess[sess.length - 1], p = sess[sess.length - 2];
  if (etParts(Number(b.t)).min < OPEN + 1) return null;
  const crosses = [];
  const vw = vwapSeries(sess);
  const v1 = vw[vw.length - 1], v0 = vw[vw.length - 2];
  if (p.c <= v0 && b.c > v1) crosses.push({ side: 'buy', trigger: 'VWAP', level: v1 });
  if (p.c >= v0 && b.c < v1) crosses.push({ side: 'sell', trigger: 'VWAP', level: v1 });
  const ix = all.findIndex((x) => Number(x.t) === Number(b.t));
  const em = emaSeries(all.slice(0, ix + 1));
  const e1 = em[em.length - 1], e0 = em[em.length - 2];
  if (ix > 0 && e1 != null && e0 != null) {
    if (p.c <= e0 && b.c > e1) crosses.push({ side: 'buy', trigger: '50 EMA', level: e1 });
    if (p.c >= e0 && b.c < e1) crosses.push({ side: 'sell', trigger: '50 EMA', level: e1 });
  }
  const or = etParts(Number(b.t)).min >= OR_END ? openingRange(sess) : null;
  if (or) {
    if (!orUsed.buy && p.c <= or.high && b.c > or.high) crosses.push({ side: 'buy', trigger: 'opening-range break', level: or.high });
    if (!orUsed.sell && p.c >= or.low && b.c < or.low) crosses.push({ side: 'sell', trigger: 'opening-range break', level: or.low });
  }
  if (!crosses.length) return null;
  const sides = new Set(crosses.map((c) => c.side));
  if (sides.size > 1) return null; // a bar crossing both ways at once is noise
  // The level furthest behind the close sets the stop; name every trigger that fired.
  const dir = crosses[0].side === 'buy' ? 1 : -1;
  const far = crosses.reduce((a, c) => ((c.level - a.level) * dir < 0 ? c : a));
  return { side: crosses[0].side, trigger: crosses.map((c) => c.trigger).join(' + '), level: far.level, bar: b, ors: crosses.some((c) => c.trigger === 'opening-range break') };
}

// Stop past the trigger level and the signal candle's far end, plus 0.25 ATR.
function plan(sig, atr) {
  const dir = sig.side === 'buy' ? 1 : -1;
  const entry = sig.bar.c;
  const beyond = dir === 1 ? Math.min(sig.level, sig.bar.l) : Math.max(sig.level, sig.bar.h);
  let stop = beyond - dir * 0.25 * (atr || 0);
  if ((entry - stop) * dir < MIN_STOP) stop = entry - dir * MIN_STOP;
  const dist = (entry - stop) * dir;
  if (dist > MAX_STOP) return { skip: `stop would be ${dist.toFixed(1)} points away, over the ${MAX_STOP}-point cap` };
  return { side: sig.side, entry, stop: +stop.toFixed(2), target: +(entry + dir * TARGET_R * dist).toFixed(2), dist: +dist.toFixed(2) };
}

// Lots that lose at most MAX_LOSS at the stop: points × contract size × lots.
function lotsFor(dist, contractSize, maxLoss = MAX_LOSS) {
  if (!(contractSize > 0) || !(dist > 0)) return 0;
  return Math.floor((maxLoss / (dist * contractSize)) * 100) / 100;
}

// Today's closed Nasdaq desk trades: net and losses.
function dayTally(trades, day = etDay()) {
  const today = trades.filter((t) => t.setup === SETUP && t.status === 'closed' && etDay(Number(t.closed_at || 0)) === day);
  return { net: +today.reduce((s, t) => s + (Number(t.realized_pl) || 0), 0).toFixed(2), losses: today.filter((t) => t.outcome === 'loss').length, count: today.length };
}

// --- the broker side --------------------------------------------------------------

let symbolCache = null;
async function nasSymbol() {
  if (symbolCache) return symbolCache;
  const tl = require('./tradeLocker');
  const names = await tl.tlListInstruments();
  const norm = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const hit = CANDIDATES.map(norm).map((c) => names.find((n) => norm(n) === c)).find(Boolean)
    || names.find((n) => /^(NAS|US|USTEC|NDX).*100|^USTEC|^NAS100/i.test(n));
  if (!hit) throw new Error(`no Nasdaq 100 instrument on this account (looked for ${CANDIDATES.slice(0, 4).join(', ')}…)`);
  symbolCache = hit;
  return hit;
}

async function load() {
  let s; try { s = JSON.parse(await getSetting(KEY, '{}')) || {}; } catch { s = {}; }
  return { day: '', orUsed: {}, done: '', lastBar: 0, log: [], ...s };
}
const save = (s) => setSetting(KEY, JSON.stringify({ ...s, log: (s.log || []).slice(-40) }));

let lastRun = null;
let busy = false;

async function tick(now = Date.now()) {
  if (!enabled() || busy) return { skipped: busy ? 'busy' : 'off' };
  busy = true;
  try { lastRun = { at: now, ...(await run(now)) }; return lastRun; }
  catch (e) { console.error('talon nasdaq failed:', e.message); lastRun = { at: now, error: e.message }; return lastRun; }
  finally { busy = false; }
}

async function run(now) {
  const { wd, min } = etParts(now);
  if (['Sat', 'Sun'].includes(wd) || min < OPEN || min >= 16 * 60) return { skipped: 'market closed' };
  if ((await getSetting('auto_trade', '0')) !== '1') return { skipped: 'auto-trade is OFF (Settings › Trading)' };
  const tl = require('./tradeLocker');
  const journal = require('./tradeJournal');
  const alerts = require('./talonAlerts');
  const env = await tl.tlActiveEnv().catch(() => 'demo');
  // Live allowed (owner, 2026-11-20); tlPlaceOrder still refuses unless LIVE TRADING is armed. NAS_LIVE=0 keeps it on demo.
  if (env !== 'demo' && process.env.NAS_LIVE === '0') return { skipped: 'Nasdaq desk is held to demo (NAS_LIVE=0)' };
  const s = await load();
  const day = etDay(now);
  if (s.day !== day) Object.assign(s, { day, orUsed: {}, done: '', lastBar: 0 });
  const sym = await nasSymbol();
  const trades = await journal.allTrades();
  const open = trades.filter((t) => t.setup === SETUP && t.status === 'open');

  // Flat by 3:58.
  if (min >= FLAT) {
    for (const t of open) {
      if (t.position_id) await tl.tlClosePosition(t.position_id).catch((e) => console.error('talon nasdaq failed: close at the bell —', e.message));
    }
    if (open.length && !s.flatNoted) { s.flatNoted = day; await alerts.araNote(`📉 T.A.L.O.N. → A.R.A.: Nasdaq desk is flat for the day — closed ${open.length} position${open.length > 1 ? 's' : ''} before the bell.`).catch(() => {}); }
    await save(s);
    return { flat: open.length };
  }
  if (s.done) { await save(s); return { skipped: `done for the day: ${s.done}` }; }
  const tally = dayTally(trades, day);
  if (tally.net >= DAILY_GOAL || tally.losses >= MAX_LOSSES) {
    s.done = tally.net >= DAILY_GOAL ? `daily goal hit (+$${tally.net})` : `${tally.losses} losses today (net $${tally.net})`;
    await save(s);
    await alerts.araNote(`🏁 T.A.L.O.N. → A.R.A.: Nasdaq desk is done for today — ${s.done}. ${tally.count} trade${tally.count === 1 ? '' : 's'}.`).catch(() => {});
    return { done: s.done };
  }
  if (open.length || min >= LAST_ENTRY) { await save(s); return { holding: open.length }; }

  const all = (await tl.tlHistory(sym, '1m', 600)).filter((b) => Number(b.t) + 60e3 <= now);
  const sess = sessionBars(all, now);
  const last = sess[sess.length - 1];
  if (!last || Number(last.t) <= s.lastBar) { await save(s); return { waiting: 'no new bar' }; }
  s.lastBar = Number(last.t);
  const sig = signal(all, sess, s.orUsed);
  if (!sig) { await save(s); return { quiet: true }; }
  if (sig.ors) s.orUsed[sig.side] = true;
  const p = plan(sig, atr14(all));
  const note = (what) => { s.log.push({ at: now, side: sig.side, trigger: sig.trigger, what }); };
  if (p.skip) { note(p.skip); await save(s); return { skipped: p.skip }; }
  const contract = await contractSize(sym);
  const lots = lotsFor(p.dist, contract);
  if (!lots) {
    const why = contract ? `even 0.01 lot would lose over $${MAX_LOSS} at a ${p.dist}-point stop` : `couldn't read ${sym}'s contract size, so it can't be sized to $${MAX_LOSS}`;
    note(why); await save(s);
    if (!contract) console.error(`talon nasdaq failed: ${why}`);
    return { skipped: why };
  }
  const target = p.target; // one Nasdaq position at a time, so no shared targets to snap to
  try {
    const r = await tl.tlPlaceOrder({ symbol: sym, side: p.side, qty: lots, stopLoss: p.stop, takeProfit: target, minStop: false, maxQty: lots });
    const why = `Nasdaq desk: 1m ${sig.trigger} ${p.side === 'buy' ? 'close above' : 'close below'}, stop ${p.dist} pts past it, ${TARGET_R}R target, sized to $${MAX_LOSS}`;
    await journal.recordTradeOpen({ symbol: sym, side: p.side, qty: r.qty, entry: p.entry, stopLoss: r.stopLoss, takeProfit: r.takeProfit, rationale: why, orderId: r.orderId, setup: SETUP, auto: true });
    note(`entered ${r.qty} lots`);
    await save(s);
    return { entered: { ...p, lots: r.qty, trigger: sig.trigger } };
  } catch (e) {
    note(`order failed: ${e.message}`); await save(s);
    alerts.orderRejected({ symbol: sym, side: p.side, error: e.message });
    throw new Error(`order — ${e.message}`);
  }
}

// $ per point per 1.0 lot. TradeLocker's instrument details carry it as the
// contract size; NAS_CONTRACT_SIZE overrides.
let contractCache = null;
async function contractSize(sym) {
  if (Number(process.env.NAS_CONTRACT_SIZE) > 0) return Number(process.env.NAS_CONTRACT_SIZE);
  if (contractCache) return contractCache;
  const n = await require('./tradeLocker').tlInstrumentDetails(sym).then((d) => Number(d && (d.contractSize ?? d.lotSize ?? d.contractMultiplier))).catch(() => 0);
  if (n > 0) contractCache = n;
  return n > 0 ? n : 0;
}

async function statusText() {
  if (!enabled()) return 'The 1-minute Nasdaq desk is retired (2026-11-26). Nasdaq (NAS100) now trades on the same playbook as gold and Bitcoin: 1H location, 15m trigger, scalp + swing, sized so a position loses at most $40 at its stop, fresh setups 9:45 AM-3:30 PM ET. [TRADE_STATS: NAS100 | 30] shows how it is doing.';
  const s = await load();
  const t = dayTally(await require('./tradeJournal').allTrades().catch(() => []));
  const log = (s.log || []).filter((x) => etDay(x.at) === etDay()).slice(-8).map((x) => `- ${new Date(x.at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ${x.side} on ${x.trigger}: ${x.what}`);
  return `Nasdaq desk (${symbolCache || 'NAS100'}, 1m VWAP / 50 EMA / opening-range triggers, same account as gold and Bitcoin): today ${t.count} closed, net $${t.net}, ${t.losses} losses. Goal $${DAILY_GOAL}, $${MAX_LOSS} max per trade, done after ${MAX_LOSSES} losses.${s.done && s.day === etDay() ? ` Done for today: ${s.done}.` : ''}${log.length ? `\n${log.join('\n')}` : ''}`;
}

module.exports = { tick, statusText, signal, plan, lotsFor, dayTally, vwapSeries, emaSeries, openingRange, sessionBars, enabled, getLastRun: () => lastRun, SETUP };
