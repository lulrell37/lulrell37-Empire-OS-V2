// A.T.L.A.S. autonomous money review — the one persona that already reads
// every front (revenue, trading, outreach, builds) but never says anything
// unless asked. This gives her a heartbeat: while the app is open, on a slow
// timer, she looks at the live empire status and drops one unprompted read —
// what's working, what's not, the one thing worth acting on.
//
// No money moves and no messages send on their own here — it's pure analysis,
// written straight into A.T.L.A.S.'s own chat (queued unread — see the orb
// badge in CommandScreen/OrbZoom) so it's waiting whenever Mr. Burrus opens
// her orb next, spoken as a catch-up line if voice is on.
// Mirrors services/autoTrader.js / services/autoScout.js.
import{getSetting,setSetting,saveMessage,savePersonaMemory}from './database';
import{callPersona}from './aiService';
import{handleCommands,stripCommands}from './commandHandler';
import{empireStatusBlock}from './empireStatus';

let timer=null,running=false,busy=false;
const listeners=new Set();
export function onAutoAtlas(cb){listeners.add(cb);return()=>listeners.delete(cb);}
export function autoAtlasRunning(){return running;}
export function autoAtlasBusy(){return busy;}
function emit(text){for(const cb of listeners){try{cb(text);}catch{}}}

async function runOnce(){
  if(busy)return;
  busy=true;
  try{
    if((await getSetting('auto_atlas','0'))!=='1'){stopAutoAtlas();return;}
    const hours=Math.max(1,parseInt(await getSetting('auto_atlas_interval_hours','24'),10)||24);
    const lastRun=parseInt(await getSetting('auto_atlas_last_run','0'),10)||0;
    if(Date.now()-lastRun<hours*3600000)return; // not due yet — the timer just polls more often than it fires

    const status=await empireStatusBlock().catch(()=>'');
    if(!status.trim())return; // nothing logged anywhere yet — nothing to review

    const ask=[{role:'user',content:
`This is your own periodic money review — nobody asked, it fires on your schedule. Here is the live cross-domain status:\n${status}\n\n`+
`Give Mr. Burrus a tight, unprompted read: what's actually working, what's slipping, and the ONE thing most worth his attention right now — a business lagging its target, cash sitting idle, momentum worth pressing, trading or outreach numbers that changed the picture. End on one concrete recommendation. A few sentences — this is a nudge, not a report. Be straight; don't manufacture urgency if nothing has actually moved.`}];
    let resp='';
    try{resp=await callPersona('atlas',ask,null,null,{skipSave:true,maxTokens:500});}catch(e){return;}
    await handleCommands(resp,'atlas',{}).catch(()=>{});
    const display=(stripCommands(resp)||resp).trim();
    if(!display)return;

    await saveMessage('atlas','assistant',display,'direct',1); // unread — delivered when he next opens her orb
    // A.R.A. runs the day and already gets the raw cross-domain numbers every
    // turn (see aiService.buildSys) — but not A.T.L.A.S.'s actual read on them.
    // Hand her the finished analysis directly so she has the full picture, not
    // just the figures, and can fold it into how she runs the day / raise it
    // herself per her own "flag anything slipping" instruction.
    await savePersonaMemory('ara',`[relayed from A.T.L.A.S. — auto money review] ${display}`).catch(()=>{});
    await setSetting('auto_atlas_last_run',String(Date.now()));
    emit(display);
  }catch(e){/* never let the loop throw */}
  finally{busy=false;}
}

export async function startAutoAtlas(){
  if(running)return;
  if((await getSetting('auto_atlas','0'))!=='1')return;
  running=true;
  // Poll every 30 min; runOnce itself no-ops until the configured interval has
  // actually elapsed (auto_atlas_last_run), so this just catches the moment
  // it comes due without needing a long-lived timer sized to the interval.
  timer=setInterval(runOnce,1800000);
  setTimeout(runOnce,15000);
}
export function stopAutoAtlas(){
  running=false;
  if(timer){clearInterval(timer);timer=null;}
}
export async function refreshAutoAtlas(){stopAutoAtlas();await startAutoAtlas();}
