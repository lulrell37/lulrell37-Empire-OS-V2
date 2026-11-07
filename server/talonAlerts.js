// T.A.L.O.N. -> A.R.A. -> Mr. Burrus. Every trade T.A.L.O.N. opens, closes or
// loses (rejected / never filled) is sent to the owner on A.R.A.'s Telegram bot,
// and goes into A.R.A.'s Telegram history so she can talk about it when he
// replies ("why'd he take that gold short?"). Plus a nightly recap (9 PM ET,
// TRADE_RECAP=off to stop) of the day's trades and what's still open.
//
// Fire-and-forget: an alert failing never holds up or breaks a trade. Each
// one goes out as a voice note from A.R.A. and then the text.
// araNote() is the same delivery for anything else headed to him through
// A.R.A. (W.I.R.E.'s news briefs and 8:30 data reads).
const { query } = require('./db');
const { syncedRows, todayET } = require('./syncStore');

const NAMES = { XAUUSD: 'Gold', BTCUSD: 'Bitcoin' };
const nameOf = (sym) => NAMES[sym] ? `${NAMES[sym]} (${sym})` : sym;
const money = (n) => (n == null ? '—' : `${n < 0 ? '-' : '+'}$${Math.abs(Number(n)).toFixed(2)}`);
const px = (n) => (n == null || n === '' ? '—' : String(n));

async function sendFromAra(text, spoken = text) {
  const telegram = require('./telegram');
  const ara = telegram.botFor('ara');
  if (!ara || !ara.isConfigured()) return false;
  // Same as a reply to him: she says it, then the text (with the exact numbers).
  const { ogg } = await require('./personaVoice').voiceNote('ara', String(spoken).replace(/\*\*/g, ''), { relay: true })
    .catch((e) => { console.error('trade alert voice failed:', e.message); return { ogg: null }; });
  if (ogg) await ara.sendVoice(telegram.OWNER_ID, ogg).catch((e) => console.error('trade alert sendVoice failed:', e.message));
  await ara.sendMessage(telegram.OWNER_ID, text);
  await query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', ['ara', 'assistant', text, Date.now()])
    .catch((e) => console.error('trade alert history save failed:', e.message));
  return true;
}

// Flags every alert on a live account, so a real-money trade never reads like a demo one.
const acct = () => (require('./tradeLocker').tlStatus().env === 'live' ? ' · 🔴 LIVE' : '');

function notify(text, spoken) {
  sendFromAra(text, spoken || text).catch((e) => console.error('trade alert failed:', e.message));
}

function tradeOpened({ symbol, side, qty, entry, stopLoss, takeProfit, rationale, setup, swingTarget, copies = 1, limitFilled = false }) {
  const news = setup === 'news', quick = setup === 'quick';
  const pair = swingTarget != null;
  const n = (pair ? 2 : 1) * copies;
  notify(`📈 **T.A.L.O.N. ${limitFilled ? 'got filled on his limit — ' : 'just opened '}${pair ? 'a scalp + swing' : quick ? 'a quick 5m scalp' : 'a trade'}**${news ? ' (news-driven)' : ''}${acct()}, Mr. Burrus.\n`
    + `**${String(side).toUpperCase()} ${nameOf(symbol)}** · ${n > 1 ? `${n} × ${qty}` : qty} lot @ ${limitFilled ? '' : '~'}${px(entry)}\n`
    + (pair ? `Stop ${px(stopLoss)} · Scalp target ${px(takeProfit)} · Swing target ${px(swingTarget)} (stop to break-even when the scalp pays)`
      : `Stop ${px(stopLoss)} · Target ${px(takeProfit)}`)
    + `${quick ? ' (stop to break-even at +1R)' : ''}`
    + `${rationale ? `\nWhy: ${String(rationale).replace(/^(news|quick 5m) — /, '')}` : ''}`);
}

// A pending (limit) order he's put in — not a position yet. It's journaled and
// alerted again (tradeOpened, limitFilled) only if it fills.
function limitPlaced({ symbol, side, qty, limit, marketPrice, stopLoss, takeProfit, rationale, minutes }) {
  notify(`⏳ **T.A.L.O.N. put in a pending order — a quick 5m scalp**${acct()}, Mr. Burrus.\n`
    + `**${String(side).toUpperCase()} LIMIT ${nameOf(symbol)}** · ${qty} lot @ ${px(limit)} (price is ${px(marketPrice)} now)\n`
    + `Stop ${px(stopLoss)} · Target ${px(takeProfit)} · cancelled if it isn't filled in ${minutes} minutes, or if price hits the target or stop first`
    + `${rationale ? `\nWhy: ${String(rationale).replace(/^quick 5m — /, '')}` : ''}`);
}

// A pending order that ended without filling: cancelled by him, or by the broker.
function limitEnded({ symbol, side, limit, why }) {
  notify(`✖️ **T.A.L.O.N.'s pending ${String(side).toUpperCase()} LIMIT ${nameOf(symbol)} @ ${px(limit)} is off** — ${why}. No position was opened.`);
}

function addedOn({ symbol, side, qty, copies, step, entry, stopLoss, earlyTarget, takeProfit }) {
  notify(`➕ **T.A.L.O.N. added to his ${String(side).toUpperCase()} ${nameOf(symbol)}**${acct()} — add-on ${step}, ${copies > 1 ? `${copies} × ${qty}` : qty} lot @ ~${px(entry)}.\n`
    + `Stop ${px(stopLoss)} · ${copies > 1 ? `Early target ${px(earlyTarget)} (one) · Target ${px(takeProfit)} (the other)` : `Target ${px(earlyTarget)}`}`);
}

function tradeClosed(t) {
  const icon = t.outcome === 'win' ? '✅' : t.outcome === 'loss' ? '🔻' : '➖';
  const word = t.outcome === 'win' ? 'a win' : t.outcome === 'loss' ? 'a loss' : 'break-even';
  const hit = t.exit_price != null && t.take_profit != null && Math.abs(t.exit_price - t.take_profit) <= Math.abs(t.take_profit) * 3e-4 ? ' — target hit'
    : t.exit_price != null && t.stop_loss != null && Math.abs(t.exit_price - t.stop_loss) <= Math.abs(t.stop_loss) * 3e-4 ? ' — stopped out' : '';
  const kind = t.setup === 'quick' ? ' (quick scalp)' : t.pair_id && (t.setup === 'scalp' || t.setup === 'swing') ? ` (${t.setup})` : '';
  // He never closes early, so an exit nowhere near the stop, the target or
  // break-even means something else closed it.
  const entry = Number(t.entry_fill ?? t.entry_ref), exit = Number(t.exit_price), sl = Number(t.stop_loss), tp = Number(t.take_profit);
  const tol = Math.max(Math.abs(entry) * 3e-4, Math.abs(entry - sl) * 0.15 || 0);
  const nearAny = [sl, tp, entry].some((x) => isFinite(x) && Math.abs(exit - x) <= tol);
  const odd = t.closed_by !== 'owner' && t.exit_price != null && isFinite(exit) && isFinite(entry) && !nearAny
    ? `\n🚨 **T.A.L.O.N. → A.R.A.: I didn't close this one.** It closed at ${px(t.exit_price)}, nowhere near its stop (${px(t.stop_loss)}) or target (${px(t.take_profit)}) — a manual close, a margin stop-out or the broker. Worth a look in TradeLocker.` : '';
  notify(`${icon} **T.A.L.O.N. closed ${String(t.side).toUpperCase()} ${nameOf(t.symbol)}${kind}**${t.closed_by === 'owner' ? ' on your order' : ''} — ${word}${hit}.\n`
    + `Entry ${px(t.entry_fill ?? t.entry_ref)} → Exit ${px(t.exit_price)} · P/L ${money(t.realized_pl)}${t.pl_estimated ? ' (est.)' : ''}`
    + `${t.r_multiple != null ? ` · ${t.r_multiple}R` : ''}${odd}`);
}

function tradeLost(t, why) {
  notify(`⚠️ T.A.L.O.N.'s ${String(t.side).toUpperCase()} ${nameOf(t.symbol)} never showed up as an open position — ${why}`);
}

function orderRejected({ symbol, side, error }) {
  notify(`⚠️ T.A.L.O.N. tried to ${side} ${nameOf(symbol)} but the order was rejected: ${String(error).slice(0, 200)}`);
}

// Nightly recap. Skipped when there was nothing today and nothing is open.
async function runDailyRecap() {
  const today = todayET();
  const dayOf = (ms) => (ms ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms)) : '');
  const trades = (await syncedRows('trades')).filter((t) => t.persona === 'talon');
  const opened = trades.filter((t) => dayOf(t.opened_at) === today);
  const closed = trades.filter((t) => t.status === 'closed' && dayOf(t.closed_at) === today);
  const open = trades.filter((t) => t.status === 'open');
  if (!opened.length && !closed.length && !open.length) return { skipped: 'no trades today' };

  const pl = closed.reduce((s, t) => s + (Number(t.realized_pl) || 0), 0);
  const wins = closed.filter((t) => t.outcome === 'win').length;
  const losses = closed.filter((t) => t.outcome === 'loss').length;
  const lines = [`📊 **T.A.L.O.N. — today's trading recap**, Mr. Burrus.`,
    `Opened ${opened.length} · Closed ${closed.length} (${wins}W / ${losses}L) · Realized ${money(pl)}`];
  if (closed.length) {
    lines.push('', '**Closed today**');
    for (const t of closed) lines.push(`• ${String(t.side).toUpperCase()} ${nameOf(t.symbol)} — ${t.outcome} ${money(t.realized_pl)}${t.r_multiple != null ? ` (${t.r_multiple}R)` : ''}`);
  }
  if (open.length) {
    lines.push('', '**Still open**');
    for (const t of open) lines.push(`• ${String(t.side).toUpperCase()} ${nameOf(t.symbol)} @ ${px(t.entry_fill ?? t.entry_ref)} · SL ${px(t.stop_loss)} TP ${px(t.take_profit)} · now ${money(t.last_unrealized)}`);
  }
  const sent = await sendFromAra(lines.join('\n'));
  return { sent, opened: opened.length, closed: closed.length, open: open.length };
}

module.exports = { sendFromAra, araNote: notify, tradeOpened, limitPlaced, limitEnded, addedOn, tradeClosed, tradeLost, orderRejected, runDailyRecap };
