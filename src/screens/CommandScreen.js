import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,FlatList,KeyboardAvoidingView,Platform,ActivityIndicator,ScrollView,Modal,Image,Alert}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{Audio}from 'expo-av';
import*as Speech from 'expo-speech';
import*as ImagePicker from 'expo-image-picker';
import*as DocumentPicker from 'expo-document-picker';
import{Camera}from 'expo-camera';
import*as FileSystem from 'expo-file-system';
import{PERSONAS,PERSONA_LIST,COUNCIL_PERSONAS,EMPIRE_PERSONAS,getPersona}from '../personas/personas';
import{callPersona,textToSpeech,transcribeAudio,queryMemory,webSearch,personaSystemPrompt,deepResearchStart,deepResearchPoll}from '../services/aiService';
import{handleCommands,stripCommands}from '../services/commandHandler';
import{getMessages,saveMessage,getAllPersonaPics,savePersonaMemory,getSetting,getExpenseSummary}from '../services/database';
import{tlSnapshot,tlFormatSnapshot,tlPlaceOrder,tlClosePosition,tlPositions,MAX_QTY}from '../services/tradeLocker';
import{loadKeys}from '../services/keyStore';
import useEmpireStore from '../store/useEmpireStore';
import{useIsFocused}from '@react-navigation/native';
import OrbZoom from './command/OrbZoom';
import ChartOverlay from './command/ChartOverlay';
import TradePanel from './command/TradePanel';
import NudgeBar from './command/NudgeBar';
import{parseChartSpec}from '../services/chartSpec';

const COUNCIL=['jarvis','ara','selene'];
const SPECIALISTS=['stephanie','rogue','atlas','haven','aisha','abraham','batman','ghost'];
const TEAM_PHOTO=require('../../assets/teamphoto.png');
const HANDS_FREE_SILENCE_MS=1500;
const HANDS_FREE_VOICE_DB=-35;
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
  const[tradeProposal,setTradeProposal]=useState(null); // {side,entry,stopLoss,takeProfit,qty,rationale,pid}
  const[tradeBusy,setTradeBusy]=useState(false);
  const[deepResearch,setDeepResearch]=useState(null); // {id,topic,pid,status}
  const[chartOverlay,setChartOverlay]=useState(null); // parsed chart spec shown over the orb
  const vizRef=useRef({speaking:false,amplitude:0,color:'#E8C98A',personaId:'jarvis'}).current;
  const flatRef=useRef(null);
  const abortRef=useRef(null);
  const contRef=useRef(false);
  const soundRef=useRef(null);
  const speakCancelRef=useRef(null); // stops the in-progress voice+text reveal
  const recordingRef=useRef(null);
  const araWsRef=useRef(null);
  const araChunksRef=useRef([]);
  const handsFreeRef=useRef(false);
  const loadingRef=useRef(false);
  const voicePausedRef=useRef(false);
  const silenceTimerRef=useRef(null);
  const hasVoicedRef=useRef(false);
  const{addRelay}=useEmpireStore();
  const isFocused=useIsFocused();

  useEffect(()=>{contRef.current=continuous;},[continuous]);
  useEffect(()=>{handsFreeRef.current=handsFree;},[handsFree]);
  useEffect(()=>{if(!vizRef.speaking){vizRef.personaId=activePersona;vizRef.color=getPersona(activePersona).color;}},[activePersona]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{loadingRef.current=loading;},[loading]);
  useEffect(()=>{voicePausedRef.current=voicePaused;},[voicePaused]);
  useEffect(()=>{if(mode==='direct')loadHistory(activePersona);},[activePersona,mode]);
  useEffect(()=>{
    Audio.setAudioModeAsync({allowsRecordingIOS:true,playsInSilentModeIOS:true});
    loadPics();
    return()=>{
      clearSilenceTimer();
      if(recordingRef.current){try{recordingRef.current.stopAndUnloadAsync();}catch{}}
    };
  },[]);

  async function loadPics(){try{const pics=await getAllPersonaPics();setPersonaPics(pics);}catch{}}

  async function loadHistory(persona){
    const h=await getMessages(persona,40);
    setMessages(h.reverse().map(m=>({id:m.id.toString(),role:m.role,content:m.content,persona:m.persona})));
  }

  function clearSilenceTimer(){
    if(silenceTimerRef.current){clearTimeout(silenceTimerRef.current);silenceTimerRef.current=null;}
  }

  function onRecordingStatus(status){
    if(!status.isRecording||status.metering===undefined)return;
    if(status.metering>HANDS_FREE_VOICE_DB){
      hasVoicedRef.current=true;
      clearSilenceTimer();
    }else if(hasVoicedRef.current){
      if(!silenceTimerRef.current){
        silenceTimerRef.current=setTimeout(()=>{
          silenceTimerRef.current=null;
          if(recordingRef.current)stopRecording();
        },HANDS_FREE_SILENCE_MS);
      }
    }
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
      if(soundRef.current){try{await soundRef.current.stopAsync();await soundRef.current.unloadAsync();}catch{}soundRef.current=null;}
      if(persona.id==='ara'){
        const result=await araGrokVoice(text);
        soundRef.current=result?.sound||null;
        if(soundRef.current)soundRef.current.setOnPlaybackStatusUpdate(st=>{if(st.didJustFinish)maybeAutoListen();});
        else maybeAutoListen();
      }else if(persona.elevenlabsVoiceId){
        const uri=await textToSpeech(text,persona.elevenlabsVoiceId,persona.name);
        if(uri){
          await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});
          const{sound}=await Audio.Sound.createAsync({uri},{shouldPlay:true});
          soundRef.current=sound;
          sound.setOnPlaybackStatusUpdate(st=>{if(st.didJustFinish)maybeAutoListen();});
        }else{
          Alert.alert('Voice Debug','textToSpeech returned null for '+persona.name);
          maybeAutoListen();
        }
      }else{
        Alert.alert('Voice Debug','No elevenlabsVoiceId for '+persona.name+' — falling back to native speech');
        Speech.speak(text.substring(0,500),{language:'en-US',rate:0.95,onDone:()=>maybeAutoListen(),onStopped:()=>maybeAutoListen()});
      }
    }catch(err){
      Alert.alert('Voice Debug — Exception',persona.name+': '+err.message);
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
    if(soundRef.current){try{await soundRef.current.stopAsync();await soundRef.current.unloadAsync();}catch{}soundRef.current=null;}

    return new Promise((resolve)=>{
      let settled=false,cancelled=false,timer=null,safety=null,lastRevealed=0,fullText=text;
      const cleanup=()=>{if(timer){clearInterval(timer);timer=null;}if(safety){clearTimeout(safety);safety=null;}speakCancelRef.current=null;};
      const done=(completed)=>{
        if(settled)return;settled=true;cleanup();
        vizRef.speaking=false;
        if(soundRef.current){try{soundRef.current.stopAsync();}catch{}}
        const revealed=completed?fullText.length:lastRevealed;
        const finalText=completed?fullText:(fullText.slice(0,revealed).trim()+(revealed<fullText.length?' …':''));
        patch(m=>({...m,content:finalText,revealed:finalText.length,streaming:false}));
        maybeAutoListen();
        resolve({revealed,completed,finalText});
      };
      speakCancelRef.current=()=>{cancelled=true;done(false);};

      const startTimer=(sound,timeline)=>{
        vizRef.speaking=true;
        timer=setInterval(async()=>{
          if(cancelled)return;
          if(abortRef.current?.signal.aborted){done(false);return;}
          let st;try{st=await sound.getStatusAsync();}catch{return;}
          if(!st?.isLoaded)return;
          if(st.isPlaying)vizRef.amplitude=synthAmp();
          const pos=st.positionMillis||0,dur=st.durationMillis||0;
          if(!safety&&dur>0)safety=setTimeout(()=>done(true),dur+2500);
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
          let sound=null,timeline=null;
          if(persona.id==='ara'){
            const r=await araGrokVoice(fullText);
            sound=r?.sound||null;timeline=r?.timeline||null;
            if(r?.transcript&&r.transcript.length>fullText.length){fullText=r.transcript;patch(m=>({...m,content:fullText}));}
          }else if(persona.elevenlabsVoiceId){
            const uri=await textToSpeech(fullText,persona.elevenlabsVoiceId,persona.name);
            if(uri){
              await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});
              const created=await Audio.Sound.createAsync({uri},{shouldPlay:true,progressUpdateIntervalMillis:80});
              sound=created.sound;
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

  function stopAudio(){
    speakCancelRef.current?.();
    if(soundRef.current){try{soundRef.current.stopAsync();}catch{}soundRef.current=null;}
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

  async function startRecording(){
    try{
      const{status}=await Audio.requestPermissionsAsync();
      if(status!=='granted'){Alert.alert('Permission','Microphone access required.');return;}
      await Audio.setAudioModeAsync({allowsRecordingIOS:true,playsInSilentModeIOS:true});
      const rec=new Audio.Recording();
      hasVoicedRef.current=false;
      clearSilenceTimer();
      await rec.prepareToRecordAsync({...Audio.RecordingOptionsPresets.HIGH_QUALITY,isMeteringEnabled:true});
      rec.setProgressUpdateInterval(150);
      rec.setOnRecordingStatusUpdate(onRecordingStatus);
      await rec.startAsync();
      recordingRef.current=rec;
      setRecording(true);
    }catch(e){Alert.alert('Error','Could not start recording: '+e.message);}
  }

  async function stopRecording(){
    try{
      clearSilenceTimer();
      setRecording(false);
      if(!recordingRef.current)return;
      const rec=recordingRef.current;
      recordingRef.current=null;
      await rec.stopAndUnloadAsync();
      const uri=rec.getURI();
      if(!uri)return;
      setLoading(true);
      try{
        const transcript=await transcribeAudio(uri);
        if(transcript){
          const isGroup=mode!=='direct';
          const userMsg={id:Date.now().toString(),role:'user',content:transcript,persona:'user'};
          if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
          else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',transcript,'direct');}
          await runRound(transcript,isGroup);
        }else{
          setLoading(false);
          maybeAutoListen();
        }
      }catch(e){Alert.alert('Voice Error',e.message);setLoading(false);maybeAutoListen();}
    }catch(e){setLoading(false);Alert.alert('Error',e.message);}
  }

  async function pickImage(){
    try{
      const{status}=await ImagePicker.requestMediaLibraryPermissionsAsync();
      if(status!=='granted'){Alert.alert('Permission','Photo library access required.');return;}
      const result=await ImagePicker.launchImageLibraryAsync({mediaTypes:ImagePicker.MediaTypeOptions.Images,quality:0.8});
      if(!result.canceled&&result.assets[0]){
        const msg=`[Image attached]\n${input.trim()||'What do you see in this image?'}`;
        setInput('');
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
        const msg=`[Document: ${doc.name}]\n${input.trim()||'Analyze this document.'}`;
        setInput('');
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
      const msg=`[Photo taken]\n${input.trim()||'What do you see in this photo?'}`;
      setInput('');
      const userMsg={id:Date.now().toString(),role:'user',content:msg,persona:'user',image:photo.uri};
      const isGroup=mode!=='direct';
      if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
      else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',msg,'direct');}
      await runRound(msg,isGroup);
    }catch(e){Alert.alert('Error',e.message);}
  }

  function getTargets(){
    if(mode==='council')return COUNCIL_PERSONAS;
    if(mode==='empire')return EMPIRE_PERSONAS;
    if(mode==='custom')return customPersonas;
    return[activePersona];
  }

  async function send(){
    const text=input.trim();if(!text||loading)return;
    setInput('');abortRef.current?.abort();stopAudio();
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
        let response=await callPersona(pid,hist,myAbort.signal,onDelta);
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
        if(/\[TRADE_SCAN\]/i.test(response)&&!myAbort.signal.aborted){
          toolLabel='◇ reading the market…';
          try{injections.push('MARKET SNAPSHOT XAUUSD:\n'+tlFormatSnapshot(await tlSnapshot('XAUUSD')));}
          catch(e){injections.push('MARKET SNAPSHOT: failed — '+e.message);}
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
        const cmdCallbacks={
          onRelay:({target,message})=>addRelay(target,`[From ${p.name}]: ${message}`),
          onTradePropose:(prop)=>setTradeProposal({...prop,pid}),
          onTradeClose:(id)=>closePosition(id),
          onDeepResearch:(topic)=>startDeepResearch(topic,pid),
          onShowChart:(raw)=>{const spec=parseChartSpec(raw);if(spec.valid){setChartOverlay(spec);setView('viz');}},
        };
        if(injections.length&&!myAbort.signal.aborted){
          await handleCommands(response,pid,cmdCallbacks);
          patch(m=>({...m,content:toolLabel,revealed:toolLabel.length,streaming:false}));
          vizRef.speaking=true;
          const hist2=[...hist,{role:'assistant',content:response},{role:'user',content:`[TOOL RESULTS — answer my previous message using this. Do not mention the lookup mechanism.\n\n${injections.join('\n\n---\n\n')}\n]`}];
          raw='';lastPatch=0;
          patch(m=>({...m,content:'',revealed:0,streaming:!willVoice}));
          response=await callPersona(pid,hist2,myAbort.signal,willVoice?null:onDelta,{skipSave:true});
          savePersonaMemory(pid,`YOU: ${text}\n${p.name}: ${stripCommands(response)||response}`).catch(()=>{});
        }
        const display=stripCommands(response)||response;
        if(display)replies.push({name:p.name,text:display});
        await handleCommands(response,pid,cmdCallbacks);
        if(willVoice){
          patch(m=>({...m,content:display,revealed:0,streaming:true}));
          const{finalText}=await speakWithReveal(display,p,msgId,isGroup);
          if(!isGroup)await saveMessage(pid,'assistant',finalText,'direct');
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
  }
  function startDeepResearch(topic,pid){
    if(deepResearch){pushSystemMsg('Deep Research already running — one at a time.');return;}
    const go=async()=>{
      try{
        pushSystemMsg(`— DEEP RESEARCH STARTED · ${topic} —`);
        const id=await deepResearchStart(topic);
        setDeepResearch({id,topic,pid:pid||'ara',status:'running'});
      }catch(e){pushSystemMsg(`Deep Research failed to start: ${e.message}`);}
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
  useEffect(()=>{
    if(!deepResearch?.id)return;
    let stop=false;
    const tick=async()=>{
      if(stop)return;
      try{
        const r=await deepResearchPoll(deepResearch.id);
        if(stop)return;
        if(r.status==='completed'){
          const dm={id:Date.now().toString(),role:'assistant',content:r.text,persona:deepResearch.pid,revealed:r.text.length,streaming:false};
          if(mode==='direct')setMessages(prev=>[...prev,dm]);else setGroupMessages(prev=>[...prev,dm]);
          savePersonaMemory(deepResearch.pid,`YOU: [deep research] ${deepResearch.topic}\n${getPersona(deepResearch.pid).name}: ${r.text.slice(0,4000)}`).catch(()=>{});
          setDeepResearch(null);
        }else if(r.status==='failed'||r.status==='cancelled'){
          pushSystemMsg(`Deep Research ${r.status}.`);setDeepResearch(null);
        }
      }catch(e){/* keep polling through transient errors */}
    };
    const iv=setInterval(tick,15000);tick();
    return()=>{stop=true;clearInterval(iv);};
  },[deepResearch?.id]);// eslint-disable-line react-hooks/exhaustive-deps

  async function confirmTrade(){
    if(!tradeProposal||tradeBusy)return;
    setTradeBusy(true);
    const{side,stopLoss,takeProfit,qty,pid}=tradeProposal;
    try{
      const r=await tlPlaceOrder({symbol:'XAUUSD',side,qty:Math.min(qty||MAX_QTY,MAX_QTY),stopLoss,takeProfit});
      pushSystemMsg(`— ORDER SENT · ${r.side.toUpperCase()} ${r.qty} XAUUSD · SL ${r.stopLoss??'—'} · TP ${r.takeProfit??'—'} · #${r.orderId||'?'} —`);
      savePersonaMemory(pid||'atlas',`YOU: [confirmed trade]\nA.T.L.A.S.: order sent ${r.side} ${r.qty} XAUUSD SL ${r.stopLoss} TP ${r.takeProfit}`).catch(()=>{});
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
        <Text style={s.empireOS}>♔ EMPIRE OS</Text>
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
        <View style={s.teamLabels}>
          <Text style={s.teamLabel}>THE EMPIRE</Text>
          <Text style={s.councilLabel}>THE COUNCIL</Text>
        </View>
        <Image source={TEAM_PHOTO} style={s.teamPhoto} resizeMode="cover"/>
      </View>}

      <View style={s.councilRow}>
        {COUNCIL.map(id=>{
          const p=getPersona(id);const active=mode==='direct'&&activePersona===id;const pic=personaPics[id];
          return(
            <TouchableOpacity key={id} style={[s.ctab,active&&{borderBottomColor:p.color,borderBottomWidth:2}]} onPress={()=>{setMode('direct');setActivePersona(id);}}>
              <View style={[s.ctabAvatar,{borderColor:active?p.color:p.color+'44'}]}>
                {pic?<Image source={{uri:pic}} style={s.ctabAvatarImg}/>:<Text style={[s.ctabIcon,{color:p.color}]}>{p.icon}</Text>}
              </View>
              <Text style={[s.ctabName,{color:active?p.color:'#444'}]}>{p.name.replace(/\./g,'').substring(0,6)}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <Text style={s.specLabel}>SPECIALISTS</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.specsScroll} contentContainerStyle={s.specialistsRow}>
        {SPECIALISTS.map(id=>{
          const p=getPersona(id);const active=mode==='direct'&&activePersona===id;const pic=personaPics[id];
          return(
            <TouchableOpacity key={id} style={[s.stab,active&&{borderBottomColor:p.color,borderBottomWidth:2}]} onPress={()=>{setMode('direct');setActivePersona(id);}}>
              <View style={[s.stabAvatar,{borderColor:active?p.color:p.color+'44'}]}>
                {pic?<Image source={{uri:pic}} style={s.stabAvatarImg}/>:<Text style={[s.stabIcon,{color:p.color}]}>{p.icon}</Text>}
              </View>
              <Text style={[s.stabName,{color:active?p.color:'#444'}]}>{p.name.replace(/\./g,'').substring(0,4)}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.modeBarScroll} contentContainerStyle={s.modeBar}>
        {['direct','council','empire','custom'].map(m=>(
          <TouchableOpacity key={m} style={[s.modeBtn,mode===m&&{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'}]} onPress={()=>{setMode(m);if(m==='custom')setShowCustomPicker(true);}}>
            <Text style={[s.modeBtnT,mode===m&&{color:'#E8C98A'}]}>{m==='direct'?'DIRECT':m==='council'?'✕ COUNCIL':m==='empire'?'◆ EMPIRE':'⬟ CUSTOM'}</Text>
          </TouchableOpacity>
        ))}
        {mode!=='direct'&&<>
          <TouchableOpacity style={[s.modeBtn,continuous&&{borderColor:'#4CAF50',backgroundColor:'#4CAF5011'}]} onPress={()=>setContinuous(v=>!v)}>
            <Text style={[s.modeBtnT,continuous&&{color:'#4CAF50'}]}>⟳ LIVE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.modeBtn,{borderColor:'#E0555533'}]} onPress={interject}>
            <Text style={[s.modeBtnT,{color:'#E05555'}]}>✋ INTERJECT</Text>
          </TouchableOpacity>
        </>}
      </ScrollView>

      <View style={s.memBar}>
        <Text style={s.memLabel}>MEMORY</Text>
        <Text style={s.memStatus}>{mode==='direct'?`${cp.name} memory active`:'All persona memory loaded ✓'}</Text>
      </View>

      <TradePanel active={isFocused} onEvent={pushSystemMsg}/>

      {deepResearch&&<View style={s.deepCard}>
        <ActivityIndicator size="small" color="#5B8DEF"/>
        <Text style={s.deepText} numberOfLines={1}>DEEP RESEARCH · {deepResearch.topic}</Text>
        <TouchableOpacity onPress={()=>{setDeepResearch(null);pushSystemMsg('Deep Research dismissed (still running on OpenAI).');}}>
          <Text style={s.deepX}>×</Text>
        </TouchableOpacity>
      </View>}

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
          onPickPersona={id=>{setMode('direct');setActivePersona(id);}}
          onLaunchGroup={ids=>{setCustomPersonas(ids);setMode('custom');setView('text');}}
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
            <TextInput style={s.input} value={input} onChangeText={setInput} placeholder="Speak your directive..." placeholderTextColor="#333" multiline maxLength={2000}/>
            <TouchableOpacity style={[s.sendBtn,{backgroundColor:mode==='direct'?cp.color:'#E8C98A'}]} onPress={send} disabled={loading||!input.trim()}>
              <Text style={s.sendT}>SEND</Text>
            </TouchableOpacity>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.inputActions}>
            <TouchableOpacity style={[s.iact,recording&&{borderColor:'#E05555',backgroundColor:'#E0555511'}]} onPress={recording?stopRecording:startRecording}>
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

      <View style={s.bottomNav}>
        <TouchableOpacity style={s.navItem} onPress={()=>{}}>
          <Text style={[s.navIcon,{color:'#E8C98A'}]}>✕</Text>
          <Text style={[s.navLabel,{color:'#E8C98A'}]}>COMMAND</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.navItem} onPress={()=>navigation.navigate('HUD')}>
          <Text style={s.navIcon}>◉</Text><Text style={s.navLabel}>HUD</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.navItem} onPress={()=>navigation.navigate('Memory')}>
          <Text style={s.navIcon}>☁</Text><Text style={s.navLabel}>MEMORY</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.navItem} onPress={()=>navigation.navigate('Settings')}>
          <Text style={s.navIcon}>⚙</Text><Text style={s.navLabel}>SETTINGS</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.navItem} onPress={()=>{setHandsFree(false);handsFreeRef.current=false;clearSilenceTimer();if(recordingRef.current)stopRecording();stopAudio();navigation.navigate('Map');}}>
          <Text style={s.navIcon}>🗺</Text><Text style={s.navLabel}>MAP</Text>
        </TouchableOpacity>
      </View>

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

      <Modal visible={!!tradeProposal} transparent animationType="fade" onRequestClose={()=>setTradeProposal(null)}>
        <View style={s.modalOver}><View style={s.tradeCard}>
          <Text style={s.tradeTitle}>CONFIRM TRADE · XAUUSD</Text>
          {tradeProposal&&<>
            <View style={[s.tradeSideChip,{backgroundColor:(tradeProposal.side==='buy'?'#5FA779':'#C7614B')+'22',borderColor:tradeProposal.side==='buy'?'#5FA779':'#C7614B'}]}>
              <Text style={[s.tradeSideT,{color:tradeProposal.side==='buy'?'#5FA779':'#C7614B'}]}>{tradeProposal.side==='buy'?'▲ BUY':'▼ SELL'} {Math.min(tradeProposal.qty||1,MAX_QTY)} LOT</Text>
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
  bottomNav:{flexDirection:'row',borderTopWidth:1,borderTopColor:'#111',paddingVertical:6,backgroundColor:'#000'},
  navItem:{flex:1,alignItems:'center',paddingVertical:3},
  navIcon:{fontSize:12,color:'#444',marginBottom:2},
  navLabel:{fontFamily:'monospace',fontSize:6,color:'#444',letterSpacing:1},
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
  deepCard:{flexDirection:'row',alignItems:'center',gap:10,marginHorizontal:10,marginTop:4,paddingHorizontal:12,paddingVertical:8,borderWidth:1,borderColor:'#1E2740',borderRadius:8,backgroundColor:'#070A10'},
  deepText:{flex:1,fontFamily:'monospace',fontSize:9,color:'#5B8DEF',letterSpacing:1},
  deepX:{color:'#555',fontSize:18,lineHeight:18},
});
