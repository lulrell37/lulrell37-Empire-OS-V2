// T.A.L.O.N. autonomous trading loop — DEMO ACCOUNT ONLY.
//
// Runs while the app is open (App.js starts/stops it on foreground) — but only
// when no backend is configured. Once a backend is linked, server/talonAutoTrade.js
// is the sole actor (App.js stops starting this loop at all) so the two can't
// double-trade; see AGENTS.md. Every `auto_trade_interval_min` minutes it pulls
// a fresh snapshot for each watched symbol, asks T.A.L.O.N. for a decision,
// and — with NO confirmation prompt —
// acts: opens a 0.01-lot position, or closes ones it wants out of. Every fill is
// recorded in the trade journal (auto=1) so it keeps learning from it.
//
// This is a deliberately unguarded experiment: no daily caps, no loss
// kill-switch. The ONE hard rule is env must be 'demo' — the loop refuses to
// place a single order on a live account and stops itself if it sees one.
import{tlStatus,tlConnect,tlSnapshot,tlFormatSnapshot,tlPlaceOrder,tlClosePosition,tlModifyPosition,tlPositions,tlInstrumentsById,MAX_QTY,MAX_OPEN_POSITIONS}from './tradeLocker';
import{autoTradeDecision}from './aiService';
import{reconcileOpenTrades,formatTradeRecord,getStrategy,recordTradeOpen,TRADER_ID}from './tradeJournal';
import{getSetting,saveMessage,savePersonaMemory}from './database';

let timer=null,running=false,busy=false;
let lastCycleAt=0;             // wall-clock of the last completed runOnce
let warnedDisconnected=false;   // so "waiting for TradeLocker" is said once, not every cycle
let lastHeartbeat=0;            // throttle the "nothing happened" line
const HEARTBEAT_MS=1800000;     // ...to at most once every 30 min
const listeners=new Set();

export function onAutoTrade(cb){listeners.add(cb);return()=>listeners.delete(cb);}
export function autoTraderRunning(){return running;}
export function autoTraderBusy(){return busy;}
// Wall-clock ms of the last runOnce that finished its work (0 = none since
// start). The HUD shows this as "last ran Nm ago" — a loop whose `running` flag
// is true but whose last cycle was an hour ago is wedged, not working.
export function autoTraderLastCycleAt(){return lastCycleAt;}

function emit(text){
  try{const{notify}=require('./report');notify(text);}catch{}
  for(const cb of listeners){try{cb(text);}catch{}}
}

// A real failure the owner needs to see even if he wasn't watching the banner:
// goes to the persistent keyed banner strip AND the Diagnostics crash log, not
// just an 18-second flash. `key` dedups so a recurring failure refreshes in
// place; clear it with the matching key once a cycle succeeds.
function flag(key,label,err){
  const e=err instanceof Error?err:new Error(String(err&&(err.message||err)||label));
  try{const{reportIssue}=require('./report');reportIssue('autotrade:'+key,label,e,{severity:'error'});}catch{}
  try{const{logCrash}=require('./crashLog');logCrash('autotrade:'+key,`${label} — ${e.message}`);}catch{}
}
function unflag(key){try{const{clearIssueKey}=require('./report');clearIssueKey('autotrade:'+key);}catch{}}
function diag(msg){try{const{logCrash}=require('./crashLog');logCrash('autotrade:cycle',msg);}catch{}}

async function runOnce(){
  if(busy)return;
  busy=true;
  try{
    if((await getSetting('auto_trade','0'))!=='1'){stopAutoTrader();return;}
    let st=tlStatus();
    if(!st.connected){
      // The session is memory-only (no backend), so it's gone every time the
      // JS engine restarts — a cold app open, or Android reclaiming the app
      // in the background. Previously this just waited for something else
      // (the TradeStatus pill, if the user happened to open T.A.L.O.N.'s
      // chat) to reconnect it, so auto-trade could sit dead indefinitely
      // after any restart. Reconnect here directly instead.
      try{await tlConnect();st=tlStatus();}
      catch(e){
        if(!warnedDisconnected){warnedDisconnected=true;emit('AUTO-TRADE waiting — TradeLocker login failed ('+String(e?.message||e).split('\n')[0]+'). Retrying each cycle; check Settings › TRADELOCKER if this persists.');}
        flag('connect','Auto-trade can\'t reach TradeLocker',e);
        return;
      }
    }
    warnedDisconnected=false;
    unflag('connect');
    if(st.env!=='demo'){
      emit('AUTO-TRADE HALTED — TradeLocker is on a LIVE account. Auto-trade only runs on demo. Turn it back on in Settings once you are back on demo.');
      await getSetting('auto_trade','0'); // (read only — leave the toggle; the guard above stops the loop)
      stopAutoTrader();
      return;
    }

    await reconcileOpenTrades().catch(()=>{});

    const symsRaw=await getSetting('auto_trade_symbols','XAUUSD, EURUSD, GBPUSD, USDJPY, GBPJPY, AUDUSD, XAGUSD, BTCUSD');
    const syms=[...new Set(symsRaw.split(/[\s,]+/).map(s=>s.trim().toUpperCase()).filter(Boolean))].slice(0,12);
    if(!syms.length)return;

    // How many positions T.A.L.O.N. may run at once — user-set in Settings ›
    // Trading, hard-capped at MAX_OPEN_POSITIONS.
    const maxOpen=Math.min(MAX_OPEN_POSITIONS,Math.max(1,parseInt(await getSetting('auto_trade_max_open',String(MAX_OPEN_POSITIONS)),10)||MAX_OPEN_POSITIONS));

    const positions=await tlPositions().catch(()=>[]);
    const idToSym=await tlInstrumentsById().catch(()=>({}));
    const symOf=p=>String(idToSym[String(p.tradableInstrumentId)]||'').toUpperCase();
    const openSyms=new Set(positions.map(symOf));
    let openCount=positions.length;   // grows as we open this cycle; capped at maxOpen
    const record=await formatTradeRecord().catch(()=>'');
    const strategy=await getStrategy().catch(()=>'');

    let entered=0,closed=0,scanned=0,snapFails=0,decFails=0,orderFails=0;
    let lastErr=null;
    for(const sym of syms){
      let snap;
      try{snap=await tlSnapshot(sym);}
      catch(e){snapFails++;lastErr=e;continue;}   // was a silent `continue` — a market-data outage looked like the loop just doing nothing
      scanned++;
      const mine=positions.filter(p=>symOf(p)===sym);
      const posText=mine.map(p=>`#${p.id} ${p.side} ${p.qty} @ ${p.avgPrice} (uP/L ${p.unrealizedPl})`).join('; ')||'none';

      let dec;
      try{dec=await autoTradeDecision({symbol:sym,snapshot:tlFormatSnapshot(snap),record,strategy,positions:posText,openCount,maxOpen});}
      catch(e){decFails++;lastErr=e;emit(`AUTO ${sym} — decision failed: ${e.message}`);continue;}

      // Break-even management runs alongside whatever else she decides.
      if(Array.isArray(dec.breakevenIds)&&dec.breakevenIds.length){
        for(const id of dec.breakevenIds){
          const pos=positions.find(p=>String(p.id)===String(id));
          if(!pos||Number(pos.unrealizedPl)<=0)continue; // only protect a winner
          try{await tlModifyPosition(id,{stopLoss:Number(pos.avgPrice)});emit(`AUTO · #${id} ${sym} stop → break-even${dec.rationale?` — ${dec.rationale}`:''}`);}
          catch(e){emit(`AUTO break-even #${id} failed: ${e.message}`);}
        }
      }

      if(dec.action==='close'&&Array.isArray(dec.closeIds)&&dec.closeIds.length){
        for(const id of dec.closeIds){
          try{await tlClosePosition(id);closed++;emit(`AUTO · closed #${id} ${sym}${dec.rationale?` — ${dec.rationale}`:''}`);}
          catch(e){emit(`AUTO close #${id} failed: ${e.message}`);}
        }
        continue;
      }

      if(dec.action==='enter'&&(dec.side==='buy'||dec.side==='sell')){
        if(openSyms.has(sym))continue; // already in this pair — don't stack
        if(openCount>=maxOpen){emit(`AUTO · skipped ${sym} — ${maxOpen} positions already open (the limit)`);continue;}
        const price=snap.quote?.mid??(dec.side==='buy'?snap.quote?.ask:snap.quote?.bid);
        try{
          const r=await tlPlaceOrder({symbol:sym,side:dec.side,qty:MAX_QTY,stopLoss:dec.stopLoss,takeProfit:dec.takeProfit});
          await recordTradeOpen({symbol:sym,side:r.side,qty:r.qty,entry:price,stopLoss:dec.stopLoss,takeProfit:dec.takeProfit,
            rationale:dec.rationale||'auto-trade',orderId:r.orderId,setup:dec.setup,auto:true}).catch(()=>{});
          openSyms.add(sym);openCount++;entered++;
          emit(`AUTO · ${r.side.toUpperCase()} ${r.qty} ${sym} @ ~${price??'mkt'} · SL ${dec.stopLoss??'—'} TP ${dec.takeProfit??'—'}${dec.rationale?` — ${dec.rationale}`:''}`);
          savePersonaMemory(TRADER_ID,`[auto-trade] opened ${r.side} ${sym} @ ~${price??'mkt'} — ${dec.rationale||''}`).catch(()=>{});
        }catch(e){orderFails++;lastErr=e;emit(`AUTO ${sym} order failed: ${e.message}`);flag('order',`Auto-trade order rejected on ${sym}`,e);}
      }
    }
    // Every completed cycle is recorded to the Diagnostics log so "why isn't
    // T.A.L.O.N. trading?" is answerable after the fact, not just from a flash
    // that faded. The full watchlist plus what each stage did.
    lastCycleAt=Date.now();
    const summary=`scanned ${scanned}/${syms.length}`
      +(snapFails?`, ${snapFails} snapshot fail`:'')
      +(decFails?`, ${decFails} decision fail`:'')
      +(orderFails?`, ${orderFails} order fail`:'')
      +`, ${entered} entered, ${closed} closed (${openCount}/${maxOpen} open)`;
    diag(summary+(lastErr?` — last error: ${lastErr.message||lastErr}`:''));

    // A whole cycle where not one symbol produced a market read is an outage,
    // not a quiet market — surface it persistently so it can't sit dead silently.
    if(syms.length&&scanned===0){
      flag('nodata',`Auto-trade got no market data for any of ${syms.length} symbols this cycle`,lastErr);
    }else{
      unflag('nodata');
      // Every symbol that got a snapshot then failed its decision call = T.A.L.O.N.'s
      // brain (the Claude call) is unreachable, not the market.
      if(scanned>0&&decFails>=scanned)flag('decision','Auto-trade can\'t get a decision from T.A.L.O.N.',lastErr);
      else unflag('decision');
      // Heartbeat — proof the loop is alive on a quiet cycle. A cycle that traded
      // or hit failures always logs; an otherwise-quiet cycle at most every HEARTBEAT_MS.
      if(entered||closed||snapFails||decFails||orderFails||Date.now()-lastHeartbeat>HEARTBEAT_MS){
        lastHeartbeat=Date.now();
        const bits=[];
        if(entered)bits.push(`${entered} new`);
        if(closed)bits.push(`${closed} closed`);
        if(snapFails)bits.push(`${snapFails} no-data`);
        if(decFails)bits.push(`${decFails} decision fail`);
        if(orderFails)bits.push(`${orderFails} order fail`);
        if(!bits.length)bits.push('standing pat');
        emit(`AUTO · reviewed ${syms.join(', ')} — ${bits.join(', ')} (${openCount}/${maxOpen} open)`);
      }
    }
    if(!orderFails)unflag('order');
  }catch(e){
    // The loop must never throw — but it also must never vanish without a trace.
    flag('loop','Auto-trade cycle crashed',e);
  }
  finally{busy=false;}
}

export async function startAutoTrader(){
  if(running)return;
  if((await getSetting('auto_trade','0'))!=='1')return;
  running=true;
  const mins=Math.max(1,parseInt(await getSetting('auto_trade_interval_min','15'),10)||15);
  timer=setInterval(runOnce,mins*60000);
  setTimeout(()=>{runOnce();},8000); // first pass shortly after start
  emit(`AUTO-TRADE ON — watching every ${mins} min on the DEMO account.`);
}

export function stopAutoTrader(){
  running=false;
  warnedDisconnected=false;
  lastHeartbeat=0;
  if(timer){clearInterval(timer);timer=null;}
}

// Call after changing any auto_trade_* setting.
export async function refreshAutoTrader(){
  stopAutoTrader();
  await startAutoTrader();
}
