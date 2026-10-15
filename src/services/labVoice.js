// Voice for the Laboratory's image session — a small, self-contained hands-free
// loop: listen until he stops talking -> Whisper -> (the screen asks the
// persona) -> speak the reply in that persona's own voice -> listen again.
//
// Same endpointing as CommandScreen's hands-free loop (recorder metering polled
// 4x/second, adaptive silence grace, never ship a take that never heard a
// voice), trimmed to what the lab needs. Speaking: ElevenLabs for personas with
// a voice id, A.R.A.'s Grok voice for her, native TTS as the last resort — all
// at the voice-speed setting.
import{Audio}from 'expo-av';
import*as Speech from 'expo-speech';
import*as FileSystem from 'expo-file-system';
import{transcribeAudio,textToSpeech}from './aiService';
import{loadKeys}from './keyStore';
import{playOpts,speechRate}from './voiceSpeed';
import{getPersona}from '../personas/personas';

const VOICE_DB=-47;          // metering above this counts as talking
const SILENCE_MS=1100;       // quiet this long after a real utterance -> done
const SILENCE_SLOW_MS=2100;  // more grace when he's barely started
const SPOKE_ENOUGH_MS=1500;
const NOVOICE_MS=9000;       // mic open this long with no voice -> give up the take
const MAX_MS=30000;
const NOMETER_MS=7000;       // devices with no metering -> fixed take

let rec=null;
let poll=null;
let sound=null;
let grokWs=null;
let cancelListen=null;

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));

async function teardownRecorder(r){
  if(!r)return null;
  let uri=null;
  try{uri=r.getURI();}catch{}
  await Promise.race([r.stopAndUnloadAsync().catch(()=>{}),sleep(5000)]);
  if(!uri){try{uri=r.getURI();}catch{}}
  return uri;
}

// Record one utterance. Resolves to the transcript, or null when nothing was
// said (or it was cancelled). Only one listen at a time.
export async function listen({onLevel}={}){
  await stopListening();
  const{status}=await Audio.requestPermissionsAsync();
  if(status!=='granted')throw new Error('Microphone access needed — grant it in Settings');
  await Audio.setAudioModeAsync({allowsRecordingIOS:true,playsInSilentModeIOS:true});
  const r=new Audio.Recording();
  try{
    await r.prepareToRecordAsync({...Audio.RecordingOptionsPresets.HIGH_QUALITY,isMeteringEnabled:true});
    await r.startAsync();
  }catch(e){
    await r.stopAndUnloadAsync().catch(()=>{});
    throw e;
  }
  rec=r;
  const started=Date.now();
  let voiced=0,heard=false,silenceAt=0,cancelled=false;
  const done=await new Promise((resolve)=>{
    cancelListen=()=>{cancelled=true;resolve('cancel');};
    poll=setInterval(async()=>{
      if(rec!==r){resolve('cancel');return;}
      let st;try{st=await r.getStatusAsync();}catch{return;}
      if(!st?.isRecording)return;
      const elapsed=Date.now()-started;
      if(elapsed>MAX_MS){resolve('end');return;}
      const m=typeof st.metering==='number'?st.metering:null;
      onLevel?.(m);
      if(m===null){if(elapsed>NOMETER_MS)resolve('end');return;}
      const talking=m>VOICE_DB;
      if(talking){voiced++;heard=true;silenceAt=0;return;}
      if(!heard){if(elapsed>NOVOICE_MS)resolve('empty');return;}
      if(!silenceAt)silenceAt=Date.now();
      const grace=voiced*250<SPOKE_ENOUGH_MS?SILENCE_SLOW_MS:SILENCE_MS;
      if(Date.now()-silenceAt>grace)resolve('end');
    },250);
  });
  clearInterval(poll);poll=null;cancelListen=null;
  if(rec===r)rec=null;
  await sleep(250); // tail so the last word isn't clipped
  const uri=await teardownRecorder(r);
  await Audio.setAudioModeAsync({allowsRecordingIOS:false,playsInSilentModeIOS:true}).catch(()=>{});
  if(cancelled||done!=='end'||!uri)return null;
  const text=(await transcribeAudio(uri)).trim();
  // Whisper's stock hallucinations on near-silence.
  if(!text||/^(thank you\.?|thanks for watching!?|you\.?|okay\. here is what i need you to do\.?)$/i.test(text))return null;
  return text;
}

export async function stopListening(){
  if(cancelListen)cancelListen();
  if(poll){clearInterval(poll);poll=null;}
  const r=rec;rec=null;
  if(r)await teardownRecorder(r);
}

function playUri(uri,signal){
  return new Promise(async(resolve)=>{
    try{
      await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});
      const{sound:snd}=await Audio.Sound.createAsync({uri},playOpts({shouldPlay:true}));
      sound=snd;
      const finish=()=>{snd.setOnPlaybackStatusUpdate(null);snd.unloadAsync().catch(()=>{});if(sound===snd)sound=null;resolve();};
      snd.setOnPlaybackStatusUpdate(st=>{if(st.didJustFinish||(!st.isLoaded&&st.error))finish();});
      signal?.addEventListener?.('abort',()=>{snd.stopAsync().catch(()=>{});finish();});
    }catch{resolve();}
  });
}

// A.R.A.'s Grok voice: deliver this exact text in her voice -> WAV file uri.
async function grokVoiceUri(text,signal){
  const keys=await loadKeys();
  if(!keys?.grok)return null;
  return new Promise((resolve)=>{
    const chunks=[];
    const ws=new WebSocket('wss://api.x.ai/v1/realtime?model=grok-voice-latest',['realtime','openai-insecure-api-key.'+keys.grok,'openai-beta.realtime-v1']);
    grokWs=ws;
    let ready=false;
    const end=(v)=>{try{ws.close();}catch{}if(grokWs===ws)grokWs=null;resolve(v);};
    const timer=setTimeout(()=>end(null),45000);
    signal?.addEventListener?.('abort',()=>{clearTimeout(timer);end(null);});
    ws.onopen=()=>ws.send(JSON.stringify({type:'session.update',session:{
      voice:'ara',turn_detection:null,
      instructions:'You are A.R.A. speaking out loud. Say the text you are given in your own natural voice — same words and meaning, nothing added.',
      audio:{input:{format:{type:'audio/pcm',rate:24000}},output:{format:{type:'audio/pcm',rate:24000}}},
    }}));
    ws.onerror=()=>{clearTimeout(timer);end(null);};
    ws.onmessage=async(e)=>{
      let ev;try{ev=JSON.parse(e.data);}catch{return;}
      if((ev.type==='session.created'||ev.type==='session.updated')&&!ready){
        ready=true;
        ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text:`Say this out loud now:\n"${text}"`}]}}));
        ws.send(JSON.stringify({type:'response.create'}));
      }else if(ev.type==='response.output_audio.delta'){
        try{const b=atob(ev.delta);const u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);chunks.push(u);}catch{}
      }else if(ev.type==='response.done'){
        clearTimeout(timer);
        if(!chunks.length){end(null);return;}
        const total=chunks.reduce((n,c)=>n+c.length,0);
        const wav=new Uint8Array(44+total);
        const v=new DataView(wav.buffer);
        const w8=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
        w8(0,'RIFF');v.setUint32(4,36+total,true);w8(8,'WAVE');w8(12,'fmt ');v.setUint32(16,16,true);
        v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,24000,true);v.setUint32(28,48000,true);
        v.setUint16(32,2,true);v.setUint16(34,16,true);w8(36,'data');v.setUint32(40,total,true);
        let off=44;for(const c of chunks){wav.set(c,off);off+=c.length;}
        let bin='';for(let i=0;i<wav.length;i+=8192)bin+=String.fromCharCode.apply(null,wav.subarray(i,i+8192));
        const uri=FileSystem.cacheDirectory+'lab_ara_'+Date.now()+'.wav';
        try{await FileSystem.writeAsStringAsync(uri,btoa(bin),{encoding:FileSystem.EncodingType.Base64});end(uri);}catch{end(null);}
      }
    };
  });
}

// Speak `text` as `personaId`. Resolves when playback finishes or is aborted.
export async function speakAs(personaId,text,{signal}={}){
  await stopSpeaking();
  const clean=String(text||'').replace(/\[[^\]]*\]/g,'').replace(/[*#`_]/g,'').trim();
  if(!clean||signal?.aborted)return;
  const p=getPersona(personaId);
  let uri=null;
  try{
    if(p?.useGrokVoice)uri=await grokVoiceUri(clean,signal);
    else if(p?.elevenlabsVoiceId)uri=await textToSpeech(clean,p.elevenlabsVoiceId,p.name,{signal});
  }catch{}
  if(signal?.aborted)return;
  if(uri)return playUri(uri,signal);
  return new Promise((resolve)=>{
    signal?.addEventListener?.('abort',()=>{try{Speech.stop();}catch{}resolve();});
    try{Speech.speak(clean.slice(0,900),{language:'en-US',rate:speechRate(0.95),onDone:resolve,onStopped:resolve,onError:resolve});}
    catch{resolve();}
  });
}

export async function stopSpeaking(){
  try{Speech.stop();}catch{}
  if(grokWs){try{grokWs.close();}catch{}grokWs=null;}
  const s=sound;sound=null;
  if(s){try{s.setOnPlaybackStatusUpdate(null);await s.stopAsync();await s.unloadAsync();}catch{}}
}

export async function stopAll(){
  await stopListening();
  await stopSpeaking();
}
