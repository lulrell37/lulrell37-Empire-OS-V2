// Reconciles local build jobs against GitHub, the same way tradeJournal reconciles
// positions. Called on a timer while a screen is focused. Pure-ish: it updates
// the db and returns an events list for the caller to surface in the UI / chat.
// Each job carries its own repo (Empire OS V2 for app changes, a dedicated repo
// for a client project), so every GitHub call is scoped to job's repo.
import{getActiveBuildJobs,updateBuildJob,buildJobRepo}from './database';
import{getIssueActivity,findLinkedPR,openPRForIssue,getPRStatus}from './buildAgent';

// A Claude comment that asks for input rather than reporting a PR.
function looksLikeQuestion(body){
  const b=String(body||'');
  if(/github\.com\/[^\s]+\/pull\/\d+/.test(b))return false; // it's the PR announcement
  if(looksLikeFailure(b))return false;
  return b.includes('?');
}
// The Claude Code Action edits its comment to this when a run errors out
// (max turns, crash, timeout). No PR will come — surface it as a failure.
function looksLikeFailure(body){
  return /claude encountered an error|reached maximum number of turns|execution failed|\berror after \d/i.test(String(body||''));
}

// What actually happened, from the failure comment. Quick deaths never reached the
// model, so "make it smaller" would be wrong advice.
function failureText(body){
  const b=String(body||'');
  const reason=(b.match(/^Reason:\s*(.+)$/m)||[])[1];
  const why=reason?` Reason: ${reason.trim().slice(0,300)}`:'';
  if(/maximum number of turns|error_max_turns/i.test(b))return `Claude Code ran out of turns.${why} Re-file the request smaller, or tell me to retry.`;
  const secs=(b.match(/error after (\d+)s\b/i)||[])[1];
  if(secs&&Number(secs)<60)return `Claude Code died after ${secs}s, before doing any work, so the size of the request isn't the problem.${why||' Usually that means its sign-in or usage limit, so check the Actions log.'} Tell me to retry and I'll run it again.`;
  return `Claude Code stopped before finishing.${why} Tell me to retry, or check the Actions log.`;
}

export async function pollBuildJobs(){
  let jobs;
  try{jobs=await getActiveBuildJobs();}catch{return[];}
  const events=[];

  for(const job of jobs){
    const n=job.issue_number;
    const repo=buildJobRepo(job);
    try{
      // 1. New comments since we last looked.
      const fresh=await getIssueActivity(n,job.last_comment_id||0,repo);
      if(fresh.length){
        await updateBuildJob(job.id,{last_comment_id:fresh[fresh.length-1].id});
        const claudeMsgs=fresh.filter(c=>c.isClaude&&c.body.trim());
        const lastClaude=claudeMsgs[claudeMsgs.length-1];
        if(lastClaude&&looksLikeFailure(lastClaude.body)&&job.state!=='pr_open'&&job.state!=='pushed'){
          await updateBuildJob(job.id,{state:'failed'});
          events.push({type:'failed',job,text:failureText(lastClaude.body)});
          continue;
        }
        if(lastClaude&&looksLikeQuestion(lastClaude.body)&&job.state!=='pr_open'&&job.state!=='pushed'){
          await updateBuildJob(job.id,{state:'question',question:lastClaude.body.slice(0,1200)});
          events.push({type:'question',job,text:lastClaude.body.trim()});
          continue; // wait for an answer before checking for a PR
        }
        if(job.state==='queued')await updateBuildJob(job.id,{state:'working'});
      }

      // 1b. Stale catch — a build that's shown no activity at all for a long
      // time has almost certainly died silently (workflow never ran, auth blew
      // up before it could comment, etc.). Don't leave it stuck at "working".
      if((job.state==='queued'||job.state==='working')&&!job.pr_number){
        const idleMs=Date.now()-(job.updated_at||job.created_at||Date.now());
        if(idleMs>45*60*1000){
          await updateBuildJob(job.id,{state:'failed'});
          events.push({type:'failed',job,text:'No progress from Claude Code for 45+ minutes — the run likely failed to start or died. Check the repo’s Actions tab, then re-file.'});
          continue;
        }
      }

      // 2. Is there a PR yet?
      if(!job.pr_number){
        let pr=await findLinkedPR(n,repo);
        // The Action leaves a pushed branch without a PR when triggered on an
        // issue — open it ourselves so the merge flow can proceed.
        if(!pr){try{pr=await openPRForIssue(n,repo);}catch{/* no branch yet, or transient */}}
        if(pr){
          if(pr.merged){
            await updateBuildJob(job.id,{pr_number:pr.prNumber,state:'pushed'});
            events.push({type:'pushed',job,text:`PR #${pr.prNumber} merged`});
          }else if(pr.state==='closed'){
            await updateBuildJob(job.id,{pr_number:pr.prNumber,state:'failed'});
            events.push({type:'failed',job,text:`PR #${pr.prNumber} was closed without merging`});
          }else{
            await updateBuildJob(job.id,{pr_number:pr.prNumber,state:'pr_open',question:null});
            events.push({type:'pr_open',job:{...job,pr_number:pr.prNumber},text:pr.title});
          }
        }
        continue;
      }

      // 3. Track an open PR (merged elsewhere, closed, CI failed).
      if(job.state==='pr_open'||job.state==='merging'){
        const st=await getPRStatus(job.pr_number,repo);
        if(st.merged&&job.state!=='pushed'){
          await updateBuildJob(job.id,{state:'pushed'});
          events.push({type:'pushed',job,text:`PR #${job.pr_number} merged`});
        }else if(st.state==='closed'&&!st.merged){
          await updateBuildJob(job.id,{state:'failed'});
          events.push({type:'failed',job,text:`PR #${job.pr_number} was closed without merging`});
        }
      }
    }catch{/* transient GitHub / network error — try again next tick */}
  }
  return events;
}
