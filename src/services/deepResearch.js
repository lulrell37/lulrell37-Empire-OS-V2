// Deep Research orchestration — start, persist, poll, deliver.
//
// A job is a row in the `deep_research` table, so it survives closing the app:
// CommandScreen calls drGetActive() on launch and resumes polling. When the job
// completes, the result is written into the STARTING persona's own chat history
// (saveMessage) and memory — not wherever you happen to be looking — so it lands
// in the right place whether or not you stayed on that conversation.
//
// Everything still runs only while the app is open; there is no server. A job
// that never finishes is failed out after DR_TIMEOUT_MS.
import{drInsert,drUpdate,drGet,drActive,drRecent,getSetting,saveMessage,savePersonaMemory,saveNote}from './database';
import{deepResearchStart,deepResearchPoll}from './aiService';
import{getPersona}from '../personas/personas';

// Deliver a finished job exactly once — into the starting persona's chat, its
// memory, and a Note any persona can [READ_NOTE]. Guarded by the `delivered`
// flag so the poll/mount race can't skip it (or double it).
async function deliverResult(id,persona,topic,text){
  const row=await drGet(id).catch(()=>null);
  if(!row||row.delivered)return;
  const name=getPersona(persona).name;
  const body=String(text||'');
  if(!body)return;
  await saveMessage(persona,'assistant',body,'direct').catch(()=>{});
  await savePersonaMemory(persona,`YOU: [deep research] ${topic}\n${name}: ${body.slice(0,12000)}`).catch(()=>{});
  // A Note survives even if memory retrieval misses it, and it's cross-persona.
  await saveNote(`Deep Research — ${String(topic||'').slice(0,80)}`,
    `Deep research requested via ${name} on ${new Date().toLocaleDateString()}.\nTopic: ${topic}\n\n${body}`,persona).catch(()=>{});
  await drUpdate(id,{delivered:1}).catch(()=>{});
}

export const DR_POLL_MS=15000;
export const DR_TIMEOUT_MS=2*60*60*1000; // 2 hours

function parseProgress(row){
  if(!row?.progress)return{searches:0,step:''};
  try{return JSON.parse(row.progress);}catch{return{searches:0,step:''};}
}

// Start a job. Throws with a readable message if OpenAI rejects it.
export async function drStart({topic,persona,mode}){
  const existing=await drGetActive();
  if(existing)throw new Error('A deep research job is already running — one at a time.');
  const pref=await getSetting('deep_research_model','auto').catch(()=>'auto');
  const{id,model}=await deepResearchStart(topic,pref);
  const row={id,topic,persona:persona||'ara',mode:mode||'direct',model,status:'running',started_at:Date.now()};
  await drInsert(row).catch(()=>{});
  return row;
}

// The running job, or null. Times a stale job out.
export async function drGetActive(){
  const row=await drActive().catch(()=>null);
  if(!row)return null;
  if(Date.now()-(row.started_at||0)>DR_TIMEOUT_MS){
    await drUpdate(row.id,{status:'failed',error:'timed out after 2 hours',finished_at:Date.now()}).catch(()=>{});
    return{...row,status:'failed',error:'timed out after 2 hours'};
  }
  return{...row,progressObj:parseProgress(row)};
}

// Poll once. Returns { row, done, outcome }:
//   outcome 'completed' | 'failed' | 'cancelled' | null (still running)
// On completion/failure the DB row is closed out and, for completion, the
// result is saved into the persona's chat + memory here.
export async function drTick(row){
  // Another poll (or another mount) may have already finished this job. If the
  // persisted row is no longer 'running', don't poll or deliver again.
  const cur=await drGet(row.id).catch(()=>null);
  if(cur&&cur.status!=='running'){
    if(cur.status==='done')await deliverResult(row.id,row.persona,row.topic,cur.result).catch(()=>{});
    return{row:{...row,status:cur.status,result:cur.result,error:cur.error},done:true,
      outcome:cur.status==='done'?'completed':cur.status,alreadyHandled:true};
  }
  if(Date.now()-(row.started_at||0)>DR_TIMEOUT_MS){
    await drUpdate(row.id,{status:'failed',error:'timed out after 2 hours',finished_at:Date.now()}).catch(()=>{});
    return{row:{...row,status:'failed',error:'timed out after 2 hours'},done:true,outcome:'failed'};
  }
  let r;
  try{r=await deepResearchPoll(row.id);}
  catch{return{row,done:false,outcome:null};} // transient network/API blip — keep polling
  if(r.progress)await drUpdate(row.id,{progress:JSON.stringify(r.progress)}).catch(()=>{});

  if(r.status==='completed'){
    const claim=await drGet(row.id).catch(()=>null);
    if(claim&&claim.status!=='running'){
      if(claim.status==='done')await deliverResult(row.id,row.persona,row.topic,claim.result).catch(()=>{});
      return{row:{...row,status:claim.status,result:claim.result},done:true,outcome:'completed',alreadyHandled:true};
    }
    await drUpdate(row.id,{status:'done',result:r.text,finished_at:Date.now()}).catch(()=>{});
    await deliverResult(row.id,row.persona,row.topic,r.text).catch(()=>{});
    return{row:{...row,status:'done',result:r.text},done:true,outcome:'completed'};
  }
  if(r.status==='failed'||r.status==='cancelled'){
    await drUpdate(row.id,{status:r.status,error:r.error||'',finished_at:Date.now()}).catch(()=>{});
    return{row:{...row,status:r.status,error:r.error},done:true,outcome:r.status};
  }
  return{row:{...row,progressObj:r.progress||parseProgress(row)},done:false,outcome:null};
}

// User tapped ✕ — stop tracking it (OpenAI keeps running; result still gets
// saved to the persona's chat if a later poll ever catches it, but we stop).
export async function drDismiss(id){
  await drUpdate(id,{status:'dismissed',finished_at:Date.now()}).catch(()=>{});
}

export async function drHistory(n=8){return drRecent(n).catch(()=>[]);}

// Deliver any finished job that never made it into memory — e.g. it completed
// on a version before delivery was idempotent, or the app was closed at the
// moment it landed. Safe to call on every launch; the `delivered` flag stops
// repeats. Returns how many were delivered.
export async function drDeliverPending(){
  let rows=[];
  try{rows=await drRecent(25);}catch{return 0;}
  let n=0;
  for(const r of rows){
    if(r.status==='done'&&!r.delivered&&r.result){
      await deliverResult(r.id,r.persona,r.topic,r.result).catch(()=>{});
      n++;
    }
  }
  return n;
}

export function drElapsedLabel(startedAt){
  const s=Math.max(0,Math.floor((Date.now()-(startedAt||Date.now()))/1000));
  const m=Math.floor(s/60);
  return m<60?`${m}m ${String(s%60).padStart(2,'0')}s`:`${Math.floor(m/60)}h ${String(m%60).padStart(2,'0')}m`;
}
