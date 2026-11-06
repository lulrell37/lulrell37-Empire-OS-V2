// A.T.L.A.S.'s investment desk. She reads W.I.R.E.'s news, picks stocks for the
// short and the long term, and hands the call to A.R.A., who tells Mr. Burrus:
// what to buy, the entry zone, the target, the stop, the date to be out by, and
// what would make her get out early.
//
//   runDesk()      weekdays 9:05 AM, 11:30 AM, 1:30 PM and 3:30 PM ET, and after a
//                  W.I.R.E. brief (at most every 2 hours): W.I.R.E.'s news ->
//                  candidates from a live web search -> real candles (stockData.js)
//                  -> her decision -> the rules in validatePick. No limit on how many
//                  calls she makes: everything that clears the rules goes to him, one
//                  call per ticker per horizon. A later run skips itself if
//                  she read the news in the last hour. Silent when nothing changed,
//                  except her Monday status.
//   watchPicks()   every 15 min in market hours, no AI: entry reached, stop, target,
//                  exit date. A.R.A. tells him each one once.
//
// Advice only: nothing here can place an order (his TradeLocker desk is gold and
// Bitcoin only), so results are a paper record. Picks live in
// app_settings.atlas_picks. ATLAS_PICKS=off stops it.
const { claudeText, webResearch, WEB_SEARCH_TOOL } = require('./llm');
const { getSetting, setSetting, syncedRow, saveMemory, todayET } = require('./syncStore');
const { sendFromAra } = require('./talonAlerts');
const { cleanTicker, stockQuote, stockSnapshot, formatSnapshot, validatePick, stepPick, closePick, recordLine } = require('./stockData');

const BRIEF_FRESH = 12 * 3600e3;
const BRIEF_REVIEW_EVERY = 2 * 3600e3;
const MIN_RUN_GAP = 3600e3;
const KEEP_CLOSED = 40;
const NOT_PLACED = 'A.T.L.A.S. can\'t place orders: any buy, and its stop, is yours to set with your broker.';
let busy = false;

const isOpen = (p) => p.status === 'watching' || p.status === 'active';
const m = (n) => `$${Number(n).toFixed(2)}`;
const dateOf = (ms) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });

async function loadPicks() {
  const raw = await getSetting('atlas_picks', '[]').catch(() => '[]');
  try { const a = Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function savePicks(picks) {
  const open = picks.filter(isOpen);
  const done = picks.filter((p) => !isOpen(p)).sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, KEEP_CLOSED);
  await setSetting('atlas_picks', JSON.stringify([...open, ...done]));
}

function parseJson(raw) {
  const x = String(raw || '').match(/\{[\s\S]*\}/);
  if (!x) return null;
  try { return JSON.parse(x[0]); } catch { return null; }
}

// A.R.A. tells him, and both of them remember it.
async function tell(text, memory, spoken = text) {
  await sendFromAra(text, spoken).catch((e) => console.error('atlas-invest: send failed —', e.message));
  await saveMemory('atlas', `[your investment desk] ${memory}`.slice(0, 1500)).catch(() => {});
  await saveMemory('ara', `[A.T.L.A.S.'s stock call, her words and her call, relayed to Mr. Burrus] ${memory}`.slice(0, 1500)).catch(() => {});
}

const planLine = (p) => `Get in: ${m(p.entryLow)}–${m(p.entryHigh)} · Get out: target ${m(p.target)} · Stop ${m(p.stop)} · Out by ${dateOf(p.exitAt)} (${p.r}R)`;

function callText(p) {
  const label = p.horizon === 'short' ? 'Short-term' : 'Long-term';
  return `**${label}: ${p.ticker}** (${p.name}), ${m(p.priceAtCall)} now\n${planLine(p)}\n`
    + `Why: ${p.thesis}${p.catalyst ? `\nCatalyst: ${p.catalyst}` : ''}\nGet out early if: ${p.getOutIf}`;
}

async function wireNews(fresh) {
  if (fresh) return fresh;
  const hud = (await syncedRow('hud_state', 'singleton').catch(() => null)) || {};
  const brief = Date.now() - Number(hud.news_updated_at || 0) < BRIEF_FRESH ? String(hud.news_brief || '') : '';
  // No fresh brief (W.I.R.E. only writes one on a real break): her own market scan.
  const scan = await webResearch('W.I.R.E. market scan: what is moving U.S. stocks today and this week. Earnings, guidance, Fed and macro data, sector moves, policy, deals, upgrades and downgrades. Named companies, tickers, numbers and sources. Facts only.').catch((e) => { console.error('atlas-invest: market scan failed —', e.message); return ''; });
  return [brief && `W.I.R.E.'S LATEST BRIEF:\n${brief}`, scan && `W.I.R.E. MARKET SCAN:\n${scan}`].filter(Boolean).join('\n\n');
}

async function findCandidates(news, open) {
  const sys = `You are A.T.L.A.S., the Empire's wealth strategist, shortlisting investments for Mr. Burrus. Search the live web to check the news below and fill in what it's missing: next earnings dates, recent results, guidance, valuation. Base every name on something you actually found.
SHORT TERM (days to about 6 weeks): a specific catalyst or news reaction a U.S. stock can still trade. LONG TERM (a year or more): a durable business or broad ETF with a real reason it compounds, bought at a sensible price.
Long only: stocks and ETFs on U.S. exchanges. No options, shorts, leveraged ETFs, OTC or penny stocks. Skip anything that's already run so far the move is gone.
Reply with ONLY JSON: {"short":["TICKER"],"long":["TICKER"],"notes":{"TICKER":"the catalyst or case, the next earnings date, what you found and where, under 60 words"}}. List every name that genuinely qualifies, however many or few.`;
  const user = `Today is ${todayET()}.\n\n${String(news).slice(0, 7000)}\n\nAlready open, don't list these: ${open.map((p) => p.ticker).join(', ') || 'none'}`;
  return parseJson(await claudeText(sys, user, { maxTokens: 4000, tools: [{ ...WEB_SEARCH_TOOL[0], max_uses: 15 }] })) || {};
}

const DECISION_RULES = `HARD RULES, checked in code; a call that breaks one is thrown out:
- Use only prices from the data below, and levels you can point to on the chart.
- stop is under the entry and past a real level (a swing low, order block or liquidity pool), at least 1× the daily ATR from the entry for a short-term call and 2× for a long-term one.
- target is a real level overhead; from the entry's midpoint it pays at least 2R short term, 2.5R long term.
- The entry zone holds the current price or sits just under it (within 5% short term, 10% long term). A pullback entry is fine; chasing isn't.
- exitBy (YYYY-MM-DD): the date to be out by even if nothing else fired. Short term within 45 days. Long term within 5 years: when you expect the thesis to have played out.
- Earnings inside a short-term hold are a coin flip with a gap: say so in the catalyst, or set exitBy before them.
- conviction is "high" or "medium". A low-conviction idea isn't a call.
"new" can be empty. He wants the best thing to do, and sometimes that is nothing; say why in "pass".`;

async function decide({ news, notes, snaps, open, record }) {
  const sys = `You are A.T.L.A.S., the Empire's wealth strategist. You decide what Mr. Burrus buys and when he gets out. Numbers first, no hype: an honest pass beats a forced pick. This is his real money and he acts on what you say.
Make a call on every name in the data that truly clears the bar, short term and long term, as many as there are; never pad the list to look busy. Review every open call too: if the news has broken its thesis, put it in "exit" and say why.
${DECISION_RULES}
Reply with ONLY JSON:
{"new":[{"ticker":"","horizon":"short"|"long","entryLow":0,"entryHigh":0,"stop":0,"target":0,"exitBy":"YYYY-MM-DD","conviction":"high"|"medium","catalyst":"under 25 words","thesis":"under 45 words, plain English","getOutIf":"the specific thing that breaks it, under 20 words"}],"exit":[{"ticker":"","horizon":"short"|"long","reason":"under 25 words"}],"pass":"under 30 words, only if new is empty"}`;
  const user = `Today is ${todayET()}.\n\nNEWS FROM W.I.R.E.:\n${String(news).slice(0, 6000)}\n\nYOUR RESEARCH NOTES:\n${JSON.stringify(notes || {}).slice(0, 12000)}\n\nOPEN CALLS:\n${open.map((p) => `${p.ticker} ${p.horizon} (${p.status}), ${planLine(p)}. Thesis: ${p.thesis}. Get out if: ${p.getOutIf}`).join('\n') || 'none'}\n\nYOUR RECORD: ${record}\n\nPRICE DATA:\n${snaps.map(formatSnapshot).join('\n\n') || '(none)'}`;
  return parseJson(await claudeText(sys, user, { maxTokens: 6000 })) || {};
}

// The whole desk. { force } is a direct ask: it skips the call limits and always answers.
async function runDesk({ force = false, news: freshNews = '', trigger = 'morning' } = {}) {
  if (busy) return { skipped: 'desk is busy' };
  busy = true;
  try {
    const now = Date.now();
    if (trigger === 'midday' && now - (parseInt(await getSetting('atlas_last_run', '0'), 10) || 0) < MIN_RUN_GAP) return { skipped: 'ran in the last hour' };
    await setSetting('atlas_last_run', String(now));
    const picks = await loadPicks();
    const open = picks.filter(isOpen);

    const news = await wireNews(freshNews);
    if (!news) { if (force) return { text: 'No news came back from W.I.R.E., so no call.' }; return { skipped: 'no news' }; }

    const cand = await findCandidates(news, open);
    const list = (x) => (Array.isArray(x) ? x.map(cleanTicker).filter(Boolean) : []);
    const fresh = [...new Set([...list(cand.short), ...list(cand.long)])];
    const tickers = [...new Set([...fresh, ...open.map((p) => p.ticker)])];
    const results = await Promise.allSettled(tickers.map(stockSnapshot));
    const snaps = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    results.forEach((r, i) => { if (r.status === 'rejected') console.error(`atlas-invest: ${tickers[i]} —`, r.reason?.message); });
    if (!snaps.length && tickers.length) {
      const msg = 'Stock prices are unavailable right now, so no call.';
      if (force) return { text: msg };
      console.error('atlas-invest:', msg);
      return { skipped: msg };
    }

    const dec = await decide({ news, notes: cand.notes, snaps, open, record: recordLine(picks) });

    // Exits she called on the news.
    const next = [...picks];
    const lines = [];
    for (const x of Array.isArray(dec.exit) ? dec.exit : []) {
      const i = next.findIndex((p) => isOpen(p) && p.ticker === cleanTicker(x.ticker) && (!x.horizon || p.horizon === x.horizon));
      if (i < 0) continue;
      const p = next[i];
      const price = snaps.find((s) => s.ticker === p.ticker)?.price;
      if (!isFinite(price)) continue;
      const why = String(x.reason || 'thesis broke').slice(0, 200);
      if (p.status === 'active') {
        next[i] = { ...closePick(p, price, now, 'thesis'), reasonText: why };
        lines.push(`🚪 **Get out of ${p.ticker}** at about ${m(price)} (${next[i].rMade}R on paper). ${why}`);
      } else {
        next[i] = { ...p, status: 'cancelled', closedAt: now, reason: why };
        lines.push(`❌ **${p.ticker} call is off, don't buy it.** ${why}`);
      }
    }

    // New calls: everything that survives the rules, one per ticker per horizon.
    const made = [], rejected = [];
    for (const raw of Array.isArray(dec.new) ? dec.new : []) {
      const t = cleanTicker(raw.ticker);
      if (next.some((p) => isOpen(p) && p.ticker === t && p.horizon === raw.horizon)) { rejected.push(`${t}: already open`); continue; }
      const snap = snaps.find((s) => s.ticker === t);
      if (!snap) { rejected.push(`${t}: no real price`); continue; }
      const v = validatePick(raw, snap, now);
      if (v.skip) { rejected.push(`${t}: ${v.skip}`); console.log(`atlas-invest: ${t} rejected — ${v.skip}`); continue; }
      next.push(v.pick); made.push(v.pick);
    }
    await savePicks(next);
    console.log(`atlas-invest: ${trigger} — ${made.length} new, ${lines.length} exits${rejected.length ? `, rejected ${rejected.join('; ')}` : ''}`);

    const pass = dec.pass ? String(dec.pass).slice(0, 240) : 'nothing clears the bar right now.';
    const monday = trigger === 'morning' && new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' }) === 'Mon';
    if (!made.length && !lines.length && !force && !monday) return { quiet: true };

    const parts = ['💰 **A.T.L.A.S. → A.R.A. — stocks**, for Mr. Burrus.'];
    if (made.length) parts.push(made.map(callText).join('\n\n'));
    if (lines.length) parts.push(lines.join('\n'));
    if (!made.length) parts.push(`No new call: ${pass}`);
    else if (force) {
      const missing = ['short', 'long'].find((h) => !made.some((p) => p.horizon === h));
      if (missing) parts.push(`No new ${missing}-term call this time.`);
    }
    if (force && rejected.length) parts.push(`Thrown out by the rules: ${rejected.join('; ').slice(0, 400)}`);
    const stillOpen = next.filter(isOpen);
    if ((force || monday) && stillOpen.length) parts.push(`**Open calls**\n${stillOpen.map((p) => `• ${p.ticker} (${p.horizon}, ${p.status === 'active' ? 'in the zone' : 'waiting on the entry'}): ${planLine(p)}`).join('\n')}`);
    if (force || monday) parts.push(`Record: ${recordLine(next)}`);
    if (made.length) parts.push(NOT_PLACED);
    const text = parts.join('\n\n');
    // However long the list runs, she says the names and the text has the numbers.
    const spoken = made.length > 2
      ? `A.T.L.A.S. → A.R.A.: ${made.length} new stock calls for Mr. Burrus: ${made.map((p) => `${p.ticker} ${p.horizon === 'short' ? 'short term' : 'long term'}`).join(', ')}.${lines.length ? ` And ${lines.length} open call${lines.length > 1 ? 's' : ''} to get out of or drop.` : ''} The levels are in the text.`
      : text;
    await tell(text, text.replace(/\*\*/g, ''), spoken);
    return { text, made: made.length, exits: lines.length };
  } finally {
    busy = false;
  }
}

// A W.I.R.E. brief just landed: she reads it, at most every 4 hours.
async function onWireBrief(brief) {
  if (process.env.ATLAS_PICKS === 'off') return;
  const last = parseInt(await getSetting('atlas_brief_review', '0'), 10) || 0;
  if (Date.now() - last < BRIEF_REVIEW_EVERY) return;
  await setSetting('atlas_brief_review', String(Date.now()));
  await runDesk({ news: `W.I.R.E.'S BRIEF, JUST IN:\n${brief}`, trigger: 'wire' });
}

const EVENT_TEXT = {
  entry: (p, price) => `✅ **${p.ticker} is in the buy zone** at ${m(price)}.\n${planLine(p)}\nGet out early if: ${p.getOutIf}`,
  stop: (p, price) => `🔻 **Get out of ${p.ticker}: it hit the stop.** ${m(price)} against a ${m(p.stop)} stop (${p.rMade}R on paper).`,
  target: (p, price) => `🎯 **${p.ticker} hit the target: take the money.** ${m(price)} (+${p.rMade}R on paper).`,
  time: (p, price) => `⏰ **${p.ticker} reached its exit date: get out.** ${m(price)} (${p.rMade}R on paper).`,
  cancelled: (p) => `❌ **${p.ticker} call is off, don't buy it**: ${p.reason}.`,
};

// Market-hours watch. No AI. A failed quote waits for the next check.
async function watchPicks() {
  if (busy) return;
  busy = true;
  try {
    const picks = await loadPicks();
    if (!picks.some(isOpen)) return;
    let changed = false;
    const notes = [];
    const next = [];
    for (const p of picks) {
      if (!isOpen(p)) { next.push(p); continue; }
      const q = await stockQuote(p.ticker).catch((e) => { console.error(`atlas-invest: quote ${p.ticker} —`, e.message); return null; });
      if (!q) { next.push(p); continue; }
      const { pick, event } = stepPick(p, q.price);
      next.push(pick);
      if (event) { changed = true; notes.push(EVENT_TEXT[event](pick, q.price)); }
    }
    if (!changed) return;
    await savePicks(next);
    const text = `💰 **A.T.L.A.S. → A.R.A. — stocks**, for Mr. Burrus.\n\n${notes.join('\n\n')}`;
    await tell(text, text.replace(/\*\*/g, ''));
  } finally {
    busy = false;
  }
}

// [STOCK_PICKS]: where every call stands right now, with live prices.
async function picksText() {
  const picks = await loadPicks();
  const open = picks.filter(isOpen);
  const lines = await Promise.all(open.map(async (p) => {
    const q = await stockQuote(p.ticker).catch(() => null);
    return `${p.ticker} ${p.name} (${p.horizon}, ${p.status === 'active' ? `in since ${m(p.entryPrice)}` : 'waiting on the entry'}), now ${q ? m(q.price) : 'price unavailable'}. ${planLine(p)}. Thesis: ${p.thesis}. Get out if: ${p.getOutIf}`;
  }));
  return `${lines.join('\n') || 'No open calls.'}\nRecord: ${recordLine(picks)}\n${NOT_PLACED}`;
}

module.exports = { runDesk, onWireBrief, watchPicks, picksText };
