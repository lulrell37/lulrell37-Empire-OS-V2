import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,FlatList,KeyboardAvoidingView,Platform,ActivityIndicator,ScrollView,Modal,Animated}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import*as Speech from 'expo-speech';
import{PERSONAS,PERSONA_LIST,COUNCIL_PERSONAS,EMPIRE_PERSONAS,getPersona}from '../personas/personas';
import{callPersona}from '../services/aiService';
import{handleCommands,stripCommands}from '../services/commandHandler';
import{getMessages,saveMessage}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';

export default function CommandScreen({navigation}){
  const[activePersona,setActivePersona]=useState('jarvis');
  const[mode,setMode]=useState('direct');
  const[input,setInput]=useState('');
  const[messages,setMessages]=useState([]);
  const[groupMessages,setGroupMessages]=useState([]);
  const[loading,setLoading]=useState(false);
  const[voiceOn,setVoiceOn]=useState(false);
  const[continuous,setContinuous]=useState(false);
  const[showCustomPicker,setShowCustomPicker]=useState(false);
  const[customPersonas,setCustomPersonas]=useState([]);
  const[selectedCustom,setSelectedCustom]=useState([]);
  const flatRef=useRef(null);
  const abortRef=useRef(null);
  const contRef=useRef(false);
  const{addRelay}=useEmpireStore();

  useEffect(()=>{contRef.current=continuous;},[continuous]);
  useEffect(()=>{if(mode==='direct')loadHistory(activePersona);},[activePersona,mode]);

  async function loadHistory(persona){
    const h=await getMessages(persona,40);
    setMessages(h.reverse().map(m=>({id:m.id.toString(),role:m.role,content:m.content,persona:m.persona})));
  }

  function getTargets(){
    if(mode==='council')return COUNCIL_PERSONAS;
    if(mode==='empire')return EMPIRE_PERSONAS;
    if(mode==='custom')return customPersonas;
    return[activePersona];
  }

  function reorder(msg,targets){
    const lower=msg.toLowerCase().trim();
    for(const id of targets){if(new RegExp(`^${id}[,\\.!?\\s]`,'i').test(lower))return[id,...targets.filter(t=>t!==id)];}
    return targets;
  }

  async function send(){
    const text=input.trim();if(!text||loading)return;
    setInput('');
    const isGroup=mode!=='direct';
    const userMsg={id:Date.now().toString(),role:'user',content:text,persona:'user'};
    if(isGroup)setGroupMessages(prev=>[...prev,userMsg]);
    else{setMessages(prev=>[...prev,userMsg]);await saveMessage(activePersona,'user',text,'direct');}
    await runRound(text,isGroup);
  }

  async function runRound(text,isGroup){
    setLoading(true);abortRef.current=new AbortController();
    const targets=isGroup?reorder(text,getTargets()):[activePersona];
    const replies=[];
    try{
      for(const pid of targets){
        if(abortRef.current?.signal.aborted)break;
        const p=getPersona(pid);
        const hist=(isGroup?groupMessages:messages).slice(-20).map(m=>({role:m.role==='user'||m.role==='assistant'?m.role:'user',content:m.content}));
        hist.push({role:'user',content:text});
        if(isGroup&&replies.length>0)hist.push({role:'user',content:`[PRIOR REPLIES:\n${replies.map(r=>`${r.name}: ${r.text}`).join('\n\n')}\nRespond and acknowledge. Be brief.]`});
        const response=await callPersona(pid,hist,abortRef.current?.signal);
        const display=stripCommands(response);
        const aiMsg={id:`${Date.now()}-${pid}`,role:'assistant',content:display||response,persona:pid};
        if(isGroup)setGroupMessages(prev=>[...prev,aiMsg]);
        else{setMessages(prev=>[...prev,aiMsg]);await saveMessage(pid,'assistant',display||response,'direct');}
        if(display)replies.push({name:p.name,text:display});
        await handleCommands(response,pid,{onRelay:({target,message})=>addRelay(target,`[From ${p.name}]: ${message}`)});
        if(voiceOn&&display)Speech.speak(display.substring(0,400),{language:'en-US',rate:0.95});
      }
    }catch(e){
      if(e.name!=='AbortError'){
        const err={id:Date.now().toString(),role:'system',content:`Error: ${e.message}`,persona:'system'};
        if(isGroup)setGroupMessages(prev=>[...prev,err]);else setMessages(prev=>[...prev,err]);
      }
    }finally{setLoading(false);setTimeout(()=>flatRef.current?.scrollToEnd({animated:true}),100);}
    if(contRef.current&&!abortRef.current?.signal.aborted)setTimeout(()=>{if(contRef.current)runRound('[Continue. Build on what was said. Be brief.]',true);},1200);
  }

  function interject(){abortRef.current?.abort();setContinuous(false);contRef.current=false;Speech.stop();setLoading(false);setGroupMessages(prev=>[...prev,{id:Date.now().toString(),role:'system',content:'— YOU HAVE THE FLOOR —',persona:'system'}]);}

  function renderMsg({item}){
    const p=item.persona&&item.persona!=='user'&&item.persona!=='system'?getPersona(item.persona):null;
    if(item.role==='user')return(<View style={s.userBubble}><Text style={s.userText}>{item.content}</Text></View>);
    if(item.role==='system')return(<View style={s.sysBubble}><Text style={s.sysText}>{item.content}</Text></View>);
    return(
      <View style={s.aiBubble}>
        {p&&<><Text style={[s.aiName,{color:p.color}]}>{p.name}</Text><View style={[s.aiLine,{backgroundColor:p.color}]}/></>}
        <Text style={s.aiText}>{item.content}</Text>
      </View>
    );
  }

  const cp=getPersona(activePersona);
  const displayMessages=mode==='direct'?messages:groupMessages;

  return(
    <SafeAreaView style={s.container} edges={['top','bottom']}>
      {/* Header */}
      <View style={[s.header,{borderBottomColor:mode==='direct'?cp.color+'55':'#E8C98A44'}]}>
        <TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity>
        <View style={s.headerCenter}>
          {mode==='direct'?(<><Text style={[s.headerName,{color:cp.color}]}>{cp.name}</Text><Text style={s.headerRole}>{cp.role}</Text></>)
          :(<><Text style={[s.headerName,{color:'#E8C98A'}]}>{mode==='council'?'COUNCIL':mode==='empire'?'EMPIRE':'CUSTOM'}</Text><Text style={s.headerRole}>{mode==='council'?'JARVIS · ARA · SELENE':mode==='empire'?'ALL 11 PERSONAS':customPersonas.map(id=>getPersona(id).name.split('.')[0]).join(' · ')}</Text></>)}
        </View>
        <View style={{flexDirection:'row',gap:8,alignItems:'center'}}>
          <TouchableOpacity onPress={()=>setVoiceOn(v=>!v)}><Text style={{fontSize:18,color:voiceOn?'#E8C98A':'#333'}}>{voiceOn?'🔊':'🔇'}</Text></TouchableOpacity>
          {loading&&<TouchableOpacity onPress={()=>{abortRef.current?.abort();Speech.stop();setLoading(false);}}><Text style={{fontSize:14,color:'#E05555'}}>■</Text></TouchableOpacity>}
          <TouchableOpacity onPress={()=>navigation.navigate('Settings')}><Text style={{fontSize:16,color:'#333'}}>⚙</Text></TouchableOpacity>
        </View>
      </View>

      {/* Mode bar */}
      <View style={s.modeBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:6,padding:8}}>
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
              <Text style={s.modeBtnT}>✋ INTERJECT</Text>
            </TouchableOpacity>
          </>}
        </ScrollView>
      </View>

      {/* Persona tabs - direct mode only */}
      {mode==='direct'&&(
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabsBar} contentContainerStyle={{paddingHorizontal:8,paddingVertical:6,gap:4}}>
          {PERSONA_LIST.map(p=>(
            <TouchableOpacity key={p.id} style={[s.tab,activePersona===p.id&&{borderBottomColor:p.color,borderBottomWidth:2}]} onPress={()=>setActivePersona(p.id)}>
              <View style={[s.tabAvatar,{borderColor:activePersona===p.id?p.color:p.color+'44'}]}>
                <Text style={[s.tabAvatarText,{color:p.color}]}>{p.icon}</Text>
              </View>
              <Text style={[s.tabName,{color:activePersona===p.id?p.color:'#333'}]}>{p.name.replace(/\./g,'').substring(0,4)}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Messages */}
      <FlatList ref={flatRef} data={displayMessages} keyExtractor={i=>i.id} renderItem={renderMsg} contentContainerStyle={s.msgList} style={{flex:1}} onContentSizeChange={()=>flatRef.current?.scrollToEnd({animated:true})}/>

      {loading&&(<View style={s.thinking}>
        <ActivityIndicator size="small" color={mode==='direct'?cp.color:'#E8C98A'}/>
        <Text style={[s.thinkT,{color:mode==='direct'?cp.color:'#E8C98A'}]}>{mode==='direct'?`${cp.name} is responding...`:'Council speaking...'}</Text>
      </View>)}

      {/* Input */}
      <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':'height'}>
        <View style={[s.inputRow,{borderTopColor:mode==='direct'?cp.color+'22':'#E8C98A22'}]}>
          <TextInput style={s.input} value={input} onChangeText={setInput} placeholder={mode==='direct'?`Message ${cp.name}...`:'Speak to the council...'} placeholderTextColor="#222" multiline maxLength={2000}/>
          <TouchableOpacity style={[s.sendBtn,{backgroundColor:mode==='direct'?cp.color:'#E8C98A'}]} onPress={send} disabled={loading||!input.trim()}>
            <Text style={s.sendT}>▶</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      {/* Custom picker */}
      <Modal visible={showCustomPicker} transparent animationType="slide">
        <View style={s.modalOver}><View style={s.modalContent}>
          <Text style={s.modalTitle}>SELECT YOUR TEAM</Text>
          <ScrollView style={{maxHeight:350}}>
            {PERSONA_LIST.map(p=>{const sel=selectedCustom.includes(p.id);return(
              <TouchableOpacity key={p.id} style={[s.pItem,sel&&{borderColor:p.color}]} onPress={()=>setSelectedCustom(prev=>prev.includes(p.id)?prev.filter(id=>id!==p.id):[...prev,p.id])}>
                <View style={[s.pCheck,sel&&{backgroundColor:p.color}]}>{sel&&<Text style={{fontSize:10,color:'#000',fontWeight:'700'}}>✓</Text>}</View>
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
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:14,paddingVertical:10,borderBottomWidth:1,gap:10},
  back:{fontSize:20,color:'#E8C98A',paddingRight:4},
  headerCenter:{flex:1},
  headerName:{fontFamily:'monospace',fontSize:13,fontWeight:'700',letterSpacing:1},
  headerRole:{fontFamily:'monospace',fontSize:8,color:'#444',letterSpacing:2,marginTop:2},
  modeBar:{backgroundColor:'#050505',borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  modeBtn:{paddingHorizontal:12,paddingVertical:5,borderRadius:4,borderWidth:1,borderColor:'#1A1A1A'},
  modeBtnT:{fontFamily:'monospace',fontSize:9,color:'#444',letterSpacing:1},
  tabsBar:{borderBottomWidth:1,borderBottomColor:'#0D0D0D',maxHeight:58},
  tab:{alignItems:'center',paddingHorizontal:8,paddingBottom:2},
  tabAvatar:{width:26,height:26,borderRadius:13,borderWidth:1.5,alignItems:'center',justifyContent:'center',marginBottom:2},
  tabAvatarText:{fontFamily:'monospace',fontSize:8,fontWeight:'700'},
  tabName:{fontFamily:'monospace',fontSize:6,letterSpacing:1},
  msgList:{padding:12,gap:10,paddingBottom:6},
  userBubble:{alignSelf:'flex-end',backgroundColor:'#111',borderRadius:16,borderBottomRightRadius:4,padding:12,maxWidth:'82%',borderWidth:1,borderColor:'#1A1A1A'},
  userText:{color:'#DDD',fontSize:15,lineHeight:22},
  aiBubble:{alignSelf:'flex-start',backgroundColor:'#080808',borderRadius:16,borderBottomLeftRadius:4,padding:14,maxWidth:'90%',borderWidth:1,borderColor:'#111'},
  aiName:{fontFamily:'monospace',fontSize:9,fontWeight:'700',letterSpacing:2,marginBottom:3},
  aiLine:{height:1,width:12,opacity:0.5,marginBottom:8},
  aiText:{color:'#CCC',fontSize:15,lineHeight:23},
  sysBubble:{alignSelf:'center',backgroundColor:'#0A0A0A',borderRadius:6,padding:8},
  sysText:{color:'#333',fontSize:10,fontFamily:'monospace',textAlign:'center',letterSpacing:2},
  thinking:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:14,paddingVertical:6},
  thinkT:{fontFamily:'monospace',fontSize:10,letterSpacing:1},
  inputRow:{flexDirection:'row',alignItems:'flex-end',padding:10,gap:8,borderTopWidth:1},
  input:{flex:1,backgroundColor:'#080808',borderWidth:1,borderColor:'#151515',borderRadius:10,paddingHorizontal:14,paddingVertical:10,color:'#DDD',fontSize:15,maxHeight:120},
  sendBtn:{width:44,height:44,borderRadius:10,alignItems:'center',justifyContent:'center'},
  sendT:{fontSize:16,color:'#000',fontWeight:'700'},
  modalOver:{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'},
  modalContent:{backgroundColor:'#0A0A0A',borderTopWidth:1,borderTopColor:'#1A1A1A',borderTopLeftRadius:16,borderTopRightRadius:16,padding:24},
  modalTitle:{fontFamily:'monospace',fontSize:13,color:'#E8C98A',letterSpacing:3,marginBottom:16},
  pItem:{flexDirection:'row',alignItems:'center',gap:12,padding:12,marginBottom:6,borderRadius:6,borderWidth:1,borderColor:'#111'},
  pCheck:{width:18,height:18,borderRadius:3,borderWidth:1,borderColor:'#333',alignItems:'center',justifyContent:'center'},
  pName:{fontFamily:'monospace',fontSize:10,fontWeight:'700',flex:1},
  pRole:{fontFamily:'monospace',fontSize:8,color:'#333'},
  modalBtns:{flexDirection:'row',gap:10,marginTop:16},
  modalBtn:{flex:1,padding:14,borderRadius:8,alignItems:'center'},
  modalBtnT:{fontFamily:'monospace',fontSize:11,fontWeight:'700',letterSpacing:2},
});
