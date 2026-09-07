// Notes on the Canvas: a list of Mr. Burrus's notes that opens into a full,
// editable note. Backed by services/notesRepo (Drive when Google is connected,
// the local notes table otherwise). Exposes back() so the Canvas header's back
// control pops detail -> list before closing the whole surface.
import React,{useState,useEffect,useCallback,useRef,useImperativeHandle,forwardRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,TextInput,ScrollView,ActivityIndicator,Alert}from 'react-native';
import{Feather}from '@expo/vector-icons';
import{colors}from '../../../theme';
import{listNotes,readNote,writeNote,removeNote}from '../../../services/notesRepo';

function when(ms){
  if(!ms)return '';
  const d=new Date(ms),now=new Date();
  if(d.toDateString()===now.toDateString())return d.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  return d.toLocaleDateString([],{month:'short',day:'numeric'});
}

export default forwardRef(function NotesCanvas({accent=colors.gold,open,onTitle},ref){
  const[list,setList]=useState(null);          // null = loading
  const[mode,setMode]=useState('list');        // 'list' | 'detail'
  const[sel,setSel]=useState(null);            // note ref from listNotes, or null for a new note
  const[doc,setDoc]=useState(null);            // { title, content, source } as loaded/saved
  const[draft,setDraft]=useState('');
  const[titleDraft,setTitleDraft]=useState('');
  const[busy,setBusy]=useState(false);
  const alive=useRef(true);

  const loadList=useCallback(async()=>{
    try{const l=await listNotes();if(alive.current)setList(l);}catch{if(alive.current)setList([]);}
  },[]);

  const openNote=useCallback(async(refItem)=>{
    setMode('detail');setSel(refItem||null);setBusy(true);
    setDoc(null);setDraft('');setTitleDraft('');
    if(!refItem){setBusy(false);return;}   // new note
    try{
      const d=await readNote(refItem);
      if(!alive.current)return;
      setDoc(d);setDraft(d.content||'');setTitleDraft(d.title||'');
    }catch{
      if(alive.current){const t=refItem.title||'';setDoc({title:t,content:'',source:'local'});setTitleDraft(t);}
    }finally{if(alive.current)setBusy(false);}
  },[]);

  useEffect(()=>{
    alive.current=true;loadList();
    return()=>{alive.current=false;};
  },[loadList]);

  // Deep-link: [SHOW_NOTE: title] opens straight into that note, once.
  const didOpen=useRef(false);
  useEffect(()=>{
    if(didOpen.current||!open)return;
    didOpen.current=true;openNote({title:open});
  },[open,openNote]);

  useEffect(()=>{onTitle?.(mode==='detail'?(titleDraft||'New note'):'NOTES');},[mode,titleDraft,onTitle]);

  const baseTitle=doc?doc.title||'':'';
  const baseBody=doc?doc.content||'':'';
  const dirty=mode==='detail'&&(draft!==baseBody||titleDraft!==baseTitle);

  const toList=useCallback(()=>{
    setMode('list');setSel(null);setDoc(null);setDraft('');setTitleDraft('');loadList();
  },[loadList]);

  const attemptBack=useCallback(()=>{
    if(mode!=='detail')return false;
    if(dirty){
      Alert.alert('Discard changes?',undefined,[
        {text:'Keep editing',style:'cancel'},
        {text:'Discard',style:'destructive',onPress:toList},
      ]);
      return true;
    }
    toList();return true;
  },[mode,dirty,toList]);

  useImperativeHandle(ref,()=>({back:attemptBack}),[attemptBack]);

  async function save(){
    if(!titleDraft.trim()){Alert.alert('Give the note a title first.');return;}
    setBusy(true);
    try{
      const res=await writeNote(sel,{title:titleDraft.trim(),content:draft});
      if(!alive.current)return;
      const saved={id:sel?.id||null,title:titleDraft.trim(),content:draft,source:res.source};
      setDoc(saved);
      setSel(res.source==='drive'&&sel?{...sel,title:saved.title}:sel);
    }catch(e){Alert.alert("Couldn't save",e.message||'unknown error');}
    finally{if(alive.current)setBusy(false);}
  }

  function del(){
    Alert.alert('Delete this note?',titleDraft||baseTitle||'',[
      {text:'Cancel',style:'cancel'},
      {text:'Delete',style:'destructive',onPress:async()=>{
        setBusy(true);
        try{if(sel)await removeNote(sel);}catch{}
        if(alive.current){setBusy(false);toList();}
      }},
    ]);
  }

  // ---- detail ----
  if(mode==='detail'){
    return(
      <View style={s.wrap}>
        <TouchableOpacity style={s.crumb} onPress={attemptBack} activeOpacity={0.7}>
          <Feather name="chevron-left" size={14} color={colors.textDim}/>
          <Text style={s.crumbT}>NOTES</Text>
        </TouchableOpacity>
        <TextInput
          style={[s.titleInput,{borderColor:accent+'44'}]}
          value={titleDraft} onChangeText={setTitleDraft}
          placeholder="Title" placeholderTextColor={colors.textFaint}/>
        {busy&&!doc&&sel?(
          <View style={s.loading}><ActivityIndicator color={accent}/></View>
        ):(
          <TextInput
            style={s.body}
            value={draft} onChangeText={setDraft}
            multiline textAlignVertical="top" scrollEnabled
            placeholder="Write…" placeholderTextColor={colors.textFaint}/>
        )}
        <View style={s.actions}>
          {!!sel&&(
            <TouchableOpacity onPress={del} style={s.actBtn} hitSlop={HIT}>
              <Feather name="trash-2" size={15} color={colors.danger}/>
            </TouchableOpacity>
          )}
          <View style={{flex:1}}/>
          {dirty&&!!doc&&(
            <TouchableOpacity onPress={()=>{setDraft(baseBody);setTitleDraft(baseTitle);}} style={s.ghost}>
              <Text style={s.ghostT}>REVERT</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={save} disabled={!dirty||busy} style={[s.save,{backgroundColor:dirty?accent:colors.hairline}]}>
            <Text style={[s.saveT,{color:dirty?colors.bg:colors.textDim}]}>{busy?'SAVING…':'SAVE'}</Text>
          </TouchableOpacity>
        </View>
        {!!doc&&<Text style={s.src}>{doc.source==='drive'?'Google Drive':'On this device'}</Text>}
      </View>
    );
  }

  // ---- list ----
  return(
    <View style={s.wrap}>
      <TouchableOpacity style={[s.newRow,{borderColor:accent+'44'}]} onPress={()=>openNote(null)} activeOpacity={0.7}>
        <Feather name="plus" size={15} color={accent}/>
        <Text style={[s.newT,{color:accent}]}>NEW NOTE</Text>
      </TouchableOpacity>
      {list===null?(
        <View style={s.loading}><ActivityIndicator color={accent}/></View>
      ):list.length===0?(
        <Text style={s.empty}>No notes yet.</Text>
      ):(
        <ScrollView style={{flex:1}} showsVerticalScrollIndicator={false}>
          {list.map(n=>(
            <TouchableOpacity key={n.source+':'+n.id} style={s.row} onPress={()=>openNote(n)} activeOpacity={0.6}>
              <Feather name="file-text" size={14} color={colors.textDim} style={{marginTop:1}}/>
              <View style={{flex:1}}>
                <Text style={s.rowT} numberOfLines={1}>{n.title||'(untitled)'}</Text>
                {!!n.modified&&<Text style={s.rowMeta}>{when(n.modified)}</Text>}
              </View>
              <Feather name="chevron-right" size={14} color={colors.textFaint}/>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
});

const HIT={top:8,bottom:8,left:8,right:8};
const s=StyleSheet.create({
  wrap:{flex:1,padding:12,gap:8},
  newRow:{flexDirection:'row',alignItems:'center',gap:8,borderWidth:1,borderRadius:6,paddingVertical:9,paddingHorizontal:12},
  newT:{fontFamily:'monospace',fontSize:9,letterSpacing:2},
  row:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:10,paddingHorizontal:4,borderBottomWidth:1,borderBottomColor:'#141210'},
  rowT:{fontFamily:'monospace',fontSize:11,color:colors.text},
  rowMeta:{fontFamily:'monospace',fontSize:8,color:colors.textDim,marginTop:2},
  crumb:{flexDirection:'row',alignItems:'center',gap:3,alignSelf:'flex-start',paddingVertical:2},
  crumbT:{fontFamily:'monospace',fontSize:8,color:colors.textDim,letterSpacing:2},
  titleInput:{fontFamily:'monospace',fontSize:13,color:colors.text,borderWidth:1,borderRadius:6,paddingHorizontal:10,paddingVertical:8},
  body:{flex:1,fontFamily:'monospace',fontSize:11,lineHeight:17,color:colors.textMuted,borderWidth:1,borderColor:'#141210',borderRadius:6,padding:10,backgroundColor:'#060504'},
  actions:{flexDirection:'row',alignItems:'center',gap:8},
  actBtn:{padding:6},
  ghost:{borderWidth:1,borderColor:colors.hairline,borderRadius:4,paddingHorizontal:10,paddingVertical:6},
  ghostT:{fontFamily:'monospace',fontSize:8,color:colors.textDim,letterSpacing:1},
  save:{borderRadius:4,paddingHorizontal:14,paddingVertical:6},
  saveT:{fontFamily:'monospace',fontSize:8,letterSpacing:1,fontWeight:'700'},
  src:{fontFamily:'monospace',fontSize:7,color:colors.textFaint,letterSpacing:1,textAlign:'right'},
  loading:{flex:1,alignItems:'center',justifyContent:'center'},
  empty:{fontFamily:'monospace',fontSize:10,color:colors.textFaint,textAlign:'center',marginTop:30},
});
