// A.R.A. LIVE — true duplex realtime voice over xAI's speech-to-speech socket.
//
// Why this exists vs. the turn-based hands-free loop (see CommandScreen):
// that loop is record -> Whisper -> Claude/Grok text call -> ElevenLabs/Grok
// TTS -> play, three network round trips per turn and the mic closed the
// whole time she's talking. This talks to Grok's realtime endpoint directly:
// the mic streams continuously, the server's own VAD decides when you're done
// talking and drives generation, and it can interrupt her mid-sentence the
// instant you start talking again (real barge-in) because the mic is *never*
// closed — no separate "should I reopen the mic" state machine to get wrong.
//
// Echo defense: Android audio is captured with MediaRecorder's
// VOICE_COMMUNICATION source (see LIVE_AUDIO_OPTS), which turns on the
// platform's own acoustic echo cancellation + noise suppression — the speaker
// bleeding into the mic is a hardware-level solved problem here, not the
// text-heuristic backstop CommandScreen uses for the turn-based loop.
//
// Scope: she keeps live read access to the HUD and her memory (function
// calling below) so she isn't flying blind, but write-side tags (SAVE_NOTE,
// REMEMBER, canvas tags, web search, …) are NOT wired into this session —
// those stay on the text turn. Tell Mr. Burrus to say "let's talk about that
// in chat" if he needs one mid-call; wiring more tools here is a follow-up,
// not a v1 requirement.
import LiveAudioStream from 'react-native-live-audio-stream';
import{playOpts,speechRate}from './voiceSpeed';
import{Audio}from 'expo-av';
import*as FileSystem from 'expo-file-system';
import{loadKeys}from './keyStore';
import{personaSystemPrompt,queryMemory,fixNames,textToSpeech}from './aiService';
import{getPersona}from '../personas/personas';
import{getSetting}from './database';
import{ARA_VOICE}from './voiceCues';
import{getHudState}from './database';

const SAMPLE_RATE=24000; // must match the session's audio.input/output format below
const LIVE_AUDIO_OPTS={
  sampleRate:SAMPLE_RATE,
  channels:1,
  bitsPerSample:16,
  audioSource:7,   // Android MediaRecorder.AudioSource.VOICE_COMMUNICATION — hardware AEC
  bufferSize:4096,
};

const TOOLS=[
  {
    type:'function',name:'read_hud',
    description:"Read Mr. Burrus's live HUD right now — tasks, morning routine, Empire Score, streak, word/verse/fact of the day, upcoming dates. Call this whenever something in the conversation needs the current state, since it can have changed since the call started.",
    parameters:{type:'object',properties:{},required:[]},
  },
  {
    type:'function',name:'run_command',
    description:"Do anything you can do in chat, live: put the exact command tag(s) you'd write there, e.g. [READ_CALENDAR], [CREATE_EVENT: dinner | Friday 7pm | 90], [ADD_TASK: call mom | ], [SAVE_NOTE: title | text], [READ_EMAIL], [RELAY_TO: talon | …], [REMIND: …], [NEWS_NOW], [MOOD: angry | 5 | why]. It runs exactly as on Telegram and the result comes back: tell him what happened from it, never claim something ran that the result doesn't show. Anything that sends, posts, buys or deletes waits on his Confirm tap on Telegram — tell him it's there.",
    parameters:{type:'object',properties:{command:{type:'string',description:'one or more command tags, exactly as in chat'}},required:['command']},
  },
  {
    type:'function',name:'query_memory',
    description:"Search your memory of past conversations with Mr. Burrus for something specific he references that isn't already in this conversation.",
    parameters:{type:'object',properties:{question:{type:'string',description:'the precise thing to recall'}},required:['question']},
  },
];

let ws=null;
let streamStarted=false;
let sound=null;
let audioChunks=[];
let respTranscript='';
let listening=false;
let lastHeard='';     // his last words on the call: the gate for writes that need his own message
let liveTimers=[];    // live pass-offs and mood while the call runs

// Her ElevenLabs voice on the live call (owner, 2026-11-27: "option 1"): Grok still
// listens, thinks and decides when she talks; its words go to ElevenLabs a sentence at
// a time as they come and play back to back, so she sounds like her voice notes and
// starts after her first sentence. Barge-in clears the queue. If ElevenLabs fails on an
// answer before anything played, Grok's own audio for it plays instead. Settings ›
// AI › A.R.A.'s Voice = Grok keeps the call on Grok's voice.
let eleven=false;       // this call uses ElevenLabs
let gen=0;              // bumps on barge-in / new answer: stale clips are dropped
let sentBuf='';         // transcript not yet sent to ElevenLabs
let spokenSoFar='';     // what's been sent this answer (for stitching)
let queue=[];           // [{ gen, uriP }] in order
let playing=false;
let answerDone=false;
let elevenFailed=false;
let playedAny=false;
let ttsAbort=null;
const SENTENCE=/^[\s\S]*?[.!?…]+["')\]]*(?=\s)/;

function resetAnswer(){
  sentBuf='';spokenSoFar='';queue=[];answerDone=false;elevenFailed=false;playedAny=false;
}
function cancelAll(){
  gen++;
  try{ttsAbort?.abort();}catch{}
  ttsAbort=new AbortController();
  resetAnswer();
}
function enqueue(text,onStateChange){
  const t=String(text||'').trim();
  if(!t)return;
  const my=gen;
  const prev=spokenSoFar;
  spokenSoFar+=(spokenSoFar?' ':'')+t;
  const signal=ttsAbort?.signal;
  const uriP=textToSpeech(t,getPersona('ara').elevenlabsVoiceId,'A.R.A.',{signal,previousText:prev}).catch(()=>null);
  queue.push({gen:my,uriP});
  pump(onStateChange);
}
// Pull whole sentences off the transcript as it streams in.
function feed(delta,onStateChange){
  sentBuf+=delta||'';
  let m;
  while((m=SENTENCE.exec(sentBuf))&&m[0].trim().length>=2){
    enqueue(m[0],onStateChange);
    sentBuf=sentBuf.slice(m[0].length);
  }
}
async function playUri(uri,onStateChange,my){
  await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:true});
  if(my!==gen)return;
  const{sound:snd}=await Audio.Sound.createAsync({uri},playOpts({shouldPlay:true}));
  if(my!==gen){try{await snd.unloadAsync();}catch{}return;}
  sound=snd;playedAny=true;
  onStateChange?.('speaking');
  await new Promise(res=>{
    snd.setOnPlaybackStatusUpdate(st=>{if(!st.isLoaded||st.didJustFinish)res();});
    const iv=setInterval(()=>{if(sound!==snd||my!==gen){clearInterval(iv);res();}},250);
  });
  try{await snd.unloadAsync();}catch{}
  if(sound===snd)sound=null;
}
async function pump(onStateChange){
  if(playing)return;
  playing=true;
  try{
    while(queue.length){
      const item=queue[0];
      const uri=await item.uriP;
      if(item.gen!==gen){queue.shift();continue;}
      queue.shift();
      if(!uri){elevenFailed=true;continue;}
      await playUri(uri,onStateChange,item.gen);
    }
  }finally{playing=false;}
  if(answerDone&&!queue.length)onStateChange?.('listening');
}

function pcmToWav(chunks){
  const total=chunks.reduce((n,c)=>n+c.length,0);
  const pcm=new Uint8Array(total);
  let off=0;for(const c of chunks){pcm.set(c,off);off+=c.length;}
  const header=new Uint8Array(44);
  const v=new DataView(header.buffer);
  const ws8=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
  ws8(0,'RIFF');v.setUint32(4,36+pcm.byteLength,true);ws8(8,'WAVE');
  ws8(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);
  v.setUint16(22,1,true);v.setUint32(24,SAMPLE_RATE,true);
  v.setUint32(28,SAMPLE_RATE*2,true);v.setUint16(32,2,true);
  v.setUint16(34,16,true);ws8(36,'data');v.setUint32(40,pcm.byteLength,true);
  const wav=new Uint8Array(44+pcm.byteLength);
  wav.set(header);wav.set(pcm,44);
  return wav;
}

async function playResponseAudio(chunks,onStateChange,onDone){
  if(!chunks.length){onDone?.();return;}
  const wav=pcmToWav(chunks);
  let binary='';
  for(let i=0;i<wav.length;i+=8192)binary+=String.fromCharCode.apply(null,wav.subarray(i,i+8192));
  const base64=btoa(binary);
  const uri=FileSystem.cacheDirectory+'ara_live_'+Date.now()+'.wav';
  await FileSystem.writeAsStringAsync(uri,base64,{encoding:FileSystem.EncodingType.Base64});
  await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:true});
  const{sound:snd}=await Audio.Sound.createAsync({uri},playOpts({shouldPlay:true}));
  sound=snd;
  onStateChange?.('speaking');
  snd.setOnPlaybackStatusUpdate(st=>{
    if(st.didJustFinish){
      try{snd.unloadAsync();}catch{}
      if(sound===snd)sound=null;
      onStateChange?.('listening');
      onDone?.();
    }
  });
}

async function stopPlayback(){
  const snd=sound;sound=null;
  if(!snd)return;
  try{snd.setOnPlaybackStatusUpdate(null);}catch{}
  try{await snd.stopAsync();}catch{}
  try{await snd.unloadAsync();}catch{}
}

async function runTool(name,args){
  try{
    if(name==='read_hud'){
      const hud=await getHudState();
      return JSON.stringify(hud||{});
    }
    if(name==='run_command'){
      const{liveCommand}=await import('./sharedDesk');
      return await liveCommand(String(args?.command||''),lastHeard);
    }
    if(name==='query_memory'){
      const answer=await queryMemory('ara',args?.question||'');
      return answer;
    }
    return JSON.stringify({error:'unknown tool '+name});
  }catch(e){return JSON.stringify({error:String(e.message||e)});}
}

// opts: { onState(state), onUserText(text,final), onAraText(partial,final), onError(err) }
// state is one of 'connecting' | 'listening' | 'speaking' | 'stopped'
export async function startAraLive(opts={}){
  const{onState,onUserText,onAraText,onError}=opts;
  await stopAraLive(); // clean slate — only one live session at a time
  const keys=await loadKeys();
  if(!keys?.grok)throw new Error('Grok API key needed for A.R.A. LIVE. Add one in Settings.');
  onState?.('connecting');
  eleven=(await getSetting('ara_voice','elevenlabs').catch(()=>'elevenlabs'))!=='grok'&&!!getPersona('ara')?.elevenlabsVoiceId;
  cancelAll();
  let mood='';try{const{araMoodLine}=await import('./sharedDesk');mood=await araMoodLine();}catch{}
  const baseInstructions=ARA_VOICE+'\n\n'+(await personaSystemPrompt('ara'))
  const callStart=Date.now();
  const instructions=baseInstructions+(mood?'\n\n'+mood:'')
    +`\n\n[LIVE VOICE CALL: you are on a real-time voice call with Mr. Burrus — everything is spoken and heard live, not read. Talk naturally and conversationally, short turns, the way a person on a call does. Keep HER VOICE from the top the whole call — sultry, seductive, slightly flirty and a touch unhinged, unhurried, feeling it out loud — never a flat read. Don't write bracketed voice cues here — just do it with your voice. Everything you can do in chat works here through the run_command tool: put the exact command tag(s) you'd write in chat and it runs for real (calendar, email, notes, tasks, reminders, hand-offs to the team, T.A.L.O.N.'s orders, news, research, your mood). When he asks you to do something, do it right then, like a real assistant on the phone: say a quick line first ("on it", "one sec", "let me check"), call run_command, then tell him how it went from the result. Several things at once go in one run_command. Never say something is done unless run_command's result shows it. read_hud and query_memory are there too — use them instead of guessing. While the call runs, pass-offs that go to him come into this conversation as notes from the system (not him speaking): you know them, mention one only if it matters or he asks. Your mood updates during the call too. If you hear "Aura", that's him saying your name — A.R.A. — never correct him or ask who Aura is. Say every persona's name as a name — Talon, Jarvis, Selene, Aisha — never spelled out letter by letter. When you pass on what another persona told you, it's theirs: "Talon says he…", never as your own and never as if he said it.]`;
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(
      'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
      ['realtime','openai-insecure-api-key.'+keys.grok,'openai-beta.realtime-v1'],
    );
    ws=socket;
    let sessionReady=false;
    socket.onopen=()=>{
      socket.send(JSON.stringify({
        type:'session.update',
        session:{
          voice:'ara',
          instructions,
          turn_detection:{type:'server_vad',threshold:0.6,silence_duration_ms:1500,prefix_padding_ms:300},
          tools:TOOLS,
          audio:{
            input:{format:{type:'audio/pcm',rate:SAMPLE_RATE}},
            output:{format:{type:'audio/pcm',rate:SAMPLE_RATE}},
          },
        },
      }));
    };
    socket.onmessage=async(e)=>{
      let event;try{event=JSON.parse(e.data);}catch{return;}
      switch(event.type){
        case'session.updated':
        case'session.created':
          if(!sessionReady){
            sessionReady=true;
            try{
              LiveAudioStream.init(LIVE_AUDIO_OPTS);
              LiveAudioStream.on('data',chunk=>{
                if(ws===socket&&socket.readyState===WebSocket.OPEN){
                  socket.send(JSON.stringify({type:'input_audio_buffer.append',audio:chunk}));
                }
              });
              LiveAudioStream.start();
              streamStarted=true;
            }catch(err){onError?.(err);reject(err);return;}
            listening=true;onState?.('listening');
            startLiveUpdates(socket,callStart,mood,(m)=>baseInstructions+(m?'\n\n'+m:''));
            resolve({stop:stopAraLive});
          }
          break;
        // Barge-in: the instant the server's VAD hears you start talking,
        // cut her off — she is never allowed to talk over you.
        case'input_audio_buffer.speech_started':
          listening=true;onState?.('listening');
          cancelAll();
          stopPlayback();
          break;
        case'conversation.item.input_audio_transcription.updated':{
          const t=event.content?.[0]?.transcript||event.transcript;
          if(t)onUserText?.(fixNames(t),false);
          break;
        }
        case'conversation.item.input_audio_transcription.completed':{
          const t=event.content?.[0]?.transcript||event.transcript;
          if(t){onUserText?.(fixNames(t),true);lastHeard=fixNames(t);}
          break;
        }
        case'response.output_audio.delta':
          try{
            const binary=atob(event.delta);
            const bytes=new Uint8Array(binary.length);
            for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
            audioChunks.push(bytes);
          }catch{}
          break;
        case'response.output_audio_transcript.delta':
          respTranscript+=event.delta||'';
          onAraText?.(respTranscript,false);
          if(eleven)feed(event.delta,onState);
          break;
        case'response.function_call_arguments.done':{
          let args={};try{args=JSON.parse(event.arguments||'{}');}catch{}
          const output=await runTool(event.name,args);
          if(ws===socket&&socket.readyState===WebSocket.OPEN){
            socket.send(JSON.stringify({type:'conversation.item.create',item:{type:'function_call_output',call_id:event.call_id,output}}));
            socket.send(JSON.stringify({type:'response.create'}));
          }
          break;
        }
        case'response.done':{
          const finalText=respTranscript;
          onAraText?.(finalText,true);
          respTranscript='';
          const chunks=audioChunks;audioChunks=[];
          if(eleven&&finalText.trim()){
            // The rest of the last sentence, then wait for the queue; Grok's own audio
            // only if ElevenLabs gave nothing for this answer.
            const my=gen;
            if(sentBuf.trim())enqueue(sentBuf,onState);
            sentBuf='';answerDone=true;
            await Promise.all(queue.map(q=>q.uriP)).catch(()=>{});
            while(playing&&my===gen)await new Promise(r=>setTimeout(r,100));
            if(my===gen&&!playedAny&&elevenFailed&&chunks.length)await playResponseAudio(chunks,onState,()=>{});
            else if(my===gen&&!playing)onState?.('listening');
            if(my===gen)resetAnswer();
          }else if(chunks.length)await playResponseAudio(chunks,onState,()=>{});
          else onState?.('listening');
          break;
        }
        case'error':
          onError?.(new Error(event.message||event.error?.message||'A.R.A. LIVE error'));
          break;
        default:break;
      }
    };
    socket.onerror=()=>{const err=new Error('A.R.A. LIVE: connection failed');onError?.(err);reject(err);};
    socket.onclose=()=>{if(ws===socket)ws=null;onState?.('stopped');};
  });
}

// While the call runs: new pass-offs come into the conversation as system notes (no
// answer forced, so she never talks over him because of one), and a changed mood
// updates her instructions (owner, 2026-11-27: "she has the memory of stuff passed to
// her while on call updated in real time and also the mood thing?").
function startLiveUpdates(socket,callStart,mood0,withMood){
  const seen=new Set();
  let mood=mood0;
  const send=(o)=>{if(ws===socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(o));};
  liveTimers.push(setInterval(async()=>{
    try{
      const{fetchAlerts}=await import('./sharedChat');
      const list=(await fetchAlerts('ara',8))||[];
      for(const a of list.slice().reverse()){
        if(seen.has(a.id))continue;
        seen.add(a.id);
        if(a.ts<callStart)continue;
        send({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',
          text:`[SYSTEM NOTE, not Mr. Burrus speaking: this just went to him on Telegram${a.from?` (from ${a.from})`:''}. You know it now; bring it up only if it matters or he asks:]\n${String(a.content).replace(/\*\*/g,'').slice(0,3000)}`}]}});
      }
    }catch{}
  },20000));
  liveTimers.push(setInterval(async()=>{
    try{
      const{araMoodLine}=await import('./sharedDesk');
      const m=await araMoodLine();
      // Only a real change (mood or a whole point of level), not every tick of the fade.
      const key=(x)=>{const r=/MOOD RIGHT NOW: (\w+)[^(]*\((\d+)/.exec(x||'');return r?`${r[1]}:${r[2]}`:'steady';};
      if(m&&key(m)!==key(mood)){mood=m;send({type:'session.update',session:{instructions:withMood(m)}});}
    }catch{}
  },30000));
}

export async function stopAraLive(){
  for(const t of liveTimers)clearInterval(t);
  liveTimers=[];lastHeard='';
  const socket=ws;ws=null;
  if(streamStarted){try{LiveAudioStream.stop();}catch{}streamStarted=false;}
  try{LiveAudioStream.removeAllListeners?.('data');}catch{}
  cancelAll();
  await stopPlayback();
  audioChunks=[];respTranscript='';listening=false;
  if(socket){try{socket.close();}catch{}}
  try{await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});}catch{}
}

export function isAraLiveActive(){return!!ws;}
