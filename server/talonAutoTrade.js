// T.A.L.O.N. auto-trade cron — server-side port of src/services/autoTrader.js.
// Ports the loop exactly as unguarded as the client version: no daily loss cap,
// no kill-switch. A live account is refused unless he's armed LIVE TRADING
// (`talon_live`, Settings › Trading). The only behavior difference from the client
// is that the TradeLocker session now survives between cycles (a long-lived
// process instead of a memory-only session that resets on every cold app open).
const { getSetting, setSetting, saveMemory } = require('./syncStore');
const { tlStatus, tlConnect, tlFollowAccount, tlActiveEnv, tlSnapshot, tlFormatSnapshot, tlPlaceOrder, tlModifyPosition, tlPositions, tlInstrumentsById, tlQuote, MAX_QTY, entryCopies } = require('./tradeLocker');
const strategies = require('./talonStrategies');
const { autoTradeDecision, guardStop, entryLocation, tradeContext, SYMBOLS, nasHours, fxHours, FOREX } = require('./talonBrain');
const { reconcileOpenTrades, formatTradeRecord, recordTradeOpen, allTrades, sharedTargets, TRADER_ID } = require('./tradeJournal');
const { orderRejected, araNote, tradeOpened, addedOn } = require('./talonAlerts');
const { pushAlert } = require('./pushSender');
const { watchTick, systemFault, systemOk } = require('./talonWatch');
const quick = require('./talonQuick');
const reentry = require('./talonReentry');

let busy = false;
let warnedDisconnected = false;
let lastError = null; // surfaced by GET /trade/status
let lastCycle = null; // the last decision cycle's tally, same
let warnedFailing = '';

// The cron ticks 20s past every 5-min mark (see server/index.js), so the
// candle that just closed is in the broker's history. A scan is due in each new
// `auto_trade_interval_min` slot on the clock — 15 scans right after every 15m
// close (:00, :15, :30, :45), 60 right after the top of the hour — rather than
// N minutes after the last scan, which drifted off the closes.
async function dueNow() {
  const slot = Math.max(1, parseInt(await getSetting('auto_trade_interval_min', '15'), 10) || 15) * 60000;
  const last = parseInt(await getSetting('talon_last_cycle_at', '0'), 10) || 0;
  return Math.floor(Date.now() / slot) > Math.floor(last / slot);
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
    // Switched off by him: no new trades, but positions still open keep being looked
    // after (missing stops put back, swing to break-even, close alerts, the watch).
    if (await require('./talonSwitch').isHalted()) {
      await tlFollowAccount().catch(() => {});
      if (!tlStatus().connected) await tlConnect().catch(() => {});
      if (tlStatus().connected) {
        const rec = await reconcileOpenTrades().catch((e) => ({ error: e.message }));
        if (rec?.error) systemFault('trade journal check', rec.error === 'positions' ? 'couldn\'t read open positions from TradeLocker' : rec.error);
        else systemOk('trade journal check');
        await watchTick({ marketOpen: fxOpen() }).catch((e) => console.error('talon-watch failed —', e.message));
      }
      return { skipped: 'T.A.L.O.N. is switched OFF by Mr. Burrus (no new trades; open ones are still managed; he says start to turn him back on)' };
    }
    if ((await getSetting('auto_trade', '0')) !== '1') return { skipped: 'auto-trade is OFF (Settings › Trading)' };
    const due = force || await dueNow();
    if (due) await setSetting('talon_last_cycle_at', String(Date.now()));
    await tlFollowAccount().catch((e) => console.error('talon-autotrade: account check failed —', e.message));
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
      // Wait, don't switch auto-trade off — he picks back up the moment LIVE
      // TRADING is armed (switching to the live login before arming it used to
      // leave him off for good).
      return { skipped: 'TradeLocker is on a LIVE account and LIVE TRADING is not armed (Settings › Trading)' };
    }

    // Every 5-min tick, not just on a decision cycle: closes (stops, targets)
    // reach A.R.A.'s Telegram alerts within minutes, and open setups get their
    // add-ons on the way to target. No AI calls in here.
    const rec = await reconcileOpenTrades().catch((e) => ({ error: e.message }));
    if (rec?.error) systemFault('trade journal check', rec.error === 'positions' ? 'couldn\'t read open positions from TradeLocker' : rec.error);
    else systemOk('trade journal check');
    const marketOpen = fxOpen();
    // Two losing trades today → done for the day (owner, 2026-11-26): open trades are
    // still managed and watched, nothing new goes in until tomorrow.
    const ds = await require('./talonSwitch').checkDayStop().catch((e) => { console.error('talon-autotrade failed: day stop check —', e.message); return { stopped: false }; });
    if (ds.stopped) {
      await watchTick({ marketOpen }).catch((e) => console.error('talon-watch failed —', e.message));
      return { skipped: `done for the day — ${ds.count} losing trades today (back tomorrow, or he says start trading)` };
    }
    // A setup stopped out by a sweep gets one re-entry at the better price (server/talonReentry.js).
    await reentry.reentryTick({ marketOpen, openPairs, maxPairs }).then(() => systemOk('re-entry pass'))
      .catch((e) => { console.error('talon-reentry failed —', e.message); systemFault('re-entry pass', e.message); });
    await addOnEntries(marketOpen).then(() => systemOk('add-on pass'))
      .catch((e) => { console.error('talon-autotrade: add-on pass failed —', e.message); systemFault('add-on pass', e.message); });
    // Anything unexpected (trade near its stop, spike, broken call, no stop) -> A.R.A.
    await watchTick({ marketOpen }).catch((e) => console.error('talon-watch failed —', e.message));
    // Quick 5m scalps — their own playbook and limits (server/talonQuick.js),
    // checked on every 5m close; the brain is only called when the filter fires.
    await quick.quickTick({ marketOpen }).then(() => systemOk('quick-scalp pass'))
      .catch((e) => { console.error('talon-quick failed —', e.message); systemFault('quick-scalp pass', e.message); });
    // Markets he put on another strategy (server/talonStrategies.js) check their own coded
    // signal on every tick; those markets skip the playbook scan below.
    const stratOff = await require('./talonSwitch').haltedMarkets().catch(() => ({}));
    const stratSyms = SYMBOLS.filter((sym) => !stratOff[sym] && (sym === 'NAS100' ? nasHours() : FOREX.includes(sym) ? fxHours() : (marketOpen || CRYPTO.test(sym))));
    await strategies.strategyTick({ syms: stratSyms, place: placeStrategyTrade }).then(() => systemOk('strategy pass'))
      .catch((e) => { console.error('talon strategies failed —', e.message); systemFault('strategy pass', e.message); });
    if (!due) return { skipped: 'not due yet' };

    // Gold, Bitcoin and the Nasdaq 100 only — the app's auto_trade_symbols setting is
    // ignored. Nasdaq takes fresh setups only in the cash session (nasHours); a market
    // he switched off ([TRADING_OFF: bitcoin]) isn't scanned at all.
    const offMarkets = await require('./talonSwitch').haltedMarkets().catch(() => ({}));
    const syms = SYMBOLS.filter((sym) => !offMarkets[sym] && (sym === 'NAS100' ? nasHours() : FOREX.includes(sym) ? fxHours() : (marketOpen || CRYPTO.test(sym))));
    if (!syms.length) return { skipped: Object.keys(offMarkets).length ? 'markets closed or switched off' : 'markets closed' };

    const positions = await tlPositions().catch(() => []);
    const idToSym = await tlInstrumentsById().catch(() => ({}));
    const symOf = (p) => String(idToSym[String(p.tradableInstrumentId)] || '').toUpperCase();
    let openCount = positions.length;
    const record = await formatTradeRecord().catch(() => '');

    let entered = 0, closed = 0, scanned = 0, snapFails = 0, decFails = 0, orderFails = 0;
    const errs = [];
    const decisions = [];
    const stratCfg = await strategies.choices();
    for (const sym of syms) {
      const onStrat = strategies.activeIn(stratCfg, sym);
      if (onStrat !== 'playbook') { decisions.push(`${sym}: on ${strategies.STRATEGIES[onStrat].name} (his choice), not the playbook`); continue; }
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
          try { await tlModifyPosition(id, { stopLoss: Number(pos.avgPrice), symbol: sym }); console.log(`talon-autotrade: #${id} ${sym} stop -> break-even`); }
          catch (e) { console.error(`talon-autotrade: break-even #${id} failed —`, e.message); }
        }
      }

      // He holds every trade to its stop or target (rule 6) — a "close" from
      // the model is never acted on.
      if (dec.action === 'close') { console.log(`talon-autotrade: ${sym} — ignored a close, holding to stop/target${dec.rationale ? ` (${dec.rationale})` : ''}`); continue; }

      if (dec.action === 'enter' && (dec.side === 'buy' || dec.side === 'sell')) {
        const price = snap.quote?.mid ?? (dec.side === 'buy' ? snap.quote?.ask : snap.quote?.bid);
        // Rule 10, enforced: a setup against the 1D trend is a pullback unless he
        // called it a reversal — and a pullback gets the scalp only, no swing.
        // Against the 4H is a counter-trend trade: scalp only as well.
        const { d1, h4, against1D, against4H, pullback, scalpOnly } = tradeContext({ side: dec.side, daily: dec.daily, snap });
        if (scalpOnly && dec.swingTakeProfit != null) {
          console.log(`talon-autotrade: ${sym} ${dec.side} — ${against4H ? `against the 4H ${h4} trend` : `against the 1D ${d1} trend, not called a reversal`}: scalp only`);
          dec.swingTakeProfit = undefined;
        }
        if (against4H) decisions.push(`${sym}: against the 4H ${h4} trend — counter-trend, scalp only`);
        if (against1D) decisions.push(`${sym}: against the daily ${d1} trend — ${pullback ? 'read as a PULLBACK, scalp only' : 'read as a REVERSAL, full pair'}`);
        // Rule 2, enforced: the price he'd get has to be at 1H value, not mid-move.
        const loc = entryLocation({ side: dec.side, entry: price, snap });
        if (loc.skip) { console.log(`talon-autotrade: refused ${sym} ${dec.side} — ${loc.skip}`); decisions.push(`${sym}: refused — ${loc.skip}`); continue; }
        const lv = guardStop({ symbol: sym, side: dec.side, entry: price, stopLoss: dec.stopLoss, takeProfit: dec.takeProfit, swingTakeProfit: dec.swingTakeProfit, snap });
        if (lv.skip) { console.log(`talon-autotrade: skipped ${sym} ${dec.side} — ${lv.skip}`); decisions.push(`${sym}: skipped — ${lv.skip}`); continue; }
        if (lv.widened) console.log(`talon-autotrade: ${sym} ${lv.note}`);
        if (lv.swingNote) console.log(`talon-autotrade: ${sym} ${lv.swingNote}`);
        Object.assign(lv, await sharedTargets({ symbol: sym, side: dec.side, entry: price, takeProfit: lv.takeProfit, swingTakeProfit: lv.swingTakeProfit }));
        // The setup goes in entryCopies(sym) times — once on every market since 2026-11-22 (fewer if that would top MAX_PAIRS). Each copy is a scalp (to the
        // 15m target) and, when there's a valid 4H target, a swing (same stop)
        // linked to it by its own pairId — the journal moves that swing's stop
        // to break-even once its scalp pays. setupId ties every copy together
        // for the add-ons.
        const paired = lv.swingTakeProfit != null;
        const held = paired ? await openPairs(sym).catch(() => 0) : 0;
        const cap = maxPairs(sym);
        const copiesFor = entryCopies(sym);
        const slots = paired ? Math.min(copiesFor, cap - held) : copiesFor;
        if (slots <= 0) { console.log(`talon-autotrade: skipped ${sym} ${dec.side} — ${held} scalp/swing pairs already open (cap ${cap})`); decisions.push(`${sym}: skipped — ${held}/${cap} pairs already open`); continue; }
        const why = dec.rationale || 'auto-trade';
        const setupId = `${sym}-${Date.now()}`;
        let r = null, scalps = 0, swings = 0;
        for (let copy = 0; copy < slots; copy++) {
          const pairId = lv.swingTakeProfit != null ? `${sym}-${Date.now()}-${copy}` : null;
          let s;
          try {
            s = await tlPlaceOrder({ symbol: sym, side: dec.side, qty: MAX_QTY, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit });
          } catch (e) { orderFails++; console.error(`talon-autotrade: ${sym} order failed —`, e.message); orderRejected({ symbol: sym, side: dec.side, error: e.message }); continue; }
          r = r || s; scalps++; openCount++;
          await recordTradeOpen({ symbol: sym, side: s.side, qty: s.qty, entry: price, stopLoss: s.stopLoss ?? lv.stopLoss, takeProfit: lv.takeProfit,
            rationale: why, orderId: s.orderId, setup: pairId ? 'scalp' : (dec.setup || 'scalp'), auto: true, pairId, setupId, trend: { d1, h4 }, alert: false }).catch(() => {});
          console.log(`talon-autotrade: ${s.side.toUpperCase()} ${s.qty} ${sym} @ ~${price ?? 'mkt'} · SL ${lv.stopLoss} TP ${lv.takeProfit}${pairId ? ' (scalp)' : ''}${dec.rationale ? ` — ${dec.rationale}` : ''}`);
          if (!pairId) continue;
          try {
            const s2 = await tlPlaceOrder({ symbol: sym, side: dec.side, qty: MAX_QTY, stopLoss: lv.stopLoss, takeProfit: lv.swingTakeProfit });
            await recordTradeOpen({ symbol: sym, side: s2.side, qty: s2.qty, entry: price, stopLoss: s2.stopLoss ?? lv.stopLoss, takeProfit: lv.swingTakeProfit,
              rationale: why, orderId: s2.orderId, setup: 'swing', auto: true, pairId, setupId, trend: { d1, h4 }, alert: false }).catch(() => {});
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
    systemOk('trade loop');
    console.log(`talon-autotrade: scanned ${scanned}/${syms.length}${snapFails ? `, ${snapFails} snapshot fail` : ''}${decFails ? `, ${decFails} decision fail` : ''}${orderFails ? `, ${orderFails} order fail` : ''}, ${entered} entered, ${closed} closed (${openCount} open)`);
    return lastCycle;
  } catch (e) {
    console.error('talon-autotrade: cycle crashed', e.message);
    lastError = `cycle crashed: ${e.message}`;
    systemFault('trade loop', `the cycle crashed — ${e.message}`);
    return { skipped: lastError };
  } finally {
    busy = false;
  }
}

// One trade from a coded strategy (server/talonStrategies.js): the same stop guard as a
// setup (minimums, the danger zone, the $40 check), a 2R target off the final stop, one
// position, one open per market from these strategies. tlPlaceOrder does the sizing and
// every switch.
async function placeStrategyTrade(sym, strategy, sig) {
  const open = (await allTrades()).some((t) => t.status === 'open' && t.symbol === sym && strategies.isStrategyTrade(t));
  if (open) return { skipped: 'a strategy trade is already open on this market' };
  const snap = await tlSnapshot(sym);
  const price = Number(snap.quote?.mid ?? (sig.side === 'buy' ? snap.quote?.ask : snap.quote?.bid));
  if (!isFinite(price) || !price) return { skipped: 'no price' };
  const dir = sig.side === 'buy' ? 1 : -1;
  const dist0 = (price - sig.stopLoss) * dir;
  if (!(dist0 > 0)) return { skipped: 'price already past the stop' };
  const lv = guardStop({ symbol: sym, side: sig.side, entry: price, stopLoss: sig.stopLoss, takeProfit: price + dir * 20 * dist0, snap, pullIn: false });
  const name = strategies.STRATEGIES[strategy].name;
  if (lv.skip) { console.log(`talon-autotrade: ${sym} ${name} ${sig.side} skipped — ${lv.skip}`); return { skipped: lv.skip }; }
  const { roundPrice } = require('./marketStructure');
  const tp = roundPrice(price + dir * 2 * Math.abs(price - lv.stopLoss));
  const why = `${name}: ${sig.why}`;
  let s;
  try { s = await tlPlaceOrder({ symbol: sym, side: sig.side, qty: MAX_QTY, stopLoss: lv.stopLoss, takeProfit: tp }); }
  catch (e) { if (!e.halted) orderRejected({ symbol: sym, side: sig.side, error: e.message }); return { error: e.message }; }
  await recordTradeOpen({ symbol: sym, side: s.side, qty: s.qty, entry: price, stopLoss: s.stopLoss ?? lv.stopLoss, takeProfit: s.takeProfit ?? tp,
    rationale: why, orderId: s.orderId, setup: `strat:${strategy}`, auto: true, setupId: `${sym}-${Date.now()}-${strategy}`, alert: false }).catch(() => {});
  tradeOpened({ symbol: sym, side: s.side, qty: s.qty, entry: price, stopLoss: s.stopLoss ?? lv.stopLoss, takeProfit: s.takeProfit ?? tp, rationale: why, setup: 'strategy' });
  await saveMemory(TRADER_ID, `[auto-trade, ${name}] opened ${s.side} ${sym} @ ~${price} — ${sig.why}`).catch(() => {});
  console.log(`talon-autotrade: ${sym} ${name} ${s.side.toUpperCase()} ${s.qty} @ ~${price} · SL ${s.stopLoss ?? lv.stopLoss} TP ${s.takeProfit ?? tp}`);
  return { entered: true };
}

async function liveArmed() { return (await getSetting('talon_live', '0')) === '1'; }

// At most MAX_PAIRS[symbol] scalp + swing pairs open per market at once
// (gold 1, Bitcoin 2). A pair
// counts only while its scalp is open — once the scalp pays, the swing riding
// on alone frees the slot. Lone scalps (no swing), news trades and add-ons
// don't count.
const MAX_PAIRS = { XAUUSD: 1, BTCUSD: 2, NAS100: 1, EURUSD: 1, GBPUSD: 1, USDJPY: 1 };
const maxPairs = (sym) => MAX_PAIRS[sym] ?? 2;
async function openPairs(sym) {
  const keys = new Set();
  for (const t of await allTrades()) {
    if (!t.auto || t.status !== 'open' || String(t.symbol).toUpperCase() !== sym) continue;
    if (t.setup === 'scalp' && t.pair_id) keys.add(t.pair_id);
  }
  return keys.size;
}

// Adds on the way to the take profit, on pullbacks only. Once one of his
// setups has run ADD_STEP_R further into profit (the step), the add for that
// step is armed; it goes in only on a pullback that has turned back toward the
// take profit: price first pulls back at least ADD_PULLBACK_R off the best price
// the setup has reached (never deeper than ADD_ROOM_R above the add's stop), then
// has to bounce ADD_RESUME_R back off that pullback's low — so he never adds
// while price is still falling away from the target. A new best price starts the
// pullback over. One 0.02 position, taking profit 1R past its own entry
// rather than riding to the setup's final target (the swing's, when it has
// one). Each add's stop sits one step behind the step it was armed at — the
// first add's stop is the setup's entry, so it can only lose what the setup
// already made. No cap on adds per setup — never one within 1R of the
// target, though, and only while one of the setup's own positions is still open. One
// try per step: a rejected add isn't retried every 5 minutes. The best price and
// pullback low live in memory, so a server restart starts them over from the
// current price.
const ADD_STEP_R = 1;
const ADD_PULLBACK_R = 0.5;
const ADD_ROOM_R = 0.25;
const ADD_RESUME_R = 0.2;
const addTried = new Map(); // setup key -> highest step attempted
const addPeak = new Map(); // setup key -> best price seen (in its direction)
const addTrough = new Map(); // setup key -> deepest pullback price since that best price
async function addOnEntries(marketOpen) {
  // Quick scalps never get add-ons — they're in and out on the 5m.
  const mine = (await allTrades()).filter((t) => t.auto && t.setup !== 'quick' && !strategies.isStrategyTrade(t));
  const groups = {};
  for (const t of mine) { const k = t.setup_id || t.pair_id || t.sync_id; (groups[k] || (groups[k] = [])).push(t); }
  for (const [key, g] of Object.entries(groups)) {
    const base = g.filter((t) => t.setup !== 'add');
    if (!base.length || !base.some((t) => t.status === 'open' && t.position_id)) continue;
    const t0 = base[0], sym = t0.symbol;
    if (!marketOpen && !CRYPTO.test(sym)) continue;
    if (await require('./talonSwitch').marketHalted(sym).catch(() => false)) continue; // he switched this market off
    const dir = t0.side === 'buy' ? 1 : -1;
    const entry = Number(t0.entry_fill ?? t0.entry_ref), stop = Number(t0.stop_loss);
    const target = base.map((t) => Number(t.take_profit)).filter(isFinite).sort((a, b) => (b - a) * dir)[0];
    const r = Math.abs(entry - stop) * ADD_STEP_R;
    if (!isFinite(entry) || !isFinite(stop) || !isFinite(target) || !r) continue;
    const q = await tlQuote(sym).catch(() => null);
    const price = Number(dir > 0 ? (q?.bid ?? q?.mid) : (q?.ask ?? q?.mid));
    if (!isFinite(price)) continue;
    const prevPeak = addPeak.get(key);
    const peak = prevPeak == null ? price : (dir > 0 ? Math.max(prevPeak, price) : Math.min(prevPeak, price));
    addPeak.set(key, peak);
    // Pullback low since the best price; a new best price resets it.
    const prevTrough = peak !== prevPeak ? null : addTrough.get(key);
    const trough = prevTrough == null ? price : (dir > 0 ? Math.min(prevTrough, price) : Math.max(prevTrough, price));
    addTrough.set(key, trough);
    const step = Math.floor(((peak - entry) * dir) / r + 1e-9);
    const done = Math.max(0, addTried.get(key) || 0, ...g.filter((t) => t.setup === 'add').map((t) => Number(t.add_level) || 0));
    if (step < 1 || step <= done) continue;
    const addStop = require('./marketStructure').roundPrice(entry + dir * (step - 1) * r);
    if ((peak - trough) * dir < ADD_PULLBACK_R * r) continue; // no pullback yet
    if ((trough - addStop) * dir < ADD_ROOM_R * r) continue; // pulled back too deep — not this one
    if ((price - trough) * dir < ADD_RESUME_R * r) continue; // still pulling back, not headed to TP yet
    if ((peak - price) * dir <= 0) continue; // back at the high — the pullback entry is gone
    if ((target - price) * dir < r) continue;
    addTried.set(key, step);
    const early = require('./marketStructure').roundPrice(price + dir * r);
    try {
      // Its own stop (one step behind), not the main rule's minimum.
      const s = await tlPlaceOrder({ symbol: sym, side: t0.side, qty: MAX_QTY, stopLoss: addStop, takeProfit: early, minStop: false });
      await recordTradeOpen({ symbol: sym, side: s.side, qty: s.qty, entry: price, stopLoss: addStop, takeProfit: early,
        rationale: `add-on ${step} — ${t0.rationale || ''}`.slice(0, 400), orderId: s.orderId, setup: 'add', auto: true, setupId: key, addLevel: step, alert: false }).catch(() => {});
      console.log(`talon-autotrade: ADD ${step} ${s.side.toUpperCase()} ${s.qty} ${sym} @ ~${price} after a pullback from ${peak} to ${trough}, turning back toward TP · SL ${addStop} TP ${early}`);
      addedOn({ symbol: sym, side: s.side, qty: s.qty, copies: 1, step, entry: price, stopLoss: addStop, earlyTarget: early, takeProfit: early });
    } catch (e) {
      // Past the gold loss limit is a skip, not a broker rejection.
      if (e.tooWide || e.goldTooWide || e.halted) { console.log(`talon-autotrade: ${sym} add-on ${step} skipped — ${e.message}`); continue; }
      console.error(`talon-autotrade: ${sym} add-on ${step} failed —`, e.message); orderRejected({ symbol: sym, side: `${t0.side} (add-on ${step})`, error: e.message });
    }
  }
}

// One-time switch-on for the gold + Bitcoin rework: flips the app's
// `auto_trade` toggle on once (it syncs back to the app's Settings). After
// that the toggle is his again — turning it off in the app sticks.
async function enableOnce() {
  // One-time move to scanning every 15m candle close (synced back to the app's
  // Settings › Trading interval box; changing it there sticks after this).
  if ((await getSetting('talon_scan_15_set', '0')) !== '1') {
    await setSetting('auto_trade_interval_min', '15');
    await setSetting('talon_scan_15_set', '1');
    console.log('talon-autotrade: scan interval set to 15 min');
  }
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
    // env from the account he's actually switched to; row 1 is only the app's last login.
    creds: rows[0] ? { server: rows[0].server, env: (await tlActiveEnv().catch(() => null)) || rows[0].env, updatedAt: Number(rows[0].updated_at) } : null,
    tradeLocker: tlStatus(),
    marketOpen: fxOpen(),
    lastCycleAt: last || null,
    lastCycle,
    quickScalps: quick.status(),
    lastError,
  };
}

// His brain is claudeText: subscription -> Anthropic API -> Grok. Any one of
// them is enough to trade; ANTHROPIC_API_KEY alone used to be required.
function cronEnabled() {
  if (process.env.TALON_AUTOTRADE === 'off') return false;
  return !!(process.env.ANTHROPIC_API_KEY || process.env.XAI_API_KEY || require('./claudeSub').subscriptionEnabled());
}

module.exports = { tick, enableOnce, status, cronEnabled, fxOpen };
