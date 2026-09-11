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
import{Audio}from 'expo-av';
import*as FileSystem from 'expo-file-system';
import{loadKeys}from './keyStore';
import{personaSystemPrompt,queryMemory}from './aiService';
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
  const{sound:snd}=await Audio.Sound.createAsync({uri},{shouldPlay:true});
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
  const instructions=(await personaSystemPrompt('ara'))
    +`\n\n[LIVE VOICE CALL: you are on a real-time voice call with Mr. Burrus — everything is spoken and heard live, not read. Talk naturally and conversationally, short turns, the way a person on a call does. You will not receive [SAVE_NOTE], [REMEMBER] or other write-side tags here — if he asks you to save or remember something mid-call, tell him you'll get it down and note it in the regular chat, don't pretend to write it. You DO have read_hud and query_memory as live tools — use them instead of guessing when the answer depends on current state or something from your history with him.]`;
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
          turn_detection:{type:'server_vad',threshold:0.6,silence_duration_ms:650,prefix_padding_ms:300},
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
            resolve({stop:stopAraLive});
          }
          break;
        // Barge-in: the instant the server's VAD hears you start talking,
        // cut her off — she is never allowed to talk over you.
        case'input_audio_buffer.speech_started':
          listening=true;onState?.('listening');
          stopPlayback();
          break;
        case'conversation.item.input_audio_transcription.updated':{
          const t=event.content?.[0]?.transcript||event.transcript;
          if(t)onUserText?.(t,false);
          break;
        }
        case'conversation.item.input_audio_transcription.completed':{
          const t=event.content?.[0]?.transcript||event.transcript;
          if(t)onUserText?.(t,true);
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
          if(chunks.length)await playResponseAudio(chunks,onState,()=>{});
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

export async function stopAraLive(){
  const socket=ws;ws=null;
  if(streamStarted){try{LiveAudioStream.stop();}catch{}streamStarted=false;}
  try{LiveAudioStream.removeAllListeners?.('data');}catch{}
  await stopPlayback();
  audioChunks=[];respTranscript='';listening=false;
  if(socket){try{socket.close();}catch{}}
  try{await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});}catch{}
}

export function isAraLiveActive(){return!!ws;}
