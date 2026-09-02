import{loadKeys,loadBackend,loadGoogleToken}from './keyStore';
import{getPersonaMemory,getMemoriesByPersona,savePersonaMemory,getHudState,getTasks,trackApiUsage,getCustomPrompt,getUpcomingDates}from './database';
import*as FileSystem from 'expo-file-system';
import{Alert}from 'react-native';
let keys=null;
async function ensureKeys(){if(!keys)keys=await loadKeys();return keys;}

// --- Provider routing ------------------------------------------------------
// Direct calls hit the provider with the on-device key. When a backend is
// configured in Settings, every call instead goes through `${backend}/ai/<name>`
// with the backend bearer token and the provider key never leaves the server.
const AI_BASE={claude:'https://api.anthropic.com',grok:'https://api.x.ai',openai:'https://api.openai.com',elevenlabs:'https://api.elevenlabs.io'};
const AI_PROXY_NAME={claude:'anthropic',grok:'xai',openai:'openai',elevenlabs:'elevenlabs'};
const AI_KEYHDR={
  claude:(kk)=>({'x-api-key':kk,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}),
  grok:(kk)=>({Authorization:'Bearer '+kk}),
  openai:(kk)=>({Authorization:'Bearer '+kk}),
  elevenlabs:(kk)=>({'xi-api-key':kk}),
};
// Returns { base, auth } — `base` has no trailing slash; the paths below start
// with `/v1/...`. Throws a Settings pointer when there's neither a backend nor a
// key for the provider.
async function aiRoute(provider,localKey,label){
  const be=await loadBackend();
  if(be)return{base:be.url+'/ai/'+AI_PROXY_NAME[provider],auth:{Authorization:'Bearer '+be.token}};
  if(!localKey)throw new Error(`No ${label} API key. Add one in Settings → KEYS, or connect a backend in Settings → BACKEND.`);
  return{base:AI_BASE[provider],auth:AI_KEYHDR[provider](localKey)};
}
// The full context-injected system prompt for a persona (HUD, memory, style).
// Exported so the Grok realtime voice socket can be seeded with the same context
// the text turn gets, instead of the bare personality prompt.
export async function personaSystemPrompt(personaId){
  const{getPersona}=await import('../personas/personas');
  return buildSys(personaId,getPersona(personaId),[]);
}

async function buildSys(personaId,persona,convo=[]){
  const now=new Date();
  const timeStr=now.toLocaleString('en-US',{timeZone:'America/New_York',weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true});
  const jan=new Date(now.getFullYear(),0,1).getTimezoneOffset();
  const jul=new Date(now.getFullYear(),6,1).getTimezoneOffset();
  const tz=now.getTimezoneOffset()<Math.max(jan,jul)?'EDT':'EST';
  const customPrompt=await getCustomPrompt(personaId);
  let sys=customPrompt||persona.system;
  sys+=`\n\n[RESPONSE STYLE: Reply directly to what Mr. Burrus just said. Do not open with a status briefing, HUD summary, morning-routine readout, or any unprompted overview unless he explicitly asks for one. Skip "here is where things stand" preambles — answer the message and stop.]`;
  sys+=`\n\n[MEMORY RECALL: The memory block below holds what is most relevant right now. If you need to recall something specific from past conversations that is NOT shown there, emit [MEMORY_QUERY: your precise question] and your memory index will answer it before you reply. Use it sparingly, only when it matters. Never mention this mechanism to Mr. Burrus — just recall.]`;
  sys+=`\n\n[CHARTS: When numbers would land better as a picture, emit [SHOW_CHART: type | title | data]. type = line, area, bar, or pie. data = "label:value, label:value, ..." for one series, or "A=x:1,y:2; B=x:3,y:4" for several. It takes over the visualization panel until Mr. Burrus closes it. Use it when it genuinely helps — trends, breakdowns, comparisons — not for one or two numbers.]`;
  sys+=`\n\n[WEB: You can search the live web. Emit [SEARCH_WEB: your query] (up to 2 per turn) whenever the answer depends on current facts, prices, news, dates, people, products, or anything you're not certain is still accurate — the results come back before you reply. Prefer searching over guessing or hedging. Don't mention the mechanism; just use what you find, with source names inline.]`;
  sys+=`\n\n[CURRENT DATE & TIME: ${timeStr} ${tz} | LOCATION: Waldorf, MD]`;
  try{
    const gt=await loadGoogleToken();
    if(gt?.accessToken){
      sys+=`\n\n[GOOGLE — connected. Use these when they genuinely help; results come back before you answer; never mention the mechanism:
 EMAIL: [READ_EMAIL] | [SEND_EMAIL: to | subject | body] (Mr. Burrus taps to confirm before it sends)
 CALENDAR: [READ_CALENDAR] | [READ_CALENDAR: 30] | [READ_CALENDAR: 2026-08-01 | 30] | [CREATE_EVENT: Title | 2026-06-01T14:00 | 60] | [DELETE_EVENT: id] (confirmed)
 DRIVE NOTES: [LIST_NOTES] | [LIST_NOTES: 50] | [SEARCH_DRIVE: keyword] | [READ_NOTE: name] | [READ_FILE_ID: fileId] | [CREATE_NOTE: title | content] | [EDIT_NOTE: fileId | content] | [DELETE_FILE: fileId] (confirmed)
   Long docs come back one page at a time and the result says so — get the next page with [READ_NOTE: name | 2] (then | 3, …) or pull the whole thing with [READ_NOTE: name | all]. Same | 2 / | all works on [READ_FILE_ID: id | 2].
 SHEETS: [CREATE_SHEET: title | col1,col2 | val1,val2]
 TASKS: [READ_TASKS] | [CREATE_TASK: title | notes | due] | [COMPLETE_TASK: name] | [DELETE_TASK: name] — these also sync to the app's own task list
 OTHER: [SET_REMINDER: text | YYYY-MM-DD] | [SYNC_AND_SAVE]]`;
    }else{
      sys+=`\n\n[GOOGLE: not connected. If Mr. Burrus asks about email, calendar, Drive or Google tasks, tell him to link his account in Settings → GOOGLE.]`;
    }
  }catch{}
  const hud=await getHudState();const tasks=await getTasks();
  if(hud){
    let routineDone={};try{routineDone=JSON.parse(hud.morning_routine_done||'{}');}catch{}
    let routine=[];try{routine=JSON.parse(hud.morning_routine||'[]');}catch{}
    const routineItems=(Array.isArray(routine)?routine:[]).map(r=>(typeof r==='string'?{id:r,label:r}:r));
    const routineCount=routineItems.filter(r=>routineDone[r.id]).length;
    const routineList=routineItems.map(r=>`${routineDone[r.id]?'[x]':'[ ]'} ${r.label}`).join(', ')||'none set';
    let bt=[];try{bt=JSON.parse(hud.batman_template||'[]');}catch{}
    const dow=new Date().getDay();
    const todayBat=Array.isArray(bt)&&bt.length===7?bt[dow===0?6:dow-1]:null;
    const openTasks=tasks.map(t=>t.title).slice(0,15).join(', ');
    let upcoming='';
    try{
      const d=await getUpcomingDates(21);
      if(d.length)upcoming=`\nUpcoming Dates: ${d.map(x=>`${x.label} (${x.daysOut===0?'today':x.daysOut===1?'tomorrow':`in ${x.daysOut}d`})`).join(', ')}`;
    }catch{}
    sys+=`\n\n[LIVE HUD DATA:\nEmpire Score: ${hud.empire_score}%\nStreak: ${hud.streak} days\nWord of Day: ${hud.word_of_day||'Not set'}\nVerse of Day: ${hud.verse_of_day||'Not set'}\nFact of Day: ${hud.fact_of_day||'Not set'}\nMorning Routine (${routineCount}/${routineItems.length}): ${routineList}\nBatman Protocol Today: ${todayBat?`${todayBat.label} — ${todayBat.desc}`:'Not set'}\nOpen Tasks (${tasks.length}): ${openTasks||'none'}${upcoming}\n]`;
  }
  try{
    const{computeNudges}=await import('./nudges');
    const nudges=await computeNudges();
    if(nudges.length)sys+=`\n\n[PROACTIVE NUDGES — raise any of these yourself if it fits the conversation, don't wait to be asked: ${nudges.map(n=>n.text).join(' · ')}]`;
  }catch{}
  const lastUser=[...convo].reverse().find(m=>m?.role==='user'&&m?.content);
  const mem=await getPersonaMemory(personaId,{query:lastUser?.content||'',limit:16});
  if(mem?.length){
    const body=mem.map(m=>`[${m.date}${m.category?' · '+m.category:''}]\n${m.content}`).join('\n\n');
    sys+=`\n\n[MEMORY — past exchanges kept in full, most relevant to the current message first. Reference naturally; never claim you don't remember:\n${body.substring(0,6000)}\n]`;
  }
  return sys;
}
// SSE over XHR — React Native's fetch can't expose a streaming response body,
// but XMLHttpRequest fires `onprogress` with the partial `responseText`, so we
// parse newline-delimited `data:` frames out of it as they arrive. Resolves
// once the response completes; rejects on non-2xx, network error, abort, or an
// error thrown by `onEvent`.
function xhrStream({url,headers,body,signal,onEvent}){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open('POST',url);
    xhr.setRequestHeader('Accept','text/event-stream');
    for(const key in headers)xhr.setRequestHeader(key,headers[key]);
    let seen=0,failed=null;
    const handleLine=(line)=>{
      line=line.trim();
      if(!line.startsWith('data:'))return;
      const payload=line.slice(5).trim();
      if(!payload||payload==='[DONE]')return;
      let json;try{json=JSON.parse(payload);}catch{return;}
      try{onEvent(json);}catch(err){failed=err;try{xhr.abort();}catch{}}
    };
    const pump=(final)=>{
      if(failed)return;
      const buf=xhr.responseText||'';
      let nl;
      while((nl=buf.indexOf('\n',seen))>=0){
        handleLine(buf.slice(seen,nl));
        seen=nl+1;
        if(failed)return;
      }
      // On the last read, flush a final line that has no newline terminator —
      // some servers don't send a trailing \n, which was dropping the last token.
      if(final&&seen<buf.length){handleLine(buf.slice(seen));seen=buf.length;}
    };
    xhr.onprogress=()=>pump(false);
    xhr.onreadystatechange=()=>{if(xhr.readyState===3)pump(false);}; // RN delivers partial text here
    xhr.onload=()=>{
      pump(true);
      if(failed)return reject(failed);
      if(xhr.status>=200&&xhr.status<300)resolve();
      else reject(new Error(`HTTP ${xhr.status}: ${String(xhr.responseText||'').substring(0,160)}`));
    };
    xhr.onerror=()=>reject(new Error('Network request failed'));
    xhr.onabort=()=>reject(failed||Object.assign(new Error('Aborted'),{name:'AbortError'}));
    if(signal){
      if(signal.aborted){xhr.abort();return;}
      if(typeof signal.addEventListener==='function')signal.addEventListener('abort',()=>{try{xhr.abort();}catch{}});
    }
    xhr.send(body);
  });
}

export async function callPersona(personaId,messages,signal=null,onDelta=null,opts={}){
  const k=await ensureKeys();
  const{getPersona}=await import('../personas/personas');
  const persona=getPersona(personaId);
  const sys=await buildSys(personaId,persona,messages);
  const hist=messages.slice(-20).map(m=>({role:m.role==='system'?'user':m.role,content:m.content}));
  const stream=typeof onDelta==='function';
  const maxTokens=opts.maxTokens||1500;
  let response='';
  const emit=(t)=>{if(t){response+=t;if(stream){try{onDelta(t);}catch{}}}};
  if(persona.api==='claude'){
    const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
    const url=base+'/v1/messages';
    const headers={'Content-Type':'application/json',...auth};
    const body=JSON.stringify({model:opts.model||persona.model||'claude-sonnet-4-6',max_tokens:maxTokens,system:sys,messages:hist,stream});
    if(stream){
      let tin=0,tout=0;
      await xhrStream({url,headers,body,signal,onEvent:(e)=>{
        if(e.type==='content_block_delta'&&e.delta?.text)emit(e.delta.text);
        else if(e.type==='message_start')tin=e.message?.usage?.input_tokens||0;
        else if(e.type==='message_delta')tout=e.usage?.output_tokens||tout;
        else if(e.type==='error')throw new Error(e.error?.message||'Claude stream error');
      }});
      if(tin||tout)await trackApiUsage('claude',tin,tout).catch(()=>{});
    }else{
      const res=await fetch(url,{method:'POST',headers,body,signal});
      if(!res.ok){const e=await res.text();throw new Error(`Claude error: ${e.substring(0,100)}`);}
      const d=await res.json();
      emit(d.content?.[0]?.text||'');
      if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
    }
  }else if(persona.api==='grok'){
    const{base,auth}=await aiRoute('grok',k?.grok,'Grok');
    const url=base+'/v1/chat/completions';
    const headers={'Content-Type':'application/json',...auth};
    const body=JSON.stringify({model:opts.model||persona.model||'grok-3-latest',max_tokens:maxTokens,messages:[{role:'system',content:sys},...hist],stream});
    if(stream){
      await xhrStream({url,headers,body,signal,onEvent:(e)=>{
        const c=e.choices?.[0]?.delta?.content;if(c)emit(c);
        if(e.usage)trackApiUsage('grok',e.usage.prompt_tokens||0,e.usage.completion_tokens||0).catch(()=>{});
      }});
    }else{
      const res=await fetch(url,{method:'POST',headers,body,signal});
      if(!res.ok){const e=await res.text();throw new Error(`Grok error: ${e.substring(0,100)}`);}
      const d=await res.json();
      emit(d.choices?.[0]?.message?.content||'');
      if(d.usage)await trackApiUsage('grok',d.usage.prompt_tokens||0,d.usage.completion_tokens||0).catch(()=>{});
    }
  }else if(persona.api==='openai'){
    const{base,auth}=await aiRoute('openai',k?.openai,'OpenAI');
    const url=base+'/v1/chat/completions';
    const headers={'Content-Type':'application/json',...auth};
    const body=JSON.stringify({model:opts.model||persona.model||'gpt-4o',max_tokens:maxTokens,messages:[{role:'system',content:sys},...hist],stream,...(stream?{stream_options:{include_usage:true}}:{})});
    if(stream){
      await xhrStream({url,headers,body,signal,onEvent:(e)=>{
        const c=e.choices?.[0]?.delta?.content;if(c)emit(c);
        if(e.usage)trackApiUsage('openai',e.usage.prompt_tokens||0,e.usage.completion_tokens||0).catch(()=>{});
      }});
    }else{
      const res=await fetch(url,{method:'POST',headers,body,signal});
      if(!res.ok){const e=await res.text();throw new Error(`OpenAI error: ${e.substring(0,100)}`);}
      const d=await res.json();
      emit(d.choices?.[0]?.message?.content||'');
      if(d.usage)await trackApiUsage('openai',d.usage.prompt_tokens||0,d.usage.completion_tokens||0).catch(()=>{});
    }
  }
  const lastUser=messages.filter(m=>m.role==='user').slice(-1)[0];
  if(lastUser&&response&&!opts.skipSave){await savePersonaMemory(personaId,`YOU: ${lastUser.content}\n${persona.name}: ${response}`).catch(()=>{});}
  return response;
}

// The Claude-backed memory index. Reasons over a persona's raw stored exchanges
// and answers a recall question in plain language — this is what a persona
// reaches for via [MEMORY_QUERY:...] when it needs to remember something
// specific beyond the recent context already in its prompt. Always Claude,
// regardless of which model runs the persona's conversation.
export async function queryMemory(personaId,question,signal=null){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
  const{getPersona}=await import('../personas/personas');
  const persona=getPersona(personaId);
  let rows=[];
  try{rows=await getPersonaMemory(personaId,{query:question,limit:60});}catch{}
  if(!rows.length){try{rows=(await getMemoriesByPersona(personaId)).slice(0,60);}catch{}}
  const corpus=rows.map(r=>`[${r.date}${r.category?' · '+r.category:''}]\n${r.content}`).join('\n\n').slice(0,14000);
  const sys=`You are the private memory index for ${persona.name}, the assistant to Mr. Burrus. Below are stored exchanges between Mr. Burrus and ${persona.name}, newest first. Answer the recall question using ONLY what is in these memories. Be specific — quote dates and details. If the memories do not cover it, say so in one sentence. No preamble.\n\n=== STORED MEMORIES ===\n${corpus||'(none)'}\n=== END ===`;
  const res=await fetch(base+'/v1/messages',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:700,system:sys,messages:[{role:'user',content:question}]}),signal});
  if(!res.ok){const e=await res.text();throw new Error(`memory recall: ${e.substring(0,80)}`);}
  const d=await res.json();
  if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
  return d.content?.[0]?.text?.trim()||'(no recall)';
}

// Quick web search — a tight factual briefing, not deep research. Grok Live
// Search for Grok personas, Claude's web_search tool otherwise.
export async function webSearch(personaId,query,signal=null){
  const k=await ensureKeys();
  const{getPersona}=await import('../personas/personas');
  const persona=getPersona(personaId);
  const brief='Search the web and give a tight, factual briefing: the key numbers, facts, and dates, with source names inline. No fluff, no preamble.';
  const be=await loadBackend();
  if(persona.api==='grok'&&(k?.grok||be)){
    const{base,auth}=await aiRoute('grok',k?.grok,'Grok');
    const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({
      model:persona.model||'grok-3-latest',max_tokens:900,
      messages:[{role:'system',content:brief},{role:'user',content:query}],
      search_parameters:{mode:'on',return_citations:true,max_search_results:8},
    }),signal});
    if(!res.ok)throw new Error(`web search: ${(await res.text()).substring(0,80)}`);
    const d=await res.json();
    if(d.usage)await trackApiUsage('grok',d.usage.prompt_tokens||0,d.usage.completion_tokens||0).catch(()=>{});
    const txt=d.choices?.[0]?.message?.content||'';
    const cites=d.citations?.length?`\n\nSources: ${d.citations.slice(0,8).join(' · ')}`:'';
    return(txt+cites).trim()||'(no results)';
  }
  if(k?.claude||be){
    const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
    const res=await fetch(base+'/v1/messages',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({
      model:'claude-sonnet-4-6',max_tokens:1000,
      tools:[{type:'web_search_20250305',name:'web_search',max_uses:5}],
      messages:[{role:'user',content:`${brief}\n\nQuery: ${query}`}],
    }),signal});
    if(!res.ok)throw new Error(`web search: ${(await res.text()).substring(0,80)}`);
    const d=await res.json();
    if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
    return(d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim()||'(no results)';
  }
  throw new Error('web search needs a Grok or Claude API key, or a connected backend');
}

// Long-form autonomous research via OpenAI Deep Research. Runs for minutes —
// started in the background, caller polls deepResearchPoll(id). Orchestration,
// persistence and delivery live in services/deepResearch.js.
const DR_MODEL_CHAINS={
  auto:['o3-deep-research','o4-mini-deep-research'],
  'o3-deep-research':['o3-deep-research'],
  'o4-mini-deep-research':['o4-mini-deep-research'],
};
function apiErrorMessage(raw){
  try{const j=JSON.parse(raw);return j.error?.message||j.message||raw;}catch{return raw;}
}
// true when the failure is "this account can't use this model" — worth trying the next one
function isModelAccessError(msg){
  return /model.*(not found|does not exist|not available)|not found.*model|must be verified|verify your organization|verification|do not have access|unsupported model/i.test(msg||'');
}

export async function deepResearchStart(topic,pref='auto'){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('openai',k?.openai,'OpenAI');
  const chain=DR_MODEL_CHAINS[pref]||DR_MODEL_CHAINS.auto;
  let lastErr='unknown error';
  for(const model of chain){
    const res=await fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({
      model,
      input:`Research this thoroughly and return a structured brief with findings, key figures, and cited sources:\n\n${topic}`,
      background:true,
      tools:[{type:'web_search_preview'}],
    })});
    if(res.ok){const d=await res.json();return{id:d.id,model};}
    lastErr=apiErrorMessage(await res.text());
    if(!isModelAccessError(lastErr))break; // a real error, not a model-availability one — stop
  }
  if(/verif/i.test(lastErr))
    throw new Error(`Deep research needs OpenAI organization verification. Verify at platform.openai.com/settings/organization/general, then try again. (${lastErr.slice(0,120)})`);
  if(isModelAccessError(lastErr))
    throw new Error(`Your OpenAI account can't access the deep-research models (${chain.join(' or ')}). ${lastErr.slice(0,140)}`);
  throw new Error(`Deep research failed to start: ${lastErr.slice(0,160)}`);
}

// Returns {status, text?, error?, progress:{searches,step}}.
export async function deepResearchPoll(id){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('openai',k?.openai,'OpenAI');
  const res=await fetch(base+'/v1/responses/'+id,{headers:{...auth}});
  if(!res.ok)throw new Error(`Deep Research poll: ${apiErrorMessage(await res.text()).slice(0,120)}`);
  const d=await res.json();
  const out=Array.isArray(d.output)?d.output:[];
  const searches=out.filter(o=>o.type==='web_search_call').length;
  const lastReason=[...out].reverse().find(o=>o.type==='reasoning');
  let step=lastReason?.summary;
  if(Array.isArray(step))step=step.map(x=>x?.text||x).join(' ');
  const progress={searches,step:typeof step==='string'?step.slice(0,140):''};

  if(d.status==='completed'){
    if(d.usage)await trackApiUsage('openai',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
    const text=d.output_text||out.flatMap(o=>(o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text)).join('\n');
    return{status:'completed',text:text||'(Deep Research returned no text)',progress};
  }
  if(d.status==='failed'||d.status==='cancelled'||d.status==='incomplete'){
    return{status:d.status==='cancelled'?'cancelled':'failed',
      error:d.error?.message||d.incomplete_details?.reason||d.status,progress};
  }
  return{status:d.status||'running',progress};
}
// Synthesize `text` in a persona's ElevenLabs voice -> local .mp3 URI (or null).
// opts: { signal, previousText, nextText } — previous/next give the flash model
// the surrounding context so per-sentence chunks keep their prosody.
// Retries once on a transient failure before giving up (a dropped TTS call is
// what makes a persona fall back to the flat native voice mid-answer).
export async function textToSpeech(text,voiceId,personaName,opts={}){
  const k=await ensureKeys();
  const be=await loadBackend();
  if(!be&&!k?.elevenlabs)return null;
  if(!voiceId)return null;
  const clean=text.replace(/\[[^\]]*\]/g,'').replace(/[*#`]/g,'').trim().substring(0,2000);
  if(!clean)return null;
  const body={
    text:clean,
    model_id:'eleven_flash_v2_5',
    voice_settings:{stability:0.5,similarity_boost:0.8},
  };
  if(opts.previousText)body.previous_text=String(opts.previousText).slice(-500);
  if(opts.nextText)body.next_text=String(opts.nextText).slice(0,500);
  for(let attempt=0;attempt<2;attempt++){
    try{
      const{base,auth}=await aiRoute('elevenlabs',k?.elevenlabs,'ElevenLabs');
      const res=await fetch(`${base}/v1/text-to-speech/${voiceId}`,{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify(body),signal:opts.signal});
      if(!res.ok){
        if(attempt===0&&(res.status===429||res.status>=500))continue;
        return null;
      }
      const arrayBuffer=await res.arrayBuffer();
      const bytes=new Uint8Array(arrayBuffer);
      let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));
      const base64=btoa(binary);
      const uri=FileSystem.cacheDirectory+'tts_'+Date.now()+'_'+Math.random().toString(36).slice(2,7)+'.mp3';
      await FileSystem.writeAsStringAsync(uri,base64,{encoding:FileSystem.EncodingType.Base64});
      return uri;
    }catch(err){
      if(err?.name==='AbortError')return null;
      if(attempt===0)continue;
      return null;
    }
  }
  return null;
}
export async function transcribeAudio(audioUri){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('openai',k?.openai,'OpenAI');
  const formData=new FormData();
  formData.append('file',{uri:audioUri,type:'audio/m4a',name:'voice.m4a'});
  formData.append('model','whisper-1');
  formData.append('language','en');
  formData.append('temperature','0');
  // A neutral priming sentence — Whisper is less likely to drop the final word
  // of a short clip when it isn't starting cold.
  formData.append('prompt','Okay. Here is what I need you to do.');
  const res=await fetch(base+'/v1/audio/transcriptions',{method:'POST',headers:{...auth},body:formData});
  if(!res.ok){const e=await res.text();throw new Error('Whisper: '+e.substring(0,100));}
  const d=await res.json();
  return d.text?.trim()||'';
}
