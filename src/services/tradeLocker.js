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

const session={token:null,refresh:null,exp:0,env:'demo',accountId:null,accNum:null,instruments:{}};

function base(){return BASE[session.env]||BASE.demo;}

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

async function api(path,{method='GET',body,query}={}){
  const t=await token();
  const headers={'Authorization':'Bearer '+t,'Content-Type':'application/json'};
  if(session.accNum!=null)headers.accNum=String(session.accNum);
  const res=await fetch(base()+path+qs(query),{method,headers,body:body?JSON.stringify(body):undefined});
  const text=await res.text();
  let json;try{json=text?JSON.parse(text):{};}catch{json={raw:text};}
  if(!res.ok||json.s==='error')throw new Error(`TradeLocker ${method} ${path}: ${(json.errmsg||text||res.status).toString().slice(0,140)}`);
  return json;
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

export function tlStatus(){return{connected:!!session.accountId,env:session.env,accountId:session.accountId};}

async function ensureAccount(){if(!session.accountId)await tlConnect();}

export async function tlAccountState(){
  await ensureAccount();
  const j=await api(`/trade/accounts/${session.accountId}/state`);
  const arr=j.d?.accountDetailsData||[];
  const out={};ACCOUNT_COLS.forEach((c,i)=>{out[c]=arr[i];});
  return out;
}

// Resolve XAUUSD (or any symbol) to its ids + routes, cached per session.
export async function tlInstrument(symbol='XAUUSD'){
  await ensureAccount();
  if(session.instruments[symbol])return session.instruments[symbol];
  const j=await api(`/trade/accounts/${session.accountId}/instruments`);
  const list=j.d?.instruments||[];
  const inst=list.find(x=>String(x.name).toUpperCase()===symbol.toUpperCase());
  if(!inst)throw new Error(`TradeLocker: instrument ${symbol} not found on this account`);
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

export function tlReset(){session.token=null;session.refresh=null;session.exp=0;session.accountId=null;session.accNum=null;session.instruments={};}

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
  const[quote,state,positions]=await Promise.all([
    tlQuote(symbol),
    tlAccountState().catch(()=>null),
    tlPositions().catch(()=>[]),
  ]);
  const candles={};
  for(const tf of['1D','4H','1H','15m']){
    try{candles[tf]=summarizeBars(await tlHistory(symbol,tf,60));}catch{candles[tf]=null;}
  }
  // USD proxy with 24h % change so "is the dollar bid right now" is actually
  // derivable — a bare level tells the model nothing.
  const usd={};
  const usdContrib=[];
  for(const s of['EURUSD','USDJPY','GBPUSD']){
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
  return{symbol,quote,state,positions,candles,usd,usdBias,ts:Date.now()};
}

export function tlFormatSnapshot(snap){
  if(!snap)return '(market snapshot unavailable)';
  const{quote,state,positions,candles,usd,usdBias}=snap;
  const L=[];
  L.push(`Price ${snap.symbol}: bid ${quote.bid} / ask ${quote.ask} (mid ${quote.mid?.toFixed?.(2)})`);
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
  L.push('Stop guidance: distance from entry to stop should be about 1–2x the 15m ATR14 (never tighter than 1x) so normal noise does not knock you out.');
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
