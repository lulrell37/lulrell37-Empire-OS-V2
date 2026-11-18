// J.A.R.V.I.S.'s engine, from the app: his direct turns go to Claude Code on
// the Empire server (server/jarvisEngine.js, routes/jarvis.js), which works in
// the repo with its full toolset and answers as him. The app starts a job and
// polls it, so a long piece of work doesn't hang on one request.
//
// The turn's abort (he left the chat, sent something else, talked over him)
// only DETACHES from the job: Claude Code keeps working and, if the app isn't
// there to collect the answer, the server sends it on J.A.R.V.I.S.'s Telegram
// bot. Only the stop button (cancelJarvisTurn) kills the work. A restart on
// the server resumes the job itself and answers on Telegram.
import{loadBackend}from './keyStore';

const POLL_MS=2000;
let current=null; // {be,id} of the job this app is waiting on
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
  const detach=()=>{call(be,`/jarvis/ask/${id}/detach`,{method:'POST'}).catch(()=>{});};
  signal?.addEventListener?.('abort',detach);
  current={be,id};
  let last='',misses=0;
  try{
    for(;;){
      if(signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});
      await sleep(POLL_MS);
      let j;
      try{j=await call(be,`/jarvis/ask/${id}`,{signal});misses=0;}
      catch(e){
        if(e?.name==='AbortError')throw e;
        if(e.status===404)throw Object.assign(new Error('the server restarted mid-job, so I\'ll pick it back up and answer you on Telegram'),{continuing:true});
        if(++misses>=15){detach();throw Object.assign(new Error(`the app lost touch with the server (${e.message}), so I\'ll keep working and answer you on Telegram`),{continuing:true});}
        continue;
      }
      if(j.status==='running'){
        const line=`◇ ${j.progress||'Thinking'}…${j.secs>=20?` (${Math.round(j.secs)}s)`:''}`;
        if(line!==last){last=line;try{onStatus?.(line);}catch{}}
        continue;
      }
      if(j.status==='done'&&String(j.text||'').trim()){
        // Already sent on Telegram (the app was away), where its tags ran: show it
        // here without them, so a note or task isn't made twice.
        if(j.deliveredTo){
          const{stripCommands}=await import('./commandHandler');
          return `${(stripCommands(j.text)||j.text).trim()}\n\n(Also sent to you on Telegram while the app was away; its actions ran there.)`;
        }
        return j.text;
      }
      if(j.status==='cancelled')throw Object.assign(new Error('aborted'),{name:'AbortError'});
      throw new Error(j.error||'Claude Code came back empty');
    }
  }finally{
    signal?.removeEventListener?.('abort',detach);
    if(current?.id===id)current=null;
  }
}

// The stop button: actually stop the work on the server, not just stop waiting.
export function cancelJarvisTurn(){
  const c=current;current=null;
  if(c)call(c.be,`/jarvis/ask/${c.id}/cancel`,{method:'POST'}).catch(()=>{});
}
