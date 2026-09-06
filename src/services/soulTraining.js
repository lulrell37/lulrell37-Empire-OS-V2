// Watches pages whose Soul ID is still training on Higgsfield and moves their
// soul_status forward in the content_pages config. Called on a timer from the
// Command screen and the Studio's Pages tab. Same shape as contentJobs.js.
import{getContentPages,setContentPages}from './database';
import{higgsfieldKey,checkSoulId}from './higgsfield';

const PAGES=['muse1','muse2','muse3'];
let inFlight=false;

export async function pollSoulTraining(){
  if(inFlight)return[];
  const key=await higgsfieldKey();
  if(!key)return[];
  let pages;
  try{pages=await getContentPages();}catch{return[];}
  const pending=PAGES.filter(p=>{
    const c=pages[p]||{};
    return c.soul_id&&c.soul_status&&c.soul_status!=='completed'&&c.soul_status!=='failed';
  });
  if(!pending.length)return[];

  inFlight=true;
  const events=[];
  try{
    const next={...pages};let changed=false;
    for(const p of pending){
      try{
        const r=await checkSoulId(next[p].soul_id,key);
        if(r.status&&r.status!==next[p].soul_status){
          next[p]={...next[p],soul_status:r.status};
          changed=true;
          if(r.status==='completed')events.push(`— CONTENT · ${next[p].name||p} character trained — ready to generate —`);
          else if(r.status==='failed')events.push(`— CONTENT · ${next[p].name||p} character training failed —`);
        }
      }catch{/* transient — next tick */}
    }
    if(changed)await setContentPages(next);
  }finally{inFlight=false;}
  return events;
}
