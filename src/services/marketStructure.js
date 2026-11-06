// T.A.L.O.N.'s chart reading: price-action / smart-money concepts computed from
// candles. Mirrors server/marketStructure.js (keep in sync — only this header and
// the exports differ; server/scripts/test-market-structure.js checks it). See that
// file for the notes.
const TF_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1H': 3600e3, '4H': 14400e3, '1D': 86400e3, '1W': 604800e3 };
const SWING_K = 2;        // a swing = higher/lower than the 2 bars each side
const EQUAL_TOL = 0.15;   // equal highs/lows: within this × ATR
const MIN_GAP = 0.1;      // an FVG smaller than this × ATR is noise
const DISPLACEMENT = 1.5; // a displacement candle's body, × ATR
const ROUND = { XAUUSD: [10, 50], BTCUSD: [1000, 5000] };
const SESSIONS = [ // ET minutes — the ICT kill zones
  { name: 'Asia', from: 20 * 60, to: 24 * 60 },
  { name: 'London', from: 2 * 60, to: 5 * 60 },
  { name: 'NY AM', from: 7 * 60, to: 10 * 60 },
  { name: 'NY PM', from: 13.5 * 60, to: 16 * 60 },
];

const px = (n) => +Number(n).toFixed(2);

function closedBars(bars, tf, now = Date.now()) {
  const ms = TF_MS[tf];
  return (bars || []).filter((b) => !ms || Number(b.t) + ms <= now);
}

// Rolling mean true range over 14 bars, one value per bar.
function rollingAtr(bars) {
  const tr = bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l));
  let sum = 0;
  return tr.map((x, i) => {
    sum += x;
    if (i >= 14) sum -= tr[i - 14];
    return sum / Math.min(i + 1, 14);
  });
}

function findSwings(bars, k = SWING_K) {
  const out = [];
  for (let i = k; i < bars.length - k; i++) {
    const left = bars.slice(i - k, i), right = bars.slice(i + 1, i + k + 1);
    if (left.every((b) => b.h <= bars[i].h) && right.every((b) => b.h < bars[i].h)) out.push({ type: 'high', price: bars[i].h, i, confirmAt: i + k });
    if (left.every((b) => b.l >= bars[i].l) && right.every((b) => b.l > bars[i].l)) out.push({ type: 'low', price: bars[i].l, i, confirmAt: i + k });
  }
  return out;
}

// Closes through the last confirmed swing. With the prevailing direction = BOS,
// against it = CHoCH (a market structure shift).
function structureEvents(bars, swings) {
  const events = [];
  let bias = null, hi = null, lo = null, next = 0;
  const ordered = [...swings].sort((a, b) => a.confirmAt - b.confirmAt);
  bars.forEach((b, j) => {
    if (hi && b.c > hi.price) {
      events.push({ type: bias === 'bear' ? 'CHoCH' : 'BOS', dir: 1, level: hi.price, i: j, swingI: hi.i });
      bias = 'bull'; hi = null;
    } else if (lo && b.c < lo.price) {
      events.push({ type: bias === 'bull' ? 'CHoCH' : 'BOS', dir: -1, level: lo.price, i: j, swingI: lo.i });
      bias = 'bear'; lo = null;
    }
    // A swing confirmed by this bar's close can only be broken from the next bar.
    while (next < ordered.length && ordered[next].confirmAt <= j) {
      const s = ordered[next++];
      if (s.type === 'high') hi = s; else lo = s;
    }
  });
  return { events, bias };
}

// A swing's first trade-through. Wick through and close back inside = a sweep
// (stops taken, the level held). Closing beyond it is a break, not a sweep.
function findSweeps(bars, swings, atrs) {
  const byKey = new Map();
  for (const s of swings) {
    const dir = s.type === 'high' ? 1 : -1;
    for (let j = s.confirmAt + 1; j < bars.length; j++) {
      const b = bars[j];
      const pierce = dir > 0 ? b.h - s.price : s.price - b.l;
      if (pierce <= 0.02 * atrs[j]) continue;
      if ((b.c - s.price) * dir < 0) {
        const tol = EQUAL_TOL * atrs[j];
        const touches = swings.filter((x) => x.type === s.type && x.i < j && Math.abs(x.price - s.price) <= tol).length;
        const key = `${j}:${s.type}`;
        const prev = byKey.get(key);
        // One candle can take several swings: keep the most significant one.
        if (!prev || (s.price - prev.level) * dir > 0) {
          const wick = dir > 0 ? b.h : b.l;
          byKey.set(key, {
            side: dir > 0 ? 'buy' : 'sell', implied: -dir, level: s.price, wick, i: j, swingI: s.i, touches,
            held: bars.slice(j + 1).every((x) => (x.c - wick) * dir <= 0),
          });
        }
      }
      break;
    }
  }
  return [...byKey.values()].sort((a, b) => a.i - b.i);
}

// Untaken swings = resting stops. Swings within tolerance cluster into one
// pool (equal highs/lows — the obvious stops, the ones that get hunted).
function liquidityPools(bars, swings, atr) {
  const tol = EQUAL_TOL * atr;
  const pools = [];
  for (const type of ['high', 'low']) {
    const dir = type === 'high' ? 1 : -1;
    // Still resting = nothing has traded past it, except a neighbouring swing
    // close enough to make an equal high/low with it.
    const own = new Set(swings.filter((s) => s.type === type).map((s) => s.i));
    const live = swings
      .filter((s) => s.type === type && bars.every((b, j) => {
        if (j <= s.i) return true;
        const past = ((dir > 0 ? b.h : b.l) - s.price) * dir;
        return past <= 0 || (past <= tol && own.has(j));
      }))
      .sort((a, b) => a.price - b.price);
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const prices = group.map((s) => s.price);
      pools.push({
        side: dir > 0 ? 'buy' : 'sell', price: dir > 0 ? Math.max(...prices) : Math.min(...prices), touches: group.length,
        kind: group.length > 1 ? (dir > 0 ? 'EQH' : 'EQL') : (dir > 0 ? 'swing high' : 'swing low'),
        i: Math.min(...group.map((s) => s.i)),
      });
      group = [];
    };
    for (const s of live) {
      if (group.length && s.price - group[group.length - 1].price > tol) flush();
      group.push(s);
    }
    flush();
  }
  return pools;
}

// Three-candle imbalance: candle 1 and candle 3 don't overlap. Bullish FVGs fill
// from the top, bearish from the bottom. A close through the far side inverts it
// (IFVG: old support now resistance); a close back through kills it.
function findFvgs(bars, atrs) {
  const out = [];
  for (let i = 2; i < bars.length; i++) {
    const c1 = bars[i - 2], c3 = bars[i];
    let dir = 0, low, high;
    if (c3.l > c1.h) { dir = 1; low = c1.h; high = c3.l; }
    else if (c3.h < c1.l) { dir = -1; low = c3.h; high = c1.l; }
    if (!dir || high - low < MIN_GAP * atrs[i]) continue;
    let fill = 0, inverted = false, dead = false;
    for (let j = i + 1; j < bars.length && !dead; j++) {
      const b = bars[j];
      fill = Math.max(fill, dir > 0 ? (high - b.l) / (high - low) : (b.h - low) / (high - low));
      if (!inverted && (dir > 0 ? b.c < low : b.c > high)) inverted = true;
      else if (inverted && (dir > 0 ? b.c > high : b.c < low)) dead = true;
    }
    if (dead) continue;
    const status = inverted ? 'inverted' : fill >= 1 ? 'filled' : fill > 0 ? 'partial' : 'open';
    if (status === 'filled') continue;
    out.push({ dir: inverted ? -dir : dir, low, high, ce: (low + high) / 2, i, startI: i - 1, status, fill: Math.min(fill, 1) });
  }
  return out;
}

// The last opposite candle at the origin of a displaced move that broke
// structure. Closed through = a breaker, which flips sides.
function findOrderBlocks(bars, events, atrs, fvgs) {
  const seen = new Set(), out = [];
  for (const e of events) {
    const dir = e.dir, j = e.i;
    const from = e.swingI; // the origin of the move sits between the broken swing and the break
    let ext = from;
    for (let k = from; k <= j; k++) if (dir > 0 ? bars[k].l <= bars[ext].l : bars[k].h >= bars[ext].h) ext = k;
    let ob = -1;
    for (let k = ext; k >= Math.max(0, ext - 3); k--) if ((bars[k].c - bars[k].o) * dir < 0) { ob = k; break; }
    if (ob < 0 || seen.has(ob)) continue;
    const displaced = bars.slice(ob + 1, j + 1).some((b, x) => Math.abs(b.c - b.o) >= 1.2 * atrs[ob + 1 + x])
      || fvgs.some((f) => f.i > ob && f.i <= j && f.status !== 'inverted' && f.dir === dir);
    if (!displaced) continue;
    seen.add(ob);
    const { l: low, h: high } = bars[ob];
    let broken = false, tested = false, dead = false;
    for (let x = j + 1; x < bars.length && !dead; x++) {
      const b = bars[x];
      if (!broken && (dir > 0 ? b.c < low : b.c > high)) broken = true;
      else if (broken && (dir > 0 ? b.c > high : b.c < low)) dead = true;
      else if (!broken && (dir > 0 ? b.l <= high : b.h >= low)) tested = true;
    }
    if (dead) continue;
    out.push({ kind: broken ? 'breaker' : 'ob', dir: broken ? -dir : dir, low, high, i: ob, status: broken ? 'flipped' : tested ? 'tested' : 'fresh' });
  }
  return out;
}

// The current leg over the last 40 bars, oriented by structure. Above the 50% =
// premium (sell zone), below = discount (buy zone); OTE = the 62-79% retracement.
function dealingRange(bars, bias) {
  const w = bars.slice(-40);
  const maxI = w.reduce((m, b, i) => (b.h >= w[m].h ? i : m), 0);
  const minI = w.reduce((m, b, i) => (b.l <= w[m].l ? i : m), 0);
  let high, low;
  if (bias === 'bull') {
    low = w[minI].l;
    high = Math.max(...w.slice(minI).map((b) => b.h));
  } else if (bias === 'bear') {
    high = w[maxI].h;
    low = Math.min(...w.slice(maxI).map((b) => b.l));
  } else { high = w[maxI].h; low = w[minI].l; }
  const r = high - low;
  if (!(r > 0)) return null;
  const last = bars[bars.length - 1].c;
  const pos = (last - low) / r;
  const ote = bias === 'bear' ? [low + 0.62 * r, low + 0.79 * r] : [high - 0.79 * r, high - 0.62 * r];
  return { high, low, eq: (high + low) / 2, pos, zone: pos > 0.5 ? 'premium' : 'discount', ote };
}

function analyzeStructure(bars) {
  if (!bars || bars.length < 10) return null;
  const atrs = rollingAtr(bars);
  const atr = atrs[atrs.length - 1];
  const swings = findSwings(bars);
  const { events, bias } = structureEvents(bars, swings);
  const fvgs = findFvgs(bars, atrs);
  let displacement = null;
  bars.forEach((b, i) => {
    const body = Math.abs(b.c - b.o), range = b.h - b.l;
    if (range > 0 && body >= DISPLACEMENT * atrs[i] && body / range >= 0.6) displacement = { dir: Math.sign(b.c - b.o), i };
  });
  return {
    n: bars.length, atr, bias, swings, events, fvgs, displacement,
    last: bars[bars.length - 1].c,
    sweeps: findSweeps(bars, swings, atrs),
    pools: liquidityPools(bars, swings, atr),
    orderBlocks: findOrderBlocks(bars, events, atrs, fvgs),
    range: dealingRange(bars, bias),
  };
}

// --- key levels --------------------------------------------------------------

let etFmt = null;
function etOf(ms) {
  etFmt = etFmt || new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = {};
  for (const x of etFmt.formatToParts(new Date(Number(ms)))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, min: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
}

function killZone(now = Date.now()) {
  const { min } = etOf(now);
  const s = SESSIONS.find((x) => min >= x.from && min < x.to);
  return s ? s.name : null;
}

// Daily candles open in the evening UTC on most brokers: shift so they group with the trading day they belong to.
const dayShift = (t) => Number(t) + 5 * 3600e3;
const weekKey = (t) => Math.floor((dayShift(t) + 3 * 86400e3) / (7 * 86400e3));
const monthKey = (t) => { const d = new Date(dayShift(t)); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

function keyLevels({ symbol, daily = [], m15 = [], price, now = Date.now() }) {
  const out = [];
  const after = (t, list) => list.filter((b) => Number(b.t) >= t);
  const add = (label, high, low, endT) => {
    const later = [...after(endT, daily), ...after(endT, m15)];
    out.push({ label: `${label}H`, price: high, taken: later.some((b) => b.h > high), side: 'buy' });
    out.push({ label: `${label}L`, price: low, taken: later.some((b) => b.l < low), side: 'sell' });
  };
  const group = (keyOf, label) => {
    const cur = keyOf(now);
    const keys = daily.map((b) => keyOf(b.t)).filter((k) => k < cur);
    if (!keys.length) return;
    const prev = Math.max(...keys);
    const bars = daily.filter((b) => keyOf(b.t) === prev);
    add(label, Math.max(...bars.map((b) => b.h)), Math.min(...bars.map((b) => b.l)), Number(bars[bars.length - 1].t) + TF_MS['1D']);
  };
  if (daily.length) {
    const d = daily[daily.length - 1];
    const endT = Number(d.t) + TF_MS['1D'];
    const later = after(endT, m15);
    out.push({ label: 'PDH', price: d.h, taken: later.some((b) => b.h > d.h), side: 'buy' });
    out.push({ label: 'PDL', price: d.l, taken: later.some((b) => b.l < d.l), side: 'sell' });
    group(weekKey, 'PW');
    group(monthKey, 'PM');
  }
  // The latest run of each session in the 15m bars. Bars are tagged in ET.
  try {
    const tagged = m15.map((b) => ({ b, et: etOf(b.t) }));
    for (const s of SESSIONS) {
      let run = [];
      for (const x of tagged) {
        if (x.et.min < s.from || x.et.min >= s.to) continue;
        if (run.length && Number(x.b.t) - Number(run[run.length - 1].b.t) > 6 * 3600e3) run = [];
        run.push(x);
      }
      if (!run.length || now - Number(run[run.length - 1].b.t) > 48 * 3600e3) continue;
      const hi = Math.max(...run.map((x) => x.b.h)), lo = Math.min(...run.map((x) => x.b.l));
      const later = m15.filter((b) => Number(b.t) > Number(run[run.length - 1].b.t));
      out.push({ label: `${s.name} H`, price: hi, taken: later.some((b) => b.h > hi), side: 'buy' });
      out.push({ label: `${s.name} L`, price: lo, taken: later.some((b) => b.l < lo), side: 'sell' });
    }
    const today = etOf(now).day;
    const open = tagged.find((x) => x.et.day === today && x.et.min === 0);
    if (open) out.push({ label: 'Midnight open', price: open.b.o, taken: false, side: null });
  } catch { /* no timezone data on this device: skip sessions, keep the rest */ }
  const steps = ROUND[String(symbol || '').toUpperCase()];
  if (steps && isFinite(price)) {
    const seen = new Set();
    for (const step of [...steps].reverse()) {
      for (const p of [Math.floor(price / step) * step, Math.ceil(price / step) * step]) {
        if (seen.has(p) || p === price) continue;
        seen.add(p);
        out.push({ label: step === steps[1] ? 'Major round' : 'Round', price: p, taken: false, side: null });
      }
    }
  }
  return out;
}

// --- the stop's danger zone ------------------------------------------------------

const ZONE_ROUND = { XAUUSD: 50, BTCUSD: 500 };
const ZONE_BUFFER = 0.2; // × 1H ATR past the zone's far side
const STOP_CEILING = { XAUUSD: () => 35, BTCUSD: (px) => px * 0.03 };

// Where a main-rule stop has to be to clear the danger zone: the furthest of the 1H
// SMA20, the round number nearest entry and the last 1H swing, whichever of them are
// on the risk side, plus a buffer. Price wicks into those levels for the stops
// resting there, so a stop can pass the flat minimum and still be in harm's way.
// tooWide = past the skip ceiling (gold $35 / Bitcoin 3%). Null when there's nothing
// to check. Quick scalps and add-ons don't use this.
function zoneStop({ symbol, side, entry, sma20, atr = 0, swings = [] }) {
  const sym = String(symbol || '').toUpperCase();
  const step = ZONE_ROUND[sym];
  const px0 = Number(entry);
  if (!step || !isFinite(px0) || !px0) return null;
  const dir = side === 'buy' ? 1 : -1;
  const onRisk = (v) => isFinite(v) && (px0 - v) * dir > 0;
  const swing = [...swings].reverse().find((s) => s.type === (dir > 0 ? 'low' : 'high') && onRisk(s.price));
  const levels = [
    { name: 'SMA20', price: Number(sma20) },
    { name: 'round number', price: Math.round(px0 / step) * step },
    { name: '1H swing', price: swing ? swing.price : NaN },
  ].filter((l) => l.price && onRisk(l.price));
  if (!levels.length) return null;
  const far = levels.reduce((a, l) => ((px0 - l.price) * dir > (px0 - a.price) * dir ? l : a));
  const stop = far.price - dir * ZONE_BUFFER * (Number(atr) || 0);
  return { stop, boundary: far.price, level: far.name, dist: Math.abs(px0 - stop), tooWide: Math.abs(px0 - stop) > STOP_CEILING[sym](px0) };
}

// --- text for the brain -------------------------------------------------------

const barsAgo = (st, i) => {
  const n = st.n - 1 - i;
  return n === 0 ? 'last candle' : n === 1 ? '1 bar ago' : `${n} bars ago`;
};
const nearest = (list, price, get, count) => [...list].sort((a, b) => Math.abs(get(a) - price) - Math.abs(get(b) - price)).slice(0, count);

function formatTimeframe(tf, st, price) {
  if (!st) return `${tf}: not enough closed candles`;
  const L = [];
  const last = (type) => [...st.events].reverse().find((e) => e.type === type);
  const ev = (e) => `${e.type} ${e.dir > 0 ? 'up' : 'down'} through ${px(e.level)}, ${barsAgo(st, e.i)}`;
  const heads = [last('BOS'), last('CHoCH')].filter(Boolean).sort((a, b) => b.i - a.i).map(ev);
  let head = `${tf}: structure ${st.bias === 'bull' ? 'BULLISH' : st.bias === 'bear' ? 'BEARISH' : 'UNDEFINED'}${heads.length ? ` (${heads.join('; ')})` : ''}`;
  if (st.range) head += `. Range ${px(st.range.low)}–${px(st.range.high)}, price in ${st.range.zone.toUpperCase()} at ${Math.round(st.range.pos * 100)}% (50% ${px(st.range.eq)}, OTE ${px(st.range.ote[0])}–${px(st.range.ote[1])})`;
  L.push(head);
  const pool = (p) => `${p.kind} ${px(p.price)}${p.touches > 1 ? ` x${p.touches}` : ''}`;
  const above = st.pools.filter((p) => p.side === 'buy' && p.price >= price).sort((a, b) => a.price - b.price).slice(0, 3);
  const below = st.pools.filter((p) => p.side === 'sell' && p.price <= price).sort((a, b) => b.price - a.price).slice(0, 3);
  L.push(`  Liquidity resting: above ${above.map(pool).join(', ') || 'none in view'}; below ${below.map(pool).join(', ') || 'none in view'}`);
  const sweeps = st.sweeps.filter((s) => st.n - 1 - s.i <= 15).slice(-3).reverse();
  if (sweeps.length) L.push(`  Sweeps: ${sweeps.map((s) => `${s.side}-side ${px(s.level)}${s.touches > 1 ? ` (equal ${s.side === 'buy' ? 'highs' : 'lows'})` : ''} taken to ${px(s.wick)}, closed back ${s.side === 'buy' ? 'under' : 'over'}, ${barsAgo(st, s.i)}, ${s.held ? `holding (${s.implied > 0 ? 'bullish' : 'bearish'})` : 'FAILED — closed past the wick since'}`).join('; ')}`);
  const fvg = (f) => `${f.status === 'inverted' ? 'IFVG ' : ''}${f.dir > 0 ? 'bullish' : 'bearish'} ${px(f.low)}–${px(f.high)} (CE ${px(f.ce)}, ${f.status === 'open' ? 'unfilled' : f.status === 'partial' ? `${Math.round(f.fill * 100)}% filled` : 'flipped'})`;
  const gaps = nearest(st.fvgs, price, (f) => f.ce, 4);
  if (gaps.length) L.push(`  FVGs: ${gaps.map(fvg).join('; ')}`);
  const block = (o) => `${o.kind === 'breaker' ? 'breaker' : 'OB'} ${o.dir > 0 ? 'bullish' : 'bearish'} ${px(o.low)}–${px(o.high)} (${o.status})`;
  const blocks = nearest(st.orderBlocks, price, (o) => (o.low + o.high) / 2, 3);
  if (blocks.length) L.push(`  Order blocks: ${blocks.map(block).join('; ')}`);
  if (st.displacement && st.n - 1 - st.displacement.i <= 10) L.push(`  Displacement: ${st.displacement.dir > 0 ? 'up' : 'down'} candle, ${barsAgo(st, st.displacement.i)}`);
  return L.join('\n');
}

function formatLevels(levels, price) {
  const line = (l) => `${l.label} ${px(l.price)}${l.taken ? ' (taken)' : ''}`;
  const above = levels.filter((l) => l.price >= price).sort((a, b) => a.price - b.price).slice(0, 6);
  const below = levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price).slice(0, 6);
  return `Key levels above: ${above.map(line).join(', ') || 'none'}\nKey levels below: ${below.map(line).join(', ') || 'none'}`;
}

function formatMarketRead({ structure, levels, price, now = Date.now() }) {
  if (!structure || !isFinite(price)) return '';
  let zone = null;
  try { zone = killZone(now); } catch { /* no timezone data */ }
  const L = [`SMART-MONEY READ (computed from closed candles — these levels are real; don't invent others). ${zone ? `Now in the ${zone} kill zone.` : 'Outside the kill zones.'}`];
  if (levels?.length) L.push(formatLevels(levels, price));
  for (const tf of Object.keys(structure)) L.push(formatTimeframe(tf, structure[tf], price));
  return L.join('\n');
}

// --- what he knows -------------------------------------------------------------

const TRADING_KNOWLEDGE = `TRADING KNOWLEDGE — you speak this fluently, and use a term only for what's actually on the chart:
LIQUIDITY: stops and pending orders resting beyond obvious levels. Buy-side (BSL) sits above highs, sell-side (SSL) below lows. Equal highs/lows (EQH/EQL), trendlines and session extremes are the obvious pools; price is drawn to them. Inducement: a minor level that baits early entries before the real move. External range liquidity = the swing extremes of the range; internal = FVGs and order blocks inside it; price tends to run from one to the other.
SWEEPS: a liquidity sweep / grab / stop hunt / SFP (swing failure pattern) / turtle soup wicks through a level and closes back inside: stops taken, the level held. Closing through and staying through is a break, not a sweep. Judas swing: the false session-open move that sweeps one side before the real direction. AMD / Power of 3: accumulation, manipulation, distribution.
STRUCTURE: HH/HL uptrend, LH/LL downtrend. BOS (break of structure): a candle CLOSE through a swing with the trend. CHoCH / MSS (change of character / market structure shift): the first close through a swing against it. Displacement: a large-bodied impulsive candle, usually leaving an FVG, showing real intent. Protected high/low: the swing that has to hold for the trend to stand.
IMBALANCE: FVG (fair value gap, BISI bullish / SIBI bearish): three candles where 1 and 3 don't overlap; price often returns to rebalance. CE (consequent encroachment) is its 50%. IFVG (inverted FVG): closed through, it flips sides. Liquidity void: a stretch of one-sided candles. Volume imbalance: a gap between candle bodies.
BLOCKS: order block (OB): the last opposite candle before a displaced move that broke structure. Breaker: a failed OB, closed through, flips sides. Mitigation block: a failed OB with no sweep before it. Rejection block: the wick of a sharp rejection. Supply/demand zones are the same idea in classic terms. Mitigation: price returning to a zone to fill the orders left there.
RANGE: dealing range = the current leg's high and low; above its 50% (equilibrium) is premium, below is discount. Buy in discount, sell in premium. OTE (optimal trade entry): the 62-79% retracement. Fibonacci: 0.382, 0.5, 0.618, 0.705, 0.79; extensions -0.27, -0.62, -1.0 as targets.
KEY LEVELS: PDH/PDL, PWH/PWL, PMH/PML, session highs/lows, midnight open, round numbers. S/R flip: broken support becomes resistance. Pivots, VWAP, moving averages. Kill zones (ET): Asia 8 PM-midnight, London 2-5 AM, NY AM 7-10 AM, NY PM 1:30-4 PM.
CLASSIC: Wyckoff (accumulation, distribution, spring, upthrust, SOS/SOW). Patterns: double top/bottom, head and shoulders, flags, wedges, triangles. Candles: engulfing, pin bar/hammer/shooting star, doji, inside/outside bar, morning/evening star. Indicators: RSI, MACD, EMA/SMA, ATR, Bollinger Bands, divergence. Volume profile: POC, VAH, VAL, HVN, LVN. Order flow: delta, absorption, open interest, funding. SMT divergence: correlated markets disagreeing at a high or low (one sweeps, the other doesn't).
RISK: R multiple, RR, position sizing, drawdown, expectancy, spread, slippage, partials, break-even, trailing stops, confluence, invalidation.
WHAT YOU CAN SEE: candles (OHLC), the SMART-MONEY READ and the cross-market quotes. You do NOT have reliable volume, order flow, open interest, funding, or RSI/MACD values. Explain those when asked, but never quote a reading you weren't given.`;

// --- one drawing model for both renderers ---------------------------------------

const COLORS = {
  up: '#5FA779', down: '#C7614B', bull: '#5FA779', bear: '#C7614B', breaker: '#C77DBB', flip: '#D9A441',
  pool: '#5B8DEF', level: '#8A8A8A', entry: '#E8C98A', stop: '#E0555F', target: '#5FA779', text: '#D8D2C4',
};

function chartModel({ symbol, tf, bars, structure: st, levels = [], positions = [], visible = 80, now = Date.now() }) {
  const shown = (bars || []).slice(-visible);
  if (!shown.length) return null;
  const start = Math.max(0, bars.length - visible);
  const toX = (i) => i - start;
  const n = shown.length;
  const lastPx = shown[n - 1].c;
  const xEnd = n - 0.5;
  const xMax = n + Math.ceil(n * 0.3);
  const lo = Math.min(...shown.map((b) => b.l)), hi = Math.max(...shown.map((b) => b.h));
  const reach = (hi - lo) * 0.25;
  const inView = (p) => p >= lo - reach && p <= hi + reach;

  const zones = [], lines = [], marks = [], labels = [];
  const label = (y, text, color, pri) => labels.push({ y, text, color, pri });
  if (st) {
    for (const f of nearest(st.fvgs, lastPx, (x) => x.ce, 5)) {
      if (!inView(f.low) && !inView(f.high)) continue;
      const color = f.dir > 0 ? COLORS.bull : COLORS.bear;
      zones.push({ x1: Math.max(0, toX(f.startI)), x2: xEnd, y1: f.low, y2: f.high, color, opacity: 0.2 });
      label(f.ce, `${f.status === 'inverted' ? 'IFVG' : 'FVG'} ${px(f.low)}–${px(f.high)}`, color, 2);
    }
    for (const o of nearest(st.orderBlocks, lastPx, (x) => (x.low + x.high) / 2, 3)) {
      if (!inView(o.low) && !inView(o.high)) continue;
      const color = o.kind === 'breaker' ? COLORS.breaker : COLORS.flip;
      zones.push({ x1: Math.max(0, toX(o.i)), x2: xEnd, y1: o.low, y2: o.high, color, opacity: 0.16 });
      label((o.low + o.high) / 2, `${o.kind === 'breaker' ? 'Breaker' : 'OB'} ${o.dir > 0 ? '▲' : '▼'} ${px(o.low)}–${px(o.high)}`, color, 2);
    }
    for (const p of st.pools) {
      if (!inView(p.price)) continue;
      lines.push({ x1: Math.max(0, toX(p.i)), x2: xEnd, y: p.price, color: COLORS.pool, dash: true });
      if (p.touches > 1) label(p.price, `${p.kind} ${px(p.price)}`, COLORS.pool, 3);
    }
    for (const e of st.events) {
      if (e.i < start) continue;
      const color = e.dir > 0 ? COLORS.up : COLORS.down;
      lines.push({ x1: Math.max(0, toX(e.swingI)), x2: toX(e.i), y: e.level, color, dash: false, text: e.type });
    }
    for (const s of st.sweeps) {
      if (s.i < start || !s.held) continue; // a sweep price has since closed past is just a break
      marks.push({ x: toX(s.i), y: s.wick, up: s.side === 'sell', color: s.side === 'sell' ? COLORS.up : COLORS.down, text: s.side === 'sell' ? 'SSL swept' : 'BSL swept' });
    }
  }
  for (const l of levels) {
    if (l.taken || !inView(l.price)) continue;
    lines.push({ x1: 0, x2: xEnd, y: l.price, color: COLORS.level, dash: true });
    label(l.price, `${l.label} ${px(l.price)}`, COLORS.level, 4);
  }
  for (const p of positions) {
    const name = p.label || p.side;
    for (const [v, tag, color] of [[p.entry, 'entry', COLORS.entry], [p.stop, 'SL', COLORS.stop], [p.target, 'TP', COLORS.target]]) {
      const y = Number(v);
      if (!isFinite(y) || !y) continue;
      lines.push({ x1: 0, x2: xEnd, y, color, dash: false, width: 1.6 });
      label(y, `${name} ${tag} ${px(y)}`, color, 1);
    }
  }
  // The y range has to hold whatever survived the filters above.
  const ys = [lo, hi, ...lines.map((l) => l.y), ...zones.flatMap((z) => [z.y1, z.y2])];
  const pad = (Math.max(...ys) - Math.min(...ys)) * 0.04 || 1;
  const yMin = Math.min(...ys) - pad, yMax = Math.max(...ys) + pad;
  // Drop the labels that would overlap, keeping the most important ones.
  const gap = (yMax - yMin) * 0.028;
  const placed = [];
  for (const l of [...labels].sort((a, b) => a.pri - b.pri)) {
    if (!placed.some((x) => Math.abs(x.y - l.y) < gap)) placed.push(l);
  }
  const candles = shown.map((b, x) => ({ x, o: b.o, h: b.h, l: b.l, c: b.c, color: b.c >= b.o ? COLORS.up : COLORS.down }));
  const bias = st?.bias === 'bull' ? 'Bullish' : st?.bias === 'bear' ? 'Bearish' : 'Undefined';
  const zone = st?.range ? `, ${st.range.zone} ${Math.round(st.range.pos * 100)}%` : '';
  return {
    symbol, tf, candles, zones, lines, marks, labels: placed, yMin, yMax, xMax, xLabel: n + 0.2,
    title: `${symbol} ${tf} — T.A.L.O.N.`, subtitle: `${bias} structure${zone} · last ${px(lastPx)} · ${n} candles`,
    at: now,
  };
}

export {
  TF_MS, closedBars, analyzeStructure, zoneStop, keyLevels, killZone, formatTimeframe, formatMarketRead, chartModel, TRADING_KNOWLEDGE,
};
