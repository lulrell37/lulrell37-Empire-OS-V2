// Every persona's note tags, in one place, with a receipt for each:
//   [SAVE_NOTE: title | content]    create, or overwrite the note with that title
//   [CREATE_NOTE: title | content]  same (the Drive-flavoured name for it)
//   [EDIT_NOTE: title or fileId | full new content]
//   [APPEND_NOTE: title | text]     add to the end (creates it if missing)
// Drive first; the local notes table when Drive isn't connected or the write
// fails — and the receipt says which, so nobody reports "saved to Drive" when
// it wasn't. Mirrors server/personaTools.js's saveNote / editNote / appendNote.
//
// Tags are found with a bracket-balancing scan rather than a [^\]]* regex, so
// a note holding a "[ ]" checklist or a markdown link isn't cut off at its
// first ]. The server's personaRuntime.js scanTags is the same scanner.
import*as g from './googleClient';
import{saveNote,getNote,updateNoteContent}from './database';

const NOTE_TAGS=new Set(['SAVE_NOTE','CREATE_NOTE','EDIT_NOTE','APPEND_NOTE']);
const HEAD=/\[([A-Z][A-Z0-9_]*)\s*(:)?/g;

// -> [{name,arg,start,end}] for every [NAME] / [NAME: arg] in text.
export function scanTags(text){
  const s=String(text||'');
  const out=[];
  HEAD.lastIndex=0;
  let m;
  while((m=HEAD.exec(s))){
    const from=HEAD.lastIndex;
    if(!m[2]){
      if(s[from]===']'){out.push({name:m[1],arg:'',start:m.index,end:from+1});HEAD.lastIndex=from+1;}
      continue;
    }
    let depth=0,end=-1,first=-1;
    for(let j=from;j<s.length;j++){
      if(s[j]==='[')depth++;
      else if(s[j]===']'){
        if(first<0)first=j;
        if(depth===0){end=j;break;}
        depth--;
      }
    }
    if(end<0)end=first;
    if(end<0)continue;
    out.push({name:m[1],arg:s.slice(from,end).trim(),start:m.index,end:end+1});
    HEAD.lastIndex=end+1;
  }
  return out;
}

// Remove the named tags (whole, brackets inside and all) from text.
export function stripTags(text,names){
  const s=String(text||'');
  let out='',at=0;
  for(const t of scanTags(s)){
    if(names&&!names.has(t.name))continue;
    out+=s.slice(at,t.start);at=t.end;
  }
  return out+s.slice(at);
}
export const stripNoteTags=(text)=>stripTags(text,NOTE_TAGS);

function split(arg){
  const i=arg.indexOf('|');
  return i<0?[arg.trim(),'']:[arg.slice(0,i).trim(),arg.slice(i+1).trim()];
}
const looksLikeFileId=(s)=>/^[A-Za-z0-9_-]{20,}$/.test(String(s||'').trim());

async function onDrive(){try{return await g.googleConnected();}catch{return false;}}

async function save(title,content,personaId){
  if(await onDrive()){
    try{return `✓ ${await g.driveSaveNote({title,content})}`;}
    catch(e){await saveNote(title,content,personaId);return `⚠️ "${title}" is NOT in Drive (${e.message}) — saved to the app's Notes instead`;}
  }
  await saveNote(title,content,personaId);
  return `✓ Saved to the app's Notes: "${title}" (Drive isn't connected)`;
}

// -> {kind:'drive',id,title} | {kind:'local',row} | null
async function find(ref){
  if(await onDrive()){
    try{
      if(looksLikeFileId(ref)){const f=await g.driveReadRaw({fileId:ref});return{kind:'drive',id:f.id,title:f.title,content:f.content};}
      const f=await g.driveFindByName(ref);
      if(f)return{kind:'drive',id:f.id,title:f.name};
    }catch{/* fall through to local */}
  }
  const row=await getNote(ref).catch(()=>null);
  return row?{kind:'local',row}:null;
}

async function edit(ref,content,personaId){
  const hit=await find(ref);
  if(!hit){
    if(looksLikeFileId(ref))return `⚠️ No note with id ${ref} — nothing edited`;
    return `${await save(ref,content,personaId)} (there was no note named "${ref}", so it's new)`;
  }
  if(hit.kind==='drive'){await g.driveUpdate({fileId:hit.id,content});return `✓ Drive: note "${hit.title}" updated`;}
  await updateNoteContent(hit.row.id,content);
  return `✓ App note "${hit.row.title}" updated`;
}

async function append(ref,text,personaId){
  const hit=await find(ref);
  if(!hit)return `${await save(ref,text,personaId)} (new — there was no note named "${ref}" to add to)`;
  if(hit.kind==='drive'){
    const cur=(hit.content!=null?hit.content:(await g.driveReadRaw({fileId:hit.id})).content||'').replace(/\s+$/,'');
    await g.driveUpdate({fileId:hit.id,content:cur?`${cur}\n\n${text}`:text});
    return `✓ Added to Drive note "${hit.title}"`;
  }
  const cur=String(hit.row.content||'').replace(/\s+$/,'');
  await updateNoteContent(hit.row.id,cur?`${cur}\n\n${text}`:text);
  return `✓ Added to app note "${hit.row.title}"`;
}

// Run every note tag in a reply. -> receipt lines (empty if there were none).
export async function noteCommands(text,personaId){
  const out=[];
  const seen=new Set();
  for(const{name,arg}of scanTags(text)){
    if(!NOTE_TAGS.has(name))continue;
    const key=name+'|'+arg;
    if(seen.has(key))continue;
    seen.add(key);
    const[ref,body]=split(arg);
    try{
      if(!ref){out.push(`⚠️ ${name} had no title — nothing saved`);continue;}
      if(name==='APPEND_NOTE'){
        out.push(body?await append(ref,body,personaId):`⚠️ APPEND_NOTE "${ref}" had nothing to add`);
      }else if(name==='EDIT_NOTE'){
        out.push(await edit(ref,body,personaId));
      }else{
        out.push(body||name==='CREATE_NOTE'?await save(ref,body,personaId):`⚠️ SAVE_NOTE "${ref}" had no content — nothing saved`);
      }
    }catch(e){
      out.push(`⚠️ ${name} "${ref}" failed — ${e.message}`);
    }
  }
  return out;
}
