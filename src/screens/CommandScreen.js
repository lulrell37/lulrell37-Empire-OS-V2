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
import{callPersona,textToSpeech,transcribeAudio}from '../services/aiService';
import{handleCommands,stripCommands}from '../services/commandHandler';
import{getMessages,saveMessage,getAllPersonaPics}from '../services/database';
import{loadKeys}from '../services/keyStore';
import useEmpireStore from '../store/useEmpireStore';
import{reportError}from '../../ErrorBanner';

const COUNCIL=['jarvis','ara','selene'];
const SPECIALISTS=['stephanie','rogue','atlas','haven','aisha','abraham','batman'];
const TEAM_PHOTO=require('../../assets/teamphoto.png');

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
  const[customPersonas,setCustomPersonas]=useState([]);
  const[showCustomPicker,setShowCustomPicker]=useState(false);
  const[selectedCustom,setSelectedCustom]=useState([]);
  const[personaPics,setPersonaPics]=useState({});
  const[showCamera,setShowCamera]=useState(false);
  const[cameraRef,setCameraRef]=useState(null);
  const flatRef=useRef(null);
  const abortRef=useRef(null);
  const contRef=useRef(false);
  const soundRef=useRef(null);
  const recordingRef=useRef(null);
  const araWsRef=useRef(null);
  const araChunksRef=useRef([]);
  const{addRelay}=useEmpireStore();

  useEffect(()=>{contRef.current=continuous;},[continuous]);
  useEffect(()=>{if(mode==='direct')loadHistory(activePersona);},[activePersona,mode]);
  useEffect(()=>{
    Audio.setAudioModeAsync({allowsRecordingIOS:true,playsInSilentModeIOS:true});
    loadPics();
  },[]);

  async function loadPics(){try{const pics=await getAllPersonaPics();setPersonaPics(pics);}catch{}}

  async function loadHistory(persona){
    const h=await getMessages(persona,40);
    setMessages(h.reverse().map(m=>({id:m.id.toString(),role:m.role,content:m.content,persona:m.persona})));
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
    const{sound}=await Audio.Sound.createAsync({uri},{shouldPlay:true});
    return sound;
  }

  async function araGrokVoice(text){
    const keys=await loadKeys();
    if(!keys?.grok)throw new Error('Grok API key needed for Ara voice. Add in Settings.');
    araChunksRef.current=[];
    return new Promise((resolve,reject)=>{
      const ws=new WebSocket(
        'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
        ['realtime','openai-insecure-api-key.'+keys.grok,'openai-beta.realtime-v1']
      );
      araWsRef.current=ws;
      let sessionReady=false;
      let transcript='';
      ws.onopen=()=>{
        ws.send(JSON.stringify({
          type:'session.update',
          session:{
            voice:'ara',
            instructions:getPersona('ara').system,
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
          }catch{}
        }
        if(event.type==='response.output_audio_transcript.delta'){transcript+=event.delta;}
        if(event.type==='response.done'){
          try{
            const sound=await buildAndPlayGrokAudio(araChunksRef.current);
            araChunksRef.current=[];
            try{ws.close();}catch{}
            araWsRef.current=null;
            resolve({sound,transcript});
          }catch(err){reject(err);}
        }
        if(event.type==='error'){try{ws.close();}catch{}araWsRef.current=null;reject(new Error(event.message||'Ara voice error'));}
      };
      ws.onerror=()=>{araWsRef.current=null;reject(new Error('Ara voice: connection failed'));};
    });
  }

  async function speakResponse(text,persona){
    if(!voiceOn||voiceMuted||!text)return;
    if(voicePaused)return;
    try{
      if(soundRef.current){try{await soundRef.current.stopAsync();await soundRef.current.unloadAsync();}catch{}soundRef.current=null;}
      if(persona.id==='ara'){
        const result=await araGrokVoice(text);
        soundRef.current=result?.sound||null;
      }else if(persona.elevenlabsVoiceId){
        const uri=await textToSpeech(text,persona.elevenlabsVoiceId);
        if(uri){
          await Audio.setAudioModeAsync({playsInSilentModeIOS:true,allowsRecordingIOS:false});
          const{sound}=await Audio.Sound.createAsync({uri},{shouldPlay:true});
          soundRef.current=sound;
        }else{
          reportError('speakResponse: textToSpeech returned null for '+persona.name);
        }
      }else{Speech.speak(text.substring(0,500),{language:'en-US',rate:0.95});}
    }catch(err){
      reportError('speakResponse failed for '+persona.name+': '+err.message);
      Speech.speak(text.substring(0,500),{language:'en-US',rate:0.95});
    }
  }

  function stopAudio(){
    if(soundRef.current){try{soundRef.current.stopAsync();}catch{}soundRef.current=null;}
    if(araWsRef.current){try{araWsRef.current.close();}catch{}araWsRef.current=null;}
    Speech.stop();
  }

  function pauseAudio(){
    if(soundRef.current){try{soundRef.current.pauseAsync();}catch{}}
    Speech.stop();setVoicePaused(true);
  }

  function resumeAudio(){setVoicePaused(false);}

  async function startRecording(){
    try{
      const{status}=await Audio.requestPermissionsAsync();
      if(status!=='granted'){Alert.alert('Permission','Microphone access required.');return;}
      await Audio.setAudioModeAsync({allowsRecordingIOS:true,playsInSilentModeIOS:true});
      const rec=new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      await rec.startAsync();
      recordingRef.current=rec;
      setRecording(true);
    }catch(e){Alert.alert('Error','Could not start recording: '+e.message);}
  }

  async function stopRecording(){
    try{
      setRecording(false);
      if(!recordingRef.current)return;
      await recordingRef.current.stopAndUnloadAsync();
      const uri=recordingRef.current.getURI();
      recordingRef.current=null;
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
        }
      }catch(e){Alert.alert('Voice Error',e.message);setLoading(false);}
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
    setInput('');stopAudio();
    const isGroup=mode!=='direct';
    const userMsg={id:Date.now().toString(),role:'user',content:text,persona:'user'};
    if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
    else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',text,'direct');}
    await runRound(text,isGroup);
  }

  async function runRound(text,isGroup){
    setLoading(true);abortRef.current=new AbortController();
    const targets=isGroup?getTargets():[activePersona];
    const replies=[];
    try{
      for(const pid of targets){
        if(abortRef.current?.signal.aborted)break;
        const p=getPersona(pid);
        const hist=(isGroup?groupMessages:messages).slice(-20).map(m=>({role:m.role==='user'||m.role==='assistant'?m.role:'user',content:m.content}));
        hist.push({role:'user',content:text});
        if(isGroup&&replies.length>0)hist.push({role:'user',content:`[PRIOR:\n${replies.map(r=>`${r.name}: ${r.text}`).join('\n\n')}\nAcknowledge and be brief.]`});
        const response=await callPersona(pid,hist,abortRef.current?.signal);
        const display=stripCommands(response);
        const aiMsg={id:`${Date.now()}-${pid}`,role:'assistant',content:display||response,persona:pid};
        if(isGroup)setGroupMessages(prev=>[...prev,aiMsg]);
        else{setMessages(prev=>[...prev,aiMsg]);await saveMessage(pid,'assistant',display||response,'direct');}
        if(display)replies.push({name:p.name,text:display});
        await handleCommands(response,pid,{onRelay:({target,message})=>addRelay(target,`[From ${p.name}]: ${message}`)});
        await speakResponse(display||response,p);
      }
    }catch(e){
      if(e.name!=='AbortError'){
        const err={id:Date.now().toString(),role:'system',content:`Error: ${e.message}`,persona:'system'};
        if(isGroup)setGroupMessages(prev=>[...prev,err]);else setMessages(prev=>[...prev,err]);
      }
    }finally{setLoading(false);setTimeout(()=>flatRef.current?.scrollToEnd({animated:true}),100);}
    if(contRef.current&&!abortRef.current?.signal.aborted)setTimeout(()=>{if(contRef.current)runRound('[Continue. Be brief.]',true);},1200);
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
          <TouchableOpacity style={s.replayBtn} onPress={()=>speakResponse(item.content,p||{})}>
            <Text style={s.replayBtnT}>↻ REPLAY</Text>
          </TouchableOpacity>
        </View>
        <View style={[s.aiDivider,{backgroundColor:p?.color||'#E8C98A'}]}/>
        <Text style={s.aiText}>{item.content}</Text>
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
        <View style={s.onlinePill}><View style={s.onlineDot}/><Text style={s.onlineText}>ONLINE</Text></View>
      </View>

      <View style={s.teamPanel}>
        <View style={s.teamLabels}>
          <Text style={s.teamLabel}>THE EMPIRE</Text>
          <Text style={s.councilLabel}>THE COUNCIL</Text>
        </View>
        <Image source={TEAM_PHOTO} style={s.teamPhoto} resizeMode="cover"/>
      </View>

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
        <TouchableOpacity style={[s.modeBtn,voiceOn&&!voiceMuted&&{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'}]} onPress={()=>{if(voiceOn)stopAudio();setVoiceOn(v=>!v);setVoicePaused(false);}}>
          <Text style={[s.modeBtnT,voiceOn&&!voiceMuted&&{color:'#E8C98A'}]}>{voiceOn?'🔊 VOICE ON':'🔇 VOICE OFF'}</Text>
        </TouchableOpacity>
        {voiceOn&&<>
          <TouchableOpacity style={[s.modeBtn,voicePaused&&{borderColor:'#FFB300',backgroundColor:'#FFB30011'}]} onPress={()=>{voicePaused?resumeAudio():pauseAudio();}}>
            <Text style={[s.modeBtnT,voicePaused&&{color:'#FFB300'}]}>{voicePaused?'▶ RESUME':'⏸ PAUSE'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.modeBtn,voiceMuted&&{borderColor:'#E05555',backgroundColor:'#E0555511'}]} onPress={()=>{setVoiceMuted(v=>!v);if(!voiceMuted)stopAudio();}}>
            <Text style={[s.modeBtnT,voiceMuted&&{color:'#E05555'}]}>{voiceMuted?'🔕 MUTED':'🔕 MUTE'}</Text>
          </TouchableOpacity>
        </>}
        {loading&&<TouchableOpacity style={[s.modeBtn,{borderColor:'#E05555'}]} onPress={()=>{abortRef.current?.abort();stopAudio();setLoading(false);}}>
          <Text style={[s.modeBtnT,{color:'#E05555'}]}>■ STOP</Text>
        </TouchableOpacity>}
      </ScrollView>

      <View style={s.memBar}>
        <Text style={s.memLabel}>MEMORY</Text>
        <Text style={s.memStatus}>{mode==='direct'?`${cp.name} memory active`:'All persona memory loaded ✓'}</Text>
      </View>

      <FlatList ref={flatRef} data={displayMessages} keyExtractor={i=>i.id} renderItem={renderMsg} contentContainerStyle={s.msgList} style={{flex:1}} onContentSizeChange={()=>flatRef.current?.scrollToEnd({animated:true})}/>

      {loading&&(<View style={s.thinking}>
        <ActivityIndicator size="small" color={mode==='direct'?cp.color:'#E8C98A'}/>
        <Text style={[s.thinkT,{color:mode==='direct'?cp.color:'#E8C98A'}]}>{mode==='direct'?`${cp.name} is responding...`:'Council speaking...'}</Text>
      </View>)}

      <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':'height'}>
        <View style={s.inputArea}>
          <View style={s.inputRow}>
            <TextInput style={s.input} value={input} onChangeText={setInput} placeholder="Speak your directive..." placeholderTextColor="#333" multiline maxLength={2000}/>
            <TouchableOpacity style={[s.sendBtn,{backgroundColor:mode==='direct'?cp.color:'#E8C98A'}]} onPress={send} disabled={loading||!input.trim()}>
              <Text style={s.sendT}>SEND</Text>
            </TouchableOpacity>
          </View>
          <View style={s.inputActions}>
            <TouchableOpacity style={[s.iact,recording&&{borderColor:'#E05555',backgroundColor:'#E0555511'}]} onPress={recording?stopRecording:startRecording}>
              <View style={[s.iactDot,recording&&{backgroundColor:'#E05555'}]}/>
              <Text style={[s.iactT,recording&&{color:'#E05555'}]}>{recording?'STOP REC':'SPEAK'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.iact} onPress={pickImage}>
              <View style={s.iactDot}/><Text style={s.iactT}>IMAGE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.iact} onPress={pickDocument}>
              <View style={s.iactDot}/><Text style={s.iactT}>DOCUMENT</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.iact} onPress={openCamera}>
              <View style={s.iactDot}/><Text style={s.iactT}>CAMERA</Text>
            </TouchableOpacity>
          </View>
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
        <TouchableOpacity style={s.navItem} onPress={()=>{stopAudio();navigation.navigate('Map');}}>
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
    </SafeAreaView>
  );
}

const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:16,paddingVertical:8,borderBottomWidth:1,borderBottomColor:'#111'},
  empireOS:{fontFamily:'monospace',fontSize:14,fontWeight:'700',color:'#E8C98A',letterSpacing:2},
  onlinePill:{flexDirection:'row',alignItems:'center',gap:5,borderWidth:1,borderColor:'#4CAF5055',borderRadius:12,paddingHorizontal:8,paddingVertical:3},
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
});
