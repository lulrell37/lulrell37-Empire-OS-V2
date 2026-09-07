// Reconciles local clip_jobs against their GitHub issues — the same pattern as
// buildJobs.js. The clip-editor agent (GitHub Actions, in CLIP_REPO) leaves
// HTML-comment markers on the issue; this reads them and moves the local row
// along. Called on a timer while the Command screen is focused; returns events
// for the caller to surface.
import{getActiveClipJobs,updateClipJob}from './database';
import{getClipActivity,CLIP_REPO}from './buildAgent';

const REPO=CLIP_REPO;

// The clip-editor Action times out at 30 min. If a job has sat in queued/editing
// well past that with no progress (no new comment, no status change — updated_at
// only moves when this poller actually advances the row), the run has almost
// certainly died mid-edit without leaving a clip-failed marker. Fail it locally
// so R.O.G.U.E. stops reporting it as still cutting and can offer another go.
const STALE_MS=45*60*1000;

function scan(body){
  const b=String(body||'');
  const res=b.match(/<!--\s*clip-result:\s*([\s\S]*?)-->/i);
  if(res){try{const j=JSON.parse(res[1].trim());if(j&&(j.download||j.share))return{kind:'done',download:j.download||'',share:j.share||''};}catch{}}
  const fail=b.match(/<!--\s*clip-failed:\s*([\s\S]*?)-->/i);
  if(fail){
    const note=fail[1].trim().slice(0,300);
    // A hosted-runner reclaim is transient — empire-clip-editor's clip-retry.yml
    // re-dispatches the job automatically, a few times. Treat those markers as
    // "still editing" so R.O.G.U.E. doesn't cry failure between attempts; only
    // the terminal "gave up" marker is a real failure.
    if(/reclaim|SIGTERM|hosted-runner|shutdown signal/i.test(note)&&!/gave up/i.test(note))return{kind:'editing'};
    return{kind:'failed',note};
  }
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
          patch.started_at=Date.now();   // anchor for the "time remaining" estimate
          events.push(`— R.O.G.U.E. · the editor is cutting your clip —`);
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
      // No result and no progress for far longer than the editor's own timeout —
      // the run stalled. Fail it so it stops showing as in-flight.
      if(!patch.status&&(job.status==='queued'||job.status==='editing')){
        const since=job.updated_at||job.created_at||0;
        if(since&&Date.now()-since>STALE_MS){
          const mins=Math.round((Date.now()-since)/60000);
          patch.status='failed';
          patch.note=`No word from the clip editor for ${mins} min — the run looks stalled. Send the clip again to retry.`;
          events.push(`— R.O.G.U.E. · the clip edit stalled — the editor never came back. Re-send it for another go. —`);
        }
      }
      if(Object.keys(patch).length)await updateClipJob(job.id,patch);
    }catch{/* transient GitHub error — try again next tick */}
  }
  return events;
}
