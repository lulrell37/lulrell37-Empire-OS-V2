// R.O.G.U.E.'s [CLIP_SCAN: Drive link or YouTube URL | focus] in the app. The scan itself (Whisper →
// Claude → ffmpeg 9:16 cuts → Drive) runs on the Empire server
// (server/clipScan.js); this just starts it. The ranked list and the clips
// arrive on Telegram from A.R.A. when it's done.
import{loadBackend}from './keyStore';

// [TRANSCRIBE: link] — the server downloads and transcribes it, saves a Drive
// note, and sends the transcript on Telegram.
export async function startTranscribe({mediaUrl,persona}){
  const be=await loadBackend();
  if(!be)throw new Error('transcription runs on the Empire server, and no server is linked (Settings › Backend)');
  const res=await fetch(be.url+'/clips/transcribe',{method:'POST',
    headers:{Authorization:'Bearer '+be.token,'Content-Type':'application/json'},
    body:JSON.stringify({url:mediaUrl,persona:persona||'ara'})});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(j.error||`server ${res.status}`);
  return j;
}

// [NEED_FEATURE: what | why] — ask J.A.R.V.I.S. to build a missing ability (server/featureRequests.js).
export async function requestFeature({persona,need,asked}){
  const be=await loadBackend();
  if(!be)throw new Error('build requests run on the Empire server, and no server is linked (Settings › Backend)');
  const res=await fetch(be.url+'/features/request',{method:'POST',
    headers:{Authorization:'Bearer '+be.token,'Content-Type':'application/json'},
    body:JSON.stringify({persona,need,asked})});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(j.error||`server ${res.status}`);
  return j;
}

// Live forecast for A.R.A.'s prompt (server/morningBrief.js weatherLive). '' when unreachable.
export async function liveWeather(){
  const be=await loadBackend();
  if(!be)return '';
  const res=await fetch(be.url+'/weather/live',{headers:{Authorization:'Bearer '+be.token}});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(j.error||`server ${res.status}`);
  return j.text||'';
}

// [BROWSE: task] — J.A.R.V.I.S.'s and A.R.A.'s browser runs on the server
// (server/browserAgent.js). Starts the job, then polls until it ends (minutes).
// Returns the result text for the persona's second pass.
export async function runBrowse({persona,task,ownerText,signal,maxMs=65*60e3}){
  const be=await loadBackend();
  if(!be)throw new Error('the browser runs on the Empire server, and no server is linked (Settings › Backend)');
  const h={Authorization:'Bearer '+be.token,'Content-Type':'application/json'};
  const res=await fetch(be.url+'/browse',{method:'POST',headers:h,body:JSON.stringify({persona,task,ownerText:ownerText||''}),signal});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(j.error||`server ${res.status}`);
  const t0=Date.now();
  while(Date.now()-t0<maxMs){
    await new Promise(r=>setTimeout(r,4000));
    if(signal?.aborted)throw new Error('stopped');
    const p=await fetch(be.url+'/browse/'+j.id,{headers:h,signal}).then(x=>x.json()).catch(()=>null);
    if(p&&p.status&&p.status!=='running')return p.text;
  }
  return 'BROWSE: still running after an hour — the result will not come back into this chat; ask again in a moment.';
}

export async function startClipScan({mediaUrl,focus}){
  const be=await loadBackend();
  if(!be)throw new Error('clip scan runs on the Empire server, and no server is linked (Settings › Backend)');
  const res=await fetch(be.url+'/clips/scan',{method:'POST',
    headers:{Authorization:'Bearer '+be.token,'Content-Type':'application/json'},
    body:JSON.stringify({url:mediaUrl,focus:focus||''})});
  const j=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(j.error||`server ${res.status}`);
  return j;
}
