// TradeLocker REST client — public API (public-api.tradelocker.com).
// Assisted trading only: everything here runs while the app is open. No backend,
// so no background monitoring, no overnight stop management.
//
// Auth: POST /auth/jwt/token { email, password, server } -> { accessToken,
// refreshToken, expireDate }. All /trade/* calls need Authorization: Bearer +
// an `accNum` header. Account state / positions come back as bare arrays whose
// column order is fixed by /trade/config (hardcoded below from the docs).
import{loadTradeCreds}from './keyStore';

const BASE={demo:'https://demo.tradelocker.com/backend-api',live:'https://live.tradelocker.com/backend-api'};

// Column orders from GET /trade/config (accountDetailsConfig / positionsConfig).
const ACCOUNT_COLS=['balance','projectedBalance','availableFunds','blockedBalance','cashBalance','unsettledCash','withdrawalAvailable','stocksValue','optionValue','initialMarginReq','maintMarginReq','marginWarningLevel','blockedForStocks','stockOrdersReq','stopOutLevel','warningMarginReq','marginBeforeWarning','todayGross','todayNet','todayFees','todayVolume','todayTradesCount','openGrossPnL','openNetPnL','positionsCount','ordersCount'];
const POSITION_COLS=['id','tradableInstrumentId','routeId','side','qty','avgPrice','stopLossId','takeProfitId','openDate','unrealizedPl','strategyId'];

const RES_MS={'1m':60e3,'5m':300e3,'15m':900e3,'30m':1800e3,'1H':3600e3,'4H':14400e3,'1D':86400e3,'1W':604800e3};

export const MAX_QTY=0.01; // hard lot cap — user-set, enforced on every order
export const MAX_OPEN_POSITIONS=5; // most positions Atlas may run at once

const session={token:null,refresh:null,exp:0,env:'demo',accountId:null,accNum:null,instruments:{},instrumentList:null,rateLimitedUntil:0};

function base(){return BASE[session.env]||BASE.demo;}

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

// Short-TTL cache for market reads (quotes, candles). A full analysis scan asks
// for the same context quotes over and over; without this a 4-symbol scan fires
// 40+ requests in a couple of seconds and Cloudflare answers with 1015.
const mdCache={};
async function cachedRead(key,ttlMs,fn){
  const hit=mdCache[key];
  if(hit&&Date.now()-hit.t<ttlMs)return hit.v;
  const v=await fn();
  mdCache[key]={t:Date.now(),v};
  return v;
}

async function authenticate(){
  const creds=await loadTradeCreds();
  if(!creds?.email||!creds?.password||!creds?.server)throw new Error('TradeLocker not connected. Add your login in Settings.');
  session.env=creds.env==='live'?'live':'demo';
  const res=await fetch(base()+'/auth/jwt/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:creds.email,password:creds.password,server:creds.server})});
  if(!res.ok)throw new Error('TradeLocker login failed: '+(await res.text()).slice(0,120));
  const d=await res.json();
  session.token=d.accessToken;session.refresh=d.refreshToken;
  session.exp=d.expireDate?Date.parse(d.expireDate):Date.now()+55*60e3;
}

async function refreshToken(){
  if(!session.refresh)return authenticate();
  const res=await fetch(base()+'/auth/jwt/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refreshToken:session.refresh})});
  if(!res.ok)return authenticate();
  const d=await res.json();
  session.token=d.accessToken;session.refresh=d.refreshToken||session.refresh;
  session.exp=d.expireDate?Date.parse(d.expireDate):Date.now()+55*60e3;
}

async function token(){
  if(!session.token)await authenticate();
  else if(Date.now()>session.exp-60e3)await refreshToken();
  return session.token;
}

function qs(query){
  if(!query)return '';
  const parts=Object.entries(query).filter(([,v])=>v!=null).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v));
  return parts.length?'?'+parts.join('&'):'';
}

// Cloudflare error 1015 = rate limited. It comes back as HTTP 429, or as a 403/
// 503 challenge page whose body mentions it.
function looksRateLimited(status,text){
  return status===429
    ||((status===403||status===503)&&/\b1015\b|rate.?limit|too many request|just a moment|attention required/i.test(text||''));
}

let apiChain=Promise.resolve();
let lastCallAt=0;
const MIN_GAP_MS=170;   // ~6 req/s ceiling — keeps bursts under Cloudflare's limit

async function rawApi(path,{method='GET',body,query}={}){
  const t=await token();
  const headers={'Authorization':'Bearer '+t,'Content-Type':'application/json'};
  if(session.accNum!=null)headers.accNum=String(session.accNum);
  for(let attempt=0;;attempt++){
    const res=await fetch(base()+path+qs(query),{method,headers,body:body?JSON.stringify(body):undefined});
    const text=await res.text();
    if(looksRateLimited(res.status,text)){
      session.rateLimitedUntil=Date.now()+10000;
      if(attempt>=3)throw new Error(`TradeLocker rate-limited (Cloudflare 1015) on ${method} ${path}`);
      const ra=Number(res.headers?.get?.('retry-after'))*1000;
      await sleep(ra>0?Math.min(ra,15000):800*Math.pow(2,attempt));
      continue;
    }
    let json;try{json=text?JSON.parse(text):{};}catch{json={raw:text};}
    if(!res.ok||json.s==='error')throw new Error(`TradeLocker ${method} ${path}: ${(json.errmsg||text||res.status).toString().slice(0,140)}`);
    return json;
  }
}

// Every call goes through one chain with a minimum gap between requests, so a
// scan that needs 40 reads spreads them over ~7s instead of hammering at once.
function api(path,opts){
  const run=apiChain.then(async()=>{
    const wait=MIN_GAP_MS-(Date.now()-lastCallAt);
    if(wait>0)await sleep(wait);
    lastCallAt=Date.now();
    return rawApi(path,opts);
  });
  apiChain=run.then(()=>{},()=>{});   // never let a rejection break the chain
  return run;
}

// --- Public surface ---

export async function tlConnect(){
  await authenticate();
  const res=await fetch(base()+'/auth/jwt/all-accounts',{headers:{'Authorization':'Bearer '+session.token,'Content-Type':'application/json'}});
  if(!res.ok)throw new Error('TradeLocker: could not list accounts');
  const{accounts=[]}=await res.json();
  if(!accounts.length)throw new Error('TradeLocker: no accounts on this login');
  const a=accounts[0];
  session.accountId=a.id;session.accNum=a.accNum;
  return{accountId:a.id,accNum:a.accNum,name:a.name,currency:a.currency,balance:a.accountBalance??a.aaccountBalance,status:a.status,env:session.env};
}

export function tlStatus(){
  return{
    connected:!!session.accountId,
    env:session.env,
    accountId:session.accountId,
    rateLimited:Date.now()<session.rateLimitedUntil,
  };
}

async function ensureAccount(){if(!session.accountId)await tlConnect();}

export async function tlAccountState(){
  await ensureAccount();
  return cachedRead('state',2500,async()=>{
    const j=await api(`/trade/accounts/${session.accountId}/state`);
    const arr=j.d?.accountDetailsData||[];
    const out={};ACCOUNT_COLS.forEach((c,i)=>{out[c]=arr[i];});
    return out;
  });
}

// The full tradable-instrument list for the account, cached per session.
async function loadInstrumentList(){
  await ensureAccount();
  if(session.instrumentList)return session.instrumentList;
  const j=await api(`/trade/accounts/${session.accountId}/instruments`);
  session.instrumentList=j.d?.instruments||[];
  return session.instrumentList;
}

// Every symbol name the account can trade (e.g. XAUUSD, EURUSD, GBPJPY, BTCUSD).
export async function tlListInstruments(){
  const list=await loadInstrumentList();
  return list.map(x=>String(x.name)).filter(Boolean).sort();
}

// { tradableInstrumentId -> symbol name } — used to label open positions.
export async function tlInstrumentsById(){
  const list=await loadInstrumentList();
  const out={};
  for(const x of list)out[String(x.tradableInstrumentId)]=String(x.name);
  return out;
}

// Resolve any symbol to its ids + routes, cached per session.
export async function tlInstrument(symbol='XAUUSD'){
  await ensureAccount();
  if(session.instruments[symbol])return session.instruments[symbol];
  const list=await loadInstrumentList();
  const want=symbol.toUpperCase();
  const inst=list.find(x=>String(x.name).toUpperCase()===want)
    ||list.find(x=>String(x.name).toUpperCase().replace(/[^A-Z0-9]/g,'')===want.replace(/[^A-Z0-9]/g,''));
  if(!inst){
    const sample=list.map(x=>x.name).slice(0,40).join(', ');
    throw new Error(`TradeLocker: instrument ${symbol} not found on this account. Available include: ${sample}`);
  }
  const routes=inst.routes||[];
  const trade=routes.find(r=>r.type==='TRADE');
  const info=routes.find(r=>r.type==='INFO');
  const meta={
    id:inst.tradableInstrumentId,name:inst.name,
    tradeRouteId:trade?.id,infoRouteId:info?.id,
    precision:inst.quantityPrecision??inst.pricePrecision??2,
  };
  session.instruments[symbol]=meta;
  return meta;
}

export async function tlQuote(symbol='XAUUSD'){
  return cachedRead('q:'+symbol.toUpperCase(),7000,async()=>{
    const m=await tlInstrument(symbol);
    const j=await api('/trade/quotes',{query:{routeId:m.infoRouteId,tradableInstrumentId:m.id}});
    const d=j.d||{};
    return{symbol,bid:d.bp,ask:d.ap,mid:d.bp!=null&&d.ap!=null?(d.bp+d.ap)/2:null,ts:Date.now()};
  });
}

export async function tlHistory(symbol='XAUUSD',resolution='1H',bars=120){
  return cachedRead(`h:${symbol.toUpperCase()}:${resolution}:${bars}`,20000,async()=>{
    const m=await tlInstrument(symbol);
    const step=RES_MS[resolution]||RES_MS['1H'];
    const to=Date.now();
    const from=to-step*Math.min(bars,20000);
    const j=await api('/trade/history',{query:{routeId:m.infoRouteId,tradableInstrumentId:m.id,resolution,from,to}});
    return(j.d?.barDetails||[]).map(b=>({t:b.t,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v}));
  });
}

export async function tlPositions(){
  await ensureAccount();
  return cachedRead('positions',2500,async()=>{
    const j=await api(`/trade/accounts/${session.accountId}/positions`);
    return(j.d?.positions||[]).map(row=>{
      const o={};POSITION_COLS.forEach((c,i)=>{o[c]=row[i];});
      return o;
    });
  });
}

// Drop the cached account/positions snapshot right after we change something,
// so the next read reflects the order we just sent.
export function tlBustPositions(){delete mdCache['positions'];delete mdCache['state'];}

// Column order for /ordersHistory rows. Pulled from /trade/config the first time
// (the shape varies by broker); the fallback below matches the public docs.
const HISTORY_COLS_FALLBACK=['id','tradableInstrumentId','routeId','type','side','status','qty','filledQty','avgPrice','price','stopPrice','validity','expireDate','position','stopLoss','stopLossType','takeProfit','takeProfitType','strategyId','createdDate','lastModified','isOpen','executionInfo','positionNetPl','positionGrossPl','commission','swap'];
let historyCols=null;
async function loadHistoryCols(){
  if(historyCols)return historyCols;
  try{
    const j=await api('/trade/config');
    const cfg=j.d?.ordersHistoryConfig;
    const arr=Array.isArray(cfg)?cfg:(cfg?.columns||cfg?.fields);
    if(Array.isArray(arr)&&arr.length)historyCols=arr.map(c=>String(c.id||c.key||c.name||c));
  }catch{}
  historyCols=historyCols||HISTORY_COLS_FALLBACK;
  return historyCols;
}

// Filled / closed order rows, newest-relevant first. Used by the trade journal to
// reconcile a position's realized P/L once it leaves the open-positions list.
export async function tlOrdersHistory(){
  await ensureAccount();
  const j=await api(`/trade/accounts/${session.accountId}/ordersHistory`);
  const cols=await loadHistoryCols();
  const rows=j.d?.ordersHistory||j.d?.orders||j.d||[];
  if(!Array.isArray(rows))return[];
  return rows.map(row=>{
    if(!Array.isArray(row))return row; // already an object on some brokers
    const o={};cols.forEach((c,i)=>{o[c]=row[i];});
    return o;
  });
}

// Market order with absolute SL/TP prices. qty is clamped to MAX_QTY.
export async function tlPlaceOrder({symbol='XAUUSD',side,qty=MAX_QTY,stopLoss,takeProfit}){
  await ensureAccount();
  if(side!=='buy'&&side!=='sell')throw new Error('side must be buy or sell');
  const q=Math.min(Math.max(Number(qty)||0,0),MAX_QTY);
  if(!q)throw new Error('qty must be > 0');
  const m=await tlInstrument(symbol);
  const body={
    tradableInstrumentId:m.id,routeId:m.tradeRouteId,
    side,qty:q,type:'market',validity:'IOC',price:0,
  };
  if(stopLoss!=null){body.stopLoss=Number(stopLoss);body.stopLossType='absolute';}
  if(takeProfit!=null){body.takeProfit=Number(takeProfit);body.takeProfitType='absolute';}
  const j=await api(`/trade/accounts/${session.accountId}/orders`,{method:'POST',body});
  tlBustPositions();
  return{orderId:j.d?.orderId,qty:q,side,symbol,stopLoss,takeProfit};
}

export async function tlClosePosition(positionId,qty=0){
  await ensureAccount();
  await api(`/trade/positions/${positionId}`,{method:'DELETE',body:{qty:Number(qty)||0}});
  tlBustPositions();
  return{closed:positionId};
}

export async function tlModifyPosition(positionId,{stopLoss,takeProfit}={}){
  await ensureAccount();
  const body={};
  if(stopLoss!==undefined)body.stopLoss=stopLoss===null?null:Number(stopLoss);
  if(takeProfit!==undefined)body.takeProfit=takeProfit===null?null:Number(takeProfit);
  await api(`/trade/positions/${positionId}`,{method:'PATCH',body});
  tlBustPositions();
  return{modified:positionId};
}

export function tlReset(){session.token=null;session.refresh=null;session.exp=0;session.accountId=null;session.accNum=null;session.instruments={};session.instrumentList=null;session.rateLimitedUntil=0;for(const k in mdCache)delete mdCache[k];}

// --- Analysis snapshot: everything Atlas needs to form a view on a pair ---

// Instruments to pull alongside the target for cross-market context (dollar
// direction, risk tone). Skipped for the target itself and for crypto.
const CONTEXT_SYMBOLS=['DXY','EURUSD','USDJPY','XAUUSD'];

function summarizeBars(bars){
  if(!bars||bars.length<3)return null;
  const c=bars.map(b=>b.c);
  const last=c[c.length-1],first=c[0];
  const smaN=Math.min(20,c.length);
  const sma=c.slice(-smaN).reduce((a,x)=>a+x,0)/smaN;
  const hi=Math.max(...bars.map(b=>b.h)),lo=Math.min(...bars.map(b=>b.l));
  const px=n=>+n.toFixed(2);
  return{
    last:px(last),changePct:+(((last-first)/first)*100).toFixed(2),
    sma20:px(sma),trend:last>sma?'up':'down',
    rangeHigh:px(hi),rangeLow:px(lo),
    recent:bars.slice(-6).map(b=>({o:px(b.o),h:px(b.h),l:px(b.l),c:px(b.c)})),
  };
}

export async function tlSnapshot(symbol='XAUUSD'){
  const sym=symbol.toUpperCase();
  const[quote,state,positions]=await Promise.all([
    tlQuote(sym),
    tlAccountState().catch(()=>null),
    tlPositions().catch(()=>[]),
  ]);
  const candles={};
  for(const tf of['1D','4H','1H','15m']){
    try{candles[tf]=summarizeBars(await tlHistory(sym,tf,60));}catch{candles[tf]=null;}
  }
  const context={};
  const isCrypto=/BTC|ETH|SOL|XRP|DOGE|USDT|USDC/.test(sym);
  if(!isCrypto){
    for(const s of CONTEXT_SYMBOLS){
      if(s===sym)continue;
      try{const q=await tlQuote(s);if(q.mid!=null)context[s]=+q.mid.toFixed(5);}catch{}
    }
  }
  return{symbol:sym,quote,state,positions,candles,context,ts:Date.now()};
}

export function tlFormatSnapshot(snap){
  if(!snap)return '(market snapshot unavailable)';
  const{quote,state,positions,candles,context}=snap;
  const L=[];
  L.push(`Price ${snap.symbol}: bid ${quote.bid} / ask ${quote.ask} (mid ${quote.mid?.toFixed?.(2)})`);
  if(state)L.push(`Account: balance ${state.balance}, available ${state.availableFunds}, open P/L ${state.openNetPnL}, open positions ${state.positionsCount}`);
  for(const tf of Object.keys(candles)){
    const c=candles[tf];if(!c){L.push(`${tf}: no data`);continue;}
    L.push(`${tf}: last ${c.last}, ${c.changePct>=0?'+':''}${c.changePct}% over window, trend ${c.trend} (SMA20 ${c.sma20}), range ${c.rangeLow}–${c.rangeHigh}; recent bars ${c.recent.map(b=>`${b.o}/${b.h}/${b.l}/${b.c}`).join('  ')}`);
  }
  if(context&&Object.keys(context).length)L.push(`Cross-market: ${Object.entries(context).map(([k,v])=>`${k} ${v}`).join(', ')} (read dollar direction / risk tone from these)`);
  if(positions?.length)L.push(`Open positions (all pairs): ${positions.map(p=>`#${p.id} ${p.side} ${p.qty} @ ${p.avgPrice} (uP/L ${p.unrealizedPl})`).join('; ')}`);
  return L.join('\n');
}
