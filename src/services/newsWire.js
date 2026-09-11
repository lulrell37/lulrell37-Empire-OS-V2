// W.I.R.E. — the Empire news desk. Two tiers, both running only while the app is
// open (App.js starts/stops on foreground), gated on the `news_wire` setting:
//
//   Tier 1 — a headline POLL every 2 hours during waking hours (6am–11pm ET,
//     nothing overnight): one cheap web search + a short classify call. If
//     something materially new has broken since the last brief, it ESCALATES to
//     a full brief. This is the ONLY scheduled work — there are no fixed-time
//     briefs; a full brief only ever fires when something breaks (or Mr. Burrus
//     asks with [NEWS_BRIEF]).
//   Tier 2 — a full BRIEF: two web searches (AP + Ground News for U.S./world,
//     Fox 5 DC for the DMV), then W.I.R.E. writes the structured brief. It lands
//     in the HUD NEWS panel, in her own chat/memory, and on the banner.
//
// When a brief carries a ===MARKETIMPACT=== line at `high` confidence, it is
// handed to T.A.L.O.N., who works out a level and flags it in chat for review —
// nothing is ever placed automatically (T.A.L.O.N. no longer trades without a
// confirmed tap, see CommandScreen.js's sendTrade). Gated on the
// `news_wire_trades` setting.
//
// Mirrors services/dailyBriefing.js (ET date stamps) + services/autoScout.js
// (foreground loop).
import{getSetting,setSetting,updateHudState,getHudState,saveMessage,savePersonaMemory}from './database';
import{webSearch,callPersona,newsTradeLevels}from './aiService';
import{tlStatus,tlConnect,tlSnapshot,tlFormatSnapshot,tlPositions,tlInstrumentsById,MAX_OPEN_POSITIONS}from './tradeLocker';
import{TRADER_ID}from './tradeJournal';

const TZ='America/New_York';
const SEEN_MAX=140;
// Poll every 2 hours, and only during waking hours — nothing overnight.
const POLL_EVERY_HOURS=2;
const DAY_START_HOUR=6;   // first poll of the day, ET (inclusive)
const DAY_END_HOUR=23;    // last poll before this hour, ET (exclusive)
let timer=null,running=false,busy=false;

export function newsWireRunning(){return running;}

function emit(text){try{require('./report').notify(text);}catch{}}
function emitErr(key,label,err){try{require('./report').reportIssue('newswire:'+key,label,err instanceof Error?err:new Error(String(err&&(err.message||err)||label)),{severity:'error'});}catch{}}
function clearErr(key){try{require('./report').clearIssueKey('newswire:'+key);}catch{}}

function todayET(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}
function hourET(){
  return parseInt(new Intl.DateTimeFormat('en-US',{timeZone:TZ,hour:'2-digit',hour12:false}).format(new Date()),10)%24;
}
// Dedup key for the current poll window: one poll per N-hour bucket per day.
const pollSlot=()=>`${todayET()}-b${Math.floor(hourET()/POLL_EVERY_HOURS)}`;
// Whether we should be polling at all right now (waking hours only).
const inPollWindow=()=>{const h=hourET();return h>=DAY_START_HOUR&&h<DAY_END_HOUR;};

// --- headline memory (rolling, deduped) ---
function fingerprint(s){
  return String(s||'').toLowerCase().replace(/[^a-z0-9 ]+/g,'').replace(/\s+/g,' ').trim().slice(0,70);
}
async function loadSeen(){
  try{const a=JSON.parse(await getSetting('news_seen','[]'));return Array.isArray(a)?a:[];}catch{return[];}
}
async function rememberHeadlines(lines){
  const fps=lines.map(fingerprint).filter(Boolean);
  if(!fps.length)return;
  const seen=await loadSeen();
  const next=[...fps,...seen.filter(x=>!fps.includes(x))].slice(0,SEEN_MAX);
  await setSetting('news_seen',JSON.stringify(next)).catch(()=>{});
}

// --- parse W.I.R.E.'s structured output ---
function parseBrief(text){
  const raw=String(text||'');
  const hIdx=raw.search(/===\s*HEADLINES\s*===/i);
  const mIdx=raw.search(/===\s*MARKETIMPACT\s*===/i);
  const cut=[hIdx,mIdx].filter(i=>i>=0).sort((a,b)=>a-b)[0];
  const brief=(cut>=0?raw.slice(0,cut):raw).trim();
  const headSec=hIdx>=0?raw.slice(hIdx+raw.slice(hIdx).indexOf('\n')+1,mIdx>=0&&mIdx>hIdx?mIdx:undefined):'';
  const impactSec=mIdx>=0?raw.slice(mIdx+raw.slice(mIdx).indexOf('\n')+1):'';
  const headlines=headSec.split('\n').map(l=>l.trim()).filter(Boolean)
    .map(l=>{const m=l.match(/^(TOP|DMV|MONEY)\s*\|\s*(.+)$/i);return m?{tag:m[1].toUpperCase(),text:m[2].trim()}:null;})
    .filter(Boolean);
  const impacts=impactSec.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>{
    const p=l.split('|').map(x=>x.trim());
    if(p.length<4)return null;
    const side=/^(buy|long)$/i.test(p[1])?'buy':/^(sell|short)$/i.test(p[1])?'sell':null;
    if(!side)return null;
    return{symbol:p[0].toUpperCase().replace(/[^A-Z0-9.]/g,''),side,horizon:p[2],confidence:(p[3]||'').toLowerCase(),thesis:(p[4]||p[3]||'').trim()};
  }).filter(x=>x&&x.symbol);
  return{brief,headlines,impacts};
}

// --- Tier 2: full brief (fires only on a break or [NEWS_BRIEF]) ---
export async function refreshNewsBrief({force=false,trigger='break'}={}){
  if(busy&&!force)return{skipped:'busy'};
  if((await getSetting('news_wire','1'))!=='1'&&!force)return{skipped:'off'};
  busy=true;
  try{
    const seen=await loadSeen();
    let world='',dmv='',extra='';
    try{world=await webSearch('wire','Top U.S. and world news right now — the biggest stories from apnews.com and ground.news: what happened, the key numbers, and how the coverage differs. List each with its source.');}
    catch(e){emitErr('search','W.I.R.E. — news search failing',e);busy=false;return{error:e.message};}
    try{dmv=await webSearch('wire','Top D.C., Maryland and Virginia (DMV) local news today from fox5dc.com — what happened and where.');}catch{}
    if(trigger==='poll'){
      try{extra=await webSearch('wire',`The single biggest developing story in the last few hours not already covered here: ${seen.slice(0,12).join('; ')}. What just happened and what it means for markets.`);}catch{}
    }
    clearErr('search');

    const user=
`RAW WIRES — write Mr. Burrus's brief from these. Name sources. Do not invent anything not below.

U.S. / WORLD (AP + Ground News):
${String(world).slice(0,6000)}

DMV (Fox 5 DC):
${String(dmv||'(nothing pulled)').slice(0,2500)}
${extra?`\nDEVELOPING:\n${String(extra).slice(0,2500)}\n`:''}
Already reported earlier (do not re-lead with these, only note real developments): ${seen.slice(0,15).join(' | ')||'(nothing yet)'}

FORMAT — exactly these sections, in order, tight:
TOP — U.S. + world, what happened and the numbers
DMV — local
MARKETS & MONEY — what moved and why
MARKET IMPACT — for each instrument the desk trades that a story is moving or about to move: the call
OPPORTUNITIES — a concrete way to profit; hand real ones off with [RELAY_TO: atlas|...] / [RELAY_TO: scout|...] / [RELAY_TO: rogue|...]

Then two machine trailers, exactly:
===HEADLINES===
TOP|<one line>
TOP|<one line>
DMV|<one line>
MONEY|<one line>
===MARKETIMPACT===
<SYMBOL>|<buy or sell>|<time horizon>|<high|med|low>|<one-line thesis>
(only instruments the account trades — XAUUSD XAGUSD EURUSD GBPUSD USDJPY GBPJPY AUDUSD BTCUSD indices crude; leave the section empty if nothing qualifies; mark 'high' ONLY when you would put money on it)`;

    let out='';
    try{out=await callPersona('wire',[{role:'user',content:user}],null,null,{skipSave:true,maxTokens:1900});}
    catch(e){emitErr('write','W.I.R.E. — can\'t reach Claude to write the brief',e);busy=false;return{error:e.message};}
    clearErr('write');

    const{brief,headlines,impacts}=parseBrief(out);
    if(!brief){busy=false;return{error:'empty brief'};}

    const slotLabel=trigger==='manual'?'manual':'break';
    await updateHudState({
      news_brief:brief,
      news_headlines:JSON.stringify(headlines),
      news_slot:slotLabel,
      news_updated_at:Date.now(),
    }).catch(()=>{});
    await saveMessage('wire','assistant',brief,'direct').catch(()=>{});
    await savePersonaMemory('wire',`[news brief · ${slotLabel}] ${brief.slice(0,4000)}`).catch(()=>{});
    await rememberHeadlines(headlines.map(h=>h.text));
    await setSetting('news_last_poll',String(Date.now())).catch(()=>{});

    const lead=headlines[0]?.text||brief.split('\n').find(Boolean)||'brief updated';
    emit(`— W.I.R.E. · news brief in — ${lead.slice(0,120)} —`);

    if(impacts.length)await newsTradeHandoff(impacts).catch(e=>emitErr('handoff','W.I.R.E. → T.A.L.O.N. hand-off failed',e));
    return{ok:true,headlines:headlines.length,impacts:impacts.length};
  }catch(e){emitErr('loop','W.I.R.E. brief crashed',e);return{error:e.message};}
  finally{busy=false;}
}

// --- Tier 1: hourly headline poll ---
async function pollHeadlines(){
  if(busy)return;
  if(!inPollWindow())return;                              // overnight — skip
  const stamp=pollSlot();
  if(await getSetting('news_poll_hour','')===stamp)return; // already polled this window
  await setSetting('news_poll_hour',stamp).catch(()=>{});

  let scan='';
  try{scan=await webSearch('wire','Breaking U.S., world and market news in the last two hours — headlines from apnews.com and ground.news, with sources.');}
  catch(e){emitErr('search','W.I.R.E. — news search failing',e);return;}
  clearErr('search');
  if(!String(scan).trim())return;

  const seen=await loadSeen();
  let verdict={new:false};
  try{
    const j=await callPersona('wire',[{role:'user',content:
`Current headlines from the wires:\n${String(scan).slice(0,4000)}\n\nYou have ALREADY reported these earlier:\n${seen.slice(0,20).join(' | ')||'(nothing yet)'}\n\nIs there anything genuinely NEW and materially important since — a real development, not a rehash? Reply ONLY JSON:\n{"new": true|false, "headlines": ["short line", ...], "marketMove": true|false}`}],
      null,null,{skipSave:true,maxTokens:400});
    const m=String(j).match(/\{[\s\S]*\}/);
    if(m)verdict=JSON.parse(m[0]);
  }catch(e){return;}

  await setSetting('news_last_poll',String(Date.now())).catch(()=>{});
  if(Array.isArray(verdict.headlines)&&verdict.headlines.length)await rememberHeadlines(verdict.headlines);

  if(verdict.new){
    emit(`— W.I.R.E. · something broke — pulling a full read —`);
    await refreshNewsBrief({trigger:'poll'});
  }
}

// --- News → T.A.L.O.N. trade ALERT (never places anything on its own) ---
// Flags a high-confidence market-mover to T.A.L.O.N. with a worked-out level,
// same as any other setup he'd bring to Mr. Burrus — placing it still needs a
// confirmed tap in chat (see CommandScreen.js's sendTrade). This used to place
// the order outright; that autonomous path was removed.
async function newsTradeHandoff(impacts){
  const highs=impacts.filter(i=>/^high/.test(i.confidence));
  if(!highs.length)return;
  if((await getSetting('news_wire_trades','1'))!=='1'){
    emit(`— W.I.R.E. flags ${highs.map(i=>`${i.side.toUpperCase()} ${i.symbol}`).join(', ')} — news-driven alerts are off —`);
    return;
  }
  let st=tlStatus();
  if(!st.connected){try{await tlConnect();st=tlStatus();}catch(e){emit(`— W.I.R.E. → T.A.L.O.N.: can't reach TradeLocker to size a level —`);return;}}

  const positions=await tlPositions().catch(()=>[]);
  const idToSym=await tlInstrumentsById().catch(()=>({}));
  const openSyms=new Set(positions.map(p=>String(idToSym[String(p.tradableInstrumentId)]||'').toUpperCase()));
  let openCount=positions.length;

  for(const imp of highs){
    if(openSyms.has(imp.symbol))continue;                 // already holding this pair
    if(openCount>=MAX_OPEN_POSITIONS){emit(`— W.I.R.E. → T.A.L.O.N.: book full (${MAX_OPEN_POSITIONS}), flagging ${imp.symbol} anyway —`);}
    let snap;
    try{snap=await tlSnapshot(imp.symbol);}
    catch(e){emit(`— W.I.R.E. → T.A.L.O.N.: no market data for ${imp.symbol} —`);continue;}
    let lv;
    try{lv=await newsTradeLevels({symbol:imp.symbol,side:imp.side,snapshot:tlFormatSnapshot(snap),thesis:imp.thesis});}
    catch(e){emit(`— W.I.R.E. → T.A.L.O.N.: ${imp.symbol} levels call failed —`);continue;}
    if(!lv){emit(`— W.I.R.E. → T.A.L.O.N.: ${imp.symbol} — T.A.L.O.N. couldn't set levels —`);continue;}
    const price=snap.quote?.mid??(imp.side==='buy'?snap.quote?.ask:snap.quote?.bid);
    emit(`— W.I.R.E. → T.A.L.O.N. · flags ${imp.side.toUpperCase()} ${imp.symbol} @ ~${price??'mkt'} · SL ${lv.stopLoss} TP ${lv.takeProfit} — ${imp.thesis.slice(0,80)} — say the word to place it —`);
    const note=`[news setup — not placed] ${imp.side} ${imp.symbol} @ ~${price??'mkt'} on: ${imp.thesis}`;
    savePersonaMemory(TRADER_ID,note).catch(()=>{});
    savePersonaMemory('wire',note).catch(()=>{});
    saveMessage('talon','assistant',`W.I.R.E. flagged a high-confidence mover — ${imp.side.toUpperCase()} ${imp.symbol} @ ~${price??'mkt'}, SL ${lv.stopLoss}, TP ${lv.takeProfit}. ${lv.note||''} Say the word and I'll place it.`.trim(),'direct').catch(()=>{});
  }
}

// --- loop ---
async function tick(){
  if(busy)return;
  try{
    if((await getSetting('news_wire','1'))!=='1'){stopNewsWire();return;}
    // The only scheduled work: the hourly cheap poll. It escalates to a full
    // brief itself when something has actually broken. No fixed-time briefs.
    await pollHeadlines();
  }catch(e){emitErr('tick','W.I.R.E. loop tick crashed',e);}
}

export async function startNewsWire(){
  if(running)return;
  if((await getSetting('news_wire','1'))!=='1')return;
  running=true;
  timer=setInterval(tick,10*60000);
  // one catch-up run a few seconds after launch (after auto-trade/scout so we
  // don't stack Claude calls at once on a cold open)
  setTimeout(()=>{tick();},14000);
  emit('NEWS DESK ON — W.I.R.E. checks the wires every 2 hours through the day (nothing overnight); a full brief lands only when something breaks.');
}
export function stopNewsWire(){
  running=false;
  if(timer){clearInterval(timer);timer=null;}
}
export async function refreshNewsWire(){stopNewsWire();await startNewsWire();}
