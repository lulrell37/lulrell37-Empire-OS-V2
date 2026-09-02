// The HUD tasks list = Google Tasks (when connected) merged with any local-only
// tasks. Shared by the HUD carousel panel and the floating panel so both read
// and write the same way. Google rows carry `gid`; every mutation on one routes
// back to the Google Tasks API, local rows stay in the app database.
import{getTasks,addTask as addLocalTask,updateTask as renameLocalTask,deleteTask as deleteLocalTask,completeTask as completeLocalTask}from './database';
import{googleConnected,hudTasksList,hudTaskCreate,hudTaskSetDone,hudTaskRename,hudTaskDelete}from './googleClient';

export async function loadHudTasks(){
  let local=[];
  try{local=(await getTasks()).map(t=>({...t,gid:null}));}catch{}
  let connected=false;
  try{connected=await googleConnected();}catch{}
  if(!connected)return local;
  try{
    // Never let a slow/failed Google call block the HUD from rendering.
    const raw=await Promise.race([
      hudTasksList(),
      new Promise((_,rej)=>setTimeout(()=>rej(new Error('google tasks timeout')),8000)),
    ]);
    const g=(raw||[]).map(t=>({
      id:'g:'+t.id,gid:t.id,title:t.title,due:t.due,completed:t.completed,notes:'',
    }));
    const seen=new Set(local.map(t=>(t.title||'').trim().toLowerCase()));
    return[...g.filter(t=>!seen.has((t.title||'').trim().toLowerCase())),...local];
  }catch{return local;}
}

export async function addHudTask(title){
  const clean=String(title||'').trim();
  if(!clean)return;
  try{if(await googleConnected()){await hudTaskCreate(clean);return;}}catch{}
  await addLocalTask(clean);
}

export async function setHudTaskDone(task,done=true){
  if(!task)return;
  if(task.gid){try{await hudTaskSetDone(task.gid,done);}catch{}}
  else if(done)await completeLocalTask(task.id);
}

export async function renameHudTask(task,title){
  const clean=String(title||'').trim();
  if(!task||!clean)return;
  if(task.gid){try{await hudTaskRename(task.gid,clean);}catch{}}
  else await renameLocalTask(task.id,clean,task.notes||'');
}

export async function deleteHudTask(task){
  if(!task)return;
  if(task.gid){try{await hudTaskDelete(task.gid);}catch{}}
  else await deleteLocalTask(task.id);
}
