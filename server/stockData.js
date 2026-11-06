// Real stock prices and the hard rules on A.T.L.A.S.'s picks. Candles come from
// Yahoo's chart endpoint (no key, unofficial: it can change without notice, and
// when it fails she makes no call rather than guessing a price). The rules here
// are code on purpose: an AI's stop or target that doesn't hold up never reaches
// Mr. Burrus. Long only, stocks and ETFs. Nothing here places an order.
const { analyzeStructure, formatTimeframe } = require('./marketStructure');

const CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const MIN_PRICE = 5;
const MIN_DOLLAR_VOLUME = 20e6; // average per day: below this, spreads and gaps eat the plan
const MIN_R = { short: 2, long: 2.5 };
const MIN_ATR_STOP = { short: 1, long: 2 }; // a stop inside normal daily noise just gets hit
const MAX_ABOVE_ZONE = { short: 0.05, long: 0.1 }; // a zone this far under price is a wish, not an entry
const MAX_HOLD_DAYS = { short: 45, long: 1825 };
const ENTRY_WINDOW_DAYS = { short: 7, long: 45 }; // never got the entry by then: the call is off
const DAY = 86400e3;
const SESSION_MS = 6.5 * 3600e3;

const cleanTicker = (t) => String(t || '').toUpperCase().trim().replace(/[^A-Z0-9.-]/g, '');
const money = (n) => `$${Number(n).toFixed(2)}`;

async function fetchChart(ticker, range, interval) {
  const url = `${CHART}${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`price data ${res.status} for ${ticker}`);
  const r = (await res.json())?.chart?.result?.[0];
  if (!r?.meta) throw new Error(`no price data for ${ticker}`);
  const q = r.indicators?.quote?.[0] || {};
  const bars = (r.timestamp || []).map((t, i) => ({ t: t * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] }))
    .filter((b) => [b.o, b.h, b.l, b.c].every((x) => x != null && isFinite(x))); // Yahoo leaves nulls in the forming bar
  return { meta: r.meta, bars };
}

async function stockQuote(ticker) {
  const t = cleanTicker(ticker);
  const { meta } = await fetchChart(t, '1d', '1d');
  const price = Number(meta.regularMarketPrice);
  if (!isFinite(price) || price <= 0) throw new Error(`no price for ${t}`);
  return { ticker: t, price };
}

function sma(bars, n) {
  if (bars.length < n) return null;
  return bars.slice(-n).reduce((a, b) => a + b.c, 0) / n;
}

// Everything A.T.L.A.S. gets to see on one ticker. Null fields stay null.
function summarize(ticker, meta, daily, weekly, now = Date.now()) {
  // A stock's day ends 6.5 hours after its open, not 24.
  const closed = daily.filter((b) => Number(b.t) + SESSION_MS <= now);
  const last20 = daily.slice(-20);
  const dollarVolume = last20.length ? last20.reduce((a, b) => a + (b.c * (b.v || 0)), 0) / last20.length : 0;
  const structure = analyzeStructure(closed);
  return {
    ticker, name: meta.longName || meta.shortName || ticker, type: meta.instrumentType, currency: meta.currency,
    price: Number(meta.regularMarketPrice), high52: meta.fiftyTwoWeekHigh, low52: meta.fiftyTwoWeekLow,
    sma50: sma(closed, 50), sma200: sma(closed, 200), atr: structure?.atr ?? null, dollarVolume, structure,
    weekly: analyzeStructure(weekly.slice(0, -1)), // this week's candle is still forming
  };
}

async function stockSnapshot(ticker) {
  const t = cleanTicker(ticker);
  if (!t) throw new Error('no ticker');
  const [d, w] = await Promise.all([fetchChart(t, '2y', '1d'), fetchChart(t, '5y', '1wk')]);
  return summarize(t, d.meta, d.bars, w.bars);
}

// Can this ticker be recommended at all? Returns a reason, or null if it can.
function tradable(s) {
  if (!s || !isFinite(s.price) || s.price <= 0) return 'no real price';
  if (s.currency !== 'USD') return `priced in ${s.currency || 'an unknown currency'}`;
  if (!['EQUITY', 'ETF'].includes(s.type)) return `is a ${s.type || 'unknown instrument'}, not a stock or ETF`;
  if (s.price < MIN_PRICE) return `under ${money(MIN_PRICE)}`;
  if (s.dollarVolume < MIN_DOLLAR_VOLUME) return 'too thinly traded';
  if (!s.atr) return 'not enough price history';
  return null;
}

const round = (v) => +Number(v).toFixed(2);

function formatSnapshot(s) {
  const f = (v) => (v == null ? '—' : round(v));
  const trend = s.sma50 && s.sma200 ? `, 50-day ${s.sma50 > s.sma200 ? 'above' : 'below'} the 200-day` : '';
  return [
    `${s.ticker} (${s.name}, ${s.type}): price ${money(s.price)}, 52-week ${f(s.low52)}–${f(s.high52)}, SMA50 ${f(s.sma50)}, SMA200 ${f(s.sma200)}${trend}, daily ATR14 ${f(s.atr)}, avg daily dollar volume $${Math.round(s.dollarVolume / 1e6)}M`,
    formatTimeframe('Daily', s.structure, s.price),
    formatTimeframe('Weekly', s.weekly, s.price),
  ].join('\n');
}

// A.T.L.A.S.'s plan against the real price. { pick } or { skip: reason }.
function validatePick(raw, snap, now = Date.now()) {
  const horizon = raw?.horizon === 'long' ? 'long' : raw?.horizon === 'short' ? 'short' : null;
  if (!horizon) return { skip: 'no horizon' };
  const why = tradable(snap);
  if (why) return { skip: `${snap?.ticker || 'ticker'} ${why}` };
  if (!/^(high|medium)$/i.test(String(raw.conviction || ''))) return { skip: 'conviction under medium' };
  const a = Number(raw.entryLow), b = Number(raw.entryHigh), stop = Number(raw.stop), target = Number(raw.target);
  if (![a, b, stop, target].every((x) => isFinite(x) && x > 0)) return { skip: 'missing a price' };
  const entryLow = Math.min(a, b), entryHigh = Math.max(a, b);
  if (stop >= entryLow) return { skip: `stop ${stop} isn't under the entry` };
  if (target <= entryHigh) return { skip: `target ${target} isn't over the entry` };
  if (snap.price <= stop) return { skip: `already through the stop (${money(snap.price)})` };
  if (snap.price >= target) return { skip: 'already at the target' };
  if (snap.price > entryHigh * (1 + MAX_ABOVE_ZONE[horizon])) return { skip: `entry zone is too far under the ${money(snap.price)} price` };
  const mid = (entryLow + entryHigh) / 2;
  const risk = mid - stop;
  if (risk < MIN_ATR_STOP[horizon] * snap.atr) return { skip: `stop is inside ${MIN_ATR_STOP[horizon]}× the daily ATR (${round(snap.atr)})` };
  const r = (target - mid) / risk;
  if (r < MIN_R[horizon]) return { skip: `pays ${r.toFixed(1)}R, needs ${MIN_R[horizon]}R` };
  const exitAt = Date.parse(raw.exitBy);
  if (!isFinite(exitAt) || exitAt <= now) return { skip: 'no future exit date' };
  if (exitAt > now + MAX_HOLD_DAYS[horizon] * DAY) return { skip: `exit date is past the ${MAX_HOLD_DAYS[horizon]}-day limit for a ${horizon} call` };
  const thesis = String(raw.thesis || '').trim();
  const getOutIf = String(raw.getOutIf || '').trim();
  if (!thesis || !getOutIf) return { skip: 'no thesis or no get-out condition' };
  return {
    pick: {
      id: `${snap.ticker}-${horizon}-${now}`, ticker: snap.ticker, name: snap.name, horizon,
      entryLow: round(entryLow), entryHigh: round(entryHigh), stop: round(stop), target: round(target), r: +r.toFixed(1),
      exitAt, entryExpires: now + ENTRY_WINDOW_DAYS[horizon] * DAY,
      conviction: String(raw.conviction).toLowerCase(), catalyst: String(raw.catalyst || '').trim().slice(0, 300), thesis: thesis.slice(0, 500), getOutIf: getOutIf.slice(0, 300),
      status: 'watching', createdAt: now, priceAtCall: snap.price,
    },
  };
}

// One price check on one pick: the next state, plus what to tell him (or null).
// Paper tracking: it assumes he gets in at the first price in the zone.
function stepPick(p, price, now = Date.now()) {
  if (p.status === 'watching') {
    if (price <= p.stop) return { pick: { ...p, status: 'cancelled', closedAt: now, reason: 'broke the stop before the entry' }, event: 'cancelled' };
    if (now > p.entryExpires) return { pick: { ...p, status: 'cancelled', closedAt: now, reason: 'never got the entry in time' }, event: 'cancelled' };
    if (price <= p.entryHigh) return { pick: { ...p, status: 'active', entryPrice: price, activatedAt: now }, event: 'entry' };
    return { pick: p, event: null };
  }
  if (p.status !== 'active') return { pick: p, event: null };
  if (price <= p.stop) return { pick: closePick(p, price, now, 'stop'), event: 'stop' };
  if (price >= p.target) return { pick: closePick(p, price, now, 'target'), event: 'target' };
  if (now >= p.exitAt) return { pick: closePick(p, price, now, 'time'), event: 'time' };
  return { pick: p, event: null };
}

function closePick(p, price, now, reason) {
  const entry = Number(p.entryPrice);
  const risk = entry - p.stop;
  const rMade = risk > 0 ? +((price - entry) / risk).toFixed(2) : null;
  return { ...p, status: 'closed', exitPrice: price, closedAt: now, reason, rMade, outcome: price > entry ? 'win' : price < entry ? 'loss' : 'flat' };
}

// Her real paper record. No trades yet reads as no record, not as a good one.
function recordLine(picks) {
  const done = picks.filter((p) => p.status === 'closed');
  if (!done.length) return 'No closed calls yet, so no record to go on.';
  const wins = done.filter((p) => p.outcome === 'win').length;
  const rs = done.filter((p) => p.rMade != null).map((p) => Number(p.rMade)).filter(isFinite);
  const avg = rs.length ? rs.reduce((a, x) => a + x, 0) / rs.length : 0;
  return `${done.length} closed: ${wins} wins, ${done.length - wins} not, average ${avg >= 0 ? '+' : ''}${avg.toFixed(2)}R (paper, assuming entry at the first price in the zone and exit at the first check past the level).`;
}

module.exports = { cleanTicker, stockQuote, stockSnapshot, summarize, tradable, formatSnapshot, validatePick, stepPick, closePick, recordLine };
