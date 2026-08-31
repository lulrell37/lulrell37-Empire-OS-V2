import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,Alert,Modal}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{Swipeable}from 'react-native-gesture-handler';
import{getAllPersonaMemory,getAllNotes,deleteNote,deletePersonaMemory}from '../services/database';
import{getPersona}from '../personas/personas';
import{categoryMeta}from '../services/memoryCategories';

export default function MemoryScreen({navigation}){
  const[memories,setMemories]=useState([]);const[notes,setNotes]=useState([]);const[tab,setTab]=useState('MEMORY');
  const[open,setOpen]=useState(null); // memory being read in full
  const[undo,setUndo]=useState(null); // {mem} — a just-swiped memory, restorable for a few seconds
  const undoTimer=useRef(null);
  const pendingRef=useRef(null); // memory awaiting the hard delete
  useEffect(()=>{load();return()=>{
    if(undoTimer.current){clearTimeout(undoTimer.current);if(pendingRef.current)deletePersonaMemory(pendingRef.current.id).catch(()=>{});}
  };},[]);
  async function load(){const m=await getAllPersonaMemory();const n=await getAllNotes();setMemories(m);setNotes(n);}
  async function handleDeleteNote(id){Alert.alert('Delete Note','Remove this note?',[{text:'Cancel'},{text:'Delete',style:'destructive',onPress:async()=>{await deleteNote(id);const n=await getAllNotes();setNotes(n);}}]);}

  // Swipe a memory away: drop it from the list immediately, commit the DB delete
  // after a short grace period unless the user taps UNDO.
  function swipeAwayMemory(mem){
    if(pendingRef.current){clearTimeout(undoTimer.current);deletePersonaMemory(pendingRef.current.id).catch(()=>{});}
    setMemories(prev=>prev.filter(x=>x.id!==mem.id));
    pendingRef.current=mem;
    setUndo({mem});
    undoTimer.current=setTimeout(()=>{deletePersonaMemory(mem.id).catch(()=>{});pendingRef.current=null;setUndo(null);undoTimer.current=null;},4500);
  }
  function undoMemory(){
    if(!undo)return;
    if(undoTimer.current){clearTimeout(undoTimer.current);undoTimer.current=null;}
    pendingRef.current=null;
    setMemories(prev=>[undo.mem,...prev].sort((a,b)=>(b.created_at||0)-(a.created_at||0)));
    setUndo(null);
  }

  return(
    <SafeAreaView style={s.c} edges={['top','bottom']}>
      <View style={s.hdr}><TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity><Text style={s.title}>THE LIBRARY</Text><View style={{width:30}}/></View>
      <View style={s.tabs}>{['MEMORY','NOTES'].map(t=>(<TouchableOpacity key={t} style={[s.tab,tab===t&&s.tabA]} onPress={()=>setTab(t)}><Text style={[s.tabT,tab===t&&s.tabTA]}>{t}</Text></TouchableOpacity>))}</View>
      <ScrollView style={{flex:1}}>
        {tab==='MEMORY'&&<View style={s.sec}>
          <Text style={s.secTitle}>CONVERSATION MEMORY</Text>
          <Text style={s.secSub}>EVERY EXCHANGE, KEPT RAW · SWIPE A MEMORY AWAY TO DELETE · TAP FOR THE MAP</Text>
          {memories.length===0&&<Text style={s.empty}>No memory yet. Start talking to your personas.</Text>}
          {memories.map(m=>{const p=getPersona(m.persona);const cat=m.category?categoryMeta(m.category):null;return(
            <Swipeable key={m.id} friction={1.6} rightThreshold={44}
              renderRightActions={()=>(<View style={s.swipeDel}><Text style={s.swipeDelT}>DELETE</Text></View>)}
              onSwipeableOpen={()=>swipeAwayMemory(m)}>
              <TouchableOpacity style={s.memCard} activeOpacity={0.7} onPress={()=>setOpen(m)}>
                <View style={s.memHdr}>
                  <Text style={[s.memPersona,{color:p.color}]}>{p.name}</Text>
                  <View style={{flexDirection:'row',alignItems:'center',gap:8}}>
                    {cat&&<Text style={[s.memCat,{color:cat.color,borderColor:cat.color+'55'}]}>{cat.label.toUpperCase()}</Text>}
                    <Text style={s.memDate}>{m.date}</Text>
                  </View>
                </View>
                <Text style={s.memContent} numberOfLines={5}>{m.content}</Text>
              </TouchableOpacity>
            </Swipeable>
          );})}
        </View>}
        {tab==='NOTES'&&<View style={s.sec}>
          <Text style={s.secTitle}>SAVED NOTES</Text>
          <Text style={s.secSub}>CREATED BY PERSONAS</Text>
          {notes.length===0&&<Text style={s.empty}>No notes yet. Ask a persona to save something.</Text>}
          {notes.map(n=>(<View key={n.id} style={s.noteCard}><View style={s.noteHdr}><Text style={s.noteTitle}>{n.title}</Text><TouchableOpacity onPress={()=>handleDeleteNote(n.id)}><Text style={{color:'#333',fontSize:16}}>×</Text></TouchableOpacity></View>{n.persona&&<Text style={s.notePersona}>{getPersona(n.persona)?.name||n.persona}</Text>}<Text style={s.noteContent} numberOfLines={5}>{n.content}</Text></View>))}
        </View>}
      </ScrollView>
      {undo&&<TouchableOpacity style={s.undoBar} activeOpacity={0.8} onPress={undoMemory}>
        <Text style={s.undoT}>Memory deleted</Text>
        <Text style={s.undoAction}>UNDO</Text>
      </TouchableOpacity>}

      <Modal visible={!!open} transparent animationType="fade" onRequestClose={()=>setOpen(null)}>
        <View style={s.modalOver}><View style={s.modalCard}>
          <View style={s.modalHdr}>
            <Text style={[s.memPersona,{color:getPersona(open?.persona)?.color||'#E8C98A',flex:1}]}>{getPersona(open?.persona)?.name}</Text>
            <Text style={s.memDate}>{open?.date}</Text>
            <TouchableOpacity onPress={()=>setOpen(null)}><Text style={{color:'#666',fontSize:20}}>×</Text></TouchableOpacity>
          </View>
          <ScrollView style={{maxHeight:'72%'}} contentContainerStyle={{padding:16}}><Text style={s.modalBody} selectable>{open?.content}</Text></ScrollView>
          <TouchableOpacity style={s.modalDel} onPress={()=>{if(open){deletePersonaMemory(open.id).catch(()=>{});setMemories(prev=>prev.filter(x=>x.id!==open.id));setOpen(null);}}}>
            <Text style={s.modalDelT}>DELETE THIS MEMORY</Text>
          </TouchableOpacity>
        </View></View>
      </Modal>
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
  memCat:{fontFamily:'monospace',fontSize:7,letterSpacing:1,borderWidth:1,borderRadius:3,paddingHorizontal:4,paddingVertical:1},
  memContent:{color:'#444',fontSize:12,lineHeight:18},
  swipeDel:{backgroundColor:'#C7614B',justifyContent:'center',alignItems:'flex-end',paddingHorizontal:22,marginBottom:10,borderRadius:6,flex:1},
  swipeDelT:{fontFamily:'monospace',fontSize:10,color:'#000',fontWeight:'700',letterSpacing:2},
  noteCard:{backgroundColor:'#060606',borderWidth:1,borderColor:'#111',borderRadius:6,padding:14,marginBottom:10},
  noteHdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:4},
  noteTitle:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',fontWeight:'700',flex:1},
  notePersona:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1,marginBottom:8},noteContent:{color:'#555',fontSize:12,lineHeight:18},
  undoBar:{position:'absolute',left:16,right:16,bottom:16,backgroundColor:'#161616',borderWidth:1,borderColor:'#2A2A2A',borderRadius:8,flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:12},
  undoT:{fontFamily:'monospace',fontSize:10,color:'#999',letterSpacing:1},
  undoAction:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',fontWeight:'700',letterSpacing:2},
  modalOver:{flex:1,backgroundColor:'rgba(0,0,0,0.9)',justifyContent:'center',padding:20},
  modalCard:{backgroundColor:'#0A0A0A',borderWidth:1,borderColor:'#1A1A1A',borderRadius:12,overflow:'hidden'},
  modalHdr:{flexDirection:'row',alignItems:'center',gap:10,padding:12,borderBottomWidth:1,borderBottomColor:'#141414'},
  modalBody:{color:'#CCC',fontSize:14,lineHeight:22},
  modalDel:{borderTopWidth:1,borderTopColor:'#141414',paddingVertical:13,alignItems:'center'},
  modalDelT:{fontFamily:'monospace',fontSize:9,color:'#C7614B',letterSpacing:2},
});
