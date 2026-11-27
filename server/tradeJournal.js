// T.A.L.O.N.'s trade journal — server-side port of src/services/tradeJournal.js,
// re-implemented against the shared `trades` and `notes` sync tables instead of
// local SQLite (see server/syncStore.js; the same `trades` rows
// server/personaRuntime.js already reads for cross-domain context).
//
// The one-time outcome-repair pass from the client version is skipped here —
// it exists to fix historical rows from an old client-side P/L-mapping bug,
// which either already ran on-device or doesn't apply to rows this cron creates.
const crypto = require('crypto');
const { syncedRows, upsertSyncRow, getSetting, setSetting } = require('./syncStore');
const { tlPositions, tlOrdersHistory, tlInstrumentsById, tlModifyPosition, tlQuote, tlClosePosition, tlActiveEnv } = require('./tradeLocker');
const alerts = require('./talonAlerts');

const TRADER_ID = 'talon';
const STRATEGY_TITLE = 'T.A.L.O.N. — Winning Strategy';
const newId = () => crypto.randomBytes(16).toString('hex');

const PL_KEYS = ['positionNetPl', 'positionGrossPl', 'netPl', 'pnl', 'profit', 'realizedPl', 'positionPnl'];
const num = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

// The order that actually closed the position. A position's history also
// holds its stop-loss and take-profit orders, which get CANCELLED when it's
// closed by hand — taking the first opposite-side row picked up the cancelled
// stop, booked its price as the exit, and an early close read as a full stop-out.
// Only a filled opposite-side order with a real fill price counts.
function pickCloser(rows, side) {
  const filled = rows.filter((r) => r.side && side && r.side !== side
    && !/cancel|reject|expire/i.test(String(r.status || ''))
    && num(r.avgPrice) > 0 && (r.filledQty == null || num(r.filledQty) > 0));
  const at = (r) => Number(r.lastModified) || Date.parse(r.lastModified || '') || Number(r.createdDate) || 0;
  return filled.sort((a, b) => at(b) - at(a))[0] || null;
}

function inferSetup(rationale = '') {
  if (/scalp/i.test(rationale)) return 'scalp';
  if (/swing/i.test(rationale)) return 'swing';
  return 'other';
}

// Open trades left on the other account when he switches, { sync_id: 'live' | 'demo' }.
// Each account's positions aren't visible from the other, so without this a live
// trade would look closed the moment he moved to demo: booked with a made-up
// result and alerted, while really still open.
async function parkedTrades() {
  const raw = await getSetting('talon_parked_trades', '{}').catch(() => '{}');
  try { const m = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw; return m && typeof m === 'object' ? m : {}; } catch { return {}; }
}

// Call before the account changes, with the account being left.
async function parkOpenTrades(fromEnv) {
  const parked = await parkedTrades();
  const next = {};
  for (const t of await syncedRows('trades')) {
    if (t.persona === TRADER_ID && t.status === 'open') next[t.sync_id] = parked[t.sync_id] || fromEnv;
  }
  await setSetting('talon_parked_trades', JSON.stringify(next));
}

// Everything except open trades sitting on the account he isn't on, so the
// journal, add-ons, watch and quick desk only act on what they can actually see.
async function allTrades() {
  const [rows, parked, env] = await Promise.all([syncedRows('trades'), parkedTrades(), tlActiveEnv().catch(() => null)]);
  return rows.filter((t) => t.persona === TRADER_ID && !(t.status === 'open' && env && parked[t.sync_id] && parked[t.sync_id] !== env));
}

// --- strategy note ----------------------------------------------------------

async function getStrategy() {
  const notes = await syncedRows('notes').catch(() => []);
  const hit = notes.find((n) => String(n.title || '').trim() === STRATEGY_TITLE);
  return hit ? String(hit.content || '') : '';
}

// --- recording ---------------------------------------------------------------

// `pairId` links a scalp + swing opened on the same setup; `setupId` links
// every position of one setup (all its copies and its add-ons, `addLevel` = which
// step toward the target an add went in at); `alert: false` when the caller
// sends one alert for the pair itself.
// Dollars per 1.0 price move per 1.0 lot, for the P/L when the broker's own figure is
// missing: gold 100 oz, Bitcoin / Nasdaq from the instrument, forex 100,000 units
// (USD/JPY's yen turned into dollars at the exit price). null when it isn't known.
function dollarsPerPoint(symbol, price) {
  try {
    const tl = require('./tradeLocker');
    const c = tl.contractKnown(symbol);
    if (!(c > 0)) return null;
    return tl.isFx(symbol) && /^USD/i.test(String(symbol)) && Number(price) > 0 ? c / Number(price) : c;
  } catch { return null; }
}

async function recordTradeOpen({ symbol, side, qty, entry, stopLoss, takeProfit, rationale, orderId, setup, auto, pairId, setupId, addLevel, trend, alert = true }) {
  const now = Date.now();
  const syncId = newId();
  await upsertSyncRow('trades', syncId, {
    persona: TRADER_ID, symbol: String(symbol || '').toUpperCase(), side,
    qty: num(qty), entry_ref: num(entry), stop_loss: num(stopLoss), take_profit: num(takeProfit),
    setup: setup || inferSetup(rationale), rationale: String(rationale || '').slice(0, 400),
    status: 'open', order_id: orderId != null ? String(orderId) : null, opened_at: now,
    auto: auto ? 1 : 0, pair_id: pairId || null, setup_id: setupId || null, add_level: addLevel || null, updated_at: now,
    // The 1D / 4H trend when it went in ({ d1, h4 }), so [TRADE_STATS] can split with vs against.
    trend_at_entry: trend && (trend.d1 || trend.h4) ? { d1: trend.d1 || null, h4: trend.h4 || null } : null,
  });
  if (alert) alerts.tradeOpened({ symbol: String(symbol || '').toUpperCase(), side, qty, entry, stopLoss, takeProfit, rationale, setup });
  return syncId;
}

// --- reconciliation ------------------------------------------------------

// A position of his that's open on the broker with no stop attached (the stop
// leg got dropped, or a modify cleared it) gets its journal stop put back.
// If price is already through that stop, the stop would have taken it out —
// so it's closed instead. Retried every 5-min tick until it sticks; A.R.A.
// hears once per position when it's fixed and once if it keeps failing.
const hasStop = (p) => p.stopLossId != null && p.stopLossId !== '' && String(p.stopLossId) !== '0';
const stopFixTries = new Map(); // position id -> attempts
async function ensureStop(t, p) {
  if (hasStop(p)) { stopFixTries.delete(String(p.id)); return; }
  const stop = num(t.stop_loss);
  if (stop == null) return;
  const id = String(p.id), tries = (stopFixTries.get(id) || 0) + 1;
  stopFixTries.set(id, tries);
  const side = String(t.side).toUpperCase();
  try {
    const q = await tlQuote(t.symbol);
    const price = num(t.side === 'buy' ? (q.bid ?? q.mid) : (q.ask ?? q.mid));
    if (price != null && (t.side === 'buy' ? price <= stop : price >= stop)) {
      await tlClosePosition(p.id);
      alerts.araNote(`🚨 **T.A.L.O.N. → A.R.A.: my ${side} ${t.symbol} (#${p.id}) was open with NO stop**, and price (${price}) is already past where it should have been (${stop}). I closed it — that's what the stop would have done.`);
    } else {
      await tlModifyPosition(p.id, { stopLoss: stop, symbol: t.symbol });
      alerts.araNote(`🛡️ **T.A.L.O.N. → A.R.A.: my ${side} ${t.symbol} (#${p.id}) was open with NO stop.** I put it back at ${stop}.`);
    }
    stopFixTries.delete(id);
  } catch (e) {
    console.error(`trade-journal: stop fix #${p.id} failed —`, e.message);
    if (tries === 2) alerts.araNote(`🚨 **T.A.L.O.N. → A.R.A.: my ${side} ${t.symbol} (#${p.id}) has NO stop and I can't attach one** (${String(e.message).slice(0, 160)}). Put a stop at ${stop} in TradeLocker, or close it. I'll keep trying every 5 minutes.`);
  }
}

async function reconcileOpenTrades() {
  const trades = await allTrades();
  const open = trades.filter((t) => t.status === 'open');
  if (!open.length) return { checked: 0, closed: 0 };

  let positions = [], idToSym = {};
  try { positions = await tlPositions(); } catch { return { checked: open.length, closed: 0, error: 'positions' }; }
  try { idToSym = await tlInstrumentsById(); } catch {}

  const posById = {};
  for (const p of positions) posById[String(p.id)] = p;
  const boundIds = new Set(open.map((t) => t.position_id).filter(Boolean));

  let history = null;
  const loadHistory = async () => {
    if (history !== null) return history;
    try { history = await tlOrdersHistory(); } catch { history = []; }
    return history;
  };

  let closed = 0;
  for (const t of open) {
    const now = Date.now();
    // 1. bind a freshly-opened trade to its live position — by its own order
    // first (a scalp + swing pair are otherwise identical positions), then by
    // symbol/side/size/time.
    if (!t.position_id) {
      const own = t.order_id ? (await loadHistory()).find((r) => String(r.id) === String(t.order_id)) : null;
      const ownPid = own && String(own.position ?? own.positionId ?? '');
      const cand = (ownPid && posById[ownPid] && !boundIds.has(ownPid)) ? posById[ownPid] : positions.find((p) => {
        if (boundIds.has(String(p.id))) return false;
        const sym = String(idToSym[String(p.tradableInstrumentId)] || '').toUpperCase();
        if (sym && t.symbol && sym !== t.symbol) return false;
        if (p.side && t.side && p.side !== t.side) return false;
        if (t.qty != null && !near(num(p.qty), t.qty, Math.max(t.qty * 0.5, 0.001))) return false;
        const opened = Number(p.openDate) || Date.parse(p.openDate || p.openTime || '') || 0;
        if (opened && Math.abs(opened - t.opened_at) > 15 * 60e3) return false;
        return true;
      });
      if (cand) {
        boundIds.add(String(cand.id));
        await upsertSyncRow('trades', t.sync_id, { ...t, position_id: String(cand.id), entry_fill: num(cand.avgPrice), last_unrealized: num(cand.unrealizedPl), misses: 0, updated_at: now });
        await ensureStop(t, cand);
        continue;
      }
      const misses = (t.misses || 0) + 1;
      if (misses >= 8 || Date.now() - t.opened_at > 20 * 60e3) {
        await upsertSyncRow('trades', t.sync_id, { ...t, status: 'unknown', outcome: 'unknown', closed_at: now,
          review: t.review || 'never appeared as an open position — order may have been rejected or filled and closed while unwatched', updated_at: now });
        alerts.tradeLost(t, 'the order may have been rejected, or it filled and closed between checks.');
      } else {
        await upsertSyncRow('trades', t.sync_id, { ...t, misses, updated_at: now });
      }
      continue;
    }

    // 2. still open — keep unrealized fresh
    const live = posById[String(t.position_id)];
    if (live) {
      await upsertSyncRow('trades', t.sync_id, { ...t, last_unrealized: num(live.unrealizedPl), entry_fill: t.entry_fill ?? num(live.avgPrice), misses: 0, updated_at: now });
      await ensureStop(t, live);
      continue;
    }

    // 3. position gone -> the trade closed. Score it from the price move
    // (exit vs. entry, side-adjusted) — the broker's own P/L column varies by
    // broker and is only used for the dollar figure when its sign agrees.
    const rows = (await loadHistory()).filter((r) => {
      const pid = String(r.position ?? r.positionId ?? r.positionID ?? '');
      return pid && pid === String(t.position_id);
    });
    let exit = null, histPl = null;
    if (rows.length) {
      const closer = pickCloser(rows, t.side);
      exit = closer ? num(closer.avgPrice) : null;
      for (const k of PL_KEYS) {
        const v = num(closer?.[k]);
        if (v != null && isFinite(v) && Math.abs(v) < 1e7) { histPl = v; break; }
      }
    }

    const entry = num(t.entry_fill) ?? num(t.entry_ref);
    const move = (exit != null && entry != null) ? ((t.side === 'buy' ? 1 : -1) * (exit - entry)) : null;
    const beTol = Math.abs(entry || 1) * 2e-4;
    const lastU = num(t.last_unrealized);

    let outcome, realized, estimated;
    if (move != null) {
      outcome = move > beTol ? 'win' : (move < -beTol ? 'loss' : 'breakeven');
      const dir = outcome === 'win' ? 1 : outcome === 'loss' ? -1 : 0;
      const histAgrees = histPl != null && (outcome === 'breakeven' || Math.sign(histPl) === dir);
      const lastAgrees = lastU != null && Math.abs(lastU) > 0.01 && (outcome === 'breakeven' || Math.sign(lastU) === dir);
      // Worked out from the exit price before the last 5-min reading (2026-11-27: two gold
      // trades filled at a bad 7188 were booked at -$0.64 each instead of about -$3,620).
      const perLot = dollarsPerPoint(t.symbol, exit);
      if (histAgrees) { realized = +histPl.toFixed(2); estimated = 0; }
      else if (perLot) { realized = +(move * (num(t.qty) || 0.01) * perLot).toFixed(2); estimated = 1; }
      else if (lastAgrees) { realized = +lastU.toFixed(2); estimated = 1; }
      else { realized = +(move * (num(t.qty) || 0.01) * 100).toFixed(2); estimated = 1; }
    } else if (histPl != null) {
      realized = +histPl.toFixed(2); estimated = 0;
      outcome = realized > 0.01 ? 'win' : (realized < -0.01 ? 'loss' : 'breakeven');
    } else if (lastU != null && Math.abs(lastU) > 0.01) {
      outcome = lastU > 0 ? 'win' : 'loss';
      realized = +lastU.toFixed(2); estimated = 1;
    } else {
      realized = 0; estimated = 1; outcome = 'breakeven';
    }

    let r_multiple = null;
    if (exit != null && entry != null && t.stop_loss != null) {
      const risk = t.side === 'buy' ? entry - t.stop_loss : t.stop_loss - entry;
      const reward = t.side === 'buy' ? exit - entry : entry - exit;
      if (risk > 0) r_multiple = +(reward / risk).toFixed(2);
    }
    // An exit more than 10% from the entry isn't a market price for these markets in a
    // day: the broker filled it at a bad tick. Flagged so the alert says so.
    const badFill = exit != null && entry ? Math.abs(exit / entry - 1) > 0.1 : false;
    const done = {
      ...t, status: 'closed', closed_at: now, exit_price: exit,
      realized_pl: realized, pl_estimated: estimated, outcome, r_multiple, updated_at: now,
      ...(badFill ? { bad_fill: true } : {}),
    };
    await upsertSyncRow('trades', t.sync_id, done);
    alerts.tradeClosed(done);
    closed++;

    // Scalp of a pair hit its target: the swing's stop goes to break-even, so
    // the rest of the trade can no longer lose.
    if (done.setup === 'scalp' && done.pair_id && outcome === 'win') {
      const swing = open.find((o) => o.pair_id === done.pair_id && o.sync_id !== t.sync_id);
      const be = swing && num(swing.entry_fill) != null ? num(swing.entry_fill) : entry;
      if (swing && swing.position_id && posById[String(swing.position_id)] && be != null) {
        try {
          await tlModifyPosition(swing.position_id, { stopLoss: be, symbol: swing.symbol });
          alerts.araNote(`🔒 Scalp paid — T.A.L.O.N.'s swing ${String(swing.side).toUpperCase()} on ${swing.symbol} now has its stop at break-even (${be}). It can't lose from here; it's riding to ${swing.take_profit}.`);
        } catch (e) { console.error(`trade-journal: swing break-even #${swing.position_id} failed —`, e.message); }
      }
    }
  }
  return { checked: open.length, closed };
}

// --- the record T.A.L.O.N. reads --------------------------------------------

async function tradeRecord({ limit = 40 } = {}) {
  const trades = await allTrades();
  const closed = trades.filter((t) => t.status === 'closed' || t.status === 'unknown')
    .sort((a, b) => (b.closed_at || 0) - (a.closed_at || 0)).slice(0, limit);
  const openCount = trades.filter((t) => t.status === 'open').length;
  const scored = closed.filter((t) => t.status === 'closed' && t.outcome && t.outcome !== 'unknown');
  const wins = scored.filter((t) => t.outcome === 'win').length;
  const losses = scored.filter((t) => t.outcome === 'loss').length;
  const be = scored.filter((t) => t.outcome === 'breakeven').length;
  const net = +scored.reduce((a, t) => a + (Number(t.realized_pl) || 0), 0).toFixed(2);
  const rs = scored.map((t) => Number(t.r_multiple)).filter((v) => !isNaN(v) && v !== null);
  const avgR = rs.length ? +(rs.reduce((a, v) => a + v, 0) / rs.length).toFixed(2) : null;
  const winRate = (wins + losses) ? Math.round((wins / (wins + losses)) * 100) : null;

  let streak = 0, streakType = null;
  for (const t of scored) {
    if (t.outcome === 'breakeven') continue;
    if (streakType == null) { streakType = t.outcome; streak = 1; }
    else if (t.outcome === streakType) streak++;
    else break;
  }

  const bySetup = {};
  for (const t of scored) {
    const k = t.setup || 'other';
    (bySetup[k] || (bySetup[k] = { n: 0, wins: 0, net: 0 }));
    bySetup[k].n++;
    if (t.outcome === 'win') bySetup[k].wins++;
    bySetup[k].net += Number(t.realized_pl) || 0;
  }
  return { count: scored.length, wins, losses, be, net, avgR, winRate, streak, streakType, openCount, bySetup, recent: closed.slice(0, 8) };
}

async function formatTradeRecord() {
  const r = await tradeRecord({});
  if (!r.count && !r.openCount) return '(no trades recorded yet — this is where your history will build)';
  const L = [];
  if (r.count) {
    L.push(`Closed: ${r.count} | ${r.wins}W-${r.losses}L-${r.be}BE${r.winRate != null ? ` (${r.winRate}% win — break-even is neither)` : ''} | Net P/L: ${r.net >= 0 ? '+' : ''}${r.net}${r.avgR != null ? ` | Avg R: ${r.avgR >= 0 ? '+' : ''}${r.avgR}` : ''}`);
    if (r.streak >= 2) L.push(`Current streak: ${r.streak}${r.streakType === 'win' ? 'W' : 'L'}`);
    const setups = Object.entries(r.bySetup).map(([k, v]) => `${k} ${v.n} (${v.wins}W, ${v.net >= 0 ? '+' : ''}${v.net.toFixed(2)})`);
    if (setups.length) L.push(`By setup: ${setups.join(' · ')}`);
  }
  if (r.openCount) L.push(`Open right now: ${r.openCount}`);
  if (r.recent.length) {
    L.push('Recent:');
    for (const t of r.recent) {
      const tag = t.status === 'unknown' ? 'UNKNOWN' : (t.outcome || '?').toUpperCase();
      const pl = t.realized_pl != null ? ` ${t.realized_pl >= 0 ? '+' : ''}${t.realized_pl}${t.pl_estimated ? '~' : ''}` : '';
      const rr = t.r_multiple != null ? ` (${t.r_multiple >= 0 ? '+' : ''}${t.r_multiple}R)` : '';
      const rev = t.review ? ` · "${t.review}"` : '';
      L.push(` • ${t.auto ? '[auto] ' : ''}${t.symbol} ${t.side}${t.setup && t.setup !== 'other' ? ` ${t.setup}` : ''} — ${tag}${pl}${rr}${rev}`);
    }
  }
  return L.join('\n');
}

// --- where the money goes: [TRADE_STATS] -----------------------------------------
//
// His closed trades on one market (or all), cut every way that could hide the
// leak: by kind of trade, side, session (ET), with/against the 1D at entry, how it
// exited, and by setup (a scalp + swing pair, its copies and add-ons together).
// Plain arithmetic on the journal, no AI. `days` = how far back (default 30).
function etHour(ts) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(new Date(ts)), 10) % 24;
}
function sessionOf(ts) {
  if (!ts) return 'unknown';
  const h = etHour(ts);
  if (h >= 3 && h < 8) return 'London (3-8 AM ET)';
  if (h >= 8 && h < 12) return 'New York AM (8-12 ET)';
  if (h >= 12 && h < 17) return 'New York PM (12-5 PM ET)';
  return 'Asia / overnight (6 PM-3 AM ET)';
}
function kindOf(t) {
  if (String(t.setup_id || '').endsWith(':re')) return `re-entry ${t.setup === 'swing' ? 'swing' : 'scalp'}`;
  if (t.setup === 'scalp') return t.pair_id ? 'paired scalp' : 'lone scalp (no swing)';
  if (['swing', 'quick', 'add', 'news', 'manual'].includes(t.setup)) return t.setup === 'add' ? 'add-on' : t.setup === 'quick' ? 'quick scalp (5m)' : t.setup;
  return t.setup || 'other';
}
function exitOf(t) {
  const x = num(t.exit_price), e = num(t.entry_ref), sl = num(t.stop_loss), tp = num(t.take_profit);
  if (t.closed_by === 'owner') return 'closed on his order';
  if (x == null) return 'exit unknown';
  const risk = e != null && sl != null ? Math.abs(e - sl) : null;
  const tol = risk ? Math.max(risk * 0.08, 0.01) : 0.5;
  if (tp != null && near(x, tp, tol)) return 'target';
  if (e != null && near(x, e, tol)) return 'break-even';
  if (sl != null && near(x, sl, tol)) return 'stop';
  if (sl != null && e != null && (t.side === 'buy' ? x < sl : x > sl)) return 'stop (slipped past it)';
  return 'other (moved stop / closed between)';
}
function dailyOf(t) {
  const d1 = t.trend_at_entry && t.trend_at_entry.d1;
  if (!d1 || d1 === 'flat' || d1 === 'range') return d1 ? 'daily flat' : 'not recorded (older trades)';
  const withIt = (t.side === 'buy' && d1 === 'up') || (t.side === 'sell' && d1 === 'down');
  return withIt ? 'with the 1D' : 'against the 1D';
}
function bucket(rows) {
  const n = rows.length;
  const wins = rows.filter((t) => t.outcome === 'win'), losses = rows.filter((t) => t.outcome === 'loss');
  const pl = (t) => Number(t.realized_pl) || 0;
  const net = rows.reduce((a, t) => a + pl(t), 0);
  const rs = rows.map((t) => num(t.r_multiple)).filter((v) => v != null);
  const stops = rows.map((t) => (num(t.entry_ref) != null && num(t.stop_loss) != null ? Math.abs(t.entry_ref - t.stop_loss) : null)).filter((v) => v != null);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return {
    n, w: wins.length, l: losses.length, be: n - wins.length - losses.length,
    winRate: wins.length + losses.length ? Math.round((wins.length / (wins.length + losses.length)) * 100) : null,
    net: +net.toFixed(2), avgR: avg(rs), avgWin: avg(wins.map(pl)), avgLoss: avg(losses.map(pl)), avgStop: avg(stops),
  };
}
const money = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`);
function line(label, b) {
  return `  ${label}: ${b.n} trades, ${b.w}W-${b.l}L-${b.be}BE${b.winRate != null ? ` (${b.winRate}%)` : ''}, net ${money(b.net)}`
    + `${b.avgR != null ? `, avg ${b.avgR >= 0 ? '+' : ''}${b.avgR.toFixed(2)}R` : ''}`
    + `${b.avgWin != null ? `, avg win ${money(b.avgWin)}` : ''}${b.avgLoss != null ? `, avg loss ${money(b.avgLoss)}` : ''}`
    + `${b.avgStop != null ? `, avg stop ${b.avgStop.toFixed(2)}` : ''}`;
}
function cut(rows, keyFn) {
  const groups = {};
  for (const t of rows) (groups[keyFn(t)] || (groups[keyFn(t)] = [])).push(t);
  return Object.entries(groups).map(([k, g]) => [k, bucket(g)]).sort((a, b) => a[1].net - b[1].net); // worst first
}

async function tradeStats({ symbol = 'XAUUSD', days = 30 } = {}) {
  const sym = String(symbol || '').toUpperCase();
  const since = Date.now() - days * 86400000;
  const rows = (await allTrades()).filter((t) => t.status === 'closed' && t.outcome && t.outcome !== 'unknown'
    && (!sym || sym === 'ALL' || t.symbol === sym) && (t.closed_at || 0) >= since);
  const label = !sym || sym === 'ALL' ? 'all markets' : sym;
  if (!rows.length) return `${label}, last ${days} days: no closed trades in the journal.`;
  const all = bucket(rows);
  const L = [`${label}, last ${days} days. P/L is the broker's, per position (0.02 lot, or 0.01 on a gold stop over $20). Worst first in every cut.`, line('ALL', all)];
  const section = (title, keyFn) => { L.push(`${title}:`); for (const [k, b] of cut(rows, keyFn)) L.push(line(k, b)); };
  section('BY KIND OF TRADE', kindOf);
  section('BY SIDE', (t) => String(t.side || '?').toUpperCase());
  section('BY SESSION (when it opened)', (t) => sessionOf(t.opened_at));
  section('BY THE DAILY TREND AT ENTRY', dailyOf);
  section('BY HOW IT EXITED', exitOf);
  // Setups: every position that went in on one decision (scalp + swing pair,
  // copies, its add-ons) as one result: the real cost of one idea being wrong.
  const bySetup = {};
  for (const t of rows) {
    const k = t.setup_id || t.pair_id || t.sync_id;
    (bySetup[k] || (bySetup[k] = [])).push(t);
  }
  const setups = Object.values(bySetup).map((g) => g.reduce((a, t) => a + (Number(t.realized_pl) || 0), 0));
  const lost = setups.filter((v) => v < -0.01), won = setups.filter((v) => v > 0.01);
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  L.push(`BY SETUP (all positions from one decision together): ${setups.length} setups, ${won.length} made money (avg ${money(avg(won))}), ${lost.length} lost (avg ${money(avg(lost))})${lost.length ? `, worst ${money(Math.min(...lost))}` : ''}.`);
  const worst = [...rows].sort((a, b) => (Number(a.realized_pl) || 0) - (Number(b.realized_pl) || 0)).slice(0, 5);
  L.push('WORST 5 TRADES:');
  for (const t of worst) {
    L.push(`  ${new Date(t.opened_at || t.closed_at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET ${t.symbol} ${String(t.side).toUpperCase()} ${kindOf(t)} @ ${t.entry_ref} SL ${t.stop_loss} TP ${t.take_profit} → ${t.exit_price ?? '?'} (${exitOf(t)}) ${money(Number(t.realized_pl) || 0)}${t.r_multiple != null ? ` ${t.r_multiple}R` : ''}${t.rationale ? ` · "${String(t.rationale).slice(0, 90)}"` : ''}`);
  }
  return L.join('\n');
}

// One target per area: a new take profit within SHARE_TP of a target his open
// trades (or a resting quick limit) on the same market and side already use is
// set to that same price, so the positions bank together instead of a few
// dollars apart. The window is gold $3 / Bitcoin 0.3% (TALON_SHARE_TP_GOLD /
// TALON_SHARE_TP_BTC), never more than a quarter of the way from entry to the
// target, and the shared price has to stay on the profit side. Owner's call, 2026-11-19.
const SHARE_TP = {
  XAUUSD: () => Number(process.env.TALON_SHARE_TP_GOLD ?? 3),
  BTCUSD: (px) => px * Number(process.env.TALON_SHARE_TP_BTC ?? 0.003),
  // Forex: 5 pips (2026-11-27).
  EURUSD: (px) => px * 0.0005, GBPUSD: (px) => px * 0.0005, USDJPY: (px) => px * 0.0005,
};
function snapTarget({ symbol, side, entry, takeProfit, targets }) {
  const sym = String(symbol).toUpperCase(), px = Number(entry), tp = Number(takeProfit);
  const win = SHARE_TP[sym];
  if (!win || !isFinite(px) || !isFinite(tp)) return takeProfit;
  const dir = side === 'buy' ? 1 : -1;
  const reach = (tp - px) * dir;
  if (!(reach > 0)) return takeProfit;
  const tol = Math.min(win(px), reach / 4);
  let best = null;
  for (const t of targets || []) {
    const v = Number(t);
    if (!isFinite(v) || (v - px) * dir <= 0) continue;
    const gap = Math.abs(v - tp);
    if (gap <= tol + 1e-9 && (best == null || gap < Math.abs(best - tp))) best = v;
  }
  return best == null ? takeProfit : best;
}
// The targets already set on a market and side: open journal trades + resting quick limits.
async function openTargets(symbol, side) {
  const sym = String(symbol).toUpperCase();
  const out = (await allTrades()).filter((t) => t.status === 'open' && String(t.symbol).toUpperCase() === sym && t.side === side)
    .map((t) => num(t.take_profit)).filter((v) => v != null);
  try {
    const raw = await getSetting('talon_quick_pending', '[]');
    const l = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    for (const p of Array.isArray(l) ? l : []) if (p.sym === sym && p.side === side && num(p.takeProfit) != null) out.push(num(p.takeProfit));
  } catch {}
  return out;
}
async function sharedTarget({ symbol, side, entry, takeProfit }) {
  if (takeProfit == null) return takeProfit;
  const targets = await openTargets(symbol, side).catch(() => []);
  const v = snapTarget({ symbol, side, entry, takeProfit, targets });
  if (v !== takeProfit) console.log(`talon: ${symbol} ${side} target ${takeProfit} → ${v}, the target already set in that area`);
  return v;
}
// Scalp + swing together: the swing has to stay past the scalp after sharing.
async function sharedTargets({ symbol, side, entry, takeProfit, swingTakeProfit }) {
  const tp = await sharedTarget({ symbol, side, entry, takeProfit });
  let sw = swingTakeProfit;
  if (sw != null) {
    const s2 = await sharedTarget({ symbol, side, entry, takeProfit: sw });
    const dir = side === 'buy' ? 1 : -1;
    sw = (Number(s2) - Number(tp)) * dir > 0 ? s2 : sw;
  }
  return { takeProfit: tp, swingTakeProfit: sw };
}

// Once, at boot: closed trades already booked off a bad fill (exit 10%+ from entry,
// P/L estimated from an old reading) get their real P/L and the bad_fill flag, so the
// stats and recaps show what the account actually lost (2026-11-26's two gold sells:
// -$0.64 each on the books, about -$3,620 each on the account).
async function fixBadFills() {
  const done = await require('./syncStore').getSetting('trades_bad_fill_fixed', '').catch(() => 'x');
  if (done) return { skipped: true };
  let fixed = 0;
  for (const t of await allTrades()) {
    const entry = num(t.entry_fill) ?? num(t.entry_ref), exit = num(t.exit_price);
    if (t.status !== 'closed' || t.bad_fill || !entry || exit == null || Math.abs(exit / entry - 1) <= 0.1) continue;
    const perLot = dollarsPerPoint(t.symbol, exit);
    const move = (t.side === 'buy' ? 1 : -1) * (exit - entry);
    const realized = t.pl_estimated && perLot ? +(move * (num(t.qty) || 0.01) * perLot).toFixed(2) : t.realized_pl;
    await upsertSyncRow('trades', t.sync_id, { ...t, realized_pl: realized, bad_fill: true, updated_at: Date.now() });
    console.log(`trade journal: ${t.symbol} ${t.side} #${t.position_id} re-booked off a bad fill at ${exit}: ${t.realized_pl} -> ${realized}`);
    fixed++;
  }
  await require('./syncStore').setSetting('trades_bad_fill_fixed', String(Date.now())).catch(() => {});
  return { fixed };
}

module.exports = { fixBadFills, dollarsPerPoint, snapTarget, sharedTarget, sharedTargets, TRADER_ID, STRATEGY_TITLE, allTrades, parkOpenTrades, getStrategy, recordTradeOpen, reconcileOpenTrades, tradeRecord, formatTradeRecord, tradeStats, statsParts: { kindOf, exitOf, sessionOf, dailyOf, bucket } };
