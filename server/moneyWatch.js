// A.T.L.A.S.'s money watch — A.R.A.'s inbox handed to A.T.L.A.S. (owner's framing,
// 2026-11-20): every money email across all his accounts is hers to log.
// The Empire's money in and out, logged without him
// telling her each one (owner's request, 2026-11-20). Every 2 h she reads his
// Gmail for the emails money already sends — sales and orders (Etsy, Fiverr,
// Shopify, YouTube/AdSense, affiliate payouts), payments received (PayPal, Cash
// App, Zelle, Venmo, Stripe), payouts, bank or card transaction alerts, bills
// paid, subscriptions charged, receipts — and one Claude call reads the new ones,
// keeps only real money movements with an amount, and logs each to the synced
// `revenue` table (the same rows [ADD_REVENUE] writes and the HUD's month-to-date
// reads) under the matching business, or "Personal". No bank statements: he said
// no to that (2026-11-20). Each message is logged once (app_settings.money_watch_seen);
// when a run logs anything, A.T.L.A.S. sends him one short summary through A.R.A.
// MONEY_WATCH=off stops it. node server/scripts/test-money-watch.js.
const { syncedRows, upsertSyncRow, newId, getSetting, setSetting, todayET } = require('./syncStore');
const { claudeText } = require('./llm');

const QUERY = 'newer_than:3d -in:spam -in:trash (order OR sale OR sold OR payment OR paid OR payout OR deposit OR receipt OR invoice OR charged OR transaction OR purchase OR refund OR "you received" OR "you sent" OR "money" OR earnings OR commission OR subscription OR renewal OR bill)';
const MAX_MSGS = 25;
const SEEN_MAX = 800;

// His own name, Tarell Burrus, and the spellings voice and email apps turn it into
// (Terrell, Tarrell, Lulrell, Lorell…) — on both ends of a transfer it's him paying himself.
const OWNER_NAME = /\b(l[uo]l+r?el+|lu\s?rel+|t[ae]r+el+|lor+el+|lul+)\s+(?:[a-z]\.?\s+)?bur+[eiou]?s+\b/i;
const ownName = (text) => OWNER_NAME.test(String(text || ''));

function enabled() { return String(process.env.MONEY_WATCH || '').toLowerCase() !== 'off'; }

const SYSTEM = (businesses) => `You are A.T.L.A.S., Mr. Burrus's money manager, reading his recent emails to log money that moved. His businesses: ${businesses.join(', ')}. Anything not tied to one of them is "Personal".

A.R.A. reads his inbox and hands you every money email from every account he has (banks, cards, PayPal, Cash App, Zelle, Venmo, Stripe, Etsy, Fiverr, YouTube, affiliate programs) — track all of them, not one account.
His name is Tarell Burrus (it may be misspelled: Terrell, Tarrell, Terell, Lulrell, Lorell Burrus or close to it). Money moving between HIS OWN accounts is a transfer, not money in or out: his name on both ends ("You sent $200 to Lulrell Burrus", "from Lulrell Burrus"), the bank calling it a transfer between his accounts ("Transfer to savings", "added cash from your bank", "transfer to your bank account"), or the same amount leaving one of his accounts and arriving in another in these emails. Mark those "transfer": true. Emails flagged [HIS NAME APPEARS] have his name in them — check whether he is on both ends.
For each email decide whether it records an ACTUAL money movement to or from him with a clear amount: a sale or order he received money for, a payment or payout received, a deposit, a purchase, a bill or subscription charged, a transfer sent, a refund. NOT money: marketing and promos, "your order shipped" with no charge, quotes, abandoned carts, failed or pending payments, statements, price alerts, anything without an amount.
Reply with ONLY a JSON array, one object per money email (skip the rest):
[{"id":"<message id>","direction":"in"|"out","amount":<number, no currency sign>,"currency":"USD","business":"<one of his businesses, exactly as written, or Personal>","source":"<which account or service the money moved through: Chase checking, Capital One card, PayPal, Cash App, Etsy…>","note":"<what it was, under 60 chars>","transfer":true|false}]
If none qualify, reply []. Never guess an amount that isn't in the email.`;

function parse(raw, ids) {
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr; try { arr = JSON.parse(m[0]); } catch { return []; }
  return (Array.isArray(arr) ? arr : []).filter((x) => x && ids.has(String(x.id)) && ['in', 'out'].includes(x.direction)
    && Number.isFinite(Number(x.amount)) && Number(x.amount) > 0 && Number(x.amount) < 1e6
    && (!x.currency || String(x.currency).toUpperCase() === 'USD'))
    .map((x) => ({ id: String(x.id), direction: x.direction, amount: +Number(x.amount).toFixed(2), business: String(x.business || 'Personal').slice(0, 60), source: String(x.source || '').slice(0, 40), note: String(x.note || '').slice(0, 80), transfer: x.transfer === true || x.transfer === 'true' }));
}

// Matching pairs: an amount that leaves one account and arrives in another within
// two days is a transfer. Checks this batch and what was logged in the last 2 days;
// returns the earlier logged rows that turned out to be the other side.
function pairTransfers(entries, recent, now = Date.now()) {
  const partners = [];
  const live = entries.filter((e) => !e.transfer);
  for (const e of live) {
    if (e.transfer) continue;
    const twin = live.find((o) => o !== e && !o.transfer && o.direction !== e.direction && o.amount === e.amount && o.source !== e.source);
    if (twin) { e.transfer = twin.transfer = true; continue; }
    const row = recent.find((r) => r.auto && !r.transfer_flag && Number(r.amount) === e.amount && now - Number(r.created_at || 0) < 2 * 86400e3
      && (String(r.type).toLowerCase() === 'expense') !== (e.direction === 'out'));
    if (row) { e.transfer = true; partners.push(row); row.transfer_flag = true; }
  }
  return partners;
}

// The best-matching business name from his list (the model's spelling can drift).
function matchBusiness(name, businesses) {
  const n = String(name || '').toLowerCase();
  return businesses.find((b) => b.toLowerCase() === n) || businesses.find((b) => n && (b.toLowerCase().includes(n) || n.includes(b.toLowerCase()))) || 'Personal';
}

async function recentEmails(seen) {
  const g = require('./google');
  const list = await g.gapi('/gmail/v1/users/me/messages', { query: { q: QUERY, maxResults: MAX_MSGS } });
  const ids = ((list && list.messages) || []).map((m) => m.id).filter((id) => !seen.has(id));
  const out = [];
  for (const id of ids) {
    try { out.push({ id, text: (await g.gmailRead(id)).slice(0, 1800) }); } catch {}
  }
  return out;
}

async function tick() {
  if (!enabled()) return { skipped: 'off' };
  const g = require('./google');
  if (!(await g.googleLinked().catch(() => false))) return { skipped: 'google not linked' };
  let seenArr = []; try { seenArr = JSON.parse(await getSetting('money_watch_seen', '[]')) || []; } catch {}
  const seen = new Set(seenArr);
  const emails = await recentEmails(seen);
  if (!emails.length) return { quiet: true };
  const businesses = [...new Set((await syncedRows('business_targets').catch(() => [])).map((b) => b.business).filter(Boolean))];
  const raw = await claudeText(SYSTEM(businesses), emails.map((e) => `=== message id ${e.id} ===${ownName(e.text) ? ' [HIS NAME APPEARS]' : ''}\n${e.text}`).join('\n\n'), { maxTokens: 1500 });
  const entries = parse(raw, new Set(emails.map((e) => e.id)));
  const now = Date.now();
  const partners = pairTransfers(entries, await syncedRows('revenue').catch(() => []), now);
  const transfers = entries.filter((e) => e.transfer);
  for (const e of entries.filter((x) => !x.transfer)) {
    const business = matchBusiness(e.business, businesses);
    await upsertSyncRow('revenue', newId(), {
      business, amount: e.amount, type: e.direction === 'in' ? 'income' : 'expense',
      note: `auto · ${e.source}${e.note ? ` · ${e.note}` : ''}`, source_email: e.id, auto: true,
      date: todayET(), created_at: now, updated_at: now,
    });
    e.business = business;
  }
  await setSetting('money_watch_seen', JSON.stringify([...seenArr, ...emails.map((e) => e.id)].slice(-SEEN_MAX)));
  const logged = entries.filter((e) => !e.transfer);
  if (entries.length) {
    const fmt = (n) => `${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const lines = logged.map((e) => `${e.direction === 'in' ? '+' : '−'}${fmt(e.amount)} · ${e.business} · ${e.source}${e.note ? ` (${e.note})` : ''}`);
    const skipped = transfers.map((e) => `↔ ${fmt(e.amount)} · ${e.source}${e.note ? ` (${e.note})` : ''}`);
    const back = partners.map((r) => `⚠️ ${fmt(Number(r.amount))} logged earlier (${String(r.note || '').replace(/^auto · /, '')}) looks like the other side of a transfer — check it.`);
    await require('./talonAlerts').araNote([`💰 A.T.L.A.S. → A.R.A.: from the money emails A.R.A. passed me —`, ...lines, ...(skipped.length ? ['Not counted, transfers between his own accounts:', ...skipped] : []), ...back].join('\n'));
  }
  return { logged: logged.length, transfers: transfers.length, read: emails.length };
}

// A month (YYYY-MM), in and out, per business and total — pure, on the revenue rows.
function monthSummary(all, month, label = `${month} so far`) {
  const rows = all.filter((r) => String(r.date || '').startsWith(month));
  if (!rows.length) return `Nothing logged in ${month} yet.`;
  const by = {};
  for (const r of rows) {
    const b = r.business || 'Personal';
    by[b] = by[b] || { in: 0, out: 0 };
    by[b][String(r.type).toLowerCase() === 'expense' ? 'out' : 'in'] += Number(r.amount) || 0;
  }
  const f = (n) => `$${n.toFixed(2)}`;
  let tin = 0, tout = 0;
  const lines = Object.entries(by).sort((a, b) => (b[1].in - b[1].out) - (a[1].in - a[1].out)).map(([b, v]) => { tin += v.in; tout += v.out; return `- ${b}: in ${f(v.in)}, out ${f(v.out)}, net ${f(v.in - v.out)}`; });
  const auto = rows.filter((r) => r.auto).length;
  return `${label} (${rows.length} entries, ${auto} logged automatically from email):\n${lines.join('\n')}\nTotal: in ${f(tin)}, out ${f(tout)}, net ${f(tin - tout)}`;
}

// This month so far — for [MONEY_IN_OUT].
async function monthText() {
  return monthSummary(await syncedRows('revenue').catch(() => []), todayET().slice(0, 7));
}

// End of the month (last day, 9:50 PM ET, after the day report): A.T.L.A.S. gives
// A.R.A. the month's total in, out and net, per business. (Owner's request, 2026-11-20.)
const lastDayOfMonth = (day) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + 1)).getUTCDate() === 1;
async function monthReport({ force = false } = {}) {
  if (!enabled()) return { skipped: 'off' };
  const day = todayET();
  if (!force && !lastDayOfMonth(day)) return { skipped: 'not the last day' };
  const month = day.slice(0, 7);
  const name = new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  await require('./talonAlerts').araNote(`📅 A.T.L.A.S. → A.R.A.: ${name} is done. ${monthSummary(await syncedRows('revenue').catch(() => []), month, `The month's total`)}`);
  return { sent: true };
}

// End of day (9:45 PM ET): A.T.L.A.S. gives A.R.A. today's in and out — totals,
// in, out and net in dollars, and each entry — after one last sweep of the inbox.
// Quiet days say so in one line. (Owner's request, 2026-11-20.)
function dayReport(rows, day) {
  const f = (n) => `$${n.toFixed(2)}`;
  const today = rows.filter((r) => String(r.date || '') === day);
  if (!today.length) return `💰 A.T.L.A.S. → A.R.A.: nothing came in or went out today (${day}).`;
  let tin = 0, tout = 0;
  const lines = today.map((r) => {
    const out = String(r.type).toLowerCase() === 'expense';
    const a = Number(r.amount) || 0;
    if (out) tout += a; else tin += a;
    return `${out ? '−' : '+'}${f(a)} · ${r.business || 'Personal'}${r.note ? ` · ${String(r.note).replace(/^auto · /, '')}` : ''}`;
  });
  return `💰 A.T.L.A.S. → A.R.A.: today's money (${day})\nIn ${f(tin)} · Out ${f(tout)} · Net ${f(tin - tout)}\n${lines.join('\n')}`;
}

async function dailyReport() {
  if (!enabled()) return { skipped: 'off' };
  await tick().catch((e) => console.error('money watch failed:', e.message));
  const text = dayReport(await syncedRows('revenue').catch(() => []), todayET());
  await require('./talonAlerts').araNote(text);
  return { sent: true };
}

const MONEY_TOOLS = ' - [MONEY_IN_OUT] — this month\'s money in and out, per business and total, from everything logged (yours, his, and what you log automatically from his email every 2 hours: sales, payouts, payments, charges, bills). Read it whenever he asks how the money looks.';

module.exports = { ownName, pairTransfers, dailyReport, dayReport, monthReport, monthSummary, lastDayOfMonth, tick, parse, matchBusiness, monthText, MONEY_TOOLS, enabled };
