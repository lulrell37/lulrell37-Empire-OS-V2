// Persistent crash ring buffer — the last ~30 crashes, so the next one is
// diagnosable from Settings › Diagnostics without a debugger attached. Written
// from errorHandler (global + unhandled rejection), ErrorBoundary, and the
// per-panel Boundary components.
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY='EMPIRE_OS_CRASH_LOG_V1';
const MAX=30;
let mem=null; // in-memory mirror so a crash mid-write still surfaces recent entries

export async function logCrash(source,message,stack){
  const entry={
    ts:Date.now(),
    source:String(source||'?'),
    message:String(message||'').slice(0,600),
    stack:String(stack||'').slice(0,2500),
  };
  try{
    if(mem===null){try{mem=JSON.parse(await AsyncStorage.getItem(KEY))||[];}catch{mem=[];}}
    mem.unshift(entry);
    if(mem.length>MAX)mem.length=MAX;
    await AsyncStorage.setItem(KEY,JSON.stringify(mem));
  }catch{}
}

export async function getCrashLog(){
  try{mem=JSON.parse(await AsyncStorage.getItem(KEY))||[];}catch{mem=mem||[];}
  return mem;
}

export async function clearCrashLog(){
  mem=[];
  try{await AsyncStorage.removeItem(KEY);}catch{}
}

// How many crashes landed in the last `ms` — App.js uses this to break a
// launch-time crash loop by starting on a clean navigation state.
export async function recentCrashCount(ms=30000){
  const log=await getCrashLog();
  const cutoff=Date.now()-ms;
  return log.filter(e=>e&&e.ts>=cutoff).length;
}
