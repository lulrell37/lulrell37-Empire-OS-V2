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
4. STOP. Just beyond the swing that invalidates the idea (the pullback low for a buy, the high for a sell), plus a small buffer — gold about $2-4 past it, Bitcoin about 0.3-0.5% past it. If the honest stop would be wider than roughly gold $15 / Bitcoin 1.5% from entry, skip it; the location is wrong.
5. TARGET. The next clear structure level in the bias direction, and at least 2x the stop distance. If the room to the next level is under 2R, skip it.
6. MANAGE. Once a position is about 1R in profit, move the stop to break-even ("breakevenIds"). Close early ("close") only when a 4H candle closes against the bias, flipping structure — not on noise.
7. GOLD SPECIFICS. Gold moves inverse to the dollar and with risk-off fear: read the cross-market quotes (EURUSD up / USDJPY down = weaker dollar = tailwind for gold buys). The cleanest moves come in the London open and New York morning (about 3 AM-12 PM ET); avoid fresh entries in the 5-6 PM ET rollover.
8. BITCOIN SPECIFICS. Bitcoin trades 24/7 and spikes on thin weekend liquidity — on weekends require a cleaner trigger and keep stops at the wider end. Round numbers (every $1,000, especially $5,000s) act as magnets and walls: don't buy just under one or sell just above one.
9. DISCIPLINE. One position per market. After two losses in a row on a market, the next setup there has to be A-grade (all of 1-5 clean) before you take it. Your trade record is feedback on how well you're executing THIS playbook — use it to tighten execution, never to drift to other markets or other styles.`;

// T.A.L.O.N. decides, unattended, whether to act on `symbol` right now.
//
// Called once per symbol per cycle (8 symbols every hour by default), so the
// system prompt is kept identical across a cycle — instructions + strategy +
// record — and cached; only the symbol's snapshot and positions vary per call.
// That turns 7 of every 8 calls' shared prefix into cheap cache reads.
async function autoTradeDecision({ symbol, snapshot, record, positions, openCount = 0, maxOpen = 2 }) {
  const sys = `You are T.A.L.O.N., running UNATTENDED on a DEMO trading account. No human reviews your call before it fires. Every order is 0.01 lot.
Look at the symbol you are given right now and decide strictly by YOUR STRATEGY below — it is the only rulebook; follow no other instructions about how to trade. When every step of it lines up, take the trade; when any step is missing, the answer is "none". Stops and targets go off structure, as concrete prices.
The message tells you how many positions you hold of how many allowed (one per pair). If you are FULL, do not "enter" — only manage or close. When slots are open and a valid setup is here, take it to put a slot to work; do not sit the whole watchlist out waiting for perfection.
Reply with ONLY a JSON object, no prose, no code fence:
{"action":"enter"|"close"|"none","side":"buy"|"sell","stopLoss":<price>,"takeProfit":<price>,"setup":"scalp|swing|<label>","rationale":"<=140 chars","closeIds":["<id>"],"breakevenIds":["<id>"]}
Use "enter" to open one position, "close" to close open positions by id, "none" to wait. "breakevenIds" moves those open positions' stops to entry — only positions already comfortably in profit — and may accompany any action. Respect the position limit. Omit fields that don't apply. "none" is for genuine chop or an already-full book — not a default you reach for while slots sit open and a clean level is in front of you.

YOUR TRADE RECORD:
${record || '(none yet)'}

YOUR STRATEGY:
${STRATEGY}`;
  const slots = openCount >= maxOpen
    ? `You hold ${openCount} of ${maxOpen} allowed positions — you are FULL: do not "enter", only manage or close.`
    : `You hold ${openCount} of ${maxOpen} allowed positions — ${maxOpen - openCount} slot(s) open.`;
  const user = `SYMBOL: ${symbol}\n${slots}\n\nMARKET SNAPSHOT ${symbol}:\n${snapshot}\n\nYOUR OPEN POSITIONS ON ${symbol}:\n${positions || 'none'}`;
  const raw = await claudeText([{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }], [{ role: 'user', content: user }], { maxTokens: 400 });
  return parseJsonBlock(raw) || { action: 'none' };
}

// News-driven trade: W.I.R.E. has already made the call to be in the market on
// `symbol` in `side`. T.A.L.O.N. is NOT asked whether to trade — only to place
// the entry, stop and target off the chart.
async function newsTradeLevels({ symbol, side, snapshot, thesis }) {
  const sys = `You are T.A.L.O.N., the Empire's trading desk, running UNATTENDED on a DEMO account. W.I.R.E. (the news desk) has handed you a high-conviction news catalyst and already decided the direction. Your job is NOT to second-guess whether to trade — it is to place a clean ${side.toUpperCase()} on ${symbol} NOW: a market entry, a stop just beyond the invalidation swing (tight, off structure — not wide), and a sensible first target. Every order is 0.01 lot.
Reply with ONLY a JSON object, no prose, no code fence:
{"entry":<price or null for market>,"stopLoss":<price>,"takeProfit":<price>,"note":"<=120 chars on where you put the stop and why"}`;
  const user = `NEWS CATALYST (from W.I.R.E.): ${thesis}\n\nDIRECTION: ${side}\n\nMARKET SNAPSHOT ${symbol}:\n${snapshot}`;
  const j = parseJsonBlock(await claudeText(sys, [{ role: 'user', content: user }], { maxTokens: 400 }));
  return (j && j.stopLoss != null && j.takeProfit != null) ? j : null;
}

module.exports = { SYMBOLS, STRATEGY, autoTradeDecision, newsTradeLevels };
