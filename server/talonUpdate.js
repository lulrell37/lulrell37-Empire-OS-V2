// T.A.L.O.N. -> A.R.A. market updates. A few times a day (TALON_UPDATE_HOURS,
// default 9:30 AM / 12:30 PM / 3:30 PM / 6:30 PM ET; TALON_UPDATES=off to stop) he reads
// gold and Bitcoin off the charts, says where he thinks each is headed next and
// how our open positions look right now, and relays it to A.R.A. She delivers
// it on her Telegram bot (voice note + text, logged in her history so she can
// talk about it), and it's saved to her persona memory so the app's A.R.A.
// knows it too. A.R.A.'s [TALON_UPDATE] asks him for one on demand.
//
// One AI call per update; no trading happens in here — the update never
// places, closes or moves anything.
const { claudeText } = require('./llm');
const { saveMemory } = require('./syncStore');
const { tlStatus, tlConnect, tlSnapshot, tlFormatSnapshot, tlPositions, tlInstrumentsById, tlAccountState } = require('./tradeLocker');
const { allTrades } = require('./tradeJournal');
const { SYMBOLS, STRATEGY } = require('./talonBrain');
const { sendFromAra } = require('./talonAlerts');

const NAMES = { XAUUSD: 'Gold', BTCUSD: 'Bitcoin' };
const CRYPTO = /^(BTC|ETH|SOL|XRP|LTC|DOGE|ADA|BNB)/;

// Our positions on `sym`, from the broker (live P/L) joined to the journal
// (scalp/swing/add, stop, target).
function positionLines(sym, positions, symOf, journal) {
  const mine = positions.filter((p) => symOf(p) === sym);
  if (!mine.length) return 'none';
  return mine.map((p) => {
    const t = journal.find((j) => String(j.position_id) === String(p.id)) || {};
    const kind = t.setup ? ` ${t.setup}${t.add_level ? ` ${t.add_level}` : ''}` : '';
    return `#${p.id}${kind} ${p.side} ${p.qty} @ ${p.avgPrice} · SL ${t.stop_loss ?? '—'} · TP ${t.take_profit ?? '—'} · unrealized P/L ${p.unrealizedPl}`;
  }).join('\n');
}

// Builds the update text. Returns { text } or { skipped }.
async function buildUpdate() {
  if (!tlStatus().connected) {
    try { await tlConnect(); } catch (e) { return { skipped: `can't log in to TradeLocker — ${e.message}` }; }
  }
  const { fxOpen } = require('./talonAutoTrade');
  const marketOpen = fxOpen();
  const syms = SYMBOLS.filter((s) => marketOpen || CRYPTO.test(s));
  const [positions, idToSym, state, trades] = await Promise.all([
    tlPositions().catch(() => []),
    tlInstrumentsById().catch(() => ({})),
    tlAccountState().catch(() => null),
    allTrades().catch(() => []),
  ]);
  const symOf = (p) => String(idToSym[String(p.tradableInstrumentId)] || '').toUpperCase();
  const journal = trades.filter((t) => t.status === 'open');

  const blocks = [];
  for (const sym of syms) {
    let snap;
    try { snap = await tlSnapshot(sym); } catch (e) { blocks.push(`=== ${sym} ===\n(market data unavailable: ${e.message})`); continue; }
    blocks.push(`=== ${sym} ===\n${tlFormatSnapshot({ ...snap, positions: [], state: null })}\n\nOUR OPEN POSITIONS ON ${sym}:\n${positionLines(sym, positions, symOf, journal)}`);
  }
  if (!blocks.length) return { skipped: 'markets closed' };
  const closedNote = syms.length < SYMBOLS.length ? `\n(Gold's market is closed right now — mention it in one line, no read.)` : '';
  // Positions on a market whose data we didn't scan (gold on the weekend) still count.
  const offScan = SYMBOLS.filter((s) => !syms.includes(s)).map((s) => `${s}: ${positionLines(s, positions, symOf, journal)}`).join('\n');

  const sys = `You are T.A.L.O.N., the Empire's trading desk. You're giving A.R.A. (who passes it straight to Mr. Burrus) a market update on gold and Bitcoin. Read the charts below by YOUR PLAYBOOK and write:
For each market: one line on where price is and the trend on 1D/4H; your PREDICTION for the next several hours — direction, the level you expect it to reach, and the level that would prove you wrong; and how OUR positions there look right now (in profit or under water, how close to stop/target, what you expect from them). If we hold nothing there, say whether a setup is forming and at what level you'd want in.
End with one line on the account (open P/L).
Plain text, short, confident, specific prices — no hedging walls, no disclaimers, no markdown headers. Bold (**like this**) is fine for the market names. Under 170 words.

YOUR PLAYBOOK:
${STRATEGY}`;
  const user = `${blocks.join('\n\n')}${offScan ? `\n\nPOSITIONS ON MARKETS NOT SCANNED NOW:\n${offScan}` : ''}${closedNote}\n\nACCOUNT: ${state ? `balance ${state.balance}, open P/L ${state.openNetPnL}, open positions ${state.positionsCount}` : 'unavailable'}`;
  const body = String(await claudeText(sys, [{ role: 'user', content: user }], { maxTokens: 600 }) || '').trim();
  if (!body) return { skipped: 'no read came back' };
  const live = tlStatus().env === 'live' ? ' · 🔴 LIVE' : '';
  return { text: `📡 **T.A.L.O.N. → A.R.A. — market update**${live}\n${body}`, body };
}

// The scheduled update: A.R.A. sends it to Mr. Burrus and remembers it.
async function runMarketUpdate() {
  const u = await buildUpdate();
  if (!u.text) return u;
  const sent = await sendFromAra(u.text);
  await saveMemory('ara', `[T.A.L.O.N. market update] ${u.body}`.slice(0, 1500)).catch(() => {});
  return { sent };
}

// [TALON_UPDATE]: the same read, handed back to A.R.A. mid-turn.
async function updateForAra() {
  const u = await buildUpdate().catch((e) => ({ skipped: e.message }));
  return u.text ? u.body : `(no update — ${u.skipped})`;
}

module.exports = { runMarketUpdate, updateForAra, buildUpdate };
