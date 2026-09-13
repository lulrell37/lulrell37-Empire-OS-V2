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

// T.A.L.O.N. decides, unattended, whether to act on `symbol` right now.
async function autoTradeDecision({ symbol, snapshot, record, strategy, positions, openCount = 0, maxOpen = 5 }) {
  const sys = `You are T.A.L.O.N., running UNATTENDED on a DEMO trading account. No human reviews your call before it fires. Every order is 0.01 lot.
Look at ${symbol} right now and decide. Patience is still the edge — never force a trade in chop or against clear structure. BUT this is a live demo you are meant to be actively working: when a clean setup is in front of you that fits your strategy and your record — a defined level, a clear bias, a sensible stop — take it rather than holding out for a perfect one. A reasonable A-/B+ setup with tight risk is a yes. Stops and targets go off structure, tight, as concrete prices.
You currently hold ${openCount} of ${maxOpen} allowed positions (one per pair). ${openCount >= maxOpen ? 'You are FULL — do not "enter", only manage or close.' : `${maxOpen - openCount} slot(s) are open — when a valid setup is here, take it to put a slot to work; do not sit the whole watchlist out waiting for perfection.`}
Reply with ONLY a JSON object, no prose, no code fence:
{"action":"enter"|"close"|"none","side":"buy"|"sell","stopLoss":<price>,"takeProfit":<price>,"setup":"scalp|swing|<label>","rationale":"<=140 chars","closeIds":["<id>"],"breakevenIds":["<id>"]}
Use "enter" to open one position, "close" to close open positions by id, "none" to wait. "breakevenIds" moves those open positions' stops to entry — only positions already comfortably in profit — and may accompany any action. Respect the position limit stated above. Omit fields that don't apply. "none" is for genuine chop or an already-full book — not a default you reach for while slots sit open and a clean level is in front of you.`;
  const user = `MARKET SNAPSHOT ${symbol}:\n${snapshot}\n\nYOUR TRADE RECORD:\n${record || '(none yet)'}\n\nYOUR STRATEGY:\n${strategy || '(none yet)'}\n\nYOUR OPEN POSITIONS ON ${symbol}:\n${positions || 'none'}`;
  const raw = await claudeText(sys, [{ role: 'user', content: user }], { maxTokens: 400 });
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

module.exports = { autoTradeDecision, newsTradeLevels };
