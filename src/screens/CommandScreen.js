import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,FlatList,KeyboardAvoidingView,Platform,ActivityIndicator,ScrollView,Modal,Image,Alert,Keyboard}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{Audio}from 'expo-av';
import*as Speech from 'expo-speech';
import*as ImagePicker from 'expo-image-picker';
import*as DocumentPicker from 'expo-document-picker';
import{Camera}from 'expo-camera';
import*as FileSystem from 'expo-file-system';
import{PERSONA_LIST,getPersona}from '../personas/personas';
import{callPersona,textToSpeech,transcribeAudio,queryMemory,webSearch,personaSystemPrompt}from '../services/aiService';
import{drStart,drGetActive,drTick,drDismiss,DR_POLL_MS}from '../services/deepResearch';
import{handleCommands,stripCommands}from '../services/commandHandler';
import{googleReadInjections,googleWriteCommands}from '../services/googleCommands';
import{getMessages,saveMessage,getAllPersonaPics,savePersonaMemory,getSetting,getExpenseSummary,addBuildJob,updateBuildJob,getBuildJob,getBuildJobs}from '../services/database';
import{fileBuildRequest,replyToBuild,mergeBuild,cancelBuild}from '../services/buildAgent';
import{pollBuildJobs}from '../services/buildJobs';
import{tlSnapshot,tlFormatSnapshot,tlPlaceOrder,tlClosePosition,tlPositions,MAX_QTY}from '../services/tradeLocker';
import{recordTradeOpen,reconcileOpenTrades,atlasJournalBlock,setStrategy,setTradeReview}from '../services/tradeJournal';
import{loadKeys}from '../services/keyStore';
import useEmpireStore from '../store/useEmpireStore';
import{useIsFocused}from '@react-navigation/native';
import OrbZoom from './command/OrbZoom';
import ChartOverlay from './command/ChartOverlay';
import TradePanel from './command/TradePanel';
import TradeStatus from '../components/TradeStatus';
import TradeRecordBar from './command/TradeRecordBar';
import DeepResearchBanner from './command/DeepResearchBanner';
import BuildPanel from './command/BuildPanel';
import NudgeBar from './command/NudgeBar';
import{parseChartSpec}from '../services/chartSpec';

const TEAM_PHOTO=require('../../assets/teamphoto.png');
const HANDS_FREE_SILENCE_MS=3000;   // quiet for this long AFTER real speech -> stop (allow mid-sentence pauses)
const HANDS_FREE_VOICE_DB=-47;      // metering above this counts as "talking"
const HANDS_FREE_MAX_MS=30000;      // hard cap on one hands-free take
const HANDS_FREE_NOMETER_MS=8000;   // devices that don't report metering -> fixed take
const HANDS_FREE_NOVOICE_MS=7000;   // mic open this long with no voice at all -> give up, discard the take
const MANUAL_MAX_MS=120000;         // manual SPEAK take: 2-min safety backstop only (user taps STOP REC)
// Faster models for voice turns (lower latency to first audio). Gated behind the
// voice_fast_model setting; grok is omitted so ROGUE keeps grok-3-latest.
const VOICE_MODELS={claude:'claude-haiku-4-5',openai:'gpt-4o-mini'};
const PLAYBACK_WEDGE_MS=4000;       // playback position frozen this long -> treat as finished
const PLAYBACK_MAX_MS=20000;        // absolute ceiling on one spoken segment
// Synthetic speech-loudness envelope for the persona orb (no real FFT in Expo).
function synthAmp(){
  const t=Date.now()/1000;
  return Math.max(0.18,Math.min(1,0.32+0.34*(0.5+0.5*Math.sin(t*6.3))+0.22*Math.sin(t*15.1)+0.12*Math.sin(t*27.7)));
}

export default function CommandScreen({navigation}){
  const[activePersona,setActivePersona]=useState('jarvis');
  const[mode,setMode]=useState('direct');
  const[input,setInput]=useState('');
  const[messages,setMessages]=useState([]);
  const[groupMessages,setGroupMessages]=useState([]);
  const[loading,setLoading]=useState(false);
  const[voiceOn,setVoiceOn]=useState(false);
  const[voicePaused,setVoicePaused]=useState(false);
  const[voiceMuted,setVoiceMuted]=useState(false);
  const[continuous,setContinuous]=useState(false);
  const[recording,setRecording]=useState(false);
  const[handsFree,setHandsFree]=useState(false);
  const[customPersonas,setCustomPersonas]=useState([]);
  const[showCustomPicker,setShowCustomPicker]=useState(false);
  const[selectedCustom,setSelectedCustom]=useState([]);
  const[personaPics,setPersonaPics]=useState({});
  const[showCamera,setShowCamera]=useState(false);
  const[cameraRef,setCameraRef]=useState(null);
  const[view,setView]=useState('viz'); // viz | text
  const[orbLevel,setOrbLevel]=useState('group'); // lifted so it survives the viz/text toggle
  const[tradeProposal,setTradeProposal]=useState(null); // {symbol,side,entry,stopLoss,takeProfit,qty,rationale,pid}
  const[tradeBusy,setTradeBusy]=useState(false);
  const[deepResearch,setDeepResearch]=useState(null); // deep_research row + progressObj; null when idle. Persisted — see services/deepResearch.js
  const[chartOverlay,setChartOverlay]=useState(null); // parsed chart spec shown over the orb
  const[googleAction,setGoogleAction]=useState(null); // pending Google action awaiting a confirm tap
  const[googleBusy,setGoogleBusy]=useState(false);
  const googleActionRef=useRef(null);
  const googleQueueRef=useRef([]);
  const vizRef=useRef({speaking:false,amplitude:0,color:'#E8C98A',personaId:'jarvis'}).current;
  const inputRef=useRef('');       // mirrors `input` so send() never misses a pending keystroke
  const textInputRef=useRef(null);
  const flatRef=useRef(null);
  const abortRef=useRef(null);
  const contRef=useRef(false);
  const soundRef=useRef(null);
  const speakCancelRef=useRef(null); // stops the in-progress voice+text reveal
  // --- streamed sentence-chunked TTS (ElevenLabs personas, voice on) ---
  const streamSpeakActiveRef=useRef(false);
  const ttsTextQueueRef=useRef([]);   // [{text,idx}] sentences waiting to be synthesized
  const ttsAudioQueueRef=useRef([]);  // [{uri,text,idx}] synthesized, waiting to play
  const ttsInputClosedRef=useRef(false); // LLM stream finished, no more sentences coming
  const ttsSynthBusyRef=useRef(false);
  const ttsSpokenRef=useRef('');      // text already voiced — drives the reveal
  const ttsCancelRef=useRef(false);
  const ttsGenRef=useRef(0);         // bumped each reply so a stale pump can't write into the next
  const ttsPlayedCountRef=useRef(0); // audio segments actually played this reply
  const voiceFastRef=useRef('1');
  const recordingRef=useRef(null);
  const araWsRef=useRef(null);
  const araChunksRef=useRef([]);
  const handsFreeRef=useRef(false);
  const loadingRef=useRef(false);
  const voicePausedRef=useRef(false);
  const silenceTimerRef=useRef(null);
  const hasVoicedRef=useRef(false);
  const voicedCountRef=useRef(0);   // metering polls that crossed the voice threshold
  const emptyTakeRef=useRef(false); // hands-free take that never heard a voice — discard, don't transcribe
  const recBusyRef=useRef(false); // true while a recorder is preparing OR being torn down
  const recPollRef=useRef(null);  // interval polling the recorder's metering
  const recStartRef=useRef(0);
  const manualRef=useRef(false); // true while the current take was started by the SPEAK button
  const{addRelay}=useEmpireStore();
  const isFocused=useIsFocused();

  useEffect(()=>{contRef.current=continuous;},[continuous]);
  useEffect(()=>{handsFreeRef.current=handsFree;},[handsFree]);
  useEffect(()=>{if(!vizRef.speaking){vizRef.personaId=activePersona;vizRef.color=getPersona(activePersona).color;}},[activePersona]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{loadingRef.current=loading;},[loading]);
  useEffect(()=>{voicePausedRef.current=voicePaused;},[voicePaused]);
  useEffect(()=>{getSetting('voice_fast_model','1').then(v=>{voiceFastRef.current=v;}).catch(()=>{});},[]);
  // Continuous-voice loop: the single source of truth for re-opening the mic.
  // Whenever hands-free is on and nothing is thinking, speaking or already
  // recording, listen again. Playback callbacks null soundRef and clear loading;
  // this effect notices the state settle and fires — which the old inline
  // maybeAutoListen() calls missed because they ran before loading flipped.
  useEffect(()=>{
    if(!handsFree||voicePaused)return;
    if(loading||recording||!isFocused)return;
    const t=setTimeout(()=>{
      if(handsFreeRef.current&&!loadingRef.current&&!recordingRef.current&&!recBusyRef.current&&!voicePausedRef.current&&!soundRef.current){
        startRecording();
      }
    },500);
    return()=>clearTimeout(t);
  },[handsFree,voicePaused,loading,recording,isFocused]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(mode==='direct')loadHistory(activePersona);},[activePersona,mode]);
  useEffect(()=>{
    audioModeForRecording();
    loadPics();
    return()=>{
      // Full teardown — a half-lived timer / socket / sound is a common crash source.
      clearSilenceTimer();
      clearRecPoll();
      handsFreeRef.current=false;
      manualRef.current=false;
      try{abortRef.current?.abort();}catch{}
      try{speakCancelRef.current?.();}catch{}
      if(recordingRef.current){try{recordingRef.current.stopAndUnloadAsync();}catch{}recordingRef.current=null;}
      clearSound();
      if(araWsRef.current){try{araWsRef.current.close();}catch{}araWsRef.current=null;}
      try{Speech.stop();}catch{}
    };
  },[]);
  // Navigating away from Command: stop listening / speaking immediately. The
  // continuous-voice effect gates on isFocused, so it resumes on return.
  useEffect(()=>{
    if(isFocused)return;
    clearSilenceTimer();
    if(recordingRef.current)stopRecording();
    stopAudio();
  },[isFocused]);// eslint-disable-line react-hooks/exhaustive-deps

  async function loadPics(){try{const pics=await getAllPersonaPics();setPersonaPics(pics);}catch{}}

  async function loadHistory(persona){
    const h=await getMessages(persona,40);
    setMessages(h.reverse().map(m=>({id:m.id.toString(),role:m.role,content:m.content,persona:m.persona})));
  }

  function clearSilenceTimer(){
    if(silenceTimerRef.current){clearTimeout(silenceTimerRef.current);silenceTimerRef.current=null;}
  }
  function clearRecPoll(){
    if(recPollRef.current){clearInterval(recPollRef.current);recPollRef.current=null;}
  }
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function waitUntil(cond,timeout=3000){
    const t0=Date.now();
    while(!cond()&&Date.now()-t0<timeout)await sleep(50);
    return cond();
  }
  async function audioModeForPlayback(){
    try{await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});}catch{}
  }
  async function audioModeForRecording(){
    try{await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:true});}catch{}
  }
  // The single teardown path for a playback Sound. Nulls soundRef FIRST so the
  // continuous-voice effect / maybeAutoListen can't stay wedged behind a dead
  // sound, then best-effort detaches + stops + unloads.
  async function clearSound(){
    const snd=soundRef.current;
    soundRef.current=null;
    if(!snd)return;
    try{snd.setOnPlaybackStatusUpdate(null);}catch{}
    try{await snd.stopAsync();}catch{}
    try{await snd.unloadAsync();}catch{}
  }

  // Called ~4x/second from a poll of the recorder's status. Decides when the
  // hands-free take is done.
  function onRecordingStatus(status){
    if(!status||!status.isRecording)return;
    if(!recordingRef.current)return;
    const elapsed=Date.now()-recStartRef.current;
    const m=(typeof status.metering==='number')?status.metering:null;

    // Hard cap — never let a take run away.
    if(elapsed>(manualRef.current?MANUAL_MAX_MS:HANDS_FREE_MAX_MS)){stopRecording();return;}

    // Manual SPEAK take: no auto-stop at all — the user ends it with STOP REC.
    // Everything below (no-meter fixed take, voice-detect discard, silence timer)
    // is hands-free only.
    if(manualRef.current)return;

    // Device reports no metering → fall back to a fixed-length take.
    if(m===null){
      if(elapsed>HANDS_FREE_NOMETER_MS)stopRecording();
      return;
    }

    // Only real audio counts as speech — needs a couple of polls above the
    // threshold so a single click/pop doesn't register. Mic-open time is NOT
    // speech (that was sending silence to the transcriber).
    const talking=m>HANDS_FREE_VOICE_DB;
    if(talking){
      voicedCountRef.current+=1;
      hasVoicedRef.current=true; // one real poll above threshold is enough at -47 dB
    }

    // Never actually heard the user — don't ship silence to Whisper (it
    // hallucinates phantom phrases). Give up and drop the take.
    if(!hasVoicedRef.current){
      if(elapsed>HANDS_FREE_NOVOICE_MS){emptyTakeRef.current=true;stopRecording();}
      return;
    }

    if(talking){
      clearSilenceTimer();
    }else if(!silenceTimerRef.current){
      silenceTimerRef.current=setTimeout(()=>{
        silenceTimerRef.current=null;
        if(recordingRef.current)stopRecording();
      },HANDS_FREE_SILENCE_MS);
    }
  }

  // Options for callPersona on a voice turn: a faster model + tighter length so
  // the persona starts talking sooner. Off when voice is off or the setting is
  // disabled; per-persona `voiceModel` (personas.js) can override or opt out.
  function voiceModelOpts(p){
    if(!(voiceOn&&!voiceMuted)||voiceFastRef.current!=='1')return{};
    const model=p.voiceModel||VOICE_MODELS[p.api];
    return model?{model,maxTokens:800}:{maxTokens:900};
  }

  function maybeAutoListen(){
    if(!handsFreeRef.current)return;
    if(loadingRef.current)return;
    if(voicePausedRef.current)return;
    if(recordingRef.current)return;
    startRecording();
  }

  async function buildAndPlayGrokAudio(chunks){
    if(!chunks.length)return null;
    const totalLength=chunks.reduce((sum,c)=>sum+c.length,0);
    const pcm=new Uint8Array(totalLength);
    let offset=0;
    for(const chunk of chunks){pcm.set(chunk,offset);offset+=chunk.length;}
    const header=new Uint8Array(44);
    const v=new DataView(header.buffer);
    const ws=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};
    ws(0,'RIFF');v.setUint32(4,36+pcm.byteLength,true);ws(8,'WAVE');
    ws(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);
    v.setUint16(22,1,true);v.setUint32(24,24000,true);
    v.setUint32(28,48000,true);v.setUint16(32,2,true);
    v.setUint16(34,16,true);ws(36,'data');v.setUint32(40,pcm.byteLength,true);
    const wav=new Uint8Array(44+pcm.byteLength);
    wav.set(header);wav.set(pcm,44);
    let binary='';
    for(let i=0;i<wav.length;i+=8192)binary+=String.fromCharCode.apply(null,wav.subarray(i,i+8192));
    const base64=btoa(binary);
    const uri=FileSystem.cacheDirectory+'ara_'+Date.now()+'.wav';
    await FileSystem.writeAsStringAsync(uri,base64,{encoding:FileSystem.EncodingType.Base64});
    await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});
    const{sound}=await Audio.Sound.createAsync({uri},{shouldPlay:true,progressUpdateIntervalMillis:80});
    return sound;
  }

  async function araGrokVoice(text){
    const keys=await loadKeys();
    if(!keys?.grok)throw new Error('Grok API key needed for Ara voice. Add in Settings.');
    araChunksRef.current=[];
    // Seed the voice socket with the same HUD + memory context Ara's text turn got.
    let araInstructions=getPersona('ara').system;
    try{araInstructions=await personaSystemPrompt('ara');}catch{}
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(
        'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
        ['realtime','openai-insecure-api-key.'+keys.grok,'openai-beta.realtime-v1']
      );
      araWsRef.current=ws;
      let sessionReady=false;
      let transcript='';
      let audioMs=0;              // running duration of audio received (16-bit mono 24kHz)
      const timeline=[];          // [{atMs, chars}] — text position vs. spoken time
      ws.onopen=()=>{
        ws.send(JSON.stringify({
          type:'session.update',
          session:{
            voice:'ara',
            instructions:araInstructions,
            turn_detection:null,
            audio:{
              input:{format:{type:'audio/pcm',rate:24000}},
              output:{format:{type:'audio/pcm',rate:24000}},
            }
          }
        }));
      };
      ws.onmessage=async(e)=>{
        let event;try{event=JSON.parse(e.data);}catch{return;}
        if(event.type==='session.created'||event.type==='session.updated'){
          if(!sessionReady){
            sessionReady=true;
            ws.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}}));
            ws.send(JSON.stringify({type:'response.create'}));
          }
        }
        if(event.type==='response.output_audio.delta'){
          try{
            const binary=atob(event.delta);
            const bytes=new Uint8Array(binary.length);
            for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
            araChunksRef.current.push(bytes);
            audioMs+=(bytes.length/2)/24000*1000;
          }catch{}
        }
        if(event.type==='response.output_audio_transcript.delta'){
          transcript+=event.delta;
          timeline.push({atMs:audioMs,chars:transcript.length});
        }
        if(event.type==='response.done'){
          try{
            const sound=await buildAndPlayGrokAudio(araChunksRef.current);
            araChunksRef.current=[];
            try{ws.close();}catch{}
            araWsRef.current=null;
            resolve({sound,transcript,timeline});
          }catch(err){reject(err);}
        }
        if(event.type==='error'){try{ws.close();}catch{}araWsRef.current=null;reject(new Error(event.message||'Ara voice error'));}
      };
      ws.onerror=()=>{araWsRef.current=null;reject(new Error('Ara voice: connection failed'));};
    });
  }

  async function speakResponse(text,persona){
    if(!voiceOn||voiceMuted||!text){maybeAutoListen();return;}
    if(voicePaused)return;
    speakCancelRef.current?.();
    try{
      await clearSound();
      await waitUntil(()=>!recBusyRef.current,3000);
      await audioModeForPlayback();
      if(persona.id==='ara'){
        const result=await araGrokVoice(text);
        soundRef.current=result?.sound||null;
        if(soundRef.current)soundRef.current.setOnPlaybackStatusUpdate(st=>{if(st.didJustFinish){clearSound();maybeAutoListen();}});
        else maybeAutoListen();
      }else if(persona.elevenlabsVoiceId){
        const uri=await textToSpeech(text,persona.elevenlabsVoiceId,persona.name);
        if(uri){
          await audioModeForPlayback();
          const{sound}=await Audio.Sound.createAsync({uri},{shouldPlay:true});
          soundRef.current=sound;
          sound.setOnPlaybackStatusUpdate(st=>{if(st.didJustFinish){clearSound();maybeAutoListen();}});
        }else{
          Speech.speak(text.substring(0,500),{language:'en-US',rate:0.95,onDone:()=>maybeAutoListen(),onStopped:()=>maybeAutoListen()});
        }
      }else{
        Speech.speak(text.substring(0,500),{language:'en-US',rate:0.95,onDone:()=>maybeAutoListen(),onStopped:()=>maybeAutoListen()});
      }
    }catch(err){
      Speech.speak(text.substring(0,500),{language:'en-US',rate:0.95,onDone:()=>maybeAutoListen(),onStopped:()=>maybeAutoListen()});
    }
  }

  // Speaks `text` and reveals it in the chat bubble (id=msgId) in step with
  // playback. Resolves { revealed, completed } — how many characters were
  // actually voiced before it finished or was interrupted.
  async function speakWithReveal(text,persona,msgId,isGroup){
    const setMsgs=isGroup?setGroupMessages:setMessages;
    const patch=(fn)=>setMsgs(prev=>prev.map(m=>m.id===msgId?fn(m):m));

    if(!voiceOn||voiceMuted||!text){
      // No voice — still light the orb up briefly so every reply registers visually.
      if(!text)vizRef.speaking=false;
      if(text){
        vizRef.speaking=true;
        const until=Date.now()+Math.min(4500,900+text.length*11);
        const pulse=setInterval(()=>{
          vizRef.amplitude=synthAmp();
          if(Date.now()>=until){clearInterval(pulse);vizRef.speaking=false;vizRef.amplitude=0;}
        },80);
      }
      patch(m=>({...m,content:text,revealed:text.length,streaming:false}));
      maybeAutoListen();
      return{revealed:text.length,completed:true,finalText:text};
    }
    await clearSound();

    return new Promise((resolve)=>{
      let settled=false,cancelled=false,timer=null,safety=null,lastRevealed=0,fullText=text;
      let lastPos=-1,lastPosAt=Date.now(),failCount=0,durKnown=false;
      const cleanup=()=>{if(timer){clearInterval(timer);timer=null;}if(safety){clearTimeout(safety);safety=null;}speakCancelRef.current=null;};
      const done=(completed)=>{
        if(settled)return;settled=true;cleanup();
        vizRef.speaking=false;
        clearSound();
        const revealed=completed?fullText.length:lastRevealed;
        const finalText=completed?fullText:(fullText.slice(0,revealed).trim()+(revealed<fullText.length?' …':''));
        patch(m=>({...m,content:finalText,revealed:finalText.length,streaming:false}));
        maybeAutoListen();
        resolve({revealed,completed,finalText});
      };
      speakCancelRef.current=()=>{cancelled=true;done(false);};

      const startTimer=(sound,timeline)=>{
        vizRef.speaking=true;
        lastPos=-1;lastPosAt=Date.now();failCount=0;
        // Pre-duration ceiling: only covers a Sound that never loads / never
        // starts. Replaced by dur+3s once the real length is known (uncapped —
        // a long reply must be allowed to finish). Mid-playback wedges are
        // caught by the position-stall watchdog below, whatever the length.
        safety=setTimeout(()=>done(true),25000);
        timer=setInterval(async()=>{
          if(cancelled)return;
          if(abortRef.current?.signal.aborted){done(false);return;}
          if(voicePausedRef.current){lastPosAt=Date.now();return;} // don't count a deliberate pause as a stall
          let st;
          try{st=await sound.getStatusAsync();failCount=0;}
          catch{if(++failCount>=10){done(true);}return;}
          if(!st?.isLoaded)return;
          if(st.isPlaying)vizRef.amplitude=synthAmp();
          const pos=st.positionMillis||0,dur=st.durationMillis||0;
          if(dur>0&&!durKnown){durKnown=true;if(safety)clearTimeout(safety);safety=setTimeout(()=>done(true),dur+3000);}
          // Position-stall watchdog: if playback claims to be running but the
          // clock hasn't moved for PLAYBACK_WEDGE_MS (past a short load grace),
          // treat it as finished. Position-based, so long healthy audio is fine.
          if(pos!==lastPos){lastPos=pos;lastPosAt=Date.now();}
          else if(!st.didJustFinish&&pos>0&&Date.now()-lastPosAt>PLAYBACK_WEDGE_MS){done(true);return;}
          let target;
          if(timeline&&timeline.length){
            let c=0;for(const e of timeline){if(e.atMs<=pos)c=e.chars;else break;}
            target=c||(dur?Math.ceil(fullText.length*Math.min(1,pos/dur)):lastRevealed);
          }else{
            target=dur?Math.ceil(fullText.length*Math.min(1,pos/dur)):lastRevealed;
          }
          if(target>lastRevealed){lastRevealed=Math.min(fullText.length,target);patch(m=>({...m,revealed:lastRevealed}));}
          if(st.didJustFinish)done(true);
        },80);
      };
      const nativeFallback=()=>{
        try{Speech.speak(fullText.slice(0,700),{language:'en-US',rate:0.95,onDone:()=>done(true),onStopped:()=>done(false)});}catch{done(false);return;}
        vizRef.speaking=true;
        safety=setTimeout(()=>done(true),Math.min(60000,(fullText.length/11)*1000+4000));
        timer=setInterval(()=>{
          if(cancelled)return;
          vizRef.amplitude=synthAmp();
          lastRevealed=Math.min(fullText.length,lastRevealed+2);
          patch(m=>({...m,revealed:lastRevealed}));
          if(lastRevealed>=fullText.length){clearInterval(timer);timer=null;}
        },90);
      };

      (async()=>{
        try{
          // Make sure any just-finished recorder is fully gone and the iOS audio
          // session is in playback mode BEFORE the first Sound is created —
          // otherwise the first voiced reply silently fails to play.
          await waitUntil(()=>!recBusyRef.current,3000);
          await audioModeForPlayback();
          await sleep(60);
          let sound=null,timeline=null;
          if(persona.id==='ara'){
            const r=await araGrokVoice(fullText);
            sound=r?.sound||null;timeline=r?.timeline||null;
            if(r?.transcript&&r.transcript.length>fullText.length){fullText=r.transcript;patch(m=>({...m,content:fullText}));}
          }else if(persona.elevenlabsVoiceId){
            const uri=await textToSpeech(fullText,persona.elevenlabsVoiceId,persona.name);
            if(uri){
              const created=await Audio.Sound.createAsync({uri},{shouldPlay:false,progressUpdateIntervalMillis:80});
              sound=created.sound;
              try{
                await sound.playAsync();
                await sleep(250);
                const st=await sound.getStatusAsync();
                if(st.isLoaded&&!st.isPlaying&&!st.didJustFinish){await sound.setPositionAsync(0);await sound.playAsync();}
              }catch{}
            }
          }
          if(cancelled||settled){if(sound){try{await sound.stopAsync();await sound.unloadAsync();}catch{}}return;}
          if(!sound){nativeFallback();return;}
          soundRef.current=sound;
          startTimer(sound,timeline);
        }catch(err){
          if(!settled)nativeFallback();
        }
      })();
    });
  }

  // ---- Streamed sentence-chunked TTS (ElevenLabs personas, voice on) -------
  // Instead of one TTS call for the whole reply, chop it into sentences and
  // synthesize + play them back to back. First audio lands after ~one sentence.
  function resetStreamSpeak(){
    ttsGenRef.current+=1;
    ttsTextQueueRef.current=[];
    ttsAudioQueueRef.current=[];
    ttsInputClosedRef.current=false;
    ttsSynthBusyRef.current=false;
    ttsSpokenRef.current='';
    ttsCancelRef.current=false;
    ttsPlayedCountRef.current=0;
    streamSpeakActiveRef.current=true;
    return ttsGenRef.current;
  }
  // Complete sentences of `clean` starting after `consumedLen`. Fragments below
  // ~24 chars (and common abbreviations like "Mr.") are merged forward so we
  // never synthesize a stray "Mr." on its own. flush=true also takes the tail.
  function sliceSentences(clean,consumedLen,flush){
    const rest=clean.slice(consumedLen);
    const segs=[];
    const ABBR=/(?:^|\s)(mr|mrs|ms|dr|sr|jr|st|vs|etc|no|inc|co|fig|eg|ie|approx|a\.m|p\.m)\.$/i;
    let cut=0,pending='';
    const re=/[.!?…](?:["')\]]+)?(?:\s|$)|\n+/g;
    let m;
    while((m=re.exec(rest))){
      const end=m.index+m[0].length;
      pending+=rest.slice(cut,end);
      cut=end;
      const t=pending.trim();
      if(t.length>=24&&!ABBR.test(t)){segs.push(t);pending='';}
    }
    if(flush){
      pending+=rest.slice(cut);
      cut=rest.length;
      const t=pending.trim();
      if(t)segs.push(t);
      pending='';
    }
    // `consumed` only advances past text we actually emitted as segments.
    return{segments:segs,consumed:consumedLen+cut-pending.length};
  }
  async function ttsSynthPump(persona,gen){
    if(ttsSynthBusyRef.current)return;
    ttsSynthBusyRef.current=true;
    const live=()=>gen===ttsGenRef.current&&!ttsCancelRef.current;
    try{
      while(live()){
        if(ttsAudioQueueRef.current.length>=2){await sleep(120);continue;} // stay ~1 ahead
        const next=ttsTextQueueRef.current.shift();
        if(!next){
          if(ttsInputClosedRef.current)break;
          await sleep(80);continue;
        }
        const peek=ttsTextQueueRef.current[0]?.text||'';
        let uri=null;
        try{
          uri=await textToSpeech(next.text,persona.elevenlabsVoiceId,persona.name,{
            signal:abortRef.current?.signal,previousText:ttsSpokenRef.current,nextText:peek,
          });
        }catch{}
        if(!live())break;
        ttsAudioQueueRef.current.push({uri:uri||null,text:next.text});
      }
    }finally{if(gen===ttsGenRef.current)ttsSynthBusyRef.current=false;}
  }
  function ttsPlayPump(persona,patch,gen){
    return new Promise((resolve)=>{
      let stopped=false;
      const finish=()=>{if(stopped)return;stopped=true;if(gen===ttsGenRef.current)speakCancelRef.current=null;vizRef.speaking=false;vizRef.amplitude=0;maybeAutoListen();resolve();};
      speakCancelRef.current=()=>{ttsCancelRef.current=true;finish();};
      (async()=>{
       try{
        vizRef.speaking=true;
        await waitUntil(()=>!recBusyRef.current,3000);
        await audioModeForPlayback();
        while(gen===ttsGenRef.current&&!ttsCancelRef.current&&!abortRef.current?.signal.aborted){
          const item=ttsAudioQueueRef.current.shift();
          if(!item){
            if(ttsInputClosedRef.current&&!ttsSynthBusyRef.current&&!ttsTextQueueRef.current.length)break;
            await sleep(100);continue;
          }
          const base=ttsSpokenRef.current.length;
          const sep=ttsSpokenRef.current?' ':'';
          if(item.uri){
            try{
              const created=await Audio.Sound.createAsync({uri:item.uri},{shouldPlay:false,progressUpdateIntervalMillis:80});
              soundRef.current=created.sound;
              await created.sound.playAsync();
              ttsPlayedCountRef.current+=1;
              const t0=Date.now();let lastPos=-1,lastAt=Date.now();
              while(gen===ttsGenRef.current&&!ttsCancelRef.current&&!abortRef.current?.signal.aborted){
                if(voicePausedRef.current){lastAt=Date.now();await sleep(120);continue;}
                let st;try{st=await created.sound.getStatusAsync();}catch{break;}
                if(!st?.isLoaded)break;
                if(st.isPlaying)vizRef.amplitude=synthAmp();
                const pos=st.positionMillis||0,dur=st.durationMillis||0;
                const frac=dur>0?Math.min(1,pos/dur):0;
                patch(m=>({...m,revealed:Math.min((m.content||'').length,base+Math.ceil(item.text.length*frac))}));
                if(st.didJustFinish)break;
                if(pos!==lastPos){lastPos=pos;lastAt=Date.now();}
                else if(pos>0&&Date.now()-lastAt>PLAYBACK_WEDGE_MS)break;
                if(Date.now()-t0>PLAYBACK_MAX_MS)break;
                await sleep(80);
              }
            }catch{}
            await clearSound();
          }
          ttsSpokenRef.current+=sep+item.text;
          patch(m=>({...m,revealed:Math.min((m.content||'').length,ttsSpokenRef.current.length)}));
        }
       }catch{}
       finally{finish();}
      })();
    });
  }
  // Speak `display` for an ElevenLabs persona via the chunked pipeline. Resolves
  // when playback has fully drained (or was cancelled / aborted).
  async function streamSpeak(display,persona,patch){
    const gen=resetStreamSpeak();
    patch(m=>({...m,content:display,revealed:0,streaming:true}));
    const{segments}=sliceSentences(display,0,true);
    for(const s of segments)ttsTextQueueRef.current.push({text:s});
    ttsInputClosedRef.current=true;
    if(!segments.length){if(gen===ttsGenRef.current)streamSpeakActiveRef.current=false;return;}
    ttsSynthPump(persona,gen).catch(()=>{});
    await ttsPlayPump(persona,patch,gen);
    if(gen!==ttsGenRef.current)return; // a newer reply has taken over
    // Every segment failed to synthesize (e.g. ElevenLabs down) — rather than
    // leave the reply silent, read it once with the native voice.
    if(ttsPlayedCountRef.current===0&&!ttsCancelRef.current&&!abortRef.current?.signal.aborted){
      try{await new Promise(res=>{Speech.speak(display.slice(0,700),{language:'en-US',rate:0.95,onDone:res,onStopped:res});setTimeout(res,Math.min(60000,display.length*70+4000));});}catch{}
    }
    streamSpeakActiveRef.current=false;
    ttsCancelRef.current=false;
  }

  function stopAudio(){
    speakCancelRef.current?.();
    ttsCancelRef.current=true;
    ttsTextQueueRef.current=[];ttsAudioQueueRef.current=[];
    clearSound(); // nulls soundRef synchronously, then unloads
    if(araWsRef.current){try{araWsRef.current.close();}catch{}araWsRef.current=null;}
    Speech.stop();
  }

  function pauseAudio(){
    if(soundRef.current){try{soundRef.current.pauseAsync();}catch{}}
    Speech.stop();setVoicePaused(true);
  }

  function resumeAudio(){
    if(soundRef.current){try{soundRef.current.playAsync();}catch{}}
    setVoicePaused(false);
  }

  function toggleHandsFree(){
    setHandsFree(v=>{
      const next=!v;
      handsFreeRef.current=next;
      if(next){
        setTimeout(()=>maybeAutoListen(),200);
      }else{
        clearSilenceTimer();
        if(recordingRef.current)stopRecording();
      }
      return next;
    });
  }

  async function startRecording(opts={}){
    if(recBusyRef.current||recordingRef.current)return; // one already live or tearing down
    recBusyRef.current=true;
    try{
      const{status}=await Audio.requestPermissionsAsync();
      if(status!=='granted'){Alert.alert('Permission','Microphone access required.');recBusyRef.current=false;return;}
      await audioModeForRecording();
      const rec=new Audio.Recording();
      hasVoicedRef.current=false;
      voicedCountRef.current=0;
      emptyTakeRef.current=false;
      clearSilenceTimer();
      await rec.prepareToRecordAsync({...Audio.RecordingOptionsPresets.HIGH_QUALITY,isMeteringEnabled:true});
      try{rec.setProgressUpdateInterval(150);}catch{}
      await rec.startAsync();
      recordingRef.current=rec;
      recStartRef.current=Date.now();
      hasVoicedRef.current=false;
      manualRef.current=!!opts.manual;
      setRecording(true);
      recBusyRef.current=false;
      // Poll the recorder ourselves — setOnRecordingStatusUpdate is unreliable
      // across devices, and this is what decides when to auto-stop.
      clearRecPoll();
      recPollRef.current=setInterval(async()=>{
        if(!recordingRef.current){clearRecPoll();return;}
        try{onRecordingStatus(await recordingRef.current.getStatusAsync());}catch{}
      },250);
    }catch(e){
      recBusyRef.current=false;
      try{await Audio.setAudioModeAsync({allowsRecordingIOS:false,playsInSilentModeIOS:true});}catch{}
      // "Only one Recording object can be prepared at a given time" — a previous
      // recorder hasn't finished unloading. Stay quiet and let the loop retry.
      if(!/only one recording|prepared/i.test(String(e&&e.message))){
        Alert.alert('Error','Could not start recording: '+e.message);
      }else if(handsFreeRef.current){
        setTimeout(()=>maybeAutoListen(),700);
      }
    }
  }

  async function stopRecording(){
    clearSilenceTimer();
    clearRecPoll();
    setRecording(false);
    const rec=recordingRef.current;
    if(!rec)return;
    recordingRef.current=null;
    recBusyRef.current=true; // block the loop until this recorder is fully gone
    const wasEmpty=emptyTakeRef.current;
    const wasManual=manualRef.current;
    emptyTakeRef.current=false;
    manualRef.current=false;
    let uri=null;
    try{
      // Tail so the last word isn't clipped. Hands-free already recorded
      // HANDS_FREE_SILENCE_MS of trailing audio; a manual take has none.
      await sleep(wasManual?800:400);
      await Promise.race([rec.stopAndUnloadAsync().catch(()=>{}),sleep(6000)]);
      uri=rec.getURI();
    }catch(e){/* recorder already gone */}
    await sleep(120); // let iOS settle the audio session category before playback
    recBusyRef.current=false;
    // Hands-free take that never heard a voice — drop it, don't transcribe silence.
    if(wasEmpty||!uri){maybeAutoListen();return;}
    setLoading(true);
    try{
      const transcript=await transcribeAudio(uri);
      const clean=(transcript||'').trim();
      if(clean&&!isLikelyHallucination(clean)){
        const isGroup=mode!=='direct';
        const userMsg={id:Date.now().toString(),role:'user',content:clean,persona:'user'};
        if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
        else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',clean,'direct');}
        await runRound(clean,isGroup);
      }else{
        setLoading(false);
        maybeAutoListen();
      }
    }catch(e){Alert.alert('Voice Error',e.message);setLoading(false);maybeAutoListen();}
  }

  // Whisper invents stock phrases from silence or noise ("thank you", "you",
  // "thanks for watching"). Drop those and near-empty transcripts in hands-free
  // mode so a persona doesn't answer something the user never said.
  function isLikelyHallucination(text){
    const s=text.trim().toLowerCase().replace(/[.!?,…"'()[\]]+/g,'').replace(/\s+/g,' ').trim();
    if(s.length<=1)return true;
    // Classic Whisper "silence" outputs — YouTube-caption boilerplate nobody
    // actually says to an assistant. Kept deliberately narrow so real short
    // answers ("yes", "no", "stop") still get through.
    const PHANTOMS=new Set(['you','thank you','thank you so much','thank you very much','thanks for watching','thank you for watching','thanks for watching everyone','please subscribe','like and subscribe','subscribe to my channel','music','[music]','uh','um','mhm','you know','subtitles by the amaraorg community']);
    if(PHANTOMS.has(s))return true;
    const words=s.split(' ');
    if(words.length>=3&&new Set(words).size===1)return true; // "you you you"
    return false;
  }

  async function pickImage(){
    try{
      const{status}=await ImagePicker.requestMediaLibraryPermissionsAsync();
      if(status!=='granted'){Alert.alert('Permission','Photo library access required.');return;}
      const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:ImagePicker.MediaTypeOptions.Images,quality:0.8});
      if(!result.canceled&&result.assets[0]){
        const msg=`[Image attached]\n${(inputRef.current||input).trim()||'What do you see in this image?'}`;
        setInput('');inputRef.current='';try{textInputRef.current?.clear();}catch{}
        const userMsg={id:Date.now().toString(),role:'user',content:msg,persona:'user',image:result.assets[0].uri};
        const isGroup=mode!=='direct';
        if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
        else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',msg,'direct');}
        await runRound(msg,isGroup);
      }
    }catch(e){Alert.alert('Error',e.message);}
  }

  async function pickDocument(){
    try{
      const result=await DocumentPicker.getDocumentAsync({type:'*/*',copyToCacheDirectory:true});
      if(!result.canceled&&result.assets[0]){
        const doc=result.assets[0];
        const msg=`[Document: ${doc.name}]\n${(inputRef.current||input).trim()||'Analyze this document.'}`;
        setInput('');inputRef.current='';try{textInputRef.current?.clear();}catch{}
        const userMsg={id:Date.now().toString(),role:'user',content:msg,persona:'user'};
        const isGroup=mode!=='direct';
        if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
        else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',msg,'direct');}
        await runRound(msg,isGroup);
      }
    }catch(e){Alert.alert('Error',e.message);}
  }

  async function openCamera(){
    const{status}=await Camera.requestCameraPermissionsAsync();
    if(status!=='granted'){Alert.alert('Permission','Camera access required.');return;}
    setShowCamera(true);
  }

  async function takePicture(){
    if(!cameraRef)return;
    try{
      const photo=await cameraRef.takePictureAsync({quality:0.8});
      setShowCamera(false);
      const msg=`[Photo taken]\n${(inputRef.current||input).trim()||'What do you see in this photo?'}`;
      setInput('');inputRef.current='';try{textInputRef.current?.clear();}catch{}
      const userMsg={id:Date.now().toString(),role:'user',content:msg,persona:'user',image:photo.uri};
      const isGroup=mode!=='direct';
      if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
      else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',msg,'direct');}
      await runRound(msg,isGroup);
    }catch(e){Alert.alert('Error',e.message);}
  }

  function getTargets(){
    return mode==='custom'?customPersonas:[activePersona];
  }

  const pickPersonaFromOrb=useCallback((id)=>{setMode('direct');setActivePersona(id);setOrbLevel('orb');},[]);
  const launchGroupFromOrb=useCallback((ids)=>{setCustomPersonas(ids);setMode('custom');setView('text');},[]);

  // Back to the Empire city — the only way out of the Command screen now that
  // the bottom nav is gone. Tear down any live voice/recording first.
  function goToCity(){
    setHandsFree(false);handsFreeRef.current=false;clearSilenceTimer();
    if(recordingRef.current)stopRecording();
    stopAudio();
    navigation.navigate('Map');
  }

  async function send(){
    // The input is uncontrolled (no `value` prop) so Android never drops the last
    // keystroke to a state/native race. inputRef holds the live text; blur once to
    // flush any IME composition, then read it.
    try{textInputRef.current?.blur();}catch{}
    await new Promise(r=>setTimeout(r,40));
    const text=(inputRef.current||input).trim();if(!text||loading)return;
    inputRef.current='';setInput('');
    try{textInputRef.current?.clear();}catch{}
    Keyboard.dismiss();abortRef.current?.abort();stopAudio();
    const isGroup=mode!=='direct';
    const userMsg={id:Date.now().toString(),role:'user',content:text,persona:'user'};
    if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
    else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',text,'direct');}
    await runRound(text,isGroup);
  }

  async function runRound(text,isGroup){
    setLoading(true);abortRef.current=new AbortController();
    const myAbort=abortRef.current;
    const targets=isGroup?getTargets():[activePersona];
    const replies=[];
    try{
      for(const pid of targets){
        if(myAbort.signal.aborted)break;
        const p=getPersona(pid);
        const hist=(isGroup?groupMessages:messages).slice(-20).map(m=>({role:m.role==='user'||m.role==='assistant'?m.role:'user',content:m.content}));
        hist.push({role:'user',content:text});
        if(isGroup&&replies.length>0)hist.push({role:'user',content:`[PRIOR:\n${replies.map(r=>`${r.name}: ${r.text}`).join('\n\n')}\nAcknowledge and be brief.]`});
        const willVoice=voiceOn&&!voiceMuted;
        const msgId=`${Date.now()}-${pid}`;
        const setMsgs=isGroup?setGroupMessages:setMessages;
        const patch=(fn)=>setMsgs(prev=>prev.map(m=>m.id===msgId?fn(m):m));
        setMsgs(prev=>[...prev,{id:msgId,role:'assistant',content:'',persona:pid,revealed:0,streaming:true}]);
        vizRef.personaId=pid;vizRef.color=p.color;vizRef.speaking=true; // orb lights up the moment tokens start
        // When not voicing, type the reply into the bubble live as tokens arrive.
        // When voicing, hold the text hidden and let speakWithReveal sync it to speech.
        let raw='',lastPatch=0;
        const onDelta=willVoice?null:(t)=>{
          raw+=t;
          vizRef.amplitude=synthAmp();
          const now=Date.now();
          if(now-lastPatch<45)return; // throttle re-renders; the post-await patch flushes the tail
          lastPatch=now;
          const shown=(stripCommands(raw)||'').replace(/\[[A-Z_]+:?[^\]]*$/,'').trimEnd();
          patch(m=>({...m,content:shown,revealed:shown.length}));
        };
        const streamVoice=willVoice&&!!p.elevenlabsVoiceId&&p.id!=='ara';
        let response=await callPersona(pid,hist,myAbort.signal,onDelta,voiceModelOpts(p));
        // Second-pass tools: the persona emits a lookup tag on pass 1, we gather
        // the data, then it re-answers with everything in hand. One pass only.
        const injections=[];
        let toolLabel='◇ working…';
        const mq=[...response.matchAll(/\[MEMORY_QUERY:\s*([^\]]+)\]/gi)].map(x=>x[1].trim()).filter(Boolean);
        if(mq.length&&(await getSetting('memory_recall','1'))==='1'){
          toolLabel='◇ recalling…';
          for(const q of mq.slice(0,2)){
            try{injections.push(`MEMORY RECALL — Q: ${q}\nA: ${await queryMemory(pid,q,myAbort.signal)}`);}
            catch(e){injections.push(`MEMORY RECALL — Q: ${q}\nA: (failed: ${e.message})`);}
          }
        }
        const scanTags=[...response.matchAll(/\[TRADE_SCAN(?::\s*([^\]]+))?\]/gi)];
        if(scanTags.length&&!myAbort.signal.aborted){
          toolLabel='◇ reading the market…';
          let syms=scanTags.flatMap(m=>(m[1]||'').split(/[\s,]+/).map(x=>x.trim().toUpperCase()).filter(Boolean));
          syms=[...new Set(syms.length?syms:['XAUUSD'])].slice(0,4);
          for(const sym of syms){
            if(myAbort.signal.aborted)break;
            try{injections.push(`MARKET SNAPSHOT ${sym}:\n`+tlFormatSnapshot(await tlSnapshot(sym)));}
            catch(e){injections.push(`MARKET SNAPSHOT ${sym}: failed — `+e.message);}
          }
          try{await reconcileOpenTrades();injections.push(await atlasJournalBlock());}
          catch(e){/* journal is best-effort — never block a scan */}
        }
        if(/\[BUILD_STATUS\]/i.test(response)&&!myAbort.signal.aborted){
          try{
            const jobs=await getBuildJobs(20);
            injections.push(jobs.length
              ?'BUILD JOBS:\n'+jobs.map(j=>`  #${j.issue_number} [${j.state}] ${j.title||j.spec?.slice(0,60)||''}${j.pr_number?` · PR #${j.pr_number}`:''}${j.state==='question'&&j.question?`\n     Claude Code asked: ${j.question.slice(0,300)}`:''}`).join('\n')
              :'BUILD JOBS: none filed yet.');
          }catch(e){injections.push('BUILD STATUS: failed — '+e.message);}
        }
        if(/\[EXPENSE_SUMMARY\]/i.test(response)){
          try{const es=await getExpenseSummary();injections.push(`EXPENSES ${es.month} — total ${es.total.toFixed(2)}:\n${es.byCategory.map(c=>`  ${c.category}: ${c.total.toFixed(2)} (${c.n})`).join('\n')||'  (none logged)'}`);}
          catch(e){injections.push('EXPENSE SUMMARY: failed — '+e.message);}
        }
        const sw=[...response.matchAll(/\[SEARCH_WEB:\s*([^\]]+)\]/gi)].map(x=>x[1].trim()).filter(Boolean);
        if(sw.length&&!myAbort.signal.aborted){
          toolLabel='◇ searching…';
          for(const q of sw.slice(0,2)){
            try{injections.push(`WEB SEARCH — "${q}":\n${await webSearch(pid,q,myAbort.signal)}`);}
            catch(e){injections.push(`WEB SEARCH — "${q}": (failed: ${e.message})`);}
          }
        }
        try{
          const gReads=await googleReadInjections(response);
          if(gReads.length){toolLabel='◇ checking Google…';injections.push(...gReads);}
        }catch(e){/* never let a Google read break the turn */}
        const cmdCallbacks={
          onRelay:({target,message})=>addRelay(target,`[From ${p.name}]: ${message}`),
          onTradePropose:(prop)=>setTradeProposal({...prop,pid}),
          onTradeClose:(id)=>closePosition(id),
          onStrategyUpdate:(text)=>{setStrategy(text).then(()=>pushSystemMsg('— A.T.L.A.S. updated her strategy —')).catch(()=>{});},
          onTradeReview:({id,note})=>{setTradeReview(id,note).catch(()=>{});},
          onDeepResearch:(topic)=>startDeepResearch(topic,pid),
          onShowChart:(raw)=>{const spec=parseChartSpec(raw);if(spec.valid){setChartOverlay(spec);setView('viz');}},
          onShowDiagram:()=>navigation.navigate('Laboratory'),
          onBuildRequest:({spec})=>confirmBuildRequest(spec),
          onBuildReply:({issueNumber,text})=>sendBuildReply(issueNumber,text),
          onBuildMerge:({issueNumber})=>confirmBuildMerge(issueNumber),
          onBuildCancel:({issueNumber})=>confirmBuildCancel(issueNumber),
        };
        if(injections.length&&!myAbort.signal.aborted){
          await handleCommands(response,pid,cmdCallbacks);
          patch(m=>({...m,content:toolLabel,revealed:toolLabel.length,streaming:false}));
          vizRef.speaking=true;
          const hist2=[...hist,{role:'assistant',content:response},{role:'user',content:`[TOOL RESULTS — answer my previous message using this. Do not mention the lookup mechanism.\n\n${injections.join('\n\n---\n\n')}\n]`}];
          raw='';lastPatch=0;
          patch(m=>({...m,content:'',revealed:0,streaming:!willVoice}));
          response=await callPersona(pid,hist2,myAbort.signal,willVoice?null:onDelta,{skipSave:true,...voiceModelOpts(p)});
          savePersonaMemory(pid,`YOU: ${text}\n${p.name}: ${stripCommands(response)||response}`).catch(()=>{});
        }
        const display=stripCommands(response)||response;
        if(display)replies.push({name:p.name,text:display});
        await handleCommands(response,pid,cmdCallbacks);
        try{
          const gw=await googleWriteCommands(response,{onConfirm:queueGoogleAction});
          for(const line of gw.immediate)pushSystemMsg(line);
        }catch(e){pushSystemMsg('Google action failed: '+e.message);}
        if(willVoice){
          patch(m=>({...m,content:display,revealed:0,streaming:true}));
          if(streamVoice)await streamSpeak(display,p,patch);
          else await speakWithReveal(display,p,msgId,isGroup);
          // The spoken helpers only drive the reveal animation — the reply text
          // is always the full `display`. Settle the bubble on it regardless of
          // how the reveal ended, unless the user has moved on.
          if(!myAbort.signal.aborted){
            patch(m=>({...m,content:display,revealed:display.length,streaming:false}));
            if(!isGroup)await saveMessage(pid,'assistant',display,'direct');
          }
        }else{
          vizRef.speaking=false;vizRef.amplitude=0;
          patch(m=>({...m,content:display,revealed:display.length,streaming:false}));
          if(!isGroup)await saveMessage(pid,'assistant',display,'direct');
        }
        if(myAbort.signal.aborted)break;
      }
    }catch(e){
      if(e.name!=='AbortError'){
        const err={id:Date.now().toString(),role:'system',content:`Error: ${e.message}`,persona:'system'};
        if(isGroup)setGroupMessages(prev=>[...prev,err]);else setMessages(prev=>[...prev,err]);
      }
      if(!streamSpeakActiveRef.current)clearSound();
      maybeAutoListen();
    }finally{
      if(abortRef.current===myAbort)setLoading(false);
      // Freeze any bubble left mid-stream by an abort/error so its caret stops.
      const freeze=(m)=>m.streaming?{...m,streaming:false,revealed:(m.content||'').length}:m;
      setMessages(prev=>prev.map(freeze));setGroupMessages(prev=>prev.map(freeze));
      vizRef.speaking=false;vizRef.amplitude=0;
      setTimeout(()=>flatRef.current?.scrollToEnd({animated:true}),100);
    }
    if(contRef.current&&abortRef.current===myAbort&&!myAbort.signal.aborted)setTimeout(()=>{if(contRef.current)runRound('[Continue. Be brief.]',true);},1200);
  }

  function pushSystemMsg(content){
    const msg={id:Date.now().toString()+Math.random().toString(36).slice(2,5),role:'system',content,persona:'system'};
    if(mode==='direct')setMessages(prev=>[...prev,msg]);else setGroupMessages(prev=>[...prev,msg]);
  }
  // A persona proposed a Google action that needs a confirm tap (send email,
  // delete). One card at a time; extras queue.
  function queueGoogleAction(a){
    if(googleActionRef.current){googleQueueRef.current.push(a);return;}
    googleActionRef.current=a;setGoogleAction(a);
  }
  function advanceGoogle(){
    const next=googleQueueRef.current.shift()||null;
    googleActionRef.current=next;setGoogleAction(next);
  }
  async function runGoogleAction(){
    const a=googleActionRef.current;
    if(!a)return;
    setGoogleBusy(true);
    try{const r=await a.run();pushSystemMsg(typeof r==='string'?r:`— ${a.label} done —`);}
    catch(e){pushSystemMsg(`⚠️ ${a.label} failed: ${e.message}`);}
    finally{setGoogleBusy(false);advanceGoogle();}
  }
  function cancelGoogleAction(){
    const label=googleActionRef.current?.label||'Action';
    pushSystemMsg(`— ${label} cancelled —`);
    advanceGoogle();
  }
  async function closePosition(id){
    try{
      if(String(id).toLowerCase()==='all'){
        const ps=await tlPositions();
        for(const pos of ps)await tlClosePosition(pos.id);
        pushSystemMsg(`— CLOSE ORDER SENT · ${ps.length} position(s) —`);
      }else{
        await tlClosePosition(id);
        pushSystemMsg(`— CLOSE ORDER SENT · position ${id} —`);
      }
    }catch(e){pushSystemMsg(`Close failed: ${e.message}`);}
    setTimeout(()=>reconcileOpenTrades().catch(()=>{}),4000);
  }
  function startDeepResearch(topic,pid){
    if(deepResearch){pushSystemMsg('Deep research is already running — one at a time.');return;}
    const persona=pid||activePersona;
    const go=async()=>{
      try{
        const row=await drStart({topic,persona,mode});
        setDeepResearch(row);
        pushSystemMsg(`— DEEP RESEARCH STARTED · ${getPersona(persona).name} · ${topic} —`);
      }catch(e){pushSystemMsg(`Deep research failed to start: ${e.message}`);}
    };
    getSetting('deep_research_confirm','1').then(v=>{
      if(v==='1'){
        Alert.alert('Deep Research',`Run deep research on:\n\n"${topic}"\n\nThis takes several minutes and bills to your OpenAI key.`,[
          {text:'Cancel',style:'cancel'},
          {text:'Run',onPress:go},
        ]);
      }else go();
    });
  }
  // Resume a job that was still running when the app was last closed.
  useEffect(()=>{
    let cancelled=false;
    drGetActive().then(row=>{
      if(cancelled||!row)return;
      if(row.status==='failed'){pushSystemMsg(`Deep research ${row.error?`failed: ${row.error}`:'timed out'}.`);return;}
      setDeepResearch(row);
    }).catch(()=>{});
    return()=>{cancelled=true;};
  },[]);// eslint-disable-line react-hooks/exhaustive-deps
  // Poll the active job; deliver the result into the starting persona's chat.
  useEffect(()=>{
    if(!deepResearch?.id||deepResearch.status!=='running')return;
    let stop=false;
    const tick=async()=>{
      if(stop)return;
      const{row,done,outcome,alreadyHandled}=await drTick(deepResearch);
      if(stop)return;
      if(!done){setDeepResearch(r=>r&&r.id===row.id?{...r,progressObj:row.progressObj}:r);return;}
      setDeepResearch(null);
      if(alreadyHandled)return; // a prior poll already delivered this one
      const name=getPersona(row.persona).name;
      if(outcome==='completed'){
        if(mode==='direct'&&activePersona===row.persona){
          setMessages(prev=>[...prev,{id:Date.now().toString(),role:'assistant',content:row.result,persona:row.persona,revealed:row.result.length,streaming:false}]);
        }else{
          pushSystemMsg(`— ${name} finished deep research on "${row.topic}" — open ${name}'s chat to read it —`);
        }
      }else if(outcome==='cancelled'){
        pushSystemMsg('Deep research was cancelled.');
      }else{
        pushSystemMsg('Deep research failed'+(row.error?`: ${row.error}`:'')+'.');
      }
    };
    const iv=setInterval(tick,DR_POLL_MS);tick();
    return()=>{stop=true;clearInterval(iv);};
  },[deepResearch?.id,deepResearch?.status,activePersona,mode]);// eslint-disable-line react-hooks/exhaustive-deps
  function dismissDeepResearch(){
    if(!deepResearch)return;
    drDismiss(deepResearch.id);
    setDeepResearch(null);
    pushSystemMsg('Deep research dismissed — it keeps running on OpenAI but the app has stopped tracking it.');
  }

  // --- JARVIS build pipeline ---
  function confirmBuildRequest(spec){
    const preview=spec.length>1000?spec.slice(0,1000)+'…':spec;
    Alert.alert('File this build request?',`Claude Code will implement it and open a pull request. This bills your Anthropic key.\n\n${preview}`,[
      {text:'Cancel',style:'cancel'},
      {text:'File it',onPress:async()=>{
        try{
          const{issueNumber,title}=await fileBuildRequest(spec);
          await addBuildJob({issueNumber,spec,title});
          pushSystemMsg(`— BUILD REQUEST FILED · #${issueNumber} — Claude Code is picking it up.`);
        }catch(e){pushSystemMsg(`Couldn't file the build request: ${e.message}`);}
      }},
    ]);
  }
  async function sendBuildReply(issueNumber,text){
    try{
      await replyToBuild(issueNumber,text);
      await updateBuildJob(issueNumber,{state:'working',question:null});
      pushSystemMsg(`— Sent to Claude Code on #${issueNumber}: "${text}" —`);
    }catch(e){pushSystemMsg(`Couldn't send that to Claude Code: ${e.message}`);}
  }
  function confirmBuildMerge(issueNumber){
    (async()=>{
      const job=await getBuildJob(issueNumber);
      if(!job?.pr_number){pushSystemMsg(`No pull request on #${issueNumber} yet.`);return;}
      Alert.alert('Merge and ship?',`Merge PR #${job.pr_number} into main. This pushes to main and starts an APK build.`,[
        {text:'Cancel',style:'cancel'},
        {text:'Merge',onPress:async()=>{
          try{
            await updateBuildJob(issueNumber,{state:'merging'});
            await mergeBuild(job.pr_number);
            await updateBuildJob(issueNumber,{state:'pushed'});
            pushSystemMsg(`— MERGED & PUSHED · PR #${job.pr_number} · APK build started —`);
          }catch(e){
            await updateBuildJob(issueNumber,{state:'pr_open'});
            pushSystemMsg(`Merge failed: ${e.message}`);
          }
        }},
      ]);
    })();
  }
  function confirmBuildCancel(issueNumber){
    (async()=>{
      const job=await getBuildJob(issueNumber);
      Alert.alert('Abandon this request?',`Close issue #${issueNumber}${job?.pr_number?` and PR #${job.pr_number}`:''}.`,[
        {text:'Keep',style:'cancel'},
        {text:'Abandon',style:'destructive',onPress:async()=>{
          try{await cancelBuild(issueNumber,job?.pr_number);}catch{}
          await updateBuildJob(issueNumber,{state:'cancelled'});
          pushSystemMsg(`— Build request #${issueNumber} abandoned —`);
        }},
      ]);
    })();
  }
  useEffect(()=>{
    if(!isFocused)return;
    let stop=false;
    const tick=async()=>{
      if(stop)return;
      try{
        const events=await pollBuildJobs();
        if(stop||!events.length)return;
        for(const ev of events){
          const n=ev.job.issue_number;
          if(ev.type==='question')pushSystemMsg(`— Claude Code is asking about #${n} —\n${ev.text}`);
          else if(ev.type==='pr_open')pushSystemMsg(`— PR #${ev.job.pr_number} ready on #${n}: ${ev.text} — tell JARVIS to ship it, or open the Build panel.`);
          else if(ev.type==='pushed')pushSystemMsg(`— #${n} MERGED & PUSHED — APK build started.`);
          else if(ev.type==='failed')pushSystemMsg(`— #${n}: ${ev.text} —`);
        }
      }catch{/* keep polling */}
    };
    const iv=setInterval(tick,15000);tick();
    return()=>{stop=true;clearInterval(iv);};
  },[isFocused]);// eslint-disable-line react-hooks/exhaustive-deps

  async function confirmTrade(){
    if(!tradeProposal||tradeBusy)return;
    setTradeBusy(true);
    const{symbol,side,stopLoss,takeProfit,qty,pid}=tradeProposal;
    const sym=symbol||'XAUUSD';
    try{
      const r=await tlPlaceOrder({symbol:sym,side,qty:Math.min(qty||MAX_QTY,MAX_QTY),stopLoss,takeProfit});
      pushSystemMsg(`— ORDER SENT · ${r.side.toUpperCase()} ${r.qty} ${sym} · SL ${r.stopLoss??'—'} · TP ${r.takeProfit??'—'} · #${r.orderId||'?'} —`);
      savePersonaMemory(pid||'atlas',`YOU: [confirmed trade]\nA.T.L.A.S.: order sent ${r.side} ${r.qty} ${sym} SL ${r.stopLoss} TP ${r.takeProfit}`).catch(()=>{});
      recordTradeOpen({symbol:sym,side:r.side,qty:r.qty,entry:tradeProposal.entry,stopLoss,takeProfit,rationale:tradeProposal.rationale,orderId:r.orderId}).catch(()=>{});
      setTimeout(()=>reconcileOpenTrades().catch(()=>{}),6000);
    }catch(e){pushSystemMsg(`Order failed: ${e.message}`);}
    finally{setTradeBusy(false);setTradeProposal(null);}
  }

  function interject(){
    abortRef.current?.abort();setContinuous(false);contRef.current=false;stopAudio();setLoading(false);
    setGroupMessages(prev=>[...prev,{id:Date.now().toString(),role:'system',content:'— YOU HAVE THE FLOOR —',persona:'system'}]);
  }

  function renderMsg({item}){
    const p=item.persona&&item.persona!=='user'&&item.persona!=='system'?getPersona(item.persona):null;
    if(item.role==='user')return(
      <View>
        {item.image&&<Image source={{uri:item.image}} style={{width:200,height:150,borderRadius:8,marginBottom:4,alignSelf:'flex-end'}}/>}
        <View style={s.userBubble}><Text style={s.userText}>{item.content}</Text></View>
      </View>
    );
    if(item.role==='system')return(<View style={s.sysBubble}><Text style={s.sysText}>{item.content}</Text></View>);
    const pic=personaPics[p?.id];
    const shown=item.streaming?String(item.content||'').slice(0,item.revealed||0):item.content;
    return(
      <View style={s.aiBubble}>
        <View style={s.aiHeader}>
          <View style={[s.aiAvatar,{borderColor:p?.color||'#E8C98A'}]}>
            {pic?<Image source={{uri:pic}} style={s.aiAvatarImg}/>:<Text style={[s.aiAvatarText,{color:p?.color||'#E8C98A'}]}>{p?.icon||'?'}</Text>}
          </View>
          <View style={{flex:1}}>
            <Text style={[s.aiName,{color:p?.color||'#E8C98A'}]}>{p?.name||'SYSTEM'}</Text>
            <Text style={s.aiRole}>{p?.role||''}</Text>
          </View>
          {!item.streaming&&<TouchableOpacity style={s.replayBtn} onPress={()=>speakResponse(item.content,p||{})}>
            <Text style={s.replayBtnT}>↻ REPLAY</Text>
          </TouchableOpacity>}
        </View>
        <View style={[s.aiDivider,{backgroundColor:p?.color||'#E8C98A'}]}/>
        <Text style={s.aiText}>{shown}{item.streaming&&<Text style={[s.caret,{color:p?.color||'#E8C98A'}]}>▍</Text>}</Text>
      </View>
    );
  }

  const cp=getPersona(activePersona);
  const displayMessages=mode==='direct'?messages:groupMessages;

  if(showCamera){
    return(
      <View style={{flex:1,backgroundColor:'#000'}}>
        <Camera style={{flex:1}} ref={ref=>setCameraRef(ref)}>
          <View style={{flex:1,justifyContent:'flex-end',padding:20}}>
            <View style={{flexDirection:'row',justifyContent:'space-between',alignItems:'center'}}>
              <TouchableOpacity onPress={()=>setShowCamera(false)} style={{padding:12,backgroundColor:'rgba(0,0,0,0.6)',borderRadius:8}}>
                <Text style={{color:'#FFF',fontFamily:'monospace',fontSize:12}}>CANCEL</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={takePicture} style={{width:60,height:60,borderRadius:30,backgroundColor:'#E8C98A',alignItems:'center',justifyContent:'center'}}>
                <Text style={{fontSize:24}}>📷</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Camera>
      </View>
    );
  }

  return(
    <SafeAreaView style={s.container} edges={['top','bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={goToCity} hitSlop={{top:10,bottom:10,left:10,right:10}}>
          <Text style={s.empireOS}>‹ EMPIRE OS</Text>
        </TouchableOpacity>
        <View style={s.headerRight}>
          <View style={s.viewToggle}>
            {[['viz','◉'],['text','≣']].map(([v,ic])=>(
              <TouchableOpacity key={v} style={[s.viewTab,view===v&&{backgroundColor:cp.color+'22',borderColor:cp.color}]} onPress={()=>setView(v)}>
                <Text style={[s.viewTabT,view===v&&{color:cp.color}]}>{ic}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.onlinePill}><View style={s.onlineDot}/><Text style={s.onlineText}>ONLINE</Text></View>
        </View>
      </View>

      <NudgeBar active={isFocused}/>

      {view==='text'&&<View style={s.teamPanel}>
        <Image source={TEAM_PHOTO} style={s.teamPhoto} resizeMode="cover"/>
      </View>}

      {mode==='custom'&&(
        <View style={s.groupCtl}>
          <Text style={s.groupCtlLabel} numberOfLines={1}>GROUP · {customPersonas.length}</Text>
          <TouchableOpacity style={[s.modeBtn,continuous&&{borderColor:'#4CAF50',backgroundColor:'#4CAF5011'}]} onPress={()=>setContinuous(v=>!v)}>
            <Text style={[s.modeBtnT,continuous&&{color:'#4CAF50'}]}>⟳ LIVE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.modeBtn,{borderColor:'#E0555533'}]} onPress={interject}>
            <Text style={[s.modeBtnT,{color:'#E05555'}]}>✋ INTERJECT</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.modeBtn,{borderColor:'#1A1A1A'}]} onPress={()=>{setMode('direct');setContinuous(false);contRef.current=false;}}>
            <Text style={s.modeBtnT}>✕ END</Text>
          </TouchableOpacity>
        </View>
      )}

      {mode==='direct'&&activePersona==='atlas'&&<TradeStatus active={isFocused} style={{marginHorizontal:10,marginTop:6}}/>}
      {mode==='direct'&&activePersona==='atlas'&&<TradeRecordBar active={isFocused} style={{marginHorizontal:10,marginTop:6}}/>}
      {mode==='direct'&&activePersona==='atlas'&&<TradePanel active={isFocused} onEvent={pushSystemMsg}/>}
      {mode==='direct'&&activePersona==='jarvis'&&<BuildPanel active={isFocused} onMerge={confirmBuildMerge} onCancel={confirmBuildCancel}/>}

      <DeepResearchBanner job={deepResearch} onDismiss={dismissDeepResearch}/>

      {view==='viz'?(
        chartOverlay?(
          <ChartOverlay spec={chartOverlay} accent={cp.color} onClose={()=>setChartOverlay(null)}/>
        ):(
        <OrbZoom
          personaId={activePersona}
          color={cp.color}
          active={isFocused}
          vizRef={vizRef}
          personaPics={personaPics}
          level={orbLevel}
          onLevelChange={setOrbLevel}
          onPickPersona={pickPersonaFromOrb}
          onLaunchGroup={launchGroupFromOrb}
          onZoomOut={goToCity}
        />
        )
      ):(
        <FlatList ref={flatRef} data={displayMessages} keyExtractor={i=>i.id} renderItem={renderMsg} contentContainerStyle={s.msgList} style={{flex:1}} onContentSizeChange={()=>flatRef.current?.scrollToEnd({animated:true})}/>
      )}

      {loading&&(<View style={s.thinking}>
        <ActivityIndicator size="small" color={mode==='direct'?cp.color:'#E8C98A'}/>
        <Text style={[s.thinkT,{color:mode==='direct'?cp.color:'#E8C98A'}]}>{mode==='direct'?`${cp.name} is responding...`:'Council speaking...'}</Text>
      </View>)}

      {recording&&(<View style={s.thinking}>
        <View style={[s.iactDot,{backgroundColor:'#E05555'}]}/>
        <Text style={[s.thinkT,{color:'#E05555'}]}>Listening...</Text>
      </View>)}

      <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':'height'}>
        <View style={s.inputArea}>
          <View style={s.inputRow}>
            <TextInput ref={textInputRef} style={s.input} defaultValue="" onChangeText={t=>{inputRef.current=t;setInput(t);}} placeholder="Speak your directive..." placeholderTextColor="#333" multiline maxLength={2000} autoCorrect={false} autoComplete="off" autoCapitalize="sentences" spellCheck={false}/>
            <TouchableOpacity style={[s.sendBtn,{backgroundColor:mode==='direct'?cp.color:'#E8C98A'}]} onPress={send} disabled={loading||!input.trim()}>
              <Text style={s.sendT}>SEND</Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.inputActions}>
            <TouchableOpacity style={[s.iact,recording&&{borderColor:'#E05555',backgroundColor:'#E0555511'}]} onPress={()=>recording?stopRecording():startRecording({manual:true})}>
              <View style={[s.iactDot,recording&&{backgroundColor:'#E05555'}]}/>
              <Text style={[s.iactT,recording&&{color:'#E05555'}]}>{recording?'STOP REC':'SPEAK'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.iact,handsFree&&{borderColor:'#4CAF50',backgroundColor:'#4CAF5011'}]} onPress={toggleHandsFree}>
              <View style={[s.iactDot,handsFree&&{backgroundColor:'#4CAF50'}]}/>
              <Text style={[s.iactT,handsFree&&{color:'#4CAF50'}]}>{handsFree?'AUTO ON':'AUTO OFF'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.iact,voiceOn&&!voiceMuted&&{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'}]} onPress={()=>{if(voiceOn)stopAudio();setVoiceOn(v=>!v);setVoicePaused(false);}}>
              <View style={[s.iactDot,voiceOn&&!voiceMuted&&{backgroundColor:'#E8C98A'}]}/>
              <Text style={[s.iactT,voiceOn&&!voiceMuted&&{color:'#E8C98A'}]}>{voiceOn?'VOICE ON':'VOICE OFF'}</Text>
            </TouchableOpacity>
            {voiceOn&&<>
              <TouchableOpacity style={[s.iact,voicePaused&&{borderColor:'#FFB300',backgroundColor:'#FFB30011'}]} onPress={()=>{voicePaused?resumeAudio():pauseAudio();}}>
                <View style={[s.iactDot,voicePaused&&{backgroundColor:'#FFB300'}]}/>
                <Text style={[s.iactT,voicePaused&&{color:'#FFB300'}]}>{voicePaused?'RESUME':'PAUSE'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.iact,voiceMuted&&{borderColor:'#E05555',backgroundColor:'#E0555511'}]} onPress={()=>{setVoiceMuted(v=>!v);if(!voiceMuted)stopAudio();}}>
                <View style={[s.iactDot,voiceMuted&&{backgroundColor:'#E05555'}]}/>
                <Text style={[s.iactT,voiceMuted&&{color:'#E05555'}]}>{voiceMuted?'MUTED':'MUTE'}</Text>
              </TouchableOpacity>
            </>}
            {loading&&<TouchableOpacity style={[s.iact,{borderColor:'#E05555'}]} onPress={()=>{abortRef.current?.abort();stopAudio();setLoading(false);}}>
              <View style={[s.iactDot,{backgroundColor:'#E05555'}]}/>
              <Text style={[s.iactT,{color:'#E05555'}]}>STOP</Text>
            </TouchableOpacity>}
            <TouchableOpacity style={s.iact} onPress={pickImage}>
              <View style={s.iactDot}/><Text style={s.iactT}>IMAGE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.iact} onPress={pickDocument}>
              <View style={s.iactDot}/><Text style={s.iactT}>DOCUMENT</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.iact} onPress={openCamera}>
              <View style={s.iactDot}/><Text style={s.iactT}>CAMERA</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={showCustomPicker} transparent animationType="slide">
        <View style={s.modalOver}><View style={s.modalContent}>
          <Text style={s.modalTitle}>SELECT YOUR TEAM</Text>
          <Text style={s.modalSub}>Choose 2 or more personas</Text>
          <ScrollView style={{maxHeight:350}}>
            {PERSONA_LIST.map(p=>{const sel=selectedCustom.includes(p.id);const pic=personaPics[p.id];return(
              <TouchableOpacity key={p.id} style={[s.pItem,sel&&{borderColor:p.color}]} onPress={()=>setSelectedCustom(prev=>prev.includes(p.id)?prev.filter(id=>id!==p.id):[...prev,p.id])}>
                <View style={[s.pCheck,sel&&{backgroundColor:p.color}]}>{sel&&<Text style={{fontSize:10,color:'#000',fontWeight:'700'}}>✓</Text>}</View>
                <View style={[s.pPickerAvatar,{borderColor:p.color}]}>
                  {pic?<Image source={{uri:pic}} style={{width:'100%',height:'100%',borderRadius:14}}/>:<Text style={{fontFamily:'monospace',fontSize:8,fontWeight:'700',color:p.color}}>{p.icon}</Text>}
                </View>
                <Text style={[s.pName,{color:p.color}]}>{p.name}</Text>
                <Text style={s.pRole}>{p.role}</Text>
              </TouchableOpacity>
            );})}
          </ScrollView>
          <View style={{flexDirection:'row',gap:10,marginTop:16}}>
            <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#E8C98A'}]} onPress={()=>{if(selectedCustom.length>=2){setCustomPersonas(selectedCustom);setMode('custom');setShowCustomPicker(false);}}}>
              <Text style={[s.modalBtnT,{color:'#000'}]}>LAUNCH</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={()=>setShowCustomPicker(false)}>
              <Text style={[s.modalBtnT,{color:'#555'}]}>CANCEL</Text>
            </TouchableOpacity>
          </View>
        </View></View>
      </Modal>

      <Modal visible={!!googleAction} transparent animationType="fade" onRequestClose={cancelGoogleAction}>
        <View style={s.modalOver}><View style={s.tradeCard}>
          <Text style={s.tradeTitle}>{(googleAction?.label||'').toUpperCase()}</Text>
          {googleAction&&<>
            <Text style={[s.tradeNote,{fontSize:11,color:'#AAA',lineHeight:16}]}>{googleAction.detail}</Text>
            <View style={{flexDirection:'row',gap:10,marginTop:16}}>
              <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#00CED1'}]} disabled={googleBusy} onPress={runGoogleAction}>
                <Text style={[s.modalBtnT,{color:'#000'}]}>{googleBusy?'WORKING…':'CONFIRM'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={cancelGoogleAction}>
                <Text style={[s.modalBtnT,{color:'#555'}]}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          </>}
        </View></View>
      </Modal>

      <Modal visible={!!tradeProposal} transparent animationType="fade" onRequestClose={()=>setTradeProposal(null)}>
        <View style={s.modalOver}><View style={s.tradeCard}>
          <Text style={s.tradeTitle}>CONFIRM TRADE · {tradeProposal?.symbol||'XAUUSD'}</Text>
          {tradeProposal&&<>
            <View style={[s.tradeSideChip,{backgroundColor:(tradeProposal.side==='buy'?'#5FA779':'#C7614B')+'22',borderColor:tradeProposal.side==='buy'?'#5FA779':'#C7614B'}]}>
              <Text style={[s.tradeSideT,{color:tradeProposal.side==='buy'?'#5FA779':'#C7614B'}]}>{tradeProposal.side==='buy'?'▲ BUY':'▼ SELL'} {Math.min(tradeProposal.qty||MAX_QTY,MAX_QTY)} LOT</Text>
            </View>
            <View style={s.tradeRow}><Text style={s.tradeK}>Entry (ref)</Text><Text style={s.tradeV}>{tradeProposal.entry??'market'}</Text></View>
            <View style={s.tradeRow}><Text style={s.tradeK}>Stop loss</Text><Text style={[s.tradeV,{color:'#C7614B'}]}>{tradeProposal.stopLoss??'—'}</Text></View>
            <View style={s.tradeRow}><Text style={s.tradeK}>Take profit</Text><Text style={[s.tradeV,{color:'#5FA779'}]}>{tradeProposal.takeProfit??'—'}</Text></View>
            {!!tradeProposal.rationale&&<Text style={s.tradeRationale}>{tradeProposal.rationale}</Text>}
            <Text style={s.tradeNote}>Sends a market order now — fill may differ from the reference entry.</Text>
            <View style={{flexDirection:'row',gap:10,marginTop:16}}>
              <TouchableOpacity style={[s.modalBtn,{backgroundColor:tradeProposal.side==='buy'?'#5FA779':'#C7614B'}]} disabled={tradeBusy} onPress={confirmTrade}>
                <Text style={[s.modalBtnT,{color:'#000'}]}>{tradeBusy?'SENDING…':'CONFIRM & SEND'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={()=>setTradeProposal(null)}>
                <Text style={[s.modalBtnT,{color:'#555'}]}>CANCEL</Text>
              </TouchableOpacity>
            </View>
          </>}
        </View></View>
      </Modal>
    </SafeAreaView>
  );
}

const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:16,paddingVertical:8,borderBottomWidth:1,borderBottomColor:'#111'},
  empireOS:{fontFamily:'monospace',fontSize:14,fontWeight:'700',color:'#E8C98A',letterSpacing:2},
  onlinePill:{flexDirection:'row',alignItems:'center',gap:5,borderWidth:1,borderColor:'#4CAF5055',borderRadius:12,paddingHorizontal:8,paddingVertical:3},
  headerRight:{flexDirection:'row',alignItems:'center',gap:8},
  viewToggle:{flexDirection:'row',gap:4},
  viewTab:{width:26,height:22,borderRadius:5,borderWidth:1,borderColor:'#222',alignItems:'center',justifyContent:'center'},
  viewTabT:{fontFamily:'monospace',fontSize:11,color:'#444'},
  onlineDot:{width:6,height:6,borderRadius:3,backgroundColor:'#4CAF50'},
  onlineText:{fontFamily:'monospace',fontSize:8,color:'#4CAF50',letterSpacing:2},
  teamPanel:{marginHorizontal:14,marginTop:6,marginBottom:4,borderWidth:1,borderColor:'#1A1A1A',borderRadius:6,overflow:'hidden'},
  teamLabels:{flexDirection:'row',justifyContent:'space-between',paddingHorizontal:10,paddingVertical:6},
  teamLabel:{fontFamily:'monospace',fontSize:7,color:'#555',letterSpacing:3},
  councilLabel:{fontFamily:'monospace',fontSize:7,color:'#E8C98A',letterSpacing:3},
  teamPhoto:{width:'100%',height:90},
  councilRow:{flexDirection:'row',paddingHorizontal:14,marginBottom:2,gap:4},
  ctab:{flex:1,alignItems:'center',paddingVertical:5,paddingBottom:8},
  ctabAvatar:{width:30,height:30,borderRadius:15,borderWidth:1.5,alignItems:'center',justifyContent:'center',marginBottom:3,overflow:'hidden'},
  ctabAvatarImg:{width:'100%',height:'100%'},
  ctabIcon:{fontFamily:'monospace',fontSize:10,fontWeight:'700'},
  ctabName:{fontFamily:'monospace',fontSize:7,letterSpacing:1},
  specLabel:{fontFamily:'monospace',fontSize:7,color:'#333',letterSpacing:3,paddingHorizontal:14,marginBottom:2},
  specsScroll:{maxHeight:54},
  specialistsRow:{paddingHorizontal:12,gap:6,flexDirection:'row',paddingBottom:4},
  stab:{alignItems:'center',paddingHorizontal:6,paddingBottom:6},
  stabAvatar:{width:24,height:24,borderRadius:12,borderWidth:1.5,alignItems:'center',justifyContent:'center',marginBottom:2,overflow:'hidden'},
  stabAvatarImg:{width:'100%',height:'100%'},
  stabIcon:{fontFamily:'monospace',fontSize:7,fontWeight:'700'},
  stabName:{fontFamily:'monospace',fontSize:6,letterSpacing:1},
  modeBarScroll:{borderTopWidth:1,borderTopColor:'#0D0D0D',maxHeight:34},
  modeBar:{paddingHorizontal:10,paddingVertical:5,gap:4,flexDirection:'row'},
  modeBtn:{paddingHorizontal:10,paddingVertical:4,borderRadius:4,borderWidth:1,borderColor:'#1A1A1A'},
  modeBtnT:{fontFamily:'monospace',fontSize:8,color:'#444',letterSpacing:1},
  groupCtl:{flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:12,paddingVertical:6,borderTopWidth:1,borderTopColor:'#0D0D0D',borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  groupCtlLabel:{fontFamily:'monospace',fontSize:8,color:'#E8C98A',letterSpacing:2,flex:1},
  memBar:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:14,paddingVertical:4,borderTopWidth:1,borderTopColor:'#0A0A0A'},
  memLabel:{fontFamily:'monospace',fontSize:7,color:'#555',letterSpacing:2},
  memStatus:{fontFamily:'monospace',fontSize:7,color:'#333',flex:1},
  msgList:{padding:10,gap:10,paddingBottom:4},
  userBubble:{alignSelf:'flex-end',backgroundColor:'#111',borderRadius:14,borderBottomRightRadius:4,padding:12,maxWidth:'82%',borderWidth:1,borderColor:'#1A1A1A'},
  userText:{color:'#DDD',fontSize:14,lineHeight:21},
  aiBubble:{alignSelf:'flex-start',backgroundColor:'#080808',borderRadius:10,padding:12,maxWidth:'96%',borderWidth:1,borderColor:'#111'},
  aiHeader:{flexDirection:'row',alignItems:'center',gap:8,marginBottom:6},
  aiAvatar:{width:30,height:30,borderRadius:15,borderWidth:1.5,alignItems:'center',justifyContent:'center',overflow:'hidden'},
  aiAvatarImg:{width:'100%',height:'100%'},
  aiAvatarText:{fontFamily:'monospace',fontSize:9,fontWeight:'700'},
  aiName:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:1},
  aiRole:{fontFamily:'monospace',fontSize:7,color:'#333',letterSpacing:1,marginTop:1},
  replayBtn:{paddingHorizontal:8,paddingVertical:3,borderWidth:1,borderColor:'#1A1A1A',borderRadius:4},
  replayBtnT:{fontFamily:'monospace',fontSize:7,color:'#444',letterSpacing:1},
  aiDivider:{height:1,marginBottom:8,opacity:0.3},
  aiText:{color:'#CCC',fontSize:14,lineHeight:21},
  caret:{opacity:0.7},
  sysBubble:{alignSelf:'center',backgroundColor:'#0A0A0A',borderRadius:6,padding:6},
  sysText:{color:'#333',fontSize:9,fontFamily:'monospace',textAlign:'center',letterSpacing:2},
  thinking:{flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:14,paddingVertical:5},
  thinkT:{fontFamily:'monospace',fontSize:9,letterSpacing:1},
  inputArea:{borderTopWidth:1,borderTopColor:'#111'},
  inputRow:{flexDirection:'row',alignItems:'flex-end',paddingHorizontal:10,paddingTop:8,paddingBottom:4,gap:8},
  input:{flex:1,backgroundColor:'#080808',borderWidth:1,borderColor:'#151515',borderRadius:8,paddingHorizontal:12,paddingVertical:9,color:'#DDD',fontSize:14,maxHeight:90},
  sendBtn:{paddingHorizontal:14,paddingVertical:10,borderRadius:8,alignItems:'center',justifyContent:'center'},
  sendT:{fontFamily:'monospace',fontSize:11,color:'#000',fontWeight:'700',letterSpacing:1},
  inputActions:{flexDirection:'row',paddingHorizontal:10,paddingBottom:6,gap:6},
  iact:{flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:8,paddingVertical:4,borderRadius:4,borderWidth:1,borderColor:'#111'},
  iactDot:{width:5,height:5,borderRadius:2.5,backgroundColor:'#E8C98A',opacity:0.5},
  iactT:{fontFamily:'monospace',fontSize:7,color:'#444',letterSpacing:1},
  modalOver:{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'},
  modalContent:{backgroundColor:'#0A0A0A',borderTopWidth:1,borderTopColor:'#1A1A1A',borderTopLeftRadius:16,borderTopRightRadius:16,padding:20},
  modalTitle:{fontFamily:'monospace',fontSize:12,color:'#E8C98A',letterSpacing:3,marginBottom:2},
  modalSub:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:2,marginBottom:14},
  pItem:{flexDirection:'row',alignItems:'center',gap:10,padding:10,marginBottom:6,borderRadius:6,borderWidth:1,borderColor:'#111'},
  pCheck:{width:18,height:18,borderRadius:3,borderWidth:1,borderColor:'#333',alignItems:'center',justifyContent:'center'},
  pPickerAvatar:{width:28,height:28,borderRadius:14,borderWidth:1.5,alignItems:'center',justifyContent:'center',overflow:'hidden'},
  pName:{fontFamily:'monospace',fontSize:9,fontWeight:'700',flex:1},
  pRole:{fontFamily:'monospace',fontSize:7,color:'#333'},
  modalBtn:{flex:1,padding:12,borderRadius:8,alignItems:'center'},
  modalBtnT:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:2},
  tradeCard:{backgroundColor:'#0A0A0A',borderTopWidth:1,borderColor:'#1A1A1A',borderRadius:14,padding:20,margin:16,alignSelf:'stretch'},
  tradeTitle:{fontFamily:'monospace',fontSize:11,color:'#E8C98A',letterSpacing:3,marginBottom:14},
  tradeSideChip:{alignSelf:'flex-start',borderWidth:1,borderRadius:5,paddingHorizontal:10,paddingVertical:5,marginBottom:14},
  tradeSideT:{fontFamily:'monospace',fontSize:11,fontWeight:'700',letterSpacing:1},
  tradeRow:{flexDirection:'row',justifyContent:'space-between',paddingVertical:6,borderBottomWidth:1,borderBottomColor:'#111'},
  tradeK:{fontFamily:'monospace',fontSize:10,color:'#555',letterSpacing:1},
  tradeV:{fontFamily:'monospace',fontSize:12,color:'#DDD',fontWeight:'700'},
  tradeRationale:{fontFamily:'monospace',fontSize:11,color:'#999',lineHeight:17,marginTop:12},
  tradeNote:{fontFamily:'monospace',fontSize:8,color:'#444',marginTop:10,letterSpacing:0.5},
});
