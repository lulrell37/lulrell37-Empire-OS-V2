// What the server's sentinel says is broken right now (server/sentinel.js,
// GET /sentinel): ElevenLabs out, an AI key out of credits, Google logged out,
// a Telegram bot down, a loop failing. The top strip shows these.
import{loadBackend}from './keyStore';

export async function fetchSentinel(){
  const be=await loadBackend();
  if(!be)return[];
  try{
    const res=await fetch(be.url+'/sentinel',{headers:{Authorization:'Bearer '+be.token}});
    if(!res.ok)return[];
    const j=await res.json();
    return Array.isArray(j.items)?j.items:[];
  }catch{return[];}
}
