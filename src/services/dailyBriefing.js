// Daily HUD content — Word + Fact of the Day (S.T.E.P.H.A.N.I.E.) and Verse of
// the Day (Abraham), refreshed once per calendar day (America/New_York), no
// repeats. Runs on app foreground; if the day's items already exist it no-ops.
//
// Storage: the live values go into hud_state (word_of_day / word_phonetic /
// word_def / fact_of_day / verse_of_day / verse_ref) — already synced and shown
// by the HUD's DailyPanel. Per-item date stamp + rolling history live in
// app_settings (daily_<kind>_date, daily_<kind>_history), also synced, so a
// second device or the backend cron sees the day is done and skips.
import{getSetting,setSetting,updateHudState}from './database';
import{dailyGenerate}from './aiService';

const HISTORY_MAX=400;
let running=false;

export function todayET(){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
}

async function history(kind){
  try{const h=JSON.parse(await getSetting(`daily_${kind}_history`,'[]'));return Array.isArray(h)?h:[];}catch{return[];}
}
async function remember(kind,value){
  const h=await history(kind);
  const v=String(value||'').trim();
  if(!v)return;
  await setSetting(`daily_${kind}_history`,JSON.stringify([v,...h.filter(x=>x.toLowerCase()!==v.toLowerCase())].slice(0,HISTORY_MAX)));
}

async function ensureWord(today,force){
  if(!force&&await getSetting('daily_word_date','')===today)return false;
  const r=await dailyGenerate('word',await history('word'));
  if(!r?.word)return false;
  await updateHudState({word_of_day:String(r.word).trim(),word_phonetic:String(r.phonetic||'').trim(),word_def:String(r.definition||'').trim()});
  await remember('word',r.word);
  await setSetting('daily_word_date',today);
  return true;
}
async function ensureFact(today,force){
  if(!force&&await getSetting('daily_fact_date','')===today)return false;
  const r=await dailyGenerate('fact',await history('fact'));
  if(!r?.fact)return false;
  await updateHudState({fact_of_day:String(r.fact).trim()});
  await remember('fact',r.fact);
  await setSetting('daily_fact_date',today);
  return true;
}
async function ensureVerse(today,force){
  if(!force&&await getSetting('daily_verse_date','')===today)return false;
  const r=await dailyGenerate('verse',await history('verse'));
  if(!r?.text)return false;
  await updateHudState({verse_of_day:String(r.text).trim(),verse_ref:String(r.ref||'').trim()});
  await remember('verse',r.ref||r.text);
  await setSetting('daily_verse_date',today);
  return true;
}

// Fill in whatever the day is missing. `force` regenerates all three now.
export async function refreshDailyBriefing({force=false}={}){
  if(running)return;
  running=true;
  const today=todayET();
  try{
    try{await ensureWord(today,force);}catch(e){}
    try{await ensureFact(today,force);}catch(e){}
    try{await ensureVerse(today,force);}catch(e){}
  }finally{running=false;}
}
