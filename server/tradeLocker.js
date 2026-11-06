// TradeLocker REST client — server-side port of src/services/tradeLocker.js.
// The client version is a pure fetch-based REST client with no RN-specific
// code; the only change here is where credentials come from (the trade_creds
// table via routes/trade.js, instead of expo-secure-store). Session state
// (token, instrument cache, rate-limit backoff) lives in module scope exactly
// as it does on-device — except here the process is long-lived, so the
// session actually survives between cycles instead of resetting on every
// cold app open.
const { query } = require('./db');

const BASE = { demo: 'https://demo.tradelocker.com/backend-api', live: 'https://live.tradelocker.com/backend-api' };

// Column orders from GET /trade/config (accountDetailsConfig / positionsConfig).
const ACCOUNT_COLS = ['balance', 'projectedBalance', 'availableFunds', 'blockedBalance', 'cashBalance', 'unsettledCash', 'withdrawalAvailable', 'stocksValue', 'optionValue', 'initialMarginReq', 'maintMarginReq', 'marginWarningLevel', 'blockedForStocks', 'stockOrdersReq', 'stopOutLevel', 'warningMarginReq', 'marginBeforeWarning', 'todayGross', 'todayNet', 'todayFees', 'todayVolume', 'todayTradesCount', 'openGrossPnL', 'openNetPnL', 'positionsCount', 'ordersCount'];
const POSITION_COLS = ['id', 'tradableInstrumentId', 'routeId', 'side', 'qty', 'avgPrice', 'stopLossId', 'takeProfitId', 'openDate', 'unrealizedPl', 'strategyId'];

const RES_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1H': 3600e3, '4H': 14400e3, '1D': 86400e3, '1W': 604800e3 };

const MAX_QTY = 0.02; // hard lot cap — enforced on every order
const ENTRY_COPIES = 2; // every trade T.A.L.O.N. takes goes in this many times…
const COPIES_BY_SYMBOL = { XAUUSD: 1 }; // …except gold, which goes in once
const entryCopies = (sym) => COPIES_BY_SYMBOL[String(sym).toUpperCase()] ?? ENTRY_COPIES;

// The main stop rule's minimum, applied to every order except quick scalps and
// add-ons (his setups, W.I.R.E.'s news trades, anything else): the stop sits at least gold $10 /
// Bitcoin 0.8% (anything else 0.4%) and 1.2x the 1H ATR14 from entry.
const STOP_FLOOR = { XAUUSD: () => 10, BTCUSD: (px) => px * 0.008 };
const minStopDist = (symbol, px, atr1h = 0) => Math.max((STOP_FLOOR[String(symbol).toUpperCase()] || ((p) => p * 0.004))(Number(px)), 1.2 * (Number(atr1h) || 0));
async function tlAtr1H(symbol) { return summarizeBars(await tlHistory(String(symbol).toUpperCase(), '1H', 60))?.atr14 || 0; }

const session = { token: null, refresh: null, exp: 0, env: 'demo', accountId: null, accNum: null, instruments: {}, instrumentList: null, rateLimitedUntil: 0 };

function base() { return BASE[session.env] || BASE.demo; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Row 1 is the login the app last pushed; rows 2 (demo) and 3 (live) keep one
// of each so T.A.L.O.N. can be switched between them from Telegram
// ([TRADE_ACCOUNT], server/talonCommands.js) — the `talon_account` setting
// says which. No choice made, or that slot empty -> row 1, as before.
async function loadTradeCreds() {
  const want = String(await require('./syncStore').getSetting('talon_account', '').catch(() => '')).toLowerCase();
  const slot = want === 'live' ? 3 : want === 'demo' ? 2 : 1;
  const { rows } = await query('SELECT id, email, password, server, env FROM trade_creds WHERE id = ANY($1) ORDER BY id = $2 DESC, id', [[1, slot], slot]);
  return rows[0] || null;
}

// Which account the saved choice points at right now ('live', 'demo', or null).
async function tlActiveEnv() {
  const c = await loadTradeCreds();
  return c ? (c.env === 'live' ? 'live' : 'demo') : null;
}

// The session outlives a setting change that came through the app's sync, so
// check the choice against the session before relying on it.
async function tlFollowAccount() {
  const env = await tlActiveEnv();
  if (!env || !session.accountId || env === session.env) return;
  await require('./tradeJournal').parkOpenTrades(session.env);
  tlReset();
}

// A single hung socket serializes behind everything else on the one request
// chain (see `api`) — cap every request so a dropped connection can't wedge
// the whole cycle.
const FETCH_TIMEOUT_MS = 20000;
async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`TradeLocker request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Short-TTL cache for market reads (quotes, candles) — a full analysis scan
// asks for the same context quotes repeatedly.
const mdCache = {};
async function cachedRead(key, ttlMs, fn) {
  const hit = mdCache[key];
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  mdCache[key] = { t: Date.now(), v };
  return v;
}

async function authenticate() {
  const creds = await loadTradeCreds();
  if (!creds?.email || !creds?.password || !creds?.server) throw new Error('TradeLocker not connected on the server. Reconnect in the app — Settings › TRADELOCKER.');
  session.env = creds.env === 'live' ? 'live' : 'demo';
  const res = await fetchWithTimeout(base() + '/auth/jwt/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: creds.email, password: creds.password, server: creds.server }) });
  if (!res.ok) throw new Error('TradeLocker login failed: ' + (await res.text()).slice(0, 120));
  const d = await res.json();
  session.token = d.accessToken; session.refresh = d.refreshToken;
  session.exp = d.expireDate ? Date.parse(d.expireDate) : Date.now() + 55 * 60e3;
}

async function refreshToken() {
  if (!session.refresh) return authenticate();
  const res = await fetchWithTimeout(base() + '/auth/jwt/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: session.refresh }) });
  if (!res.ok) return authenticate();
  const d = await res.json();
  session.token = d.accessToken; session.refresh = d.refreshToken || session.refresh;
  session.exp = d.expireDate ? Date.parse(d.expireDate) : Date.now() + 55 * 60e3;
}

async function token() {
  if (!session.token) await authenticate();
  else if (Date.now() > session.exp - 60e3) await refreshToken();
  return session.token;
}

function qs(query) {
  if (!query) return '';
  const parts = Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v));
  return parts.length ? '?' + parts.join('&') : '';
}

// Cloudflare error 1015 = rate limited — HTTP 429, or a 403/503 challenge page.
function looksRateLimited(status, text) {
  return status === 429
    || ((status === 403 || status === 503) && /\b1015\b|rate.?limit|too many request|just a moment|attention required/i.test(text || ''));
}

let apiChain = Promise.resolve();
let lastCallAt = 0;
const MIN_GAP_MS = 170; // ~6 req/s ceiling — keeps bursts under Cloudflare's limit

async function rawApi(path, { method = 'GET', body, query } = {}) {
  const t = await token();
  const headers = { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' };
  if (session.accNum != null) headers.accNum = String(session.accNum);
  for (let attempt = 0; ; attempt++) {
    const res = await fetchWithTimeout(base() + path + qs(query), { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (looksRateLimited(res.status, text)) {
      session.rateLimitedUntil = Date.now() + 10000;
      if (attempt >= 3) throw new Error(`TradeLocker rate-limited (Cloudflare 1015) on ${method} ${path}`);
      const ra = Number(res.headers?.get?.('retry-after')) * 1000;
      await sleep(ra > 0 ? Math.min(ra, 15000) : 800 * Math.pow(2, attempt));
      continue;
    }
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok || json.s === 'error') throw new Error(`TradeLocker ${method} ${path}: ${(json.errmsg || text || res.status).toString().slice(0, 140)}`);
    return json;
  }
}

// Every call goes through one chain with a minimum gap between requests.
function api(path, opts) {
  const run = apiChain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    return rawApi(path, opts);
  });
  apiChain = run.then(() => {}, () => {}); // never let a rejection break the chain
  return run;
}

// --- Public surface ---

async function tlConnect() {
  await authenticate();
  const res = await fetchWithTimeout(base() + '/auth/jwt/all-accounts', { headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error('TradeLocker: could not list accounts');
  const { accounts = [] } = await res.json();
  if (!accounts.length) throw new Error('TradeLocker: no accounts on this login');
  const a = accounts[0];
  session.accountId = a.id; session.accNum = a.accNum;
  return { accountId: a.id, accNum: a.accNum, name: a.name, currency: a.currency, balance: a.accountBalance ?? a.aaccountBalance, status: a.status, env: session.env };
}

function tlStatus() {
  return { connected: !!session.accountId, env: session.env, accountId: session.accountId, rateLimited: Date.now() < session.rateLimitedUntil };
}

async function ensureAccount() { if (!session.accountId) await tlConnect(); }

async function tlAccountState() {
  await ensureAccount();
  return cachedRead('state', 2500, async () => {
    const j = await api(`/trade/accounts/${session.accountId}/state`);
    const arr = j.d?.accountDetailsData || [];
    const out = {}; ACCOUNT_COLS.forEach((c, i) => { out[c] = arr[i]; });
    return out;
  });
}

async function loadInstrumentList() {
  await ensureAccount();
  if (session.instrumentList) return session.instrumentList;
  const j = await api(`/trade/accounts/${session.accountId}/instruments`);
  session.instrumentList = j.d?.instruments || [];
  return session.instrumentList;
}

async function tlListInstruments() {
  const list = await loadInstrumentList();
  return list.map((x) => String(x.name)).filter(Boolean).sort();
}

async function tlInstrumentsById() {
  const list = await loadInstrumentList();
  const out = {};
  for (const x of list) out[String(x.tradableInstrumentId)] = String(x.name);
  return out;
}

async function tlInstrument(symbol = 'XAUUSD') {
  await ensureAccount();
  if (session.instruments[symbol]) return session.instruments[symbol];
  const list = await loadInstrumentList();
  const want = symbol.toUpperCase();
  const inst = list.find((x) => String(x.name).toUpperCase() === want)
    || list.find((x) => String(x.name).toUpperCase().replace(/[^A-Z0-9]/g, '') === want.replace(/[^A-Z0-9]/g, ''));
  if (!inst) {
    const sample = list.map((x) => x.name).slice(0, 40).join(', ');
    throw new Error(`TradeLocker: instrument ${symbol} not found on this account. Available include: ${sample}`);
  }
  const routes = inst.routes || [];
  const trade = routes.find((r) => r.type === 'TRADE');
  const info = routes.find((r) => r.type === 'INFO');
  const meta = { id: inst.tradableInstrumentId, name: inst.name, tradeRouteId: trade?.id, infoRouteId: info?.id, precision: inst.quantityPrecision ?? inst.pricePrecision ?? 2, pricePrecision: Number.isInteger(inst.pricePrecision) ? inst.pricePrecision : 2 };
  session.instruments[symbol] = meta;
  return meta;
}

async function tlQuote(symbol = 'XAUUSD') {
  return cachedRead('q:' + symbol.toUpperCase(), 7000, async () => {
    const m = await tlInstrument(symbol);
    const j = await api('/trade/quotes', { query: { routeId: m.infoRouteId, tradableInstrumentId: m.id } });
    const d = j.d || {};
    return { symbol, bid: d.bp, ask: d.ap, mid: d.bp != null && d.ap != null ? (d.bp + d.ap) / 2 : null, ts: Date.now() };
  });
}

async function tlHistory(symbol = 'XAUUSD', resolution = '1H', bars = 120) {
  return cachedRead(`h:${symbol.toUpperCase()}:${resolution}:${bars}`, 20000, async () => {
    const m = await tlInstrument(symbol);
    const step = RES_MS[resolution] || RES_MS['1H'];
    const to = Date.now();
    const from = to - step * Math.min(bars, 20000);
    const j = await api('/trade/history', { query: { routeId: m.infoRouteId, tradableInstrumentId: m.id, resolution, from, to } });
    return (j.d?.barDetails || []).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  });
}

async function tlPositions() {
  await ensureAccount();
  return cachedRead('positions', 2500, async () => {
    const j = await api(`/trade/accounts/${session.accountId}/positions`);
    return (j.d?.positions || []).map((row) => {
      const o = {}; POSITION_COLS.forEach((c, i) => { o[c] = row[i]; });
      return o;
    });
  });
}

function tlBustPositions() { delete mdCache['positions']; delete mdCache['state']; }

const HISTORY_COLS_FALLBACK = ['id', 'tradableInstrumentId', 'routeId', 'type', 'side', 'status', 'qty', 'filledQty', 'avgPrice', 'price', 'stopPrice', 'validity', 'expireDate', 'position', 'stopLoss', 'stopLossType', 'takeProfit', 'takeProfitType', 'strategyId', 'createdDate', 'lastModified', 'isOpen', 'executionInfo', 'positionNetPl', 'positionGrossPl', 'commission', 'swap'];
let historyCols = null;
async function loadHistoryCols() {
  if (historyCols) return historyCols;
  try {
    const j = await api('/trade/config');
    const cfg = j.d?.ordersHistoryConfig;
    const arr = Array.isArray(cfg) ? cfg : (cfg?.columns || cfg?.fields);
    if (Array.isArray(arr) && arr.length) historyCols = arr.map((c) => String(c.id || c.key || c.name || c));
  } catch {}
  historyCols = historyCols || HISTORY_COLS_FALLBACK;
  return historyCols;
}

async function tlOrdersHistory() {
  await ensureAccount();
  const j = await api(`/trade/accounts/${session.accountId}/ordersHistory`);
  const cols = await loadHistoryCols();
  const rows = j.d?.ordersHistory || j.d?.orders || j.d || [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (!Array.isArray(row)) return row; // already an object on some brokers
    const o = {}; cols.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

// Stop/target prices go out on the instrument's own price precision — an
// off-tick level (an AI's 3985.375) can get the stop dropped while the market
// order still fills.
const roundPx = (m, v) => +Number(v).toFixed(m?.pricePrecision ?? 2);

async function tlPlaceOrder({ symbol = 'XAUUSD', side, qty = MAX_QTY, stopLoss, takeProfit, minStop = true }) {
  await tlFollowAccount();
  await ensureAccount();
  // The last gate before real money, for every path into here. If the setting
  // can't be read this throws too, so no order goes out on a guess.
  if (session.env === 'live' && String(await require('./syncStore').getSetting('talon_live', '0')) !== '1') {
    throw new Error('this is the LIVE account and live trading isn\'t armed, so no order was placed');
  }
  if (side !== 'buy' && side !== 'sell') throw new Error('side must be buy or sell');
  const q = Math.min(Math.max(Number(qty) || 0, 0), MAX_QTY);
  if (!q) throw new Error('qty must be > 0');
  // Never a trade without a stop — same refusal as the app's tlPlaceOrder.
  if (stopLoss == null || !isFinite(Number(stopLoss))) throw new Error('no stop loss given — every trade needs one');
  const m = await tlInstrument(symbol);
  const body = { tradableInstrumentId: m.id, routeId: m.tradeRouteId, side, qty: q, type: 'market', validity: 'IOC', price: 0 };
  // Backstop for the main stop rule: a stop closer than the minimum (or on the
  // wrong side) is pushed out to it. Quick scalps and add-ons run their own
  // tighter stops and pass minStop: false.
  let widenedFrom = null;
  if (minStop && stopLoss != null && isFinite(Number(stopLoss))) {
    const qt = await tlQuote(symbol).catch(() => null);
    const entry = Number(qt?.mid ?? (side === 'buy' ? qt?.ask : qt?.bid));
    if (isFinite(entry) && entry) {
      const min = minStopDist(symbol, entry, await tlAtr1H(symbol).catch(() => 0));
      const dir = side === 'buy' ? 1 : -1;
      if ((entry - Number(stopLoss)) * dir < min - 1e-9) { widenedFrom = Number(stopLoss); stopLoss = entry - dir * min; }
      // Backstop for the danger zone too, for orders that skipped guardStop (his
      // own orders). It can't skip a trade, so past the ceiling it leaves the stop.
      try {
        const bars = await tlHistory(symbol, '1H', 120);
        const s = summarizeBars(bars.slice(-60));
        const z = zoneStop({ symbol, side, entry, sma20: s?.sma20, atr: s?.atr14, swings: analyzeStructure(closedBars(bars, '1H'))?.swings });
        if (z && !z.tooWide && (Number(stopLoss) - z.stop) * dir > 1e-9) { widenedFrom = widenedFrom ?? Number(stopLoss); stopLoss = z.stop; }
      } catch (e) { console.error(`tradelocker: ${symbol} zone check failed —`, e.message); }
    }
  }
  if (stopLoss != null && isFinite(Number(stopLoss))) { stopLoss = roundPx(m, stopLoss); body.stopLoss = stopLoss; body.stopLossType = 'absolute'; }
  if (takeProfit != null && isFinite(Number(takeProfit))) { takeProfit = roundPx(m, takeProfit); body.takeProfit = takeProfit; body.takeProfitType = 'absolute'; }
  const j = await api(`/trade/accounts/${session.accountId}/orders`, { method: 'POST', body });
  tlBustPositions();
  if (widenedFrom != null) console.log(`tradelocker: ${symbol} ${side} stop ${widenedFrom} widened to ${stopLoss} (main stop rule)`);
  return { orderId: j.d?.orderId, qty: q, side, symbol, stopLoss, takeProfit, widenedFrom };
}

async function tlClosePosition(positionId, qty = 0) {
  await ensureAccount();
  await api(`/trade/positions/${positionId}`, { method: 'DELETE', body: { qty: Number(qty) || 0 } });
  tlBustPositions();
  return { closed: positionId };
}

async function tlModifyPosition(positionId, { stopLoss, takeProfit, symbol } = {}) {
  await ensureAccount();
  const m = symbol ? await tlInstrument(symbol).catch(() => null) : null;
  const body = {};
  if (stopLoss !== undefined) {
    body.stopLoss = stopLoss === null ? null : roundPx(m, stopLoss);
    if (stopLoss !== null) body.stopLossType = 'absolute';
  }
  if (takeProfit !== undefined) {
    body.takeProfit = takeProfit === null ? null : roundPx(m, takeProfit);
    if (takeProfit !== null) body.takeProfitType = 'absolute';
  }
  await api(`/trade/positions/${positionId}`, { method: 'PATCH', body });
  tlBustPositions();
  return { modified: positionId };
}

function tlReset() {
  session.token = null; session.refresh = null; session.exp = 0; session.accountId = null; session.accNum = null;
  session.instruments = {}; session.instrumentList = null; session.rateLimitedUntil = 0;
  for (const k in mdCache) delete mdCache[k];
}

// --- Analysis snapshot: everything T.A.L.O.N. needs to form a view on a pair ---

const { closedBars, analyzeStructure, keyLevels, formatMarketRead, zoneStop } = require('./marketStructure');

const CONTEXT_SYMBOLS = ['DXY', 'EURUSD', 'USDJPY', 'XAUUSD'];

function summarizeBars(bars) {
  if (!bars || bars.length < 3) return null;
  const c = bars.map((b) => b.c);
  const last = c[c.length - 1], first = c[0];
  const smaN = Math.min(20, c.length);
  const sma = c.slice(-smaN).reduce((a, x) => a + x, 0) / smaN;
  const hi = Math.max(...bars.map((b) => b.h)), lo = Math.min(...bars.map((b) => b.l));
  const px = (n) => +n.toFixed(2);
  // ATR14 — the bar's normal swing, so stops sit past the noise, not inside it.
  const tr = bars.slice(1).map((b, i) => Math.max(b.h - b.l, Math.abs(b.h - bars[i].c), Math.abs(b.l - bars[i].c)));
  const atrN = tr.slice(-14);
  const atr = atrN.reduce((a, x) => a + x, 0) / atrN.length;
  return {
    last: px(last), changePct: +(((last - first) / first) * 100).toFixed(2),
    sma20: px(sma), trend: last > sma ? 'up' : 'down', atr14: px(atr),
    rangeHigh: px(hi), rangeLow: px(lo),
    recent: bars.slice(-6).map((b) => ({ o: px(b.o), h: px(b.h), l: px(b.l), c: px(b.c) })),
  };
}

async function tlSnapshot(symbol = 'XAUUSD') {
  const sym = symbol.toUpperCase();
  const [quote, state, positions] = await Promise.all([
    tlQuote(sym),
    tlAccountState().catch(() => null),
    tlPositions().catch(() => []),
  ]);
  const candles = {};
  const closed = {};
  for (const tf of ['1D', '4H', '1H', '15m']) {
    try {
      // The structure read needs more history than the summary's 60 bars; 15m
      // gets two full days so every session's high and low is in view.
      const bars = await tlHistory(sym, tf, tf === '15m' ? 192 : 120);
      candles[tf] = summarizeBars(bars.slice(-60));
      closed[tf] = closedBars(bars, tf);
    } catch { candles[tf] = null; }
  }
  // Never let the chart read cost him a scan.
  let structure = null, levels = null;
  try {
    const price = Number(quote?.mid);
    structure = {};
    for (const tf of ['4H', '1H', '15m']) if (closed[tf]) structure[tf] = analyzeStructure(closed[tf]);
    levels = keyLevels({ symbol: sym, daily: closed['1D'] || [], m15: closed['15m'] || [], price });
  } catch (e) { console.error(`tradelocker: structure read failed for ${sym} —`, e.message); structure = null; }
  const context = {};
  const isCrypto = /BTC|ETH|SOL|XRP|DOGE|USDT|USDC/.test(sym);
  if (!isCrypto) {
    for (const s of CONTEXT_SYMBOLS) {
      if (s === sym) continue;
      try { const q = await tlQuote(s); if (q.mid != null) context[s] = +q.mid.toFixed(5); } catch {}
    }
  }
  return { symbol: sym, quote, state, positions, candles, structure, levels, context, ts: Date.now() };
}

function tlFormatSnapshot(snap) {
  if (!snap) return '(market snapshot unavailable)';
  const { quote, state, positions, candles, context } = snap;
  const L = [];
  L.push(`Price ${snap.symbol}: bid ${quote.bid} / ask ${quote.ask} (mid ${quote.mid?.toFixed?.(2)})`);
  if (state) L.push(`Account: balance ${state.balance}, available ${state.availableFunds}, open P/L ${state.openNetPnL}, open positions ${state.positionsCount}`);
  for (const tf of Object.keys(candles)) {
    const c = candles[tf]; if (!c) { L.push(`${tf}: no data`); continue; }
    L.push(`${tf}: last ${c.last}, ${c.changePct >= 0 ? '+' : ''}${c.changePct}% over window, trend ${c.trend} (SMA20 ${c.sma20}), ATR14 ${c.atr14}, range ${c.rangeLow}–${c.rangeHigh}; recent bars ${c.recent.map((b) => `${b.o}/${b.h}/${b.l}/${b.c}`).join('  ')}`);
  }
  const read = formatMarketRead({ structure: snap.structure, levels: snap.levels, price: Number(quote.mid) });
  if (read) L.push(read);
  if (context && Object.keys(context).length) L.push(`Cross-market: ${Object.entries(context).map(([k, v]) => `${k} ${v}`).join(', ')} (read dollar direction / risk tone from these)`);
  if (positions?.length) L.push(`Open positions (all pairs): ${positions.map((p) => `#${p.id} ${p.side} ${p.qty} @ ${p.avgPrice} (uP/L ${p.unrealizedPl})`).join('; ')}`);
  return L.join('\n');
}

module.exports = {
  MAX_QTY, ENTRY_COPIES, entryCopies, minStopDist, tlAtr1H,
  tlConnect, tlStatus, tlAccountState, tlListInstruments, tlInstrumentsById, tlInstrument,
  tlQuote, tlHistory, tlPositions, tlOrdersHistory, tlPlaceOrder, tlClosePosition, tlModifyPosition,
  tlReset, tlActiveEnv, tlFollowAccount, tlSnapshot, tlFormatSnapshot, summarizeBars,
};
