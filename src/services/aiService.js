import{loadKeys}from './keyStore';
import{getPersonaMemory,savePersonaMemory,getHudState,getTasks,trackApiUsage,getCustomPrompt}from './database';
import*as FileSystem from 'expo-file-system';
import{reportError}from '../../ErrorBanner';
let keys=null;
async function ensureKeys(){if(!keys)keys=await loadKeys();return keys;}
async function buildSys(personaId,persona){
  const now=new Date();
  const timeStr=now.toLocaleString('en-US',{timeZone:'America/New_York',weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true});
  const jan=new Date(now.getFullYear(),0,1).getTimezoneOffset();
  const jul=new Date(now.getFullYear(),6,1).getTimezoneOffset();
  const tz=now.getTimezoneOffset()<Math.max(jan,jul)?'EDT':'EST';
  const customPrompt=await getCustomPrompt(personaId);
  let sys=customPrompt||persona.system;
  sys+=`\n\n[CURRENT DATE & TIME: ${timeStr} ${tz} | LOCATION: Waldorf, MD]`;
  const hud=await getHudState();const tasks=await getTasks();
  if(hud){
    let routineDone={};try{routineDone=JSON.parse(hud.morning_routine_done||'{}');}catch{}
    let routine=[];try{routine=JSON.parse(hud.morning_routine||'[]');}catch{}
    const routineCount=Object.values(routineDone).filter(Boolean).length;
    sys+=`\n\n[LIVE HUD DATA:\nEmpire Score: ${hud.empire_score}%\nStreak: ${hud.streak} days\nWord of Day: ${hud.word_of_day||'Not set'}\nVerse of Day: ${hud.verse_of_day||'Not set'}\nFact of Day: ${hud.fact_of_day||'Not set'}\nMorning Routine: ${routineCount}/${routine.length} complete\nOpen Tasks: ${tasks.length}\n]`;
  }
  const mem=await getPersonaMemory(personaId,14);
  if(mem?.length){sys+=`\n\n[MEMORY FROM RECENT SESSIONS:\n${mem.map(m=>`[${m.date}]\n${m.content}`).join('\n\n').substring(0,3000)}\n]`;}
  return sys;
}
export async function callPersona(personaId,messages,signal=null){
  const k=await ensureKeys();
  const{getPersona}=await import('../personas/personas');
  const persona=getPersona(personaId);
  const sys=await buildSys(personaId,persona);
  const hist=messages.slice(-20).map(m=>({role:m.role==='system'?'user':m.role,content:m.content}));
  let response='';
  if(persona.api==='claude'){
    if(!k?.claude)throw new Error('No Claude API key. Go to Settings.');
    const res=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':k.claude,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:persona.model||'claude-sonnet-4-6',max_tokens:1500,system:sys,messages:hist}),signal});
    if(!res.ok){const e=await res.text();throw new Error(`Claude error: ${e.substring(0,100)}`);}
    const d=await res.json();
    response=d.content?.[0]?.text||'';
    if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
  }else if(persona.api==='grok'){
    if(!k?.grok)throw new Error('No Grok API key. Go to Settings.');
    const res=await fetch('https://api.x.ai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+k.grok},body:JSON.stringify({model:persona.model||'grok-3-latest',max_tokens:1500,messages:[{role:'system',content:sys},...hist]}),signal});
    if(!res.ok){const e=await res.text();throw new Error(`Grok error: ${e.substring(0,100)}`);}
    const d=await res.json();
    response=d.choices?.[0]?.message?.content||'';
    if(d.usage)await trackApiUsage('grok',d.usage.prompt_tokens||0,d.usage.completion_tokens||0).catch(()=>{});
  }else if(persona.api==='openai'){
    if(!k?.openai)throw new Error('No OpenAI API key. Go to Settings.');
    const res=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+k.openai},body:JSON.stringify({model:persona.model||'gpt-4o',max_tokens:1500,messages:[{role:'system',content:sys},...hist]}),signal});
    if(!res.ok){const e=await res.text();throw new Error(`OpenAI error: ${e.substring(0,100)}`);}
    const d=await res.json();
    response=d.choices?.[0]?.message?.content||'';
    if(d.usage)await trackApiUsage('openai',d.usage.prompt_tokens||0,d.usage.completion_tokens||0).catch(()=>{});
  }
  const lastUser=messages.filter(m=>m.role==='user').slice(-1)[0];
  if(lastUser&&response){await savePersonaMemory(personaId,`YOU: ${lastUser.content.substring(0,400)}\n${persona.name}: ${response.substring(0,600)}`).catch(()=>{});}
  return response;
}
export async function textToSpeech(text,voiceId){
  const k=await ensureKeys();
  if(!k?.elevenlabs){reportError('ElevenLabs: no API key found');return null;}
  if(!voiceId){reportError('ElevenLabs: no voiceId provided for this persona');return null;}
  const clean=text.replace(/\[[^\]]*\]/g,'').replace(/[*#`]/g,'').trim().substring(0,2000);
  if(!clean)return null;
  try{
    const res=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,{method:'POST',headers:{'Content-Type':'application/json','xi-api-key':k.elevenlabs},body:JSON.stringify({text:clean,model_id:'eleven_monolingual_v1',voice_settings:{stability:0.5,similarity_boost:0.8}})});
    if(!res.ok){const e=await res.text();reportError(`ElevenLabs API error (${res.status}): ${e.substring(0,150)}`);return null;}
    const arrayBuffer=await res.arrayBuffer();
    const bytes=new Uint8Array(arrayBuffer);
    let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));
    const base64=btoa(binary);
    const uri=FileSystem.cacheDirectory+'tts_'+Date.now()+'.mp3';
    await FileSystem.writeAsStringAsync(uri,base64,{encoding:FileSystem.EncodingType.Base64});
    return uri;
  }catch(err){reportError('ElevenLabs exception: '+err.message);return null;}
}
export async function transcribeAudio(audioUri){
  const k=await ensureKeys();
  if(!k?.openai)throw new Error('OpenAI API key needed for voice transcription. Add it in Settings.');
  const formData=new FormData();
  formData.append('file',{uri:audioUri,type:'audio/m4a',name:'voice.m4a'});
  formData.append('model','whisper-1');
  formData.append('language','en');
  const res=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{'Authorization':'Bearer '+k.openai},body:formData});
  if(!res.ok){const e=await res.text();throw new Error('Whisper: '+e.substring(0,100));}
  const d=await res.json();
  return d.text?.trim()||'';
}
