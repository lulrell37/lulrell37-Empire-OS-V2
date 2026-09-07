import{addTask,updateTask,completeTask,deleteTask,saveNote,getNote,addRevenue,getTasks,getHudState,updateHudState,setRoutineDone,addRoutineItem,removeRoutineItem,renameRoutineItem,setBatmanDay,getBusinessTargets,setBusinessTarget,setPanelLayout,addExpense,addImportantDate,addLead,updateLead,appendLeadLog,findLead,leadHasContact,pinMemory,unpinMemory,getPinnedMemories,getSetting,setSetting,addContentItem,updateContentItem,deleteContentItem,getContentItems}from './database';

// Resolve a content-item reference — full id or an 8-char prefix from a listing.
async function findContentByRef(ref){
  const raw=String(ref||'').trim();
  if(!raw)return null;
  const all=await getContentItems({}).catch(()=>[]);
  return all.find(x=>x.id===raw)||all.find(x=>x.id.startsWith(raw))||null;
}
import*as gtask from './googleClient';
import{openApp,openWebpage}from './appLauncher';
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
  // Every persona's own instructions teach [SAVE_NOTE], not the Drive-specific
  // [CREATE_NOTE]/[EDIT_NOTE] tags that only live in the generic GOOGLE block —
  // so a note "saved" was always landing in the app's local table, never in
  // Drive, no matter who asked or which persona wrote it. driveSaveNote writes
  // to Drive and edits an existing note in place (by title) rather than
  // duplicating it, so this one tag covers both create and edit for every
  // persona; fall back to the local note only when Drive isn't connected or
  // the write fails — mirrors [READ_NOTE]'s Drive-first/local-fallback in
  // googleCommands.js.
  for(const m of response.matchAll(/\[SAVE_NOTE:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    const title=m[1]?.trim(),content=m[2]?.trim();
    if(!title||!content)continue;
    try{await gtask.driveSaveNote({title,content});}
    catch{await saveNote(title,content,personaId);}
  }
  // S.C.R.I.B.E. and H.O.O.K. get dedicated create/edit verbs for their
  // deliverables — a script, a hook set — so the work is a first-class artifact
  // rather than a generic note. Both map to the same Drive create-or-edit path
  // as [SAVE_NOTE] (local note is the fallback when Drive isn't connected),
  // namespaced by a title prefix so each persona's library stays self-contained
  // and listable. CREATE and EDIT behave identically (create-or-overwrite by
  // title) — two verbs only so the intent reads clearly in the transcript. As
  // with [SAVE_NOTE], no literal ] may appear inside the tag.
  const ARTIFACT_NS={scribe:{verb:'SCRIPT',prefix:'Script'},hook:{verb:'HOOK',prefix:'Hook Set'}};
  if(ARTIFACT_NS[personaId]){
    const{verb,prefix}=ARTIFACT_NS[personaId];
    for(const m of response.matchAll(new RegExp(`\\[${verb}_(?:CREATE|EDIT):\\s*([^|\\]]+)\\|([^\\]]+)\\]`,'gi'))){
      const name=m[1]?.trim(),body=m[2]?.trim();
      if(!name||!body)continue;
      const title=`${prefix} — ${name}`;
      try{await gtask.driveSaveNote({title,content:body});}
      catch{await saveNote(title,body,personaId);}
    }
  }
  // [COUNCIL_IDEA: text] — the owner hands A.R.A. a strategy idea for the nightly
  // Empire Council to work through. Appended to the `council_ideas` app-setting
  // (a JSON list), which syncs to the backend where the 5am meeting reads it.
  // [COUNCIL_IDEAS_CLEAR] wipes the agenda.
  for(const m of response.matchAll(/\[COUNCIL_IDEA:\s*([^\]]+)\]/gi)){
    const text=m[1]?.trim();if(!text)continue;
    let list=[];try{list=JSON.parse((await getSetting('council_ideas',''))||'[]');}catch{}
    if(!Array.isArray(list))list=[];
    if(!list.some(i=>(typeof i==='string'?i:i.text||'').toLowerCase()===text.toLowerCase())){
      list.push({text,added_at:Date.now()});
      await setSetting('council_ideas',JSON.stringify(list));
      callbacks.onCouncilIdea?.({text});
    }
  }
  if(/\[COUNCIL_IDEAS_CLEAR\]/i.test(response)){
    await setSetting('council_ideas','[]');
  }
  // [COUNCIL_NOTE: text] — the owner leaves a freeform note on his own thinking
  // for the whole council to read and weigh before they answer at the next
  // meeting. Same synced app-setting shape as `council_ideas` (a JSON list);
  // [COUNCIL_NOTES_CLEAR] wipes it. The meeting surfaces the brief to every
  // persona and clears it once it's been used.
  for(const m of response.matchAll(/\[COUNCIL_NOTE:\s*([^\]]+)\]/gi)){
    const text=m[1]?.trim();if(!text)continue;
    let list=[];try{list=JSON.parse((await getSetting('council_notes',''))||'[]');}catch{}
    if(!Array.isArray(list))list=[];
    if(!list.some(i=>(typeof i==='string'?i:i.text||'').toLowerCase()===text.toLowerCase())){
      list.push({text,added_at:Date.now()});
      await setSetting('council_notes',JSON.stringify(list));
      callbacks.onCouncilNote?.({text});
    }
  }
  if(/\[COUNCIL_NOTES_CLEAR\]/i.test(response)){
    await setSetting('council_notes','[]');
  }
  // [COUNCIL_CONVENE] — the owner asks A.R.A. to run the Empire Council now,
  // off its 5am schedule. The callback force-syncs and fires the backend
  // meeting (a few minutes; lands the usual push + transcript note when done).
  if(/\[COUNCIL_CONVENE\]/i.test(response)){
    callbacks.onCouncilConvene?.();
  }
  // --- AI-influencer content pipeline ---------------------------------
  // A page persona (muse1/2/3) queues an item for ITS page. F.O.R.G.E. compiles
  // batches and H.E.R.A.L.D. publishes — those are handled in CommandScreen's
  // tool-injection pass since they return a result. Nothing posts without the
  // owner approving it in the Content screen.
  if(/^muse[123]$/.test(personaId)){
    for(const m of response.matchAll(/\[CONTENT_QUEUE:\s*([^|\]]*)\|([^|\]]*)\|([^|\]]*)\|([^|\]]*)(?:\|([^\]]*))?\]/gi)){
      const kind=(m[1]||'reel').trim().toLowerCase();
      const slot=(m[2]||'').trim();
      const prompt=(m[3]||'').trim();
      const caption=(m[4]||'').trim();
      const hashtags=(m[5]||'').trim();
      if(!prompt)continue;
      const id=await addContentItem({page:personaId,kind:['reel','image','carousel'].includes(kind)?kind:'reel',slot,prompt,caption,hashtags,status:'queued'});
      callbacks.onContentQueued?.({id,page:personaId,slot,kind});
    }
    for(const m of response.matchAll(/\[CONTENT_CAPTION:\s*([^|\]]+)\|([^\]]*)\]/gi)){
      const item=await findContentByRef(m[1].trim());
      if(item){await updateContentItem(item.id,{caption:m[2].trim()});callbacks.onContentEdited?.({id:item.id});}
    }
    for(const m of response.matchAll(/\[CONTENT_DROP:\s*([^\]]+)\]/gi)){
      const item=await findContentByRef(m[1].trim());
      if(item&&item.status!=='posted'){await deleteContentItem(item.id);callbacks.onContentDropped?.({id:item.id});}
    }
  }
  if(/\[OPEN_CONTENT\]/i.test(response))callbacks.onOpenContent?.();
  // [OPEN_APP: name] launches the actual app (Spotify, Instagram, Maps, Uber,
  // etc.) by its Android package — never a webpage fallback. [OPEN_WEBPAGE:
  // url] is the separate, explicit escape hatch for when a webpage genuinely
  // is what's wanted. Both fire-and-forget: no confirmation, no DB state.
  for(const m of response.matchAll(/\[OPEN_APP:\s*([^\]]+)\]/gi)){
    const name=m[1]?.trim();if(!name)continue;
    openApp(name).then(r=>{if(!r.ok)callbacks.onOpenAppFailed?.({name,reason:r.reason});}).catch(()=>{});
  }
  for(const m of response.matchAll(/\[OPEN_WEBPAGE:\s*([^\]]+)\]/gi)){
    const url=m[1]?.trim();if(!url)continue;
    openWebpage(url).then(r=>{if(!r.ok)callbacks.onOpenAppFailed?.({name:url,reason:r.reason});}).catch(()=>{});
  }
  for(const m of response.matchAll(/\[ADD_REVENUE:\s*([^|\]]+)\|([^|\]]+)(?:\|([^|\]]+))?(?:\|([^\]]+))?\]/gi)){
    const amount=parseFloat(m[2]);
    if(m[1]&&!isNaN(amount))await addRevenue(m[1].trim(),amount,m[3]?.trim()||'income',m[4]?.trim()||'');
  }
  for(const m of response.matchAll(/\[RELAY_TO:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    callbacks.onRelay?.({target:m[1].trim().toLowerCase(),message:m[2].trim()});
  }
  // --- THE FIRM — A.R.A. project orchestration ---
  // [PROJECT_START: name | brief] opens a client project; [PROJECT_DONE] closes it.
  // [DELEGATE: persona | task] is handled in CommandScreen.runRound (it calls the
  // specialist inline and feeds the result back to A.R.A.), not here.
  for(const m of response.matchAll(/\[PROJECT_START:\s*([\s\S]+?)\]/gi)){
    const parts=m[1].split('|').map(s=>s.trim());
    const name=parts[0];if(!name)continue;
    // target: "empire" (build into Empire OS V2) | "new" (dedicated repo) | "owner/repo"
    callbacks.onProjectStart?.({name,brief:parts[1]||'',target:(parts[2]||'').toLowerCase()});
  }
  if(/\[PROJECT_(?:DONE|CLOSE|COMPLETE|END)\]/i.test(response))callbacks.onProjectDone?.();
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
  // [TRADE_BREAKEVEN: positionId] — move that position's stop to entry.
  // Optional lock-in in price units: [TRADE_BREAKEVEN: id | 3.0] leaves the
  // stop 3.0 in profit. [TRADE_BREAKEVEN: all] does every open position.
  for(const m of response.matchAll(/\[TRADE_BREAKEVEN:\s*([A-Za-z0-9]+)\s*(?:\|\s*([0-9.]+))?\]/gi)){
    const off=m[2]?parseFloat(m[2]):0;
    callbacks.onTradeBreakeven?.({id:m[1].trim(),offset:isNaN(off)?0:off});
  }
  // [STRATEGY_UPDATE: full replacement text] — T.A.L.O.N. rewrites the trading playbook
  for(const m of response.matchAll(/\[STRATEGY_UPDATE:\s*([\s\S]+?)\]/gi)){
    if(m[1]?.trim())callbacks.onStrategyUpdate?.(m[1].trim());
  }
  // [TRADE_REVIEW: tradeId | one-line note] — T.A.L.O.N. annotates a closed trade
  for(const m of response.matchAll(/\[TRADE_REVIEW:\s*#?(\d+)\s*\|\s*([^\]]+)\]/gi)){
    callbacks.onTradeReview?.({id:parseInt(m[1],10),note:m[2].trim()});
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
  // --- The Canvas — a persona turns the orb screen into an interactive surface.
  // [SHOW_CHART], [SHOW_NOTES]/[SHOW_NOTE: title], [SHOW_TASKS]. All route to one
  // callback; CommandScreen animates it in (viz view) or drops a chip (chat).
  for(const m of response.matchAll(/\[SHOW_CHART:\s*([^\]]+)\]/gi)){
    if(m[1]?.trim())callbacks.onShowArtifact?.({kind:'chart',raw:m[1].trim()});
  }
  for(const m of response.matchAll(/\[SHOW_NOTE:\s*([^\]]+)\]/gi)){
    if(m[1]?.trim())callbacks.onShowArtifact?.({kind:'notes',open:m[1].trim()});
  }
  if(/\[SHOW_NOTES\]/i.test(response))callbacks.onShowArtifact?.({kind:'notes'});
  if(/\[SHOW_TASKS\]/i.test(response))callbacks.onShowArtifact?.({kind:'tasks'});
  // Auto-surface: if the persona went to BROWSE the note collection or the task
  // list to answer, and didn't already emit an explicit SHOW_ tag, put that
  // surface on the canvas too. Deliberately narrow — a bare [READ_NOTE] (reading
  // one note for its own reasoning) does NOT surface anything; only [LIST_NOTES]
  // / [SEARCH_DRIVE] ("show me my notes") and [READ_TASKS] do.
  if(!/\[SHOW_(?:CHART:|NOTE:|NOTES\]|TASKS\])/i.test(response)){
    if(/\[LIST_NOTES(?::[^\]]*)?\]|\[SEARCH_DRIVE:/i.test(response))callbacks.onShowArtifact?.({kind:'notes'});
    else if(/\[READ_TASKS\]/i.test(response))callbacks.onShowArtifact?.({kind:'tasks'});
  }
  for(const m of response.matchAll(/\[ADD_EXPENSE:\s*([^|\]]+)(?:\|([^|\]]+))?(?:\|([^\]]+))?\]/gi)){
    await addExpense(m[1],m[2]?.trim()||'general',m[3]?.trim()||'');
  }
  for(const m of response.matchAll(/\[ADD_DATE:\s*([^|\]]+)\|([^|\]]+)(?:\|([^\]]+))?\]/gi)){
    await addImportantDate(m[1].trim(),m[2].trim(),m[3]?.trim()||'');
  }
  // --- S.C.O.U.T. leads pipeline ---
  for(const m of response.matchAll(/\[LEAD_ADD:\s*([^\]]+)\]/gi)){
    const parts=m[1].split('|').map(s=>s.trim());
    const name=parts[0];
    if(!name)continue;
    const contact=parts[3]||'',segment=parts[5]||'';
    // Every lead needs a direct line — a phone or an email. The only exception
    // is an inbound social signal (segment "inbound-signal"), where the reply
    // happens on the platform the post is on.
    const isInboundSignal=/inbound[\s-]?signal/i.test(segment);
    if(!isInboundSignal&&!leadHasContact(contact)){
      callbacks.onLeadChange?.({action:'nocontact',name});
      continue;
    }
    const id=await addLead({name,business:parts[1]||'',website:parts[2]||'',contact,bottleneck:parts[4]||'',segment});
    callbacks.onLeadChange?.({action:'add',id,name});
  }
  for(const m of response.matchAll(/\[LEAD_UPDATE:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    const lead=await findLead(m[1].trim());
    if(!lead){callbacks.onLeadChange?.({action:'miss',ref:m[1].trim()});continue;}
    const patch={};
    for(const pair of m[2].split(';')){
      const eq=pair.indexOf('=');
      if(eq<0)continue;
      const k=pair.slice(0,eq).trim().toLowerCase();
      const v=pair.slice(eq+1).trim();
      if(k==='log'){await appendLeadLog(lead.id,v);continue;}
      if(['name','business','website','contact','bottleneck','segment','value','stage','next_action','next_touch'].includes(k))patch[k]=v;
    }
    if(Object.keys(patch).length)await updateLead(lead.id,patch);
    callbacks.onLeadChange?.({action:'update',id:lead.id,name:lead.name});
  }
  for(const m of response.matchAll(/\[LEAD_LOG:\s*([^|\]]+)\|([^\]]+)\]/gi)){
    const lead=await findLead(m[1].trim());
    if(!lead){callbacks.onLeadChange?.({action:'miss',ref:m[1].trim()});continue;}
    await appendLeadLog(lead.id,m[2].trim());
    callbacks.onLeadChange?.({action:'log',id:lead.id,name:lead.name});
  }
  // --- R.O.G.U.E. clip editing ---
  for(const m of response.matchAll(/\[EDIT_CLIP:\s*(\S+)\s*\|\s*([\s\S]+?)\]/gi)){
    const mediaUrl=m[1].trim();const instructions=m[2].trim();
    if(mediaUrl&&instructions)callbacks.onClipEdit?.({mediaUrl,instructions});
  }
  // --- Video watching (any persona) — focus is optional ---
  for(const m of response.matchAll(/\[WATCH_VIDEO:\s*(\S+)(?:\s*\|\s*([\s\S]+?))?\]/gi)){
    const mediaUrl=m[1].trim();const focus=(m[2]||'').trim();
    if(mediaUrl)callbacks.onWatchVideo?.({mediaUrl,focus});
  }
  // --- Pinned memory (any persona) ---
  for(const m of response.matchAll(/\[REMEMBER:\s*([^|\]]+?)(?:\s*\|\s*(\d+))?\]/gi)){
    const txt=m[1]?.trim();if(!txt)continue;
    const r=await pinMemory(personaId,txt,m[2]?parseInt(m[2],10):3);
    if(r)callbacks.onMemoryPinned?.({text:txt,days:r.days});
  }
  for(const m of response.matchAll(/\[UNPIN_MEMORY:\s*([^\]]+)\]/gi)){
    const q=m[1].trim().toLowerCase();if(!q)continue;
    const pins=await getPinnedMemories(personaId);
    const hit=pins.find(p=>String(p.content||'').toLowerCase().includes(q));
    if(hit){await unpinMemory(hit.id);callbacks.onMemoryUnpinned?.({text:q});}
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
    .replace(/\[SAVE_NOTE:[^\]]*\]/gi,'').replace(/\[OPEN_APP:[^\]]*\]/gi,'').replace(/\[OPEN_WEBPAGE:[^\]]*\]/gi,'')
    .replace(/\[READ_NOTE:[^\]]*\]/gi,'').replace(/\[ADD_REVENUE:[^\]]*\]/gi,'')
    .replace(/\[READ_HUD\]/gi,'').replace(/\[UPDATE_HUD:[^\]]*\]/gi,'')
    .replace(/\[UPDATE_SCORE:[^\]]*\]/gi,'').replace(/\[ROUTINE_DONE:[^\]]*\]/gi,'')
    .replace(/\[ROUTINE_ADD:[^\]]*\]/gi,'').replace(/\[ROUTINE_REMOVE:[^\]]*\]/gi,'')
    .replace(/\[ROUTINE_RENAME:[^\]]*\]/gi,'').replace(/\[BATMAN_SET:[^\]]*\]/gi,'')
    .replace(/\[SET_WORD:[^\]]*\]/gi,'').replace(/\[SET_VERSE:[^\]]*\]/gi,'')
    .replace(/\[SET_FACT:[^\]]*\]/gi,'').replace(/\[SET_TARGET:[^\]]*\]/gi,'')
    .replace(/\[HUD_DETACH:[^\]]*\]/gi,'').replace(/\[HUD_DOCK:[^\]]*\]/gi,'').replace(/\[DIAGRAM_SHOW:[^\]]*\]/gi,'')
    .replace(/\[RELAY_TO:[^\]]*\]/gi,'').replace(/\[SEARCH_WEB:[^\]]*\]/gi,'')
    .replace(/\[COUNCIL_IDEA:[^\]]*\]/gi,'').replace(/\[COUNCIL_IDEAS_CLEAR\]/gi,'')
    .replace(/\[COUNCIL_NOTE:[^\]]*\]/gi,'').replace(/\[COUNCIL_NOTES_CLEAR\]/gi,'').replace(/\[COUNCIL_CONVENE\]/gi,'')
    .replace(/\[PROJECT_START:[\s\S]*?\]/gi,'').replace(/\[DELEGATE:[^\]]*\]/gi,'')
    .replace(/\[PROJECT_(?:DONE|CLOSE|COMPLETE|END)\]/gi,'')
    .replace(/\[READ_CALENDAR\]/gi,'').replace(/\[READ_EMAIL\]/gi,'')
    .replace(/\[MEMORY_QUERY:[^\]]*\]/gi,'').replace(/\[DEEP_RESEARCH:[^\]]*\]/gi,'')
    .replace(/\[TRADE_SCAN(?::[^\]]*)?\]/gi,'').replace(/\[TRADE_PROPOSE:[^\]]*\]/gi,'').replace(/\[TRADE_CLOSE:[^\]]*\]/gi,'')
    .replace(/\[TRADE_BREAKEVEN:[^\]]*\]/gi,'')
    .replace(/\[STRATEGY_UPDATE:[\s\S]*?\]/gi,'').replace(/\[TRADE_REVIEW:[^\]]*\]/gi,'')
    .replace(/\[ADD_EXPENSE:[^\]]*\]/gi,'').replace(/\[ADD_DATE:[^\]]*\]/gi,'').replace(/\[EXPENSE_SUMMARY\]/gi,'')
    .replace(/\[LEAD_ADD:[^\]]*\]/gi,'').replace(/\[LEAD_UPDATE:[^\]]*\]/gi,'').replace(/\[LEAD_LOG:[^\]]*\]/gi,'')
    .replace(/\[LEAD_EMAIL:[^\]]*\]/gi,'').replace(/\[LEAD_LIST(?::[^\]]*)?\]/gi,'').replace(/\[LEADS\]/gi,'')
    .replace(/\[SCAN_INBOUND(?::[^\]]*)?\]/gi,'')
    .replace(/\[CONTENT_QUEUE:[^\]]*\]/gi,'').replace(/\[CONTENT_CAPTION:[^\]]*\]/gi,'').replace(/\[CONTENT_DROP:[^\]]*\]/gi,'')
    .replace(/\[CONTENT_LIST(?::[^\]]*)?\]/gi,'').replace(/\[BATCH_COMPILE(?::[^\]]*)?\]/gi,'').replace(/\[BATCH_STATUS\]/gi,'')
    .replace(/\[PUBLISH(_APPROVED)?(?::[^\]]*)?\]/gi,'').replace(/\[PUBLISH_STATUS\]/gi,'').replace(/\[OPEN_CONTENT\]/gi,'')
    .replace(/\[REMEMBER:[^\]]*\]/gi,'').replace(/\[UNPIN_MEMORY:[^\]]*\]/gi,'')
    .replace(/\[EDIT_CLIP:[^\]]*\]/gi,'')
    .replace(/\[WATCH_VIDEO:[^\]]*\]/gi,'')
    .replace(/\[SHOW_CHART:[^\]]*\]/gi,'').replace(/\[SHOW_NOTE:[^\]]*\]/gi,'')
    .replace(/\[SHOW_NOTES\]/gi,'').replace(/\[SHOW_TASKS\]/gi,'')
    .replace(/\[BUILD_REQUEST:[^\]]*\]/gi,'').replace(/\[BUILD_REPLY:[^\]]*\]/gi,'')
    .replace(/\[BUILD_MERGE:[^\]]*\]/gi,'').replace(/\[BUILD_CANCEL:[^\]]*\]/gi,'').replace(/\[BUILD_STATUS\]/gi,'')
    .replace(/\[SEND_SMS:[^\]]*\]/gi,'')
    .replace(/\[CREATE_EVENT:[^\]]*\]/gi,'').replace(/\[DELETE_EVENT:[^\]]*\]/gi,'')
    .replace(/\[LIST_NOTES(?::[^\]]*)?\]/gi,'').replace(/\[SEARCH_DRIVE:[^\]]*\]/gi,'')
    .replace(/\[READ_FILE_ID:[^\]]*\]/gi,'').replace(/\[CREATE_NOTE:[^\]]*\]/gi,'')
    .replace(/\[EDIT_NOTE:[^\]]*\]/gi,'').replace(/\[DELETE_FILE:[^\]]*\]/gi,'')
    .replace(/\[CREATE_SHEET:[^\]]*\]/gi,'').replace(/\[SEND_EMAIL:[^\]]*\]/gi,'')
    .replace(/\[(?:SCRIPT|HOOK)_(?:CREATE|EDIT|OPEN):[^\]]*\]/gi,'').replace(/\[(?:SCRIPTS|HOOKS)\]/gi,'')
    .replace(/\[READ_TASKS\]/gi,'').replace(/\[CREATE_TASK:[^\]]*\]/gi,'')
    .replace(/\[SET_REMINDER:[^\]]*\]/gi,'').replace(/\[SYNC_AND_SAVE\]/gi,'')
    .replace(/\[READ_CALENDAR(?::[^\]]*)?\]/gi,'').replace(/\[LIST_NOTES\]/gi,'')
    .trim();
}
