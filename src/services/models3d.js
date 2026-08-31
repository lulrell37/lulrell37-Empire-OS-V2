// Text-to-3D generation for the HUD diagram card. Meshy preview mode: prompt in,
// GLB URL out in ~30-90s. Dormant until a Meshy key is set in Settings.
//
// This runs on-device for now; Item 4 moves the key and the polling to the
// backend and adds result caching so repeated prompts are instant.
import{loadKeys}from './keyStore';

const BASE='https://api.meshy.ai/openapi/v2/text-to-3d';

export async function hasMeshyKey(){
  const k=await loadKeys();
  return !!k?.meshy;
}

// Returns { url } where url is a downloadable .glb. onProgress(pct, status).
export async function generateModel(prompt,onProgress,signal){
  const k=await loadKeys();
  if(!k?.meshy)throw new Error('No Meshy API key — add it in Settings to generate models.');
  const headers={Authorization:'Bearer '+k.meshy,'Content-Type':'application/json'};

  const createRes=await fetch(BASE,{
    method:'POST',headers,signal,
    body:JSON.stringify({
      mode:'preview',
      prompt:String(prompt||'').slice(0,600),
      ai_model:'meshy-5',
      should_remesh:true,
      target_formats:['glb'],
    }),
  });
  if(!createRes.ok){
    const t=await createRes.text().catch(()=>'');
    throw new Error(`Meshy ${createRes.status}: ${t.slice(0,160)}`);
  }
  const created=await createRes.json();
  const taskId=created.result||created.id;
  if(!taskId)throw new Error('Meshy did not return a task id');

  const deadline=Date.now()+200000; // ~3.3 min
  while(Date.now()<deadline){
    if(signal?.aborted)throw new Error('cancelled');
    await new Promise(r=>setTimeout(r,4000));
    const pollRes=await fetch(`${BASE}/${taskId}`,{headers,signal});
    if(!pollRes.ok)continue;
    const task=await pollRes.json();
    if(typeof task.progress==='number')onProgress?.(task.progress,task.status);
    if(task.status==='SUCCEEDED'){
      const url=task.model_urls?.glb;
      if(!url)throw new Error('Meshy finished but returned no GLB');
      return{url,taskId};
    }
    if(task.status==='FAILED'||task.status==='CANCELED'){
      throw new Error(`Meshy task ${task.status}${task.task_error?.message?': '+task.task_error.message:''}`);
    }
  }
  throw new Error('Meshy generation timed out');
}
