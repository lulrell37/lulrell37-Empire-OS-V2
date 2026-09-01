import{loadKeys,loadBackend}from './keyStore';
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
  sys+=`\n\n[CURRENT DATE & TIME: ${timeStr} ${tz} | LOCATION: Waldorf, MD]`;
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
  let response='';
  const emit=(t)=>{if(t){response+=t;if(stream){try{onDelta(t);}catch{}}}};
  if(persona.api==='claude'){
    const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
    const url=base+'/v1/messages';
    const headers={'Content-Type':'application/json',...auth};
    const body=JSON.stringify({model:persona.model||'claude-sonnet-4-6',max_tokens:1500,system:sys,messages:hist,stream});
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
    const body=JSON.stringify({model:persona.model||'grok-3-latest',max_tokens:1500,messages:[{role:'system',content:sys},...hist],stream});
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
    const body=JSON.stringify({model:persona.model||'gpt-4o',max_tokens:1500,messages:[{role:'system',content:sys},...hist],stream,...(stream?{stream_options:{include_usage:true}}:{})});
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
// started in the background, caller polls deepResearchPoll(id).
export async function deepResearchStart(topic){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('openai',k?.openai,'OpenAI');
  const res=await fetch(base+'/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({
    model:'o3-deep-research',
    input:`Research this thoroughly and return a structured brief with findings, key figures, and cited sources:\n\n${topic}`,
    background:true,
    tools:[{type:'web_search_preview'}],
  })});
  if(!res.ok)throw new Error(`Deep Research: ${(await res.text()).substring(0,120)}`);
  const d=await res.json();
  return d.id;
}
export async function deepResearchPoll(id){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('openai',k?.openai,'OpenAI');
  const res=await fetch(base+'/v1/responses/'+id,{headers:{...auth}});
  if(!res.ok)throw new Error(`Deep Research poll: ${(await res.text()).substring(0,100)}`);
  const d=await res.json();
  if(d.status!=='completed')return{status:d.status};
  if(d.usage)await trackApiUsage('openai',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
  const text=d.output_text||(d.output||[]).flatMap(o=>(o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text)).join('\n');
  return{status:'completed',text:text||'(Deep Research returned no text)'};
}
export async function textToSpeech(text,voiceId,personaName){
  const k=await ensureKeys();
  const be=await loadBackend();
  if(!be&&!k?.elevenlabs){Alert.alert('ElevenLabs Error','No API key found');return null;}
  if(!voiceId){Alert.alert('ElevenLabs Error','No voiceId provided for this persona');return null;}
  const clean=text.replace(/\[[^\]]*\]/g,'').replace(/[*#`]/g,'').trim().substring(0,2000);
  if(!clean)return null;
  try{
    const{base,auth}=await aiRoute('elevenlabs',k?.elevenlabs,'ElevenLabs');
    const res=await fetch(`${base}/v1/text-to-speech/${voiceId}`,{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({text:clean,model_id:'eleven_turbo_v2_5',voice_settings:{stability:0.5,similarity_boost:0.8}})});
    if(!res.ok){const e=await res.text();Alert.alert('ElevenLabs API Error',`Status ${res.status}: ${e.substring(0,150)}`);return null;}
    const arrayBuffer=await res.arrayBuffer();
    const bytes=new Uint8Array(arrayBuffer);
    let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));
    const base64=btoa(binary);
    const uri=FileSystem.cacheDirectory+'tts_'+Date.now()+'.mp3';
    await FileSystem.writeAsStringAsync(uri,base64,{encoding:FileSystem.EncodingType.Base64});
    return uri;
  }catch(err){Alert.alert('ElevenLabs Exception',err.message);return null;}
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
