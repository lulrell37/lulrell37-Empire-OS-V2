// T.A.L.O.N. auto-trade cron — server-side port of src/services/autoTrader.js.
// Ports the loop exactly as unguarded as the client version: no daily loss cap,
// no kill-switch. A live account is refused unless he's armed LIVE TRADING
// (`talon_live`, Settings › Trading). The only behavior difference from the client
// is that the TradeLocker session now survives between cycles (a long-lived
// process instead of a memory-only session that resets on every cold app open).
const { getSetting, setSetting, saveMemory } = require('./syncStore');
const { tlStatus, tlConnect, tlSnapshot, tlFormatSnapshot, tlPlaceOrder, tlModifyPosition, tlPositions, tlInstrumentsById, tlQuote, MAX_QTY, ENTRY_COPIES } = require('./tradeLocker');
const { autoTradeDecision, guardStop, SYMBOLS } = require('./talonBrain');
const { reconcileOpenTrades, formatTradeRecord, recordTradeOpen, allTrades, TRADER_ID } = require('./tradeJournal');
const { orderRejected, araNote, tradeOpened, addedOn } = require('./talonAlerts');
const { pushAlert } = require('./pushSender');

let busy = false;
let warnedDisconnected = false;
let lastError = null; // surfaced by GET /trade/status
let lastCycle = null; // the last decision cycle's tally, same
let warnedFailing = '';

// The cron ticks every 5 min (see server/index.js); this self-paces to
// whatever `auto_trade_interval_min` says, same due-check pattern as
// server/autoAtlas.js.
async function dueNow() {
  const mins = Math.max(1, parseInt(await getSetting('auto_trade_interval_min', '60'), 10) || 60);
  const last = parseInt(await getSetting('talon_last_cycle_at', '0'), 10) || 0;
  return Date.now() - last >= mins * 60000;
}

// FX/metals trade Sun 17:00 ET → Fri 17:00 ET with a daily 17:00-18:00 ET
// break; crypto trades around the clock. Scanning a closed market is a Claude
// call per symbol for nothing — the cron runs 24/7 now, not just while the app
// was open, so weekends alone were ~a quarter of T.A.L.O.N.'s spend.
const CRYPTO = /^(BTC|ETH|SOL|XRP|LTC|DOGE|ADA|BNB)/;
function fxOpen(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false })
    .formatToParts(now).map((x) => [x.type, x.value]));
  const h = parseInt(p.hour, 10) % 24;
  if (p.weekday === 'Sat') return false;
  if (p.weekday === 'Sun') return h >= 18;
  if (p.weekday === 'Fri') return h < 17;
  return h !== 17;
}

// `force` (A.R.A.'s [TALON_RUN]) runs a decision cycle now instead of waiting
// for the interval. Returns what happened, for her to report.
async function tick({ force = false } = {}) {
  if (busy) return { skipped: 'a cycle is already running' };
  busy = true;
  try {
    if ((await getSetting('auto_trade', '0')) !== '1') return { skipped: 'auto-trade is OFF (Settings › Trading)' };
    const due = force || await dueNow();
    if (due) await setSetting('talon_last_cycle_at', String(Date.now()));
    let st = tlStatus();
    if (!st.connected) {
      try { await tlConnect(); st = tlStatus(); }
      catch (e) {
        lastError = e.message;
        if (!warnedDisconnected) {
          warnedDisconnected = true;
          console.error('talon-autotrade: TradeLocker login failed —', e.message);
          // Without this the loop just goes quiet on the server. Once per
          // outage, so he knows T.A.L.O.N. isn't trading with the app closed.
          araNote(`⚠️ T.A.L.O.N. can't reach TradeLocker from the server, so he isn't trading while the app is closed: ${String(e.message).slice(0, 200)}\nOpen the app once (Settings › TRADELOCKER → reconnect) and he picks back up on his own.`);
        }
        return { skipped: `can't log in to TradeLocker — ${e.message}` };
      }
    }
    if (warnedDisconnected) araNote('✅ T.A.L.O.N. is back on TradeLocker and trading from the server again.');
    warnedDisconnected = false;
    lastError = null;
    const live = st.env !== 'demo';
    if (live && !(await liveArmed())) {
      console.error('talon-autotrade: HALTED — TradeLocker is on a LIVE account and LIVE TRADING is not armed.');
      await pushAlert(`talon-live-halt:${new Date().toDateString()}`, 'T.A.L.O.N. — auto-trade halted', 'TradeLocker is on a LIVE account. Arm LIVE TRADING in Settings › Trading, or switch back to demo.', { kind: 'talon-halt' }).catch(() => {});
      await setSetting('auto_trade', '0');
      return { skipped: 'TradeLocker is on a LIVE account and LIVE TRADING is not armed (Settings › Trading)' };
    }

    // Every 5-min tick, not just on a decision cycle: closes (stops, targets)
    // reach A.R.A.'s Telegram alerts within minutes, and open setups get their
    // add-ons on the way to target. No AI calls in here.
    await reconcileOpenTrades().catch(() => {});
    const marketOpen = fxOpen();
    await addOnEntries(marketOpen).catch((e) => console.error('talon-autotrade: add-on pass failed —', e.message));
    if (!due) return { skipped: 'not due yet' };

    // Gold and Bitcoin only — the app's auto_trade_symbols setting is ignored.
    const syms = SYMBOLS.filter((sym) => marketOpen || CRYPTO.test(sym));
    if (!syms.length) return { skipped: 'markets closed' };

    const positions = await tlPositions().catch(() => []);
    const idToSym = await tlInstrumentsById().catch(() => ({}));
    const symOf = (p) => String(idToSym[String(p.tradableInstrumentId)] || '').toUpperCase();
    let openCount = positions.length;
    const record = await formatTradeRecord().catch(() => '');

    let entered = 0, closed = 0, scanned = 0, snapFails = 0, decFails = 0, orderFails = 0;
    const errs = [];
    const decisions = [];
    for (const sym of syms) {
      let snap;
      try { snap = await tlSnapshot(sym); } catch (e) { snapFails++; errs.push(`${sym} market data: ${e.message}`); continue; }
      scanned++;
      const mine = positions.filter((p) => symOf(p) === sym);
      const posText = mine.map((p) => `#${p.id} ${p.side} ${p.qty} @ ${p.avgPrice} (uP/L ${p.unrealizedPl})`).join('; ') || 'none';

      let dec;
      try { dec = await autoTradeDecision({ symbol: sym, snapshot: tlFormatSnapshot(snap), record, positions: posText }); }
      catch (e) { decFails++; errs.push(`${sym} decision: ${e.message}`); console.error(`talon-autotrade: ${sym} decision failed —`, e.message); continue; }
      decisions.push(`${sym}: ${dec.action}${dec.side ? ` ${dec.side}` : ''}${dec.rationale ? ` — ${String(dec.rationale).slice(0, 160)}` : ''}`);

      if (Array.isArray(dec.breakevenIds) && dec.breakevenIds.length) {
        for (const id of dec.breakevenIds) {
          const pos = positions.find((p) => String(p.id) === String(id));
          if (!pos || Number(pos.unrealizedPl) <= 0) continue;
          try { await tlModifyPosition(id, { stopLoss: Number(pos.avgPrice) }); console.log(`talon-autotrade: #${id} ${sym} stop -> break-even`); }
          catch (e) { console.error(`talon-autotrade: break-even #${id} failed —`, e.message); }
        }
      }

      // He holds every trade to its stop or target (rule 6) — a "close" from
      // the model is never acted on.
      if (dec.action === 'close') { console.log(`talon-autotrade: ${sym} — ignored a close, holding to stop/target${dec.rationale ? ` (${dec.rationale})` : ''}`); continue; }

      if (dec.action === 'enter' && (dec.side === 'buy' || dec.side === 'sell')) {
        const price = snap.quote?.mid ?? (dec.side === 'buy' ? snap.quote?.ask : snap.quote?.bid);
        const lv = guardStop({ symbol: sym, side: dec.side, entry: price, stopLoss: dec.stopLoss, takeProfit: dec.takeProfit, swingTakeProfit: dec.swingTakeProfit, snap });
        if (lv.skip) { console.log(`talon-autotrade: skipped ${sym} ${dec.side} — ${lv.skip}`); decisions.push(`${sym}: skipped — ${lv.skip}`); continue; }
        if (lv.widened) console.log(`talon-autotrade: ${sym} ${lv.note}`);
        if (lv.swingNote) console.log(`talon-autotrade: ${sym} ${lv.swingNote}`);
        // The setup goes in ENTRY_COPIES times. Each copy is a scalp (to the
        // 15m target) and, when there's a valid 4H target, a swing (same stop)
        // linked to it by its own pairId — the journal moves that swing's stop
        // to break-even once its scalp pays. setupId ties every copy together
        // for the add-ons.
        const why = dec.rationale || 'auto-trade';
        const setupId = `${sym}-${Date.now()}`;
        let r = null, scalps = 0, swings = 0;
        for (let copy = 0; copy < ENTRY_COPIES; copy++) {
          const pairId = lv.swingTakeProfit != null ? `${sym}-${Date.now()}-${copy}` : null;
          let s;
          try {
            s = await tlPlaceOrder({ symbol: sym, side: dec.side, qty: MAX_QTY, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit });
          } catch (e) { orderFails++; console.error(`talon-autotrade: ${sym} order failed —`, e.message); orderRejected({ symbol: sym, side: dec.side, error: e.message }); continue; }
          r = r || s; scalps++; openCount++;
          await recordTradeOpen({ symbol: sym, side: s.side, qty: s.qty, entry: price, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit,
            rationale: why, orderId: s.orderId, setup: pairId ? 'scalp' : (dec.setup || 'scalp'), auto: true, pairId, setupId, alert: false }).catch(() => {});
          console.log(`talon-autotrade: ${s.side.toUpperCase()} ${s.qty} ${sym} @ ~${price ?? 'mkt'} · SL ${lv.stopLoss} TP ${lv.takeProfit}${pairId ? ' (scalp)' : ''}${dec.rationale ? ` — ${dec.rationale}` : ''}`);
          if (!pairId) continue;
          try {
            const s2 = await tlPlaceOrder({ symbol: sym, side: dec.side, qty: MAX_QTY, stopLoss: lv.stopLoss, takeProfit: lv.swingTakeProfit });
            await recordTradeOpen({ symbol: sym, side: s2.side, qty: s2.qty, entry: price, stopLoss: lv.stopLoss, takeProfit: lv.swingTakeProfit,
              rationale: why, orderId: s2.orderId, setup: 'swing', auto: true, pairId, setupId, alert: false }).catch(() => {});
            swings++; openCount++;
            console.log(`talon-autotrade: ${s2.side.toUpperCase()} ${s2.qty} ${sym} · SL ${lv.stopLoss} TP ${lv.swingTakeProfit} (swing)`);
          } catch (e) { orderFails++; console.error(`talon-autotrade: ${sym} swing order failed —`, e.message); orderRejected({ symbol: sym, side: `${dec.side} (swing half)`, error: e.message }); }
        }
        if (!r) continue;
        entered++;
        tradeOpened({ symbol: sym, side: r.side, qty: r.qty, entry: price, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit,
          swingTarget: swings ? lv.swingTakeProfit : null, rationale: why, setup: swings ? 'scalp' : (dec.setup || 'scalp'), copies: scalps });
        await saveMemory(TRADER_ID, `[auto-trade] opened ${r.side} ${sym} ×${scalps}${swings ? ' scalp + swing' : ''} @ ~${price ?? 'mkt'} — ${why}`).catch(() => {});
      }
    }
    lastCycle = { at: Date.now(), scanned, of: syms.length, entered, closed, openCount, decisions, errors: errs.slice(0, 4) };
    // Nothing scanned or decided at all is an outage, not a quiet market — say
    // so once (credits out, no quotes), instead of only logging it.
    const dead = syms.length && !decisions.length && errs.length;
    if (dead) {
      lastError = errs[0];
      const kind = String(errs[0]).replace(/^\w+ /, '').slice(0, 40);
      if (warnedFailing !== kind) {
        warnedFailing = kind;
        araNote(`⚠️ T.A.L.O.N. ran his scan but couldn't decide on anything — ${String(errs[0]).slice(0, 220)}. He's not trading until that clears.`);
      }
    } else if (decisions.length) {
      if (warnedFailing) araNote('✅ T.A.L.O.N. is scanning and deciding again.');
      warnedFailing = '';
    }
    console.log(`talon-autotrade: scanned ${scanned}/${syms.length}${snapFails ? `, ${snapFails} snapshot fail` : ''}${decFails ? `, ${decFails} decision fail` : ''}${orderFails ? `, ${orderFails} order fail` : ''}, ${entered} entered, ${closed} closed (${openCount} open)`);
    return lastCycle;
  } catch (e) {
    console.error('talon-autotrade: cycle crashed', e.message);
    lastError = `cycle crashed: ${e.message}`;
    return { skipped: lastError };
  } finally {
    busy = false;
  }
}

async function liveArmed() { return (await getSetting('talon_live', '0')) === '1'; }

// Adds on the way to the take profit. Every ADD_STEP_R of open profit on one
// of his setups, ENTRY_COPIES more 0.02 positions go in toward that setup's
// final target (the swing's, when it has one) — the first copy takes profit
// early, 1R past its own entry (the next step); the rest ride to the final
// target. Each add's stop sits one step
// behind price — the first add's stop is the setup's entry, so it can only
// lose what the setup already made. Up to ADD_MAX adds per setup, never one
// within 1R of the target, and only while one of the setup's own positions is
// still open. One try per step: a rejected add isn't retried every 5 minutes.
const ADD_STEP_R = 1;
const ADD_MAX = 3;
const addTried = new Map(); // setup key -> highest step attempted
async function addOnEntries(marketOpen) {
  const mine = (await allTrades()).filter((t) => t.auto);
  const groups = {};
  for (const t of mine) { const k = t.setup_id || t.pair_id || t.sync_id; (groups[k] || (groups[k] = [])).push(t); }
  for (const [key, g] of Object.entries(groups)) {
    const base = g.filter((t) => t.setup !== 'add');
    if (!base.length || !base.some((t) => t.status === 'open' && t.position_id)) continue;
    const t0 = base[0], sym = t0.symbol;
    if (!marketOpen && !CRYPTO.test(sym)) continue;
    const dir = t0.side === 'buy' ? 1 : -1;
    const entry = Number(t0.entry_fill ?? t0.entry_ref), stop = Number(t0.stop_loss);
    const target = base.map((t) => Number(t.take_profit)).filter(isFinite).sort((a, b) => (b - a) * dir)[0];
    const r = Math.abs(entry - stop) * ADD_STEP_R;
    if (!isFinite(entry) || !isFinite(stop) || !isFinite(target) || !r) continue;
    const q = await tlQuote(sym).catch(() => null);
    const price = Number(dir > 0 ? (q?.bid ?? q?.mid) : (q?.ask ?? q?.mid));
    if (!isFinite(price)) continue;
    const step = Math.floor(((price - entry) * dir) / r + 1e-9);
    const done = Math.max(0, addTried.get(key) || 0, ...g.filter((t) => t.setup === 'add').map((t) => Number(t.add_level) || 0));
    if (step < 1 || step <= done || step > ADD_MAX) continue;
    if ((target - price) * dir < r) continue;
    addTried.set(key, step);
    const addStop = +(entry + dir * (step - 1) * r).toFixed(2);
    const early = +(price + dir * r).toFixed(2);
    let placed = null, copies = 0;
    for (let copy = 0; copy < ENTRY_COPIES; copy++) {
      const tp = copy === 0 ? early : target;
      try {
        const s = await tlPlaceOrder({ symbol: sym, side: t0.side, qty: MAX_QTY, stopLoss: addStop, takeProfit: tp });
        await recordTradeOpen({ symbol: sym, side: s.side, qty: s.qty, entry: price, stopLoss: addStop, takeProfit: tp,
          rationale: `add-on ${step} — ${t0.rationale || ''}`.slice(0, 400), orderId: s.orderId, setup: 'add', auto: true, setupId: key, addLevel: step, alert: false }).catch(() => {});
        placed = placed || s; copies++;
        console.log(`talon-autotrade: ADD ${step} ${s.side.toUpperCase()} ${s.qty} ${sym} @ ~${price} · SL ${addStop} TP ${tp}${copy === 0 ? ' (early)' : ''}`);
      } catch (e) { console.error(`talon-autotrade: ${sym} add-on ${step} failed —`, e.message); orderRejected({ symbol: sym, side: `${t0.side} (add-on ${step})`, error: e.message }); }
    }
    if (placed) addedOn({ symbol: sym, side: placed.side, qty: placed.qty, copies, step, entry: price, stopLoss: addStop, earlyTarget: early, takeProfit: target });
  }
}

// One-time switch-on for the gold + Bitcoin rework: flips the app's
// `auto_trade` toggle on once (it syncs back to the app's Settings). After
// that the toggle is his again — turning it off in the app sticks.
async function enableOnce() {
  if ((await getSetting('talon_gold_btc_enabled', '0')) === '1') return false;
  await setSetting('auto_trade', '1');
  await setSetting('talon_gold_btc_enabled', '1');
  console.log('talon-autotrade: switched on (gold + Bitcoin playbook)');
  return true;
}

// What GET /trade/status reports: is the server actually able to trade on
// its own right now.
async function status() {
  const { query } = require('./db');
  const { rows } = await query('SELECT server, env, updated_at FROM trade_creds WHERE id = 1').catch(() => ({ rows: [] }));
  const last = parseInt(await getSetting('talon_last_cycle_at', '0'), 10) || 0;
  return {
    cron: cronEnabled(),
    autoTrade: (await getSetting('auto_trade', '0')) === '1',
    liveArmed: await liveArmed(),
    creds: rows[0] ? { server: rows[0].server, env: rows[0].env, updatedAt: Number(rows[0].updated_at) } : null,
    tradeLocker: tlStatus(),
    marketOpen: fxOpen(),
    lastCycleAt: last || null,
    lastCycle,
    lastError,
  };
}

// His brain is claudeText: subscription -> Anthropic API -> Grok. Any one of
// them is enough to trade; ANTHROPIC_API_KEY alone used to be required.
function cronEnabled() {
  if (process.env.TALON_AUTOTRADE === 'off') return false;
  return !!(process.env.ANTHROPIC_API_KEY || process.env.XAI_API_KEY || require('./claudeSub').subscriptionEnabled());
}

module.exports = { tick, enableOnce, status, cronEnabled };
