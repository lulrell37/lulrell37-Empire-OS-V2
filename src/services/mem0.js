// Mem0 (hosted) — the persona memory layer. Each persona is a Mem0 `user_id`;
// Mem0 extracts and dedupes facts server-side, so the store stays small, and
// mem0Search returns just the handful relevant to the current message instead
// of the whole history. Everything here is best-effort: a failure returns
// nothing / does nothing so the caller falls back to the local persona_memory
// table. The key lives in Settings → KEYS (keyStore), never in the repo.
import{loadKeys}from './keyStore';
import useEmpireStore from '../store/useEmpireStore';

const BASE='https://api.mem0.ai';

// Surface Mem0 health to the top banner (NudgeBar). Called on every read; a
// success clears the flag, a failure raises a keyed issue so a fallback to the
// local memory table is never silent.
function report(ok,status){
  try{
    const st=useEmpireStore.getState();
    if(ok){st.clearFirmIssue('mem0');return;}
    if(status===401||status===403){
      st.flagFirmIssue('mem0','Mem0 key rejected — memory on local fallback',
        'The Mem0 API key in Settings → KEYS was rejected. Semantic recall is off; personas are running on the on-device memory table. Re-enter or rotate the key.','error');
    }else if(status===429){
      st.flagFirmIssue('mem0','Mem0 limit hit — memory on local fallback',
        'Mem0 reached its monthly request cap. Recall falls back to the on-device table until it resets, or raise the Mem0 plan.','error');
    }else{
      st.flagFirmIssue('mem0','Mem0 unreachable — memory on local fallback',
        `Couldn't reach Mem0 (${status||'network error'}). Using the on-device memory table for now; it'll clear on the next successful call.`,'warn');
    }
  }catch{}
}

let cachedKey;   // undefined = not loaded, '' = none set, string = the key
export function mem0ClearKeyCache(){cachedKey=undefined;}
async function key(){
  if(cachedKey!==undefined)return cachedKey;
  try{cachedKey=(await loadKeys())?.mem0||'';}catch{cachedKey='';}
  return cachedKey;
}
export async function mem0Enabled(){return!!(await key());}

const headers=k=>({Authorization:'Token '+k,'Content-Type':'application/json',Accept:'application/json'});

// Store one exchange (or any text) as a persona's memory. Mem0 does the fact
// extraction; we just hand it the raw text. Fire-and-forget, never throws.
export async function mem0Remember(personaId,text,meta={}){
  const k=await key();
  if(!k||!personaId)return;
  const t=String(text||'').trim();
  if(!t)return;
  try{
    const r=await fetch(BASE+'/v3/memories/add/',{
      method:'POST',headers:headers(k),
      body:JSON.stringify({user_id:personaId,messages:[{role:'user',content:t.slice(0,12000)}],metadata:{app:'empire-os',...meta}}),
    });
    // Only escalate the persistent, actionable failures from the write path —
    // the read path (mem0Search, once per turn) is the reliable health signal.
    if(r.status===401||r.status===403||r.status===429)report(false,r.status);
  }catch{}
}

// The facts most relevant to `query` for this persona. Returns [] on any
// failure. Each item: { id, memory, score, categories, created_at }.
export async function mem0Search(personaId,query,{topK=16,threshold=0.05}={}){
  const k=await key();
  const q=String(query||'').trim();
  if(!k||!personaId||!q)return[];
  try{
    const r=await fetch(BASE+'/v3/memories/search/',{
      method:'POST',headers:headers(k),
      body:JSON.stringify({query:q.slice(0,2000),filters:{user_id:personaId},top_k:topK,threshold}),
    });
    if(!r.ok){report(false,r.status);return[];}
    const d=await r.json();
    report(true);
    return Array.isArray(d?.results)?d.results:[];
  }catch{report(false,0);return[];}
}

// One-time import of the existing local persona_memory rows into Mem0. Throttled.
// onProgress(done, total). Returns { pushed, total }.
export async function mem0BackfillFromLocal(getDb,onProgress){
  const k=await key();
  if(!k)throw new Error('Add the Mem0 key first.');
  const db=getDb();
  const rows=await db.getAllAsync('SELECT persona,content,date FROM persona_memory ORDER BY created_at ASC');
  const total=rows.length;
  let pushed=0;
  for(const row of rows){
    const t=String(row.content||'').trim();
    if(t&&row.persona){
      try{
        await fetch(BASE+'/v3/memories/add/',{
          method:'POST',headers:headers(k),
          body:JSON.stringify({user_id:row.persona,messages:[{role:'user',content:t.slice(0,12000)}],metadata:{app:'empire-os',backfill:true,date:row.date||''}}),
        });
        pushed++;
      }catch{}
    }
    onProgress&&onProgress(pushed,total);
    await new Promise(r=>setTimeout(r,180));   // ~5/sec, gentle on the free tier
  }
  return{pushed,total};
}
