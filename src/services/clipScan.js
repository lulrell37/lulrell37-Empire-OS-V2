// R.O.G.U.E.'s [CLIP_SCAN: link | focus] in the app. The scan itself (Whisper →
// Claude → ffmpeg 9:16 cuts → Drive) runs on the Empire server
// (server/clipScan.js); this just starts it. The ranked list and the clips
// arrive on Telegram from A.R.A. when it's done.
import{loadBackend}from './keyStore';

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
