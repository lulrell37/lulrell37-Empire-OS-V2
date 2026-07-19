import React,{useState,useEffect}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,Alert}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{getAllPersonaMemory,getAllNotes,deleteNote}from '../services/database';
import{getPersona}from '../personas/personas';
export default function MemoryScreen({navigation}){
  const[memories,setMemories]=useState([]);const[notes,setNotes]=useState([]);const[tab,setTab]=useState('MEMORY');
  useEffect(()=>{load();},[]);
  async function load(){const m=await getAllPersonaMemory();const n=await getAllNotes();setMemories(m);setNotes(n);}
  async function handleDeleteNote(id){Alert.alert('Delete Note','Remove this note?',[{text:'Cancel'},{text:'Delete',style:'destructive',onPress:async()=>{await deleteNote(id);const n=await getAllNotes();setNotes(n);}}]);}
  return(
    <SafeAreaView style={s.c} edges={['top','bottom']}>
      <View style={s.hdr}><TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity><Text style={s.title}>THE LIBRARY</Text><View style={{width:30}}/></View>
      <View style={s.tabs}>{['MEMORY','NOTES'].map(t=>(<TouchableOpacity key={t} style={[s.tab,tab===t&&s.tabA]} onPress={()=>setTab(t)}><Text style={[s.tabT,tab===t&&s.tabTA]}>{t}</Text></TouchableOpacity>))}</View>
      <ScrollView style={{flex:1}}>
        {tab==='MEMORY'&&<View style={s.sec}>
          <Text style={s.secTitle}>CONVERSATION MEMORY</Text>
          <Text style={s.secSub}>LAST 14 DAYS PER PERSONA</Text>
          {memories.length===0&&<Text style={s.empty}>No memory yet. Start talking to your personas.</Text>}
          {memories.map(m=>{const p=getPersona(m.persona);return(<View key={m.id} style={s.memCard}><View style={s.memHdr}><Text style={[s.memPersona,{color:p.color}]}>{p.name}</Text><Text style={s.memDate}>{m.date}</Text></View><Text style={s.memContent} numberOfLines={4}>{m.content}</Text></View>);})}
        </View>}
        {tab==='NOTES'&&<View style={s.sec}>
          <Text style={s.secTitle}>SAVED NOTES</Text>
          <Text style={s.secSub}>CREATED BY PERSONAS</Text>
          {notes.length===0&&<Text style={s.empty}>No notes yet. Ask a persona to save something.</Text>}
          {notes.map(n=>(<View key={n.id} style={s.noteCard}><View style={s.noteHdr}><Text style={s.noteTitle}>{n.title}</Text><TouchableOpacity onPress={()=>handleDeleteNote(n.id)}><Text style={{color:'#333',fontSize:16}}>×</Text></TouchableOpacity></View>{n.persona&&<Text style={s.notePersona}>{getPersona(n.persona)?.name||n.persona}</Text>}<Text style={s.noteContent} numberOfLines={5}>{n.content}</Text></View>))}
        </View>}
      </ScrollView>
    </SafeAreaView>
  );
}
const s=StyleSheet.create({
  c:{flex:1,backgroundColor:'#000'},
  hdr:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  back:{fontSize:20,color:'#E8C98A'},title:{fontFamily:'monospace',fontSize:13,color:'#E8C98A',fontWeight:'700',letterSpacing:3},
  tabs:{flexDirection:'row',borderBottomWidth:1,borderBottomColor:'#0D0D0D',paddingHorizontal:16,paddingTop:8,gap:8},
  tab:{paddingHorizontal:16,paddingVertical:6,borderRadius:4,borderWidth:1,borderColor:'#111',marginBottom:8},
  tabA:{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'},tabT:{fontFamily:'monospace',fontSize:9,color:'#333',letterSpacing:1},tabTA:{color:'#E8C98A'},
  sec:{padding:16},secTitle:{fontFamily:'monospace',fontSize:11,color:'#E8C98A',letterSpacing:3,marginBottom:2},secSub:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:2,marginBottom:16},
  empty:{fontFamily:'monospace',fontSize:10,color:'#222',textAlign:'center',marginTop:40,letterSpacing:1,lineHeight:20},
  memCard:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,padding:14,marginBottom:10},
  memHdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:8},
  memPersona:{fontFamily:'monospace',fontSize:9,fontWeight:'700',letterSpacing:2},memDate:{fontFamily:'monospace',fontSize:8,color:'#222'},
  memContent:{color:'#444',fontSize:12,lineHeight:18},
  noteCard:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,padding:14,marginBottom:10},
  noteHdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:4},
  noteTitle:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',fontWeight:'700',flex:1},
  notePersona:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1,marginBottom:8},noteContent:{color:'#555',fontSize:12,lineHeight:18},
});
