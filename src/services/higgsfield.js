// Higgsfield generation — F.O.R.G.E. submits the page personas' prompts here and
// the finished media lands back in the Content queue on its own (contentJobs.js
// reconciles the jobs). Dormant until a Higgsfield key pair is set in
// Settings → KEYS.
//
// v1 API (https://platform.higgsfield.ai): POST a job to a model endpoint, get
// back a job-set { id, jobs:[{status,results}] }, then GET /v1/job-sets/{id}
// until every job is completed (or one is failed / nsfw / canceled). Auth is a
// key id + secret pair sent as `hf-api-key` / `hf-secret` headers. Output URLs
// stay live ~7 days.
import{loadKeys}from './keyStore';

const BASE='https://platform.higgsfield.ai';

// Instagram-shaped output, at the largest size Soul offers for each ratio.
// Soul has no true 4:5 — 1152x1536 (3:4) is the closest portrait; H.E.R.A.L.D.
// crops to 4:5 at publish time. Reels are the tallest 9:16 Soul supports.
export const REEL_SIZE='1152x2048';    // 9:16, the largest Soul offers
export const POST_SIZE='1536x2048';    // 3:4, the largest portrait Soul offers (≈ IG's 4:5)
export const SOUL_QUALITY='1080p';     // Soul's top quality tier
export const DOP_MODEL='dop-standard'; // image->video: highest-quality model

export async function higgsfieldKey(){
  const k=await loadKeys();
  const id=(k?.hfKeyId||'').trim(),secret=(k?.hfKeySecret||'').trim();
  return id&&secret?{id,secret}:null;
}
export async function hasHiggsfieldKey(){return !!(await higgsfieldKey());}

async function hf(path,{method='GET',body,key}={}){
  const cred=key||await higgsfieldKey();
  if(!cred)throw new Error('No Higgsfield key — add the key ID + secret in Settings → KEYS.');
  const res=await fetch(BASE+path,{
    method,
    headers:{'hf-api-key':cred.id,'hf-secret':cred.secret,'Content-Type':'application/json'},
    body:body?JSON.stringify(body):undefined,
  });
  const text=await res.text().catch(()=>'');
  let json=null;try{json=text?JSON.parse(text):null;}catch{}
  if(!res.ok){
    const detail=json?.detail||json?.message||text||`HTTP ${res.status}`;
    throw new Error(`Higgsfield ${res.status}: ${String(detail).slice(0,180)}`);
  }
  return json;
}

// --- submit ---------------------------------------------------------------
// Each returns the job-set id to poll with checkJobSet().
// customReferenceId is the page's trained Higgsfield Soul ID — passing it here
// is what keeps every render for that page the same character.
export async function submitImage(prompt,{size=POST_SIZE,batch=1,customReferenceId,referenceStrength,key}={}){
  const params={
    prompt:String(prompt||'').slice(0,2000),
    width_and_height:size,
    quality:SOUL_QUALITY,
    batch_size:batch,
  };
  if(customReferenceId){
    params.custom_reference_id=String(customReferenceId).trim();
    params.custom_reference_strength=Number.isFinite(referenceStrength)?referenceStrength:0.8;
  }
  const j=await hf('/v1/text2image/soul',{method:'POST',key,body:{params}});
  return j?.id||null;
}
export async function submitVideo(prompt,imageUrl,{key}={}){
  const j=await hf('/v1/image2video/dop',{method:'POST',key,body:{params:{
    model:DOP_MODEL,
    prompt:String(prompt||'').slice(0,2000),
    input_images:[{type:'image_url',image_url:imageUrl}],
  }}});
  return j?.id||null;
}

// --- trained characters (Soul IDs) -------------------------------------
// Higgsfield's web app trains the character but doesn't surface its id; this
// lists them so a page can be assigned one. Returns [{id,name,status}].
export async function listSoulIds({page=1,pageSize=50,key}={}){
  const j=await hf(`/v1/custom-references/list?page=${page}&page_size=${pageSize}`,{key});
  const items=Array.isArray(j?.items)?j.items:Array.isArray(j)?j:[];
  return items.map(x=>({id:x.id,name:x.name||'(unnamed)',status:x.status||'ready'}));
}

// --- poll ----------------------------------------------------------------
// Returns { status, media:[{url,type}] }.
// status: queued | in_progress | completed | failed | nsfw | canceled
export async function checkJobSet(jobSetId,key){
  const j=await hf(`/v1/job-sets/${jobSetId}`,{key});
  const jobs=Array.isArray(j?.jobs)?j.jobs:[];
  const any=s=>jobs.some(x=>x.status===s);
  const status=any('failed')?'failed'
    :any('nsfw')?'nsfw'
    :any('canceled')?'canceled'
    :jobs.length&&jobs.every(x=>x.status==='completed')?'completed'
    :any('in_progress')?'in_progress'
    :'queued';
  const media=[];
  for(const job of jobs){
    const url=job?.results?.raw?.url||job?.results?.min?.url;
    if(url)media.push({url,type:job.results.raw?.type||'image'});
  }
  return{status,media};
}
