import*as SQLite from 'expo-sqlite';
let db;
export async function initDatabase(){
  db=await SQLite.openDatabaseAsync('empire_os.db');
  await db.execAsync(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT,role TEXT,content TEXT,mode TEXT DEFAULT 'direct',timestamp INTEGER);
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,notes TEXT,due_date TEXT,priority TEXT DEFAULT 'normal',completed INTEGER DEFAULT 0,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS hud_state(id INTEGER PRIMARY KEY DEFAULT 1,date TEXT,empire_score INTEGER DEFAULT 0,streak INTEGER DEFAULT 0,batman_protocol TEXT DEFAULT '{}',morning_routine TEXT DEFAULT '[]',morning_routine_done TEXT DEFAULT '{}',word_of_day TEXT,word_phonetic TEXT,word_def TEXT,verse_of_day TEXT,verse_ref TEXT,fact_of_day TEXT,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS revenue(id INTEGER PRIMARY KEY AUTOINCREMENT,business TEXT,amount REAL,type TEXT DEFAULT 'income',note TEXT,date TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS business_targets(business TEXT PRIMARY KEY,target REAL DEFAULT 0,week_goal REAL DEFAULT 0,sort_order INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS persona_memory(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT,content TEXT,date TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,content TEXT,persona TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS persona_pics(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT UNIQUE,pic_data TEXT);
    CREATE TABLE IF NOT EXISTS custom_prompts(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT UNIQUE,prompt TEXT);
    CREATE TABLE IF NOT EXISTS api_usage(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT,tokens_in INTEGER DEFAULT 0,tokens_out INTEGER DEFAULT 0,date TEXT,created_at INTEGER);
  `);
  await ensureHudState();
  await ensureBusinessTargets();
}
export function getTodayStr(){return new Date().toISOString().split('T')[0];}
export function getMonthStr(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
async function ensureHudState(){
  const today=getTodayStr();
  const ex=await db.getFirstAsync('SELECT * FROM hud_state WHERE id=1');
  if(!ex){
    const defaultRoutine=JSON.stringify(['Pray','Charge tech','Calendar','Weather','Analytics','Emails','News','Finances','Study','Empire Sheets','Bible','Meditation','Memory Training','Social media post']);
    await db.runAsync('INSERT INTO hud_state(id,date,morning_routine,updated_at) VALUES(1,?,?,?)',[today,defaultRoutine,Date.now()]);
  }else if(ex.date!==today){
    const newStreak=ex.empire_score>=75?(ex.streak+1):0;
    await db.runAsync(`UPDATE hud_state SET date=?,empire_score=0,batman_protocol='{}',morning_routine_done='{}',streak=?,word_of_day=NULL,word_phonetic=NULL,word_def=NULL,verse_of_day=NULL,verse_ref=NULL,fact_of_day=NULL,updated_at=? WHERE id=1`,[today,newStreak,Date.now()]);
  }
  await ensureDailyContent();
}
const HUD_WORDS=[
  {word:'Gudgeon',phon:'/ˈɡʌdʒ.ən/',def:'Someone who is easily deceived or manipulated.'},
  {word:'Sedulous',phon:'/ˈsɛdʒ.ʊ.ləs/',def:'Showing dedication and diligence; persistent in effort.'},
  {word:'Acumen',phon:'/ˈæk.jʊ.mən/',def:'The ability to make good judgments and quick decisions, especially in business.'},
  {word:'Indefatigable',phon:'/ˌɪn.dɪˈfæt.ɪ.ɡə.bəl/',def:'Persisting tirelessly; incapable of being fatigued.'},
  {word:'Tenacious',phon:'/təˈneɪ.ʃəs/',def:'Holding firmly to a course of action or purpose; persistent.'},
  {word:'Cogent',phon:'/ˈkoʊ.dʒənt/',def:'Clear, logical, and convincing; forceful.'},
  {word:'Resilience',phon:'/rɪˈzɪl.jəns/',def:'The capacity to recover quickly from difficulties; toughness.'},
  {word:'Fortitude',phon:'/ˈfɔːr.tɪ.tuːd/',def:'Courage in pain or adversity.'},
];
const HUD_VERSES=[
  {text:'Commit to the Lord whatever you do, and he will establish your plans.',ref:'PROVERBS 16:3'},
  {text:'The plans of the diligent lead to profit as surely as haste leads to poverty.',ref:'PROVERBS 21:5'},
  {text:'Whatever you do, work at it with all your heart, as working for the Lord.',ref:'COLOSSIANS 3:23'},
  {text:'I can do all this through him who gives me strength.',ref:'PHILIPPIANS 4:13'},
  {text:'Be strong and courageous. Do not be afraid; do not be discouraged.',ref:'JOSHUA 1:9'},
  {text:'Trust in the Lord with all your heart and lean not on your own understanding.',ref:'PROVERBS 3:5'},
  {text:'For I know the plans I have for you, plans to prosper you and not to harm you.',ref:'JEREMIAH 29:11'},
  {text:'And let us not grow weary of doing good, for in due season we will reap.',ref:'GALATIANS 6:9'},
];
const HUD_FACTS=[
  'The first message ever sent over the internet\'s predecessor, ARPANET, was just the letters "LO" before the system crashed.',
  'The Wright brothers ran a bicycle repair shop to fund their early experiments in flight.',
  'Compound interest was called "the eighth wonder of the world" by Einstein.',
  'Honda was originally a piston ring manufacturer before it ever built a motorcycle or car.',
  'Sam Walton opened his first Walmart at age 44, after his first store lost its lease.',
  'Henry Ford\'s first business, the Detroit Automobile Company, failed before he founded Ford Motor Company.',
  'Warren Buffett still lives in the same house he bought in 1958 for $31,500.',
  'The Roman Empire had a road network of over 250,000 miles, much of it still usable today.',
];
async function ensureDailyContent(){
  const hud=await db.getFirstAsync('SELECT * FROM hud_state WHERE id=1');
  if(hud&&hud.word_of_day)return;
  const now=new Date();
  const start=new Date(now.getFullYear(),0,0);
  const dayOfYear=Math.floor((now-start)/86400000);
  const w=HUD_WORDS[dayOfYear%HUD_WORDS.length];
  const v=HUD_VERSES[dayOfYear%HUD_VERSES.length];
  const f=HUD_FACTS[dayOfYear%HUD_FACTS.length];
  await db.runAsync('UPDATE hud_state SET word_of_day=?,word_phonetic=?,word_def=?,verse_of_day=?,verse_ref=?,fact_of_day=? WHERE id=1',[w.word,w.phon,w.def,v.text,v.ref,f]);
}
const DEFAULT_BUSINESSES=[
  {name:'Wholesaling',target:2000,weekGoal:500},
  {name:'Vehicle Import-Export',target:3000,weekGoal:750},
  {name:'Blessed Visionary Clothing',target:1500,weekGoal:375},
  {name:'PHP Networking',target:1000,weekGoal:250},
  {name:'YouTube Shorts',target:200,weekGoal:50},
  {name:'Affiliate Marketing',target:500,weekGoal:125},
  {name:'Lawn Care / Junk Removal',target:3500,weekGoal:875},
  {name:'Noir Zodiac Co.',target:1000,weekGoal:250},
  {name:'Velvet Society',target:1000,weekGoal:250},
  {name:'Empire Digital',target:2000,weekGoal:500},
  {name:'Resurrection',target:0,weekGoal:0},
  {name:'Trading',target:2000,weekGoal:500},
  {name:'Social Media',target:500,weekGoal:125},
];
async function ensureBusinessTargets(){
  const ex=await db.getAllAsync('SELECT business FROM business_targets');
  if(ex&&ex.length)return;
  for(let i=0;i<DEFAULT_BUSINESSES.length;i++){
    const b=DEFAULT_BUSINESSES[i];
    await db.runAsync('INSERT OR IGNORE INTO business_targets(business,target,week_goal,sort_order) VALUES(?,?,?,?)',[b.name,b.target,b.weekGoal,i]);
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
export async function getMonthlyRevenueByBusiness(){const month=getMonthStr();return await db.getAllAsync("SELECT business,SUM(amount) as total FROM revenue WHERE type='income' AND date LIKE ? GROUP BY business",[month+'%']);}
export async function getBusinessTargets(){return await db.getAllAsync('SELECT * FROM business_targets ORDER BY sort_order ASC');}
export async function setBusinessTarget(business,target,weekGoal){await db.runAsync('UPDATE business_targets SET target=?,week_goal=? WHERE business=?',[target,weekGoal,business]);}
export async function getBusinessesWithRevenue(){
  const targets=await getBusinessTargets();
  const revenue=await getMonthlyRevenueByBusiness();
  const revMap={};revenue.forEach(r=>{revMap[r.business]=r.total;});
  return targets.map(t=>({name:t.business,target:t.target,weekGoal:t.week_goal,rev:revMap[t.business]||0}));
}
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
