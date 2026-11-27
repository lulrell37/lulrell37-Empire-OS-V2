// T.A.L.O.N.'s strategies, chosen per market (owner, 2026-11-27: "I don't want to lose
// that strategy we have now, so maybe make them changeable each pair. I can choose which
// strategy I want to use and when"). The playbook he trades today is the default and is
// never changed. The others come from S.A.G.E.'s two research notes ("Research — best
// trading bot strategies for gold and bitcoin…", "Research — Best forex trading bot
// strategies…") and are pure code, no AI call:
//
//   playbook        the current one: his AI brain's top-down setups (scalp + swing), quick
//                   scalps (gold, Bitcoin), add-ons and re-entries. Untouched.
//   trend_cross     EMA 9/21 cross on the closed 15m, RSI(14) over 55 to buy / under 45 to
//                   sell, with the 15m EMA200 as the trend filter. Stop past the last 10
//                   bars' swing + 0.25× ATR; target 2R. (Her Bitcoin research; any market.)
//   donchian        a closed 1H candle through the 20-bar high (buy) or low (sell). Stop at
//                   the 10-bar opposite channel; target 2R. (Best Bitcoin backtest in her
//                   note, Sharpe 1.95; any market.)
//   london_breakout gold and forex: the Asian range (7 PM-3 AM ET, 15m) breaks between 3 and
//                   7 AM ET on a decisive 15m close (body 75%+ of the candle), the day's range
//                   under 70% of the 14-day ATR; entry on the first pullback candle after the
//                   break, still outside the box. Stop at the box's middle; target 2R; once a
//                   day per market. (Her note says this one has no stable edge over 18 years:
//                   it's here as an option, not a recommendation.)
//
// Choice: app_settings.talon_strategies = { XAUUSD: { base: 'playbook', windows: [{ strategy,
// from, to }] } } (ET minutes; a window wins inside its hours, the base outside them).
// [TALON_STRATEGY: market | strategy | hours] / [TALON_STRATEGIES] (T.A.L.O.N., A.R.A.; a
// change only on his own message). Every order still goes through guardStop and
// tlPlaceOrder: the stop minimums, the $40 max loss, the market and day switches, live
// arming. One open trade per market from these strategies; journal setup `strat:<name>`;
// no add-ons or re-entries on them. node server/scripts/test-talon-strategies.js.
const TZ = 'America/New_York';

const STRATEGIES = {
  playbook: { name: 'the playbook (current)', markets: null, words: /\b(playbook|current|default|normal|usual|original|the one we have|smart money|ict)\b/i },
  trend_cross: { name: 'trend cross (EMA 9/21 + RSI)', markets: null, words: /\b(trend[ _-]?cross|ema|crossover|cross)\b/i },
  donchian: { name: 'Donchian breakout (20-bar 1H)', markets: null, words: /\b(donchian|channel)\b/i },
  london_breakout: { name: 'London breakout (Asian range)', markets: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'], words: /\b(london|asian? range|session breakout)\b/i },
};

let deps = null;
const d = () => ({
  getSetting: (...a) => require('./syncStore').getSetting(...a),
  setSetting: (...a) => require('./syncStore').setSetting(...a),
  history: (...a) => require('./tradeLocker').tlHistory(...a),
  ...(deps || {}),
});

const etParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
  .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const etMin = (ms) => { const p = etParts(ms); return (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10); };
const etDay = (ms) => { const p = etParts(ms); return `${p.year}-${p.month}-${p.day}`; };

// --- the choice ------------------------------------------------------------------

async function choices() {
  try { return JSON.parse(await d().getSetting('talon_strategies', '{}')) || {}; } catch { return {}; }
}
function activeIn(cfg, sym, now = Date.now()) {
  const c = cfg[sym] || {};
  const m = etMin(now);
  for (const w of c.windows || []) {
    const inside = w.from <= w.to ? m >= w.from && m < w.to : m >= w.from || m < w.to;
    if (inside && STRATEGIES[w.strategy]) return w.strategy;
  }
  return STRATEGIES[c.base] ? c.base : 'playbook';
}
async function active(sym, now = Date.now()) { return activeIn(await choices(), sym, now); }

// "3am-6am", "3-6am", "15:00-18:00", "9:30am to 11", "all day"
function parseHours(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t || /\b(all day|always|any ?time|24\/?7|all the time)\b/.test(t)) return null;
  const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|to|until|till)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!m) return undefined;
  const conv = (h, mi, ap, other) => {
    let hh = Number(h) % 12;
    const a = ap || other;
    if (a === 'pm') hh += 12;
    if (!a && Number(h) >= 13) hh = Number(h);
    if (!a && Number(h) === 12) hh = 12;
    return hh * 60 + (Number(mi) || 0);
  };
  const from = conv(m[1], m[2], m[3], m[6]), to = conv(m[4], m[5], m[6], m[3]);
  return from === to ? undefined : { from, to };
}
const hhmm = (min) => { const h = Math.floor(min / 60) % 24, m = min % 60; const ap = h >= 12 ? 'PM' : 'AM'; return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${ap}`; };

function strategyIn(text) {
  const t = String(text || '');
  return Object.keys(STRATEGIES).find((k) => STRATEGIES[k].words.test(t) || t.toLowerCase().replace(/\s+/g, '_').includes(k)) || null;
}

function describe(cfg) {
  const { SYMBOLS } = require('./talonBrain');
  return SYMBOLS.map((sym) => {
    const c = cfg[sym] || {};
    const base = STRATEGIES[c.base] ? c.base : 'playbook';
    const wins = (c.windows || []).filter((w) => STRATEGIES[w.strategy]).map((w) => `${STRATEGIES[w.strategy].name} ${hhmm(w.from)}-${hhmm(w.to)} ET`);
    return `${sym}: ${STRATEGIES[base].name}${wins.length ? `; ${wins.join('; ')}` : ''}`;
  }).join('\n');
}

const TOOLS = ` - STRATEGIES, PER MARKET: each market trades one strategy at a time, and he picks which and when. [TALON_STRATEGIES] lists what each market is on now and the choices. [TALON_STRATEGY: market | strategy] sets a market's strategy; [TALON_STRATEGY: market | strategy | 3am-6am] uses it only in those hours (ET) and the market's main one the rest of the time; [TALON_STRATEGY: market | playbook] puts it back on the current playbook and clears its hours. Markets: gold, bitcoin, nasdaq, eurusd, gbpusd, usdjpy, "forex" (all three pairs) or "all". Strategies: playbook (the current one, the default: top-down setups, scalp + swing, quick scalps, add-ons, re-entries), trend_cross (EMA 9/21 cross + RSI on the 15m, 2R), donchian (20-bar 1H channel breakout, 2R), london_breakout (gold and forex only: the Asian range break 3-7 AM ET, 2R; S.A.G.E.'s research found no stable edge in it, say so if he picks it). Only on his own message. Every strategy keeps the same protections: the stop minimums, $40 max loss, the market switches and the two-loss day stop.`;

async function tag(name, arg, { asked = '' } = {}) {
  const cfg = await choices();
  if (name === 'TALON_STRATEGIES') return `TALON_STRATEGIES:\n${describe(cfg)}\nChoices: ${Object.entries(STRATEGIES).map(([k, s]) => `${k} = ${s.name}${s.markets ? ` (${s.markets.join(', ')})` : ''}`).join('; ')}.`;
  if (name !== 'TALON_STRATEGY') return '';
  if (!String(asked || '').trim()) return 'TALON_STRATEGY: not changed — only on his own message.';
  const parts = String(arg || '').split('|').map((x) => x.trim());
  const { SYMBOLS, FOREX } = require('./talonBrain');
  const mk = parts[0] || '';
  const syms = /\b(all|every|everything)\b/i.test(mk) ? SYMBOLS : require('./talonSwitch').marketsIn(mk);
  if (!syms.length) return `TALON_STRATEGY: which market? (gold, bitcoin, nasdaq, eurusd, gbpusd, usdjpy, forex or all)`;
  const strat = strategyIn(parts[1] || '') || (/\breset\b/i.test(parts[1] || '') ? 'playbook' : null);
  if (!strat) return `TALON_STRATEGY: which strategy? ${Object.keys(STRATEGIES).join(', ')}`;
  const hours = parseHours(parts[2] || '');
  if (hours === undefined) return `TALON_STRATEGY: couldn't read the hours "${parts[2]}" — say them like 3am-6am (ET)`;
  const okSyms = syms.filter((s) => !STRATEGIES[strat].markets || STRATEGIES[strat].markets.includes(s));
  const refused = syms.filter((s) => !okSyms.includes(s));
  if (!okSyms.length) return `TALON_STRATEGY: ${STRATEGIES[strat].name} is for ${STRATEGIES[strat].markets.join(', ')} only.`;
  for (const s of okSyms) {
    const c = cfg[s] || { base: 'playbook', windows: [] };
    if (!hours) {
      c.base = strat;
      if (strat === 'playbook') c.windows = [];
    } else {
      c.windows = [...(c.windows || []).filter((w) => w.strategy !== strat), { strategy: strat, from: hours.from, to: hours.to }];
    }
    cfg[s] = c;
  }
  await d().setSetting('talon_strategies', JSON.stringify(cfg));
  const when = hours ? ` from ${hhmm(hours.from)} to ${hhmm(hours.to)} ET (the market's main strategy the rest of the time)` : '';
  const warn = strat === 'london_breakout' ? ' Note: S.A.G.E.\'s research found no stable edge in this one over 18 years of data.' : '';
  return `TALON_STRATEGY: ✓ ${okSyms.join(', ')} now ${strat === 'playbook' && !hours ? 'back on the playbook (current strategy)' : `on ${STRATEGIES[strat].name}${when}`}.${refused.length ? ` Not ${refused.join(', ')}: ${STRATEGIES[strat].name} is for ${STRATEGIES[strat].markets.join(', ')} only.` : ''}${warn}\nNow:\n${describe(cfg)}`;
}

// --- the signals (pure, closed bars only) -------------------------------------

function ema(vals, n) {
  const k = 2 / (n + 1); const out = []; let e = null;
  for (const v of vals) { e = e == null ? v : v * k + e * (1 - k); out.push(e); }
  return out;
}
function rsi(closes, n = 14) {
  const out = Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = Math.max(ch, 0), dn = Math.max(-ch, 0);
    if (i <= n) { g += up; l += dn; if (i === n) { g /= n; l /= n; out[i] = l ? 100 - 100 / (1 + g / l) : 100; } continue; }
    g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n;
    out[i] = l ? 100 - 100 / (1 + g / l) : 100;
  }
  return out;
}
function atr(bars, n = 14) {
  const trs = bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l));
  const last = trs.slice(-n);
  return last.length ? last.reduce((a, v) => a + v, 0) / last.length : 0;
}
const R = 2;
const plan = (side, entry, stop, why) => {
  const dir = side === 'buy' ? 1 : -1;
  const dist = (entry - stop) * dir;
  if (!(dist > 0)) return null;
  return { side, entry, stopLoss: stop, takeProfit: entry + dir * R * dist, why };
};

// 15m closed bars (oldest first) -> a plan for the newest bar, or null.
function trendCross(m15) {
  if (m15.length < 210) return null;
  const c = m15.map((b) => b.c);
  const e9 = ema(c, 9), e21 = ema(c, 21), e200 = ema(c, 200), r = rsi(c, 14);
  const i = m15.length - 1;
  const up = e9[i - 1] <= e21[i - 1] && e9[i] > e21[i], dn = e9[i - 1] >= e21[i - 1] && e9[i] < e21[i];
  const a = atr(m15.slice(-15));
  const last10 = m15.slice(-10);
  if (up && r[i] > 55 && c[i] > e200[i]) return plan('buy', c[i], Math.min(...last10.map((b) => b.l)) - 0.25 * a, `EMA 9 crossed over 21 on the 15m, RSI ${r[i].toFixed(0)}, above the EMA200`);
  if (dn && r[i] < 45 && c[i] < e200[i]) return plan('sell', c[i], Math.max(...last10.map((b) => b.h)) + 0.25 * a, `EMA 9 crossed under 21 on the 15m, RSI ${r[i].toFixed(0)}, below the EMA200`);
  return null;
}

// 1H closed bars -> a plan for the newest bar, or null.
function donchian(h1) {
  if (h1.length < 22) return null;
  const i = h1.length - 1, b = h1[i];
  const prior = h1.slice(i - 20, i);
  const hi = Math.max(...prior.map((x) => x.h)), lo = Math.min(...prior.map((x) => x.l));
  const ten = h1.slice(i - 10, i);
  if (b.c > hi) return plan('buy', b.c, Math.min(...ten.map((x) => x.l)), `1H closed above the 20-bar high ${hi}`);
  if (b.c < lo) return plan('sell', b.c, Math.max(...ten.map((x) => x.h)), `1H closed below the 20-bar low ${lo}`);
  return null;
}

// 15m closed bars + 1D closed bars -> a plan for the newest bar, or null.
function londonBreakout(m15, d1) {
  if (!m15.length) return null;
  const last = m15[m15.length - 1];
  const m = etMin(last.t), day = etDay(last.t);
  if (m < 3 * 60 || m >= 7 * 60) return null;
  // The Asian box: 7 PM yesterday to 3 AM today (ET).
  const start = Number(last.t) - (m + 5 * 60) * 60000, boxEnd = Number(last.t) - (m - 3 * 60) * 60000;
  const box = m15.filter((b) => Number(b.t) >= start && Number(b.t) < boxEnd);
  if (box.length < 16) return null;
  const hi = Math.max(...box.map((b) => b.h)), lo = Math.min(...box.map((b) => b.l)), mid = (hi + lo) / 2;
  const a14 = atr(d1.slice(-15), 14);
  const todays = m15.filter((b) => etDay(b.t) === day);
  const dayRange = Math.max(...todays.map((b) => b.h)) - Math.min(...todays.map((b) => b.l));
  if (a14 && dayRange >= 0.7 * a14) return null;
  const after = m15.filter((b) => Number(b.t) >= boxEnd);
  const decisive = (b) => (b.h - b.l) > 0 && Math.abs(b.c - b.o) >= 0.75 * (b.h - b.l);
  const brk = after.findIndex((b) => (b.c > hi || b.c < lo) && decisive(b));
  if (brk < 0 || brk === after.length - 1) return null;
  const up = after[brk].c > hi;
  // The first pullback candle after the break is the newest bar, still outside the box.
  const pull = after.slice(brk + 1).findIndex((b) => (up ? b.c < b.o && b.c > hi : b.c > b.o && b.c < lo));
  if (pull < 0 || brk + 1 + pull !== after.length - 1) return null;
  return plan(up ? 'buy' : 'sell', last.c, mid, `Asian range ${lo}-${hi} broke ${up ? 'up' : 'down'} at London, first pullback`);
}

// --- running them ------------------------------------------------------------------

async function signalFor(strategy, sym) {
  const { closedBars } = require('./marketStructure');
  if (strategy === 'trend_cross') return trendCross(closedBars(await d().history(sym, '15m', 260), '15m'));
  if (strategy === 'donchian') return donchian(closedBars(await d().history(sym, '1H', 60), '1H'));
  if (strategy === 'london_breakout') {
    const [m15, d1] = await Promise.all([d().history(sym, '15m', 120), d().history(sym, '1D', 30)]);
    return londonBreakout(closedBars(m15, '15m'), closedBars(d1, '1D'));
  }
  return null;
}

// Every 5-min tick (talonAutoTrade): each market on a coded strategy checks its newest
// closed candle; a signal goes in through the same guards as every order.
async function strategyTick({ syms, place }) {
  const cfg = await choices();
  let state = {};
  try { state = JSON.parse(await d().getSetting('talon_strategy_state', '{}')) || {}; } catch { state = {}; }
  const out = [];
  for (const sym of syms) {
    const strategy = activeIn(cfg, sym);
    if (strategy === 'playbook') continue;
    if (STRATEGIES[strategy].markets && !STRATEGIES[strategy].markets.includes(sym)) continue;
    let sig;
    try { sig = await signalFor(strategy, sym); } catch (e) { console.error(`talon strategies failed: ${sym} ${strategy}: ${e.message}`); continue; }
    if (!sig) continue;
    const key = `${sym}:${strategy}`;
    const stamp = `${sig.side}@${sig.entry}`;
    if (state[key] === stamp) continue; // this candle's signal was already handled
    state[key] = stamp;
    await d().setSetting('talon_strategy_state', JSON.stringify(state)).catch(() => {});
    out.push({ sym, strategy, ...(await place(sym, strategy, sig).catch((e) => ({ error: e.message }))) });
  }
  return out;
}

const isStrategyTrade = (t) => /^strat:/.test(String((t && t.setup) || ''));

module.exports = { STRATEGIES, TOOLS, tag, active, activeIn, choices, parseHours, strategyIn, describe, trendCross, donchian, londonBreakout, ema, rsi, strategyTick, isStrategyTrade, _setDeps: (x) => { deps = x; } };
