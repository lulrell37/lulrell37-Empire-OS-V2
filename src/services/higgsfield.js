// Higgsfield generation — F.O.R.G.E. submits the page personas' prompts here and
// the finished media lands back in the Content queue on its own (contentJobs.js
// reconciles the jobs). Dormant until a Higgsfield key pair is set in
// Settings → KEYS.
//
// No training, no character IDs. Each page keeps a set of reference photos
// (uploaded to Higgsfield's CDN, URLs stored on the page). Every generation
// sends those reference photos + the MUSE's prompt straight to Higgsfield:
//   image / carousel  ->  /v1/text2image/soul  with image_reference
//   reel              ->  /v1/image2video/dop  with the photos as input_images
//
// v1 API (https://platform.higgsfield.ai): POST a job to a model endpoint, get
// back a job-set { id, jobs:[{status,results}] }, then GET /v1/job-sets/{id}
// until every job is completed (or one is failed / nsfw / canceled). Auth is a
// key id + secret pair sent as `hf-api-key` / `hf-secret` headers. Output URLs
// stay live ~7 days.
import*as FileSystem from 'expo-file-system';
import{loadKeys}from './keyStore';

const BASE='https://platform.higgsfield.ai';

// Instagram-shaped output. Soul has no true 4:5 — 1536x2048 (3:4) is the
// closest portrait; H.E.R.A.L.D. crops to 4:5 at publish. Reels follow the
// reference photos' aspect (DoP has no size param).
export const POST_SIZE='1536x2048';    // 3:4, the largest portrait Soul offers (≈ IG's 4:5)
export const SOUL_QUALITY='1080p';     // Soul's top quality tier
export const DOP_MODEL='dop-standard'; // image->video: highest-quality model

const clip=s=>String(s||'').slice(0,2000);

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

// --- reference media upload ---------------------------------------------
// Push a local image or video to Higgsfield's CDN; returns its public URL.
export async function uploadToHiggsfield(localUri,contentType='image/jpeg',key){
  const cred=key||await higgsfieldKey();
  if(!cred)throw new Error('No Higgsfield key.');
  const link=await hf('/files/generate-upload-url',{method:'POST',key:cred,body:{content_type:contentType}});
  const uploadUrl=link?.upload_url,publicUrl=link?.public_url;
  if(!uploadUrl||!publicUrl)throw new Error('Higgsfield returned no upload URL');
  const res=await FileSystem.uploadAsync(uploadUrl,localUri,{
    httpMethod:'PUT',
    uploadType:FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers:{'Content-Type':contentType},
  });
  if(res.status<200||res.status>=300)throw new Error(`upload failed (${res.status})`);
  return publicUrl;
}

// --- submit ------------------------------------------------------------
// Each returns the job-set id to poll with checkJobSet().
export async function submitImage(prompt,{size=POST_SIZE,batch=1,referenceUrl,key}={}){
  const params={prompt:clip(prompt),width_and_height:size,quality:SOUL_QUALITY,batch_size:batch};
  if(referenceUrl)params.image_reference={type:'image_url',image_url:referenceUrl};
  const j=await hf('/v1/text2image/soul',{method:'POST',key,body:{params}});
  return j?.id||null;
}
export async function submitVideo(prompt,referenceUrls,{key}={}){
  const imgs=(referenceUrls||[]).filter(Boolean).slice(0,4).map(u=>({type:'image_url',image_url:u}));
  if(!imgs.length)throw new Error('a reel needs at least one reference photo on the page');
  const j=await hf('/v1/image2video/dop',{method:'POST',key,body:{params:{
    model:DOP_MODEL,prompt:clip(prompt),input_images:imgs,
  }}});
  return j?.id||null;
}

// --- poll ------------------------------------------------------------
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
