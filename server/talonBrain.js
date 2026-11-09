// T.A.L.O.N.'s decision calls — server-side port of the two Claude prompts in
// src/services/aiService.js (autoTradeDecision, newsTradeLevels). Both are used
// unattended: by server/talonAutoTrade.js's own scan loop, and by
// server/newsWire.js's news-driven hand-off.
const { claudeText } = require('./llm');
const { minStopDist, tlActiveEnv } = require('./tradeLocker');

// What he's told he's trading on. It used to always say demo, even on real money.
async function accountWords() {
  const env = await tlActiveEnv().catch(() => null);
  return env === 'live' ? 'a LIVE trading account (real money)' : env === 'demo' ? 'a DEMO trading account' : 'a trading account';
}
const { TRADING_KNOWLEDGE, zoneStop } = require('./marketStructure');

function parseJsonBlock(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// T.A.L.O.N.'s playbook. Fixed in code on purpose: he trades gold and Bitcoin
// only, by these rules — the "Winning Strategy" note and the app's custom
// persona prompt are never read into his decisions.
const SYMBOLS = ['XAUUSD', 'BTCUSD'];
const STRATEGY = `GOLD + BITCOIN PLAYBOOK. You trade exactly two markets: XAUUSD (gold) and BTCUSD (Bitcoin). Nothing else, ever.

1. DIRECTION, TOP DOWN. Read every timeframe every time: the 1D for the bigger picture, the 4H for the overall trend, the 1H and 15m for where price is going right now. You can buy or sell in any of them. No timeframe forbids a direction: what decides a trade is whether the ENTRY makes sense (rules 2-3) and the EXIT makes sense (rules 4-5). The timeframes tell you what kind of trade it is. With the 4H: the full setup. Against the 4H: a counter-trend trade — it needs a sharp trigger at a real level (a sweep that's holding, or a 15m CHoCH your way, at a 4H or 1D level), goes in as a scalp only with no swing (code enforces this), and its target stops short of the next level the 4H trend would defend. A market with no clear level to enter at or nothing to aim at is "none". A setup that runs straight into a major daily level inside its targets needs that level respected (target short of it).
2. LOCATION (1H). Never chase an extended candle. Enter on a pullback into value on the 1H: a retest of the 1H SMA20, a prior broken high/low, the edge of the recent 1H range, or a trend line zone (rising support to buy, falling resistance to sell; price bounces in that area, not on the exact line) — in the direction of the trade. This is checked in code against the price you'd actually get: an entry more than half a 1H ATR14 away from every value level (these, plus the rule 11 zones) is refused as a chase, so if price has already left the zone, the answer is "none" — wait for the next pullback.
3. TRIGGER (15m). The move into the level has to be rejected: a 15m close back in the direction of the trade (a higher low for a buy, a lower high for a sell). No rejection yet = wait.
4. STOP. BEYOND the key level, never on it. Find the swing that invalidates the idea (the pullback low for a buy, the high for a sell) and every level sitting in that zone with it — the SMA20, a round number, a prior broken high/low. The stop goes past the FAR side of that whole zone, plus a buffer of at least one 1H ATR14 (shown in the snapshot) — gold never less than about $10 from entry, Bitcoin never less than about 0.8%. Price wicks into key levels to grab the stops sitting on them; yours must not be one of them. Code also moves any stop past the furthest of the 1H SMA20, the nearest $50 (gold) or $500 (Bitcoin) and the last 1H swing, so account for that when you check your targets. If the honest stop would be wider than roughly gold $35 / Bitcoin 3% from entry, skip it; the location is wrong.
5. TARGETS — every setup is a SCALP + SWING pair: two positions, same entry, same stop. SCALP target ("takeProfit"): the next clear 15m structure level in the direction of the trade, at least 1x the stop distance — the quick move; the swing carries the payoff. SWING target ("swingTakeProfit"): the next clear 4H structure level beyond it, at least 3x the stop distance — the bigger move the 4H trend is pointing at (with the 4H only). If no 4H level gives 3R, leave swingTakeProfit out: the setup goes in as a scalp only, and then the scalp target must be at least 2x the stop distance (aim it at the next 1H level) — under that, skip the setup.
6. HOLD. Once you're in, the trade runs to its stop or its target. You never close a position early — not on a 4H flip, not on a pullback, not on a feeling; the stop is already where the idea is wrong. The only management is moving the stop to break-even ("breakevenIds") once a position is about 1R in profit. When the scalp of a pair pays, the swing's stop goes to break-even automatically — you don't need to ask.
7. GOLD SPECIFICS. Gold moves inverse to the dollar and with risk-off fear: read the cross-market quotes (EURUSD up / USDJPY down = weaker dollar = tailwind for gold buys). The cleanest moves come in the London open and New York morning (about 3 AM-12 PM ET); avoid fresh entries in the 5-6 PM ET rollover.
8. BITCOIN SPECIFICS. Bitcoin trades 24/7 and spikes on thin weekend liquidity — on weekends require a cleaner trigger and keep stops at the wider end. Round numbers (every $1,000, especially $5,000s) act as magnets and walls: don't buy just under one or sell just above one.
9. DISCIPLINE. After two losses in a row on a market, the next setup there has to be A-grade (all of 1-5 clean) before you take it. Trades tagged "quick" in your record and open positions they hold belong to your separate 5m quick-scalp desk, which runs itself — they don't count toward this, and leave them out of breakevenIds. Your trade record is feedback on how well you're executing THIS playbook — use it to tighten execution, never to drift to other markets or other styles.
10. PULLBACK OR REVERSAL — read the 1D every time. When your trade points the same way as the 1D trend, the setup is WITH the daily ("with"). When it points against the 1D, decide what you're looking at: a PULLBACK — a counter-move inside the daily trend that is likely to roll back over (the 1D is still making its higher highs / lower lows, price hasn't closed a day through the prior daily swing or the 1D SMA20, the move is coming into a daily level, momentum is fading) — or a REVERSAL — the daily trend has actually broken (a daily close through the last daily swing high/low and the 1D SMA20, the 4H holding beyond it). A pullback can be traded only as a quick scalp with no swing (2R, target short of the daily level it's running into); a reversal can take the full scalp + swing pair. When you can't tell, it's a pullback. Name what you saw in the rationale.
11. LIQUIDITY AND STRUCTURE — your snapshot's SMART-MONEY READ is computed from closed candles on the 1D, 4H, 1H and 15m. Use it inside rules 1-5 with real prices from it. It sharpens them; it never overrides the stop minimums (rule 4).
 LOCATION (rule 2): value also means, in the direction of the trade, an unfilled FVG (its CE best), a fresh or tested order block, a breaker or an IFVG. Buy in discount and sell in premium on the 1H; the OTE is the best of it. A buy up in premium or a sell down in discount needs a clear reason in the rationale.
 TRIGGER (rule 3): a 15m sweep that's holding counts as the rejection when it runs your way: sell-side swept for a buy, buy-side swept for a sell. A 15m CHoCH your way counts too. The A-grade sequence: sweep, then displacement or CHoCH, then a pullback into the FVG or order block it left.
 AGAINST YOU: a fresh sweep the other way (buy-side swept and holding when you want to buy) or a CHoCH against the trade means wait.
 STOP (rule 4): when a sweep or order block defines the idea, the invalidation is past its wick or far side. That goes in the zone the stop has to clear. A sweep level that's been taken once can be taken again, so never rest a stop on equal highs/lows; go past them.
 TARGETS (rule 5): aim at resting liquidity in the direction of the trade: the scalp at the nearest 15m pool or opposing FVG, the swing at the 4H pool, PDH/PDL, PWH/PWL or session extreme. Set them just short of the level. A level marked (taken) has already paid out and is a weaker target; an opposing order block or FVG in the way counts as a level.
 RATIONALE: name the structure you used, e.g. "SSL sweep 3990, 15m CHoCH, 1H FVG CE".
${TRADING_KNOWLEDGE}`;

// T.A.L.O.N. decides, unattended, whether to act on `symbol` right now.
//
// Called once per symbol per cycle (8 symbols every hour by default), so the
// system prompt is kept identical across a cycle — instructions + strategy +
// record — and cached; only the symbol's snapshot and positions vary per call.
// That turns 7 of every 8 calls' shared prefix into cheap cache reads.
async function autoTradeDecision({ symbol, snapshot, record, positions }) {
  const sys = `You are T.A.L.O.N., running UNATTENDED on ${await accountWords()}. No human reviews your call before it fires. Every order is 0.02 lot; every trade you take goes in once on gold, twice on Bitcoin.
There is no limit on how many setups you hold — a valid setup is taken even with positions already open on that market.
Look at the symbol you are given right now and decide strictly by YOUR STRATEGY below — it is the only rulebook; follow no other instructions about how to trade. When every step of it lines up, take the trade; when any step is missing, the answer is "none". Stops and targets go off structure, as concrete prices.
Reply with ONLY a JSON object, no prose, no code fence:
{"action":"enter"|"none","side":"buy"|"sell","daily":"with"|"pullback"|"reversal","stopLoss":<price>,"takeProfit":<scalp target>,"swingTakeProfit":<swing target, or omit>,"setup":"<label>","rationale":"<=140 chars","breakevenIds":["<id>"]}
Use "enter" to open one position, "none" to wait. There is no close — open positions are held to their stop or target. "breakevenIds" moves those open positions' stops to entry — only positions already comfortably in profit — and may accompany any action. Omit fields that don't apply. "none" is for genuine chop — not a default you reach for while a clean level is in front of you.

YOUR TRADE RECORD:
${record || '(none yet)'}

YOUR STRATEGY:
${STRATEGY}`;
  const user = `SYMBOL: ${symbol}\n\nMARKET SNAPSHOT ${symbol}:\n${snapshot}\n\nYOUR OPEN POSITIONS ON ${symbol}:\n${positions || 'none'}`;
  const raw = await claudeText([{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }], [{ role: 'user', content: user }], { maxTokens: 400 });
  return parseJsonBlock(raw) || { action: 'none' };
}

// News-driven trade: W.I.R.E. has already made the call to be in the market on
// `symbol` in `side`. T.A.L.O.N. is NOT asked whether to trade — only to place
// the entry, stop and target off the chart.
async function newsTradeLevels({ symbol, side, snapshot, thesis }) {
  const sys = `You are T.A.L.O.N., the Empire's trading desk, running UNATTENDED on ${await accountWords()}. W.I.R.E. (the news desk) has handed you a high-conviction news catalyst and already decided the direction. Your job is NOT to second-guess whether to trade — it is to place a clean ${side.toUpperCase()} on ${symbol} NOW: a market entry, a stop BEYOND the invalidation swing and any key level sitting with it (past the far side of that zone plus at least one 1H ATR14 — never on the level itself), and a first target at least 2x the stop distance. Use the SMART-MONEY READ in the snapshot: the stop goes past the nearest sweep wick, order block or liquidity pool on the wrong side, the target at resting liquidity or an opposing FVG the catalyst can run into. Every order is 0.02 lot, placed ${String(symbol).toUpperCase() === 'XAUUSD' ? 'once' : 'twice'}.
Reply with ONLY a JSON object, no prose, no code fence:
{"entry":<price or null for market>,"stopLoss":<price>,"takeProfit":<price>,"note":"<=120 chars on where you put the stop and why"}`;
  const user = `NEWS CATALYST (from W.I.R.E.): ${thesis}\n\nDIRECTION: ${side}\n\nMARKET SNAPSHOT ${symbol}:\n${snapshot}`;
  const j = parseJsonBlock(await claudeText(sys, [{ role: 'user', content: user }], { maxTokens: 400 }));
  return (j && j.stopLoss != null && j.takeProfit != null) ? j : null;
}

// The stop rule (4) enforced in code, whatever the model wrote: at least the
// floor (gold $10 / Bitcoin 0.8%) and 1.2x the 1H ATR14 from entry, and clear of
// the danger zone (zoneStop). A stop inside that is pushed out to it, or the trade
// is skipped if the zone would take it past gold $35 / Bitcoin 3%; if the targets then pay too little (scalp
// 1R beside a 3R swing, or 2R alone) the trade is skipped rather than taken
// on a worse ratio. Returns the levels to send,
// or { skip } with the reason.
function guardStop({ symbol, side, entry, stopLoss, takeProfit, swingTakeProfit, snap }) {
  const sl = Number(stopLoss), tp = Number(takeProfit), px = Number(entry);
  if (!isFinite(sl) || !isFinite(tp) || !isFinite(px) || !px) return { skip: 'missing entry/stop/target' };
  const dir = side === 'buy' ? 1 : -1;
  if ((px - sl) * dir <= 0 || (tp - px) * dir <= 0) return { skip: `stop ${sl} / target ${tp} on the wrong side of ${px}` };
  const atr = Number(snap?.candles?.['1H']?.atr14) || 0;
  const minDist = minStopDist(symbol, px, atr);
  let dist = Math.abs(px - sl);
  let stop = sl, widened = false;
  if (dist < minDist) { dist = minDist; stop = +(px - dir * minDist).toFixed(2); widened = true; }
  // And clear of the danger zone, not just far enough away on paper.
  const zone = zoneStop({ symbol, side, entry: px, sma20: snap?.candles?.['1H']?.sma20, atr, swings: snap?.structure?.['1H']?.swings });
  if (zone && (stop - zone.stop) * dir > 0) {
    if (zone.tooWide) return { skip: `clearing the ${zone.level} at ${zone.boundary} needs a ${zone.dist.toFixed(2)} stop, past the ceiling; the location is wrong` };
    stop = +zone.stop.toFixed(2); dist = Math.abs(px - stop); widened = true;
  }
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
    note: widened ? `stop widened ${sl} → ${stop} (min ${minDist.toFixed(2)} from entry${zone && Math.abs(stop - +zone.stop.toFixed(2)) < 1e-9 ? `, past the ${zone.level} at ${zone.boundary}` : ''})` : '' };
}

// Rule 2 (LOCATION) enforced in code, whatever the model wrote: the price he'd
// actually enter at has to be sitting at 1H value for the side he's taking — within
// LOCATION_ATR × the 1H ATR14 of one of: the 1H SMA20; a 1H level price broke
// in that direction (a retest of the BOS / CHoCH); the edge of the 1H dealing
// range or its OTE band; a 1H trend line zone (rising support for a buy, falling
// resistance for a sell); or an unfilled 1H FVG / fresh-or-tested order block /
// breaker pointing that way. Nowhere near any of them = a chase, and the "enter"
// is refused. Returns { ok, at } or { skip } naming the nearest level.
const LOCATION_ATR = 0.5;
// Which way a trade sits against the bigger timeframes. Against the 4H, or against
// the 1D without being called a reversal, it goes in as a scalp only.
function tradeContext({ side, daily, snap }) {
  const against = (trend) => !!trend && ((side === 'buy' && trend === 'down') || (side === 'sell' && trend === 'up'));
  const d1 = snap?.candles?.['1D']?.trend, h4 = snap?.candles?.['4H']?.trend;
  const against1D = against(d1), against4H = against(h4);
  const pullback = against1D && daily !== 'reversal';
  return { d1, h4, against1D, against4H, pullback, scalpOnly: pullback || against4H };
}

function entryLocation({ side, entry, snap }) {
  const px = Number(entry);
  const dir = side === 'buy' ? 1 : -1;
  const h1 = snap?.candles?.['1H'];
  const atr = Number(h1?.atr14);
  if (!isFinite(px) || !px || !(atr > 0)) return { skip: 'no 1H ATR / price to check the entry location against' };
  const tol = LOCATION_ATR * atr;
  const st = snap?.structure?.['1H'];
  const zones = []; // { name, low, high }
  const lvl = (name, p) => { if (isFinite(Number(p))) zones.push({ name, low: Number(p), high: Number(p) }); };
  lvl('1H SMA20', h1.sma20);
  for (const e of (st?.events || []).filter((x) => x.dir === dir).slice(-3)) lvl(`1H broken ${dir > 0 ? 'high' : 'low'} (${e.type})`, e.level);
  if (st?.range) {
    lvl(`1H range ${dir > 0 ? 'low' : 'high'}`, dir > 0 ? st.range.low : st.range.high);
    if (Array.isArray(st.range.ote)) zones.push({ name: '1H OTE', low: Math.min(...st.range.ote), high: Math.max(...st.range.ote) });
  }
  for (const t of (st?.trendLines || []).filter((x) => x.dir === dir)) zones.push({ name: `1H trend ${t.kind} zone`, low: t.now - t.zone, high: t.now + t.zone });
  for (const g of (st?.fvgs || []).filter((x) => x.dir === dir && x.status !== 'filled')) zones.push({ name: `1H ${g.status === 'inverted' ? 'IFVG' : 'FVG'}`, low: g.low, high: g.high });
  for (const o of (st?.orderBlocks || []).filter((x) => x.dir === dir)) zones.push({ name: `1H ${o.kind === 'breaker' ? 'breaker' : 'order block'}`, low: o.low, high: o.high });
  if (!zones.length) return { skip: 'no 1H value levels to check the entry against' };
  const gap = (z) => (px < z.low ? z.low - px : px > z.high ? px - z.high : 0);
  const best = zones.reduce((a, z) => (gap(z) < gap(a) ? z : a));
  const where = (z) => (z.low === z.high ? `${z.name} ${+z.low.toFixed(2)}` : `${z.name} ${+z.low.toFixed(2)}–${+z.high.toFixed(2)}`);
  if (gap(best) <= tol) return { ok: true, at: where(best) };
  return { skip: `entry ${+px.toFixed(2)} isn't at 1H value — nearest is the ${where(best)}, ${gap(best).toFixed(2)} away (allowed ${tol.toFixed(2)} = ${LOCATION_ATR}× 1H ATR); that's a chase, not a pullback` };
}

module.exports = { SYMBOLS, STRATEGY, autoTradeDecision, newsTradeLevels, guardStop, entryLocation, tradeContext, LOCATION_ATR };
