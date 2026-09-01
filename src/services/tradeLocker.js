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

export const MAX_QTY=0.01; // hard lot cap — 0.01, enforced on every order

const session={token:null,refresh:null,exp:0,env:'demo',accountId:null,accNum:null,instruments:{},instrList:null};

// Connection health. `tlStatus().connected` is only "did an auth ever succeed
// this JS session" — it resets on every reload and never notices a token going
// stale or every call 1015'ing. `health` is the truthful picture the UI shows:
// when we last had a good call, when we last failed, and why.
const health={configured:null,lastOkAt:0,lastFailAt:0,lastError:null,connecting:false};
// Only a genuinely stale session (no good call in this long) plus a recent
// failure counts as OFFLINE — one flaky /trade/history mid-scan must not flip
// the indicator, since the snapshot already tolerates a degraded feed.
const STALE_MS=75e3;
function markOk(){health.lastOkAt=Date.now();health.lastError=null;}
function markFail(e,kind){
  health.lastFailAt=Date.now();
  health.lastError={message:String(e?.message||e).slice(0,180),rateLimited:!!e?.rateLimited,kind:kind||e?.kind||'feed'};
}

function base(){return BASE[session.env]||BASE.demo;}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// The public API sits behind Cloudflare, which rate-limits bursts with
// "error code: 1015" (served as HTTP 429). A single scan fires ~15 calls, so
// without a governor Cloudflare 1015s every one of them and the snapshot comes
// back completely blank.
const RATE_LIMIT_COOLDOWN_MS=60e3;
let rateLimitedUntil=0;

// True while a recent burst got 1015'd — callers show "throttled, not
// disconnected" without firing another round of doomed requests.
export function tlRateLimited(){return Date.now()<rateLimitedUntil;}

function isRateLimit(status,text){
  return status===429||status===503||/error code:? *1015|\brate[ -]?limit/i.test(String(text||''));
}
function rateLimitError(where){
  rateLimitedUntil=Date.now()+RATE_LIMIT_COOLDOWN_MS;
  return Object.assign(
    new Error(`TradeLocker is being rate-limited by Cloudflare (error 1015)${where?` on ${where}`:''}. This is NOT a login problem — wait ~60s and try again.`),
    {rateLimited:true},
  );
}

async function authenticate(){
  const creds=await loadTradeCreds();
  if(!creds?.email||!creds?.password||!creds?.server){
    health.configured=false;
    throw new Error('TradeLocker not connected. Add your login in Settings.');
  }
  health.configured=true;
  session.env=creds.env==='live'?'live':'demo';
  const res=await fetch(base()+'/auth/jwt/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:creds.email,password:creds.password,server:creds.server})});
  const bodyText=await res.text();
  if(isRateLimit(res.status,bodyText)){const e=rateLimitError('login');markFail(e,'ratelimit');throw e;}
  if(!res.ok){const e=new Error('TradeLocker login failed: '+bodyText.slice(0,120));markFail(e,'auth');throw e;}
  const d=JSON.parse(bodyText);
  session.token=d.accessToken;session.refresh=d.refreshToken;
  session.exp=d.expireDate?Date.parse(d.expireDate):Date.now()+55*60e3;
  markOk();
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

// Every request goes through one chain with a minimum gap between calls, and a
// 1015/429 is retried a few times with exponential backoff. This keeps a scan's
// burst under Cloudflare's threshold instead of tripping it and going blind.
const API_MIN_GAP_MS=200;
let apiGate=Promise.resolve();
let apiLast=0;

async function apiCall(path,method,body,query){
  const wait=API_MIN_GAP_MS-(Date.now()-apiLast);
  if(wait>0)await sleep(wait);
  apiLast=Date.now();
  const t=await token();
  const headers={'Authorization':'Bearer '+t,'Content-Type':'application/json'};
  if(session.accNum!=null)headers.accNum=String(session.accNum);
  const res=await fetch(base()+path+qs(query),{method,headers,body:body?JSON.stringify(body):undefined});
  const text=await res.text();
  return{res,text};
}

async function api(path,{method='GET',body,query}={}){
  const task=async()=>{
    // Still cooling down from a recent 1015 — fail fast instead of piling on.
    if(tlRateLimited())throw rateLimitError(`${method} ${path}`);
    for(let attempt=0;;attempt++){
      const{res,text}=await apiCall(path,method,body,query);
      if(isRateLimit(res.status,text)){
        if(attempt<2){await sleep(700*2**attempt+Math.random()*300);continue;}
        const e=rateLimitError(`${method} ${path}`); // also arms the cooldown
        markFail(e);throw e;
      }
      let json;try{json=text?JSON.parse(text):{};}catch{json={raw:text};}
      if(!res.ok||json.s==='error'){
        const e=new Error(`TradeLocker ${method} ${path}: ${(json.errmsg||text||res.status).toString().slice(0,140)}`);
        markFail(e);throw e;
      }
      markOk();
      return json;
    }
  };
  const run=apiGate.then(task,task);
  apiGate=run.then(()=>{},()=>{});
  return run;
}

// --- Public surface ---

export async function tlConnect(){
  await authenticate();
  const res=await fetch(base()+'/auth/jwt/all-accounts',{headers:{'Authorization':'Bearer '+session.token,'Content-Type':'application/json'}});
  const text=await res.text();
  if(isRateLimit(res.status,text)){const e=rateLimitError('account list');markFail(e,'ratelimit');throw e;}
  if(!res.ok){const e=new Error('TradeLocker: could not list accounts');markFail(e,'auth');throw e;}
  const{accounts=[]}=JSON.parse(text||'{}');
  if(!accounts.length){const e=new Error('TradeLocker: no accounts on this login');markFail(e,'auth');throw e;}
  const a=accounts[0];
  session.accountId=a.id;session.accNum=a.accNum;
  health.configured=true;markOk();
  return{accountId:a.id,accNum:a.accNum,name:a.name,currency:a.currency,balance:a.accountBalance??a.aaccountBalance,status:a.status,env:session.env};
}

export function tlStatus(){return{connected:!!session.accountId,env:session.env,accountId:session.accountId};}

// Call once at app start: learn whether a login is saved (so the status reads
// "no login" vs "connecting" correctly the instant the app opens) and quietly
// warm the session so a reload reconnects on its own instead of showing a false
// "not connected" until the next scan.
export async function tlInit(){
  try{
    const creds=await loadTradeCreds();
    health.configured=!!(creds?.email&&creds?.password&&creds?.server);
    if(health.configured){
      session.env=creds.env==='live'?'live':'demo';
      ensureAccount().catch(()=>{}); // errors are recorded in `health`
    }
  }catch{/* leave health.configured as-is */}
  return tlHealth();
}

// Truthful, synchronous connection status for the always-on UI indicator.
// state: 'unconfigured' | 'connecting' | 'live' | 'throttled' | 'down'
export function tlHealth(){
  const env=session.env;
  if(health.configured===false)
    return{state:'unconfigured',label:'NO LOGIN',env:null,accountId:null,
      detail:'No TradeLocker login saved. Add it in Settings › Trading.'};
  if(tlRateLimited())
    return{state:'throttled',label:'THROTTLED',env,accountId:session.accountId,
      retryInMs:Math.max(0,rateLimitedUntil-Date.now()),
      detail:'Broker feed is rate-limited (Cloudflare 1015). The login is fine — it clears in about a minute.'};
  const err=health.lastError;
  const failing=!!err&&health.lastFailAt>=health.lastOkAt;
  // A dead session: auth was rejected, or nothing has succeeded in a long time.
  // A lone failed data feed while other calls keep succeeding stays LIVE.
  const dead=failing&&(err.kind==='auth'||health.lastOkAt===0||Date.now()-health.lastOkAt>STALE_MS);
  if(session.accountId&&!dead)
    return{state:'live',label:'LIVE',env,accountId:session.accountId,lastOkAt:health.lastOkAt,
      detail:`Connected to ${env.toUpperCase()}${session.accountId?` · acct ${session.accountId}`:''}.${failing?' Last feed call errored; retrying.':''}`};
  if(dead&&health.connecting)
    return{state:'connecting',label:'RECONNECTING…',env,accountId:session.accountId,
      detail:`Retrying after: ${err.message}`};
  if(dead)
    return{state:'down',label:'OFFLINE',env,accountId:session.accountId,lastOkAt:health.lastOkAt,
      detail:err.message};
  if(health.connecting||health.configured)
    return{state:'connecting',label:'CONNECTING…',env,accountId:null,
      detail:'Establishing the TradeLocker session…'};
  return{state:'connecting',label:'CHECKING…',env,accountId:null,detail:'Checking the TradeLocker session…'};
}

// Active health probe used by the status indicator's slow tick: a cheap
// authenticated call that also re-auths / re-establishes the session if the
// token or the whole in-memory session went away. Never throws.
export async function tlPing(){
  try{
    if(health.configured==null)await tlInit();
    if(health.configured===false||tlRateLimited())return tlHealth();
    await tlAccountState();
  }catch(e){markFail(e);}
  return tlHealth();
}

// A scan calls tlQuote/tlAccountState/tlPositions in parallel and each would
// otherwise kick off its own login — three simultaneous auth round-trips is a
// fast way to get 1015'd. Collapse concurrent connects into one.
let connecting=null;
async function ensureAccount(){
  if(session.accountId)return;
  if(!connecting){
    health.connecting=true;
    connecting=tlConnect().finally(()=>{connecting=null;health.connecting=false;});
  }
  await connecting;
}

export async function tlAccountState(){
  await ensureAccount();
  const j=await api(`/trade/accounts/${session.accountId}/state`);
  const arr=j.d?.accountDetailsData||[];
  const out={};ACCOUNT_COLS.forEach((c,i)=>{out[c]=arr[i];});
  return out;
}

// Resolve XAUUSD (or any symbol) to its ids + routes, cached per session.
// Brokers label gold differently (XAUUSD, GOLD, XAU/USD, XAUUSD.r, …) so for
// gold we fall back to a fuzzy match instead of failing outright.
// The full instrument list is the same for every symbol — fetch it once per
// session so resolving EURUSD/USDJPY/GBPUSD for the USD proxy doesn't re-pull it.
async function instrumentList(){
  await ensureAccount();
  if(session.instrList)return session.instrList;
  const j=await api(`/trade/accounts/${session.accountId}/instruments`);
  session.instrList=j.d?.instruments||[];
  return session.instrList;
}

export async function tlInstrument(symbol='XAUUSD'){
  await ensureAccount();
  if(session.instruments[symbol])return session.instruments[symbol];
  const list=await instrumentList();
  const want=symbol.toUpperCase().replace(/[^A-Z]/g,'');
  const norm=x=>String(x.name||'').toUpperCase().replace(/[^A-Z]/g,'');
  let inst=list.find(x=>norm(x)===want);
  if(!inst&&want==='XAUUSD'){
    inst=list.find(x=>norm(x).startsWith('XAUUSD'))
       ||list.find(x=>norm(x).includes('XAU')&&norm(x).includes('USD'))
       ||list.find(x=>norm(x).startsWith('GOLD'));
  }
  if(!inst){
    const names=list.slice(0,20).map(x=>x.name).join(', ');
    throw new Error(`TradeLocker: no instrument matching ${symbol} on this account. Available: ${names||'(none)'}`);
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
  const m=await tlInstrument(symbol);
  const j=await api('/trade/quotes',{query:{routeId:m.infoRouteId,tradableInstrumentId:m.id}});
  const d=j.d||{};
  return{symbol,bid:d.bp,ask:d.ap,mid:d.bp!=null&&d.ap!=null?(d.bp+d.ap)/2:null,ts:Date.now()};
}

// Standalone ATR read for the pre-send trade check (cheaper than a full snapshot).
export async function tlVolatility(symbol='XAUUSD',resolution='15m',bars=20){
  const h=await tlHistory(symbol,resolution,bars);
  return{atr:atr(h,14),bars:h.length};
}

export async function tlHistory(symbol='XAUUSD',resolution='1H',bars=120){
  const m=await tlInstrument(symbol);
  const step=RES_MS[resolution]||RES_MS['1H'];
  const to=Date.now();
  const from=to-step*Math.min(bars,20000);
  const j=await api('/trade/history',{query:{routeId:m.infoRouteId,tradableInstrumentId:m.id,resolution,from,to}});
  return(j.d?.barDetails||[]).map(b=>({t:b.t,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v}));
}

export async function tlPositions(){
  await ensureAccount();
  const j=await api(`/trade/accounts/${session.accountId}/positions`);
  return(j.d?.positions||[]).map(row=>{
    const o={};POSITION_COLS.forEach((c,i)=>{o[c]=row[i];});
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
  return{orderId:j.d?.orderId,qty:q,side,symbol,stopLoss,takeProfit};
}

export async function tlClosePosition(positionId,qty=0){
  await ensureAccount();
  await api(`/trade/positions/${positionId}`,{method:'DELETE',body:{qty:Number(qty)||0}});
  return{closed:positionId};
}

export async function tlModifyPosition(positionId,{stopLoss,takeProfit}={}){
  await ensureAccount();
  const body={};
  if(stopLoss!==undefined)body.stopLoss=stopLoss===null?null:Number(stopLoss);
  if(takeProfit!==undefined)body.takeProfit=takeProfit===null?null:Number(takeProfit);
  await api(`/trade/positions/${positionId}`,{method:'PATCH',body});
  return{modified:positionId};
}

export function tlReset(){
  session.token=null;session.refresh=null;session.exp=0;session.accountId=null;session.accNum=null;session.instruments={};session.instrList=null;
  health.configured=false;health.lastOkAt=0;health.lastFailAt=0;health.lastError=null;health.connecting=false;
}

// --- Analysis snapshot: everything Atlas needs to form a view on gold ---

// Average True Range over the last `period` bars — the volatility figure Atlas
// needs to size a stop that survives normal noise on this timeframe.
function atr(bars,period=14){
  if(!bars||bars.length<2)return null;
  const trs=[];
  for(let i=1;i<bars.length;i++){
    const b=bars[i],p=bars[i-1];
    trs.push(Math.max(b.h-b.l,Math.abs(b.h-p.c),Math.abs(b.l-p.c)));
  }
  const n=Math.min(period,trs.length);
  if(!n)return null;
  return trs.slice(-n).reduce((a,x)=>a+x,0)/n;
}

function summarizeBars(bars){
  if(!bars||bars.length<3)return null;
  const c=bars.map(b=>b.c);
  const last=c[c.length-1],first=c[0];
  const smaN=Math.min(20,c.length);
  const sma=c.slice(-smaN).reduce((a,x)=>a+x,0)/smaN;
  const hi=Math.max(...bars.map(b=>b.h)),lo=Math.min(...bars.map(b=>b.l));
  const px=n=>+n.toFixed(2);
  const a=atr(bars,14);
  return{
    last:px(last),changePct:+(((last-first)/first)*100).toFixed(2),
    sma20:px(sma),trend:last>sma?'up':'down',
    rangeHigh:px(hi),rangeLow:px(lo),
    atr14:a!=null?px(a):null,
    recent:bars.slice(-6).map(b=>({o:px(b.o),h:px(b.h),l:px(b.l),c:px(b.c)})),
  };
}

export async function tlSnapshot(symbol='XAUUSD'){
  const errors=[];
  let rateLimited=false;
  const grab=async(label,fn,fallback)=>{
    try{return await fn();}
    catch(e){
      if(e?.rateLimited)rateLimited=true;
      errors.push(`${label}: ${String(e?.message||e).slice(0,120)}`);
      return fallback;
    }
  };
  const[quote,state,positions]=await Promise.all([
    grab('price',()=>tlQuote(symbol),null),
    grab('account',()=>tlAccountState(),null),
    grab('positions',()=>tlPositions(),[]),
  ]);
  const candles={};
  for(const tf of['1D','4H','1H','15m']){
    candles[tf]=await grab(`${tf} candles`,async()=>summarizeBars(await tlHistory(symbol,tf,60)),null);
  }
  // USD proxy with 24h % change so "is the dollar bid right now" is actually
  // derivable — a bare level tells the model nothing.
  const usd={};
  const usdContrib=[];
  // If we're already being throttled, don't pile on 9 more calls for the proxy.
  for(const s of(rateLimited?[]:['EURUSD','USDJPY','GBPUSD'])){
    try{
      const q=await tlQuote(s);
      let chg=null;
      try{
        const h=await tlHistory(s,'1H',24);
        if(h.length>=2)chg=+(((h[h.length-1].c-h[0].c)/h[0].c)*100).toFixed(2);
      }catch{}
      if(q.mid!=null)usd[s]={mid:+q.mid.toFixed(5),chgPct:chg};
      // USD gains when EUR/GBP fall and USDJPY rises.
      if(chg!=null)usdContrib.push(s==='USDJPY'?chg:-chg);
    }catch{}
  }
  const usdBias=usdContrib.length
    ?(()=>{const avg=usdContrib.reduce((a,x)=>a+x,0)/usdContrib.length;
      return{avgPct:+avg.toFixed(2),label:avg>0.1?'USD firm (gold headwind)':avg<-0.1?'USD soft (gold tailwind)':'USD flat'};})()
    :null;
  return{symbol,connected:tlStatus().connected,rateLimited,errors,quote,state,positions,candles,usd,usdBias,ts:Date.now()};
}

export function tlFormatSnapshot(snap){
  if(!snap)return 'MARKET SNAPSHOT: unavailable. TradeLocker call threw before any data came back — likely not connected. Tell Mr. Burrus to add / re-check his login in Settings › Trading.';
  const{quote,state,positions,candles,usd,usdBias,connected,rateLimited,errors=[]}=snap;
  const L=[];
  if(rateLimited&&!quote){
    return 'MARKET SNAPSHOT: TradeLocker\'s data feed is being rate-limited by Cloudflare right now (error 1015). This is NOT a login problem — do NOT tell Mr. Burrus to reconnect or re-add his login. Tell him the broker feed is briefly throttled, wait about a minute, then run [TRADE_SCAN] again. Do not propose a trade until a scan returns a live price.';
  }
  if(!connected&&!quote){
    return 'MARKET SNAPSHOT: TradeLocker is NOT connected — no live data at all. You cannot scan or place a trade. Tell Mr. Burrus plainly to add his TradeLocker login in Settings › Trading, then try again. Do not say "information is limited" — say it is not connected.';
  }
  L.push(`TradeLocker: ${connected?'connected':'session not established'}${errors.length?` · ${errors.length} feed(s) degraded`:''}`);
  if(quote)L.push(`Price ${snap.symbol}: bid ${quote.bid} / ask ${quote.ask} (mid ${quote.mid?.toFixed?.(2)})`);
  else L.push(`Price ${snap.symbol}: UNAVAILABLE — no live quote this scan.`);
  if(state)L.push(`Account: balance ${state.balance}, available ${state.availableFunds}, open P/L ${state.openNetPnL}, open positions ${state.positionsCount}`);
  for(const tf of Object.keys(candles)){
    const c=candles[tf];if(!c){L.push(`${tf}: no data`);continue;}
    L.push(`${tf}: last ${c.last}, ${c.changePct>=0?'+':''}${c.changePct}% over window, trend ${c.trend} (SMA20 ${c.sma20}), range ${c.rangeLow}–${c.rangeHigh}, ATR14 ${c.atr14??'—'}; recent bars ${c.recent.map(b=>`${b.o}/${b.h}/${b.l}/${b.c}`).join('  ')}`);
  }
  if(usd&&Object.keys(usd).length){
    const parts=Object.entries(usd).map(([k,v])=>`${k} ${v.mid}${v.chgPct!=null?` (${v.chgPct>=0?'+':''}${v.chgPct}% 24h)`:''}`);
    L.push(`USD proxy: ${parts.join(', ')}${usdBias?` — ${usdBias.label} [${usdBias.avgPct>=0?'+':''}${usdBias.avgPct}%]`:''} (gold moves inverse to USD)`);
  }
  if(positions?.length)L.push(`Open positions: ${positions.map(p=>`#${p.id} ${p.side} ${p.qty} @ ${p.avgPrice} (uP/L ${p.unrealizedPl})`).join('; ')}`);
  if(errors.length)L.push(`Degraded feeds — ${errors.join(' | ')}`);
  if(rateLimited)L.push('Some feeds were rate-limited (Cloudflare 1015), not disconnected — the login is fine. A fuller picture is available if Mr. Burrus rescans in a minute.');
  const haveAtr=Object.values(candles).some(c=>c&&c.atr14!=null);
  L.push(haveAtr
    ? 'Stop guidance: entry->stop distance ~1–2x the 15m ATR14 (never tighter than 1x).'
    : 'Stop guidance: no ATR this scan — size the stop off structure, and on XAUUSD keep it at least ~$3–4 from entry so intraday noise does not take you out.');
  L.push(quote
    ? 'You HAVE a live price. A few missing feeds is not a reason to refuse — analyse what you have, note what is missing, and you may still [TRADE_PROPOSE]. Mr. Burrus confirms every order and the app re-checks it against a fresh quote before it fires.'
    : 'No live price this scan — do not propose a trade. Say what failed and ask Mr. Burrus to retry or reconnect in Settings › Trading.');
  return L.join('\n');
}

// --- Proposal validation: block the trades that are simply wrong ---

export const MIN_RR=1.5;      // reward:risk floor
export const MAX_ENTRY_DRIFT_PCT=0.35; // proposed entry vs live mid before we warn

// Returns { ok, errors:[], warnings:[], rr, riskPts, rewardPts }. `errors`
// block the send; `warnings` are shown but overridable.
export function validateProposal(prop,{mid,atr15}={}){
  const errors=[],warnings=[];
  const{side,entry,stopLoss,takeProfit}=prop||{};
  const n=v=>typeof v==='number'&&isFinite(v);
  if(side!=='buy'&&side!=='sell')errors.push('side must be buy or sell');
  if(!n(stopLoss))errors.push('no valid stop loss');
  if(!n(takeProfit))errors.push('no valid take profit');
  const ref=n(entry)?entry:(n(mid)?mid:null);
  if(ref==null)errors.push('no entry or live price to check against');

  let rr=null,riskPts=null,rewardPts=null;
  if(!errors.length){
    if(side==='buy'){
      if(stopLoss>=ref)errors.push(`buy stop (${stopLoss}) must be below entry (${ref})`);
      if(takeProfit<=ref)errors.push(`buy target (${takeProfit}) must be above entry (${ref})`);
    }else{
      if(stopLoss<=ref)errors.push(`sell stop (${stopLoss}) must be above entry (${ref})`);
      if(takeProfit>=ref)errors.push(`sell target (${takeProfit}) must be below entry (${ref})`);
    }
    riskPts=Math.abs(ref-stopLoss);
    rewardPts=Math.abs(takeProfit-ref);
    rr=riskPts>0?+(rewardPts/riskPts).toFixed(2):null;
    if(rr!=null&&rr<MIN_RR)errors.push(`reward:risk ${rr} is below the ${MIN_RR} minimum`);
    if(n(mid)&&n(entry)){
      const drift=Math.abs(entry-mid)/mid*100;
      if(drift>MAX_ENTRY_DRIFT_PCT)warnings.push(`price has moved ${drift.toFixed(2)}% from the proposed entry (${entry} vs ${mid.toFixed(2)}) — a market fill will differ`);
    }
    if(n(atr15)&&riskPts!=null){
      if(riskPts<atr15*0.9)warnings.push(`stop is only ${riskPts.toFixed(2)} pts (< 1x 15m ATR ${atr15.toFixed(2)}) — likely to be stopped on noise`);
      if(riskPts>atr15*6)warnings.push(`stop is ${riskPts.toFixed(2)} pts (> 6x 15m ATR ${atr15.toFixed(2)}) — unusually wide`);
    }
  }
  return{ok:errors.length===0,errors,warnings,rr,riskPts,rewardPts};
}
