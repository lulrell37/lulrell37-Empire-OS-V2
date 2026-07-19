import React,{useState,useRef,useEffect}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,FlatList,KeyboardAvoidingView,Platform,ActivityIndicator,Modal,ScrollView}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import*as Speech from 'expo-speech';
import{PERSONAS,COUNCIL_PERSONAS,EMPIRE_PERSONAS,getPersona}from '../personas/personas';
import{callPersona}from '../services/aiService';
import{handleCommands,stripCommands}from '../services/commandHandler';
import{saveMessage}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
export default function CouncilScreen({navigation}){
  const[mode,setMode]=useState('council');const[messages,setMessages]=useState([]);
  const[input,setInput]=useState('');const[loading,setLoading]=useState(false);
  const[voiceOn,setVoiceOn]=useState(true);const[continuous,setContinuous]=useState(false);
  const[showPicker,setShowPicker]=useState(false);const[customSel,setCustomSel]=useState([]);
  const[targets,setTargets]=useState(COUNCIL_PERSONAS);
  const flatRef=useRef(null);const abortRef=useRef(null);const contRef=useRef(false);
  const{addRelay}=useEmpireStore();
  useEffect(()=>{contRef.current=continuous;},[continuous]);
  function getT(m,c){return m==='council'?COUNCIL_PERSONAS:m==='empire'?EMPIRE_PERSONAS:c;}
  function switchMode(id){if(id==='custom'){setShowPicker(true);}else{setMode(id);setTargets(getT(id,[]));}}
  function launch(){if(customSel.length<2)return;setMode('custom');setTargets(customSel);setShowPicker(false);}
  function reorder(msg,tgts){
    const lower=msg.toLowerCase().trim();
    for(const id of tgts){if(new RegExp(`^${id}[,\\.!?\\s]`,'i').test(lower))return[id,...tgts.filter(t=>t!==id)];}
    return tgts;
  }
  async function send(msg){
    const text=(msg||input).trim();if(!text||loading)return;if(!msg)setInput('');
    setMessages(prev=>[...prev,{id:Date.now().toString(),role:'user',content:text,persona:'user'}]);
    await runRound(text);
  }
  async function runRound(userText){
    setLoading(true);abortRef.current=new AbortController();
    const ordered=reorder(userText,targets);const replies=[];
    try{
      for(const pid of ordered){
        if(abortRef.current?.signal.aborted)break;
        const p=getPersona(pid);
        const hist=messages.slice(-15).map(m=>({role:m.role==='user'||m.role==='assistant'?m.role:'user',content:m.content}));
        hist.push({role:'user',content:userText});
        if(replies.length>0){hist.push({role:'user',content:`[PRIOR REPLIES:\n${replies.map(r=>`${r.name}: ${r.text}`).join('\n\n')}\nRespond and acknowledge others if relevant. Be brief.]`});}
        const response=await callPersona(pid,hist,abortRef.current?.signal);
        const display=stripCommands(response);
        setMessages(prev=>[...prev,{id:`${Date.now()}-${pid}`,role:'assistant',content:display||response,persona:pid}]);
        await saveMessage(pid,'assistant',display||response,mode);
        replies.push({name:p.name,text:display||response});
        await handleCommands(response,pid,{onRelay:({target,message})=>addRelay(target,`[From ${p.name}]: ${message}`)});
        if(voiceOn&&display){Speech.speak(display.substring(0,400),{language:'en-US',rate:0.95});}
      }
    }catch(e){if(e.name!=='AbortError'){setMessages(prev=>[...prev,{id:Date.now().toString(),role:'system',content:`Error: ${e.message}`,persona:'system'}]);}}
    finally{setLoading(false);setTimeout(()=>flatRef.current?.scrollToEnd({animated:true}),100);}
    if(contRef.current&&!abortRef.current?.signal.aborted){
      setTimeout(()=>{if(contRef.current)runRound('[Continue the discussion. Build on what was said. Work through the problem. Be direct and brief.]');},1200);
    }
  }
  function interject(){abortRef.current?.abort();setContinuous(false);contRef.current=false;Speech.stop();setLoading(false);setMessages(prev=>[...prev,{id:Date.now().toString(),role:'system',content:'— YOU HAVE THE FLOOR —',persona:'system'}]);}
  function renderMessage({item}){
    if(item.role==='user')return(<View style={s.ub}><Text style={s.ut}>{item.content}</Text></View>);
    if(item.role==='system')return(<View style={s.syb}><Text style={s.syt}>{item.content}</Text></View>);
    const p=getPersona(item.persona);
    return(<View style={s.ab}>
      <View style={s.ah}><View style={[s.av,{borderColor:p.color}]}><Text style={[s.avt,{color:p.color}]}>{p.icon}</Text></View><View><Text style={[s.an,{color:p.color}]}>{p.name}</Text><Text style={s.ar}>{p.role}</Text></View></View>
      <Text style={s.at}>{item.content}</Text>
    </View>);
  }
  const ml=mode==='custom'?`CUSTOM · ${targets.map(id=>getPersona(id).name.split('.')[0]).join(' · ')}`:mode.toUpperCase();
  return(<SafeAreaView style={s.c} edges={['top','bottom']}>
    <View style={s.hdr}>
      <TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity>
      <View style={{flex:1,alignItems:'center'}}><Text style={s.ml}>{ml}</Text><Text style={s.ms}>WAR ROOM</Text></View>
      <TouchableOpacity onPress={()=>setVoiceOn(v=>!v)}><Text style={{fontSize:18,color:voiceOn?'#E8C98A':'#333'}}>{voiceOn?'🔊':'🔇'}</Text></TouchableOpacity>
    </View>
    <View style={s.mb}>
      {['council','empire','custom'].map(m=>(<TouchableOpacity key={m} style={[s.mbt,mode===m&&s.mbta]} onPress={()=>switchMode(m)}><Text style={[s.mbtt,mode===m&&{color:'#E8C98A'}]}>{m.toUpperCase()}</Text></TouchableOpacity>))}
      <TouchableOpacity style={[s.mbt,continuous&&{borderColor:'#4CAF50',backgroundColor:'#4CAF5011'}]} onPress={()=>setContinuous(v=>!v)}><Text style={[s.mbtt,continuous&&{color:'#4CAF50'}]}>LIVE</Text></TouchableOpacity>
      <TouchableOpacity style={[s.mbt,{borderColor:'#E0555533',backgroundColor:'#E0555511'}]} onPress={interject}><Text style={{fontSize:14}}>✋</Text></TouchableOpacity>
    </View>
    <FlatList ref={flatRef} data={messages} keyExtractor={i=>i.id} renderItem={renderMessage} contentContainerStyle={s.msl} style={{flex:1}}/>
    {loading&&<View style={s.think}><ActivityIndicator size="small" color="#E8C98A"/><Text style={s.tht}>Council speaking...</Text></View>}
    <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':'height'}>
      <View style={s.ir}>
        <TextInput style={s.input} value={input} onChangeText={setInput} placeholder="Speak to the council..." placeholderTextColor="#333" multiline maxLength={2000}/>
        <TouchableOpacity style={s.send} onPress={()=>send()} disabled={loading||!input.trim()}><Text style={s.sendT}>▶</Text></TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
    <Modal visible={showPicker} transparent animationType="slide">
      <View style={s.mo}><View style={s.mc}>
        <Text style={s.mtit}>CHOOSE YOUR TEAM</Text>
        <ScrollView style={{maxHeight:350}}>
          {Object.values(PERSONAS).map(p=>{
            const sel=customSel.includes(p.id);
            return(<TouchableOpacity key={p.id} style={[s.pi,sel&&{borderColor:p.color}]} onPress={()=>setCustomSel(prev=>prev.includes(p.id)?prev.filter(id=>id!==p.id):[...prev,p.id])}>
              <View style={[s.pch,sel&&{backgroundColor:p.color}]}>{sel&&<Text style={{fontSize:10,color:'#000',fontWeight:'700'}}>✓</Text>}</View>
              <Text style={[s.pn,{color:p.color}]}>{p.name}</Text>
              <Text style={s.pr}>{p.role}</Text>
            </TouchableOpacity>);
          })}
        </ScrollView>
        <View style={{flexDirection:'row',gap:10,marginTop:16}}>
          <TouchableOpacity style={[s.mbtn,{backgroundColor:'#E8C98A'}]} onPress={launch}><Text style={[s.mbtnt,{color:'#000'}]}>LAUNCH</Text></TouchableOpacity>
          <TouchableOpacity style={[s.mbtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={()=>setShowPicker(false)}><Text style={[s.mbtnt,{color:'#555'}]}>CANCEL</Text></TouchableOpacity>
        </View>
      </View></View>
    </Modal>
  </SafeAreaView>);
}
const s=StyleSheet.create({
  c:{flex:1,backgroundColor:'#000'},
  hdr:{flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#E8C98A22',gap:12},
  back:{fontSize:20,color:'#E8C98A'},ml:{fontFamily:'monospace',fontSize:13,color:'#E8C98A',fontWeight:'700',letterSpacing:2},ms:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:3},
  mb:{flexDirection:'row',padding:10,gap:6,borderBottomWidth:1,borderBottomColor:'#111',flexWrap:'wrap'},
  mbt:{paddingHorizontal:10,paddingVertical:6,borderRadius:6,borderWidth:1,borderColor:'#222'},mbta:{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'},mbtt:{fontFamily:'monospace',fontSize:9,color:'#444',letterSpacing:1},
  msl:{padding:14,gap:14},
  ub:{alignSelf:'flex-end',backgroundColor:'#1A1A1A',borderRadius:16,borderBottomRightRadius:4,padding:12,maxWidth:'82%'},ut:{color:'#DDD',fontSize:15,lineHeight:22},
  ab:{alignSelf:'flex-start',backgroundColor:'#090909',borderRadius:16,borderBottomLeftRadius:4,padding:14,maxWidth:'92%',borderWidth:1,borderColor:'#1A1A1A'},
  ah:{flexDirection:'row',alignItems:'center',gap:10,marginBottom:10},av:{width:28,height:28,borderRadius:14,borderWidth:1.5,alignItems:'center',justifyContent:'center'},avt:{fontFamily:'monospace',fontSize:10,fontWeight:'700'},
  an:{fontFamily:'monospace',fontSize:11,fontWeight:'700',letterSpacing:1},ar:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1},at:{color:'#CCC',fontSize:14,lineHeight:22},
  syb:{alignSelf:'center',backgroundColor:'#0D0D0D',borderRadius:8,padding:8,maxWidth:'90%'},syt:{color:'#333',fontSize:10,fontFamily:'monospace',textAlign:'center',letterSpacing:2},
  think:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:16,paddingVertical:8},tht:{fontFamily:'monospace',fontSize:11,color:'#E8C98A',letterSpacing:1},
  ir:{flexDirection:'row',alignItems:'flex-end',padding:12,gap:10,borderTopWidth:1,borderTopColor:'#111'},
  input:{flex:1,backgroundColor:'#0D0D0D',borderWidth:1,borderColor:'#1E1E1E',borderRadius:12,paddingHorizontal:14,paddingVertical:10,color:'#DDD',fontSize:15,maxHeight:120},
  send:{width:44,height:44,borderRadius:12,backgroundColor:'#E8C98A',alignItems:'center',justifyContent:'center'},sendT:{fontSize:16,color:'#000',fontWeight:'700'},
  mo:{flex:1,backgroundColor:'rgba(0,0,0,0.9)',justifyContent:'flex-end'},mc:{backgroundColor:'#0D0D0D',borderTopWidth:1,borderTopColor:'#222',borderTopLeftRadius:20,borderTopRightRadius:20,padding:24},
  mtit:{fontFamily:'monospace',fontSize:14,color:'#E8C98A',letterSpacing:3,marginBottom:16},
  pi:{flexDirection:'row',alignItems:'center',gap:12,padding:12,marginBottom:8,borderRadius:8,borderWidth:1,borderColor:'#1A1A1A'},
  pch:{width:18,height:18,borderRadius:4,borderWidth:1,borderColor:'#333',alignItems:'center',justifyContent:'center'},
  pn:{fontFamily:'monospace',fontSize:11,fontWeight:'700',flex:1},pr:{fontFamily:'monospace',fontSize:8,color:'#333'},
  mbtn:{flex:1,padding:14,borderRadius:8,alignItems:'center',justifyContent:'center'},mbtnt:{fontFamily:'monospace',fontSize:12,fontWeight:'700',letterSpacing:2},
});
