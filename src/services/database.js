import*as SQLite from 'expo-sqlite';
let db;
export async function initDatabase(){
  db=await SQLite.openDatabaseAsync('empire_os.db');
  await db.execAsync(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT,role TEXT,content TEXT,mode TEXT DEFAULT 'direct',timestamp INTEGER);
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,notes TEXT,due_date TEXT,priority TEXT DEFAULT 'normal',completed INTEGER DEFAULT 0,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS hud_state(id INTEGER PRIMARY KEY DEFAULT 1,date TEXT,empire_score INTEGER DEFAULT 0,streak INTEGER DEFAULT 0,batman_protocol TEXT DEFAULT '{}',morning_routine TEXT DEFAULT '[]',morning_routine_done TEXT DEFAULT '{}',word_of_day TEXT,verse_of_day TEXT,fact_of_day TEXT,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS revenue(id INTEGER PRIMARY KEY AUTOINCREMENT,business TEXT,amount REAL,type TEXT DEFAULT 'income',note TEXT,date TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS persona_memory(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT,content TEXT,date TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,content TEXT,persona TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS persona_pics(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT UNIQUE,pic_data TEXT);
    CREATE TABLE IF NOT EXISTS custom_prompts(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT UNIQUE,prompt TEXT);
    CREATE TABLE IF NOT EXISTS api_usage(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT,tokens_in INTEGER DEFAULT 0,tokens_out INTEGER DEFAULT 0,date TEXT,created_at INTEGER);
  `);
  await ensureHudState();
}
export function getTodayStr(){return new Date().toISOString().split('T')[0];}
async function ensureHudState(){
  const today=getTodayStr();
  const ex=await db.getFirstAsync('SELECT * FROM hud_state WHERE id=1');
  if(!ex){
    const defaultRoutine=JSON.stringify(['Pray','Charge tech','Calendar','Weather','Analytics','Emails','News','Finances','Study','Empire Sheets','Bible','Meditation','Memory Training','Social media post']);
    await db.runAsync('INSERT INTO hud_state(id,date,morning_routine,updated_at) VALUES(1,?,?,?)',[today,defaultRoutine,Date.now()]);
  }else if(ex.date!==today){
    const newStreak=ex.empire_score>=75?(ex.streak+1):0;
    await db.runAsync(`UPDATE hud_state SET date=?,empire_score=0,batman_protocol='{}',morning_routine_done='{}',streak=?,word_of_day=NULL,verse_of_day=NULL,fact_of_day=NULL,updated_at=? WHERE id=1`,[today,newStreak,Date.now()]);
  }
}
export async function saveMessage(persona,role,content,mode='direct'){await db.runAsync('INSERT INTO messages(persona,role,content,mode,timestamp) VALUES(?,?,?,?,?)',[persona,role,content,mode,Date.now()]);}
export async function getMessages(persona,limit=50){return await db.getAllAsync('SELECT * FROM messages WHERE persona=? ORDER BY timestamp DESC LIMIT ?',[persona,limit]);}
export async function getTasks(includeCompleted=false){return await db.getAllAsync(includeCompleted?'SELECT * FROM tasks ORDER BY completed ASC,created_at DESC':'SELECT * FROM tasks WHERE completed=0 ORDER BY created_at DESC');}
export async function addTask(title,notes='',dueDate=null,priority='normal'){const r=await db.runAsync('INSERT INTO tasks(title,notes,due_date,priority,created_at) VALUES(?,?,?,?,?)',[title,notes,dueDate,priority,Date.now()]);return r.lastInsertRowId;}
export async function updateTask(id,title,notes=''){await db.runAsync('UPDATE tasks SET title=?,notes=? WHERE id=?',[title,notes,id]);}
export async function completeTask(id){await db.runAsync('UPDATE tasks SET completed=1 WHERE id=?',[id]);}
export async function uncompleteTask(id){await db.runAsync('UPDATE tasks SET completed=0 WHERE id=?',[id]);}
export async function deleteTask(id){await db.runAsync('DELETE FROM tasks WHERE id=?',[id]);}
export async function getHudState(){return await db.getFirstAsync('SELECT * FROM hud_state WHERE id=1');}
export async function updateHudState(updates){const fields=Object.keys(updates).map(k=>`${k}=?`).join(',');await db.runAsync(`UPDATE hud_state SET ${fields},updated_at=? WHERE id=1`,[...Object.values(updates),Date.now()]);}
export async function updateEmpireScore(score){await updateHudState({empire_score:score});}
export async function updateMorningRoutine(routine){await updateHudState({morning_routine:JSON.stringify(routine)});}
export async function checkRoutineItem(item,done=true){const hud=await getHudState();let doneMap={};try{doneMap=JSON.parse(hud.morning_routine_done||'{}');}catch{}doneMap[item]=done;await updateHudState({morning_routine_done:JSON.stringify(doneMap)});}
export async function addRevenue(business,amount,type='income',note=''){await db.runAsync('INSERT INTO revenue(business,amount,type,note,date,created_at) VALUES(?,?,?,?,?,?)',[business,amount,type,note,getTodayStr(),Date.now()]);}
export async function getTotalRevenue(){const r=await db.getFirstAsync("SELECT SUM(amount) as total FROM revenue WHERE type='income'");return r?.total||0;}
export async function getRevenueByBusiness(){return await db.getAllAsync("SELECT business,SUM(amount) as total FROM revenue WHERE type='income' GROUP BY business ORDER BY total DESC");}
export async function savePersonaMemory(persona,content){const today=getTodayStr();const ex=await db.getFirstAsync('SELECT * FROM persona_memory WHERE persona=? AND date=?',[persona,today]);if(ex){await db.runAsync('UPDATE persona_memory SET content=? WHERE id=?',[ex.content+'\n\n'+content,ex.id]);}else{await db.runAsync('INSERT INTO persona_memory(persona,content,date,created_at) VALUES(?,?,?,?)',[persona,content,today,Date.now()]);}}
export async function getPersonaMemory(persona,days=14){const cutoff=new Date();cutoff.setDate(cutoff.getDate()-days);return await db.getAllAsync('SELECT * FROM persona_memory WHERE persona=? AND date>=? ORDER BY date DESC',[persona,cutoff.toISOString().split('T')[0]]);}
export async function getAllPersonaMemory(){return await db.getAllAsync('SELECT * FROM persona_memory ORDER BY date DESC LIMIT 100');}
export async function saveNote(title,content,persona=null){const now=Date.now();const ex=await db.getFirstAsync('SELECT * FROM notes WHERE title=?',[title]);if(ex){await db.runAsync('UPDATE notes SET content=?,updated_at=? WHERE id=?',[content,now,ex.id]);return ex.id;}const r=await db.runAsync('INSERT INTO notes(title,content,persona,created_at,updated_at) VALUES(?,?,?,?,?)',[title,content,persona,now,now]);return r.lastInsertRowId;}
export async function getNote(title){return await db.getFirstAsync('SELECT * FROM notes WHERE title LIKE ?',['%'+title+'%']);}
export async function getAllNotes(){return await db.getAllAsync('SELECT * FROM notes ORDER BY updated_at DESC');}
export async function deleteNote(id){await db.runAsync('DELETE FROM notes WHERE id=?',[id]);}
export async function savePersonaPic(persona,picData){await db.runAsync('INSERT OR REPLACE INTO persona_pics(persona,pic_data) VALUES(?,?)',[persona,picData]);}
export async function getPersonaPic(persona){const r=await db.getFirstAsync('SELECT pic_data FROM persona_pics WHERE persona=?',[persona]);return r?.pic_data||null;}
export async function getAllPersonaPics(){const rows=await db.getAllAsync('SELECT * FROM persona_pics');const map={};rows.forEach(r=>{map[r.persona]=r.pic_data;});return map;}
export async function saveCustomPrompt(persona,prompt){await db.runAsync('INSERT OR REPLACE INTO custom_prompts(persona,prompt) VALUES(?,?)',[persona,prompt]);}
export async function getCustomPrompt(persona){const r=await db.getFirstAsync('SELECT prompt FROM custom_prompts WHERE persona=?',[persona]);return r?.prompt||null;}
export async function trackApiUsage(provider,tokensIn,tokensOut){const today=getTodayStr();const ex=await db.getFirstAsync('SELECT * FROM api_usage WHERE provider=? AND date=?',[provider,today]);if(ex){await db.runAsync('UPDATE api_usage SET tokens_in=tokens_in+?,tokens_out=tokens_out+? WHERE id=?',[tokensIn,tokensOut,ex.id]);}else{await db.runAsync('INSERT INTO api_usage(provider,tokens_in,tokens_out,date,created_at) VALUES(?,?,?,?,?)',[provider,tokensIn,tokensOut,today,Date.now()]);}}
export async function getApiUsage(){return await db.getAllAsync('SELECT * FROM api_usage ORDER BY date DESC LIMIT 30');}
