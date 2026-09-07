// One interface for the Canvas notes surface over two backing stores:
// Google Drive when Mr. Burrus has connected his account, the local `notes`
// table otherwise. The personas' [SAVE_NOTE] path (commandHandler.js) already
// writes Drive-first with the same local fallback, so the Canvas and the
// personas stay pointed at the same place.
import{googleConnected,driveListRaw,driveReadRaw,driveSaveNote,driveUpdate,driveDelete}from './googleClient';
import{getAllNotes,getNote,saveNote as dbSaveNote,deleteNote as dbDeleteNote}from './database';

async function onDrive(){try{return await googleConnected();}catch{return false;}}

// -> [{ id, title, modified, source }]  newest first
export async function listNotes(){
  if(await onDrive()){
    try{
      const files=await driveListRaw(80);
      return files.map(f=>({id:f.id,title:f.title,modified:f.modified,source:'drive'}));
    }catch{/* fall through to local */}
  }
  const rows=await getAllNotes().catch(()=>[]);
  return rows.map(r=>({
    id:String(r.id),title:r.title,
    modified:r.updated_at||r.created_at||0,source:'local',
  }));
}

// ref: an item from listNotes ({id,title,source}) or a bare title string.
// -> { id, title, content, source }
export async function readNote(ref){
  const source=typeof ref==='object'?ref&&ref.source:null;
  if(source==='drive'&&ref.id){
    try{return{...(await driveReadRaw({fileId:ref.id})),source:'drive'};}catch{/* fall through */}
  }
  const title=typeof ref==='string'?ref:ref&&ref.title;
  if(!source&&await onDrive()){
    try{
      const files=await driveListRaw(80);
      const hit=files.find(f=>f.title.toLowerCase()===String(title||'').toLowerCase())
        ||files.find(f=>f.title.toLowerCase().includes(String(title||'').toLowerCase()));
      if(hit)return{...(await driveReadRaw({fileId:hit.id})),source:'drive'};
    }catch{/* fall through */}
  }
  const row=await getNote(title).catch(()=>null);
  return{id:row?String(row.id):null,title:row?row.title:title,content:row?row.content||'':'',source:'local'};
}

// Save an existing note (ref carries source/id) or a new one (pass no ref).
// Title changes on a Drive note only take effect for local notes — a renamed
// Drive note is saved by content in place, keeping its file.
export async function writeNote(ref,{title,content}){
  const t=(title||'').trim();
  if(!t)throw new Error('a note needs a title');
  if(ref&&ref.source==='drive'&&ref.id){
    try{await driveUpdate({fileId:ref.id,content:content||''});return{source:'drive'};}catch{/* fall through */}
  }
  if(!ref&&await onDrive()){
    try{await driveSaveNote({title:t,content:content||''});return{source:'drive'};}catch{/* fall through */}
  }
  await dbSaveNote(t,content||'',null);
  return{source:'local'};
}

export async function removeNote(ref){
  if(ref&&ref.source==='drive'&&ref.id){
    try{await driveDelete(ref.id);return;}catch{/* fall through */}
  }
  let row=null;
  if(ref&&/^\d+$/.test(String(ref.id||'')))row=ref;
  else row=await getNote(ref&&ref.title).catch(()=>null);
  if(row&&row.id)await dbDeleteNote(Number(row.id));
}
