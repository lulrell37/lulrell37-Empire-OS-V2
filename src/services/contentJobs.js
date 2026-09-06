// Reconciles content_items that are generating on Higgsfield — the same pattern
// as clipJobs.js / buildJobs.js. Called on a timer from the Command screen and
// while the Content queue is focused. Moves a row from 'awaiting_media' (with a
// gen_job_id) to 'needs_review' once its media is ready. Reels do two passes: a
// still (gen_phase 'image'), then image->video (gen_phase 'video').
import{getGeneratingContentItems,updateContentItem}from './database';
import{higgsfieldKey,checkJobSet,submitVideo}from './higgsfield';

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
          await updateContentItem(it.id,{status:'failed',gen_phase:'',
            error:`Higgsfield ${status==='nsfw'?'flagged the result as NSFW':status}`});
          events.push(`— CONTENT · ${it.page} ${it.kind} generation ${status} —`);
          continue;
        }
        if(status!=='completed')continue;   // still cooking — check again next tick

        const first=media[0];
        if(!first?.url){
          await updateContentItem(it.id,{status:'failed',gen_phase:'',error:'Higgsfield finished with no media'});
          continue;
        }

        // Reel, still pass done → kick the image->video pass.
        if(it.kind==='reel'&&it.gen_phase==='image'){
          try{
            const vidJob=await submitVideo(it.prompt,first.url,{key});
            if(!vidJob)throw new Error('no job id');
            await updateContentItem(it.id,{gen_job_id:vidJob,gen_phase:'video',thumb_uri:first.url});
            events.push(`— CONTENT · ${it.page} reel still ready — animating —`);
          }catch(e){
            // Animation step failed — fall back to the still as the media.
            await updateContentItem(it.id,{status:'needs_review',media_uri:first.url,media_type:'image',
              gen_phase:'',error:'couldn’t animate — review the still: '+e.message});
          }
          continue;
        }

        // Post image, carousel, or a reel's finished video → ready to review.
        const type=(it.gen_phase==='video'||first.type==='video')?'video':'image';
        const patch={status:'needs_review',media_uri:first.url,media_type:type,gen_phase:'',error:''};
        if(media.length>1)patch.note=JSON.stringify({frames:media.map(m=>m.url)});
        await updateContentItem(it.id,patch);
        events.push(`— CONTENT · ${it.page} ${it.kind} ready to review —`);
      }catch(e){/* transient Higgsfield error — try again next tick */}
    }
  }finally{inFlight=false;}
  return events;
}
