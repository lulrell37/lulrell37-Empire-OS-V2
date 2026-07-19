import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,FlatList,KeyboardAvoidingView,Platform,ActivityIndicator,ScrollView,Modal}from 'react-native';
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
  const[showModeBar,setShowModeBar]=useState(false);
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
    if(isGroup){setGroupMessages(prev=>[...prev,userMsg]);}
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
        if(isGroup&&replies.length>0){hist.push({role:'user',content:`[PRIOR REPLIES:\n${replies.map(r=>`${r.name}: ${r.text}`).join('\n\n')}\nRespond and acknowledge others. Be brief.]`});}
        const response=await callPersona(pid,hist,abortRef.current?.signal);
        const display=stripCommands(response);
        const aiMsg={id:`${Date.now()}-${pid}`,role:'assistant',content:display||response,persona:pid};
        if(isGroup){setGroupMessages(prev=>[...prev,aiMsg]);}
        else{setMessages(prev=>[...prev,aiMsg]);await saveMessage(pid,'assistant',display||response,'direct');}
        if(display)replies.push({name:p.name,text:display});
        await handleCommands(response,pid,{onRelay:({target,message})=>addRelay(target,`[From ${p.name}]: ${message}`)});
        if(voiceOn&&display){Speech.speak(display.substring(0,400),{language:'en-US',rate:0.95});}
      }
    }catch(e){
      if(e.name!=='AbortError'){
        const errMsg={id:Date.now().toString(),role:'system',content:`Error: ${e.message}`,persona:'system'};
        if(isGroup){setGroupMessages(prev=>[...prev,errMsg]);}else{setMessages(prev=>[...prev,errMsg]);}
      }
    }finally{setLoading(false);setTimeout(()=>flatRef.current?.scrollToEnd({animated:true}),100);}
    if(contRef.current&&!abortRef.current?.signal.aborted){setTimeout(()=>{if(contRef.current)runRound('[Continue the discussion. Build on what was said. Be direct and brief.]',true);},1200);}
  }
  function interject(){abortRef.current?.abort();setContinuous(false);contRef.current=false;Speech.stop();setLoading(false);setGroupMessages(prev=>[...prev,{id:Date.now().toString(),role:'system',content:'— YOU HAVE THE FLOOR —',persona:'system'}]);}
  function renderMsg({item}){
    const p=item.persona&&item.persona!=='user'&&item.persona!=='system'?getPersona(item.persona):null;
    if(item.role==='user')return(<View style={s.userBubble}><Text style={s.userText}>{item.content}</Text></View>);
    if(item.role==='system')return(<View style={s.sysBubble}><Text style={s.sysText}>{item.content}</Text></View>);
    return(<View style={s.aiBubble}>{p&&<><Text style={[s.aiName,{color:p.color}]}>{p.name}</Text><View style={[s.aiLine,{backgroundColor:p.color}]}/></>}<Text style={s.aiText}>{item.content}</Text></View>);
  }
  const currentPersona=getPersona(activePersona);
  const displayMessages=mode==='direct'?messages:groupMessages;
  return(
    <SafeAreaView style={s.container} edges={['top','bottom']}>
      <View style={[s.header,{borderBottomColor:mode==='direct'?currentPersona.color+'44':'#E8C98A44'}]}>
        <TouchableOpacity onPress={()=>navigation.goBack()} style={s.backBtn}><Text style={s.backText}>←</Text></TouchableOpacity>
        <View style={s.headerCenter}>
          {mode==='direct'?(<><Text style={[s.headerName,{color:currentPersona.color}]}>{currentPersona.name}</Text><Text style={s.headerRole}>{currentPersona.role}</Text></>):(<><Text style={s.headerName}>{mode.toUpperCase()}</Text><Text style={s.headerRole}>{mode==='council'?'JARVIS · ARA · SELENE':mode==='empire'?'ALL 11 PERSONAS':customPersonas.map(id=>getPersona(id).name.split('.')[0]).join(' · ')}</Text></>)}
        </View>
        <View style={s.headerActions}>
          <TouchableOpacity onPress={()=>setVoiceOn(v=>!v)} style={s.iconBtn}><Text style={{fontSize:16,color:voiceOn?'#E8C98A':'#333'}}>{voiceOn?'🔊':'🔇'}</Text></TouchableOpacity>
          <TouchableOpacity onPress={()=>setShowModeBar(v=>!v)} style={s.iconBtn}><Text style={{fontSize:16,color:'#555'}}>⋮</Text></TouchableOpacity>
          {loading&&<TouchableOpacity onPress={()=>{abortRef.current?.abort();Speech.stop();setLoading(false);}} style={s.iconBtn}><Text style={{fontSize:14,color:'#E05555'}}>■</Text></TouchableOpacity>}
        </View>
      </View>
      {mode==='direct'&&(<ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.tabsScroll} contentContainerStyle={s.tabsContent}>
        {PERSONA_LIST.map(p=>(<TouchableOpacity key={p.id} style={[s.tab,activePersona===p.id&&{borderBottomColor:p.color,borderBottomWidth:2}]} onPress={()=>setActivePersona(p.id)}>
          <View style={[s.tabAvatar,{borderColor:p.color}]}><Text style={[s.tabAvatarText,{color:p.color}]}>{p.icon}</Text></View>
          <Text style={[s.tabName,activePersona===p.id&&{color:p.color}]}>{p.name.split('.').filter(Boolean)[0]}</Text>
        </TouchableOpacity>))}
      </ScrollView>)}
      {showModeBar&&(<View style={s.modeBar}><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.modeBarContent}>
        {['direct','council','empire','custom'].map(m=>(<TouchableOpacity key={m} style={[s.modeBtn,mode===m&&s.modeBtnActive]} onPress={()=>{setMode(m);if(m==='custom')setShowCustomPicker(true);setShowModeBar(false);}}><Text style={[s.modeBtnText,mode===m&&{color:'#E8C98A'}]}>{m.toUpperCase()}</Text></TouchableOpacity>))}
        {mode!=='direct'&&<><TouchableOpacity style={[s.modeBtn,continuous&&{borderColor:'#4CAF50',backgroundColor:'#4CAF5011'}]} onPress={()=>setContinuous(v=>!v)}><Text style={[s.modeBtnText,continuous&&{color:'#4CAF50'}]}>⟳ LIVE</Text></TouchableOpacity><TouchableOpacity style={[s.modeBtn,{borderColor:'#E0555533'}]} onPress={interject}><Text style={s.modeBtnText}>✋ INTERJECT</Text></TouchableOpacity></>}
      </ScrollView></View>)}
      <FlatList ref={flatRef} data={displayMessages} keyExtractor={i=>i.id} renderItem={renderMsg} contentContainerStyle={s.msgList} style={{flex:1}} onContentSizeChange={()=>flatRef.current?.scrollToEnd({animated:true})}/>
      {loading&&(<View style={s.thinking}><ActivityIndicator size="small" color={mode==='direct'?currentPersona.color:'#E8C98A'}/><Text style={[s.thinkText,{color:mode==='direct'?currentPersona.color:'#E8C98A'}]}>{mode==='direct'?`${currentPersona.name} is responding...`:'Council speaking...'}</Text></View>)}
      <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':'height'}>
        <View style={s.inputRow}>
          <TextInput style={s.input} value={input} onChangeText={setInput} placeholder={mode==='direct'?'Speak your directive...':'Speak to the council...'} placeholderTextColor="#222" multiline maxLength={2000}/>
          <TouchableOpacity style={[s.sendBtn,{backgroundColor:mode==='direct'?currentPersona.color:'#E8C98A'}]} onPress={send} disabled={loading||!input.trim()}><Text style={s.sendText}>▶</Text></TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
      <Modal visible={showCustomPicker} transparent animationType="slide">
        <View style={s.modalOver}><View style={s.modalContent}>
          <Text style={s.modalTitle}>CHOOSE YOUR TEAM</Text>
          <ScrollView style={{maxHeight:350}}>
            {PERSONA_LIST.map(p=>{const sel=selectedCustom.includes(p.id);return(<TouchableOpacity key={p.id} style={[s.pItem,sel&&{borderColor:p.color}]} onPress={()=>setSelectedCustom(prev=>prev.includes(p.id)?prev.filter(id=>id!==p.id):[...prev,p.id])}>
              <View style={[s.pCheck,sel&&{backgroundColor:p.color}]}>{sel&&<Text style={{fontSize:10,color:'#000',fontWeight:'700'}}>✓</Text>}</View>
              <Text style={[s.pName,{color:p.color}]}>{p.name}</Text>
              <Text style={s.pRole}>{p.role}</Text>
            </TouchableOpacity>);})}
          </ScrollView>
          <View style={s.modalBtns}>
            <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#E8C98A'}]} onPress={()=>{if(selectedCustom.length>=2){setCustomPersonas(selectedCustom);setMode('custom');setShowCustomPicker(false);}}}><Text style={[s.modalBtnT,{color:'#000'}]}>LAUNCH</Text></TouchableOpacity>
            <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={()=>setShowCustomPicker(false)}><Text style={[s.modalBtnT,{color:'#555'}]}>CANCEL</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>
    </SafeAreaView>
  );
}
const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingVertical:10,borderBottomWidth:1,gap:10},
  backBtn:{padding:4},backText:{fontSize:20,color:'#E8C98A'},
  headerCenter:{flex:1},headerName:{fontFamily:'monospace',fontSize:13,fontWeight:'700',letterSpacing:1,color:'#E8C98A'},headerRole:{fontFamily:'monospace',fontSize:8,color:'#444',letterSpacing:2,marginTop:2},
  headerActions:{flexDirection:'row',gap:6},iconBtn:{padding:8},
  tabsScroll:{borderBottomWidth:1,borderBottomColor:'#0D0D0D',maxHeight:64},
  tabsContent:{paddingHorizontal:8,paddingVertical:8,gap:2},
  tab:{alignItems:'center',paddingHorizontal:10,paddingBottom:4},
  tabAvatar:{width:28,height:28,borderRadius:14,borderWidth:1.5,alignItems:'center',justifyContent:'center',marginBottom:3},
  tabAvatarText:{fontFamily:'monospace',fontSize:9,fontWeight:'700'},
  tabName:{fontFamily:'monospace',fontSize:7,color:'#333',letterSpacing:1},
  modeBar:{backgroundColor:'#080808',borderBottomWidth:1,borderBottomColor:'#111'},
  modeBarContent:{padding:8,gap:6},
  modeBtn:{paddingHorizontal:12,paddingVertical:6,borderRadius:4,borderWidth:1,borderColor:'#1A1A1A'},
  modeBtnActive:{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'},modeBtnText:{fontFamily:'monospace',fontSize:9,color:'#444',letterSpacing:1},
  msgList:{padding:14,gap:10,paddingBottom:8},
  userBubble:{alignSelf:'flex-end',backgroundColor:'#131313',borderRadius:16,borderBottomRightRadius:4,padding:12,maxWidth:'82%',borderWidth:1,borderColor:'#1A1A1A'},
  userText:{color:'#DDD',fontSize:15,lineHeight:22},
  aiBubble:{alignSelf:'flex-start',backgroundColor:'#080808',borderRadius:16,borderBottomLeftRadius:4,padding:14,maxWidth:'90%',borderWidth:1,borderColor:'#111'},
  aiName:{fontFamily:'monospace',fontSize:9,fontWeight:'700',letterSpacing:2,marginBottom:3},
  aiLine:{height:1,width:12,opacity:0.5,marginBottom:8},aiText:{color:'#CCC',fontSize:15,lineHeight:23},
  sysBubble:{alignSelf:'center',backgroundColor:'#0A0A0A',borderRadius:6,padding:8,maxWidth:'90%'},
  sysText:{color:'#333',fontSize:10,fontFamily:'monospace',textAlign:'center',letterSpacing:2},
  thinking:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:16,paddingVertical:6},
  thinkText:{fontFamily:'monospace',fontSize:10,letterSpacing:1},
  inputRow:{flexDirection:'row',alignItems:'flex-end',padding:10,gap:8,borderTopWidth:1,borderTopColor:'#0D0D0D'},
  input:{flex:1,backgroundColor:'#080808',borderWidth:1,borderColor:'#151515',borderRadius:10,paddingHorizontal:14,paddingVertical:10,color:'#DDD',fontSize:15,maxHeight:120},
  sendBtn:{width:44,height:44,borderRadius:10,alignItems:'center',justifyContent:'center'},sendText:{fontSize:16,color:'#000',fontWeight:'700'},
  modalOver:{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'},
  modalContent:{backgroundColor:'#0A0A0A',borderTopWidth:1,borderTopColor:'#1A1A1A',borderTopLeftRadius:16,borderTopRightRadius:16,padding:24},
  modalTitle:{fontFamily:'monospace',fontSize:13,color:'#E8C98A',letterSpacing:3,marginBottom:16},
  pItem:{flexDirection:'row',alignItems:'center',gap:12,padding:12,marginBottom:6,borderRadius:6,borderWidth:1,borderColor:'#111'},
  pCheck:{width:18,height:18,borderRadius:3,borderWidth:1,borderColor:'#333',alignItems:'center',justifyContent:'center'},
  pName:{fontFamily:'monospace',fontSize:10,fontWeight:'700',flex:1},pRole:{fontFamily:'monospace',fontSize:8,color:'#333'},
  modalBtns:{flexDirection:'row',gap:10,marginTop:16},
  modalBtn:{flex:1,padding:14,borderRadius:8,alignItems:'center'},modalBtnT:{fontFamily:'monospace',fontSize:11,fontWeight:'700',letterSpacing:2},
});
