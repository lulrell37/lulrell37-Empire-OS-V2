// T.A.L.O.N. on Mr. Burrus's orders — the hand-placed side of the desk, from
// Telegram (A.R.A. relays "tell Talon to…" to him; he emits these tags):
//
//   [TRADE_POSITIONS]                                  open positions, ids, stops, targets, P/L
//   [TRADE_ENTER: SYMBOL | buy|sell | stop | target]   market order, 0.02 (main stop rule applies)
//   [TRADE_CLOSE: position id | SYMBOL | all]          close
//   [MOVE_STOP: position id | SYMBOL | all  ~  price | breakeven]
//   [MOVE_TP: position id | SYMBOL | all  ~  price]
//   [TRADE_ACCOUNT: live | demo]                       which TradeLocker login he trades on
//
// On the demo account they run at once. On a LIVE account — and switching TO
// live — every one waits for his Confirm tap (tg_pending), like a sent email.
// Switching to demo always runs at once, from either account.
// Every change lands in the trade journal too, so ensureStop / the near-stop
// watch / the close alerts all work off the new levels, and a close he ordered
// isn't reported as "I didn't close this one".
const { query } = require('./db');
const { syncedRows, upsertSyncRow, getSetting, setSetting, newId } = require('./syncStore');
const tl = require('./tradeLocker');
const { recordTradeOpen, parkOpenTrades } = require('./tradeJournal');

const SYMS = ['XAUUSD', 'BTCUSD'];
const NAME = { XAUUSD: 'gold', BTCUSD: 'Bitcoin' };
const num = (v) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const parts = (arg) => String(arg || '').split('|').map((s) => s.trim());
const symOf = (s) => {
  const t = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (/^(XAU|XAUUSD|GOLD)$/.test(t)) return 'XAUUSD';
  if (/^(BTC|BTCUSD|BITCOIN|XBT)$/.test(t)) return 'BTCUSD';
  return null;
};

async function openJournal() {
  return (await syncedRows('trades').catch(() => [])).filter((t) => t.persona === 'talon' && t.status === 'open');
}

// Live positions joined to the journal (stop/target/setup live there; the
// broker's position row only has order ids for them).
async function positions() {
  const [pos, byId, journal] = await Promise.all([tl.tlPositions(), tl.tlInstrumentsById().catch(() => ({})), openJournal()]);
  return pos.map((p) => {
    const j = journal.find((t) => String(t.position_id) === String(p.id)) || null;
    return { id: String(p.id), symbol: String(byId[String(p.tradableInstrumentId)] || (j && j.symbol) || '?').toUpperCase(),
      side: p.side, qty: Number(p.qty), entry: Number(p.avgPrice), pl: Number(p.unrealizedPl), j };
  });
}

async function positionsText() {
  const st = tl.tlStatus();
  const list = await positions();
  const head = `ACCOUNT: ${String(st.env || 'demo').toUpperCase()}${st.env === 'live' ? ((await getSetting('talon_live', '0')) === '1' ? ' (live trading armed)' : ' (live trading NOT armed)') : ''}`;
  if (!list.length) return `${head}\nNo open positions.`;
  return `${head}\n${list.map((p) => `#${p.id} ${String(p.side).toUpperCase()} ${p.symbol} ${p.qty} @ ${p.entry} · stop ${p.j?.stop_loss ?? '?'} · target ${p.j?.take_profit ?? '?'} · P/L ${Number.isFinite(p.pl) ? `$${p.pl.toFixed(2)}` : '?'}${p.j?.setup ? ` · ${p.j.setup}` : ''}`).join('\n')}`;
}

// "#123" / "123" / "gold" / "XAUUSD" / "all" -> matching open positions.
async function pick(ref) {
  const r = String(ref || '').trim().replace(/^#/, '');
  const list = await positions();
  if (!r) throw new Error('say which position — its id, the market, or "all"');
  if (/^all$/i.test(r)) return list;
  const byId = list.filter((p) => p.id === r);
  if (byId.length) return byId;
  const sym = symOf(r.split(/\s+/)[0]);
  if (sym) {
    const side = /\b(buy|long)s?\b/i.test(r) ? 'buy' : /\b(sell|short)s?\b/i.test(r) ? 'sell' : null;
    const setup = (r.match(/\b(scalp|swing|quick|add|manual)\b/i) || [])[1];
    return list.filter((p) => p.symbol === sym && (!side || p.side === side) && (!setup || (p.j && p.j.setup === setup.toLowerCase())));
  }
  throw new Error(`no open position matches "${ref}"`);
}

async function journalUpdate(p, patch) {
  if (!p.j) return;
  await upsertSyncRow('trades', p.j.sync_id, { ...p.j, ...patch, updated_at: Date.now() });
}

const isLive = () => tl.tlStatus().env === 'live';

// --- the actions (run straight away on demo, or on his Confirm tap) ----------

async function enter({ symbol, side, stop, target }) {
  if (isLive() && (await getSetting('talon_live', '0')) !== '1') throw new Error('this is the LIVE account and live trading isn\'t armed');
  const r = await tl.tlPlaceOrder({ symbol, side, stopLoss: stop, takeProfit: target });
  const q = await tl.tlQuote(symbol).catch(() => null);
  const entry = num(side === 'buy' ? q?.ask : q?.bid) ?? num(q?.mid);
  await recordTradeOpen({ symbol, side, qty: r.qty, entry, stopLoss: r.stopLoss, takeProfit: r.takeProfit,
    rationale: 'placed on Mr. Burrus\'s order', orderId: r.orderId, setup: 'manual', auto: 0, alert: false });
  return `${side.toUpperCase()} ${NAME[symbol]} ${r.qty} placed — stop ${r.stopLoss}${r.takeProfit != null ? `, target ${r.takeProfit}` : ''}${r.widenedFrom != null ? ` (stop widened from ${r.widenedFrom} to the main stop rule's minimum)` : ''}`;
}

async function close({ ids }) {
  const list = (await positions()).filter((p) => ids.includes(p.id));
  if (!list.length) return 'nothing to close — those positions are already gone';
  const out = [];
  for (const p of list) {
    try {
      await journalUpdate(p, { closed_by: 'owner' });
      await tl.tlClosePosition(p.id);
      out.push(`closed #${p.id} ${String(p.side).toUpperCase()} ${p.symbol}`);
    } catch (e) { out.push(`#${p.id} didn't close: ${e.message}`); }
  }
  return out.join('; ');
}

async function modify({ ids, stop, target, breakeven }) {
  const list = (await positions()).filter((p) => ids.includes(p.id));
  if (!list.length) return 'nothing to change — those positions are already gone';
  const out = [];
  for (const p of list) {
    try {
      const sl = breakeven ? (num(p.j?.entry_fill) ?? p.entry) : stop;
      const change = {};
      if (sl != null) change.stopLoss = sl;
      if (target != null) change.takeProfit = target;
      await tl.tlModifyPosition(p.id, { ...change, symbol: p.symbol });
      await journalUpdate(p, { ...(sl != null ? { stop_loss: sl } : {}), ...(target != null ? { take_profit: target } : {}) });
      out.push(`#${p.id} ${p.symbol}${sl != null ? ` stop → ${sl}${breakeven ? ' (break-even)' : ''}` : ''}${target != null ? ` target → ${target}` : ''}`);
    } catch (e) { out.push(`#${p.id} not changed: ${e.message}`); }
  }
  return out.join('; ');
}

// Which saved login is active: trade_creds row 2 = demo, 3 = live (routes/trade.js
// keeps both as the app pushes them); the choice is the `talon_account` setting.
async function account({ env }) {
  // Off live before anything else can fail: whatever happens below, he can't
  // place another real order.
  if (env === 'demo') await setSetting('talon_live', '0');
  const slot = env === 'live' ? 3 : 2;
  const { rows } = await query('SELECT env FROM trade_creds WHERE id = $1', [slot]);
  const from = await tl.tlActiveEnv().catch(() => null);
  // What he's leaving behind, while the session can still see that account.
  const left = from === 'live' && env === 'demo' ? await tl.tlPositions().then((p) => p.length).catch(() => null) : 0;
  const leftNote = left === null
    ? ' I couldn\'t read the LIVE account, so check it for open positions: anything there keeps its broker stop and target, but nobody manages it while he\'s on demo.'
    : left ? ` ${left} position${left > 1 ? 's are' : ' is'} still open on LIVE with the broker stop and target. Nobody manages ${left > 1 ? 'them' : 'it'} while he's on demo: no break-even moves, no add-ons, no alerts. To close ${left > 1 ? 'them' : 'it'}, switch back to live first.` : '';
  if (from) await parkOpenTrades(from);
  if (!rows.length) {
    if (env === 'demo') return `LIVE trading is OFF, so no more real orders, but he's NOT on demo and isn't trading at all: there's no demo TradeLocker login on the server. Connect your demo login once in the app (Settings › TRADELOCKER) and he picks up there.${leftNote}`;
    throw new Error(`there's no ${env} TradeLocker login on the server yet — connect your ${env} login once in the app (Settings › TRADELOCKER) and it's saved for switching`);
  }
  await setSetting('talon_account', env);
  if (env === 'live') await setSetting('talon_live', '1');
  tl.tlReset();
  const info = await tl.tlConnect().catch((e) => ({ error: e.message }));
  if (info.error) return `switched to ${env.toUpperCase()}, but logging in failed: ${info.error}${env === 'demo' ? ' LIVE trading is off either way.' : ''}${leftNote}`;
  return `T.A.L.O.N. is now on the ${env.toUpperCase()} account${info.accNum ? ` (#${info.accNum}` : ''}${info.balance != null ? `, balance $${Number(info.balance).toLocaleString()})` : info.accNum ? ')' : ''}${env === 'live' ? ' — live trading armed: real money from here' : ''}.${leftNote}`;
}

const RUN = { enter, close, modify, account };
async function runAction(kind, payload) { return RUN[kind](payload); }

// --- tags -> action (now, or a Confirm card) ---------------------------------

async function propose(kind, label, detail, payload) {
  const id = newId().slice(0, 12);
  await query('INSERT INTO tg_pending (id, persona, kind, label, detail, payload, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [id, 'ara', `talon_${kind}`, label, detail, JSON.stringify(payload), Date.now()]);
  return { confirm: { id, label, detail } };
}

async function act(kind, label, detail, payload, { confirm = false } = {}) {
  if (confirm || isLive()) return propose(kind, label, detail, payload);
  return { ok: `T.A.L.O.N.: ${await runAction(kind, payload)}` };
}

const WRITE_TAGS = new Set(['TRADE_ENTER', 'TRADE_CLOSE', 'MOVE_STOP', 'MOVE_TP', 'TRADE_ACCOUNT']);

async function writeTag({ name, arg }) {
  try {
    if (!tl.tlStatus().connected) await tl.tlConnect();
  } catch (e) {
    if (name !== 'TRADE_ACCOUNT') return { warn: `${name}: can't reach TradeLocker — ${e.message}` };
  }
  const p = parts(arg);
  try {
    if (name === 'TRADE_ENTER') {
      const symbol = symOf(p[0]);
      const side = /^(buy|long)$/i.test(p[1]) ? 'buy' : /^(sell|short)$/i.test(p[1]) ? 'sell' : null;
      const stop = num(p[2]);
      const target = num(p[3]);
      if (!symbol) return { warn: `TRADE_ENTER: "${p[0]}" — T.A.L.O.N. only trades gold (XAUUSD) and Bitcoin (BTCUSD)` };
      if (!side) return { warn: 'TRADE_ENTER: needs buy or sell' };
      if (stop == null) return { warn: 'TRADE_ENTER: every trade needs a stop — nothing placed' };
      const label = `T.A.L.O.N.: ${side.toUpperCase()} ${NAME[symbol]} on the LIVE account`;
      return act('enter', label, `0.02 · stop ${stop}${target != null ? ` · target ${target}` : ''}`, { symbol, side, stop, target });
    }
    if (name === 'TRADE_CLOSE') {
      const list = await pick(p[0]);
      if (!list.length) return { warn: `TRADE_CLOSE: no open position matches "${p[0]}"` };
      const ids = list.map((x) => x.id);
      return act('close', `T.A.L.O.N.: close ${list.length} LIVE position${list.length > 1 ? 's' : ''}`, list.map((x) => `#${x.id} ${String(x.side).toUpperCase()} ${x.symbol} (P/L $${(x.pl || 0).toFixed(2)})`).join('\n'), { ids });
    }
    if (name === 'MOVE_STOP' || name === 'MOVE_TP') {
      const list = await pick(p[0]);
      if (!list.length) return { warn: `${name}: no open position matches "${p[0]}"` };
      const ids = list.map((x) => x.id);
      const be = name === 'MOVE_STOP' && /^(be|break[\s-]?even|entry)$/i.test(p[1] || '');
      const price = num(p[1]);
      if (!be && price == null) return { warn: `${name}: needs a price${name === 'MOVE_STOP' ? ' or "breakeven"' : ''} — a stop can be moved, never removed` };
      const payload = name === 'MOVE_STOP' ? { ids, stop: be ? null : price, breakeven: be } : { ids, target: price };
      const what = name === 'MOVE_STOP' ? `stop → ${be ? 'break-even' : price}` : `target → ${price}`;
      return act('modify', `T.A.L.O.N.: ${what} on the LIVE account`, list.map((x) => `#${x.id} ${String(x.side).toUpperCase()} ${x.symbol}`).join('\n'), payload);
    }
    if (name === 'TRADE_ACCOUNT') {
      const env = /live|real/i.test(p[0]) ? 'live' : /demo|paper|practice/i.test(p[0]) ? 'demo' : null;
      if (!env) return { warn: 'TRADE_ACCOUNT: live or demo?' };
      // Back to demo is the safe direction: never a card, even from the live
      // account, or he stays live until someone taps it.
      if (env === 'demo') return { ok: `T.A.L.O.N.: ${await runAction('account', { env })}` };
      return propose('account', 'T.A.L.O.N.: switch to the LIVE account (real money)', 'Auto-trade, W.I.R.E.\'s news trades and anything you order will place real orders.', { env });
    }
  } catch (e) {
    return { warn: `${name} failed — ${e.message}` };
  }
  return null;
}

module.exports = { WRITE_TAGS, writeTag, runAction, positionsText, symOf, SYMS };
