// S.T.E.P.H.A.N.I.E.'s course in the app. The tracker itself lives on the
// server (server/stephanieCourse.js, routes/stephanie.js) — the same one her
// Telegram bot uses — so a lesson checked off here is checked off there, and the
// other way round. Nothing about the course is kept on the phone.
//
//   courseContext()                    -> her tool lines + live course, for buildSys
//   courseInjections(text, pid, asked) -> TOOL RESULT strings for the second pass
//   COURSE_TAG_RE                      -> for stripCommands
import{loadBackend}from './keyStore';

export const COURSE_TAG_RE=/\[(COURSE_STATUS|COURSE_START|LESSON_DONE|LESSON_UNDO|COURSE_DONE|ROADMAP_CHECK|ROADMAP_UNCHECK)(?::\s*([^\]]*))?\]/gi;

async function call(path,{method='GET',body,timeoutMs=45000}={}){
  const be=await loadBackend();
  if(!be)throw new Error('the course tracker runs on the Empire server, and no server is linked (Settings › Backend)');
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

// Her prompt block: the same tool lines her Telegram prompt carries (served by
// the server, so the two can't drift) and the course read live from Drive.
export async function courseContext(){
  try{
    const{status,tools}=await call('/stephanie/course',{timeoutMs:20000});
    return `\n\n[${String(tools||'').trim()}]\n\n[YOUR COURSE — live from Drive this turn:\n${status}\n]`;
  }catch(e){
    return `\n\n[YOUR COURSE: unavailable right now — ${e.message}. Don't guess where he is in the course; tell him the tracker couldn't be reached.]`;
  }
}

// Run the course tags in a reply. Checks need his own message (`asked`), and
// only S.T.E.P.H.A.N.I.E. runs them; A.R.A. can read the status.
export async function courseInjections(text,persona,asked){
  const out=[];
  const seen=new Set();
  for(const m of String(text||'').matchAll(COURSE_TAG_RE)){
    const name=m[1].toUpperCase(),arg=(m[2]||'').trim();
    const key=`${name}|${arg}`;
    if(seen.has(key))continue;
    seen.add(key);
    if(persona!=='stephanie'&&!(persona==='ara'&&name==='COURSE_STATUS'))continue;
    try{
      const{text:res}=await call('/stephanie/course',{method:'POST',body:{tag:name,arg,asked:String(asked||'')}});
      out.push(`${name}${arg?` "${arg}"`:''}: ${res}`);
    }catch(e){out.push(`${name}: failed — ${e.message}`);}
  }
  return out;
}
