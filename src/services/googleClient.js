// Device-side Google REST client. Uses the OAuth access token obtained by
// Settings -> GOOGLE (src/services/googleAuth.js). Every call auto-refreshes the
// token via getFreshGoogleToken(). Scopes granted at login: drive, gmail
// (readonly + send), calendar, tasks.
import{getFreshGoogleToken}from './googleAuth';
import*as FileSystem from 'expo-file-system';

const GBASE='https://www.googleapis.com';

// UTF-8 -> bytes without relying on TextEncoder (not guaranteed on Hermes/SDK 51).
function utf8Bytes(str){
  const out=[];
  for(let i=0;i<str.length;i++){
    let c=str.charCodeAt(i);
    if(c<0x80)out.push(c);
    else if(c<0x800)out.push(0xc0|(c>>6),0x80|(c&0x3f));
    else if(c>=0xd800&&c<0xdc00){
      const c2=str.charCodeAt(++i);
      c=0x10000+((c&0x3ff)<<10)+(c2&0x3ff);
      out.push(0xf0|(c>>18),0x80|((c>>12)&0x3f),0x80|((c>>6)&0x3f),0x80|(c&0x3f));
    }else out.push(0xe0|(c>>12),0x80|((c>>6)&0x3f),0x80|(c&0x3f));
  }
  return out;
}
function b64url(str){
  const bytes=utf8Bytes(str);
  let bin='';
  for(let i=0;i<bytes.length;i+=8192)bin+=String.fromCharCode.apply(null,bytes.slice(i,i+8192));
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function gapi(path,opts={}){
  const{method='GET',query,json,body,headers,base=GBASE,raw=false}=opts;
  const token=await getFreshGoogleToken();
  if(!token)throw new Error('Google not connected — link it in Settings → GOOGLE');
  let url=path.startsWith('http')?path:base+path;
  if(query){
    const parts=[];
    for(const[k,v]of Object.entries(query)){
      if(v==null)continue;
      const arr=Array.isArray(v)?v:[v];
      for(const x of arr)parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(x)}`);
    }
    if(parts.length)url+=(url.includes('?')?'&':'?')+parts.join('&');
  }
  const h={Authorization:'Bearer '+token,...(headers||{})};
  let payload;
  if(json!==undefined){h['Content-Type']=h['Content-Type']||'application/json';payload=JSON.stringify(json);}
  else if(body!==undefined)payload=body;
  const res=await fetch(url,{method,headers:h,body:payload});
  if(res.status===401)throw new Error('Google auth expired — reconnect in Settings → GOOGLE');
  if(!res.ok){
    const t=await res.text().catch(()=>'');
    throw new Error(`Google API ${res.status}: ${t.slice(0,160)}`);
  }
  if(res.status===204)return null;
  if(raw)return await res.text();
  const ct=(res.headers.get('content-type')||'');
  return ct.includes('json')?await res.json():await res.text();
}

export async function googleConnected(){
  try{return !!(await getFreshGoogleToken());}catch{return false;}
}

// --- Structured reads for the HUD (arrays, not the AI-facing strings) -------

export async function gmailUnreadList(max=6){
  const list=await gapi('/gmail/v1/users/me/messages',{query:{q:'is:unread in:inbox',maxResults:max}});
  const ids=(list.messages||[]).map(m=>m.id);
  const total=list.resultSizeEstimate??ids.length;
  const rows=[];
  for(const id of ids){
    try{
      const m=await gapi(`/gmail/v1/users/me/messages/${id}`,{query:{format:'metadata',metadataHeaders:['From','Subject']}});
      const hdr={};
      for(const x of(m.payload?.headers||[]))hdr[x.name.toLowerCase()]=x.value;
      const from=(hdr.from||'').replace(/\s*<[^>]*>/,'').replace(/"/g,'').trim()||hdr.from||'?';
      rows.push({from,subject:hdr.subject||'(no subject)',snippet:(m.snippet||'').slice(0,120)});
    }catch{}
  }
  return{count:total,messages:rows};
}

export async function calendarEvents({days=3}={}){
  const start=new Date();
  const data=await gapi('/calendar/v3/calendars/primary/events',{query:{
    timeMin:start.toISOString(),timeMax:new Date(start.getTime()+days*86400000).toISOString(),
    singleEvents:'true',orderBy:'startTime',maxResults:12,
  }});
  return(data.items||[]).map(e=>{
    const iso=e.start?.dateTime||e.start?.date;
    const d=new Date(iso);
    const allDay=!e.start?.dateTime;
    const now=new Date();
    const sameDay=d.toDateString()===now.toDateString();
    const when=allDay
      ?(sameDay?'Today':d.toLocaleDateString('en-US',{weekday:'short',day:'numeric'}))+' · all day'
      :(sameDay?'':d.toLocaleDateString('en-US',{weekday:'short'})+' ')+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    return{when,title:e.summary||'(no title)',location:e.location||'',allDay,ts:d.getTime()};
  });
}

export async function tasksListRaw(){
  try{
    const data=await gapi('/tasks/v1/lists/@default/tasks',{query:{showCompleted:'false',maxResults:100}});
    return(data.items||[]).filter(t=>t.status!=='completed').map(t=>({title:t.title||'',due:t.due?t.due.slice(0,10):null}));
  }catch{return[];}
}

// --- Google Tasks, for the HUD tasks panel (real ids, two-way) --------------
// Just the open tasks. (Do NOT pass completedMin — the Tasks API treats it as a
// filter and drops every not-yet-done task, which left the panel empty.)
export async function hudTasksList(){
  const data=await gapi('/tasks/v1/lists/@default/tasks',{query:{showCompleted:'false',maxResults:100}});
  return(data.items||[])
    .filter(t=>t.status!=='completed')
    .map(t=>({id:t.id,title:t.title||'',due:t.due?t.due.slice(0,10):null,completed:false}));
}
export async function hudTaskCreate(title){
  const j=await gapi('/tasks/v1/lists/@default/tasks',{method:'POST',json:{title:String(title||'').trim()}});
  return{id:j.id,title:j.title};
}
export async function hudTaskSetDone(id,done){
  await gapi(`/tasks/v1/lists/@default/tasks/${id}`,{method:'PATCH',json:{status:done?'completed':'needsAction'}});
}
export async function hudTaskRename(id,title){
  await gapi(`/tasks/v1/lists/@default/tasks/${id}`,{method:'PATCH',json:{title:String(title||'').trim()}});
}
export async function hudTaskDelete(id){
  await gapi(`/tasks/v1/lists/@default/tasks/${id}`,{method:'DELETE'});
}

// --- Gmail -----------------------------------------------------------------
export async function gmailUnread(max=10){
  const list=await gapi('/gmail/v1/users/me/messages',{query:{q:'is:unread in:inbox',maxResults:max}});
  const ids=(list.messages||[]).map(m=>m.id);
  if(!ids.length)return 'Inbox: no unread messages.';
  const rows=[];
  for(const id of ids){
    try{
      const m=await gapi(`/gmail/v1/users/me/messages/${id}`,{query:{format:'metadata',metadataHeaders:['From','Subject','Date']}});
      const hdr={};
      for(const x of(m.payload?.headers||[]))hdr[x.name.toLowerCase()]=x.value;
      rows.push(`• ${hdr.from||'?'} — ${hdr.subject||'(no subject)'}\n  ${(m.snippet||'').slice(0,150)}`);
    }catch{}
  }
  return `Inbox — ${rows.length} unread:\n`+rows.join('\n');
}

export async function gmailSend({to,subject,body}){
  if(!to)throw new Error('no recipient');
  const mime=[
    `To: ${to}`,
    `Subject: ${subject||'(no subject)'}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body||'',
  ].join('\r\n');
  await gapi('/gmail/v1/users/me/messages/send',{method:'POST',json:{raw:b64url(mime)}});
  return `Email sent to ${to}.`;
}

// --- Calendar ------------------------------------------------------------------
export async function calendarList({startISO,days=7}={}){
  const start=startISO?new Date(startISO):new Date();
  if(isNaN(start))throw new Error('bad start date: '+startISO);
  const end=new Date(start.getTime()+days*86400000);
  const data=await gapi('/calendar/v3/calendars/primary/events',{query:{
    timeMin:start.toISOString(),timeMax:end.toISOString(),
    singleEvents:'true',orderBy:'startTime',maxResults:25,
  }});
  const items=data.items||[];
  if(!items.length)return `Calendar: nothing scheduled in the next ${days} days.`;
  const rows=items.map(e=>{
    const s=e.start?.dateTime||e.start?.date;
    const d=new Date(s);
    const when=e.start?.date
      ?d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'})+' (all day)'
      :d.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
    return `• ${when} — ${e.summary||'(no title)'}${e.location?' @ '+e.location:''}  [id:${e.id}]`;
  });
  return `Calendar (next ${days} days):\n`+rows.join('\n');
}

export async function calendarCreate({title,startISO,minutes=60}){
  if(!title||!startISO)throw new Error('need a title and a start time');
  const start=new Date(startISO);
  if(isNaN(start))throw new Error('bad start time: '+startISO);
  const end=new Date(start.getTime()+(minutes||60)*60000);
  await gapi('/calendar/v3/calendars/primary/events',{method:'POST',json:{
    summary:title,start:{dateTime:start.toISOString()},end:{dateTime:end.toISOString()},
  }});
  return `Calendar: "${title}" set for ${start.toLocaleString('en-US',{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}.`;
}

export async function calendarDelete(eventId){
  if(!eventId)throw new Error('no event id');
  await gapi(`/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,{method:'DELETE'});
  return 'Calendar: event deleted.';
}

// --- Drive ("notes" = text/plain files + Google Docs) -------------------------
export async function driveList(max=30){
  const data=await gapi('/drive/v3/files',{query:{
    q:"trashed=false and (mimeType='text/plain' or mimeType='application/vnd.google-apps.document')",
    orderBy:'modifiedTime desc',pageSize:max,fields:'files(id,name,mimeType,modifiedTime)',
  }});
  const files=data.files||[];
  if(!files.length)return 'Drive: no notes found.';
  return `Drive notes (${files.length}):\n`+files.map(f=>`• ${f.name}  [id:${f.id}]`).join('\n');
}

export async function driveSearch(kw){
  if(!kw)throw new Error('no search term');
  const esc=kw.replace(/'/g,"\\'");
  const data=await gapi('/drive/v3/files',{query:{
    q:`trashed=false and (name contains '${esc}' or fullText contains '${esc}')`,
    pageSize:20,fields:'files(id,name,mimeType,modifiedTime)',
  }});
  const files=data.files||[];
  if(!files.length)return `Drive: nothing matches "${kw}".`;
  return `Drive matches for "${kw}":\n`+files.map(f=>`• ${f.name}  [id:${f.id}]`).join('\n');
}

async function driveFindByName(name){
  const esc=name.replace(/'/g,"\\'");
  const data=await gapi('/drive/v3/files',{query:{
    q:`trashed=false and name contains '${esc}'`,pageSize:5,fields:'files(id,name,mimeType)',
  }});
  const files=data.files||[];
  // Prefer an exact (case-insensitive) title match over Drive's loose "contains"
  // search, so editing "Trip Plan" doesn't land on "Trip Plan — Backup" instead.
  return files.find(f=>f.name.toLowerCase()===name.toLowerCase())||files[0]||null;
}

// Long documents are paged so one read can't blow out the context window.
// page = 1,2,3… returns that PAGE_CHARS-sized slice; page='all' returns the
// whole doc up to ALL_CAP. The footer tells the caller how to get the rest.
const PAGE_CHARS=16000;
const ALL_CAP=60000;
export async function driveRead({name,fileId,page=1}){
  let file=null;
  if(fileId)file=await gapi(`/drive/v3/files/${fileId}`,{query:{fields:'id,name,mimeType'}});
  else if(name){
    file=await driveFindByName(name);
    if(!file)throw new Error(`no Drive note named "${name}"`);
  }else throw new Error('need a note name or file id');
  let text;
  if(file.mimeType==='application/vnd.google-apps.document')
    text=await gapi(`/drive/v3/files/${file.id}/export`,{query:{mimeType:'text/plain'},raw:true});
  else
    text=await gapi(`/drive/v3/files/${file.id}`,{query:{alt:'media'},raw:true});
  return sliceDoc(`Note "${file.name}" [id:${file.id}]`,text||'',page,name||file.name);
}

// Shared by driveRead and the local-note fallback in googleCommands.js.
export function sliceDoc(header,full,page,refName){
  const total=full.length;
  const ref=refName||(header.match(/"([^"]+)"/)||[])[1]||'the note';
  if(String(page).toLowerCase()==='all'){
    const body=full.slice(0,ALL_CAP);
    const tail=total>ALL_CAP?`\n\n[--- truncated at ${ALL_CAP.toLocaleString()} of ${total.toLocaleString()} chars; ask again by section name for the rest ---]`:'';
    return `${header} — full document, ${total.toLocaleString()} chars:\n${body}${tail}`;
  }
  const p=Math.max(1,parseInt(page,10)||1);
  const start=(p-1)*PAGE_CHARS;
  if(start>=total&&total>0)return `${header} — page ${p} is past the end (document is ${total.toLocaleString()} chars, ${Math.ceil(total/PAGE_CHARS)} page(s)).`;
  const body=full.slice(start,start+PAGE_CHARS);
  const pages=Math.max(1,Math.ceil(total/PAGE_CHARS));
  let foot='';
  if(pages>1){
    const remaining=Math.max(0,total-(start+body.length));
    foot=remaining>0
      ? `\n\n[--- page ${p}/${pages}, ${remaining.toLocaleString()} chars remain. Re-issue the same read tag for "${ref}" with " | ${p+1}" for the next page, or " | all" for the whole document. ---]`
      : `\n\n[--- page ${p}/${pages} — end of document ---]`;
  }
  return `${header}${pages>1?` — page ${p}/${pages}`:''}:\n${body}${foot}`;
}

export async function driveCreate({title,content}){
  if(!title)throw new Error('no title');
  const boundary='empireos'+Date.now();
  const meta={name:title,mimeType:'text/plain'};
  const body=
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`+
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content||''}\r\n`+
    `--${boundary}--`;
  const f=await gapi('/upload/drive/v3/files',{
    method:'POST',query:{uploadType:'multipart'},
    headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body,
  });
  return `Drive: note "${title}" created  [id:${f.id}]`;
}

// Create-or-update by title: what every persona's [SAVE_NOTE] actually needs
// — a note with this title should be written the first time and edited in
// place after that, not duplicated. Falls back to a fresh file if the name
// lookup itself fails (still better than losing the write).
export async function driveSaveNote({title,content}){
  if(!title)throw new Error('no title');
  const existing=await driveFindByName(title).catch(()=>null);
  if(existing)return driveUpdate({fileId:existing.id,content}).then(()=>`Drive: note "${title}" updated  [id:${existing.id}]`);
  return driveCreate({title,content});
}

export async function driveUpdate({fileId,content}){
  if(!fileId)throw new Error('no file id');
  await gapi(`/upload/drive/v3/files/${fileId}`,{
    method:'PATCH',query:{uploadType:'media'},
    headers:{'Content-Type':'text/plain'},body:content||'',
  });
  return 'Drive: note updated.';
}

export async function driveDelete(fileId){
  if(!fileId)throw new Error('no file id');
  await gapi(`/drive/v3/files/${fileId}`,{method:'DELETE'});
  return 'Drive: file deleted.';
}

// Resumable upload of a local file (a phone video) to Drive, then make it
// link-shareable. Streams the bytes straight off disk — nothing large is held
// in JS memory. `onProgress(0..1)` is optional. Returns { id, viewLink, downloadLink }.
export async function driveUploadFile({fileUri,name,mimeType='video/mp4'},onProgress){
  const token=await getFreshGoogleToken();
  if(!token)throw new Error('Google not connected — link it in Settings → GOOGLE');
  const info=await FileSystem.getInfoAsync(fileUri).catch(()=>({exists:false}));
  if(!info.exists)throw new Error('clip file not found on device');

  const start=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',{
    method:'POST',
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json; charset=UTF-8','X-Upload-Content-Type':mimeType},
    body:JSON.stringify({name:name||`clip-${Date.now()}.mp4`,mimeType}),
  });
  if(!start.ok)throw new Error(`Drive upload start ${start.status}: ${(await start.text()).slice(0,120)}`);
  const session=start.headers.get('location')||start.headers.get('Location');
  if(!session)throw new Error('Drive: no resumable session URL returned');

  const task=FileSystem.createUploadTask(session,fileUri,{
    httpMethod:'PUT',
    uploadType:FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers:{'Content-Type':mimeType},
  },(p)=>{
    if(onProgress&&p.totalBytesExpectedToSend>0)onProgress(p.totalBytesSent/p.totalBytesExpectedToSend);
  });
  const res=await task.uploadAsync();
  if(!res||res.status<200||res.status>=300)throw new Error(`Drive upload failed (${res?.status||'no response'})`);
  const id=JSON.parse(res.body||'{}').id;
  if(!id)throw new Error('Drive: upload returned no file id');

  await gapi(`/drive/v3/files/${id}/permissions`,{method:'POST',json:{role:'reader',type:'anyone'}}).catch(()=>{});
  return{
    id,
    viewLink:`https://drive.google.com/file/d/${id}/view`,
    downloadLink:`https://drive.google.com/uc?export=download&id=${id}`,
  };
}

// --- Sheets (the broad drive scope covers the Sheets API) --------------------
export async function sheetCreate({title,columns=[],values=[]}){
  const ss=await gapi('https://sheets.googleapis.com/v4/spreadsheets',{
    method:'POST',json:{properties:{title:title||'Untitled'}},
  });
  const rows=[];
  if(columns.length)rows.push(columns);
  if(values.length)rows.push(values);
  if(rows.length){
    await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${ss.spreadsheetId}/values/A1:append`,{
      method:'POST',query:{valueInputOption:'USER_ENTERED'},json:{values:rows},
    });
  }
  return `Sheets: "${title}" created — ${ss.spreadsheetUrl}`;
}

// Read a value range from a spreadsheet — used by the inbound-leads poller to
// pull Google Form responses (they land in a "Form Responses" sheet).
export async function sheetRead({spreadsheetId,range='A1:Z2000'}){
  if(!spreadsheetId)throw new Error('no spreadsheet id');
  const data=await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,{});
  return data?.values||[];
}

// Create a blank spreadsheet — returns { id, url }.
export async function sheetCreateRaw(title){
  const ss=await gapi('https://sheets.googleapis.com/v4/spreadsheets',{method:'POST',json:{properties:{title:title||'Untitled'}}});
  return{id:ss.spreadsheetId,url:ss.spreadsheetUrl};
}
function colLetter(n){let s='';while(n>0){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26);}return s;}
// Overwrite the first sheet with `rows` (a 2D array). Clears the old range first
// so deleted leads don't linger. One-way mirror — user edits don't flow back.
export async function sheetReplace(spreadsheetId,rows){
  if(!spreadsheetId)throw new Error('no spreadsheet id');
  await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/A1:Z100000:clear`,{method:'POST',json:{}});
  if(!rows.length)return;
  const end=colLetter(Math.max(1,...rows.map(r=>r.length)));
  await gapi(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/A1:${end}${rows.length}`,{
    method:'PUT',query:{valueInputOption:'RAW'},json:{values:rows},
  });
}

// --- Google Tasks -----------------------------------------------------------
export async function tasksList(){
  const data=await gapi('/tasks/v1/lists/@default/tasks',{query:{showCompleted:'false',maxResults:100}});
  const items=(data.items||[]).filter(t=>t.status!=='completed');
  if(!items.length)return 'Google Tasks: none open.';
  return 'Google Tasks:\n'+items.map(t=>`• ${t.title}${t.due?' (due '+t.due.slice(0,10)+')':''}`).join('\n');
}

async function findGTask(idOrTitle){
  const data=await gapi('/tasks/v1/lists/@default/tasks',{query:{maxResults:100}});
  const items=data.items||[];
  const q=String(idOrTitle||'').toLowerCase();
  return items.find(t=>t.id===idOrTitle)||items.find(t=>(t.title||'').toLowerCase().includes(q))||null;
}

export async function taskCreate({title,notes,due}){
  if(!title)throw new Error('no title');
  const json={title};
  if(notes)json.notes=notes;
  if(due){const d=new Date(due);if(!isNaN(d))json.due=d.toISOString();}
  await gapi('/tasks/v1/lists/@default/tasks',{method:'POST',json});
  return `Google Tasks: "${title}" added.`;
}

export async function taskComplete(idOrTitle){
  const t=await findGTask(idOrTitle);
  if(!t)return `Google Tasks: no match for "${idOrTitle}".`;
  await gapi(`/tasks/v1/lists/@default/tasks/${t.id}`,{method:'PATCH',json:{status:'completed'}});
  return `Google Tasks: "${t.title}" done.`;
}

export async function taskDelete(idOrTitle){
  const t=await findGTask(idOrTitle);
  if(!t)return `Google Tasks: no match for "${idOrTitle}".`;
  await gapi(`/tasks/v1/lists/@default/tasks/${t.id}`,{method:'DELETE'});
  return `Google Tasks: "${t.title}" deleted.`;
}
