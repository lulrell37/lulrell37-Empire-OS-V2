// The trade journal — Atlas's memory of her own trading.
//
// confirmTrade() records a row here the moment an order is sent. reconcile()
// then watches TradeLocker: while a trade's position is open it keeps the
// unrealized P/L fresh, and once the position leaves the open list it pulls the
// realized P/L from /ordersHistory, scores the trade (win / loss / breakeven,
// R multiple), and closes the row.
//
// Everything runs while the app is open — same "assisted" boundary as the rest
// of trading. A trade that closes overnight (SL/TP hit while the app is shut) is
// reconciled on the next open; if it can't be resolved it's marked 'unknown'.
//
// formatRecord() + getStrategy() are what get injected into Atlas's context on
// every [TRADE_SCAN] so she reviews her record and refines her strategy.
import{insertTrade,updateTrade,getOpenTrades,getClosedTrades,getTradeById,saveNote,getNote}from './database';
import{tlPositions,tlOrdersHistory,tlInstrumentsById}from './tradeLocker';

export const STRATEGY_TITLE='A.T.L.A.S. — Winning Strategy';

const PL_KEYS=['positionNetPl','positionGrossPl','netPl','pnl','profit','realizedPl','positionPnl'];
const num=(v)=>{const n=Number(v);return isNaN(n)?null:n;};
const near=(a,b,tol)=>a!=null&&b!=null&&Math.abs(a-b)<=tol;

function inferSetup(rationale=''){
  if(/scalp/i.test(rationale))return 'scalp';
  if(/swing/i.test(rationale))return 'swing';
  return 'other';
}

// --- strategy note --------------------------------------------------------
export async function getStrategy(){
  try{return (await getNote(STRATEGY_TITLE))?.content||'';}catch{return '';}
}
export async function setStrategy(text){
  const body=String(text||'').trim().slice(0,4000);
  if(!body)return;
  await saveNote(STRATEGY_TITLE,body,'atlas');
}

// --- recording -----------------------------------------------------------
export async function recordTradeOpen({symbol,side,qty,entry,stopLoss,takeProfit,rationale,orderId,setup,auto}){
  return insertTrade({
    persona:'atlas',symbol:String(symbol||'').toUpperCase(),side,
    qty:num(qty),entry_ref:num(entry),stop_loss:num(stopLoss),take_profit:num(takeProfit),
    setup:setup||inferSetup(rationale),rationale:String(rationale||'').slice(0,400),
    status:'open',order_id:orderId!=null?String(orderId):null,opened_at:Date.now(),
    auto:auto?1:0,
  });
}

export async function setTradeReview(id,note){
  const t=await getTradeById(Number(id));
  if(!t)return false;
  await updateTrade(t.id,{review:String(note||'').slice(0,400)});
  return true;
}

// --- reconciliation ----------------------------------------------------------
export async function reconcileOpenTrades(){
  let open;
  try{open=await getOpenTrades('atlas');}catch{return{checked:0,closed:0};}
  if(!open.length)return{checked:0,closed:0};

  let positions=[],idToSym={};
  try{positions=await tlPositions();}catch{return{checked:open.length,closed:0,error:'positions'};}
  try{idToSym=await tlInstrumentsById();}catch{}

  const posById={};
  for(const p of positions)posById[String(p.id)]=p;
  const boundIds=new Set(open.map(t=>t.position_id).filter(Boolean));

  let history=null;
  const loadHistory=async()=>{
    if(history!==null)return history;
    try{history=await tlOrdersHistory();}catch{history=[];}
    return history;
  };

  let closed=0;
  for(const t of open){
    // 1. bind a freshly-opened trade to its live position
    if(!t.position_id){
      const cand=positions.find(p=>{
        if(boundIds.has(String(p.id)))return false;
        const sym=String(idToSym[String(p.tradableInstrumentId)]||'').toUpperCase();
        if(sym&&t.symbol&&sym!==t.symbol)return false;
        if(p.side&&t.side&&p.side!==t.side)return false;
        if(t.qty!=null&&!near(num(p.qty),t.qty,Math.max(t.qty*0.5,0.001)))return false;
        const opened=Number(p.openDate)||Date.parse(p.openDate||p.openTime||'')||0;
        if(opened&&Math.abs(opened-t.opened_at)>15*60e3)return false;
        return true;
      });
      if(cand){
        boundIds.add(String(cand.id));
        await updateTrade(t.id,{position_id:String(cand.id),entry_fill:num(cand.avgPrice),last_unrealized:num(cand.unrealizedPl),misses:0});
        continue;
      }
      // order sent but no matching position yet — give it a few cycles
      const misses=(t.misses||0)+1;
      if(misses>=8||Date.now()-t.opened_at>20*60e3){
        await updateTrade(t.id,{status:'unknown',outcome:'unknown',closed_at:Date.now(),
          review:t.review||'never appeared as an open position — order may have been rejected or filled and closed while the app was shut'});
      }else{
        await updateTrade(t.id,{misses});
      }
      continue;
    }

    // 2. still open — keep unrealized fresh
    const live=posById[String(t.position_id)];
    if(live){
      await updateTrade(t.id,{last_unrealized:num(live.unrealizedPl),entry_fill:t.entry_fill??num(live.avgPrice),misses:0});
      continue;
    }

    // 3. position gone -> the trade closed. Score it.
    const rows=(await loadHistory()).filter(r=>{
      const pid=String(r.position??r.positionId??r.positionID??'');
      return pid&&pid===String(t.position_id);
    });
    let realized=null,exit=null,estimated=0;
    if(rows.length){
      for(const r of rows){
        for(const k of PL_KEYS){if(r[k]!=null&&num(r[k])!=null){realized=(realized||0)+num(r[k]);break;}}
      }
      const closer=rows.find(r=>r.side&&r.side!==t.side)||rows[rows.length-1];
      exit=num(closer?.avgPrice)??num(closer?.price);
    }
    if(realized==null){realized=num(t.last_unrealized)??0;estimated=1;}

    const entry=num(t.entry_fill)??num(t.entry_ref);
    let r_multiple=null;
    if(exit!=null&&entry!=null&&t.stop_loss!=null){
      const risk=t.side==='buy'?entry-t.stop_loss:t.stop_loss-entry;
      const reward=t.side==='buy'?exit-entry:entry-exit;
      if(risk>0)r_multiple=+(reward/risk).toFixed(2);
    }
    const outcome=realized>0.01?'win':realized<-0.01?'loss':'breakeven';
    await updateTrade(t.id,{
      status:'closed',closed_at:Date.now(),exit_price:exit,
      realized_pl:+realized.toFixed(2),pl_estimated:estimated,outcome,r_multiple,
    });
    closed++;
  }
  return{checked:open.length,closed};
}

// --- the record Atlas reads -----------------------------------------------
export async function tradeRecord({limit=40}={}){
  let closed=[],openCount=0;
  try{closed=await getClosedTrades('atlas',limit);}catch{}
  try{openCount=(await getOpenTrades('atlas')).length;}catch{}
  const scored=closed.filter(t=>t.status==='closed'&&t.outcome&&t.outcome!=='unknown');
  const wins=scored.filter(t=>t.outcome==='win').length;
  const losses=scored.filter(t=>t.outcome==='loss').length;
  const be=scored.filter(t=>t.outcome==='breakeven').length;
  const net=+scored.reduce((a,t)=>a+(Number(t.realized_pl)||0),0).toFixed(2);
  const rs=scored.map(t=>Number(t.r_multiple)).filter(v=>!isNaN(v)&&v!==null);
  const avgR=rs.length?+(rs.reduce((a,v)=>a+v,0)/rs.length).toFixed(2):null;
  const winRate=(wins+losses)?Math.round((wins/(wins+losses))*100):null;

  // current streak (consecutive same outcome, newest first, ignoring BE)
  let streak=0,streakType=null;
  for(const t of scored){
    if(t.outcome==='breakeven')continue;
    if(streakType==null){streakType=t.outcome;streak=1;}
    else if(t.outcome===streakType)streak++;
    else break;
  }

  const bySetup={};
  for(const t of scored){
    const k=t.setup||'other';
    (bySetup[k]||(bySetup[k]={n:0,wins:0,net:0}));
    bySetup[k].n++;
    if(t.outcome==='win')bySetup[k].wins++;
    bySetup[k].net+=Number(t.realized_pl)||0;
  }
  return{count:scored.length,wins,losses,be,net,avgR,winRate,streak,streakType,openCount,bySetup,recent:closed.slice(0,8)};
}

export async function formatTradeRecord(){
  const r=await tradeRecord({});
  if(!r.count&&!r.openCount)return '(no trades recorded yet — this is where your history will build)';
  const L=[];
  if(r.count){
    L.push(`Closed: ${r.count} | ${r.wins}W-${r.losses}L-${r.be}BE${r.winRate!=null?` (${r.winRate}% win)`:''} | Net P/L: ${r.net>=0?'+':''}${r.net}${r.avgR!=null?` | Avg R: ${r.avgR>=0?'+':''}${r.avgR}`:''}`);
    if(r.streak>=2)L.push(`Current streak: ${r.streak}${r.streakType==='win'?'W':'L'}`);
    const setups=Object.entries(r.bySetup).map(([k,v])=>`${k} ${v.n} (${v.wins}W, ${v.net>=0?'+':''}${v.net.toFixed(2)})`);
    if(setups.length)L.push(`By setup: ${setups.join(' · ')}`);
  }
  if(r.openCount)L.push(`Open right now: ${r.openCount}`);
  if(r.recent.length){
    L.push('Recent:');
    for(const t of r.recent){
      const tag=t.status==='unknown'?'UNKNOWN':(t.outcome||'?').toUpperCase();
      const pl=t.realized_pl!=null?` ${t.realized_pl>=0?'+':''}${t.realized_pl}${t.pl_estimated?'~':''}`:'';
      const rr=t.r_multiple!=null?` (${t.r_multiple>=0?'+':''}${t.r_multiple}R)`:'';
      const rev=t.review?` · "${t.review}"`:'';
      L.push(` • #${t.id} ${t.auto?'[auto] ':''}${t.symbol} ${t.side} — ${tag}${pl}${rr}${rev}`);
    }
  }
  return L.join('\n');
}

// One block for the [TRADE_SCAN] injection: record + live strategy.
export async function atlasJournalBlock(){
  const [rec,strat]=await Promise.all([formatTradeRecord(),getStrategy()]);
  return `A.T.L.A.S. TRADE RECORD (your own history — review before proposing):
${rec}

A.T.L.A.S. CURRENT STRATEGY (your personalized playbook):
${strat||'(none written yet — as your record reveals what works for you, build it with [STRATEGY_UPDATE: ...])'}`;
}
