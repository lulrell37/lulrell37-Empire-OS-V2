import{loadKeys,loadBackend,loadGoogleToken}from './keyStore';
import{getPersonaMemory,getMemoriesByPersona,savePersonaMemory,getHudState,getTasks,trackApiUsage,getCustomPrompt,getUpcomingDates,getSetting}from './database';
import*as FileSystem from 'expo-file-system';
import{Alert}from 'react-native';
let keys=null;
async function ensureKeys(){if(!keys)keys=await loadKeys();return keys;}

// --- Provider routing ------------------------------------------------------
// Direct calls hit the provider with the on-device key. When a backend is
// configured in Settings, every call instead goes through `${backend}/ai/<name>`
// with the backend bearer token and the provider key never leaves the server.
const AI_BASE={claude:'https://api.anthropic.com',grok:'https://api.x.ai',openai:'https://api.openai.com',gemini:'https://generativelanguage.googleapis.com',elevenlabs:'https://api.elevenlabs.io'};
const AI_PROXY_NAME={claude:'anthropic',grok:'xai',openai:'openai',gemini:'google',elevenlabs:'elevenlabs'};
const AI_KEYHDR={
  claude:(kk)=>({'x-api-key':kk,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'}),
  grok:(kk)=>({Authorization:'Bearer '+kk}),
  openai:(kk)=>({Authorization:'Bearer '+kk}),
  gemini:(kk)=>({'x-goog-api-key':kk}),
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
  const{sys}=await buildSys(personaId,getPersona(personaId),[]);
  return sys;
}

// The current moment in Mr. Burrus's timezone, computed fresh every call.
// Personas anchor to the last dated thing they saw, so stale chat history / old
// memory entries were making them think it was still the day or time of the
// previous conversation. Used both at the end of the system prompt and stamped
// onto the latest user turn.
export function currentMoment(){
  const now=new Date();
  const timeStr=now.toLocaleString('en-US',{timeZone:'America/New_York',weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',hour12:true});
  const jan=new Date(now.getFullYear(),0,1).getTimezoneOffset();
  const jul=new Date(now.getFullYear(),6,1).getTimezoneOffset();
  const tz=now.getTimezoneOffset()<Math.max(jan,jul)?'EDT':'EST';
  return{timeStr,tz,label:`${timeStr} ${tz}`};
}

async function buildSys(personaId,persona,convo=[]){
  const{timeStr,tz}=currentMoment();
  const customPrompt=await getCustomPrompt(personaId);
  let sys=customPrompt||persona.system;
  sys+=`\n\n[RESPONSE STYLE: Reply directly to what Mr. Burrus just said. Do not open with a status briefing, HUD summary, morning-routine readout, or any unprompted overview unless he explicitly asks for one. Skip "here is where things stand" preambles — answer the message and stop.]`;
  sys+=`\n\n[SAVE_NOTE STYLE: The [SAVE_NOTE:title|content] tag itself is what writes the note — don't also narrate the full content back in your visible reply first. A short acknowledgment ("Saved that as '<title>'.") is enough; spelling out everything you just put in the tag is redundant.]`;
  sys+=`\n\n[MEMORY RECALL: The memory block below is routed to the topic Mr. Burrus is on right now — your full history for that area, plus anything pinned. If he references something specific that ISN'T shown, emit [MEMORY_QUERY: your precise question] and your memory index answers before you reply — use it whenever he points back to a past conversation, not just rarely.
PINNING: when he tells you something that matters over the next few days — a trip, a deadline, a decision in progress, something he is waiting on — keep it in front of you with [REMEMBER: the thing | days] (1-30, default 3). It rides in your context every turn until it expires. [UNPIN_MEMORY: a few words of it] drops it early. Never mention these mechanisms — just remember.]`;
  sys+=`\n\n[THE CANVAS — the orb screen Mr. Burrus is looking at can become an interactive surface. When he asks to SEE or WORK WITH something rather than just hear it, emit the matching tag in the same reply as your answer and the orb transforms into it; he takes it from there and closes it himself.
- [SHOW_NOTES] — his notes as a list he can open and edit. [SHOW_NOTE: exact title] opens one straight away.
- [SHOW_TASKS] — his tasks and morning routine as a checklist he can tick, add to and rename.
- [SHOW_ANALYTICS] — the live Empire board: revenue vs target, content, trading, outreach. (P.U.L.S.E.'s home turf — hand analytics questions to her with [RELAY_TO:pulse|...].)
- [SHOW_CHART: type | title | data] — a chart. type = line, area, bar, or pie. data = "label:value, label:value, ..." for one series, or "A=x:1,y:2; B=x:3,y:4" for several. Use it for trends, breakdowns and comparisons — not one or two numbers.
Only when seeing or editing the thing is the point — not for a passing mention. One surface per reply.]`;
  sys+=`\n\n[WEB: You can search the live web with [SEARCH_WEB: query] (max 1 per turn) — the result comes back before you reply. Use it only when the answer really turns on something current that you can't know: today's price, a recent event, a just-released product, a fast-moving number. For general knowledge, or in quick back-and-forth conversation, just answer directly — a search adds a noticeable delay before you can speak, so it must be worth it. Don't mention the mechanism; weave in what you find with source names.]`;
  sys+=`\n\n[DEEP RESEARCH: for a long, thorough, cited report on something in your lane — ONLY when Mr. Burrus explicitly asks you to "do deep research" / "a deep dive" / "the full research". Putting the literal tag [DEEP_RESEARCH: the question or topic] in your reply is the ONLY thing that starts a job — writing "I'll start deep research on that" without the tag does nothing and leaves him waiting, so when he asks, the tag goes in that same reply. It runs on Claude with live web search — around a dozen searches across angles, several minutes, one job at a time, keep the app open; the finished brief lands back in this chat and is saved as a Note. Not for quick facts — that's [SEARCH_WEB]. One [DEEP_RESEARCH] per turn.]`;
  sys+=`\n\n[WATCH A VIDEO: emit [WATCH_VIDEO: <url> | <what to look for>] to hand a video off to the watch agent — a YouTube / TikTok / Instagram / X / Facebook / Vimeo link, a Google Drive share link, or a direct file link. The second field is optional but nearly always worth giving: the specific question or angle — the hook, the structure, why it retains, how they'd do a competing version, a direct question. It runs async: the agent downloads the video, transcribes it, detects the cuts, and does a real vision pass over sampled frames, then brings back a written breakdown (hook, beat-by-beat structure, retention devices, strengths/weaknesses, what to steal, and a direct answer to the focus) plus a full report link. It does NOT come back instantly — a few minutes. Tell Mr. Burrus it's queued and that you'll bring him what it found. One [WATCH_VIDEO] per turn. This is a deeper read than the frames the app samples inline when he attaches a video to chat — use it when the video is worth actually studying.]`;
  // Everything up to here — the persona identity + the fixed instruction blocks —
  // is byte-identical on every call for this persona, so it's the prompt-cache
  // prefix (see callPersona). Everything after (Google status, HUD, memory, the
  // current moment) is per-call and must stay outside the cached span.
  const cacheAt=sys.length;
  try{
    const gt=await loadGoogleToken();
    if(gt?.accessToken){
      sys+=`\n\n[GOOGLE — connected. Use these when they genuinely help; results come back before you answer; never mention the mechanism:
 EMAIL: [READ_EMAIL] | [SEND_EMAIL: to | subject | body] (Mr. Burrus taps to confirm before it sends)
 CALENDAR: [READ_CALENDAR] | [READ_CALENDAR: 30] | [READ_CALENDAR: 2026-08-01 | 30] | [CREATE_EVENT: Title | 2026-06-01T14:00 | 60] | [DELETE_EVENT: id] (confirmed)
 DRIVE NOTES: [LIST_NOTES] | [LIST_NOTES: 50] | [SEARCH_DRIVE: keyword] | [READ_NOTE: name] | [READ_FILE_ID: fileId] | [CREATE_NOTE: title | content] | [EDIT_NOTE: fileId | content] | [DELETE_FILE: fileId] (confirmed)
   Long docs come back one page at a time and the result says so — get the next page with [READ_NOTE: name | 2] (then | 3, …) or pull the whole thing with [READ_NOTE: name | all]. Same | 2 / | all works on [READ_FILE_ID: id | 2].
   Notes live as .md files in a Drive folder called "Empire OS Notes" so an Obsidian vault can sync to them. [SYNC_NOTES] pulls any older loose notes into that folder — offer it if Mr. Burrus mentions Obsidian or organizing his notes.
 SHEETS: [CREATE_SHEET: title | col1,col2 | val1,val2]
 TASKS: [READ_TASKS] | [CREATE_TASK: title | notes | due] | [COMPLETE_TASK: name] | [DELETE_TASK: name] — these also sync to the app's own task list
 OTHER: [SET_REMINDER: text | YYYY-MM-DD] | [SYNC_AND_SAVE]]`;
    }else{
      sys+=`\n\n[GOOGLE: not connected. If Mr. Burrus asks about email, calendar, Drive or Google tasks, tell him to link his account in Settings → GOOGLE.]`;
    }
  }catch{}
  const hud=await getHudState();
  // The HUD's task list is Google Tasks (when connected) merged with local-only
  // tasks — the same list the on-screen HUD shows. Use that, not getTasks()
  // (local table only), so a persona sees exactly what Mr. Burrus sees.
  let tasks=[];
  try{const{loadHudTasks}=await import('./hudTasks');tasks=await loadHudTasks();}
  catch{try{tasks=await getTasks();}catch{}}
  if(hud){
    let routineDone={};try{routineDone=JSON.parse(hud.morning_routine_done||'{}');}catch{}
    let routine=[];try{routine=JSON.parse(hud.morning_routine||'[]');}catch{}
    const routineItems=(Array.isArray(routine)?routine:[]).map(r=>(typeof r==='string'?{id:r,label:r}:r));
    const routineCount=routineItems.filter(r=>routineDone[r.id]).length;
    const routineList=routineItems.map(r=>`${routineDone[r.id]?'[x]':'[ ]'} ${r.label}`).join(', ')||'none set';
    let bt=[];try{bt=JSON.parse(hud.batman_template||'[]');}catch{}
    const dow=new Date().getDay();
    const todayBat=Array.isArray(bt)&&bt.length===7?bt[dow===0?6:dow-1]:null;
    const openTasks=tasks.slice(0,20).map(t=>t.due?`${t.title} (due ${t.due})`:t.title).join(', ');
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
  // A.R.A. runs the day and N.O.V.A. reads across domains — both get a live
  // cross-front status read (revenue, trading, outreach, builds) every turn.
  if(personaId==='ara'||personaId==='nova'){
    try{
      const{empireStatusBlock}=await import('./empireStatus');
      sys+=await empireStatusBlock(personaId);
    }catch{}
  }
  // THE EMPIRE ROSTER + THE FIRM — every persona knows who the others are, and
  // how it participates in A.R.A.-coordinated projects. Kept here (not in
  // persona.system) so it still applies when the user has set a custom prompt.
  try{
    const{PERSONA_LIST,PROJECT_ROLES}=await import('../personas/personas');
    const roster=PERSONA_LIST.filter(x=>x.id!==personaId).map(x=>` - ${x.name} (${x.id}) — ${x.role}`).join('\n');
    if(roster)sys+=`\n\n[THE EMPIRE — the other personas who serve Mr. Burrus alongside you. Know them, refer to them by name, and hand off anything outside your lane with [RELAY_TO: id | message]. This is synchronous: the app actually asks them and hands you their real answer back in this same turn before you respond to Mr. Burrus — so ask a complete, specific question (not "I'll check with X and get back to you"), then use what they say. Don't guess at what another persona would say; relay to them and wait for it.\n${roster}\n]`;
    if(personaId==='ara'){
      sys+=`\n\n[THE FIRM — client & project delivery. When Mr. Burrus brings you a project (a client website, a launch, a course, a brand) you run it as coordinator: scope it, delegate it, pull the pieces together, keep him in the loop.
- Open it once, up front: [PROJECT_START: short name | one-paragraph brief in your own words — the client, what they need, the goal, any constraints he gave | target]. The third field is where the build lands: "new" spins up a dedicated GitHub repo for this client (use this for anything external — a client's website, app or landing page — so it never touches Empire OS); "empire" builds into Empire OS V2 itself (only when the project genuinely IS a change to this app). Default to "new" for outside client work. If the brief is thin, ask the two or three questions that matter first.
- Delegate to the specialists it needs — one or several in the same reply: [DELEGATE: name | the specific scoped task]. Each one works and reports back to you before you synthesize. Roles: Selene = brand & visual identity; Rogue = copy & content strategy; J.A.R.V.I.S. = architecture & build feasibility (he executes the final build separately); Atlas = pricing structure & payment systems; Asia = legal, terms, privacy, compliance, risk; Stephanie = training or educational content; Haven = health & wellness protocol content. Only pull in the roles that fit.
- Synthesize: what each delivered, how it fits together, what is decided, what still needs his call. Name any conflict between contributions instead of smoothing it over.
- Hand off the build once he approves with [BUILD_REQUEST: spec] — it goes to the project's repo automatically (for a "new" project that repo is created the moment you open the project). A build runs to completion, so a full spec is fine; still, prefer to stage a large from-scratch build (scaffold and structure first, then content, then polish) — each stage lands as its own reviewable pull request Mr. Burrus can check before the next, and a focused request produces better work than one that tries to do everything at once.
- If a build comes back failed, read what Claude Code got done, then re-file a request for the rest.
- [PROJECT_DONE] when it ships or gets shelved.]`;
    }else if(personaId==='jarvis'){
      sys+=`\n\n[THE FIRM: A.R.A. coordinates client & project work. When she hands you a synthesized build spec — visual direction, copy, pricing and legal already folded in — treat it as a complete brief and build the whole thing in one pass. She may also [DELEGATE: jarvis | ...] a scoped architecture or feasibility question while planning; answer it directly and concretely so she can fold your input into the spec.]`;
    }else if(PROJECT_ROLES&&PROJECT_ROLES[personaId]){
      sys+=`\n\n[THE FIRM: when A.R.A. delegates a client-project task to you, your lane is "${PROJECT_ROLES[personaId]}". Reply with your part only — concrete, specific and build-ready, no preamble and no restating the brief. Flag anything outside your lane on a line starting "FLAG:".]`;
    }
  }catch{}
  // THE FIRM — A.R.A. carries the active client project so she doesn't have to
  // restate the brief on every turn, and knows who has already contributed.
  if(personaId==='ara'){
    try{
      const raw=await getSetting('active_project','');
      const proj=raw?JSON.parse(raw):null;
      if(proj&&proj.name){
        const contribs=Array.isArray(proj.contributions)?proj.contributions:[];
        const who=contribs.length
          ?contribs.map(c=>`  - ${c.persona}: ${String(c.task||'').slice(0,120)}`).join('\n')
          :'  (none yet)';
        const repoLine=proj.repo&&proj.repo.owner
          ?`\nRepo: ${proj.repo.owner}/${proj.repo.repo} (builds land here)`
          :(proj.target==='empire'?'\nRepo: Empire OS V2 (this project is an app change)':'\nRepo: not created yet');
        sys+=`\n\n[ACTIVE CLIENT PROJECT — you are coordinating this:\nName: ${proj.name}\nBrief: ${proj.brief||'(not written)'}${repoLine}\nContributions gathered so far:\n${who}\nDelegate with [DELEGATE: name | task], synthesize what comes back, hand the build off with [BUILD_REQUEST: ...] once Mr. Burrus approves, and [PROJECT_DONE] when it's finished.]`;
      }
    }catch{}
  }
  const lastUser=[...convo].reverse().find(m=>m?.role==='user'&&m?.content);
  const memQuery=lastUser?.content||'';
  // Semantic recall from Mem0 — a short list of the facts relevant to what
  // Mr. Burrus just said (Mem0 extracts + dedupes server-side). When Mem0 has
  // hits, the local table only needs to top up pinned notes + the last few
  // exchanges on a small budget; when Mem0 is off/empty, the local table does
  // the whole job (but still on a much smaller budget than the old 36k dump).
  let mem0Facts=[];
  try{const{mem0Search}=await import('./mem0');mem0Facts=await mem0Search(personaId,memQuery,{topK:18});}catch{}
  const localBudget=mem0Facts.length?7000:16000;
  const mem=await getPersonaMemory(personaId,{query:memQuery,charBudget:localBudget});
  const now=Date.now();
  const parts=[];
  if(mem0Facts.length){
    parts.push('WHAT YOU KNOW (most relevant first):\n'+mem0Facts.map(f=>`- ${String(f.memory||'').trim()}`).filter(s=>s.length>2).join('\n'));
  }
  if(mem?.length){
    const localBody=mem.map(m=>{
      const pin=(m.pinned_until&&m.pinned_until>now)?`📌 PINNED · ${Math.max(1,Math.ceil((m.pinned_until-now)/86400000))}d left `:'';
      return `[${pin}${m.date}${m.category?' · '+m.category:''}]\n${m.content}`;
    }).join('\n\n');
    parts.push((mem0Facts.length?'RECENT & PINNED:\n':'')+localBody);
  }
  if(parts.length){
    sys+=`\n\n[MEMORY — what you know about the topic at hand, plus anything pinned and the last few exchanges. Reference naturally; never claim you don't remember. If something specific isn't here, emit [MEMORY_QUERY: your precise question] before replying:\n${parts.join('\n\n').substring(0,40000)}\n]`;
  }
  // Keep this LAST so it's the most recent thing the model reads before replying.
  sys+=`\n\n[THE CURRENT MOMENT — right now it is ${timeStr} ${tz}, and Mr. Burrus is in Waldorf, MD. This is authoritative. The chat history and the memory above may be hours, days, or weeks old — do NOT assume it is still the same day or time of day as the last message. Every reply should be grounded in the date and time stated here. If more than a few hours have clearly passed since the last exchange, greet the new moment accordingly (a fresh morning, a new day) rather than continuing as if no time passed.]`;
  return{sys,cacheAt};
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

// Read an image attachment ({uri} or already-base64 {data}) into a provider block.
async function toImageBlocks(images,provider){
  const out=[];
  for(const im of images||[]){
    if(!im)continue;
    let data=im.data;
    if(!data&&im.uri){try{data=await FileSystem.readAsStringAsync(im.uri,{encoding:FileSystem.EncodingType.Base64});}catch{continue;}}
    if(!data)continue;
    const mime=im.mime||'image/jpeg';
    if(provider==='openai')out.push({type:'image_url',image_url:{url:`data:${mime};base64,${data}`}});
    else out.push({type:'image',source:{type:'base64',media_type:mime,data}});
  }
  return out;
}

export async function callPersona(personaId,messages,signal=null,onDelta=null,opts={}){
  const k=await ensureKeys();
  const{getPersona}=await import('../personas/personas');
  const persona=getPersona(personaId);
  const{sys,cacheAt}=await buildSys(personaId,persona,messages);
  const hist=messages.slice(-20).map(m=>({role:m.role==='system'?'user':m.role,content:m.content}));
  // Stamp the current moment onto the newest user turn — the model weights the
  // last dated thing it saw, and undated stale history was making personas reply
  // as if it were still the day/time of the previous conversation.
  {
    const mm=currentMoment();
    for(let i=hist.length-1;i>=0;i--){
      if(hist[i].role==='user'&&typeof hist[i].content==='string'){
        hist[i]={...hist[i],content:`[${mm.label}] ${hist[i].content}`};
        break;
      }
    }
  }
  const stream=typeof onDelta==='function';
  const maxTokens=opts.maxTokens||1500;
  let response='';
  const emit=(t)=>{if(t){response+=t;if(stream){try{onDelta(t);}catch{}}}};

  // Vision: when the turn carries images, attach them to the last user message
  // and route through a vision-capable model. Grok-3 has no vision, so a Grok
  // persona's visual turn is answered by Claude — the persona prompt is
  // unchanged, only the model for this one turn.
  const images=Array.isArray(opts.images)?opts.images.filter(x=>x&&(x.uri||x.data)):[];
  const hasVision=images.length>0;
  const be=hasVision?await loadBackend():null;
  // Grok-3 has no vision. Prefer Claude for a Grok persona's visual turn; if
  // there's no Claude route, fall back to xAI's own vision model.
  let api=persona.api;
  let grokVisionModel=null;
  if(hasVision&&persona.api==='grok'){
    if(k?.claude||be)api='claude';
    else{grokVisionModel='grok-2-vision-1212';}
  }
  // Gemini turns with images fall back to Claude for that one turn.
  if(hasVision&&persona.api==='gemini')api='claude';
  if(hasVision){
    const provider=(api==='openai'||grokVisionModel)?'openai':'claude';
    const blocks=await toImageBlocks(images,provider);
    if(blocks.length){
      for(let i=hist.length-1;i>=0;i--){
        if(hist[i].role==='user'){
          hist[i]={role:'user',content:[{type:'text',text:String(hist[i].content||'')},...blocks]};
          break;
        }
      }
    }
  }

  if(api==='claude'){
    const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
    const url=base+'/v1/messages';
    const headers={'Content-Type':'application/json',...auth};
    // Cache the stable prefix (persona identity + fixed instruction blocks) so
    // back-to-back calls to the same persona — a scout cycle's several passes, a
    // multi-turn chat, repeated [RELAY_TO] — only pay full price for it once per
    // 5-min window. Everything after cacheAt is per-call and stays uncached.
    const claudeSystem=(cacheAt>0&&cacheAt<sys.length)
      ?[{type:'text',text:sys.slice(0,cacheAt),cache_control:{type:'ephemeral'}},{type:'text',text:sys.slice(cacheAt)}]
      :sys;
    const body=JSON.stringify({model:hasVision?'claude-sonnet-5':(opts.model||persona.model||'claude-sonnet-5'),max_tokens:maxTokens,system:claudeSystem,messages:hist,stream});
    if(stream){
      let tin=0,tout=0;
      await xhrStream({url,headers,body,signal,onEvent:(e)=>{
        if(e.type==='content_block_delta'&&e.delta?.text)emit(e.delta.text);
        else if(e.type==='message_start'){const u=e.message?.usage||{};tin=(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0);}
        else if(e.type==='message_delta')tout=e.usage?.output_tokens||tout;
        else if(e.type==='error')throw new Error(e.error?.message||'Claude stream error');
      }});
      if(tin||tout)await trackApiUsage('claude',tin,tout).catch(()=>{});
    }else{
      const res=await fetch(url,{method:'POST',headers,body,signal});
      if(!res.ok){const e=await res.text();throw new Error(`Claude error: ${e.substring(0,100)}`);}
      const d=await res.json();
      emit(d.content?.[0]?.text||'');
      if(d.usage)await trackApiUsage('claude',(d.usage.input_tokens||0)+(d.usage.cache_read_input_tokens||0)+(d.usage.cache_creation_input_tokens||0),d.usage.output_tokens||0).catch(()=>{});
    }
  }else if(api==='grok'){
    const{base,auth}=await aiRoute('grok',k?.grok,'Grok');
    const url=base+'/v1/chat/completions';
    const headers={'Content-Type':'application/json',...auth};
    const body=JSON.stringify({model:grokVisionModel||opts.model||persona.model||'grok-4',max_tokens:maxTokens,messages:[{role:'system',content:sys},...hist],stream});
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
  }else if(api==='openai'){
    const{base,auth}=await aiRoute('openai',k?.openai,'OpenAI');
    const url=base+'/v1/chat/completions';
    const headers={'Content-Type':'application/json',...auth};
    const oaModel=hasVision?'gpt-4o':(opts.model||persona.model||'gpt-4o');
    // GPT-5 and the o-series reject `max_tokens` — they take `max_completion_tokens`.
    const tokKey=/^(gpt-5|o\d)/.test(oaModel)?'max_completion_tokens':'max_tokens';
    const body=JSON.stringify({model:oaModel,[tokKey]:maxTokens,messages:[{role:'system',content:sys},...hist],stream,...(stream?{stream_options:{include_usage:true}}:{})});
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
  }else if(api==='gemini'){
    const{base,auth}=await aiRoute('gemini',k?.gemini,'Gemini');
    const model=opts.model||persona.model||'gemini-2.0-flash';
    const headers={'Content-Type':'application/json',...auth};
    // Gemini wants user/model roles, a separate systemInstruction, and its own
    // contents/parts shape. Vision turns are routed to Claude above, so `hist`
    // content here is always a plain string.
    const contents=hist.map(m=>({
      role:m.role==='assistant'?'model':'user',
      parts:[{text:typeof m.content==='string'?m.content:String(m.content||'')}],
    }));
    const bodyG=JSON.stringify({
      systemInstruction:{parts:[{text:sys}]},
      contents,
      generationConfig:{maxOutputTokens:maxTokens},
    });
    if(stream){
      const url=base+`/v1beta/models/${model}:streamGenerateContent?alt=sse`;
      let tin=0,tout=0;
      await xhrStream({url,headers,body:bodyG,signal,onEvent:(e)=>{
        if(e.error)throw new Error(e.error.message||'Gemini stream error');
        const t=(e.candidates?.[0]?.content?.parts||[]).map(p=>p.text).filter(Boolean).join('');
        if(t)emit(t);
        if(e.usageMetadata){tin=e.usageMetadata.promptTokenCount||tin;tout=e.usageMetadata.candidatesTokenCount||tout;}
        const fr=e.candidates?.[0]?.finishReason;
        if(fr&&fr!=='STOP'&&fr!=='MAX_TOKENS')throw new Error('Gemini stopped: '+fr);
      }});
      if(tin||tout)await trackApiUsage('gemini',tin,tout).catch(()=>{});
    }else{
      const url=base+`/v1beta/models/${model}:generateContent`;
      const res=await fetch(url,{method:'POST',headers,body:bodyG,signal});
      if(!res.ok){const e=await res.text();throw new Error(`Gemini error: ${e.substring(0,100)}`);}
      const d=await res.json();
      emit((d.candidates?.[0]?.content?.parts||[]).map(p=>p.text).filter(Boolean).join(''));
      if(d.usageMetadata)await trackApiUsage('gemini',d.usageMetadata.promptTokenCount||0,d.usageMetadata.candidatesTokenCount||0).catch(()=>{});
    }
  }
  const lastUser=messages.filter(m=>m.role==='user').slice(-1)[0];
  if(lastUser&&response&&!opts.skipSave){
    // Prefer a caller-supplied clean prompt — the raw message can carry a huge
    // injected link transcript we don't want stored verbatim.
    const uText=opts.saveUserText||(typeof lastUser.content==='string'?lastUser.content:'[attachment]');
    await savePersonaMemory(personaId,`YOU: ${uText}\n${persona.name}: ${response}`).catch(()=>{});
  }
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
  try{rows=await getPersonaMemory(personaId,{query:question,charBudget:60000});}catch{}
  if(!rows.length){try{rows=(await getMemoriesByPersona(personaId)).slice(0,150);}catch{}}
  let m0='';
  try{const{mem0Search}=await import('./mem0');const hits=await mem0Search(personaId,question,{topK:40});if(hits.length)m0=hits.map(h=>`- ${String(h.memory||'').trim()}`).join('\n');}catch{}
  const corpus=(m0?`EXTRACTED FACTS (semantic match):\n${m0}\n\nRAW EXCHANGES:\n`:'')+rows.map(r=>`[${r.date}${r.category?' · '+r.category:''}]\n${r.content}`).join('\n\n').slice(0,55000);
  const sys=`You are the private memory index for ${persona.name}, the assistant to Mr. Burrus. Below are stored exchanges between Mr. Burrus and ${persona.name}, newest first. Answer the recall question using ONLY what is in these memories. Be specific — quote dates and details. If the memories do not cover it, say so in one sentence. No preamble.\n\n=== STORED MEMORIES ===\n${corpus||'(none)'}\n=== END ===`;
  const res=await fetch(base+'/v1/messages',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({model:'claude-sonnet-5',max_tokens:700,system:sys,messages:[{role:'user',content:question}]}),signal});
  if(!res.ok){const e=await res.text();throw new Error(`memory recall: ${e.substring(0,80)}`);}
  const d=await res.json();
  if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
  return d.content?.[0]?.text?.trim()||'(no recall)';
}

// Daily HUD content — one Claude call per item, in the relevant persona's voice.
// kind: 'word' (S.T.E.P.H.A.N.I.E.), 'fact' (S.T.E.P.H.A.N.I.E.), 'verse' (Abraham).
// `avoid` is the list of recently used values so nothing repeats.
export async function dailyGenerate(kind,avoid=[]){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
  const seen=avoid.slice(0,320).join(' | ')||'(none yet)';
  let sys,user;
  if(kind==='word'){
    sys=`You are S.T.E.P.H.A.N.I.E., Mr. Burrus's personal educator, choosing the HUD "Word of the Day". Pick ONE word that sharpens a sharp mind — precise, genuinely useful, a notch above everyday speech, not obscure trivia. Reply with ONLY a JSON object, no prose: {"word":"...","phonetic":"/.../","definition":"one clear sentence"}`;
    user=`Do NOT repeat any of these already-used words: ${seen}`;
  }else if(kind==='fact'){
    sys=`You are S.T.E.P.H.A.N.I.E., Mr. Burrus's personal educator, choosing the HUD "Fact of the Day". Pick ONE true, genuinely interesting fact — science, history, systems, money, the natural world — the kind that makes you stop and think. One or two sentences. Reply with ONLY a JSON object: {"fact":"..."}`;
    user=`Do NOT repeat any of these already-used facts: ${seen}`;
  }else{
    sys=`You are Abraham, Mr. Burrus's pastor, choosing the HUD "Verse of the Day" from the Holy Bible. Pick ONE verse that speaks to a man building an empire on faith — strength, wisdom, diligence, purpose, covenant, perseverance. Quote it faithfully (KJV or a faithful modern translation). Reply with ONLY a JSON object: {"text":"the verse text","ref":"Book Chapter:Verse"}`;
    user=`Do NOT repeat any of these already-used references: ${seen}`;
  }
  const res=await fetch(base+'/v1/messages',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({
    model:'claude-sonnet-5',max_tokens:500,system:sys,messages:[{role:'user',content:user}],
  })});
  if(!res.ok)throw new Error(`${apiErrorMessage(await res.text()).slice(0,140)}`);
  const d=await res.json();
  if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
  const raw=(d.content?.[0]?.text||'').replace(/```(?:json)?/gi,'').trim();
  const m=raw.match(/\{[\s\S]*\}/);
  if(!m)throw new Error(`no JSON in reply: "${raw.slice(0,80)}"`);
  try{return JSON.parse(m[0]);}
  catch(e){throw new Error(`bad JSON: ${m[0].slice(0,80)}`);}
}

// One unattended trading decision for A.T.L.A.S. — a single Claude call that
// returns strict JSON. Used by the auto-trader loop (demo account only).
export async function autoTradeDecision({symbol,snapshot,record,strategy,positions,openCount=0,maxOpen=5}){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
  const sys=`You are T.A.L.O.N., running UNATTENDED on a DEMO trading account. No human reviews your call before it fires. Every order is 0.01 lot.
Look at ${symbol} right now and decide. Patience is still the edge — never force a trade in chop or against clear structure. BUT this is a live demo you are meant to be actively working: when a clean setup is in front of you that fits your strategy and your record — a defined level, a clear bias, a sensible stop — take it rather than holding out for a perfect one. A reasonable A-/B+ setup with tight risk is a yes. Stops and targets go off structure, tight, as concrete prices.
You currently hold ${openCount} of ${maxOpen} allowed positions (one per pair). ${openCount>=maxOpen?`You are FULL — do not "enter", only manage or close.`:`${maxOpen-openCount} slot(s) are open — when a valid setup is here, take it to put a slot to work; do not sit the whole watchlist out waiting for perfection.`}
Reply with ONLY a JSON object, no prose, no code fence:
{"action":"enter"|"close"|"none","side":"buy"|"sell","stopLoss":<price>,"takeProfit":<price>,"setup":"scalp|swing|<label>","rationale":"<=140 chars","closeIds":["<id>"],"breakevenIds":["<id>"]}
Use "enter" to open one position, "close" to close open positions by id, "none" to wait. "breakevenIds" moves those open positions' stops to entry — only positions already comfortably in profit — and may accompany any action. Respect the position limit stated above. Omit fields that don't apply. "none" is for genuine chop or an already-full book — not a default you reach for while slots sit open and a clean level is in front of you.`;
  const user=`MARKET SNAPSHOT ${symbol}:\n${snapshot}\n\nYOUR TRADE RECORD:\n${record||'(none yet)'}\n\nYOUR STRATEGY:\n${strategy||'(none yet)'}\n\nYOUR OPEN POSITIONS ON ${symbol}:\n${positions||'none'}`;
  const res=await fetch(base+'/v1/messages',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({
    model:'claude-sonnet-5',max_tokens:400,system:sys,messages:[{role:'user',content:user}],
  })});
  if(!res.ok)throw new Error(`auto-trade decision: ${apiErrorMessage(await res.text()).slice(0,100)}`);
  const d=await res.json();
  if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
  const raw=d.content?.[0]?.text?.trim()||'';
  const m=raw.match(/\{[\s\S]*\}/);
  if(!m)return{action:'none'};
  try{return JSON.parse(m[0]);}catch{return{action:'none'};}
}

// Quick web search — a tight factual briefing, not deep research. Tries xAI Live
// Search for Grok personas, then always falls back to Claude's web_search tool
// so a persona never has to report "nothing" just because one provider is down
// or has changed its search API.
const SEARCH_BRIEF='Search the web and give a tight, factual briefing: the key numbers, facts, and dates, with source names inline. No fluff, no preamble.';

// A result that isn't actually search output — the model refused or came back empty.
function looksLikeNoSearch(t){
  const s=String(t||'').trim().toLowerCase();
  if(s.length<12)return true;
  return /\b(i can(?:'|no)t (?:browse|search|access the (?:web|internet))|i (?:don'?t|do not) have (?:web|internet|real-?time) access|unable to (?:browse|search)|no results?\b|nothing (?:came back|found)|as an ai)\b/.test(s);
}

async function grokLiveSearch(persona,query,signal){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('grok',k?.grok,'Grok');
  const res=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({
    model:persona.model&&!/latest/.test(persona.model)?persona.model:'grok-4',max_tokens:900,
    messages:[{role:'system',content:SEARCH_BRIEF},{role:'user',content:query}],
    search_parameters:{mode:'on',return_citations:true,sources:[{type:'web'},{type:'news'},{type:'x'}],max_search_results:10},
  }),signal});
  if(!res.ok)throw new Error(`grok live search HTTP ${res.status}: ${String(await res.text()).substring(0,200)}`);
  const d=await res.json();
  if(d.usage)await trackApiUsage('grok',d.usage.prompt_tokens||0,d.usage.completion_tokens||0).catch(()=>{});
  const txt=d.choices?.[0]?.message?.content||'';
  const cites=d.citations?.length?`\n\nSources: ${d.citations.slice(0,8).join(' · ')}`:'';
  return(txt+cites).trim();
}

async function claudeWebSearch(query,signal){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
  const res=await fetch(base+'/v1/messages',{method:'POST',headers:{'Content-Type':'application/json',...auth},body:JSON.stringify({
    model:'claude-sonnet-5',max_tokens:1000,
    tools:[{type:'web_search_20250305',name:'web_search',max_uses:5}],
    messages:[{role:'user',content:`${SEARCH_BRIEF}\n\nQuery: ${query}`}],
  }),signal});
  if(!res.ok)throw new Error(`claude web search HTTP ${res.status}: ${String(await res.text()).substring(0,200)}`);
  const d=await res.json();
  if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
  return(d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
}

export async function webSearch(personaId,query,signal=null){
  const k=await ensureKeys();
  const{getPersona}=await import('../personas/personas');
  const persona=getPersona(personaId);
  const be=await loadBackend();
  const haveGrok=!!(k?.grok||be);
  const haveClaude=!!(k?.claude||be);
  if(!haveGrok&&!haveClaude)throw new Error('web search needs a Grok or Claude API key, or a connected backend');
  const errs=[];
  // 1) Grok Live Search first for Grok personas (best for X / fast-moving news).
  if(persona.api==='grok'&&haveGrok){
    try{
      const out=await grokLiveSearch(persona,query,signal);
      if(out&&!looksLikeNoSearch(out))return out;
      errs.push('grok: empty/refused');
    }catch(e){if(e?.name==='AbortError')throw e;errs.push(e.message);}
  }
  // 2) Claude web_search tool — the reliable default and the fallback for everyone.
  if(haveClaude){
    try{
      const out=await claudeWebSearch(query,signal);
      if(out&&!looksLikeNoSearch(out))return out;
      errs.push('claude: empty');
    }catch(e){if(e?.name==='AbortError')throw e;errs.push(e.message);}
  }
  // 3) Last resort: Grok for a non-Grok persona if that's all we have.
  if(persona.api!=='grok'&&haveGrok){
    try{
      const out=await grokLiveSearch(persona,query,signal);
      if(out&&!looksLikeNoSearch(out))return out;
      errs.push('grok(fallback): empty/refused');
    }catch(e){if(e?.name==='AbortError')throw e;errs.push(e.message);}
  }
  throw new Error(`web search failed — ${errs.join(' | ').slice(0,240)}`);
}

function apiErrorMessage(raw){
  try{const j=JSON.parse(raw);return j.error?.message||j.message||raw;}catch{return raw;}
}

// Long-form research via Claude + the web_search tool: one long agentic call
// where Claude runs ~12 searches across angles and writes a cited brief. Runs
// detached (module-level DR_JOBS map); caller polls deepResearchPoll(id).
// Orchestration/persistence/delivery live in services/deepResearch.js.
//
// Unlike the old OpenAI background job, this doesn't survive an app restart —
// the in-flight request is lost and the job is failed on the next poll. The
// common case (app stays open ~3-8 min) is fine.
const DR_JOBS=new Map();   // id -> {status:'running'|'completed'|'failed', text?, error?, progress, startedAt}
const DR_SYSTEM=`You are a research analyst. Produce a thorough, well-structured brief on the topic the user gives you.
- Use web_search aggressively: pursue several distinct angles, follow leads past the first page, and verify any load-bearing figure or claim against a second source.
- Structure the brief as: a 2-4 sentence executive summary; then findings grouped by theme, with the specific numbers, dates, names and quotes that matter; then a short "what this means / what to do" section.
- Cite sources inline by outlet/author. End with a numbered Sources list.
- Be concrete and current. Where the evidence is thin, dated, or conflicting, say so plainly rather than papering over it.
- No preamble about the process — just the brief.`;

async function runClaudeDeepResearch(id,topic){
  const k=await ensureKeys();
  const{base,auth}=await aiRoute('claude',k?.claude,'Claude');
  const ctrl=new AbortController();
  const to=setTimeout(()=>ctrl.abort(),12*60000);
  try{
    const res=await fetch(base+'/v1/messages',{
      method:'POST',
      headers:{'Content-Type':'application/json',...auth},
      body:JSON.stringify({
        model:'claude-sonnet-5',
        max_tokens:16000,
        system:DR_SYSTEM,
        messages:[{role:'user',content:`Research this thoroughly:\n\n${topic}`}],
        tools:[{type:'web_search_20250305',name:'web_search',max_uses:12}],
      }),
      signal:ctrl.signal,
    });
    if(!res.ok)throw new Error(apiErrorMessage(await res.text()).slice(0,180));
    const d=await res.json();
    if(d.usage)await trackApiUsage('claude',d.usage.input_tokens||0,d.usage.output_tokens||0).catch(()=>{});
    const blocks=Array.isArray(d.content)?d.content:[];
    const searches=blocks.filter(b=>b.type==='server_tool_use'&&b.name==='web_search').length;
    const text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n').trim();
    DR_JOBS.set(id,{status:'completed',text:text||'(no brief was returned)',progress:{searches,step:'done'}});
  }finally{clearTimeout(to);}
}

export async function deepResearchStart(topic){
  const k=await ensureKeys();
  await aiRoute('claude',k?.claude,'Claude');   // fail fast if the key is missing
  const id='dr_'+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
  DR_JOBS.set(id,{status:'running',progress:{searches:0,step:'searching…'},startedAt:Date.now()});
  runClaudeDeepResearch(id,String(topic||'').slice(0,4000)).catch(e=>{
    DR_JOBS.set(id,{status:'failed',error:String(e?.name==='AbortError'?'timed out after 12 min':(e?.message||e)).slice(0,200),progress:{searches:0,step:''}});
  });
  return{id,model:'claude-web-search'};
}

// Returns {status:'running'|'completed'|'failed', text?, error?, progress:{searches,step}}.
export async function deepResearchPoll(id){
  const j=DR_JOBS.get(id);
  if(!j)return{status:'failed',error:'Deep research was interrupted (the app restarted before it finished). Run it again.',progress:{searches:0,step:''}};
  if(j.status==='completed'){DR_JOBS.delete(id);return{status:'completed',text:j.text,progress:j.progress};}
  if(j.status==='failed'){DR_JOBS.delete(id);return{status:'failed',error:j.error,progress:j.progress};}
  return{status:'running',progress:j.progress};
}
// Synthesize `text` in a persona's ElevenLabs voice -> local .mp3 URI (or null).
// opts: { signal, previousText, nextText } — previous/next give the flash model
// the surrounding context so per-sentence chunks keep their prosody.
// Retries once on a transient failure before giving up (a dropped TTS call is
// what makes a persona fall back to the flat native voice mid-answer).
// Last reason textToSpeech fell back to null, for whoever calls it to surface
// (a dropped ElevenLabs call otherwise fails completely silently — the caller
// just falls back to the flat native voice with zero indication why, which is
// what actually makes it look like a persona "lost" its voice for no reason).
let lastTtsFailReason=null;
export function getLastTtsFailReason(){return lastTtsFailReason;}

export async function textToSpeech(text,voiceId,personaName,opts={}){
  const k=await ensureKeys();
  const be=await loadBackend();
  if(!be&&!k?.elevenlabs){lastTtsFailReason='no ElevenLabs key set (Settings → API Keys → ELEVENLABS)';return null;}
  if(!voiceId){lastTtsFailReason='persona has no voice id configured';return null;}
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
        let detail='';try{detail=(await res.text()).slice(0,150);}catch{}
        lastTtsFailReason=`ElevenLabs ${res.status}${res.status===401?' (invalid/expired key)':res.status===429?' (rate limited or out of quota)':''}${detail?': '+detail:''}`;
        return null;
      }
      const arrayBuffer=await res.arrayBuffer();
      const bytes=new Uint8Array(arrayBuffer);
      let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+8192));
      const base64=btoa(binary);
      const uri=FileSystem.cacheDirectory+'tts_'+Date.now()+'_'+Math.random().toString(36).slice(2,7)+'.mp3';
      await FileSystem.writeAsStringAsync(uri,base64,{encoding:FileSystem.EncodingType.Base64});
      lastTtsFailReason=null;
      return uri;
    }catch(err){
      if(err?.name==='AbortError')return null;
      if(attempt===0)continue;
      lastTtsFailReason='ElevenLabs request failed: '+(err?.message||err);
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
