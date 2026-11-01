// T.A.L.O.N.'s "something's off" watch. Runs on every 5-min auto-trade tick
// (after the journal reconcile), no AI calls, and relays anything unexpected
// to A.R.A. — she sends it to Mr. Burrus on her Telegram bot (voice note +
// text, logged in her history) and it lands in her persona memory too.
//
//   1. A trade going against him — an open setup is 75%+ of the way to its
//      stop. Once per setup and stop.
//   2. A sudden spike — a 15m candle on gold or Bitcoin over 2× the normal
//      15m range (ATR14), in or out of a trade. Once per candle.
//   3. A broken prediction — price crosses the invalidation level from his
//      last market update (talonUpdate.js stores them). Once per update.
//   4. System problems — a position with no stop on it, or the trade loop
//      erroring (cycle crash, reconcile / add-on pass failing). Closes away
//      from stop and target are flagged in tradeClosed (talonAlerts.js).
//
// The once-only memory is in-process: a server restart can repeat one alert.
const { getSetting, saveMemory } = require('./syncStore');
const { tlQuote, tlHistory, tlPositions, tlInstrumentsById } = require('./tradeLocker');
const { allTrades } = require('./tradeJournal');
const { SYMBOLS } = require('./talonBrain');
const { araNote } = require('./talonAlerts');

const NAMES = { XAUUSD: 'Gold', BTCUSD: 'Bitcoin' };
const nameOf = (sym) => NAMES[sym] || sym;
const CRYPTO = /^(BTC|ETH|SOL|XRP|LTC|DOGE|ADA|BNB)/;
const NEAR_STOP = 0.75; // share of the way from entry to stop
const SPIKE_ATR = 2; // 15m candle range vs. the 15m ATR14
const BAR_MS = 15 * 60e3;
const fmt = (n) => (n == null || !isFinite(n) ? '—' : String(+Number(n).toFixed(2)));

const sent = new Set(); // keys of alerts already relayed
function once(key) {
  if (sent.has(key)) return false;
  sent.add(key);
  if (sent.size > 2000) sent.delete(sent.values().next().value);
  return true;
}

function relay(text, memory = true) {
  araNote(text);
  if (memory) saveMemory('ara', `[T.A.L.O.N. heads-up] ${text.replace(/\*\*/g, '')}`.slice(0, 1500)).catch(() => {});
}

async function priceOf(sym, side) {
  const q = await tlQuote(sym).catch(() => null);
  // What it would close at: a buy closes on the bid, a sell on the ask.
  const p = Number(side === 'buy' ? (q?.bid ?? q?.mid) : side === 'sell' ? (q?.ask ?? q?.mid) : q?.mid);
  return isFinite(p) ? p : null;
}

// 1. Open setups 75%+ of the way to their stop.
async function nearStops(open, live) {
  const groups = {};
  for (const t of open) {
    if (!live(t.symbol)) continue;
    if (t.setup === 'quick') continue; // 5m scalps with tight stops — too noisy to relay
    const entry = Number(t.entry_fill ?? t.entry_ref), stop = Number(t.stop_loss);
    if (!isFinite(entry) || !isFinite(stop) || entry === stop) continue;
    const k = `${t.setup_id || t.pair_id || t.sync_id}:${stop}`;
    (groups[k] || (groups[k] = [])).push({ t, entry, stop });
  }
  for (const [k, g] of Object.entries(groups)) {
    const { t, entry, stop } = g[0];
    const price = await priceOf(t.symbol, t.side);
    if (price == null) continue;
    const dir = t.side === 'buy' ? 1 : -1;
    const against = ((entry - price) * dir) / Math.abs(entry - stop);
    if (against < NEAR_STOP || !once(`near:${k}`)) continue;
    const pl = g.reduce((s, x) => s + (Number(x.t.last_unrealized) || 0), 0);
    const kinds = g.map((x) => x.t.setup || 'trade').join(' + ');
    relay(`⚠️ **T.A.L.O.N. → A.R.A.: ${nameOf(t.symbol)} is going against me.** My ${String(t.side).toUpperCase()} (${kinds}) from ${fmt(entry)} is ${Math.round(against * 100)}% of the way to its stop — price ${fmt(price)}, stop ${fmt(stop)}, open P/L about ${pl < 0 ? '-' : ''}$${Math.abs(pl).toFixed(2)}.\n`
      + `I'm holding it to the stop like the playbook says; the stop is where the idea is wrong. Telling you now so it's no surprise.`);
  }
}

// 2. A 15m candle over 2× the normal 15m range.
async function spikes(syms, open) {
  for (const sym of syms) {
    const bars = await tlHistory(sym, '15m', 40).catch(() => null);
    if (!bars || bars.length < 17) continue;
    // The newest bar may still be forming — check it and the last closed one.
    for (const i of [bars.length - 2, bars.length - 1]) {
      const b = bars[i];
      // ATR14 of the bars before this one (true range uses each bar's prior close).
      let trSum = 0, n = 0;
      for (let j = Math.max(1, i - 14); j < i; j++, n++) {
        const x = bars[j], pc = bars[j - 1].c;
        trSum += Math.max(x.h - x.l, Math.abs(x.h - pc), Math.abs(x.l - pc));
      }
      const atr = n ? trSum / n : 0;
      const range = b.h - b.l;
      if (!atr || range < SPIKE_ATR * atr) continue;
      if (Date.now() - Number(b.t) > 2 * BAR_MS) continue; // stale history, not news
      if (!once(`spike:${sym}:${b.t}`)) continue;
      const up = b.c >= b.o;
      const mine = open.filter((t) => t.symbol === sym);
      const effect = !mine.length ? 'We have nothing open there.'
        : mine.some((t) => (t.side === 'buy') === up) && mine.some((t) => (t.side === 'buy') !== up) ? 'We have positions on both sides there.'
        : (mine[0].side === 'buy') === up ? `It's moving in favor of our ${String(mine[0].side).toUpperCase()}.`
        : `It's moving against our ${String(mine[0].side).toUpperCase()} — stops are in place.`;
      relay(`⚡ **T.A.L.O.N. → A.R.A.: sudden move in ${nameOf(sym)}.** A 15m candle just ran ${up ? 'UP' : 'DOWN'} ${fmt(range)} (${(range / atr).toFixed(1)}× its normal ${fmt(atr)} range), ${fmt(b.o)} → ${fmt(b.c)}. ${effect}\n`
        + `Usually news or a liquidity grab — I won't chase it; I'll wait for the dust to settle before any new entry.`);
      break;
    }
  }
}

// 3. Price through the invalidation level of his last market update.
async function brokenPredictions(syms) {
  let saved;
  try { saved = JSON.parse(await getSetting('talon_update_levels', '') || 'null'); } catch { saved = null; }
  if (!saved?.levels || Date.now() - Number(saved.at) > 12 * 3600e3) return;
  for (const sym of syms) {
    const lv = saved.levels[sym];
    const inv = Number(lv?.invalidation);
    if (!lv || !isFinite(inv) || !/^(up|down)$/.test(lv.bias)) continue;
    const price = await priceOf(sym);
    if (price == null) continue;
    const broken = lv.bias === 'up' ? price < inv : price > inv;
    if (!broken || !once(`pred:${saved.at}:${sym}`)) continue;
    relay(`🔄 **T.A.L.O.N. → A.R.A.: my ${nameOf(sym)} call was wrong.** In my last update I expected ${lv.bias === 'up' ? 'higher' : 'lower'} prices${isFinite(Number(lv.target)) ? ` toward ${fmt(lv.target)}` : ''} and said ${fmt(inv)} would prove me wrong — it's at ${fmt(price)} now.\n`
      + `I'm dropping that read. No new ${lv.bias === 'up' ? 'buys' : 'sells'} there until the charts line up again.`);
  }
}

// 4a. Any position on the account with no stop attached.
async function missingStops(open) {
  const [positions, idToSym] = await Promise.all([tlPositions().catch(() => null), tlInstrumentsById().catch(() => ({}))]);
  if (!positions) return;
  for (const p of positions) {
    const sl = p.stopLossId;
    if (sl != null && sl !== '' && String(sl) !== '0') continue;
    const opened = Number(p.openDate) || Date.parse(p.openDate || '') || 0;
    if (opened && Date.now() - opened < 2 * 60e3) continue; // stop may still be attaching
    // His own positions get their stop re-attached by the journal (ensureStop
    // in tradeJournal.js), which says so itself.
    if (open.some((t) => String(t.position_id) === String(p.id))) continue;
    if (!once(`nostop:${p.id}`)) continue;
    const sym = String(idToSym[String(p.tradableInstrumentId)] || '').toUpperCase() || 'an instrument';
    relay(`🚨 **T.A.L.O.N. → A.R.A.: a position has NO stop on it.** ${String(p.side).toUpperCase()} ${p.qty} ${nameOf(sym)} @ ${p.avgPrice} (#${p.id}), open P/L ${p.unrealizedPl}. It isn't one of mine (opened by hand or from the app).\n`
      + `Nothing protects it if price runs. Put a stop on it in TradeLocker, or close it.`, false);
  }
}

// 4b. The loop itself failing — called from talonAutoTrade.js. Once per kind of
// error until `systemOk(kind)` clears it.
const failing = new Map();
function systemFault(kind, message) {
  const msg = String(message || '').slice(0, 220);
  if (failing.has(kind)) return;
  failing.set(kind, msg);
  relay(`🛠️ **T.A.L.O.N. → A.R.A.: something broke on my side** (${kind}): ${msg}\nI'll keep retrying every 5 minutes and tell you when it clears.`, false);
}
function systemOk(kind) {
  if (!failing.has(kind)) return;
  failing.delete(kind);
  relay(`✅ T.A.L.O.N.: the ${kind} problem cleared — running normally again.`, false);
}

async function watchTick({ marketOpen }) {
  if (process.env.TALON_WATCH === 'off') return;
  const live = (sym) => marketOpen || CRYPTO.test(sym);
  const syms = SYMBOLS.filter(live);
  const open = (await allTrades().catch(() => [])).filter((t) => t.persona === 'talon' && t.status === 'open' && t.position_id);
  const steps = [() => nearStops(open, live), () => spikes(syms, open), () => brokenPredictions(syms), () => missingStops(open)];
  for (const step of steps) await step().catch((e) => console.error('talon-watch:', e.message));
}

module.exports = { watchTick, systemFault, systemOk };
