// Parses persona replies for Google command tags and runs them.
//
//   googleReadInjections(text)  -> string[]  (TOOL RESULT blocks for the
//                                  second-pass mechanism in CommandScreen)
//   googleWriteCommands(text,{onConfirm}) -> { immediate: string[], deferred }
//
// Read tags feed data back to the persona before it answers. Write tags either
// run immediately (create/edit) or are handed to onConfirm() for a confirmation
// card (send email, deletes). Any persona may use these — no gate.
import*as g from './googleClient';
import{addImportantDate,getTasks,getNote}from './database';
import{runSync}from './sync';

// ---- reads ---------------------------------------------------------------
export async function googleReadInjections(text){
  const out=[];
  const t=String(text||'');
  const push=async(label,fn)=>{
    try{out.push(await fn());}
    catch(e){out.push(`${label}: unavailable — ${e.message}`);}
  };

  if(/\[READ_EMAIL\]/i.test(t))await push('GMAIL',()=>g.gmailUnread());

  for(const m of t.matchAll(/\[READ_CALENDAR(?::\s*([^\]]+))?\]/ig)){
    const arg=(m[1]||'').trim();
    let opts={};
    if(arg){
      const parts=arg.split('|').map(s=>s.trim());
      if(parts.length>=2)opts={startISO:parts[0],days:parseInt(parts[1],10)||30};
      else if(/^\d+$/.test(parts[0]))opts={days:parseInt(parts[0],10)};
      else opts={startISO:parts[0]};
    }
    await push('GOOGLE CALENDAR',()=>g.calendarList(opts));
  }

  for(const m of t.matchAll(/\[LIST_NOTES(?::\s*(\d+))?\]/ig)){
    const n=m[1]?parseInt(m[1],10):30;
    await push('DRIVE',()=>g.driveList(n));
  }
  for(const m of t.matchAll(/\[SEARCH_DRIVE:\s*([^\]]+)\]/ig))
    await push('DRIVE SEARCH',()=>g.driveSearch(m[1].trim()));
  for(const m of t.matchAll(/\[READ_NOTE:\s*([^\]]+)\]/ig)){
    const name=m[1].trim();
    await push('NOTE',async()=>{
      try{return await g.driveRead({name});}
      catch(e){
        const local=await getNote(name).catch(()=>null);
        if(local)return `Note "${local.title}" (local):\n${(local.content||'').slice(0,4000)}`;
        throw e;
      }
    });
  }
  for(const m of t.matchAll(/\[READ_FILE_ID:\s*([^\]]+)\]/ig))
    await push('DRIVE FILE',()=>g.driveRead({fileId:m[1].trim()}));

  if(/\[READ_TASKS\]/i.test(t)){
    await push('TASKS',async()=>{
      let local='App tasks: (unavailable)';
      try{
        const rows=await getTasks();
        local=rows.length?'App tasks:\n'+rows.map(x=>`• ${x.title}`).join('\n'):'App tasks: none open.';
      }catch{}
      const gt=await g.tasksList().catch(e=>`Google Tasks: unavailable — ${e.message}`);
      return `${local}\n\n${gt}`;
    });
  }
  return out;
}

// ---- writes -------------------------------------------------------------
export async function googleWriteCommands(text,{onConfirm}={}){
  const t=String(text||'');
  const immediate=[];
  let deferred=0;
  const run=async(fn)=>{try{immediate.push(await fn());}catch(e){immediate.push(`⚠️ ${e.message}`);}};

  for(const m of t.matchAll(/\[CREATE_EVENT:\s*([^|\]]+)\|([^|\]]+)(?:\|([^\]]+))?\]/ig))
    await run(()=>g.calendarCreate({title:m[1].trim(),startISO:m[2].trim(),minutes:parseInt(m[3],10)||60}));

  for(const m of t.matchAll(/\[CREATE_NOTE:\s*([^|\]]+)\|([^\]]*)\]/ig))
    await run(()=>g.driveCreate({title:m[1].trim(),content:(m[2]||'').trim()}));

  for(const m of t.matchAll(/\[EDIT_NOTE:\s*([^|\]]+)\|([^\]]*)\]/ig))
    await run(()=>g.driveUpdate({fileId:m[1].trim(),content:(m[2]||'').trim()}));

  for(const m of t.matchAll(/\[CREATE_SHEET:\s*([^|\]]+)(?:\|([^|\]]*))?(?:\|([^\]]*))?\]/ig)){
    const cols=(m[2]||'').split(',').map(s=>s.trim()).filter(Boolean);
    const vals=(m[3]||'').split(',').map(s=>s.trim()).filter(Boolean);
    await run(()=>g.sheetCreate({title:m[1].trim(),columns:cols,values:vals}));
  }

  for(const m of t.matchAll(/\[SET_REMINDER:\s*([^|\]]+)\|([^\]]+)\]/ig))
    await run(async()=>{await addImportantDate(m[1].trim(),m[2].trim(),'');return `Reminder saved: ${m[1].trim()} — ${m[2].trim()}`;});

  if(/\[SYNC_AND_SAVE\]/i.test(t))
    await run(async()=>{const st=await runSync();return st?.error?`Sync failed: ${st.error}`:'Synced to the backend.';});

  // deferred — need a confirmation tap
  const defer=(a)=>{deferred++;onConfirm?.(a);};
  for(const m of t.matchAll(/\[SEND_EMAIL:\s*([^|\]]+)\|([^|\]]+)\|([^\]]+)\]/ig)){
    const to=m[1].trim(),subject=m[2].trim(),body=m[3].trim();
    defer({kind:'send_email',label:'Send email',detail:`To: ${to}\nSubject: ${subject}`,
      run:()=>g.gmailSend({to,subject,body})});
  }
  for(const m of t.matchAll(/\[DELETE_EVENT:\s*([^\]]+)\]/ig)){
    const id=m[1].trim();
    defer({kind:'delete_event',label:'Delete calendar event',detail:`Event id: ${id}`,run:()=>g.calendarDelete(id)});
  }
  for(const m of t.matchAll(/\[DELETE_FILE:\s*([^\]]+)\]/ig)){
    const id=m[1].trim();
    defer({kind:'delete_file',label:'Delete Drive file',detail:`File id: ${id}`,run:()=>g.driveDelete(id)});
  }

  return{immediate,deferred};
}
