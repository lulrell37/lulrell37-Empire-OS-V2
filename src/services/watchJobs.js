// Reconciles local watch_jobs against their GitHub issues — the same pattern as
// clipJobs.js. The empire-video-watch agent (GitHub Actions, in WATCH_REPO)
// leaves HTML-comment markers on the issue; this reads them and moves the local
// row along. Called on a timer while the Command screen is focused; returns
// events for the caller to surface.
import{getActiveWatchJobs,updateWatchJob}from './database';
import{getWatchActivity,WATCH_REPO}from './buildAgent';

const REPO=WATCH_REPO;

function scan(body){
  const b=String(body||'');
  const res=b.match(/<!--\s*watch-result:\s*([\s\S]*?)-->/i);
  if(res){try{const j=JSON.parse(res[1].trim());if(j&&(j.report||j.summary))return{kind:'done',report:j.report||'',summary:j.summary||''};}catch{}}
  const fail=b.match(/<!--\s*watch-failed:\s*([\s\S]*?)-->/i);
  if(fail)return{kind:'failed',note:fail[1].trim().slice(0,300)};
  if(/<!--\s*watch-status:\s*watching\s*-->/i.test(b))return{kind:'watching'};
  return null;
}

export async function pollWatchJobs(){
  let jobs;
  try{jobs=await getActiveWatchJobs();}catch{return[];}
  const events=[];

  for(const job of jobs){
    try{
      const{state,comments}=await getWatchActivity(job.issue_number,job.last_comment_id,REPO);
      let patch={};
      let maxId=job.last_comment_id||0;
      for(const c of comments){
        if(c.id>maxId)maxId=c.id;
        const s=scan(c.body);
        if(!s)continue;
        if(s.kind==='watching'&&job.status==='queued'){
          patch.status='watching';
          events.push(`— WATCH · the agent is watching your video —`);
        }else if(s.kind==='done'){
          patch={status:'done',report_url:s.report,summary:s.summary};
          events.push(`— WATCH · analysis ready 👁  ${s.summary||s.report} —`);
        }else if(s.kind==='failed'){
          patch={status:'failed',note:s.note};
          events.push(`— WATCH · couldn't watch it: ${s.note} —`);
        }
      }
      if(maxId!==job.last_comment_id)patch.last_comment_id=maxId;
      // Issue closed with no result marker → treat as cancelled.
      if(state==='closed'&&!patch.status&&job.status!=='done'&&job.status!=='failed'){
        patch.status='cancelled';
      }
      if(Object.keys(patch).length)await updateWatchJob(job.id,patch);
    }catch{/* transient GitHub error — try again next tick */}
  }
  return events;
}
