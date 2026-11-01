// T.A.L.O.N.'s quick scalps — a second playbook on the 5m chart, separate from
// the 1D/4H trend-pullback setups in talonBrain.js. Runs on every 5-min
// auto-trade tick (the cron fires 20s after each 5m close).
//
//   1. BIAS (1H + 15m). Both trend the same way (last close vs SMA20), and the
//      5m EMA20 slopes that way too.
//   2. PULLBACK (5m). One of the last 3 closed 5m bars dipped into the EMA20
//      (within 0.25 ATR of it) without breaking a full ATR through it.
//   3. TRIGGER (5m). The bar that just closed is a rejection back in the trend
//      direction: closes past the EMA20 and past the prior close, in the outer
//      40% of its range, not a spike (under 2.5× ATR), and not already more than
//      1 ATR away from the EMA20.
//   4. STOP past the last 5 bars' swing + 0.3 ATR, at least gold $3 / Bitcoin
//      0.3% and 1× the 5m ATR14. Wider than gold $8 / Bitcoin 0.8% → skip.
//   5. TARGET: his brain confirms the setup and picks the next 5m/15m level —
//      at least 1.5R (else no trade), capped at 3R. Stop goes to break-even at
//      +1R. Otherwise held to stop or target, like everything else.
//
// The filter is code (no AI cost); the brain is called only when it fires.
// Limits: one 0.02 position, one quick scalp open per market at a time, never
// against an open position of his on that market. Gold only 3 AM-12 PM ET
// (London + New York morning); both markets sit out 8:25-8:45 AM ET weekdays
// (data releases). Two quick losses in a row on a market → 1 hour off it;
// three in a day → done there for the day. No add-ons, no doubling, and they
// don't count toward MAX_PAIRS. TALON_QUICK=off stops it.
const { tlHistory, tlQuote, tlSnapshot, tlFormatSnapshot, tlPlaceOrder, tlModifyPosition, summarizeBars, MAX_QTY } = require('./tradeLocker');
const { allTrades, recordTradeOpen, TRADER_ID } = require('./tradeJournal');
const { upsertSyncRow, saveMemory } = require('./syncStore');
const { tradeOpened, orderRejected } = require('./talonAlerts');
const { claudeText } = require('./llm');
const { SYMBOLS } = require('./talonBrain');

const BAR = 5 * 60e3;
const STOP = {
  XAUUSD: { floor: () => 3, cap: () => 8 },
  BTCUSD: { floor: (px) => px * 0.003, cap: (px) => px * 0.008 },
};
const MIN_R = 1.5, MAX_R = 3, BE_AT_R = 1;
const CRYPTO = /^(BTC|ETH|SOL|XRP|LTC|DOGE|ADA|BNB)/;

let lastRun = null; // surfaced by GET /trade/status

function etParts(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
}
const etDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));

// Is this market in a window where quick scalps are allowed right now?
function sessionOk(sym, marketOpen) {
  const { wd, min } = etParts();
  const weekday = !['Sat', 'Sun'].includes(wd);
  if (weekday && min >= 8 * 60 + 25 && min < 8 * 60 + 45) return 'data-release window (8:25-8:45 ET)';
  if (CRYPTO.test(sym)) return null;
  if (!marketOpen) return 'market closed';
  if (min < 3 * 60 || min >= 12 * 60) return 'outside London/NY morning (3 AM-12 PM ET)';
  return null;
}

function ema(vals, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e = vals.slice(0, n).reduce((a, x) => a + x, 0) / n;
  for (let i = 0; i < vals.length; i++) { if (i >= n) e = vals[i] * k + e * (1 - k); out.push(i < n - 1 ? null : e); }
  return out;
}
function atr14(bars) {
  const tr = bars.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - bars[i].c), Math.abs(b.l - bars[i].c)));
  const last = tr.slice(-14);
  return last.reduce((a, x) => a + x, 0) / (last.length || 1);
}

// The coded filter (rules 1-4). Returns { side, stopLoss, dist, ... } or { skip }.
function findSetup({ sym, bars5, s15, s1h, quote }) {
  if (!s15 || !s1h) return { skip: 'no 15m/1H data' };
  if (s15.trend !== s1h.trend) return { skip: `1H ${s1h.trend} / 15m ${s15.trend} disagree` };
  const dir = s1h.trend === 'up' ? 1 : -1;
  if (bars5.length < 40) return { skip: 'not enough 5m history' };
  const closes = bars5.map((b) => b.c);
  const e = ema(closes, 20);
  const n = bars5.length - 1;
  const b = bars5[n], prev = bars5[n - 1], E = e[n];
  const atr = atr14(bars5);
  if (!atr || E == null) return { skip: 'no 5m ATR/EMA' };
  if ((E - e[n - 3]) * dir <= 0) return { skip: '5m EMA20 not sloping with the trend' };
  // 2. Pullback into the EMA20 in the last 3 bars, not a breakdown through it.
  const last3 = bars5.slice(-3);
  const deepest = dir > 0 ? Math.min(...last3.map((x) => x.l)) : Math.max(...last3.map((x) => x.h));
  const eAtDeep = e[n - 2] ?? E;
  if ((deepest - (eAtDeep + dir * 0.25 * atr)) * dir > 0) return { skip: 'no pullback to the 5m EMA20' };
  if ((eAtDeep - deepest) * dir > atr) return { skip: 'pullback broke through the 5m EMA20' };
  // 3. Rejection candle.
  const range = b.h - b.l;
  if (!range) return { skip: 'flat bar' };
  if ((b.c - b.o) * dir <= 0) return { skip: 'last 5m bar not in trend direction' };
  if ((b.c - E) * dir <= 0 || (b.c - prev.c) * dir <= 0) return { skip: 'no close back past the EMA20 / prior close' };
  const closePos = dir > 0 ? (b.c - b.l) / range : (b.h - b.c) / range;
  if (closePos < 0.6) return { skip: 'weak close (not in the outer 40% of the bar)' };
  if (range > 2.5 * atr) return { skip: 'spike bar — not chasing it' };
  if ((b.c - E) * dir > atr) return { skip: 'already extended from the EMA20' };
  // 4. Stop off structure, floored and capped.
  const px = Number(dir > 0 ? quote.ask ?? quote.mid : quote.bid ?? quote.mid);
  if (!isFinite(px)) return { skip: 'no quote' };
  const spread = Number(quote.ask) - Number(quote.bid);
  if (isFinite(spread) && spread > 0.35 * atr) return { skip: `spread ${spread.toFixed(2)} too wide for the 5m ATR ${atr.toFixed(2)}` };
  const recent = bars5.slice(-5);
  const swing = dir > 0 ? Math.min(...recent.map((x) => x.l)) : Math.max(...recent.map((x) => x.h));
  const cfg = STOP[sym] || STOP.BTCUSD;
  const dist = Math.max((px - (swing - dir * 0.3 * atr)) * dir, cfg.floor(px), atr);
  if (dist > cfg.cap(px)) return { skip: `stop would need ${dist.toFixed(2)} — over the ${cfg.cap(px).toFixed(2)} cap` };
  const swingHi = dir > 0 ? Math.max(...bars5.slice(-24).map((x) => x.h)) : Math.min(...bars5.slice(-24).map((x) => x.l));
  return { side: dir > 0 ? 'buy' : 'sell', dir, entry: +px.toFixed(2), dist, stopLoss: +(px - dir * dist).toFixed(2), atr, ema: E, swingHi };
}

// Rule 5: his brain looks at the setup the filter found and picks the target.
async function confirm({ sym, setup, snapText, bars5 }) {
  const { side, entry, dist, stopLoss, atr, ema: E, swingHi } = setup;
  const minTp = +(entry + setup.dir * MIN_R * dist).toFixed(2);
  const sys = `You are T.A.L.O.N., running UNATTENDED, on your QUICK-SCALP desk — separate from your 1D/4H setups. A coded 5m filter just flagged a ${side.toUpperCase()} on ${sym}: 1H and 15m trend agree, price pulled back into the 5m EMA20 and the 5m bar that just closed rejected back in the trend direction. The stop is already set by code at ${stopLoss} (${dist.toFixed(2)} from entry ~${entry}).
Your job: (a) say whether this is a clean continuation or a trap — "none" if price is pinned under/over a nearby 15m or 1H level in the trade's way, the 15m bars are choppy and overlapping, the move is late in an exhausted leg, or (gold) the dollar is moving against it; (b) if it's clean, the target: the next clear 5m/15m structure level in the trade direction. It must be at least ${MIN_R}R (${minTp} or further); if the nearest level in the way is closer than that, answer "none". One 0.02 position, held to stop or target.
Reply with ONLY a JSON object, no prose, no code fence:
{"action":"enter"|"none","takeProfit":<price>,"rationale":"<=120 chars"}`;
  const recent = bars5.slice(-12).map((b) => `${+b.o.toFixed(2)}/${+b.h.toFixed(2)}/${+b.l.toFixed(2)}/${+b.c.toFixed(2)}`).join('  ');
  const user = `MARKET SNAPSHOT ${sym}:\n${snapText}\n5m: EMA20 ${E.toFixed(2)}, ATR14 ${atr.toFixed(2)}, 2-hour ${side === 'buy' ? 'high' : 'low'} ${swingHi}; last 12 bars o/h/l/c ${recent}`;
  const raw = await claudeText(sys, [{ role: 'user', content: user }], { maxTokens: 250 });
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : { action: 'none' }; } catch { return { action: 'none' }; }
}

// Rule 5's break-even: +1R → stop to entry. Once per trade.
async function manage(open) {
  for (const t of open) {
    if (t.be_moved || !t.position_id) continue;
    const entry = Number(t.entry_fill ?? t.entry_ref), stop = Number(t.stop_loss);
    const dir = t.side === 'buy' ? 1 : -1;
    if (!isFinite(entry) || !isFinite(stop) || (entry - stop) * dir <= 0) continue;
    const q = await tlQuote(t.symbol).catch(() => null);
    const price = Number(dir > 0 ? q?.bid ?? q?.mid : q?.ask ?? q?.mid);
    if (!isFinite(price) || (price - entry) * dir < BE_AT_R * (entry - stop) * dir) continue;
    try {
      await tlModifyPosition(t.position_id, { stopLoss: entry, symbol: t.symbol });
      // stop_loss stays the original stop, so the trade's R still reads right.
      await upsertSyncRow('trades', t.sync_id, { ...t, be_moved: 1, be_stop: entry, updated_at: Date.now() });
      console.log(`talon-quick: #${t.position_id} ${t.symbol} +1R — stop to break-even ${entry}`);
    } catch (e) { console.error(`talon-quick: break-even #${t.position_id} failed —`, e.message); }
  }
}

// Two quick losses in a row on a market → an hour off it; three today → done for the day.
function discipline(sym, mine) {
  const closed = mine.filter((t) => t.status === 'closed' && t.symbol === sym).sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0));
  const today = etDay(Date.now());
  const lossesToday = closed.filter((t) => t.outcome === 'loss' && etDay(t.closed_at || 0) === today).length;
  if (lossesToday >= 3) return `${lossesToday} quick losses today — done on it until tomorrow`;
  const scored = closed.filter((t) => t.outcome === 'win' || t.outcome === 'loss');
  if (scored[0]?.outcome === 'loss' && scored[1]?.outcome === 'loss' && Date.now() - (scored[0].closed_at || 0) < 60 * 60e3) return 'two quick losses in a row — an hour off it';
  return null;
}

async function quickTick({ marketOpen }) {
  if (process.env.TALON_QUICK === 'off') return { skipped: 'TALON_QUICK=off' };
  const trades = await allTrades();
  const mine = trades.filter((t) => t.auto && t.setup === 'quick');
  await manage(mine.filter((t) => t.status === 'open')).catch((e) => console.error('talon-quick: manage failed —', e.message));
  const out = {};
  for (const sym of SYMBOLS) {
    const why = sessionOk(sym, marketOpen)
      || (mine.some((t) => t.status === 'open' && t.symbol === sym) ? 'a quick scalp is already open' : null)
      || discipline(sym, mine);
    if (why) { out[sym] = why; continue; }
    try {
      const [raw5, h15, h1] = await Promise.all([tlHistory(sym, '5m', 80), tlHistory(sym, '15m', 60), tlHistory(sym, '1H', 60)]);
      const bars5 = raw5.filter((b) => Number(b.t) + BAR <= Date.now()); // closed bars only
      const quote = await tlQuote(sym);
      const setup = findSetup({ sym, bars5, s15: summarizeBars(h15), s1h: summarizeBars(h1), quote });
      if (setup.skip) { out[sym] = setup.skip; continue; }
      if (trades.some((t) => t.status === 'open' && t.symbol === sym && t.side !== setup.side)) { out[sym] = `${setup.side} would go against an open position`; continue; }
      const snap = await tlSnapshot(sym);
      const dec = await confirm({ sym, setup, snapText: tlFormatSnapshot(snap), bars5 });
      if (dec.action !== 'enter') { out[sym] = `filter fired, brain passed — ${dec.rationale || 'no reason given'}`; console.log(`talon-quick: ${sym} ${setup.side} passed — ${dec.rationale || ''}`); continue; }
      const { dir, entry, dist, stopLoss } = setup;
      let tp = Number(dec.takeProfit);
      if (!isFinite(tp) || (tp - entry) * dir < MIN_R * dist - 1e-9) { out[sym] = `target ${dec.takeProfit} under ${MIN_R}R — skipped`; continue; }
      if ((tp - entry) * dir > MAX_R * dist) tp = +(entry + dir * MAX_R * dist).toFixed(2);
      const rationale = `quick 5m — ${dec.rationale || 'EMA20 pullback rejection'}`.slice(0, 400);
      let s;
      try { s = await tlPlaceOrder({ symbol: sym, side: setup.side, qty: MAX_QTY, stopLoss, takeProfit: tp }); }
      catch (e) { orderRejected({ symbol: sym, side: `${setup.side} (quick scalp)`, error: e.message }); out[sym] = `order rejected — ${e.message}`; continue; }
      await recordTradeOpen({ symbol: sym, side: s.side, qty: s.qty, entry, stopLoss, takeProfit: tp, rationale, orderId: s.orderId,
        setup: 'quick', auto: true, setupId: `${sym}-q-${Date.now()}`, alert: false }).catch(() => {});
      tradeOpened({ symbol: sym, side: s.side, qty: s.qty, entry, stopLoss, takeProfit: tp, rationale, setup: 'quick' });
      await saveMemory(TRADER_ID, `[quick scalp] opened ${s.side} ${sym} @ ~${entry} · SL ${stopLoss} TP ${tp} — ${rationale}`).catch(() => {});
      console.log(`talon-quick: ${s.side.toUpperCase()} ${s.qty} ${sym} @ ~${entry} · SL ${stopLoss} TP ${tp} (${((tp - entry) * dir / dist).toFixed(1)}R) — ${dec.rationale || ''}`);
      out[sym] = `entered ${s.side} @ ~${entry}`;
    } catch (e) { out[sym] = `error — ${e.message}`; console.error(`talon-quick: ${sym} failed —`, e.message); }
  }
  lastRun = { at: Date.now(), ...out };
  return out;
}

module.exports = { quickTick, findSetup, status: () => lastRun };
