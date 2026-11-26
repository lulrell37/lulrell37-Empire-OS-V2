// The app's side of server/routes/shared.js: Telegram's switches, T.A.L.O.N.'s stop,
// A.R.A.'s W.I.R.E. brief and breaking-news check, S.T.E.P.H.A.N.I.E.'s drill and the
// follow-through rules, run on the server so the app and Telegram can't drift
// (owner, 2026-11-26: "both Telegram and the app should have the matching changes").
//
//   sharedContext(pid)               -> prompt block for buildSys
//   sharedInjections(text,pid,asked) -> TOOL RESULT strings for the second pass
//   followNotes(pid,reply,asked)     -> { check, ask } notes for one more round
//   followFinal(pid,reply,asked)     -> a still-promised check comes back on Telegram
//   SHARED_TAG_RE                    -> for stripCommands
import{loadBackend}from './keyStore';

export const SHARED_TAG_RE=/\[(SWITCH_OFF|SWITCH_ON|SWITCHES|TRADING_OFF|TRADING_ON|TRADING_STATUS|BREAKING_NOW|NEWS_NOW|QUIZ_SCORE|QUIZ_OFF|QUIZ_ON|QUIZ_NOW)(?::\s*([^\]]*))?\]/gi;
const HAS_TAG=/\[(SWITCH_OFF|SWITCH_ON|SWITCHES|TRADING_OFF|TRADING_ON|TRADING_STATUS|BREAKING_NOW|NEWS_NOW|QUIZ_SCORE|QUIZ_OFF|QUIZ_ON|QUIZ_NOW)\b/i;

async function call(path,{method='GET',body,timeoutMs=45000}={}){
  const be=await loadBackend();
  if(!be)throw new Error('this runs on the Empire server, and no server is linked (Settings › Backend)');
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),timeoutMs);
  try{
    const res=await fetch(be.url+path,{method,signal:ctl.signal,
      headers:{Authorization:'Bearer '+be.token,...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined});
    const j=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(j.error||`server ${res.status}`);
    return j;
  }catch(e){
    if(e?.name==='AbortError')throw new Error('the server took too long');
    throw e;
  }finally{clearTimeout(timer);}
}

export async function sharedContext(pid){
  try{const{block}=await call('/shared/context?persona='+encodeURIComponent(pid),{timeoutMs:15000});return block?`\n\n${block}`:'';}
  catch(e){return `\n\n[The on/off switches and shared desk tools are unavailable right now (${e.message}). If he asks to switch something on or off, tell him it couldn't be reached — never say it's done.]`;}
}

export async function sharedInjections(text,pid,asked){
  if(!HAS_TAG.test(String(text||'')))return [];
  try{const{results}=await call('/shared/tags',{method:'POST',body:{persona:pid,text:String(text),asked:String(asked||'')},timeoutMs:150000});return results||[];}
  catch(e){return [`SHARED TOOLS failed — ${e.message}. Nothing was switched or fetched; tell him plainly.`];}
}

export async function followNotes(pid,reply,asked){
  try{return await call('/shared/follow',{method:'POST',body:{persona:pid,reply:String(reply||''),asked:String(asked||'')},timeoutMs:8000});}
  catch{return{check:'',ask:''};}
}
export async function followFinal(pid,reply,asked){
  try{return await call('/shared/follow',{method:'POST',body:{persona:pid,reply:String(reply||''),asked:String(asked||''),final:true},timeoutMs:8000});}
  catch{return{scheduled:false};}
}
