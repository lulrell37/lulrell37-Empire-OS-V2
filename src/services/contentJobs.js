// Reconciles content_items that are generating on Higgsfield — the same pattern
// as clipJobs.js / buildJobs.js. Called on a timer from the Command screen and
// while the Content queue is focused. Moves a row from 'awaiting_media' (with a
// gen_job_id) to 'needs_review' once Higgsfield finishes it.
import{getGeneratingContentItems,updateContentItem}from './database';
import{higgsfieldKey,checkJobSet}from './higgsfield';

let inFlight=false;

export async function pollContentJobs(){
  if(inFlight)return[];
  const key=await higgsfieldKey();
  if(!key)return[];
  let rows;
  try{rows=await getGeneratingContentItems();}catch{return[];}
  if(!rows.length)return[];

  inFlight=true;
  const events=[];
  try{
    for(const it of rows){
      try{
        const{status,media}=await checkJobSet(it.gen_job_id,key);
        if(status==='failed'||status==='nsfw'||status==='canceled'){
          await updateContentItem(it.id,{status:'failed',
            error:`Higgsfield ${status==='nsfw'?'flagged the result as NSFW':status}`});
          events.push(`— CONTENT · ${it.page} ${it.kind} generation ${status} —`);
          continue;
        }
        if(status!=='completed')continue;   // still cooking — check again next tick

        const first=media[0];
        if(!first?.url){
          await updateContentItem(it.id,{status:'failed',error:'Higgsfield finished with no media'});
          continue;
        }
        const type=(it.kind==='reel'||first.type==='video')?'video':'image';
        const patch={status:'needs_review',media_uri:first.url,media_type:type,error:''};
        if(media.length>1)patch.note=JSON.stringify({frames:media.map(m=>m.url)});
        await updateContentItem(it.id,patch);
        events.push(`— CONTENT · ${it.page} ${it.kind} ready to review —`);
      }catch(e){/* transient Higgsfield error — try again next tick */}
    }
  }finally{inFlight=false;}
  return events;
}
