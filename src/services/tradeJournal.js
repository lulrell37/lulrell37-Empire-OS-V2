// Trade journal for Atlas — the feedback loop the persona was missing.
//
// Every fired proposal is recorded here with its rationale. TradePanel calls
// reconcile() on each poll; when a position we were tracking disappears, we
// close the matching journal entry with its last-seen P/L so Atlas can review
// what actually happened instead of only ever seeing its own entries.
//
// Assisted-trading caveat: with no backend, "closed" P/L is the last
// unrealized value we saw before the position vanished from a poll. It is an
// estimate, not the broker's realized figure, and it is labelled as such.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY='empire_os_trade_journal';
const MAX=60; // ring buffer — plenty of history for review, bounded storage

let mem=null;            // cached journal array, newest last
const lastSeenPl={};     // positionId -> last unrealized P/L seen in a poll
let trackedIds=new Set();// position ids currently open that we've attached

async function load(){
  if(mem)return mem;
  try{mem=JSON.parse(await AsyncStorage.getItem(KEY))||[];}catch{mem=[];}
  return mem;
}
async function persist(){
  try{await AsyncStorage.setItem(KEY,JSON.stringify(mem.slice(-MAX)));}catch{}
}

// Called from confirmTrade the moment an order is accepted. positionId is not
// known yet (the broker returns an orderId); reconcile() attaches it.
export async function logFired({side,entry,fillPrice,stopLoss,takeProfit,qty,rationale,orderId}){
  await load();
  mem.push({
    id:`${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
    ts:Date.now(),side,entry:entry??null,fillPrice:fillPrice??null,
    stopLoss:stopLoss??null,takeProfit:takeProfit??null,qty:qty??null,
    rationale:rationale||'',orderId:orderId??null,
    positionId:null,status:'pending',closePl:null,closedTs:null,
  });
  await persist();
}

// Called by TradePanel on every poll with the current open-position list.
// Attaches new positions to pending entries, tracks P/L, and closes entries
// whose position has disappeared since the previous poll.
export async function reconcile(positions=[]){
  await load();
  const open=new Set();
  for(const p of positions){
    const pid=String(p.id);
    open.add(pid);
    if(p.unrealizedPl!=null)lastSeenPl[pid]=Number(p.unrealizedPl)||0;
    if(!trackedIds.has(pid)){
      // New position — attach to the most recent pending entry that matches side.
      const cand=[...mem].reverse().find(e=>e.status==='pending'&&e.side===p.side);
      if(cand){
        cand.positionId=pid;cand.status='open';
        if(cand.fillPrice==null&&p.avgPrice!=null)cand.fillPrice=Number(p.avgPrice);
        await persist();
      }
      trackedIds.add(pid);
    }
  }
  // Anything we were tracking that is no longer open -> closed.
  let changed=false;
  for(const pid of[...trackedIds]){
    if(open.has(pid))continue;
    trackedIds.delete(pid);
    const entry=mem.find(e=>e.positionId===pid&&e.status==='open');
    if(entry){
      entry.status='closed';
      entry.closePl=lastSeenPl[pid]??null;
      entry.closedTs=Date.now();
      changed=true;
    }
    delete lastSeenPl[pid];
  }
  if(changed)await persist();
  return changed;
}

export async function getJournal(){return[...(await load())];}

// Compact, model-readable review of recent closed trades + open exposure.
export async function formatReview(limit=8){
  const j=await load();
  const closed=j.filter(e=>e.status==='closed').slice(-limit);
  const openNow=j.filter(e=>e.status==='open');
  if(!closed.length&&!openNow.length)return 'TRADE REVIEW: no trades on record yet.';
  const L=['TRADE REVIEW — your own recent trades and how they resolved:'];
  if(closed.length){
    let wins=0,total=0;
    for(const e of closed){
      const pl=e.closePl;
      if(pl!=null){total++;if(pl>0)wins++;}
      const d=new Date(e.closedTs||e.ts).toISOString().slice(5,16).replace('T',' ');
      const px=v=>v==null?'—':(+v).toFixed(2);
      L.push(`  ${d}  ${e.side.toUpperCase()} @${px(e.fillPrice||e.entry)} SL ${px(e.stopLoss)} TP ${px(e.takeProfit)} -> ${pl==null?'result unknown':(pl>=0?'+':'')+pl.toFixed(2)+' (est.)'}  ·  ${e.rationale||'no rationale logged'}`);
    }
    if(total)L.push(`  Record: ${wins}/${total} green (${Math.round((wins/total)*100)}%). Estimated P/L, not broker-realized.`);
  }
  if(openNow.length){
    L.push('  Currently open:');
    for(const e of openNow){
      const px=v=>v==null?'—':(+v).toFixed(2);
      L.push(`    ${e.side.toUpperCase()} @${px(e.fillPrice||e.entry)} SL ${px(e.stopLoss)} TP ${px(e.takeProfit)}  ·  ${e.rationale||''}`);
    }
  }
  L.push('Learn from this: if a setup type keeps losing, stop taking it.');
  return L.join('\n');
}

export async function clearJournal(){mem=[];trackedIds=new Set();for(const k of Object.keys(lastSeenPl))delete lastSeenPl[k];await persist();}
