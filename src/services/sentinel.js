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

// J.A.R.V.I.S.'s workers (server/workers.js, GET /workers): each one's live step,
// percent (null = still planning), current plan step and plan [{name, done}], plus
// the ones that finished in the last 15 minutes. The top strip shows them.
export async function fetchWorkers(){
  const be=await loadBackend();
  if(!be)return[];
  try{
    const res=await fetch(be.url+'/workers',{headers:{Authorization:'Bearer '+be.token}});
    if(!res.ok)return[];
    const j=await res.json();
    return Array.isArray(j.items)?j.items:[];
  }catch{return[];}
}
