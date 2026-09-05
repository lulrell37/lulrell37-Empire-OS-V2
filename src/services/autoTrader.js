// T.A.L.O.N. autonomous trading loop — DEMO ACCOUNT ONLY.
//
// Runs while the app is open (App.js starts/stops it on foreground). Every
// `auto_trade_interval_min` minutes it pulls a fresh snapshot for each watched
// symbol, asks T.A.L.O.N. for a decision, and — with NO confirmation prompt —
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
let warnedDisconnected=false;   // so "waiting for TradeLocker" is said once, not every cycle
let lastHeartbeat=0;            // throttle the "nothing happened" line
const HEARTBEAT_MS=1800000;     // ...to at most once every 30 min
const listeners=new Set();

export function onAutoTrade(cb){listeners.add(cb);return()=>listeners.delete(cb);}
export function autoTraderRunning(){return running;}

function emit(text){
  saveMessage(TRADER_ID,'system',text,'direct').catch(()=>{});
  for(const cb of listeners){try{cb(text);}catch{}}
}

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
        return;
      }
    }
    warnedDisconnected=false;
    if(st.env!=='demo'){
      emit('AUTO-TRADE HALTED — TradeLocker is on a LIVE account. Auto-trade only runs on demo. Turn it back on in Settings once you are back on demo.');
      await getSetting('auto_trade','0'); // (read only — leave the toggle; the guard above stops the loop)
      stopAutoTrader();
      return;
    }

    await reconcileOpenTrades().catch(()=>{});

    const symsRaw=await getSetting('auto_trade_symbols','XAUUSD, EURUSD, GBPJPY, BTCUSD');
    const syms=[...new Set(symsRaw.split(/[\s,]+/).map(s=>s.trim().toUpperCase()).filter(Boolean))].slice(0,6);
    if(!syms.length)return;

    const positions=await tlPositions().catch(()=>[]);
    const idToSym=await tlInstrumentsById().catch(()=>({}));
    const symOf=p=>String(idToSym[String(p.tradableInstrumentId)]||'').toUpperCase();
    const openSyms=new Set(positions.map(symOf));
    let openCount=positions.length;   // grows as we open this cycle; capped at MAX_OPEN_POSITIONS
    const record=await formatTradeRecord().catch(()=>'');
    const strategy=await getStrategy().catch(()=>'');

    let entered=0,closed=0,scanned=0;
    for(const sym of syms){
      let snap;
      try{snap=await tlSnapshot(sym);}catch{continue;}
      scanned++;
      const mine=positions.filter(p=>symOf(p)===sym);
      const posText=mine.map(p=>`#${p.id} ${p.side} ${p.qty} @ ${p.avgPrice} (uP/L ${p.unrealizedPl})`).join('; ')||'none';

      let dec;
      try{dec=await autoTradeDecision({symbol:sym,snapshot:tlFormatSnapshot(snap),record,strategy,positions:posText});}
      catch(e){emit(`AUTO ${sym} — decision failed: ${e.message}`);continue;}

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
        if(openCount>=MAX_OPEN_POSITIONS){emit(`AUTO · skipped ${sym} — ${MAX_OPEN_POSITIONS} positions already open`);continue;}
        const price=snap.quote?.mid??(dec.side==='buy'?snap.quote?.ask:snap.quote?.bid);
        try{
          const r=await tlPlaceOrder({symbol:sym,side:dec.side,qty:MAX_QTY,stopLoss:dec.stopLoss,takeProfit:dec.takeProfit});
          await recordTradeOpen({symbol:sym,side:r.side,qty:r.qty,entry:price,stopLoss:dec.stopLoss,takeProfit:dec.takeProfit,
            rationale:dec.rationale||'auto-trade',orderId:r.orderId,setup:dec.setup,auto:true}).catch(()=>{});
          openSyms.add(sym);openCount++;entered++;
          emit(`AUTO · ${r.side.toUpperCase()} ${r.qty} ${sym} @ ~${price??'mkt'} · SL ${dec.stopLoss??'—'} TP ${dec.takeProfit??'—'}${dec.rationale?` — ${dec.rationale}`:''}`);
          savePersonaMemory(TRADER_ID,`[auto-trade] opened ${r.side} ${sym} @ ~${price??'mkt'} — ${dec.rationale||''}`).catch(()=>{});
        }catch(e){emit(`AUTO ${sym} order failed: ${e.message}`);}
      }
    }
    // Heartbeat — so you can see the loop is alive even on a quiet cycle. A cycle
    // that traded always logs; a quiet cycle logs at most every HEARTBEAT_MS.
    if(scanned&&(entered||closed||Date.now()-lastHeartbeat>HEARTBEAT_MS)){
      lastHeartbeat=Date.now();
      const bits=[];
      if(entered)bits.push(`${entered} new`);
      if(closed)bits.push(`${closed} closed`);
      if(!bits.length)bits.push('standing pat');
      emit(`AUTO · reviewed ${syms.join(', ')} — ${bits.join(', ')} (${openCount}/${MAX_OPEN_POSITIONS} open)`);
    }
  }catch(e){/* never let the loop throw */}
  finally{busy=false;}
}

export async function startAutoTrader(){
  if(running)return;
  if((await getSetting('auto_trade','0'))!=='1')return;
  running=true;
  const mins=Math.max(1,parseInt(await getSetting('auto_trade_interval_min','5'),10)||5);
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
