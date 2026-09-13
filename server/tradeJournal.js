// T.A.L.O.N.'s trade journal — server-side port of src/services/tradeJournal.js,
// re-implemented against the shared `trades` and `notes` sync tables instead of
// local SQLite (see server/syncStore.js; the same `trades` rows
// server/personaRuntime.js already reads for cross-domain context).
//
// The one-time outcome-repair pass from the client version is skipped here —
// it exists to fix historical rows from an old client-side P/L-mapping bug,
// which either already ran on-device or doesn't apply to rows this cron creates.
const crypto = require('crypto');
const { syncedRows, upsertSyncRow } = require('./syncStore');
const { tlPositions, tlOrdersHistory, tlInstrumentsById } = require('./tradeLocker');

const TRADER_ID = 'talon';
const STRATEGY_TITLE = 'T.A.L.O.N. — Winning Strategy';
const newId = () => crypto.randomBytes(16).toString('hex');

const PL_KEYS = ['positionNetPl', 'positionGrossPl', 'netPl', 'pnl', 'profit', 'realizedPl', 'positionPnl'];
const num = (v) => { const n = Number(v); return isNaN(n) ? null : n; };
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

function inferSetup(rationale = '') {
  if (/scalp/i.test(rationale)) return 'scalp';
  if (/swing/i.test(rationale)) return 'swing';
  return 'other';
}

async function allTrades() {
  return (await syncedRows('trades')).filter((t) => t.persona === TRADER_ID);
}

// --- strategy note ----------------------------------------------------------

async function getStrategy() {
  const notes = await syncedRows('notes').catch(() => []);
  const hit = notes.find((n) => String(n.title || '').trim() === STRATEGY_TITLE);
  return hit ? String(hit.content || '') : '';
}

// --- recording ---------------------------------------------------------------

async function recordTradeOpen({ symbol, side, qty, entry, stopLoss, takeProfit, rationale, orderId, setup, auto }) {
  const now = Date.now();
  const syncId = newId();
  await upsertSyncRow('trades', syncId, {
    persona: TRADER_ID, symbol: String(symbol || '').toUpperCase(), side,
    qty: num(qty), entry_ref: num(entry), stop_loss: num(stopLoss), take_profit: num(takeProfit),
    setup: setup || inferSetup(rationale), rationale: String(rationale || '').slice(0, 400),
    status: 'open', order_id: orderId != null ? String(orderId) : null, opened_at: now,
    auto: auto ? 1 : 0, updated_at: now,
  });
  return syncId;
}

// --- reconciliation ------------------------------------------------------

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
    // 1. bind a freshly-opened trade to its live position
    if (!t.position_id) {
      const cand = positions.find((p) => {
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
        continue;
      }
      const misses = (t.misses || 0) + 1;
      if (misses >= 8 || Date.now() - t.opened_at > 20 * 60e3) {
        await upsertSyncRow('trades', t.sync_id, { ...t, status: 'unknown', outcome: 'unknown', closed_at: now,
          review: t.review || 'never appeared as an open position — order may have been rejected or filled and closed while unwatched', updated_at: now });
      } else {
        await upsertSyncRow('trades', t.sync_id, { ...t, misses, updated_at: now });
      }
      continue;
    }

    // 2. still open — keep unrealized fresh
    const live = posById[String(t.position_id)];
    if (live) {
      await upsertSyncRow('trades', t.sync_id, { ...t, last_unrealized: num(live.unrealizedPl), entry_fill: t.entry_fill ?? num(live.avgPrice), misses: 0, updated_at: now });
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
      const closer = rows.find((r) => r.side && t.side && r.side !== t.side) || rows[rows.length - 1];
      exit = num(closer?.avgPrice) ?? num(closer?.price);
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
      if (histAgrees) { realized = +histPl.toFixed(2); estimated = 0; }
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
    await upsertSyncRow('trades', t.sync_id, {
      ...t, status: 'closed', closed_at: now, exit_price: exit,
      realized_pl: realized, pl_estimated: estimated, outcome, r_multiple, updated_at: now,
    });
    closed++;
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
      L.push(` • ${t.auto ? '[auto] ' : ''}${t.symbol} ${t.side} — ${tag}${pl}${rr}${rev}`);
    }
  }
  return L.join('\n');
}

module.exports = { TRADER_ID, STRATEGY_TITLE, getStrategy, recordTradeOpen, reconcileOpenTrades, tradeRecord, formatTradeRecord };
