// A.T.L.A.S. autonomous trading loop — DEMO ACCOUNT ONLY.
//
// Runs while the app is open (App.js starts/stops it on foreground). Every
// `auto_trade_interval_min` minutes it pulls a fresh snapshot for each watched
// symbol, asks Atlas for a decision, and — with NO confirmation prompt — acts:
// opens a 0.01-lot position, or closes ones she wants out of. Every fill is
// recorded in the trade journal (auto=1) so she keeps learning from it.
//
// This is a deliberately unguarded experiment: no daily caps, no loss
// kill-switch. The ONE hard rule is env must be 'demo' — the loop refuses to
// place a single order on a live account and stops itself if it sees one.
import{tlStatus,tlSnapshot,tlFormatSnapshot,tlPlaceOrder,tlClosePosition,tlModifyPosition,tlPositions,tlInstrumentsById,MAX_QTY,MAX_OPEN_POSITIONS}from './tradeLocker';
import{autoTradeDecision}from './aiService';
import{reconcileOpenTrades,formatTradeRecord,getStrategy,recordTradeOpen}from './tradeJournal';
import{getSetting,saveMessage,savePersonaMemory}from './database';

let timer=null,running=false,busy=false;
const listeners=new Set();

export function onAutoTrade(cb){listeners.add(cb);return()=>listeners.delete(cb);}
export function autoTraderRunning(){return running;}

function emit(text){
  saveMessage('atlas','system',text,'direct').catch(()=>{});
  for(const cb of listeners){try{cb(text);}catch{}}
}

async function runOnce(){
  if(busy)return;
  busy=true;
  try{
    if((await getSetting('auto_trade','0'))!=='1'){stopAutoTrader();return;}
    const st=tlStatus();
    if(!st.connected)return;
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

    for(const sym of syms){
      let snap;
      try{snap=await tlSnapshot(sym);}catch{continue;}
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
          try{await tlClosePosition(id);emit(`AUTO · closed #${id} ${sym}${dec.rationale?` — ${dec.rationale}`:''}`);}
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
          openSyms.add(sym);openCount++;
          emit(`AUTO · ${r.side.toUpperCase()} ${r.qty} ${sym} @ ~${price??'mkt'} · SL ${dec.stopLoss??'—'} TP ${dec.takeProfit??'—'}${dec.rationale?` — ${dec.rationale}`:''}`);
          savePersonaMemory('atlas',`[auto-trade] opened ${r.side} ${sym} @ ~${price??'mkt'} — ${dec.rationale||''}`).catch(()=>{});
        }catch(e){emit(`AUTO ${sym} order failed: ${e.message}`);}
      }
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
  if(timer){clearInterval(timer);timer=null;}
}

// Call after changing any auto_trade_* setting.
export async function refreshAutoTrader(){
  stopAutoTrader();
  await startAutoTrader();
}
