// Reconciles local build jobs against GitHub, the same way tradeJournal reconciles
// positions. Called on a timer while a screen is focused. Pure-ish: it updates
// the db and returns an events list for the caller to surface in the UI / chat.
import{getActiveBuildJobs,updateBuildJob}from './database';
import{getIssueActivity,findLinkedPR,getPRStatus}from './buildAgent';

// A Claude comment that asks for input rather than reporting a PR.
function looksLikeQuestion(body){
  const b=String(body||'');
  if(/github\.com\/[^\s]+\/pull\/\d+/.test(b))return false; // it's the PR announcement
  return b.includes('?');
}

export async function pollBuildJobs(){
  let jobs;
  try{jobs=await getActiveBuildJobs();}catch{return[];}
  const events=[];

  for(const job of jobs){
    const n=job.issue_number;
    try{
      // 1. New comments since we last looked.
      const fresh=await getIssueActivity(n,job.last_comment_id||0);
      if(fresh.length){
        await updateBuildJob(n,{last_comment_id:fresh[fresh.length-1].id});
        const claudeMsgs=fresh.filter(c=>c.isClaude&&c.body.trim());
        const lastClaude=claudeMsgs[claudeMsgs.length-1];
        if(lastClaude&&looksLikeQuestion(lastClaude.body)&&job.state!=='pr_open'&&job.state!=='pushed'){
          await updateBuildJob(n,{state:'question',question:lastClaude.body.slice(0,1200)});
          events.push({type:'question',job,text:lastClaude.body.trim()});
          continue; // wait for an answer before checking for a PR
        }
        if(job.state==='queued')await updateBuildJob(n,{state:'working'});
      }

      // 2. Is there a PR yet?
      if(!job.pr_number){
        const pr=await findLinkedPR(n);
        if(pr){
          if(pr.merged){
            await updateBuildJob(n,{pr_number:pr.prNumber,state:'pushed'});
            events.push({type:'pushed',job,text:`PR #${pr.prNumber} merged`});
          }else if(pr.state==='closed'){
            await updateBuildJob(n,{pr_number:pr.prNumber,state:'failed'});
            events.push({type:'failed',job,text:`PR #${pr.prNumber} was closed without merging`});
          }else{
            await updateBuildJob(n,{pr_number:pr.prNumber,state:'pr_open',question:null});
            events.push({type:'pr_open',job:{...job,pr_number:pr.prNumber},text:pr.title});
          }
        }
        continue;
      }

      // 3. Track an open PR (merged elsewhere, closed, CI failed).
      if(job.state==='pr_open'||job.state==='merging'){
        const st=await getPRStatus(job.pr_number);
        if(st.merged&&job.state!=='pushed'){
          await updateBuildJob(n,{state:'pushed'});
          events.push({type:'pushed',job,text:`PR #${job.pr_number} merged`});
        }else if(st.state==='closed'&&!st.merged){
          await updateBuildJob(n,{state:'failed'});
          events.push({type:'failed',job,text:`PR #${job.pr_number} was closed without merging`});
        }
      }
    }catch{/* transient GitHub / network error — try again next tick */}
  }
  return events;
}
