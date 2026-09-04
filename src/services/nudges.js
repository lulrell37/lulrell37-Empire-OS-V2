// Proactive nudges — distilled "act on this now" signals computed from local
// data (tasks, routine, streak, important dates). Surfaced both in the Command
// screen strip and injected into every persona's context so they can raise
// things before being asked. In-app only; real push needs expo-notifications.
import{getTasks,getHudState,getUpcomingDates,getActiveBuildJobs,getBuildJobs,getLeadsDue,getInboundLeads}from './database';

export async function computeNudges(){
  const out=[];
  const now=new Date();
  const today=now.toISOString().split('T')[0];
  const hour=now.getHours();

  try{
    const tasks=await getTasks();
    const overdue=tasks.filter(t=>t.due_date&&t.due_date<today);
    const dueToday=tasks.filter(t=>t.due_date===today);
    if(overdue.length)out.push({key:'overdue',text:`${overdue.length} task${overdue.length>1?'s':''} overdue`});
    if(dueToday.length)out.push({key:'today',text:`${dueToday.length} due today`});
  }catch{}

  try{
    const hud=await getHudState();
    if(hud){
      let done={},routine=[];
      try{done=JSON.parse(hud.morning_routine_done||'{}');}catch{}
      try{routine=JSON.parse(hud.morning_routine||'[]');}catch{}
      const items=(Array.isArray(routine)?routine:[]).map(r=>typeof r==='string'?{id:r,label:r}:r);
      const doneCount=items.filter(r=>done[r.id]).length;
      if(items.length&&hour>=14&&doneCount/items.length<0.6)out.push({key:'routine',text:`routine ${doneCount}/${items.length} — behind`});
      if(hour>=18&&(hud.empire_score||0)<75)out.push({key:'streak',text:`score ${hud.empire_score||0}% — streak at risk`});
    }
  }catch{}

  try{
    const d=await getUpcomingDates(3);
    for(const x of d)out.push({key:'date-'+x.id,text:`${x.label} ${x.daysOut===0?'today':x.daysOut===1?'tomorrow':`in ${x.daysOut}d`}`});
  }catch{}

  try{
    for(const j of await getActiveBuildJobs()){
      const tag=j.project_name?`the ${j.project_name} build`:`#${j.issue_number}`;
      if(j.state==='question')out.push({key:'build-q-'+(j.id||j.issue_number),text:`Claude Code needs your answer on ${tag}`});
      else if(j.state==='pr_open')out.push({key:'build-pr-'+(j.id||j.issue_number),text:`${j.project_name?j.project_name+': ':''}PR #${j.pr_number} ready to merge`});
    }
    // Builds that failed in the last few days — terminal, so not in the active
    // list, but still worth flagging until dismissed.
    const cutoff=Date.now()-3*86400000;
    for(const j of (await getBuildJobs(20)).filter(j=>j.state==='failed'&&(j.updated_at||0)>cutoff)){
      out.push({key:'build-fail-'+(j.id||j.issue_number),severity:'error',text:`${j.project_name?j.project_name+': ':''}build #${j.issue_number} failed — open it on GitHub`});
    }
  }catch{}

  try{
    const inbound=await getInboundLeads();
    if(inbound.length)out.push({key:'inbound-leads',text:`${inbound.length} inbound lead${inbound.length>1?'s':''} waiting — they came to you`});
  }catch{}

  try{
    const due=await getLeadsDue(today);
    for(const l of due.slice(0,4)){
      const overdue=l.next_touch<today;
      out.push({key:'lead-'+l.id,text:`${overdue?'overdue — ':''}follow up: ${l.name}`});
    }
  }catch{}

  return out;
}
