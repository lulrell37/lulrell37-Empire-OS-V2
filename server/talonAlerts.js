// T.A.L.O.N. -> A.R.A. -> Mr. Burrus. Every trade T.A.L.O.N. opens, closes or
// loses (rejected / never filled) is sent to the owner on A.R.A.'s Telegram bot,
// and goes into A.R.A.'s Telegram history so she can talk about it when he
// replies ("why'd he take that gold short?"). Plus a nightly recap (9 PM ET,
// TRADE_RECAP=off to stop) of the day's trades and what's still open.
//
// Fire-and-forget: an alert failing never holds up or breaks a trade.
// araNote() is the same delivery for anything else headed to him through
// A.R.A. (W.I.R.E.'s news briefs and 8:30 data reads).
const { query } = require('./db');
const { syncedRows, todayET } = require('./syncStore');

const NAMES = { XAUUSD: 'Gold', BTCUSD: 'Bitcoin' };
const nameOf = (sym) => NAMES[sym] ? `${NAMES[sym]} (${sym})` : sym;
const money = (n) => (n == null ? '—' : `${n < 0 ? '-' : '+'}$${Math.abs(Number(n)).toFixed(2)}`);
const px = (n) => (n == null || n === '' ? '—' : String(n));

async function sendFromAra(text) {
  const telegram = require('./telegram');
  const ara = telegram.botFor('ara');
  if (!ara || !ara.isConfigured()) return false;
  await ara.sendMessage(telegram.OWNER_ID, text);
  await query('INSERT INTO tg_messages (persona, role, content, ts) VALUES ($1, $2, $3, $4)', ['ara', 'assistant', text, Date.now()])
    .catch((e) => console.error('trade alert history save failed:', e.message));
  return true;
}

function notify(text) {
  sendFromAra(text).catch((e) => console.error('trade alert failed:', e.message));
}

function tradeOpened({ symbol, side, qty, entry, stopLoss, takeProfit, rationale, setup }) {
  const news = setup === 'news';
  notify(`📈 **T.A.L.O.N. just opened a trade**${news ? ' (news-driven)' : ''}, Mr. Burrus.\n`
    + `**${String(side).toUpperCase()} ${nameOf(symbol)}** · ${qty} lot @ ~${px(entry)}\n`
    + `Stop ${px(stopLoss)} · Target ${px(takeProfit)}`
    + `${rationale ? `\nWhy: ${String(rationale).replace(/^news — /, '')}` : ''}`);
}

function tradeClosed(t) {
  const icon = t.outcome === 'win' ? '✅' : t.outcome === 'loss' ? '🔻' : '➖';
  const word = t.outcome === 'win' ? 'a win' : t.outcome === 'loss' ? 'a loss' : 'break-even';
  const hit = t.exit_price != null && t.take_profit != null && Math.abs(t.exit_price - t.take_profit) <= Math.abs(t.take_profit) * 3e-4 ? ' — target hit'
    : t.exit_price != null && t.stop_loss != null && Math.abs(t.exit_price - t.stop_loss) <= Math.abs(t.stop_loss) * 3e-4 ? ' — stopped out' : '';
  notify(`${icon} **T.A.L.O.N. closed ${String(t.side).toUpperCase()} ${nameOf(t.symbol)}** — ${word}${hit}.\n`
    + `Entry ${px(t.entry_fill ?? t.entry_ref)} → Exit ${px(t.exit_price)} · P/L ${money(t.realized_pl)}${t.pl_estimated ? ' (est.)' : ''}`
    + `${t.r_multiple != null ? ` · ${t.r_multiple}R` : ''}`);
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

module.exports = { araNote: notify, tradeOpened, tradeClosed, tradeLost, orderRejected, runDailyRecap };
