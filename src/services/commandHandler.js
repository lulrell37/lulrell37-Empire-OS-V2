import{addTask,updateTask,completeTask,deleteTask,saveNote,getNote,addRevenue,getTasks,getHudState,updateHudState,setRoutineDone,addRoutineItem,removeRoutineItem,renameRoutineItem,setBatmanDay,getBusinessTargets,setBusinessTarget,setPanelLayout,addExpense,addImportantDate}from './database';
import*as gtask from './googleClient';
import useEmpireStore from '../store/useEmpireStore';
const HUD_PANELS=['briefing','businesses','tasks','routine','batman','daily'];
const PANEL_ALIASES=[['brief','briefing'],['business','businesses'],['revenue','businesses'],['empire','businesses'],['task','tasks'],['routine','routine'],['morning','routine'],['batman','batman'],['protocol','batman'],['training','batman'],['daily','daily'],['word','daily'],['verse','daily'],['fact','daily']];
function resolvePanel(s){
  const q=String(s||'').toLowerCase().trim();
  if(HUD_PANELS.includes(q))return q;
  for(const[k,v]of PANEL_ALIASES){if(q.includes(k))return v;}
  return null;
}
export async function handleCommands(response,personaId,callbacks={}){
  const hudChanged=()=>callbacks.onHudMutated?.();
  for(const m of response.matchAll(/\[ADD_TASK:\s*([^|\]]+?)(?:\|([^|\]]+))?(?:\|([^\]]+))?\]/gi)){
    const title=m[1]?.trim();if(!title)continue;
    const id=await addTask(title,m[2]?.trim()||'',m[3]?.trim()||null);
    callbacks.onTaskAdded?.({id,title});
  }
  // [CREATE_TASK: title | notes | due-date] — distinct from [ADD_TASK]; mirrors
  // to Google Tasks as well as the app's own synced task list.
  for(const m of response.matchAll(/\[CREATE_TASK:\s*([^|\]]+?)(?:\|([^|\]]+))?(?:\|([^\]]+))?\]/gi)){
    const title=m[1]?.trim();if(!title)continue;
    const notes=m[2]?.trim()||'',due=m[3]?.trim()||null;
    const id=await addTask(title,notes,due);
    callbacks.onTaskAdded?.({id,title});
    gtask.taskCreate({title,notes,due}).catch(()=>{});
  }
  for(const m of response.matchAll(/\[COMPLETE_TASK:\s*([^\]]+)\]/gi)){
    const name=m[1].trim();
    const tasks=await getTasks(true);
    const task=tasks.find(t=>t.title.toLowerCase().includes(name.toLowerCase()));
    if(task){await completeTask(task.id);callbacks.onTaskCompleted?.(task);}
    gtask.taskComplete(name).catch(()=>{}); // best-effort Google Tasks mirror (title-matched)
  }
  for(const m of response.matchAll(/\[DELETE_TASK:\s*([^\]]+)\]/gi)){
    const name=m[1].trim();
    const tasks=await getTasks(true);
    const task=tasks.find(t=>t.title.toLowerCase().includes(name.toLowerCase()));
    if(task){await deleteTask(task.id);callbacks.onTaskDeleted?.(task);}
    gtask.taskDelete(name).catch(()=>{}); // best-effort Google Tasks mirror
  }
  for(const m of response.matchAll(/\[TASK_EDIT:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    const tasks=await getTasks(true);
    const task=tasks.find(t=>t.title.toLowerCase().includes(m[1].trim().toLowerCase()));
    if(task){await updateTask(task.id,m[2].trim(),task.notes||'');callbacks.onTaskEdited?.(task);}
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
  // [TRADE_PROPOSE: SYMBOL | side | entry | stopLoss | takeProfit | qty | rationale]
  // SYMBOL is optional for backward compatibility; side must be buy/sell/long/short.
  for(const m of response.matchAll(/\[TRADE_PROPOSE:\s*(?:([A-Za-z0-9./]{3,12})\s*\|\s*)?(buy|sell|long|short)\s*\|([^|\]]+)\|([^|\]]+)\|([^|\]]+)\|([^|\]]+)\|([^\]]+)\]/gi)){
    const num=s=>{const v=parseFloat(String(s).replace(/[^0-9.\-]/g,''));return isNaN(v)?null:v;};
    const side=m[2].trim().toLowerCase();
    callbacks.onTradePropose?.({
      symbol:m[1]?m[1].trim().toUpperCase():'XAUUSD',
      side:side==='long'?'buy':side==='short'?'sell':side,
      entry:num(m[3]),stopLoss:num(m[4]),takeProfit:num(m[5]),
      qty:num(m[6])||1,rationale:m[7].trim(),
    });
  }
  for(const m of response.matchAll(/\[TRADE_CLOSE:\s*([^\]]+)\]/gi)){
    callbacks.onTradeClose?.(m[1].trim());
  }
  for(const m of response.matchAll(/\[DEEP_RESEARCH:\s*([^\]]+)\]/gi)){
    if(m[1]?.trim())callbacks.onDeepResearch?.(m[1].trim());
  }
  // --- JARVIS build pipeline ---
  for(const m of response.matchAll(/\[BUILD_REQUEST:\s*([^\]]+)\]/gi)){
    if(m[1]?.trim())callbacks.onBuildRequest?.({spec:m[1].trim()});
  }
  for(const m of response.matchAll(/\[BUILD_REPLY:\s*#?(\d+)\s*\|\s*([^\]]+)\]/gi)){
    callbacks.onBuildReply?.({issueNumber:parseInt(m[1],10),text:m[2].trim()});
  }
  for(const m of response.matchAll(/\[BUILD_MERGE:\s*#?(\d+)\]/gi)){
    callbacks.onBuildMerge?.({issueNumber:parseInt(m[1],10)});
  }
  for(const m of response.matchAll(/\[BUILD_CANCEL:\s*#?(\d+)\]/gi)){
    callbacks.onBuildCancel?.({issueNumber:parseInt(m[1],10)});
  }
  for(const m of response.matchAll(/\[SHOW_CHART:\s*([^\]]+)\]/gi)){
    if(m[1]?.trim())callbacks.onShowChart?.(m[1].trim());
  }
  for(const m of response.matchAll(/\[ADD_EXPENSE:\s*([^|\]]+)(?:\|([^|\]]+))?(?:\|([^\]]+))?\]/gi)){
    await addExpense(m[1],m[2]?.trim()||'general',m[3]?.trim()||'');
  }
  for(const m of response.matchAll(/\[ADD_DATE:\s*([^|\]]+)\|([^|\]]+)(?:\|([^\]]+))?\]/gi)){
    await addImportantDate(m[1].trim(),m[2].trim(),m[3]?.trim()||'');
  }
  if(/\[READ_HUD\]/i.test(response)){const hud=await getHudState();callbacks.onHudRead?.(hud);}
  for(const m of response.matchAll(/\[UPDATE_HUD:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    await updateHudState({[m[1].trim()]:m[2].trim()});hudChanged();callbacks.onHudUpdated?.({field:m[1].trim(),value:m[2].trim()});
  }
  for(const m of response.matchAll(/\[UPDATE_SCORE:\s*(\d+)\]/gi)){
    await updateHudState({empire_score:parseInt(m[1])});hudChanged();callbacks.onScoreUpdated?.(parseInt(m[1]));
  }
  for(const m of response.matchAll(/\[ROUTINE_DONE:\s*([^\]]+)\]/gi)){
    const items=m[1].split(',').map(s=>s.trim()).filter(Boolean);
    for(const item of items){await setRoutineDone(item,true);}
    hudChanged();callbacks.onRoutineDone?.(items);
  }
  for(const m of response.matchAll(/\[ROUTINE_ADD:\s*([^\]]+)\]/gi)){
    await addRoutineItem(m[1].trim());hudChanged();
  }
  for(const m of response.matchAll(/\[ROUTINE_REMOVE:\s*([^\]]+)\]/gi)){
    await removeRoutineItem(m[1].trim());hudChanged();
  }
  for(const m of response.matchAll(/\[ROUTINE_RENAME:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    await renameRoutineItem(m[1].trim(),m[2].trim());hudChanged();
  }
  for(const m of response.matchAll(/\[BATMAN_SET:\s*([^|\]]+)\|([^|\]]+)(?:\|([^\]]+))?\]/gi)){
    await setBatmanDay(m[1].trim(),m[2].trim(),m[3]!=null?m[3].trim():null);hudChanged();
  }
  for(const m of response.matchAll(/\[SET_WORD:\s*([^|\]]+)(?:\|([^|\]]*))?(?:\|([^\]]+))?\]/gi)){
    await updateHudState({word_of_day:m[1].trim(),word_phonetic:m[2]?.trim()||'',word_def:m[3]?.trim()||''});hudChanged();
  }
  for(const m of response.matchAll(/\[SET_VERSE:\s*([^|\]]+)(?:\|([^\]]+))?\]/gi)){
    await updateHudState({verse_of_day:m[1].trim(),verse_ref:m[2]?.trim()||''});hudChanged();
  }
  for(const m of response.matchAll(/\[SET_FACT:\s*([^\]]+)\]/gi)){
    await updateHudState({fact_of_day:m[1].trim()});hudChanged();
  }
  for(const m of response.matchAll(/\[HUD_DETACH:\s*([^\]]+)\]/gi)){
    const p=resolvePanel(m[1]);
    if(p){await setPanelLayout(p,{detached:1,x:24,y:24,z:Math.floor(Date.now()/1000)%100000});hudChanged();}
  }
  for(const m of response.matchAll(/\[HUD_DOCK:\s*([^\]]+)\]/gi)){
    const p=resolvePanel(m[1]);
    if(p){await setPanelLayout(p,{detached:0});hudChanged();}
  }
  for(const m of response.matchAll(/\[DIAGRAM_SHOW:\s*([^\]]+)\]/gi)){
    const subject=m[1].trim();
    if(subject){
      useEmpireStore.getState().setDiagramPrompt(subject);
      callbacks.onShowDiagram?.();
    }
  }
  for(const m of response.matchAll(/\[SET_TARGET:\s*([^|\]]+)\|([^|\]]+)(?:\|([^\]]+))?\]/gi)){
    const targets=await getBusinessTargets();
    const b=targets.find(x=>x.business.toLowerCase().includes(m[1].trim().toLowerCase()));
    if(b){
      const monthly=parseFloat(m[2]);
      const weekly=m[3]!=null?parseFloat(m[3]):NaN;
      await setBusinessTarget(b.business,isNaN(monthly)?b.target:monthly,isNaN(weekly)?b.week_goal:weekly);
      hudChanged();
    }
  }
}
export function stripCommands(text){
  return text
    .replace(/\[ADD_TASK:[^\]]*\]/gi,'').replace(/\[COMPLETE_TASK:[^\]]*\]/gi,'')
    .replace(/\[DELETE_TASK:[^\]]*\]/gi,'').replace(/\[TASK_EDIT:[^\]]*\]/gi,'')
    .replace(/\[SAVE_NOTE:[^\]]*\]/gi,'')
    .replace(/\[READ_NOTE:[^\]]*\]/gi,'').replace(/\[ADD_REVENUE:[^\]]*\]/gi,'')
    .replace(/\[READ_HUD\]/gi,'').replace(/\[UPDATE_HUD:[^\]]*\]/gi,'')
    .replace(/\[UPDATE_SCORE:[^\]]*\]/gi,'').replace(/\[ROUTINE_DONE:[^\]]*\]/gi,'')
    .replace(/\[ROUTINE_ADD:[^\]]*\]/gi,'').replace(/\[ROUTINE_REMOVE:[^\]]*\]/gi,'')
    .replace(/\[ROUTINE_RENAME:[^\]]*\]/gi,'').replace(/\[BATMAN_SET:[^\]]*\]/gi,'')
    .replace(/\[SET_WORD:[^\]]*\]/gi,'').replace(/\[SET_VERSE:[^\]]*\]/gi,'')
    .replace(/\[SET_FACT:[^\]]*\]/gi,'').replace(/\[SET_TARGET:[^\]]*\]/gi,'')
    .replace(/\[HUD_DETACH:[^\]]*\]/gi,'').replace(/\[HUD_DOCK:[^\]]*\]/gi,'').replace(/\[DIAGRAM_SHOW:[^\]]*\]/gi,'')
    .replace(/\[RELAY_TO:[^\]]*\]/gi,'').replace(/\[SEARCH_WEB:[^\]]*\]/gi,'')
    .replace(/\[READ_CALENDAR\]/gi,'').replace(/\[READ_EMAIL\]/gi,'')
    .replace(/\[MEMORY_QUERY:[^\]]*\]/gi,'').replace(/\[DEEP_RESEARCH:[^\]]*\]/gi,'')
    .replace(/\[TRADE_SCAN(?::[^\]]*)?\]/gi,'').replace(/\[TRADE_PROPOSE:[^\]]*\]/gi,'').replace(/\[TRADE_CLOSE:[^\]]*\]/gi,'')
    .replace(/\[ADD_EXPENSE:[^\]]*\]/gi,'').replace(/\[ADD_DATE:[^\]]*\]/gi,'').replace(/\[EXPENSE_SUMMARY\]/gi,'')
    .replace(/\[SHOW_CHART:[^\]]*\]/gi,'')
    .replace(/\[BUILD_REQUEST:[^\]]*\]/gi,'').replace(/\[BUILD_REPLY:[^\]]*\]/gi,'')
    .replace(/\[BUILD_MERGE:[^\]]*\]/gi,'').replace(/\[BUILD_CANCEL:[^\]]*\]/gi,'').replace(/\[BUILD_STATUS\]/gi,'')
    .replace(/\[SEND_SMS:[^\]]*\]/gi,'')
    .replace(/\[CREATE_EVENT:[^\]]*\]/gi,'').replace(/\[DELETE_EVENT:[^\]]*\]/gi,'')
    .replace(/\[LIST_NOTES(?::[^\]]*)?\]/gi,'').replace(/\[SEARCH_DRIVE:[^\]]*\]/gi,'')
    .replace(/\[READ_FILE_ID:[^\]]*\]/gi,'').replace(/\[CREATE_NOTE:[^\]]*\]/gi,'')
    .replace(/\[EDIT_NOTE:[^\]]*\]/gi,'').replace(/\[DELETE_FILE:[^\]]*\]/gi,'')
    .replace(/\[CREATE_SHEET:[^\]]*\]/gi,'').replace(/\[SEND_EMAIL:[^\]]*\]/gi,'')
    .replace(/\[READ_TASKS\]/gi,'').replace(/\[CREATE_TASK:[^\]]*\]/gi,'')
    .replace(/\[SET_REMINDER:[^\]]*\]/gi,'').replace(/\[SYNC_AND_SAVE\]/gi,'')
    .replace(/\[READ_CALENDAR(?::[^\]]*)?\]/gi,'').replace(/\[LIST_NOTES\]/gi,'')
    .trim();
}
