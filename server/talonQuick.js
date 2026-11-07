// T.A.L.O.N.'s quick scalps — a second playbook on the 5m chart, separate from
// the 4H/1H trend-pullback setups in talonBrain.js. Runs on every 5-min
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
//   4. STOP beyond the key level, never on it, sized for the 5m: past the far
//      side of the zone (the last 5 bars' swing, the 5m EMA20, a round number
//      sitting with them) plus one 5m ATR14, at least gold $3 / Bitcoin 0.3%.
//      Wider than gold $8 / Bitcoin 0.8% → skip. Its own minimum, not the
//      main rule's $10 / 0.8% (that would make every quick scalp a swing).
//   5. TARGET: his brain confirms the setup and picks the next 5m/15m level —
//      at least 1.5R (else no trade), capped at 3R. Stop goes to break-even at
//      +1R. Otherwise held to stop or target, like everything else.
//   6. ENTRY back at the zone, not the confirmation close: by the time the
//      rejection bar closes, price has often run. So unless it's still sitting
//      at the 5m EMA20 (within 0.15 ATR), the order is a LIMIT at the EMA20
//      (limitPlan), the stop where rule 4 put it (floored again from the better
//      price) and R measured from the limit. It rests up to 3 bars (15 min) and
//      is cancelled if it hasn't filled, or if price reaches the target or the
//      stop first. It goes in the journal and the alert when it fills
//      (pendingTick; app_settings.talon_quick_pending).
//
// The filter is code (no AI cost); the brain is called only when it fires.
// Limits: one 0.02 position, one quick scalp open per market at a time, never
// against an open position of his on that market. Gold only 3 AM-12 PM ET
// (London + New York morning); both markets sit out 8:25-8:45 AM ET weekdays
// (data releases). Two quick losses in a row on a market → 1 hour off it;
// three in a day → done there for the day. No add-ons, no doubling, and they
// don't count toward MAX_PAIRS. TALON_QUICK=off stops it.
const { tlHistory, tlQuote, tlSnapshot, tlFormatSnapshot, tlPlaceOrder, tlModifyPosition, tlCancelOrder, tlOrderState, summarizeBars, MAX_QTY } = require('./tradeLocker');
const { allTrades, recordTradeOpen, TRADER_ID } = require('./tradeJournal');
const { upsertSyncRow, saveMemory, getSetting, setSetting } = require('./syncStore');
const alerts = require('./talonAlerts');
const { orderRejected } = alerts;
const { claudeText } = require('./llm');
const { SYMBOLS } = require('./talonBrain');
const { analyzeStructure, formatTimeframe } = require('./marketStructure');

const BAR = 5 * 60e3;
const STOP = {
  XAUUSD: { floor: () => 3, cap: () => 8 },
  BTCUSD: { floor: (px) => px * 0.003, cap: (px) => px * 0.008 },
};
const ROUND = { XAUUSD: 10, BTCUSD: 1000 }; // round numbers that act as levels
const MIN_R = 1.5, MAX_R = 3, BE_AT_R = 1;
const AT_ZONE_ATR = 0.15; // within this of the EMA20, the market price is already the zone
const LIMIT_BARS = 3;      // a limit rests this many 5m bars, then it's cancelled
const CRYPTO = /^(BTC|ETH|SOL|XRP|LTC|DOGE|ADA|BNB)/;

let lastRun = null; // surfaced by GET /trade/status

// Every time the filter fires, what happened next (the brain's call, a skip, the
// entry) — kept in app_settings.talon_quick_log (last 40) so "why no quick
// scalps?" has a real answer ([QUICK_LOG] for T.A.L.O.N. / A.R.A.).
async function logQuick(sym, side, outcome) {
  try {
    const raw = await getSetting('talon_quick_log', '[]');
    const list = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    list.push({ at: Date.now(), sym, side, outcome: String(outcome).slice(0, 200) });
    await setSetting('talon_quick_log', JSON.stringify(list.slice(-40)));
  } catch (e) { console.error('talon-quick: log failed —', e.message); }
}
async function quickLogText() {
  const raw = await getSetting('talon_quick_log', '[]').catch(() => '[]');
  let list = [];
  try { list = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { /* */ }
  const t = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const now = lastRun ? `LAST 5-MIN CHECK (${t(lastRun.at)} ET): ${Object.entries(lastRun).filter(([k]) => k !== 'at').map(([k, v]) => `${k}: ${v}`).join(' · ')}` : 'No quick-scalp check has run since the server started.';
  if (!list.length) return `${now}\nThe 5m filter hasn't fired since logging started.`;
  return `${now}\nEVERY TIME THE 5M FILTER FIRED (newest last):\n${list.map((x) => `${t(x.at)} ${x.sym} ${String(x.side || '').toUpperCase()} → ${x.outcome}`).join('\n')}`;
}

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
  // The key-level zone the stop has to clear: the swing, the EMA20, and a
  // round number sitting within one 5m ATR past them.
  const recent = bars5.slice(-5);
  const swing = dir > 0 ? Math.min(...recent.map((x) => x.l)) : Math.max(...recent.map((x) => x.h));
  let far = dir > 0 ? Math.min(swing, E) : Math.max(swing, E);
  const step = ROUND[sym];
  if (step) {
    const round = dir > 0 ? Math.floor(far / step) * step : Math.ceil(far / step) * step;
    if (Math.abs(far - round) <= atr) far = round;
  }
  const cfg = STOP[sym] || STOP.BTCUSD;
  const dist = Math.max((px - (far - dir * atr)) * dir, cfg.floor(px), atr);
  const cap = cfg.cap(px);
  if (dist > cap) return { skip: `stop would need ${dist.toFixed(2)} — over the ${cap.toFixed(2)} cap` };
  const swingHi = dir > 0 ? Math.max(...bars5.slice(-24).map((x) => x.h)) : Math.min(...bars5.slice(-24).map((x) => x.l));
  return { side: dir > 0 ? 'buy' : 'sell', dir, entry: +px.toFixed(2), dist, stopLoss: +(px - dir * dist).toFixed(2), atr, ema: E, swingHi, zone: far };
}

// Rule 6: where the order goes. Already at the EMA20 → market at the quote.
// Otherwise a limit at the EMA20, the stop kept beyond the zone (pushed out to
// the floor if the better price brought it too close) and the target re-checked
// for 1.5R and capped at 3R from the limit. Returns { limit|null, entry,
// stopLoss, dist, takeProfit } or { skip }.
function limitPlan({ sym, setup, takeProfit }) {
  const { dir, entry: px, stopLoss, atr, ema: E } = setup;
  const cfg = STOP[sym] || STOP.BTCUSD;
  const away = (px - E) * dir;
  let limit = null, entry = px, stop = stopLoss;
  if (away > AT_ZONE_ATR * atr) {
    limit = +E.toFixed(2); entry = limit;
    if ((entry - stop) * dir < cfg.floor(entry)) stop = +(entry - dir * cfg.floor(entry)).toFixed(2);
  }
  const dist = (entry - stop) * dir;
  if (!(dist > 0)) return { skip: 'stop not below the entry' };
  let tp = Number(takeProfit);
  if (!isFinite(tp) || (tp - entry) * dir < MIN_R * dist - 1e-9) return { skip: `target ${takeProfit} under ${MIN_R}R` };
  if ((tp - entry) * dir > MAX_R * dist) tp = +(entry + dir * MAX_R * dist).toFixed(2);
  return { limit, entry, stopLoss: stop, dist, takeProfit: tp };
}

async function loadPending() {
  const raw = await getSetting('talon_quick_pending', '[]').catch(() => '[]');
  try { const l = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); return Array.isArray(l) ? l : []; } catch { return []; }
}
const savePending = (list) => setSetting('talon_quick_pending', JSON.stringify(list));

// Every tick: each resting quick limit is filled (→ journal + alert), gone, or
// still waiting — cancelled once it's had its 3 bars, or once price has hit the
// target or the stop without it (the move happened without us).
async function pendingTick() {
  const list = await loadPending();
  if (!list.length) return list;
  const keep = [];
  for (const p of list) {
    const dir = p.side === 'buy' ? 1 : -1;
    let st;
    try { st = await tlOrderState(p.orderId); } catch (e) { console.error(`talon-quick: limit ${p.orderId} check failed —`, e.message); keep.push(p); continue; }
    if (st.state === 'filled') {
      const entry = st.avgPrice ?? p.limit;
      await recordTradeOpen({ symbol: p.sym, side: p.side, qty: p.qty, entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, rationale: p.rationale,
        orderId: p.orderId, setup: 'quick', auto: true, setupId: p.setupId, alert: false }).catch(() => {});
      alerts.tradeOpened({ symbol: p.sym, side: p.side, qty: p.qty, entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, rationale: p.rationale, setup: 'quick', limitFilled: true });
      await saveMemory(TRADER_ID, `[quick scalp] limit filled ${p.side} ${p.sym} @ ${entry} · SL ${p.stopLoss} TP ${p.takeProfit} — ${p.rationale}`).catch(() => {});
      await logQuick(p.sym, p.side, `LIMIT FILLED @ ${entry} · SL ${p.stopLoss} · TP ${p.takeProfit}`);
      console.log(`talon-quick: limit ${p.side} ${p.sym} filled @ ${entry}`);
      continue;
    }
    if (st.state === 'gone') {
      await logQuick(p.sym, p.side, `limit @ ${p.limit} ended unfilled (${st.status})`);
      alerts.limitEnded({ symbol: p.sym, side: p.side, limit: p.limit, why: `the broker shows it ${String(st.status).toLowerCase()}, unfilled` });
      continue;
    }
    let why = Date.now() >= p.expiresAt ? `not filled in ${LIMIT_BARS} bars` : null;
    if (!why) {
      const q = await tlQuote(p.sym).catch(() => null);
      const px = Number(q?.mid);
      if (isFinite(px) && (px - p.takeProfit) * dir >= 0) why = `price reached the target ${p.takeProfit} without it`;
      else if (isFinite(px) && (p.stopLoss - px) * dir >= 0) why = `price hit the stop ${p.stopLoss} before it filled`;
    }
    if (!why) { keep.push(p); continue; }
    try { await tlCancelOrder(p.orderId); }
    catch (e) {
      // It may have filled in the meantime: look again next tick rather than lose it.
      console.error(`talon-quick: cancel ${p.orderId} failed —`, e.message); keep.push(p); continue;
    }
    await logQuick(p.sym, p.side, `limit @ ${p.limit} cancelled — ${why}`);
    alerts.limitEnded({ symbol: p.sym, side: p.side, limit: p.limit, why: `cancelled, ${why}` });
    console.log(`talon-quick: limit ${p.side} ${p.sym} @ ${p.limit} cancelled — ${why}`);
  }
  await savePending(keep).catch((e) => console.error('talon-quick: pending save failed —', e.message));
  return keep;
}

// Rule 5: his brain looks at the setup the filter found and picks the target.
async function confirm({ sym, setup, snapText, bars5 }) {
  const { side, entry, dist, stopLoss, atr, ema: E, swingHi } = setup;
  const minTp = +(entry + setup.dir * MIN_R * dist).toFixed(2);
  const sys = `You are T.A.L.O.N., running UNATTENDED, on your QUICK-SCALP desk — separate from your 4H/1H setups. A coded 5m filter just flagged a ${side.toUpperCase()} on ${sym}: 1H and 15m trend agree, price pulled back into the 5m EMA20 and the 5m bar that just closed rejected back in the trend direction. The stop is already set by code at ${stopLoss} (${dist.toFixed(2)} from entry ~${entry}) — beyond the key-level zone at ${+setup.zone.toFixed(2)} plus a 5m ATR.
The filter has already done the checking — your default is to TAKE it. Answer "none" only for a concrete, nameable reason: a specific 15m or 1H level sitting in the way closer than ${MIN_R}R (${minTp}), or price already in the middle of a sharp reversal against the trade. "Could be choppy" or general caution is not a reason — he wants these trades taken. If you pass, the rationale must name the level or the move.
Target: the next clear 5m/15m structure level in the trade direction (resting liquidity, an opposing FVG or order block, from the SMART-MONEY READ and 5m read below), at least ${MIN_R}R (${minTp} or further) — if structure is unclear, use ${minTp} itself. One 0.02 position, held to stop or target.
Reply with ONLY a JSON object, no prose, no code fence:
{"action":"enter"|"none","takeProfit":<price>,"rationale":"<=120 chars"}`;
  const recent = bars5.slice(-12).map((b) => `${+b.o.toFixed(2)}/${+b.h.toFixed(2)}/${+b.l.toFixed(2)}/${+b.c.toFixed(2)}`).join('  ');
  const user = `MARKET SNAPSHOT ${sym}:\n${snapText}\n5m: EMA20 ${E.toFixed(2)}, ATR14 ${atr.toFixed(2)}, 2-hour ${side === 'buy' ? 'high' : 'low'} ${swingHi}; last 12 bars o/h/l/c ${recent}\n${formatTimeframe('5m', analyzeStructure(bars5), entry)}`;
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
  const pending = await pendingTick().catch((e) => { console.error('talon-quick: pending check failed —', e.message); return []; });
  const out = {};
  for (const sym of SYMBOLS) {
    const resting = pending.find((p) => p.sym === sym);
    const why = (resting ? `a quick limit ${resting.side} @ ${resting.limit} is waiting to fill` : null)
      || (mine.some((t) => t.status === 'open' && t.symbol === sym) ? 'a quick scalp is already open' : null)
      || sessionOk(sym, marketOpen)
      || discipline(sym, mine);
    if (why) { out[sym] = why; continue; }
    try {
      const [raw5, h15, h1] = await Promise.all([tlHistory(sym, '5m', 80), tlHistory(sym, '15m', 60), tlHistory(sym, '1H', 60)]);
      const bars5 = raw5.filter((b) => Number(b.t) + BAR <= Date.now()); // closed bars only
      const quote = await tlQuote(sym);
      const setup = findSetup({ sym, bars5, s15: summarizeBars(h15), s1h: summarizeBars(h1), quote });
      if (setup.skip) { out[sym] = setup.skip; continue; }
      if (trades.some((t) => t.status === 'open' && t.symbol === sym && t.side !== setup.side)) { out[sym] = `${setup.side} would go against an open position`; await logQuick(sym, setup.side, out[sym]); continue; }
      const snap = await tlSnapshot(sym);
      const dec = await confirm({ sym, setup, snapText: tlFormatSnapshot(snap), bars5 });
      if (dec.action !== 'enter') { out[sym] = `filter fired, brain passed — ${dec.rationale || 'no reason given'}`; await logQuick(sym, setup.side, out[sym]); console.log(`talon-quick: ${sym} ${setup.side} passed — ${dec.rationale || ''}`); continue; }
      const plan = limitPlan({ sym, setup, takeProfit: dec.takeProfit });
      if (plan.skip) { out[sym] = `${plan.skip} — skipped`; await logQuick(sym, setup.side, out[sym]); continue; }
      const { dir } = setup;
      const { entry, dist, stopLoss, takeProfit: tp, limit } = plan;
      const rationale = `quick 5m — ${dec.rationale || 'EMA20 pullback rejection'}`.slice(0, 400);
      let s;
      try { s = await tlPlaceOrder({ symbol: sym, side: setup.side, qty: MAX_QTY, stopLoss, takeProfit: tp, minStop: false, limitPrice: limit }); }
      catch (e) { orderRejected({ symbol: sym, side: `${setup.side} (quick scalp)`, error: e.message }); out[sym] = `order rejected — ${e.message}`; await logQuick(sym, setup.side, out[sym]); continue; }
      if (limit != null) {
        // Rests at the zone; the journal and the alert wait for the fill (pendingTick).
        const list = await loadPending();
        list.push({ orderId: s.orderId, sym, side: s.side, qty: s.qty, limit, stopLoss, takeProfit: tp, rationale,
          setupId: `${sym}-q-${Date.now()}`, placedAt: Date.now(), expiresAt: Date.now() + LIMIT_BARS * BAR - 30e3 });
        await savePending(list).catch(() => {});
        console.log(`talon-quick: LIMIT ${s.side.toUpperCase()} ${s.qty} ${sym} @ ${limit} (close was ${setup.entry}) · SL ${stopLoss} TP ${tp} (${((tp - entry) * dir / dist).toFixed(1)}R) — ${dec.rationale || ''}`);
        out[sym] = `limit ${s.side} @ ${limit} placed (close was ${setup.entry})`;
        await logQuick(sym, s.side, `LIMIT @ ${limit} (close ${setup.entry}) · SL ${stopLoss} · TP ${tp} · ${LIMIT_BARS} bars to fill`);
        alerts.limitPlaced({ symbol: sym, side: s.side, qty: s.qty, limit, marketPrice: setup.entry, stopLoss, takeProfit: tp, rationale, minutes: LIMIT_BARS * 5 });
        continue;
      }
      await recordTradeOpen({ symbol: sym, side: s.side, qty: s.qty, entry, stopLoss, takeProfit: tp, rationale, orderId: s.orderId,
        setup: 'quick', auto: true, setupId: `${sym}-q-${Date.now()}`, alert: false }).catch(() => {});
      alerts.tradeOpened({ symbol: sym, side: s.side, qty: s.qty, entry, stopLoss, takeProfit: tp, rationale, setup: 'quick' });
      await saveMemory(TRADER_ID, `[quick scalp] opened ${s.side} ${sym} @ ~${entry} · SL ${stopLoss} TP ${tp} — ${rationale}`).catch(() => {});
      console.log(`talon-quick: ${s.side.toUpperCase()} ${s.qty} ${sym} @ ~${entry} · SL ${stopLoss} TP ${tp} (${((tp - entry) * dir / dist).toFixed(1)}R) — ${dec.rationale || ''}`);
      out[sym] = `entered ${s.side} @ ~${entry}`;
      await logQuick(sym, s.side, `ENTERED @ ~${entry} · SL ${stopLoss} · TP ${tp}`);
    } catch (e) { out[sym] = `error — ${e.message}`; console.error(`talon-quick: ${sym} failed —`, e.message); if (/claude|anthropic|xai|credit|api/i.test(e.message)) await logQuick(sym, '', out[sym]); }
  }
  lastRun = { at: Date.now(), ...out };
  return out;
}

module.exports = { quickTick, findSetup, limitPlan, pendingTick, quickLogText, status: () => lastRun };
