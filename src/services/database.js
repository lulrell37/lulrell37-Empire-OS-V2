import*as SQLite from 'expo-sqlite';
import{classifyMemory,memoryRelevance}from './memoryCategories';
let db;
export async function initDatabase(){
  db=await SQLite.openDatabaseAsync('empire_os.db');
  await db.execAsync(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT,role TEXT,content TEXT,mode TEXT DEFAULT 'direct',timestamp INTEGER);
    CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,notes TEXT,due_date TEXT,priority TEXT DEFAULT 'normal',completed INTEGER DEFAULT 0,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS hud_state(id INTEGER PRIMARY KEY DEFAULT 1,date TEXT,empire_score INTEGER DEFAULT 0,streak INTEGER DEFAULT 0,batman_protocol TEXT DEFAULT '{}',batman_template TEXT DEFAULT '[]',morning_routine TEXT DEFAULT '[]',morning_routine_done TEXT DEFAULT '{}',word_of_day TEXT,word_phonetic TEXT,word_def TEXT,verse_of_day TEXT,verse_ref TEXT,fact_of_day TEXT,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS revenue(id INTEGER PRIMARY KEY AUTOINCREMENT,business TEXT,amount REAL,type TEXT DEFAULT 'income',note TEXT,date TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS business_targets(business TEXT PRIMARY KEY,target REAL DEFAULT 0,week_goal REAL DEFAULT 0,sort_order INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS persona_memory(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT,content TEXT,category TEXT,keywords TEXT,date TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT,content TEXT,persona TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS persona_pics(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT UNIQUE,pic_data TEXT);
    CREATE TABLE IF NOT EXISTS custom_prompts(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT UNIQUE,prompt TEXT);
    CREATE TABLE IF NOT EXISTS api_usage(id INTEGER PRIMARY KEY AUTOINCREMENT,provider TEXT,tokens_in INTEGER DEFAULT 0,tokens_out INTEGER DEFAULT 0,date TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS hud_layout(panel TEXT PRIMARY KEY,detached INTEGER DEFAULT 0,x REAL DEFAULT 0,y REAL DEFAULT 0,scale REAL DEFAULT 1,z INTEGER DEFAULT 0);
  `);
  await migrateHudColumns();
  await migratePersonaMemory();
  await ensureHudState();
  await ensureBusinessTargets();
}
async function migrateHudColumns(){
  const cols=await db.getAllAsync('PRAGMA table_info(hud_state)');
  const names=cols.map(c=>c.name);
  if(!names.includes('batman_template')){
    await db.execAsync("ALTER TABLE hud_state ADD COLUMN batman_template TEXT DEFAULT '[]'");
  }
}
// persona_memory moved from one blob-per-day to one row per exchange, each tagged
// with a keyword category. Add the columns, then split any legacy day-blobs into
// individual rows and classify everything that isn't categorized yet.
async function migratePersonaMemory(){
  const cols=(await db.getAllAsync('PRAGMA table_info(persona_memory)')).map(c=>c.name);
  if(!cols.includes('category'))await db.execAsync('ALTER TABLE persona_memory ADD COLUMN category TEXT');
  if(!cols.includes('keywords'))await db.execAsync('ALTER TABLE persona_memory ADD COLUMN keywords TEXT');
  const legacy=await db.getAllAsync('SELECT * FROM persona_memory WHERE category IS NULL OR category=""');
  for(const row of legacy){
    const parts=String(row.content||'').split(/\n\n+/).map(s=>s.trim()).filter(Boolean);
    if(parts.length<=1){
      const c=classifyMemory(row.content||'');
      await db.runAsync('UPDATE persona_memory SET category=?,keywords=? WHERE id=?',[c.category,JSON.stringify(c.keywords),row.id]);
      continue;
    }
    const[first,...rest]=parts;
    const c0=classifyMemory(first);
    await db.runAsync('UPDATE persona_memory SET content=?,category=?,keywords=? WHERE id=?',[first,c0.category,JSON.stringify(c0.keywords),row.id]);
    let i=0;
    for(const p of rest){
      const c=classifyMemory(p);
      await db.runAsync('INSERT INTO persona_memory(persona,content,category,keywords,date,created_at) VALUES(?,?,?,?,?,?)',[row.persona,p,c.category,JSON.stringify(c.keywords),row.date,(row.created_at||Date.now())+(++i)]);
    }
  }
}
export function getTodayStr(){return new Date().toISOString().split('T')[0];}
export function getMonthStr(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');}
// --- Editable HUD structures: morning routine + Batman protocol ---
const DEFAULT_ROUTINE_LABELS=['Pray','Charge tech','Calendar','Weather','Analytics','Emails','News','Finances','Study','Empire Sheets','Bible','Meditation','Memory Training','Social media post'];
export const DEFAULT_BATMAN=[
  {day:'MON',label:'Raw Power',desc:'Deadlifts, Bench Press, Pull-Ups, Squats, Overhead Press · 6×3-5'},
  {day:'TUE',label:'Combat',desc:'3+ hours martial arts, heavy bag, acrobatics'},
  {day:'WED',label:'Hell Day',desc:'Full body circuit 8-10 rounds + 10+ mile run'},
  {day:'THU',label:'Skill & Precision',desc:'Martial arts, detective work, parkour'},
  {day:'FRI',label:'Heavy Strength',desc:'Same as Monday, heavier'},
  {day:'SAT',label:'Endurance & Pain',desc:'2-4 hour conditioning, ruck march, swimming'},
  {day:'SUN',label:'Active Recovery',desc:'Mobility, meditation, study, plan'},
];
function routineId(i=0){return 'r_'+Date.now().toString(36)+i.toString(36)+Math.random().toString(36).slice(2,5);}
function buildDefaultRoutine(){return DEFAULT_ROUTINE_LABELS.map((label,i)=>({id:routineId(i),label}));}
async function ensureHudState(){
  const today=getTodayStr();
  const ex=await db.getFirstAsync('SELECT * FROM hud_state WHERE id=1');
  if(!ex){
    await db.runAsync('INSERT INTO hud_state(id,date,morning_routine,batman_template,updated_at) VALUES(1,?,?,?,?)',[today,JSON.stringify(buildDefaultRoutine()),JSON.stringify(DEFAULT_BATMAN),Date.now()]);
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
// Returns {items:[{id,label}], done:{[id]:true}}. Migrates the legacy string[]
// shape (and label-keyed done map) to id-keyed on first read, persisting the result.
export async function getMorningRoutine(){
  const hud=await getHudState();
  let items=[];try{items=JSON.parse(hud?.morning_routine||'[]');}catch{}
  let done={};try{done=JSON.parse(hud?.morning_routine_done||'{}');}catch{}
  if(!Array.isArray(items))items=[];
  if(items.length&&typeof items[0]==='string'){
    const migrated=items.map((label,i)=>({id:routineId(i),label}));
    const nextDone={};
    migrated.forEach(it=>{if(done[it.label])nextDone[it.id]=true;});
    await updateHudState({morning_routine:JSON.stringify(migrated),morning_routine_done:JSON.stringify(nextDone)});
    return{items:migrated,done:nextDone};
  }
  let changed=false;
  items=items.map((it,i)=>{
    if(it&&typeof it==='object'&&it.id)return{id:it.id,label:it.label||''};
    changed=true;return{id:routineId(i),label:(it&&it.label)||String(it||'')};
  });
  if(changed)await updateHudState({morning_routine:JSON.stringify(items)});
  return{items,done};
}
export async function saveMorningRoutine(items){await updateHudState({morning_routine:JSON.stringify(items.map(it=>({id:it.id||routineId(),label:(it.label||'').trim()})).filter(it=>it.label))});}
export async function updateMorningRoutine(routine){await saveMorningRoutine(routine);}
function resolveRoutineItem(items,ref){
  const q=String(ref||'').toLowerCase().trim();
  return items.find(i=>i.id===ref)||items.find(i=>i.label.toLowerCase()===q)||items.find(i=>i.label.toLowerCase().includes(q));
}
export async function addRoutineItem(label){
  const{items}=await getMorningRoutine();
  const item={id:routineId(items.length),label:String(label||'').trim()};
  if(!item.label)return null;
  await updateHudState({morning_routine:JSON.stringify([...items,item])});
  return item;
}
export async function renameRoutineItem(ref,newLabel){
  const{items}=await getMorningRoutine();
  const it=resolveRoutineItem(items,ref);
  if(!it)return false;
  it.label=String(newLabel||'').trim();
  await updateHudState({morning_routine:JSON.stringify(items)});
  return true;
}
export async function removeRoutineItem(ref){
  const{items,done}=await getMorningRoutine();
  const it=resolveRoutineItem(items,ref);
  if(!it)return false;
  delete done[it.id];
  await updateHudState({morning_routine:JSON.stringify(items.filter(i=>i.id!==it.id)),morning_routine_done:JSON.stringify(done)});
  return true;
}
export async function setRoutineDone(ref,done=true){
  const{items,done:doneMap}=await getMorningRoutine();
  const it=resolveRoutineItem(items,ref);
  if(!it)return false;
  doneMap[it.id]=done;
  await updateHudState({morning_routine_done:JSON.stringify(doneMap)});
  return true;
}
export async function checkRoutineItem(item,done=true){return setRoutineDone(item,done);}
export async function getBatmanTemplate(){
  const hud=await getHudState();
  let t=[];try{t=JSON.parse(hud?.batman_template||'[]');}catch{}
  if(!Array.isArray(t)||t.length!==7){
    t=DEFAULT_BATMAN.map(d=>({...d}));
    await updateHudState({batman_template:JSON.stringify(t)});
  }
  return t;
}
export async function saveBatmanTemplate(days){
  const t=(Array.isArray(days)?days:[]).slice(0,7).map((d,i)=>({day:d.day||DEFAULT_BATMAN[i].day,label:(d.label||'').trim(),desc:(d.desc||'').trim()}));
  if(t.length===7)await updateHudState({batman_template:JSON.stringify(t)});
}
// --- HUD holographic layout: which panels float, and where ---
export async function getHudLayout(){
  const rows=await db.getAllAsync('SELECT * FROM hud_layout');
  const map={};
  rows.forEach(r=>{map[r.panel]={detached:!!r.detached,x:r.x,y:r.y,scale:r.scale||1,z:r.z||0};});
  return map;
}
export async function setPanelLayout(panel,patch){
  const cur=await db.getFirstAsync('SELECT * FROM hud_layout WHERE panel=?',[panel]);
  const base=cur||{detached:0,x:0,y:0,scale:1,z:0};
  const next={
    detached:patch.detached!=null?(patch.detached?1:0):(base.detached?1:0),
    x:patch.x!=null?patch.x:base.x,
    y:patch.y!=null?patch.y:base.y,
    scale:patch.scale!=null?patch.scale:(base.scale||1),
    z:patch.z!=null?patch.z:(base.z||0),
  };
  await db.runAsync(
    'INSERT INTO hud_layout(panel,detached,x,y,scale,z) VALUES(?,?,?,?,?,?) ON CONFLICT(panel) DO UPDATE SET detached=excluded.detached,x=excluded.x,y=excluded.y,scale=excluded.scale,z=excluded.z',
    [panel,next.detached,next.x,next.y,next.scale,next.z]
  );
}
export async function setBatmanDay(day,label,desc){
  const t=await getBatmanTemplate();
  const key=String(day||'').toLowerCase().slice(0,3);
  const d=t.find(x=>x.day.toLowerCase()===key);
  if(!d)return false;
  if(label!=null)d.label=String(label).trim();
  if(desc!=null)d.desc=String(desc).trim();
  await updateHudState({batman_template:JSON.stringify(t)});
  return true;
}
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
// One row per exchange, stored verbatim (no truncation), tagged with a category.
export async function savePersonaMemory(persona,content){
  const text=String(content||'').trim();
  if(!text)return;
  const{category,keywords}=classifyMemory(text);
  await db.runAsync('INSERT INTO persona_memory(persona,content,category,keywords,date,created_at) VALUES(?,?,?,?,?,?)',[persona,text,category,JSON.stringify(keywords),getTodayStr(),Date.now()]);
}
// Retrieval for a persona's system prompt. With a `query`, returns the most
// relevant full exchanges (category + keyword match) plus the 3 most recent for
// continuity; without one, plain recency. `opts` may be a number (limit only)
// for backward compatibility.
export async function getPersonaMemory(persona,opts={}){
  const{query='',limit=14}=(typeof opts==='number')?{limit:opts}:opts;
  const rows=await db.getAllAsync('SELECT * FROM persona_memory WHERE persona=? ORDER BY created_at DESC LIMIT 400',[persona]);
  if(!rows.length)return[];
  if(!query)return rows.slice(0,limit);
  const{category,keywords}=classifyMemory(query);
  const recent=rows.slice(0,3);
  const seen=new Set(recent.map(r=>r.id));
  const out=[...recent];
  const relevant=rows
    .map(r=>({r,s:memoryRelevance(r,category,keywords)}))
    .filter(x=>x.s>0&&!seen.has(x.r.id))
    .sort((a,b)=>b.s-a.s);
  for(const x of relevant){if(out.length>=limit)break;seen.add(x.r.id);out.push(x.r);}
  for(const r of rows){if(out.length>=limit)break;if(!seen.has(r.id)){seen.add(r.id);out.push(r);}}
  return out;
}
export async function getAllPersonaMemory(){return await db.getAllAsync('SELECT * FROM persona_memory ORDER BY created_at DESC LIMIT 100');}
// Every memory for one persona — for the Brain network view.
export async function getMemoriesByPersona(persona){return await db.getAllAsync('SELECT * FROM persona_memory WHERE persona=? ORDER BY created_at DESC',[persona]);}
// User prunes memory by hand — swipe a memory away to remove it permanently.
export async function deletePersonaMemory(id){await db.runAsync('DELETE FROM persona_memory WHERE id=?',[id]);}
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
