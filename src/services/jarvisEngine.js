// J.A.R.V.I.S.'s engine, from the app: his direct turns go to Claude Code on
// the Empire server (server/jarvisEngine.js, routes/jarvis.js), which works in
// the repo with its full toolset and answers as him. The app starts a job and
// polls it, so a long piece of work doesn't hang on one request.
import{loadBackend}from './keyStore';

const POLL_MS=2000;
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function call(be,path,{method='GET',body,signal}={}){
  const res=await fetch(be.url+path,{method,signal,
    headers:{Authorization:'Bearer '+be.token,...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw Object.assign(new Error(j.error||`server ${res.status}`),{status:res.status});
  return j;
}

// Resolves to his reply text. Throws (so the caller can use the plain model)
// when no server is linked, the engine is off, or the run failed.
// onStatus(line) gets what Claude Code is doing ("Reading server/x.js").
export async function jarvisEngineTurn(text,system,{signal,onStatus}={}){
  const be=await loadBackend();
  if(!be)throw new Error('no Empire server linked');
  const{id}=await call(be,'/jarvis/ask',{method:'POST',body:{text,system},signal});
  const cancel=()=>{call(be,`/jarvis/ask/${id}/cancel`,{method:'POST'}).catch(()=>{});};
  signal?.addEventListener?.('abort',cancel);
  let last='',misses=0;
  try{
    for(;;){
      if(signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});
      await sleep(POLL_MS);
      let j;
      try{j=await call(be,`/jarvis/ask/${id}`,{signal});misses=0;}
      catch(e){
        if(e?.name==='AbortError')throw e;
        if(e.status===404)throw new Error('the server lost the job (it restarted) — ask again');
        if(++misses>=15)throw new Error(`lost touch with the server (${e.message})`);
        continue;
      }
      if(j.status==='running'){
        const line=`◇ ${j.progress||'Thinking'}…${j.secs>=20?` (${Math.round(j.secs)}s)`:''}`;
        if(line!==last){last=line;try{onStatus?.(line);}catch{}}
        continue;
      }
      if(j.status==='done'&&String(j.text||'').trim())return j.text;
      if(j.status==='cancelled')throw Object.assign(new Error('aborted'),{name:'AbortError'});
      throw new Error(j.error||'Claude Code came back empty');
    }
  }finally{signal?.removeEventListener?.('abort',cancel);}
}
