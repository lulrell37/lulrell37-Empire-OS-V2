// T.A.L.O.N.'s re-entry after a stop hunt (TALON_REENTRY=off to stop).
//
// A setup stops out, but the move through the stop was a sweep — a wick that
// took the stops and came straight back — not a real breakdown. He gets back in
// once, at the better price, with the stop past the sweep:
//   - a setup of his (scalp / swing / lone scalp — not quick scalps, add-ons,
//     news or hand trades) closed at its stop, and none of that setup is still open
//   - he watches that market for REENTRY_WINDOW_MS (4h) after the stop-out
//   - price went no further than SWEEP_MAX_ATR (1×) the 1H ATR14 past the old
//     stop — deeper than that is a breakdown and the watch ends
//   - a CLOSED 15m candle then closes back on the trade's side of the old stop
//   - the 4H trend still agrees with the trade's side
//   - new stop = the sweep's extreme + STOP_BUFFER_ATR (0.2×) the 1H ATR, then
//     guardStop (the main stop rule's minimum and danger zone) like any setup
//   - the original targets: the furthest has to pay MIN_R (2R) from the new entry
//   - one copy (not doubled on Bitcoin), scalp + swing when the swing is valid,
//     counted in MAX_PAIRS; a full cap waits for a slot inside the window
//   - ONE re-entry per setup: re-entry trades carry setup_id `<setup>:re` and
//     never start a watch of their own
// Runs on the 5-min tick, no AI calls. State: app_settings.talon_reentry.
const { getSetting, setSetting, saveMemory } = require('./syncStore');
const { tlHistory, tlSnapshot, tlPlaceOrder, MAX_QTY } = require('./tradeLocker');
const { guardStop, tradeContext } = require('./talonBrain');
const { allTrades, recordTradeOpen, sharedTargets, TRADER_ID } = require('./tradeJournal');
const { closedBars } = require('./marketStructure');
const alerts = require('./talonAlerts');

const REENTRY_WINDOW_MS = 4 * 3600e3;
const SWEEP_MAX_ATR = 1.0;
const STOP_BUFFER_ATR = 0.2;
const MIN_R = 2;
const STOPPED_R = -0.7; // closed at -0.7R or worse = it was the stop, not a break-even or hand close
const M15 = 15 * 60e3;
const SKIP_SETUPS = new Set(['quick', 'add', 'manual', 'news']);
const CRYPTO = /^(BTC|ETH|SOL|XRP|LTC|DOGE|ADA|BNB)/;

function enabled() { return String(process.env.TALON_REENTRY || '').toLowerCase() !== 'off'; }
const num = (v) => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
const groupKey = (t) => t.setup_id || t.pair_id || t.sync_id;

// A closed trade of his that its stop took out.
function stoppedOut(t) {
  if (!t || !t.auto || t.status !== 'closed' || t.outcome !== 'loss') return false;
  if (SKIP_SETUPS.has(t.setup) || String(t.setup_id || '').endsWith(':re') || t.closed_by === 'owner') return false;
  const entry = num(t.entry_fill) ?? num(t.entry_ref), stop = num(t.stop_loss), exit = num(t.exit_price);
  if (num(t.r_multiple) != null) return Number(t.r_multiple) <= STOPPED_R;
  if (entry == null || stop == null || exit == null) return false;
  return Math.abs(exit - stop) <= 0.3 * Math.abs(entry - stop);
}

// New watches from the journal: setups that stopped out inside the window with
// nothing of theirs still open. -> [{ key, watch }]
function newWatches(trades, state, now = Date.now()) {
  const groups = {};
  for (const t of trades) { if (!t.auto || t.setup === 'add') continue; const k = groupKey(t); (groups[k] || (groups[k] = [])).push(t); }
  const out = [];
  for (const [key, g] of Object.entries(groups)) {
    if (state[key] || String(key).endsWith(':re')) continue;
    if (g.some((t) => t.status === 'open')) continue;
    const hit = g.filter(stoppedOut);
    if (!hit.length) continue;
    const t0 = hit[0];
    const closedAt = Math.max(...hit.map((t) => Number(t.closed_at) || 0));
    if (!closedAt || now - closedAt > REENTRY_WINDOW_MS) continue;
    const dir = t0.side === 'buy' ? 1 : -1;
    const tps = g.map((t) => num(t.take_profit)).filter((v) => v != null).sort((a, b) => (a - b) * dir); // nearest first
    if (!tps.length) continue;
    const swing = g.find((t) => t.setup === 'swing');
    out.push({ key, watch: {
      symbol: String(t0.symbol).toUpperCase(), side: t0.side, entry: num(t0.entry_fill) ?? num(t0.entry_ref), stop: num(t0.stop_loss),
      takeProfit: tps[0], swingTakeProfit: swing && tps.length > 1 ? tps[tps.length - 1] : null,
      rationale: t0.rationale || '', closedAt, status: 'watching', armedAt: now,
    } });
  }
  return out;
}

// The decision, pure (no broker calls) so it can be tested:
//   watch  — from newWatches
//   bars   — closed 15m bars ({ t, o, h, l, c }) covering the stop-out onward
//   snap   — tlSnapshot (1H ATR, 4H/1D trend, structure for guardStop)
//   price  — the price he'd get now
// -> { wait: why } | { end: status, why } | { enter: { stopLoss, takeProfit, swingTakeProfit, sweep, risk } }
function reentryCheck({ watch: w, bars, snap, price, now = Date.now() }) {
  if (now - w.closedAt > REENTRY_WINDOW_MS) return { end: 'expired', why: 'no reclaim within 4 hours' };
  const dir = w.side === 'buy' ? 1 : -1;
  const atr = Number(snap?.candles?.['1H']?.atr14);
  if (!(atr > 0)) return { wait: 'no 1H ATR' };
  const since = (bars || []).filter((b) => Number(b.t) + M15 > w.closedAt); // the bar the stop hit in, and every one after
  if (!since.length) return { wait: 'no closed 15m candle since the stop-out yet' };
  const sweep = dir > 0 ? Math.min(...since.map((b) => Number(b.l))) : Math.max(...since.map((b) => Number(b.h)));
  const depth = (w.stop - sweep) * dir;
  if (depth > SWEEP_MAX_ATR * atr) return { end: 'broke', why: `price ran ${depth.toFixed(2)} past the stop (over 1× the 1H ATR ${atr.toFixed(2)}) — a breakdown, not a sweep` };
  const last = since[since.length - 1];
  if (Number(last.t) + M15 <= w.closedAt) return { wait: 'no 15m close after the stop-out yet' };
  if ((Number(last.c) - w.stop) * dir <= 0) return { wait: `no 15m close back ${dir > 0 ? 'above' : 'below'} ${w.stop} yet` };
  const px = Number(price);
  if (!isFinite(px) || (px - w.stop) * dir <= 0) return { wait: `price ${price} isn't back past ${w.stop}` };
  const { h4, against4H } = tradeContext({ side: w.side, snap });
  if (against4H) return { end: 'trend', why: `the 4H trend is ${h4} now — against a ${w.side}` };
  const rawStop = +(sweep - dir * STOP_BUFFER_ATR * atr).toFixed(2);
  const lv = guardStop({ symbol: w.symbol, side: w.side, entry: px, stopLoss: rawStop, takeProfit: w.takeProfit, swingTakeProfit: w.swingTakeProfit, snap, pullIn: false }); // the journal's targets are already pulled in
  if (lv.skip) return { end: 'skipped', why: lv.skip };
  const risk = Math.abs(px - lv.stopLoss);
  const far = lv.swingTakeProfit ?? lv.takeProfit;
  if (Math.abs(far - px) < MIN_R * risk) return { end: 'skipped', why: `the target ${far} pays under ${MIN_R}R from ${px} with the stop at ${lv.stopLoss}` };
  return { enter: { stopLoss: lv.stopLoss, takeProfit: lv.takeProfit, swingTakeProfit: lv.swingTakeProfit, sweep, risk, note: lv.note } };
}

async function loadState() {
  try { return JSON.parse(await getSetting('talon_reentry', '{}')) || {}; } catch { return {}; }
}
async function saveState(state) {
  const cutoff = Date.now() - 24 * 3600e3;
  for (const [k, w] of Object.entries(state)) if ((w.closedAt || 0) < cutoff) delete state[k];
  await setSetting('talon_reentry', JSON.stringify(state));
}

// The 5-min pass. `openPairs` / `maxPairs` come from talonAutoTrade (the cap).
async function reentryTick({ marketOpen, openPairs, maxPairs }) {
  if (!enabled()) return;
  const state = await loadState();
  let changed = false;
  for (const { key, watch } of newWatches(await allTrades(), state)) {
    state[key] = watch;
    changed = true;
    const side = watch.side.toUpperCase();
    alerts.araNote(`👀 T.A.L.O.N. → A.R.A.: my ${side} ${watch.symbol} stopped out at ${watch.stop}. If that was a stop hunt, I'll get back in once: price has to stay within one 1H ATR past ${watch.stop} and a 15m candle has to close back ${watch.side === 'buy' ? 'above' : 'below'} it in the next 4 hours, with the 4H still behind the trade. Otherwise I stay out.`);
  }
  for (const [key, w] of Object.entries(state)) {
    if (w.status !== 'watching') continue;
    if (!marketOpen && !CRYPTO.test(w.symbol)) continue;
    if (await require('./talonSwitch').marketHalted(w.symbol).catch(() => false)) continue; // switched off: no re-entry there
    let bars, snap;
    try {
      bars = closedBars(await tlHistory(w.symbol, '15m', 40), '15m');
      snap = await tlSnapshot(w.symbol);
    } catch (e) { console.error(`talon-reentry: ${w.symbol} market data failed —`, e.message); continue; }
    const price = snap.quote?.mid ?? (w.side === 'buy' ? snap.quote?.ask : snap.quote?.bid);
    const d = reentryCheck({ watch: w, bars, snap, price });
    if (d.wait) { w.lastWait = d.wait; changed = true; continue; }
    if (d.end) {
      w.status = d.end; w.why = d.why; changed = true;
      console.log(`talon-reentry: ${w.symbol} ${w.side} watch ended (${d.end}) — ${d.why}`);
      if (d.end !== 'expired') alerts.araNote(`T.A.L.O.N. → A.R.A.: no re-entry on ${w.symbol} — ${d.why}.`);
      continue;
    }
    const e = d.enter;
    Object.assign(e, await sharedTargets({ symbol: w.symbol, side: w.side, entry: price, takeProfit: e.takeProfit, swingTakeProfit: e.swingTakeProfit }));
    let swing = e.swingTakeProfit;
    if (swing != null && (await openPairs(w.symbol).catch(() => 0)) >= maxPairs(w.symbol)) { w.lastWait = 'pair cap full'; changed = true; continue; }
    // One try, recorded before the order, so a failure can't double it on the next tick.
    w.status = 'entered'; w.enteredAt = Date.now(); w.entryPrice = price; w.newStop = e.stopLoss; w.sweep = e.sweep;
    await saveState(state);
    changed = false;
    const setupId = `${key}:re`;
    const pairId = swing != null ? `${setupId}-0` : null;
    const why = `re-entry after a stop sweep to ${e.sweep} and a 15m close back past ${w.stop} — ${w.rationale}`.slice(0, 400);
    let s;
    try { s = await tlPlaceOrder({ symbol: w.symbol, side: w.side, qty: MAX_QTY, stopLoss: e.stopLoss, takeProfit: e.takeProfit }); }
    catch (err) {
      console.error(`talon-reentry: ${w.symbol} order failed —`, err.message);
      alerts.orderRejected({ symbol: w.symbol, side: `${w.side} (re-entry)`, error: err.message });
      w.status = 'failed'; w.why = err.message; changed = true;
      continue;
    }
    await recordTradeOpen({ symbol: w.symbol, side: s.side, qty: s.qty, entry: price, stopLoss: s.stopLoss ?? e.stopLoss, takeProfit: e.takeProfit,
      rationale: why, orderId: s.orderId, setup: 'scalp', auto: true, pairId, setupId, alert: false }).catch(() => {});
    if (pairId) {
      try {
        const s2 = await tlPlaceOrder({ symbol: w.symbol, side: w.side, qty: MAX_QTY, stopLoss: e.stopLoss, takeProfit: swing });
        await recordTradeOpen({ symbol: w.symbol, side: s2.side, qty: s2.qty, entry: price, stopLoss: s2.stopLoss ?? e.stopLoss, takeProfit: swing,
          rationale: why, orderId: s2.orderId, setup: 'swing', auto: true, pairId, setupId, alert: false }).catch(() => {});
      } catch (err) { swing = null; alerts.orderRejected({ symbol: w.symbol, side: `${w.side} (re-entry swing half)`, error: err.message }); }
    }
    console.log(`talon-reentry: RE-ENTERED ${s.side.toUpperCase()} ${w.symbol} @ ~${price} · SL ${e.stopLoss} (sweep ${e.sweep}) TP ${e.takeProfit}${swing != null ? ` + swing ${swing}` : ''}`);
    alerts.tradeOpened({ symbol: w.symbol, side: s.side, qty: s.qty, entry: price, stopLoss: e.stopLoss, takeProfit: e.takeProfit,
      swingTarget: swing, rationale: why, setup: 'scalp', copies: 1 });
    alerts.araNote(`🔁 T.A.L.O.N. → A.R.A.: that stop-out on ${w.symbol} was a sweep. Price only got to ${e.sweep} (old stop ${w.stop}) and a 15m candle closed back ${w.side === 'buy' ? 'above' : 'below'} it, so I'm back in ${w.side.toUpperCase()} at ~${price} (first entry was ${w.entry}). Stop ${e.stopLoss}, past the sweep. This is my one re-entry on it: if it stops again, I'm done with this setup.`);
    await saveMemory(TRADER_ID, `[auto-trade] re-entered ${w.side} ${w.symbol} @ ~${price} after a stop sweep to ${e.sweep} (old stop ${w.stop})`).catch(() => {});
    changed = true;
  }
  if (changed) await saveState(state);
}

module.exports = { reentryTick, reentryCheck, newWatches, stoppedOut, REENTRY_WINDOW_MS, SWEEP_MAX_ATR, STOP_BUFFER_ATR, MIN_R };
