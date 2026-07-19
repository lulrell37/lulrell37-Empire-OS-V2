import{addTask,completeTask,deleteTask,saveNote,getNote,addRevenue,getTasks,getHudState,updateHudState,checkRoutineItem}from './database';
export async function handleCommands(response,personaId,callbacks={}){
  for(const m of response.matchAll(/\[ADD_TASK:\s*([^|\]]+?)(?:\|([^|\]]+))?(?:\|([^\]]+))?\]/gi)){
    const title=m[1]?.trim();if(!title)continue;
    const id=await addTask(title,m[2]?.trim()||'',m[3]?.trim()||null);
    callbacks.onTaskAdded?.({id,title});
  }
  for(const m of response.matchAll(/\[COMPLETE_TASK:\s*([^\]]+)\]/gi)){
    const tasks=await getTasks(true);
    const task=tasks.find(t=>t.title.toLowerCase().includes(m[1].trim().toLowerCase()));
    if(task){await completeTask(task.id);callbacks.onTaskCompleted?.(task);}
  }
  for(const m of response.matchAll(/\[DELETE_TASK:\s*([^\]]+)\]/gi)){
    const tasks=await getTasks(true);
    const task=tasks.find(t=>t.title.toLowerCase().includes(m[1].trim().toLowerCase()));
    if(task){await deleteTask(task.id);callbacks.onTaskDeleted?.(task);}
  }
  for(const m of response.matchAll(/\[SAVE_NOTE:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    if(m[1]&&m[2])await saveNote(m[1].trim(),m[2].trim(),personaId);
  }
  for(const m of response.matchAll(/\[ADD_REVENUE:\s*([^|\]]+)\|([^|\]]+)(?:\|([^|\]]+))?(?:\|([^\]]+))?\]/gi)){
    const amount=parseFloat(m[2]);
    if(m[1]&&!isNaN(amount))await addRevenue(m[1].trim(),amount,m[3]?.trim()||'income',m[4]?.trim()||'');
  }
  for(const m of response.matchAll(/\[RELAY_TO:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    callbacks.onRelay?.({target:m[1].trim().toLowerCase(),message:m[2].trim()});
  }
  if(/\[READ_HUD\]/i.test(response)){const hud=await getHudState();callbacks.onHudRead?.(hud);}
  for(const m of response.matchAll(/\[UPDATE_HUD:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    await updateHudState({[m[1].trim()]:m[2].trim()});callbacks.onHudUpdated?.({field:m[1].trim(),value:m[2].trim()});
  }
  for(const m of response.matchAll(/\[UPDATE_SCORE:\s*(\d+)\]/gi)){
    await updateHudState({empire_score:parseInt(m[1])});callbacks.onScoreUpdated?.(parseInt(m[1]));
  }
  for(const m of response.matchAll(/\[ROUTINE_DONE:\s*([^\]]+)\]/gi)){
    const items=m[1].split(',').map(s=>s.trim()).filter(Boolean);
    for(const item of items){await checkRoutineItem(item,true);}
    callbacks.onRoutineDone?.(items);
  }
}
export function stripCommands(text){
  return text
    .replace(/\[ADD_TASK:[^\]]*\]/gi,'').replace(/\[COMPLETE_TASK:[^\]]*\]/gi,'')
    .replace(/\[DELETE_TASK:[^\]]*\]/gi,'').replace(/\[SAVE_NOTE:[^\]]*\]/gi,'')
    .replace(/\[READ_NOTE:[^\]]*\]/gi,'').replace(/\[ADD_REVENUE:[^\]]*\]/gi,'')
    .replace(/\[READ_HUD\]/gi,'').replace(/\[UPDATE_HUD:[^\]]*\]/gi,'')
    .replace(/\[UPDATE_SCORE:[^\]]*\]/gi,'').replace(/\[ROUTINE_DONE:[^\]]*\]/gi,'')
    .replace(/\[RELAY_TO:[^\]]*\]/gi,'').replace(/\[SEARCH_WEB:[^\]]*\]/gi,'')
    .replace(/\[READ_CALENDAR\]/gi,'').replace(/\[READ_EMAIL\]/gi,'')
    .replace(/\[SEND_SMS:[^\]]*\]/gi,'').trim();
}
