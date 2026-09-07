// Higgsfield generation — F.O.R.G.E. submits the page personas' prompts here and
// the finished media lands back in the Content queue on its own (contentJobs.js
// reconciles the jobs). Dormant until a Higgsfield key pair is set in
// Settings → KEYS.
//
// No training, no character IDs. Each page keeps a set of reference photos
// (uploaded to Higgsfield's CDN, URLs stored on the page). Every generation
// sends those reference photos + the MUSE's prompt straight to Higgsfield:
//   image / carousel  ->  v2 /nano-banana  with the WHOLE set as input_images
//   reel              ->  v1 /v1/image2video/dop  with the photos as input_images
//
// Two API surfaces, one key pair:
//  - v1 (https://platform.higgsfield.ai): POST a job, get a job-set
//    { id, jobs:[{status,results}] }, poll GET /v1/job-sets/{id}. Used for reels
//    and for the reference-photo upload. hf-api-key / hf-secret headers.
//  - v2 (https://api.higgsfield.ai): POST a generation, get { request_id, status },
//    poll GET /requests/{request_id}/status. Used for Nano Banana stills, which
//    accept up to 8 reference images at once. `Authorization: Key <id>:<secret>`.
// checkJobSet() takes either id — a "nb:" prefix routes to v2. Output URLs stay
// live ~7 days.
import*as FileSystem from 'expo-file-system';
import{loadKeys}from './keyStore';

const BASE='https://platform.higgsfield.ai';   // v1 — reels (DoP image->video)
const BASE_V2='https://api.higgsfield.ai';     // v2 — stills (Nano Banana, multi-reference)

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

// v2 API (api.higgsfield.ai). Same key pair, sent the v2 way as
// `Authorization: Key <id>:<secret>` (the legacy hf-* headers are kept alongside
// since v2 still accepts them). A generation POST returns a { request_id, status }
// straight away; poll GET /requests/{id}/status until status is completed.
async function hf2(path,{method='GET',body,key}={}){
  const cred=key||await higgsfieldKey();
  if(!cred)throw new Error('No Higgsfield key — add the key ID + secret in Settings → KEYS.');
  const res=await fetch(BASE_V2+path,{
    method,
    headers:{
      'Authorization':`Key ${cred.id}:${cred.secret}`,
      'hf-api-key':cred.id,'hf-secret':cred.secret,
      'Content-Type':'application/json',
    },
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

// Map a v2 RequestStatus.status onto our shared job vocabulary.
function v2Status(s){
  return s==='completed'?'completed'
    :s==='failed'?'failed'
    :s==='nsfw'?'nsfw'
    :s==='canceled'?'canceled'
    :s==='in_progress'?'in_progress'
    :'queued';
}

// --- reference media upload ---------------------------------------------
// Push a local image or video to Higgsfield's CDN; returns its public URL.
export async function uploadToHiggsfield(localUri,contentType='image/jpeg',key){
  const cred=key||await higgsfieldKey();
  if(!cred)throw new Error('No Higgsfield key.');
  const link=await hf('/files/generate-upload-url',{method:'POST',key:cred,body:{content_type:contentType}});
  const uploadUrl=link?.upload_url,publicUrl=link?.public_url;
  if(!uploadUrl||!publicUrl)throw new Error('Higgsfield returned no upload URL');
  // The presigned PUT is signed over a specific set of headers (Content-Type,
  // x-amz-tagging, …). Replay every header Higgsfield hands back verbatim or the
  // storage layer rejects the signature with a 403. Do NOT add the API creds here.
  const signed=link?.upload_headers||{};
  const hasCT=Object.keys(signed).some(h=>h.toLowerCase()==='content-type');
  const putHeaders=hasCT?{...signed}:{'Content-Type':contentType,...signed};
  const res=await FileSystem.uploadAsync(uploadUrl,localUri,{
    httpMethod:'PUT',
    uploadType:FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers:putHeaders,
  });
  if(res.status<200||res.status>=300)throw new Error(`upload failed (${res.status}) ${String(res.body||'').slice(0,180)}`);
  return publicUrl;
}

// --- submit ------------------------------------------------------------
// Each returns the job-set id to poll with checkJobSet().
// Stills / carousels go through Nano Banana on the v2 API: it takes the WHOLE
// set of a page's reference photos (up to 8) as `input_images`, not just one, so
// face + body + wardrobe shots all inform the render. Returns "nb:<request_id>"
// — checkJobSet() routes that prefix to the v2 status endpoint.
export async function submitImage(prompt,{batch=1,referenceUrl,referenceUrls,aspectRatio='3:4',key}={}){
  const urls=(referenceUrls&&referenceUrls.length?referenceUrls:(referenceUrl?[referenceUrl]:[]))
    .filter(Boolean).slice(0,8);
  const j=await hf2('/nano-banana',{method:'POST',key,body:{
    prompt:clip(prompt),
    num_images:Math.min(4,Math.max(1,parseInt(batch,10)||1)),
    aspect_ratio:aspectRatio,
    input_images:urls.map(u=>({type:'image_url',image_url:u})),
    output_format:'jpeg',
  }});
  return j?.request_id?`nb:${j.request_id}`:null;
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
  // Nano Banana stills (v2) — "nb:<request_id>".
  if(String(jobSetId||'').startsWith('nb:')){
    const j=await hf2(`/requests/${String(jobSetId).slice(3)}/status`,{key});
    const media=[];
    for(const im of (Array.isArray(j?.images)?j.images:[])) if(im?.url)media.push({url:im.url,type:'image'});
    if(j?.video?.url)media.push({url:j.video.url,type:'video'});
    return{status:v2Status(j?.status),media};
  }
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
