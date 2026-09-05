// S.C.O.U.T. autonomous prospecting + outreach loop.
//
// Runs while the app is open (App.js starts/stops it on foreground), gated on
// the `auto_scout` setting. Every `auto_scout_interval_min` minutes it:
//   1. sweeps X / Hacker News / Reddit for inbound buying signals — people
//      already looking for us — and claims the lead budget first,
//   2. prospects one metro x segment cell of the nationwide grid with
//      whatever lead-budget room is left,
//   3. cold-emails fresh leads their opener — NO confirmation prompt,
//   4. sends due follow-ups.
// Daily caps (`auto_scout_daily_leads`, `auto_scout_daily_emails`) bound the
// volume and the API/Gmail exposure. Mirrors services/autoTrader.js.
import{getSetting,setSetting,saveMessage,addLead,leadExists,updateLead,appendLeadLog,getLeadsForOutreach,getLeadsDue,getTodayStr}from './database';
import{webSearch,callPersona}from './aiService';
import{runInboundScan}from './inbound';
import{gmailSend,googleConnected}from './googleClient';
import{pickTarget,pickInboundQuery}from './scoutTargets';
import{pushLeadsToSheet}from './leadsSheet';

let timer=null,running=false,busy=false;
let lastHeartbeat=0,lastError=0;
const HEARTBEAT_MS=1800000;
const ERROR_MS=3600000;
const listeners=new Set();
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function onAutoScout(cb){listeners.add(cb);return()=>listeners.delete(cb);}
export function autoScoutRunning(){return running;}

function emit(text){
  saveMessage('scout','system',text,'direct').catch(()=>{});
  for(const cb of listeners){try{cb(text);}catch{}}
}
// Throttled — a persistent failure (no key, Google down) shouldn't spam the chat.
function emitErr(text){
  if(Date.now()-lastError<ERROR_MS)return;
  lastError=Date.now();
  emit(text);
}

async function loadStats(){
  const today=getTodayStr();
  let s={date:today,added:0,sent:0};
  try{const raw=await getSetting('auto_scout_stats','');if(raw){const p=JSON.parse(raw);if(p&&p.date===today)s={date:today,added:p.added|0,sent:p.sent|0};}}catch{}
  return s;
}
const saveStats=s=>setSetting('auto_scout_stats',JSON.stringify(s)).catch(()=>{});

function parseLeadAdds(text){
  const out=[];
  for(const m of String(text||'').matchAll(/\[LEAD_ADD:\s*([^\]]+)\]/gi)){
    const p=m[1].split('|').map(x=>x.trim());
    if(p[0])out.push({name:p[0],business:p[1]||'',website:p[2]||'',contact:p[3]||'',bottleneck:p[4]||'',segment:p[5]||''});
  }
  return out;
}
function parseSubjectBody(text){
  const t=String(text||'');
  const sm=t.match(/SUBJECT:\s*(.+)/i);
  const bm=t.match(/BODY:\s*([\s\S]+)/i);
  const subject=(sm?sm[1]:'').trim().split('\n')[0].replace(/^["']|["']$/g,'').slice(0,160);
  let body=(bm?bm[1]:'').trim().replace(/\[[^\]]*\]/g,'').trim(); // no stray command tags in a real email
  return{subject,body};
}
function plusDays(n){const d=new Date();d.setDate(d.getDate()+n);return d.toISOString().split('T')[0];}

// --- outbound prospecting (fills whatever lead-budget room inbound left) --
async function prospectPass(stats,dailyLeads){
  if(stats.added>=dailyLeads)return;
  let cursor=0;
  try{cursor=parseInt(await getSetting('auto_scout_cursor','0'),10)||0;}catch{}
  await setSetting('auto_scout_cursor',String(cursor+1)).catch(()=>{});
  const{metro,segment}=pickTarget(cursor);

  let results='';
  try{results=await webSearch('scout',`${segment} businesses in ${metro} — small, owner-operated, currently open (not permanently closed)`);}
  catch(e){emitErr(`AUTO-SCOUT · search failing — ${e.message}`);return;}
  if(!String(results||'').trim())return;

  const room=Math.min(6,Math.max(1,dailyLeads-stats.added));
  const ask=[{role:'user',content:
`TOOL RESULTS — web search for "${segment}" in ${metro}:\n\n${String(results).slice(0,4000)}\n\n`+
`Pick the businesses in these results that genuinely fit Empire Digital's ICP and emit one line per business:\n`+
`[LEAD_ADD: name | what they do | website | contact | the bottleneck you'd guess they have | ${segment} · ${metro}]\n\n`+
`ICP: owner-operated, roughly 2-50 people, a clear repetitive bottleneck likely costing time or money, an owner who can say yes alone. `+
`Do NOT add franchises, national chains, directories, marketplaces, aggregator listings or anything enterprise. `+
`Do NOT add a business that is permanently closed, temporarily closed, or otherwise no longer operating — if the results flag a listing "permanently closed", "closed", "out of business" or similar, skip it; we need live, reachable leads. `+
`Never invent an email or phone — leave contact blank if it isn't in the results. `+
`Add at most ${room}; two well-qualified beats ten weak. Output ONLY the [LEAD_ADD:] lines.`}];
  let resp='';
  try{resp=await callPersona('scout',ask,null,null,{skipSave:true,maxTokens:1400});}
  catch(e){emitErr(`AUTO-SCOUT · can't reach Claude — ${e.message}`);return;}

  let added=0;
  for(const c of parseLeadAdds(resp)){
    if(stats.added>=dailyLeads)break;
    try{
      if(await leadExists(c.name,c.website))continue;
      await addLead({
        name:c.name,business:c.business,website:c.website,contact:c.contact,bottleneck:c.bottleneck,
        segment:c.segment||`${segment} · ${metro}`,stage:'new',source:'scout-auto',
        log:`Auto-scouted from ${metro} (${segment})`,
      });
      stats.added++;added++;
    }catch{}
  }
  if(added)emit(`AUTO-SCOUT · ${metro} / ${segment} — +${added} lead${added===1?'':'s'} (${stats.added}/${dailyLeads} today)`);
}

// --- inbound signal sweep (priority — runs first, claims budget first) ---
async function inboundPass(stats,dailyLeads){
  if(stats.added>=dailyLeads)return;
  let cursor=0;
  try{cursor=parseInt(await getSetting('auto_scout_inbound_cursor','0'),10)||0;}catch{}
  await setSetting('auto_scout_inbound_cursor',String(cursor+1)).catch(()=>{});

  let digest='';
  try{digest=await runInboundScan('scout',pickInboundQuery(cursor),null);}catch{return;}
  if(!String(digest||'').trim())return;

  const room=Math.min(4,Math.max(1,dailyLeads-stats.added));
  const ask=[{role:'user',content:
`INBOUND SCAN — public posts where people may be asking for what Empire Digital builds:\n\n${String(digest).slice(0,4000)}\n\n`+
`For each post that is genuinely a business owner or operator asking for a custom tool, automation, or software help, emit:\n`+
`[LEAD_ADD: name or handle | what their business does | the post URL | | what they said they need | inbound-signal]\n\n`+
`Skip developers offering services, job posts, generic discussion, anything that isn't a real buying signal. Add at most ${room}. Output ONLY [LEAD_ADD:] lines.`}];
  let resp='';
  try{resp=await callPersona('scout',ask,null,null,{skipSave:true,maxTokens:1200});}catch{return;}

  let added=0;
  for(const c of parseLeadAdds(resp)){
    if(stats.added>=dailyLeads)break;
    try{
      if(await leadExists(c.name,c.website))continue;
      await addLead({name:c.name,business:c.business,website:c.website,contact:c.contact||'',bottleneck:c.bottleneck,
        segment:'inbound-signal',stage:'new',source:'scout-auto',
        log:`Auto-scouted inbound signal: ${String(c.bottleneck||'').slice(0,200)}`});
      stats.added++;added++;
    }catch{}
  }
  if(added)emit(`AUTO-SCOUT · inbound sweep — +${added} signal${added===1?'':'s'}`);
}

// --- 3. cold outreach -------------------------------------------------
async function sendFor(lead,promptText,stats,dailyEmails,label){
  const email=String(lead.contact||'').trim();
  if(!EMAIL_RE.test(email))return false;
  let resp='';
  try{resp=await callPersona('scout',[{role:'user',content:promptText}],null,null,{skipSave:true,maxTokens:500});}catch{return false;}
  const{subject,body}=parseSubjectBody(resp);
  if(!subject||body.length<20)return false;
  try{await gmailSend({to:email,subject,body});}
  catch(e){
    emit(`AUTO-SCOUT · email to ${lead.name} failed — ${e.message}`);
    if(/auth|401|expired|token/i.test(e.message))throw e; // Google problem — abort the pass
    return false;
  }
  stats.sent++;
  await appendLeadLog(lead.id,`${label}: ${subject}`).catch(()=>{});
  emit(`AUTO-SCOUT · ${label.toLowerCase()} → ${lead.name} <${email}> — "${subject}" (${stats.sent}/${dailyEmails} today)`);
  return true;
}

async function outreachPass(stats,dailyEmails){
  if(stats.sent>=dailyEmails)return;
  if(!(await googleConnected().catch(()=>false)))return;
  let leads=[];
  try{leads=await getLeadsForOutreach(3);}catch{return;}
  for(const lead of leads){
    if(stats.sent>=dailyEmails)break;
    const prompt=
`Write the FIRST cold outreach email to this prospect. It is the opener — one question, nothing else: no pitch, no link, no credentials, no "I hope this finds you well". Warm, sharp, short.\n\n`+
`Prospect: ${lead.name}${lead.business?` — ${lead.business}`:''}${lead.segment?` (${lead.segment})`:''}\nLikely bottleneck: ${lead.bottleneck||'unknown'}\n\n`+
`Reply in EXACTLY this format, nothing else:\nSUBJECT: <short, not salesy>\nBODY: <2-4 sentences, ends on the question>`;
    let ok=false;
    try{ok=await sendFor(lead,prompt,stats,dailyEmails,'Auto-emailed opener');}
    catch{return;} // auth error bubbled up
    if(ok)await updateLead(lead.id,{stage:'contacted',next_touch:plusDays(4),next_action:'await reply / follow up'}).catch(()=>{});
  }
}

// --- 4. follow-ups --------------------------------------------------
async function followupPass(stats,dailyEmails){
  if(stats.sent>=dailyEmails)return;
  if(!(await googleConnected().catch(()=>false)))return;
  let due=[];
  try{due=await getLeadsDue(getTodayStr());}catch{return;}
  due=due.filter(l=>EMAIL_RE.test(String(l.contact||'').trim())&&['contacted','replied','qualifying'].includes(l.stage));
  for(const lead of due.slice(0,2)){
    if(stats.sent>=dailyEmails)break;
    const prompt=
`Write the NEXT follow-up email to this prospect — they haven't replied. Bring a NEW angle: a relevant example, a sharper version of the question, or a specific idea for their business. Never "just checking in". Short.\n\n`+
`Prospect: ${lead.name}${lead.business?` — ${lead.business}`:''}\nBottleneck: ${lead.bottleneck||'unknown'}\nThread so far:\n${String(lead.log||'').slice(0,600)}\n\n`+
`Reply EXACTLY:\nSUBJECT: <re: … or a fresh short line>\nBODY: <2-4 sentences>`;
    const touches=(String(lead.log||'').match(/emailed|follow-up/gi)||[]).length;
    let ok=false;
    try{ok=await sendFor(lead,prompt,stats,dailyEmails,'Auto follow-up sent');}
    catch{return;}
    if(ok)await updateLead(lead.id,touches>=3?{stage:'cold',next_touch:'',next_action:'went cold — no reply after 3 touches'}:{next_touch:plusDays(4)}).catch(()=>{});
  }
}

async function runOnce(){
  if(busy)return;
  busy=true;
  try{
    if((await getSetting('auto_scout','0'))!=='1'){stopAutoScout();return;}
    const dailyLeads=Math.max(1,parseInt(await getSetting('auto_scout_daily_leads','20'),10)||20);
    const dailyEmails=Math.max(0,parseInt(await getSetting('auto_scout_daily_emails','20'),10)||20);
    const stats=await loadStats();

    // Inbound (X + Hacker News, then Reddit) is the priority — it goes first
    // and claims the lead budget, with outbound prospecting filling whatever
    // room is left rather than the other way around.
    await inboundPass(stats,dailyLeads).catch(()=>{});
    await prospectPass(stats,dailyLeads).catch(()=>{});
    await outreachPass(stats,dailyEmails).catch(()=>{});
    await followupPass(stats,dailyEmails).catch(()=>{});

    await saveStats(stats);
    pushLeadsToSheet().catch(()=>{});

    if(Date.now()-lastHeartbeat>HEARTBEAT_MS){
      lastHeartbeat=Date.now();
      emit(`AUTO-SCOUT · alive — ${stats.added}/${dailyLeads} leads, ${stats.sent}/${dailyEmails} emails today`);
    }
  }catch(e){/* never let the loop throw */}
  finally{busy=false;}
}

export async function startAutoScout(){
  if(running)return;
  if((await getSetting('auto_scout','0'))!=='1')return;
  running=true;lastHeartbeat=0;
  const mins=Math.max(1,parseInt(await getSetting('auto_scout_interval_min','30'),10)||30);
  timer=setInterval(runOnce,mins*60000);
  setTimeout(()=>{runOnce();},9000);
  emit(`AUTO-SCOUT ON — prospecting the US every ${mins} min while the app is open. Cold emails send automatically, capped daily.`);
}
export function stopAutoScout(){
  running=false;lastHeartbeat=0;
  if(timer){clearInterval(timer);timer=null;}
}
export async function refreshAutoScout(){stopAutoScout();await startAutoScout();}
