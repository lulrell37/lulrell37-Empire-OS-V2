// W.I.R.E. news desk — server-side port of src/services/newsWire.js.
//
// Tier 1: a headline poll every 10 min (itself gated to once per 2h during
// waking hours, matching the client) — cheap search + classify, escalates to a
// full brief on a real break. Tier 2: the full brief, written to `hud_state`
// (the app's NEWS panel already reads this via sync — no separate delivery
// needed) plus a push alert on the owner's phone for a real break, and the
// full brief to him on Telegram from A.R.A.'s bot. A
// MARKETIMPACT high-confidence line hands off to T.A.L.O.N. exactly like the
// client's newsTradeHandoff, demo-account-only.
const { webResearch, chatAs } = require('./llm');
const { getSetting, setSetting, upsertSyncRow, syncedRow, syncedRows, saveMemory, todayET } = require('./syncStore');
const { tlStatus, tlConnect, tlSnapshot, tlFormatSnapshot, tlPlaceOrder, MAX_QTY, ENTRY_COPIES } = require('./tradeLocker');
const { recordTradeOpen, TRADER_ID } = require('./tradeJournal');
const { newsTradeLevels, guardStop, SYMBOLS } = require('./talonBrain');
const { orderRejected, tradeOpened, araNote } = require('./talonAlerts');
const { pushAlert } = require('./pushSender');

const TZ = 'America/New_York';
const SEEN_MAX = 140;
const POLL_EVERY_HOURS = 2;
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 23;
let busy = false;

function hourET() {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()), 10) % 24;
}
const pollSlot = () => `${todayET()}-b${Math.floor(hourET() / POLL_EVERY_HOURS)}`;
const inPollWindow = () => { const h = hourET(); return h >= DAY_START_HOUR && h < DAY_END_HOUR; };

function fingerprint(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
}
async function loadSeen() {
  try { const a = JSON.parse(await getSetting('news_seen', '[]')); return Array.isArray(a) ? a : []; } catch { return []; }
}
async function rememberHeadlines(lines) {
  const fps = lines.map(fingerprint).filter(Boolean);
  if (!fps.length) return;
  const seen = await loadSeen();
  const next = [...fps, ...seen.filter((x) => !fps.includes(x))].slice(0, SEEN_MAX);
  await setSetting('news_seen', JSON.stringify(next));
}

function parseBrief(text) {
  const raw = String(text || '');
  const hIdx = raw.search(/===\s*HEADLINES\s*===/i);
  const mIdx = raw.search(/===\s*MARKETIMPACT\s*===/i);
  const cut = [hIdx, mIdx].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const brief = (cut >= 0 ? raw.slice(0, cut) : raw).trim();
  const headSec = hIdx >= 0 ? raw.slice(hIdx + raw.slice(hIdx).indexOf('\n') + 1, mIdx >= 0 && mIdx > hIdx ? mIdx : undefined) : '';
  const impactSec = mIdx >= 0 ? raw.slice(mIdx + raw.slice(mIdx).indexOf('\n') + 1) : '';
  const headlines = headSec.split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => { const m = l.match(/^(TOP|DMV|MONEY)\s*\|\s*(.+)$/i); return m ? { tag: m[1].toUpperCase(), text: m[2].trim() } : null; })
    .filter(Boolean);
  const impacts = impactSec.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const p = l.split('|').map((x) => x.trim());
    if (p.length < 4) return null;
    const side = /^(buy|long)$/i.test(p[1]) ? 'buy' : /^(sell|short)$/i.test(p[1]) ? 'sell' : null;
    if (!side) return null;
    return { symbol: p[0].toUpperCase().replace(/[^A-Z0-9.]/g, ''), side, horizon: p[2], confidence: (p[3] || '').toLowerCase(), thesis: (p[4] || p[3] || '').trim() };
  }).filter((x) => x && x.symbol);
  return { brief, headlines, impacts };
}

// --- Tier 2: full brief ---
async function refreshNewsBrief({ force = false, trigger = 'break' } = {}) {
  if (busy && !force) return { skipped: 'busy' };
  if ((await getSetting('news_wire', '1')) !== '1' && !force) return { skipped: 'off' };
  busy = true;
  try {
    const seen = await loadSeen();
    let world = '', dmv = '', extra = '';
    try { world = await webResearch('Top U.S. and world news right now — the biggest stories from apnews.com and ground.news: what happened, the key numbers, and how the coverage differs. List each with its source.'); }
    catch (e) { console.error('newswire: search failed', e.message); return { error: e.message }; }
    try { dmv = await webResearch('Top D.C., Maryland and Virginia (DMV) local news today from fox5dc.com — what happened and where.'); } catch {}
    if (trigger === 'poll') {
      try { extra = await webResearch(`The single biggest developing story in the last few hours not already covered here: ${seen.slice(0, 12).join('; ')}. What just happened and what it means for markets.`); } catch {}
    }

    const user =
`RAW WIRES — write Mr. Burrus's brief from these. Name sources. Do not invent anything not below.

U.S. / WORLD (AP + Ground News):
${String(world).slice(0, 6000)}

DMV (Fox 5 DC):
${String(dmv || '(nothing pulled)').slice(0, 2500)}
${extra ? `\nDEVELOPING:\n${String(extra).slice(0, 2500)}\n` : ''}
Already reported earlier (do not re-lead with these, only note real developments): ${seen.slice(0, 15).join(' | ') || '(nothing yet)'}

FORMAT — exactly these sections, in order, tight:
TOP — U.S. + world, what happened and the numbers
DMV — local
MARKETS & MONEY — what moved and why
MARKET IMPACT — for each instrument the desk trades that a story is moving or about to move: the call
OPPORTUNITIES — a concrete way to profit

Then two machine trailers, exactly:
===HEADLINES===
TOP|<one line>
TOP|<one line>
DMV|<one line>
MONEY|<one line>
===MARKETIMPACT===
<SYMBOL>|<buy or sell>|<time horizon>|<high|med|low>|<one-line thesis>
(only instruments the account trades — XAUUSD XAGUSD EURUSD GBPUSD USDJPY GBPJPY AUDUSD BTCUSD indices crude; leave the section empty if nothing qualifies; mark 'high' ONLY when you would put money on it)`;

    let out = '';
    try { out = await chatAs('anthropic', null, 'You are W.I.R.E., the Empire\'s news desk — tight, factual, sourced.', [{ role: 'user', content: user }], { maxTokens: 1900 }); }
    catch (e) { console.error('newswire: brief write failed', e.message); return { error: e.message }; }

    const { brief, headlines, impacts } = parseBrief(out);
    if (!brief) return { error: 'empty brief' };

    const slotLabel = trigger === 'manual' ? 'manual' : 'break';
    // Merge into the HUD row, never replace it — it also carries the routine,
    // Batman Protocol and score that every persona's context reads.
    const hudNow = (await syncedRow('hud_state', 'singleton')) || {};
    await upsertSyncRow('hud_state', 'singleton', {
      ...hudNow,
      news_brief: brief, news_headlines: JSON.stringify(headlines), news_slot: slotLabel, news_updated_at: Date.now(),
    });
    await saveMemory('wire', `[news brief · ${slotLabel}] ${brief.slice(0, 4000)}`);
    await rememberHeadlines(headlines.map((h) => h.text));
    await setSetting('news_last_poll', String(Date.now()));

    const lead = headlines[0]?.text || brief.split('\n').find(Boolean) || 'brief updated';
    console.log('newswire: brief in —', lead.slice(0, 120));
    // Every brief W.I.R.E. writes reaches him on Telegram from A.R.A. (and goes
    // into her Telegram history, so he can reply about it).
    araNote(`📰 **W.I.R.E. — ${trigger === 'manual' ? 'news brief' : 'breaking news'}**, Mr. Burrus.\n\n${brief}`);
    if (trigger !== 'manual') {
      await pushAlert(`newswire:${todayET()}-${pollSlot()}`, 'W.I.R.E. — news brief', lead.slice(0, 160), { kind: 'news' }).catch(() => {});
    }

    if (impacts.length) await newsTradeHandoff(impacts).catch((e) => console.error('newswire: hand-off failed', e.message));
    return { ok: true, headlines: headlines.length, impacts: impacts.length };
  } catch (e) {
    console.error('newswire: brief crashed', e.message);
    return { error: e.message };
  } finally {
    busy = false;
  }
}

// --- Tier 1: headline poll ---
async function pollHeadlines() {
  if (busy) return;
  if (!inPollWindow()) return;
  const stamp = pollSlot();
  if ((await getSetting('news_poll_hour', '')) === stamp) return;
  await setSetting('news_poll_hour', stamp);

  let scan = '';
  try { scan = await webResearch('Breaking U.S., world and market news in the last two hours — headlines from apnews.com and ground.news, with sources.'); }
  catch (e) { console.error('newswire: poll search failed', e.message); return; }
  if (!String(scan).trim()) return;

  const seen = await loadSeen();
  let verdict = { new: false };
  try {
    const j = await chatAs('anthropic', null, 'You are W.I.R.E., the Empire\'s news desk.', [{ role: 'user', content:
`Current headlines from the wires:\n${String(scan).slice(0, 4000)}\n\nYou have ALREADY reported these earlier:\n${seen.slice(0, 20).join(' | ') || '(nothing yet)'}\n\nIs there anything genuinely NEW and materially important since — a real development, not a rehash? Reply ONLY JSON:\n{"new": true|false, "headlines": ["short line", ...], "marketMove": true|false}` }], { maxTokens: 400 });
    const m = String(j).match(/\{[\s\S]*\}/);
    if (m) verdict = JSON.parse(m[0]);
  } catch { return; }

  await setSetting('news_last_poll', String(Date.now()));
  if (Array.isArray(verdict.headlines) && verdict.headlines.length) await rememberHeadlines(verdict.headlines);

  if (verdict.new) {
    console.log('newswire: something broke — pulling a full read');
    await refreshNewsBrief({ trigger: 'poll' });
  }
}

// --- News -> T.A.L.O.N. trade hand-off (demo account only) ---
async function newsTradeHandoff(impacts) {
  // T.A.L.O.N. only trades gold and Bitcoin, news calls included.
  const highs = impacts.filter((i) => /^high/.test(i.confidence) && SYMBOLS.includes(i.symbol));
  if (!highs.length) return;
  if ((await getSetting('news_wire_trades', '1')) !== '1') {
    console.log('newswire: high-confidence calls but news trades are off —', highs.map((i) => `${i.side} ${i.symbol}`).join(', '));
    return;
  }
  let st = tlStatus();
  if (!st.connected) { try { await tlConnect(); st = tlStatus(); } catch (e) { console.error('newswire->talon: cannot reach TradeLocker', e.message); return; } }
  if (st.env !== 'demo') { console.log('newswire->talon: LIVE account — news trades are demo-only, not placing'); return; }

  for (const imp of highs) {
    let snap;
    try { snap = await tlSnapshot(imp.symbol); } catch { console.log(`newswire->talon: no market data for ${imp.symbol}`); continue; }
    let lv;
    try { lv = await newsTradeLevels({ symbol: imp.symbol, side: imp.side, snapshot: tlFormatSnapshot(snap), thesis: imp.thesis }); }
    catch (e) { console.log(`newswire->talon: ${imp.symbol} levels call failed —`, e.message); continue; }
    if (!lv) { console.log(`newswire->talon: ${imp.symbol} — T.A.L.O.N. couldn't set levels`); continue; }
    const price = snap.quote?.mid ?? (imp.side === 'buy' ? snap.quote?.ask : snap.quote?.bid);
    const g = guardStop({ symbol: imp.symbol, side: imp.side, entry: price, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit, snap });
    if (g.skip) { console.log(`newswire->talon: ${imp.symbol} skipped — ${g.skip}`); continue; }
    if (g.widened) console.log(`newswire->talon: ${imp.symbol} ${g.note}`);
    lv = { ...lv, stopLoss: g.stopLoss, takeProfit: g.takeProfit };
    // Every news trade goes in ENTRY_COPIES times; one alert covers them all.
    const why = `news — ${imp.thesis}`.slice(0, 180);
    let r = null, copies = 0;
    for (let copy = 0; copy < ENTRY_COPIES; copy++) {
      try {
        const s = await tlPlaceOrder({ symbol: imp.symbol, side: imp.side, qty: MAX_QTY, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit });
        await recordTradeOpen({ symbol: imp.symbol, side: s.side, qty: s.qty, entry: price, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit,
          rationale: why, orderId: s.orderId, setup: 'news', auto: true, alert: false });
        r = r || s; copies++;
        console.log(`newswire->talon: ${s.side.toUpperCase()} ${s.qty} ${imp.symbol} @ ~${price ?? 'mkt'} · SL ${lv.stopLoss} TP ${lv.takeProfit} — ${imp.thesis.slice(0, 80)}`);
      } catch (e) {
        console.error(`newswire->talon: ${imp.symbol} order rejected —`, e.message);
        orderRejected({ symbol: imp.symbol, side: imp.side, error: e.message });
      }
    }
    if (!r) continue;
    tradeOpened({ symbol: imp.symbol, side: r.side, qty: r.qty, entry: price, stopLoss: lv.stopLoss, takeProfit: lv.takeProfit, rationale: why, setup: 'news', copies });
    const note = `[news trade] ${r.side} ${imp.symbol} ×${copies} @ ~${price ?? 'mkt'} on: ${imp.thesis}`;
    await saveMemory(TRADER_ID, note).catch(() => {});
    await saveMemory('wire', note).catch(() => {});
  }
}

// --- 8:30 AM data desk -> gold trade ---
// The U.S. economic releases (CPI, PPI, the jobs report, jobless claims, retail
// sales, GDP, PCE…) all drop at 8:30 AM ET, and gold reacts hard to the surprise
// vs. forecast. Weekdays at 8:32 / 8:36 / 8:42 / 8:50 ET (server/index.js) W.I.R.E.
// reads what came out; a clear surprise becomes a BUY/SELL hand-off to T.A.L.O.N.
// on XAUUSD through the same newsTradeHandoff as any other news call (demo only,
// `news_wire_trades` toggle respected). A.R.A. tells Mr. Burrus what the number
// was and what was done. Once a day (`wire_830_date`); "not out yet" retries on
// the next slot. ECON_DESK=off disables the cron.
async function runEconDesk() {
  if ((await getSetting('news_wire', '1')) !== '1') return { skipped: 'news wire off' };
  const today = todayET();
  if ((await getSetting('wire_830_date', '')) === today) return { skipped: 'already handled today' };
  const { claudeText, WEB_SEARCH_TOOL } = require('./llm');
  const dateLine = new Date().toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const out = await claudeText(
    `You are W.I.R.E., the news desk, reading the 8:30 AM ET U.S. economic data release for the gold trading desk. Search the live web for the reports released at 8:30 AM ET TODAY (CPI / core CPI, PPI, nonfarm payrolls + unemployment rate + wages, initial jobless claims, retail sales, GDP, PCE / core PCE, durable goods, and similar). Use only numbers actually published today, never last month's.
How gold reacts: a HOT surprise (inflation above forecast, payrolls/wages/growth/retail stronger than forecast, jobless claims lower than forecast) lifts the dollar and yields -> gold falls -> "sell". A SOFT surprise (the reverse) -> gold rises -> "buy". In line with forecast (CPI/PCE within 0.1 pt, payrolls within ~50k, claims within ~10k) or mixed signals with no clear lead -> "none". When several reports come out, the inflation and jobs numbers outrank the rest.
Reply with exactly ONE line, nothing else:
RELEASED | <report names> | <actual vs forecast, key numbers> | buy|sell|none | high|medium|low | <one-sentence reason>
or NOT_YET (today has an 8:30 release but the numbers aren't published yet), or NONE (no 8:30 release today).`,
    `Today is ${dateLine}. What came out at 8:30 AM ET today and what does it mean for gold?`,
    { maxTokens: 900, tools: WEB_SEARCH_TOOL },
  );
  const line = String(out || '').split('\n').map((l) => l.trim()).find((l) => /^(RELEASED|NOT_YET|NONE)\b/i.test(l)) || '';
  if (!line || /^NOT_YET/i.test(line)) return { pending: true };
  await setSetting('wire_830_date', today);
  if (/^NONE/i.test(line)) return { release: false };

  const [, reports = '', numbers = '', side = '', conviction = '', reason = ''] = line.split('|').map((x) => x.trim());
  const dir = side.toLowerCase();
  const trade = (dir === 'buy' || dir === 'sell') && /^(high|medium)/i.test(conviction);
  const thesis = `8:30 data — ${reports}: ${numbers}. ${reason}`.slice(0, 400);
  await saveMemory('wire', `[8:30 data] ${thesis} -> gold ${trade ? dir : 'no trade'}`);
  const { araNote } = require('./talonAlerts');
  araNote(`📊 **W.I.R.E. — 8:30 data**, Mr. Burrus: ${reports}\n${numbers}\n${reason}\n`
    + (trade ? `→ Gold **${dir.toUpperCase()}** — handed to T.A.L.O.N. to put through.` : `→ No gold trade (${dir === 'none' ? 'in line / mixed' : `${conviction || 'low'} conviction`}).`));
  if (trade) await newsTradeHandoff([{ symbol: 'XAUUSD', side: dir, confidence: 'high', thesis }]);
  return { release: true, side: dir, conviction, traded: trade };
}

// --- loop ---
async function tick() {
  if (busy) return;
  try {
    if ((await getSetting('news_wire', '1')) !== '1') return;
    await pollHeadlines();
  } catch (e) {
    console.error('newswire: tick crashed', e.message);
  }
}

module.exports = { tick, refreshNewsBrief, runEconDesk };
