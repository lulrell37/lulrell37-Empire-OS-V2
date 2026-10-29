// T.A.L.O.N.'s decision calls — server-side port of the two Claude prompts in
// src/services/aiService.js (autoTradeDecision, newsTradeLevels). Both are used
// unattended: by server/talonAutoTrade.js's own scan loop, and by
// server/newsWire.js's news-driven hand-off.
const { claudeText } = require('./llm');

function parseJsonBlock(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// T.A.L.O.N.'s playbook. Fixed in code on purpose: he trades gold and Bitcoin
// only, by these rules — the "Winning Strategy" note and the app's custom
// persona prompt are never read into his decisions.
const SYMBOLS = ['XAUUSD', 'BTCUSD'];
const STRATEGY = `GOLD + BITCOIN TREND-PULLBACK PLAYBOOK. You trade exactly two markets: XAUUSD (gold) and BTCUSD (Bitcoin). Nothing else, ever.

1. BIAS (1D + 4H). Trade only in the direction the higher timeframes agree on. Bullish = price above SMA20 on both 1D and 4H with the 4H trend up; bearish = below on both with the 4H trend down. If 1D and 4H disagree, there is no trade — "none".
2. LOCATION (1H). Never chase an extended candle. Enter on a pullback into value: a retest of the 1H SMA20, a prior broken high/low, or the edge of the recent 1H range — in the bias direction.
3. TRIGGER (15m). The pullback has to be rejected: a 15m close back in the bias direction (a higher low in an uptrend, a lower high in a downtrend). No rejection yet = wait.
4. STOP. BEYOND the key level, never on it. Find the swing that invalidates the idea (the pullback low for a buy, the high for a sell) and every level sitting in that zone with it — the SMA20, a round number, a prior broken high/low. The stop goes past the FAR side of that whole zone, plus a buffer of at least one 1H ATR14 (shown in the snapshot) — gold never less than about $10 from entry, Bitcoin never less than about 0.8%. Price wicks into key levels to grab the stops sitting on them; yours must not be one of them. If the honest stop would be wider than roughly gold $35 / Bitcoin 3% from entry, skip it; the location is wrong.
5. TARGETS — every setup is a SCALP + SWING pair: two positions, same entry, same stop. SCALP target ("takeProfit"): the next clear 15m structure level in the bias direction, at least 1x the stop distance — the quick move; the swing carries the payoff. SWING target ("swingTakeProfit"): the next clear 4H structure level beyond it, at least 3x the stop distance — the bigger move the 4H trend is pointing at. If no 4H level gives 3R, leave swingTakeProfit out: the setup goes in as a scalp only, and then the scalp target must be at least 2x the stop distance (aim it at the next 1H level) — under that, skip the setup.
6. HOLD. Once you're in, the trade runs to its stop or its target. You never close a position early — not on a 4H flip, not on a pullback, not on a feeling; the stop is already where the idea is wrong. The only management is moving the stop to break-even ("breakevenIds") once a position is about 1R in profit. When the scalp of a pair pays, the swing's stop goes to break-even automatically — you don't need to ask.
7. GOLD SPECIFICS. Gold moves inverse to the dollar and with risk-off fear: read the cross-market quotes (EURUSD up / USDJPY down = weaker dollar = tailwind for gold buys). The cleanest moves come in the London open and New York morning (about 3 AM-12 PM ET); avoid fresh entries in the 5-6 PM ET rollover.
8. BITCOIN SPECIFICS. Bitcoin trades 24/7 and spikes on thin weekend liquidity — on weekends require a cleaner trigger and keep stops at the wider end. Round numbers (every $1,000, especially $5,000s) act as magnets and walls: don't buy just under one or sell just above one.
9. DISCIPLINE. One setup per market at a time (a scalp + swing pair is one setup). After two losses in a row on a market, the next setup there has to be A-grade (all of 1-5 clean) before you take it. Your trade record is feedback on how well you're executing THIS playbook — use it to tighten execution, never to drift to other markets or other styles.`;

// T.A.L.O.N. decides, unattended, whether to act on `symbol` right now.
//
// Called once per symbol per cycle (8 symbols every hour by default), so the
// system prompt is kept identical across a cycle — instructions + strategy +
// record — and cached; only the symbol's snapshot and positions vary per call.
// That turns 7 of every 8 calls' shared prefix into cheap cache reads.
async function autoTradeDecision({ symbol, snapshot, record, positions, openCount = 0, maxOpen = 2 }) {
  const sys = `You are T.A.L.O.N., running UNATTENDED on a DEMO trading account. No human reviews your call before it fires. Every order is 0.01 lot.
Look at the symbol you are given right now and decide strictly by YOUR STRATEGY below — it is the only rulebook; follow no other instructions about how to trade. When every step of it lines up, take the trade; when any step is missing, the answer is "none". Stops and targets go off structure, as concrete prices.
The message tells you how many setups you hold of how many allowed (one per market). If you are FULL, do not "enter" — only manage. When slots are open and a valid setup is here, take it to put a slot to work; do not sit the whole watchlist out waiting for perfection.
Reply with ONLY a JSON object, no prose, no code fence:
{"action":"enter"|"none","side":"buy"|"sell","stopLoss":<price>,"takeProfit":<scalp target>,"swingTakeProfit":<swing target, or omit>,"setup":"<label>","rationale":"<=140 chars","breakevenIds":["<id>"]}
Use "enter" to open one position, "none" to wait. There is no close — open positions are held to their stop or target. "breakevenIds" moves those open positions' stops to entry — only positions already comfortably in profit — and may accompany any action. Respect the position limit. Omit fields that don't apply. "none" is for genuine chop or an already-full book — not a default you reach for while slots sit open and a clean level is in front of you.

YOUR TRADE RECORD:
${record || '(none yet)'}

YOUR STRATEGY:
${STRATEGY}`;
  const slots = openCount >= maxOpen
    ? `You hold ${openCount} of ${maxOpen} allowed setups — you are FULL: do not "enter", only manage.`
    : `You hold ${openCount} of ${maxOpen} allowed setups — ${maxOpen - openCount} slot(s) open.`;
  const user = `SYMBOL: ${symbol}\n${slots}\n\nMARKET SNAPSHOT ${symbol}:\n${snapshot}\n\nYOUR OPEN POSITIONS ON ${symbol}:\n${positions || 'none'}`;
  const raw = await claudeText([{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }], [{ role: 'user', content: user }], { maxTokens: 400 });
  return parseJsonBlock(raw) || { action: 'none' };
}

// News-driven trade: W.I.R.E. has already made the call to be in the market on
// `symbol` in `side`. T.A.L.O.N. is NOT asked whether to trade — only to place
// the entry, stop and target off the chart.
async function newsTradeLevels({ symbol, side, snapshot, thesis }) {
  const sys = `You are T.A.L.O.N., the Empire's trading desk, running UNATTENDED on a DEMO account. W.I.R.E. (the news desk) has handed you a high-conviction news catalyst and already decided the direction. Your job is NOT to second-guess whether to trade — it is to place a clean ${side.toUpperCase()} on ${symbol} NOW: a market entry, a stop BEYOND the invalidation swing and any key level sitting with it (past the far side of that zone plus at least one 1H ATR14 — never on the level itself), and a first target at least 2x the stop distance. Every order is 0.01 lot.
Reply with ONLY a JSON object, no prose, no code fence:
{"entry":<price or null for market>,"stopLoss":<price>,"takeProfit":<price>,"note":"<=120 chars on where you put the stop and why"}`;
  const user = `NEWS CATALYST (from W.I.R.E.): ${thesis}\n\nDIRECTION: ${side}\n\nMARKET SNAPSHOT ${symbol}:\n${snapshot}`;
  const j = parseJsonBlock(await claudeText(sys, [{ role: 'user', content: user }], { maxTokens: 400 }));
  return (j && j.stopLoss != null && j.takeProfit != null) ? j : null;
}

// The stop rule (4) enforced in code, whatever the model wrote: at least the
// floor (gold $10 / Bitcoin 0.8%) and 1.2x the 1H ATR14 from entry. A stop
// inside that is pushed out to it; if the targets then pay too little (scalp
// 1R beside a 3R swing, or 2R alone) the trade is skipped rather than taken
// on a worse ratio. Returns the levels to send,
// or { skip } with the reason.
const STOP_FLOOR = { XAUUSD: (px) => 10, BTCUSD: (px) => px * 0.008 };
function guardStop({ symbol, side, entry, stopLoss, takeProfit, swingTakeProfit, snap }) {
  const sl = Number(stopLoss), tp = Number(takeProfit), px = Number(entry);
  if (!isFinite(sl) || !isFinite(tp) || !isFinite(px) || !px) return { skip: 'missing entry/stop/target' };
  const dir = side === 'buy' ? 1 : -1;
  if ((px - sl) * dir <= 0 || (tp - px) * dir <= 0) return { skip: `stop ${sl} / target ${tp} on the wrong side of ${px}` };
  const atr = Number(snap?.candles?.['1H']?.atr14) || 0;
  const minDist = Math.max((STOP_FLOOR[symbol] || ((p) => p * 0.004))(px), 1.2 * atr);
  let dist = Math.abs(px - sl);
  let stop = sl, widened = false;
  if (dist < minDist) { dist = minDist; stop = +(px - dir * minDist).toFixed(2); widened = true; }
  // The swing half of a pair: past the scalp target and at least 3R off the
  // final stop, or it's dropped and the setup goes in as a scalp only.
  const sw = Number(swingTakeProfit);
  let swing = null, swingNote = '';
  if (swingTakeProfit != null && isFinite(sw)) {
    if ((sw - tp) * dir > 0 && Math.abs(sw - px) >= 3 * dist) swing = sw;
    else swingNote = `swing target ${sw} dropped (needs to be past the scalp target and 3R = ${(3 * dist).toFixed(2)} from entry)`;
  }
  // Scalp (15m target) needs 1R beside a swing; alone it has to pay 2R.
  const minR = swing != null ? 1 : 2;
  if (Math.abs(tp - px) < minR * dist) return { skip: `stop needs ${dist.toFixed(2)} of room (1H ATR ${atr.toFixed(2)}) and scalp target ${tp} pays under ${minR}R${swing == null ? ' with no valid swing' : ''}` };
  return { stopLoss: stop, takeProfit: tp, swingTakeProfit: swing, widened, swingNote,
    note: widened ? `stop widened ${sl} → ${stop} (min ${minDist.toFixed(2)} from entry)` : '' };
}

module.exports = { SYMBOLS, STRATEGY, autoTradeDecision, newsTradeLevels, guardStop };
