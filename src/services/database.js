import*as SQLite from 'expo-sqlite';
import{classifyMemory,memoryRelevance}from './memoryCategories';
let db;
export function getDb(){return db;}
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
    CREATE TABLE IF NOT EXISTS app_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY AUTOINCREMENT,amount REAL,category TEXT,note TEXT,date TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS important_dates(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT,date TEXT,note TEXT,created_at INTEGER);
    CREATE TABLE IF NOT EXISTS build_jobs(id TEXT PRIMARY KEY,repo_owner TEXT,repo_name TEXT,issue_number INTEGER,pr_number INTEGER,spec TEXT,state TEXT,question TEXT,last_comment_id INTEGER DEFAULT 0,title TEXT,project_name TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY AUTOINCREMENT,persona TEXT DEFAULT 'talon',symbol TEXT,side TEXT,qty REAL,entry_ref REAL,entry_fill REAL,stop_loss REAL,take_profit REAL,setup TEXT,rationale TEXT,status TEXT DEFAULT 'open',order_id TEXT,position_id TEXT,opened_at INTEGER,closed_at INTEGER,exit_price REAL,realized_pl REAL,pl_estimated INTEGER DEFAULT 0,outcome TEXT,r_multiple REAL,review TEXT,misses INTEGER DEFAULT 0,last_unrealized REAL,auto INTEGER DEFAULT 0,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS deep_research(id TEXT PRIMARY KEY,topic TEXT,persona TEXT,mode TEXT DEFAULT 'direct',model TEXT,status TEXT DEFAULT 'running',progress TEXT,result TEXT,error TEXT,started_at INTEGER,finished_at INTEGER,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS leads(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,business TEXT,website TEXT,contact TEXT,bottleneck TEXT,segment TEXT,value TEXT,stage TEXT DEFAULT 'new',next_action TEXT,next_touch TEXT,last_touch TEXT,log TEXT DEFAULT '',source TEXT DEFAULT 'scout',source_id TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  await migrateHudColumns();
  await migratePersonaMemory();
  await migrateBuildJobs();
  await migrateColumn('trades','auto','INTEGER DEFAULT 0');
  await migrateColumn('deep_research','delivered','INTEGER DEFAULT 0');
  await migrateColumn('leads','source_id','TEXT');
  await migrateTraderPersona();
  await ensureHudState();
  await ensureBusinessTargets();
  await initSync();
}

// --- Cross-device sync scaffolding -----------------------------------------
// Each syncable table gets a stable `sync_id` and an `updated_at` (ms). SQLite
// triggers keep both current so the ~40 existing write functions don't change.
// Deletes drop a row in `tombstones`. During a pull, `sync_meta.mute` is set to
// 1 so applying server rows doesn't re-stamp them (which would ping-pong).

const NOW_MS="CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

// table -> SQL expression for its sync_id at INSERT time (NEW.* refers to the row)
const SYNC_TABLES={
  tasks:'lower(hex(randomblob(16)))',
  persona_memory:'lower(hex(randomblob(16)))',
  revenue:'lower(hex(randomblob(16)))',
  notes:'lower(hex(randomblob(16)))',
  expenses:'lower(hex(randomblob(16)))',
  important_dates:'lower(hex(randomblob(16)))',
  build_jobs:'NEW.id',
  trades:'lower(hex(randomblob(16)))',
  leads:'lower(hex(randomblob(16)))',
  business_targets:'NEW.business',
  custom_prompts:'NEW.persona',
  persona_pics:'NEW.persona',
  hud_layout:'NEW.panel',
  hud_state:"'singleton'",
  app_settings:'NEW.key',
};
// of those, the tables that don't already have an updated_at column
const NEEDS_UPDATED_AT=new Set(['tasks','persona_memory','revenue','expenses','important_dates','business_targets','custom_prompts','persona_pics','hud_layout','app_settings']);

export const SYNC_TABLE_NAMES=Object.keys(SYNC_TABLES);

async function initSync(){
  await db.execAsync(`
    PRAGMA recursive_triggers=OFF;
    CREATE TABLE IF NOT EXISTS sync_meta(id INTEGER PRIMARY KEY CHECK(id=1), mute INTEGER DEFAULT 0, pull_cursor INTEGER DEFAULT 0, push_cursor INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0, last_error TEXT);
    INSERT OR IGNORE INTO sync_meta(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS tombstones(table_name TEXT NOT NULL, sync_id TEXT NOT NULL, deleted_at INTEGER NOT NULL, PRIMARY KEY(table_name,sync_id));
  `);
  for(const[t,expr]of Object.entries(SYNC_TABLES)){
    const cols=(await db.getAllAsync(`PRAGMA table_info(${t})`)).map(c=>c.name);
    if(!cols.includes('sync_id'))await db.execAsync(`ALTER TABLE ${t} ADD COLUMN sync_id TEXT`);
    if(NEEDS_UPDATED_AT.has(t)&&!cols.includes('updated_at'))await db.execAsync(`ALTER TABLE ${t} ADD COLUMN updated_at INTEGER`);
    await db.execAsync(`CREATE UNIQUE INDEX IF NOT EXISTS ${t}_sync_id_idx ON ${t}(sync_id)`);
    // backfill any rows that predate the columns
    await db.execAsync(`UPDATE ${t} SET sync_id=${expr.replace(/NEW\./g,'')} WHERE sync_id IS NULL OR sync_id=''`);
    await db.execAsync(`UPDATE ${t} SET updated_at=${NOW_MS} WHERE updated_at IS NULL`);
    await db.execAsync(`
      DROP TRIGGER IF EXISTS ${t}_sync_ins;
      DROP TRIGGER IF EXISTS ${t}_sync_upd;
      DROP TRIGGER IF EXISTS ${t}_sync_del;
      CREATE TRIGGER ${t}_sync_ins AFTER INSERT ON ${t}
      WHEN NEW.sync_id IS NULL OR NEW.sync_id=''
      BEGIN UPDATE ${t} SET sync_id=${expr}, updated_at=${NOW_MS} WHERE rowid=NEW.rowid; END;
      CREATE TRIGGER ${t}_sync_upd AFTER UPDATE ON ${t}
      WHEN (SELECT mute FROM sync_meta WHERE id=1)=0
      BEGIN UPDATE ${t} SET updated_at=${NOW_MS} WHERE rowid=NEW.rowid; END;
      CREATE TRIGGER ${t}_sync_del AFTER DELETE ON ${t}
      WHEN (SELECT mute FROM sync_meta WHERE id=1)=0 AND OLD.sync_id IS NOT NULL
      BEGIN INSERT OR REPLACE INTO tombstones(table_name,sync_id,deleted_at) VALUES('${t}',OLD.sync_id,${NOW_MS}); END;
    `);
    // build_jobs is keyed on a synthetic `id` (`owner/repo#issue`) that equals
    // its sync_id. Rows arriving from another device via sync insert without an
    // `id`; backfill it from sync_id so getBuildJob(id) keeps working.
    if(t==='build_jobs'){
      await db.execAsync(`
        DROP TRIGGER IF EXISTS build_jobs_id_fill;
        CREATE TRIGGER build_jobs_id_fill AFTER INSERT ON build_jobs
        WHEN NEW.id IS NULL AND NEW.sync_id IS NOT NULL
        BEGIN UPDATE build_jobs SET id=NEW.sync_id WHERE rowid=NEW.rowid; END;
      `);
      await db.execAsync(`UPDATE build_jobs SET id=sync_id WHERE id IS NULL AND sync_id IS NOT NULL`);
    }
  }
}
// Add one column to an existing table if it isn't there yet (no-op on fresh installs).
async function migrateColumn(table,col,decl){
  try{
    const cols=(await db.getAllAsync(`PRAGMA table_info(${table})`)).map(c=>c.name);
    if(!cols.includes(col))await db.execAsync(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
  }catch{}
}
// Trading moved off A.T.L.A.S. onto the dedicated T.A.L.O.N. persona. Re-tag the
// historical trade rows and the strategy note so the new desk inherits the full
// record. One-time; guarded by an app_settings flag. No-op on fresh installs.
async function migrateTraderPersona(){
  try{
    const done=await db.getFirstAsync("SELECT value FROM app_settings WHERE key='trader_persona_migrated'");
    if(done&&done.value==='1')return;
    await db.execAsync("UPDATE trades SET persona='talon' WHERE persona='atlas'");
    await db.execAsync("UPDATE notes SET title='T.A.L.O.N. — Winning Strategy', persona='talon' WHERE title='A.T.L.A.S. — Winning Strategy'");
    await db.runAsync("INSERT INTO app_settings(key,value) VALUES('trader_persona_migrated','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  }catch{}
}
async function migrateHudColumns(){
  const names=(await db.getAllAsync('PRAGMA table_info(hud_state)')).map(c=>c.name);
  // Every column the current hud_state schema has beyond the original set. An
  // old table (created before word/verse/fact shipped) is missing these, and
  // CREATE TABLE IF NOT EXISTS never adds them — so the daily-content writes were
  // failing with "no such column: word_phonetic".
  const add=[
    ['batman_template',"TEXT DEFAULT '[]'"],
    ['batman_protocol',"TEXT DEFAULT '{}'"],
    ['morning_routine',"TEXT DEFAULT '[]'"],
    ['morning_routine_done',"TEXT DEFAULT '{}'"],
    ['word_of_day','TEXT'],
    ['word_phonetic','TEXT'],
    ['word_def','TEXT'],
    ['verse_of_day','TEXT'],
    ['verse_ref','TEXT'],
    ['fact_of_day','TEXT'],
  ];
  for(const[name,decl]of add){
    if(!names.includes(name)){
      try{await db.execAsync(`ALTER TABLE hud_state ADD COLUMN ${name} ${decl}`);}catch{}
    }
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
// build_jobs moved from an issue_number PK to a synthetic `id` (`owner/repo#n`)
// so client-project repos can't collide with Empire OS V2 on the same issue
// number. Rebuild the table, tagging every existing row as an Empire OS V2 build.
async function migrateBuildJobs(){
  const cols=(await db.getAllAsync('PRAGMA table_info(build_jobs)')).map(c=>c.name);
  if(!cols.length||cols.includes('id'))return; // fresh install already has the new schema
  await db.execAsync(`
    DROP TRIGGER IF EXISTS build_jobs_sync_ins;
    DROP TRIGGER IF EXISTS build_jobs_sync_upd;
    DROP TRIGGER IF EXISTS build_jobs_sync_del;
    ALTER TABLE build_jobs RENAME TO build_jobs_legacy;
    CREATE TABLE build_jobs(id TEXT PRIMARY KEY,repo_owner TEXT,repo_name TEXT,issue_number INTEGER,pr_number INTEGER,spec TEXT,state TEXT,question TEXT,last_comment_id INTEGER DEFAULT 0,title TEXT,project_name TEXT,created_at INTEGER,updated_at INTEGER);
    INSERT INTO build_jobs(id,repo_owner,repo_name,issue_number,pr_number,spec,state,question,last_comment_id,title,project_name,created_at,updated_at)
      SELECT 'lulrell37/lulrell37-Empire-OS-V2#'||issue_number,'lulrell37','lulrell37-Empire-OS-V2',issue_number,pr_number,spec,state,question,COALESCE(last_comment_id,0),title,NULL,created_at,updated_at
      FROM build_jobs_legacy;
    DROP TABLE build_jobs_legacy;
  `);
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
export async function ensureHudState(){
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
// Simple app-wide key/value settings (feature toggles, etc.).
export async function getSetting(key,fallback=null){const r=await db.getFirstAsync('SELECT value FROM app_settings WHERE key=?',[key]);return r?r.value:fallback;}
export async function setSetting(key,value){await db.runAsync('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[key,String(value)]);}

// --- Expenses (manual entry, local) ---
export async function addExpense(amount,category,note=''){
  const a=parseFloat(amount);if(isNaN(a))return;
  await db.runAsync('INSERT INTO expenses(amount,category,note,date,created_at) VALUES(?,?,?,?,?)',[a,(category||'general').toLowerCase().trim(),note||'',getTodayStr(),Date.now()]);
}
export async function getExpensesRecent(limit=20){return await db.getAllAsync('SELECT * FROM expenses ORDER BY created_at DESC LIMIT ?',[limit]);}
export async function getExpenseSummary(){
  const month=getMonthStr();
  const rows=await db.getAllAsync("SELECT category,SUM(amount) as total,COUNT(*) as n FROM expenses WHERE date LIKE ? GROUP BY category ORDER BY total DESC",[month+'%']);
  const total=rows.reduce((a,r)=>a+(r.total||0),0);
  return{month,total,byCategory:rows};
}

// --- Important dates ---
export async function addImportantDate(label,date,note=''){
  if(!label||!date)return;
  await db.runAsync('INSERT INTO important_dates(label,date,note,created_at) VALUES(?,?,?,?)',[label.trim(),String(date).trim(),note||'',Date.now()]);
}
export async function getAllImportantDates(){return await db.getAllAsync('SELECT * FROM important_dates ORDER BY date ASC');}
export async function deleteImportantDate(id){await db.runAsync('DELETE FROM important_dates WHERE id=?',[id]);}
// Dates within `days` from today, ignoring year for recurring occasions.
export async function getUpcomingDates(days=30){
  const all=await getAllImportantDates();
  const now=new Date();now.setHours(0,0,0,0);
  const out=[];
  for(const d of all){
    const m=/(\d{4})-(\d{2})-(\d{2})/.exec(d.date)||/^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(d.date);
    if(!m)continue;
    const mm=m.length===4?+m[2]:+m[1],dd=m.length===4?+m[3]:+m[2];
    let next=new Date(now.getFullYear(),mm-1,dd);
    if(next<now)next=new Date(now.getFullYear()+1,mm-1,dd);
    const daysOut=Math.round((next-now)/86400000);
    if(daysOut<=days)out.push({...d,daysOut});
  }
  return out.sort((a,b)=>a.daysOut-b.daysOut);
}
export async function saveNote(title,content,persona=null){const now=Date.now();const ex=await db.getFirstAsync('SELECT * FROM notes WHERE title=?',[title]);if(ex){await db.runAsync('UPDATE notes SET content=?,updated_at=? WHERE id=?',[content,now,ex.id]);return ex.id;}const r=await db.runAsync('INSERT INTO notes(title,content,persona,created_at,updated_at) VALUES(?,?,?,?,?)',[title,content,persona,now,now]);return r.lastInsertRowId;}
export async function getNote(title){return await db.getFirstAsync('SELECT * FROM notes WHERE title LIKE ?',['%'+title+'%']);}
export async function getAllNotes(){return await db.getAllAsync('SELECT * FROM notes ORDER BY updated_at DESC');}
export async function deleteNote(id){await db.runAsync('DELETE FROM notes WHERE id=?',[id]);}

// --- Leads pipeline (S.C.O.U.T.) -----------------------------------------
// One row per prospect. S.C.O.U.T. drives every field from chat via the
// [LEAD_ADD] / [LEAD_UPDATE] / [LEAD_LOG] tags; the Command-screen LeadsPanel
// and the follow-up nudges read it back. Synced like tasks/notes.
export const LEAD_STAGES=['inbound','new','contacted','replied','qualifying','call_booked','won','lost','cold'];
const LEAD_FIELDS=['name','business','website','contact','bottleneck','segment','value','stage','next_action','next_touch','last_touch','log','source','source_id'];
export async function addLead(fields={}){
  const now=Date.now();
  const f={source:'scout',stage:'new',...fields};
  const cols=LEAD_FIELDS.filter(k=>f[k]!==undefined&&f[k]!==null);
  const sql=`INSERT INTO leads(${cols.join(',')},created_at,updated_at) VALUES(${cols.map(()=>'?').join(',')},?,?)`;
  const r=await db.runAsync(sql,[...cols.map(k=>f[k]),now,now]);
  return r.lastInsertRowId;
}
export async function updateLead(id,patch={}){
  const cols=Object.keys(patch).filter(k=>LEAD_FIELDS.includes(k));
  if(!cols.length)return;
  await db.runAsync(`UPDATE leads SET ${cols.map(c=>c+'=?').join(',')} WHERE id=?`,[...cols.map(c=>patch[c]),id]);
}
export async function appendLeadLog(id,line){
  const text=String(line||'').trim();
  if(!text)return;
  const lead=await getLead(id);
  if(!lead)return;
  const stamped=`${getTodayStr()} — ${text}`;
  const nextLog=lead.log?`${stamped}\n${lead.log}`:stamped;
  await db.runAsync('UPDATE leads SET log=?,last_touch=? WHERE id=?',[nextLog,getTodayStr(),id]);
}
export async function getAllLeads(){return await db.getAllAsync('SELECT * FROM leads ORDER BY updated_at DESC');}
export async function getLeads(stage){return stage?await db.getAllAsync('SELECT * FROM leads WHERE stage=? ORDER BY updated_at DESC',[stage]):getAllLeads();}
export async function getLead(id){return await db.getFirstAsync('SELECT * FROM leads WHERE id=?',[id]);}
// Resolve a reference S.C.O.U.T. wrote — a row id, or a name/business substring.
export async function findLead(ref){
  const raw=String(ref||'').trim();
  if(!raw)return null;
  if(/^\d+$/.test(raw)){const byId=await getLead(parseInt(raw,10));if(byId)return byId;}
  const q='%'+raw.toLowerCase()+'%';
  return await db.getFirstAsync('SELECT * FROM leads WHERE lower(name) LIKE ? ORDER BY updated_at DESC LIMIT 1',[q])
    || await db.getFirstAsync('SELECT * FROM leads WHERE lower(business) LIKE ? ORDER BY updated_at DESC LIMIT 1',[q]);
}
// Leads whose next touch is due on or before `dateStr` and aren't closed out.
export async function getLeadsDue(dateStr){
  return await db.getAllAsync("SELECT * FROM leads WHERE next_touch IS NOT NULL AND next_touch!='' AND next_touch<=? AND stage NOT IN ('won','lost') ORDER BY next_touch ASC",[dateStr]);
}
export async function deleteLead(id){await db.runAsync('DELETE FROM leads WHERE id=?',[id]);}
// Dedupe key for auto-imported inbound leads (a Google Form row, etc.).
export async function findLeadBySourceId(sid){
  if(!sid)return null;
  return await db.getFirstAsync('SELECT * FROM leads WHERE source_id=? LIMIT 1',[String(sid)]);
}
// Inbound leads still sitting untouched at the front of the pipeline.
export async function getInboundLeads(){
  return await db.getAllAsync("SELECT * FROM leads WHERE stage='inbound' ORDER BY created_at DESC");
}
// source_ids already imported from the website form — the poller's dedupe set.
export async function getFormSourceIds(){
  const rows=await db.getAllAsync("SELECT source_id FROM leads WHERE source='inbound-form' AND source_id IS NOT NULL");
  return rows.map(r=>r.source_id);
}
// Dedupe for the auto-scout loop — a lead already exists if its name normalizes
// to the same thing, or it shares a website host.
const normName=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const hostOf=s=>String(s||'').toLowerCase().replace(/^https?:\/\//,'').replace(/^www\./,'').split(/[/?#]/)[0];
export async function leadExists(name,website){
  const n=normName(name);
  const h=hostOf(website);
  const rows=await db.getAllAsync('SELECT name,website FROM leads');
  return rows.some(r=>(n&&normName(r.name)===n)||(h&&h.length>3&&hostOf(r.website)===h));
}
// Leads the auto-scout loop may cold-email: fresh, reachable, not yet contacted.
export async function getLeadsForOutreach(limit=5){
  return await db.getAllAsync(
    `SELECT * FROM leads
     WHERE stage IN ('inbound','new')
       AND contact LIKE '%_@_%._%'
       AND COALESCE(log,'') NOT LIKE '%mailed%'
     ORDER BY (stage='inbound') DESC, created_at ASC
     LIMIT ?`,[limit]);
}

// --- Trade journal (Atlas) -------------------------------------------------
// One row per trade Mr. Burrus confirmed. Opened on confirm; reconciled against
// TradeLocker by tradeJournal.js as positions close. This is the record Atlas
// reviews before proposing and learns her strategy from.
const TRADE_FIELDS=['persona','symbol','side','qty','entry_ref','entry_fill','stop_loss','take_profit','setup','rationale','status','order_id','position_id','opened_at','closed_at','exit_price','realized_pl','pl_estimated','outcome','r_multiple','review','misses','last_unrealized','auto'];
export async function insertTrade(t){
  const now=Date.now();
  const cols=TRADE_FIELDS.filter(k=>t[k]!==undefined);
  const sql=`INSERT INTO trades(${cols.join(',')},created_at,updated_at) VALUES(${cols.map(()=>'?').join(',')},?,?)`;
  const r=await db.runAsync(sql,[...cols.map(k=>t[k]),now,now]);
  return r.lastInsertRowId;
}
export async function updateTrade(id,patch){
  const cols=Object.keys(patch).filter(k=>TRADE_FIELDS.includes(k));
  if(!cols.length)return;
  await db.runAsync(`UPDATE trades SET ${cols.map(c=>c+'=?').join(',')} WHERE id=?`,[...cols.map(c=>patch[c]),id]);
}
export async function getOpenTrades(persona='talon'){return await db.getAllAsync('SELECT * FROM trades WHERE persona=? AND status=? ORDER BY opened_at ASC',[persona,'open']);}
export async function getClosedTrades(persona='talon',limit=40){return await db.getAllAsync('SELECT * FROM trades WHERE persona=? AND status IN (?,?) ORDER BY COALESCE(closed_at,opened_at) DESC LIMIT ?',[persona,'closed','unknown',limit]);}
export async function getTradeById(id){return await db.getFirstAsync('SELECT * FROM trades WHERE id=?',[id]);}
export async function getAllTrades(persona='talon',limit=200){return await db.getAllAsync('SELECT * FROM trades WHERE persona=? ORDER BY opened_at DESC LIMIT ?',[persona,limit]);}

// --- Deep Research jobs --------------------------------------------------
// One row per OpenAI Deep Research run. Persisted so a job survives closing
// the app — CommandScreen resumes polling on launch and delivers the result
// into the starting persona's chat whenever it lands. Local only (not synced).
export async function drInsert(r){
  const now=Date.now();
  await db.runAsync('INSERT OR REPLACE INTO deep_research(id,topic,persona,mode,model,status,started_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [r.id,r.topic||'',r.persona||'ara',r.mode||'direct',r.model||'',r.status||'running',r.started_at||now,now,now]);
}
export async function drUpdate(id,patch){
  const cols=Object.keys(patch);
  if(!cols.length)return;
  await db.runAsync(`UPDATE deep_research SET ${cols.map(c=>c+'=?').join(',')},updated_at=? WHERE id=?`,[...cols.map(c=>patch[c]),Date.now(),id]);
}
export async function drGet(id){return await db.getFirstAsync('SELECT * FROM deep_research WHERE id=?',[id]);}
export async function drActive(){return await db.getFirstAsync("SELECT * FROM deep_research WHERE status='running' ORDER BY started_at DESC LIMIT 1");}
export async function drRecent(n=10){return await db.getAllAsync('SELECT * FROM deep_research ORDER BY started_at DESC LIMIT ?',[n]);}
export async function savePersonaPic(persona,picData){await db.runAsync('INSERT INTO persona_pics(persona,pic_data) VALUES(?,?) ON CONFLICT(persona) DO UPDATE SET pic_data=excluded.pic_data',[persona,picData]);}
export async function getPersonaPic(persona){const r=await db.getFirstAsync('SELECT pic_data FROM persona_pics WHERE persona=?',[persona]);return r?.pic_data||null;}
export async function getAllPersonaPics(){const rows=await db.getAllAsync('SELECT * FROM persona_pics');const map={};rows.forEach(r=>{map[r.persona]=r.pic_data;});return map;}
export async function saveCustomPrompt(persona,prompt){await db.runAsync('INSERT INTO custom_prompts(persona,prompt) VALUES(?,?) ON CONFLICT(persona) DO UPDATE SET prompt=excluded.prompt',[persona,prompt]);}
export async function getCustomPrompt(persona){const r=await db.getFirstAsync('SELECT prompt FROM custom_prompts WHERE persona=?',[persona]);return r?.prompt||null;}
export async function trackApiUsage(provider,tokensIn,tokensOut){const today=getTodayStr();const ex=await db.getFirstAsync('SELECT * FROM api_usage WHERE provider=? AND date=?',[provider,today]);if(ex){await db.runAsync('UPDATE api_usage SET tokens_in=tokens_in+?,tokens_out=tokens_out+? WHERE id=?',[tokensIn,tokensOut,ex.id]);}else{await db.runAsync('INSERT INTO api_usage(provider,tokens_in,tokens_out,date,created_at) VALUES(?,?,?,?,?)',[provider,tokensIn,tokensOut,today,Date.now()]);}}
export async function getApiUsage(){return await db.getAllAsync('SELECT * FROM api_usage ORDER BY date DESC LIMIT 30');}

// --- Build jobs (JARVIS / A.R.A. build pipeline) ---
// state: queued | working | question | pr_open | merging | pushed | failed | cancelled
// id: `owner/repo#issue` — app-change builds target Empire OS V2, client
// projects target their own repo.
const BUILD_TERMINAL=['pushed','failed','cancelled'];
export const DEFAULT_BUILD_REPO={owner:'lulrell37',repo:'lulrell37-Empire-OS-V2'};
export function buildJobId(repo,issueNumber){const r=repo||DEFAULT_BUILD_REPO;return `${r.owner}/${r.repo}#${issueNumber}`;}
export function buildJobRepo(job){return{owner:job?.repo_owner||DEFAULT_BUILD_REPO.owner,repo:job?.repo_name||DEFAULT_BUILD_REPO.repo};}
export async function addBuildJob({issueNumber,repo=DEFAULT_BUILD_REPO,spec,title,projectName=null,state='queued'}){
  const now=Date.now();
  const id=buildJobId(repo,issueNumber);
  await db.runAsync(
    `INSERT INTO build_jobs(id,repo_owner,repo_name,issue_number,pr_number,spec,state,question,last_comment_id,title,project_name,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET pr_number=excluded.pr_number,spec=excluded.spec,state=excluded.state,question=excluded.question,last_comment_id=excluded.last_comment_id,title=excluded.title,project_name=COALESCE(excluded.project_name,build_jobs.project_name),updated_at=excluded.updated_at`,
    [id,repo.owner,repo.repo,issueNumber,null,spec||'',state,null,0,title||'',projectName,now,now],
  );
  return id;
}
export async function updateBuildJob(id,patch){
  const keys=Object.keys(patch);
  if(!keys.length)return;
  const fields=keys.map(k=>`${k}=?`).join(',');
  await db.runAsync(`UPDATE build_jobs SET ${fields},updated_at=? WHERE id=?`,[...keys.map(k=>patch[k]),Date.now(),id]);
}
export async function getBuildJobs(limit=40){return await db.getAllAsync('SELECT * FROM build_jobs ORDER BY created_at DESC LIMIT ?',[limit]);}
export async function getActiveBuildJobs(){
  const q=BUILD_TERMINAL.map(()=>'?').join(',');
  return await db.getAllAsync(`SELECT * FROM build_jobs WHERE state NOT IN (${q}) ORDER BY created_at DESC`,BUILD_TERMINAL);
}
export async function getBuildJob(id){return await db.getFirstAsync('SELECT * FROM build_jobs WHERE id=?',[id]);}
// Resolve an issue-number-only reference (from a persona's [BUILD_*:#n] command)
// to a job row — preferring one in `preferRepo` ({owner,repo}), else newest.
export async function getBuildJobByIssue(issueNumber,preferRepo=null){
  if(preferRepo){
    const hit=await db.getFirstAsync('SELECT * FROM build_jobs WHERE issue_number=? AND repo_owner=? AND repo_name=?',[issueNumber,preferRepo.owner,preferRepo.repo]);
    if(hit)return hit;
  }
  return await db.getFirstAsync('SELECT * FROM build_jobs WHERE issue_number=? ORDER BY created_at DESC LIMIT 1',[issueNumber]);
}
