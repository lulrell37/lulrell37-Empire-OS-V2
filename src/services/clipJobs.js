// Reconciles local clip_jobs against their GitHub issues — the same pattern as
// buildJobs.js. The scheduled Descript agent leaves HTML-comment markers on the
// issue; this reads them and moves the local row along. Called on a timer while
// the Command screen is focused; returns events for the caller to surface.
import{getActiveClipJobs,updateClipJob,DEFAULT_BUILD_REPO}from './database';
import{getClipActivity}from './buildAgent';

const REPO={owner:DEFAULT_BUILD_REPO.owner,repo:DEFAULT_BUILD_REPO.repo};

function scan(body){
  const b=String(body||'');
  const res=b.match(/<!--\s*clip-result:\s*([\s\S]*?)-->/i);
  if(res){try{const j=JSON.parse(res[1].trim());if(j&&(j.download||j.share))return{kind:'done',download:j.download||'',share:j.share||''};}catch{}}
  const fail=b.match(/<!--\s*clip-failed:\s*([\s\S]*?)-->/i);
  if(fail)return{kind:'failed',note:fail[1].trim().slice(0,300)};
  if(/<!--\s*clip-status:\s*editing\s*-->/i.test(b))return{kind:'editing'};
  return null;
}

export async function pollClipJobs(){
  let jobs;
  try{jobs=await getActiveClipJobs();}catch{return[];}
  const events=[];

  for(const job of jobs){
    try{
      const{state,comments}=await getClipActivity(job.issue_number,job.last_comment_id,REPO);
      let patch={};
      let maxId=job.last_comment_id||0;
      for(const c of comments){
        if(c.id>maxId)maxId=c.id;
        const s=scan(c.body);
        if(!s)continue;
        if(s.kind==='editing'&&job.status==='queued'){
          patch.status='editing';
          events.push(`— R.O.G.U.E. · Descript is cutting your clip —`);
        }else if(s.kind==='done'){
          patch={status:'done',result_url:s.download,share_url:s.share};
          events.push(`— R.O.G.U.E. · clip ready ✂️  ${s.download||s.share} —`);
        }else if(s.kind==='failed'){
          patch={status:'failed',note:s.note};
          events.push(`— R.O.G.U.E. · clip edit failed: ${s.note} —`);
        }
      }
      if(maxId!==job.last_comment_id)patch.last_comment_id=maxId;
      // Issue closed with no result marker → treat as cancelled.
      if(state==='closed'&&!patch.status&&job.status!=='done'&&job.status!=='failed'){
        patch.status='cancelled';
      }
      if(Object.keys(patch).length)await updateClipJob(job.id,patch);
    }catch{/* transient GitHub error — try again next tick */}
  }
  return events;
}
