// The app's side of server/routes/chat.js: one conversation per persona, shared with
// Telegram (owner, 2026-11-27: "make the app like Telegram"). The server's thread is
// the record; the phone's own messages table is only the offline fallback and the
// unread badge, so a message is never shown twice.
//
//   fetchThread(pid, limit) -> [{ id, role, content, ts }] oldest first, or null when unreachable
//   pushMessage(pid, role, content)  fire-and-forget, into the shared thread
//   fetchAlerts(pid, limit) -> [{ id, content, ts, from }] newest first (the ◈ activity tab)
import{loadBackend}from './keyStore';

async function call(path,{method='GET',body,timeoutMs=6000}={}){
  const be=await loadBackend();
  if(!be)return null;
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),timeoutMs);
  try{
    const res=await fetch(be.url+path,{method,signal:ctl.signal,
      headers:{Authorization:'Bearer '+be.token,...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined});
    if(!res.ok)return null;
    return await res.json().catch(()=>null);
  }catch{return null;}
  finally{clearTimeout(timer);}
}

export async function fetchThread(pid,limit=40){
  const j=await call(`/chat/${encodeURIComponent(pid)}?limit=${limit}`);
  return j&&Array.isArray(j.messages)?j.messages:null;
}

// Retried once: a message that never reaches the server would be missing from the
// thread the next time the chat opens (it stays on the phone either way).
export function pushMessage(pid,role,content){
  const text=String(content||'').trim();
  if(!pid||!text)return;
  const body={role,content:text};
  call(`/chat/${encodeURIComponent(pid)}`,{method:'POST',body,timeoutMs:10000})
    .then(r=>r||new Promise(res=>setTimeout(res,5000)).then(()=>call(`/chat/${encodeURIComponent(pid)}`,{method:'POST',body,timeoutMs:10000})))
    .catch(()=>{});
}

export async function fetchAlerts(pid,limit=30){
  const j=await call(`/chat/${encodeURIComponent(pid)}/alerts?limit=${limit}`);
  return j&&Array.isArray(j.alerts)?j.alerts:null;
}
