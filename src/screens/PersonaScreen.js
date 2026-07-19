import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,TextInput,TouchableOpacity,FlatList,KeyboardAvoidingView,Platform,ActivityIndicator}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import*as Speech from 'expo-speech';
import{getPersona}from '../personas/personas';
import{callPersona}from '../services/aiService';
import{handleCommands,stripCommands}from '../services/commandHandler';
import{getMessages,saveMessage}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
export default function PersonaScreen({route,navigation}){
  const{personaId}=route.params;const persona=getPersona(personaId);
  const[input,setInput]=useState('');const[messages,setMessages]=useState([]);
  const[loading,setLoading]=useState(false);const[voiceOn,setVoiceOn]=useState(true);
  const flatRef=useRef(null);const abortRef=useRef(null);
  const{addRelay}=useEmpireStore();
  useEffect(()=>{loadHistory();},[personaId]);
  async function loadHistory(){
    const h=await getMessages(personaId,30);
    setMessages(h.reverse().map(m=>({id:m.id.toString(),role:m.role,content:m.content})));
  }
  async function send(){
    const text=input.trim();if(!text||loading)return;
    setInput('');
    const userMsg={id:Date.now().toString(),role:'user',content:text};
    setMessages(prev=>[...prev,userMsg]);
    await saveMessage(personaId,'user',text,'direct');
    setLoading(true);abortRef.current=new AbortController();
    try{
      const hist=messages.slice(-20).map(m=>({role:m.role==='system'?'user':m.role,content:m.content}));
      hist.push({role:'user',content:text});
      const response=await callPersona(personaId,hist,abortRef.current.signal);
      const display=stripCommands(response);
      const aiMsg={id:(Date.now()+1).toString(),role:'assistant',content:display||response};
      setMessages(prev=>[...prev,aiMsg]);
      await saveMessage(personaId,'assistant',display||response,'direct');
      await handleCommands(response,personaId,{onRelay:({target,message})=>addRelay(target,`[From ${persona.name}]: ${message}`)});
      if(voiceOn&&display){Speech.speak(display.substring(0,500),{language:'en-US',rate:0.95});}
    }catch(e){
      if(e.name!=='AbortError'){setMessages(prev=>[...prev,{id:(Date.now()+1).toString(),role:'system',content:`Error: ${e.message}`}]);}
    }finally{setLoading(false);}
    setTimeout(()=>flatRef.current?.scrollToEnd({animated:true}),100);
  }
  function renderMessage({item}){
    if(item.role==='user')return(<View style={s.ub}><Text style={s.ut}>{item.content}</Text></View>);
    if(item.role==='system')return(<View style={s.sb}><Text style={s.st}>{item.content}</Text></View>);
    return(<View style={s.ab}>
      <Text style={[s.al,{color:persona.color}]}>{persona.name}</Text>
      <View style={[s.aline,{backgroundColor:persona.color}]}/>
      <Text style={s.at}>{item.content}</Text>
    </View>);
  }
  return(<SafeAreaView style={s.c} edges={['top','bottom']}>
    <View style={[s.hdr,{borderBottomColor:persona.color+'44'}]}>
      <TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity>
      <View style={s.hi}><Text style={[s.pn,{color:persona.color}]}>{persona.name}</Text><Text style={s.pr}>{persona.role}</Text></View>
      <View style={{flexDirection:'row',gap:8}}>
        <TouchableOpacity onPress={()=>setVoiceOn(v=>!v)}><Text style={{fontSize:18,color:voiceOn?persona.color:'#444'}}>{voiceOn?'🔊':'🔇'}</Text></TouchableOpacity>
        {loading&&<TouchableOpacity onPress={()=>{abortRef.current?.abort();Speech.stop();setLoading(false);}}><Text style={{fontSize:16,color:'#E05555'}}>■</Text></TouchableOpacity>}
      </View>
    </View>
    <FlatList ref={flatRef} data={messages} keyExtractor={i=>i.id} renderItem={renderMessage} contentContainerStyle={s.ml} style={{flex:1}} onContentSizeChange={()=>flatRef.current?.scrollToEnd({animated:true})}/>
    {loading&&<View style={s.think}><ActivityIndicator size="small" color={persona.color}/><Text style={[s.tht,{color:persona.color}]}>{persona.name} is responding...</Text></View>}
    <KeyboardAvoidingView behavior={Platform.OS==='ios'?'padding':'height'}>
      <View style={s.ir}>
        <TextInput style={s.input} value={input} onChangeText={setInput} placeholder="Speak your directive..." placeholderTextColor="#333" multiline maxLength={2000}/>
        <TouchableOpacity style={[s.send,{backgroundColor:persona.color}]} onPress={send} disabled={loading||!input.trim()}><Text style={s.sendT}>▶</Text></TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  </SafeAreaView>);
}
const s=StyleSheet.create({
  c:{flex:1,backgroundColor:'#000'},
  hdr:{flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,gap:12},
  back:{fontSize:20,color:'#E8C98A'},hi:{flex:1},
  pn:{fontFamily:'monospace',fontSize:14,fontWeight:'700',letterSpacing:1},
  pr:{fontFamily:'monospace',fontSize:9,color:'#444',letterSpacing:2,marginTop:2},
  ml:{padding:16,gap:12,paddingBottom:8},
  ub:{alignSelf:'flex-end',backgroundColor:'#1A1A1A',borderRadius:16,borderBottomRightRadius:4,padding:12,maxWidth:'82%'},
  ut:{color:'#DDD',fontSize:15,lineHeight:22},
  ab:{alignSelf:'flex-start',backgroundColor:'#090909',borderRadius:16,borderBottomLeftRadius:4,padding:14,maxWidth:'90%',borderWidth:1,borderColor:'#1A1A1A'},
  al:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:2,marginBottom:4},
  aline:{height:1,width:14,opacity:0.5,marginBottom:8},at:{color:'#CCC',fontSize:15,lineHeight:23},
  sb:{alignSelf:'center',backgroundColor:'#0D0D0D',borderRadius:8,padding:10,maxWidth:'90%'},
  st:{color:'#555',fontSize:12,fontFamily:'monospace',textAlign:'center'},
  think:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:16,paddingVertical:8},
  tht:{fontFamily:'monospace',fontSize:11,letterSpacing:1},
  ir:{flexDirection:'row',alignItems:'flex-end',padding:12,gap:10,borderTopWidth:1,borderTopColor:'#111'},
  input:{flex:1,backgroundColor:'#0D0D0D',borderWidth:1,borderColor:'#1E1E1E',borderRadius:12,paddingHorizontal:14,paddingVertical:10,color:'#DDD',fontSize:15,maxHeight:120},
  send:{width:44,height:44,borderRadius:12,alignItems:'center',justifyContent:'center'},
  sendT:{fontSize:16,color:'#000',fontWeight:'700'},
});
