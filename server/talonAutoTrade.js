// T.A.L.O.N. auto-trade cron — server-side port of src/services/autoTrader.js.
// Ports the loop exactly as unguarded as the client version: no daily loss cap,
// no kill-switch. The one hard rule stays the same — refuses to place an order
// on anything but a demo account. The only behavior difference from the client
// is that the TradeLocker session now survives between cycles (a long-lived
// process instead of a memory-only session that resets on every cold app open).
const { getSetting, setSetting, saveMemory } = require('./syncStore');
const { tlStatus, tlConnect, tlSnapshot, tlFormatSnapshot, tlPlaceOrder, tlClosePosition, tlModifyPosition, tlPositions, tlInstrumentsById, MAX_QTY, MAX_OPEN_POSITIONS } = require('./tradeLocker');
const { autoTradeDecision } = require('./talonBrain');
const { reconcileOpenTrades, formatTradeRecord, getStrategy, recordTradeOpen, TRADER_ID } = require('./tradeJournal');
const { pushAlert } = require('./pushSender');

let busy = false;
let warnedDisconnected = false;

// The cron ticks every 5 min (see server/index.js); this self-paces to
// whatever `auto_trade_interval_min` says, same due-check pattern as
// server/autoAtlas.js.
async function dueNow() {
  const mins = Math.max(1, parseInt(await getSetting('auto_trade_interval_min', '15'), 10) || 15);
  const last = parseInt(await getSetting('talon_last_cycle_at', '0'), 10) || 0;
  return Date.now() - last >= mins * 60000;
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if ((await getSetting('auto_trade', '0')) !== '1') return;
    if (!(await dueNow())) return;
    await setSetting('talon_last_cycle_at', String(Date.now()));
    let st = tlStatus();
    if (!st.connected) {
      try { await tlConnect(); st = tlStatus(); }
      catch (e) {
        if (!warnedDisconnected) { warnedDisconnected = true; console.error('talon-autotrade: TradeLocker login failed —', e.message); }
        return;
      }
    }
    warnedDisconnected = false;
    if (st.env !== 'demo') {
      console.error('talon-autotrade: HALTED — TradeLocker is on a LIVE account. Auto-trade only runs on demo.');
      await pushAlert(`talon-live-halt:${new Date().toDateString()}`, 'T.A.L.O.N. — auto-trade halted', 'TradeLocker is on a LIVE account. Switch back to demo to resume.', { kind: 'talon-halt' }).catch(() => {});
      await setSetting('auto_trade', '0');
      return;
    }

    await reconcileOpenTrades().catch(() => {});

    const symsRaw = await getSetting('auto_trade_symbols', 'XAUUSD, EURUSD, GBPUSD, USDJPY, GBPJPY, AUDUSD, XAGUSD, BTCUSD');
    const syms = [...new Set(symsRaw.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 12);
    if (!syms.length) return;

    const maxOpen = Math.min(MAX_OPEN_POSITIONS, Math.max(1, parseInt(await getSetting('auto_trade_max_open', String(MAX_OPEN_POSITIONS)), 10) || MAX_OPEN_POSITIONS));

    const positions = await tlPositions().catch(() => []);
    const idToSym = await tlInstrumentsById().catch(() => ({}));
    const symOf = (p) => String(idToSym[String(p.tradableInstrumentId)] || '').toUpperCase();
    const openSyms = new Set(positions.map(symOf));
    let openCount = positions.length;
    const record = await formatTradeRecord().catch(() => '');
    const strategy = await getStrategy().catch(() => '');

    let entered = 0, closed = 0, scanned = 0, snapFails = 0, decFails = 0, orderFails = 0;
    for (const sym of syms) {
      let snap;
      try { snap = await tlSnapshot(sym); } catch { snapFails++; continue; }
      scanned++;
      const mine = positions.filter((p) => symOf(p) === sym);
      const posText = mine.map((p) => `#${p.id} ${p.side} ${p.qty} @ ${p.avgPrice} (uP/L ${p.unrealizedPl})`).join('; ') || 'none';

      let dec;
      try { dec = await autoTradeDecision({ symbol: sym, snapshot: tlFormatSnapshot(snap), record, strategy, positions: posText, openCount, maxOpen }); }
      catch (e) { decFails++; console.error(`talon-autotrade: ${sym} decision failed —`, e.message); continue; }

      if (Array.isArray(dec.breakevenIds) && dec.breakevenIds.length) {
        for (const id of dec.breakevenIds) {
          const pos = positions.find((p) => String(p.id) === String(id));
          if (!pos || Number(pos.unrealizedPl) <= 0) continue;
          try { await tlModifyPosition(id, { stopLoss: Number(pos.avgPrice) }); console.log(`talon-autotrade: #${id} ${sym} stop -> break-even`); }
          catch (e) { console.error(`talon-autotrade: break-even #${id} failed —`, e.message); }
        }
      }

      if (dec.action === 'close' && Array.isArray(dec.closeIds) && dec.closeIds.length) {
        for (const id of dec.closeIds) {
          try { await tlClosePosition(id); closed++; console.log(`talon-autotrade: closed #${id} ${sym}${dec.rationale ? ` — ${dec.rationale}` : ''}`); }
          catch (e) { console.error(`talon-autotrade: close #${id} failed —`, e.message); }
        }
        continue;
      }

      if (dec.action === 'enter' && (dec.side === 'buy' || dec.side === 'sell')) {
        if (openSyms.has(sym)) continue;
        if (openCount >= maxOpen) { console.log(`talon-autotrade: skipped ${sym} — ${maxOpen} positions already open`); continue; }
        const price = snap.quote?.mid ?? (dec.side === 'buy' ? snap.quote?.ask : snap.quote?.bid);
        try {
          const r = await tlPlaceOrder({ symbol: sym, side: dec.side, qty: MAX_QTY, stopLoss: dec.stopLoss, takeProfit: dec.takeProfit });
          await recordTradeOpen({ symbol: sym, side: r.side, qty: r.qty, entry: price, stopLoss: dec.stopLoss, takeProfit: dec.takeProfit,
            rationale: dec.rationale || 'auto-trade', orderId: r.orderId, setup: dec.setup, auto: true }).catch(() => {});
          openSyms.add(sym); openCount++; entered++;
          console.log(`talon-autotrade: ${r.side.toUpperCase()} ${r.qty} ${sym} @ ~${price ?? 'mkt'} · SL ${dec.stopLoss ?? '—'} TP ${dec.takeProfit ?? '—'}${dec.rationale ? ` — ${dec.rationale}` : ''}`);
          await saveMemory(TRADER_ID, `[auto-trade] opened ${r.side} ${sym} @ ~${price ?? 'mkt'} — ${dec.rationale || ''}`);
        } catch (e) { orderFails++; console.error(`talon-autotrade: ${sym} order failed —`, e.message); }
      }
    }
    console.log(`talon-autotrade: scanned ${scanned}/${syms.length}${snapFails ? `, ${snapFails} snapshot fail` : ''}${decFails ? `, ${decFails} decision fail` : ''}${orderFails ? `, ${orderFails} order fail` : ''}, ${entered} entered, ${closed} closed (${openCount}/${maxOpen} open)`);
  } catch (e) {
    console.error('talon-autotrade: cycle crashed', e.message);
  } finally {
    busy = false;
  }
}

module.exports = { tick };
