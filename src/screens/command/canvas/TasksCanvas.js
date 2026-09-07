// Tasks + morning routine on the Canvas — a checklist Mr. Burrus can tick, add
// to, rename inline and delete, straight from whichever persona he's talking to.
// Writes go through the same database helpers the personas' [ADD_TASK] /
// [ROUTINE_*] tags use, so chat and Canvas stay in sync. Reads poll every 5s.
import React,{useState,useEffect,useCallback,useRef,useImperativeHandle,forwardRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,TextInput,ScrollView,Alert}from 'react-native';
import{Feather}from '@expo/vector-icons';
import{colors}from '../../../theme';
import{
  getTasks,addTask,completeTask,updateTask,deleteTask,
  getMorningRoutine,addRoutineItem,renameRoutineItem,removeRoutineItem,setRoutineDone,
}from '../../../services/database';

const POLL_MS=5000;

export default forwardRef(function TasksCanvas({accent=colors.gold},ref){
  const[tasks,setTasks]=useState([]);
  const[routine,setRoutine]=useState({items:[],done:{}});
  const[editing,setEditing]=useState(null); // `t:<id>` | `r:<id>`
  const[editText,setEditText]=useState('');
  const[newTask,setNewTask]=useState('');
  const[newRoutine,setNewRoutine]=useState('');
  const alive=useRef(true);

  const load=useCallback(async()=>{
    try{const t=await getTasks();if(alive.current)setTasks(t);}catch{}
    try{const r=await getMorningRoutine();if(alive.current)setRoutine(r);}catch{}
  },[]);

  useEffect(()=>{
    alive.current=true;load();
    const iv=setInterval(load,POLL_MS);
    return()=>{alive.current=false;clearInterval(iv);};
  },[load]);

  useImperativeHandle(ref,()=>({back:()=>false}),[]);

  function beginEdit(key,text){setEditing(key);setEditText(text);}
  async function commitEdit(){
    const key=editing,text=editText.trim();
    setEditing(null);
    if(!key)return;
    const[kind,id]=key.split(/:(.+)/);
    if(!text){return;}
    if(kind==='t'){const row=tasks.find(x=>String(x.id)===id);if(row)await updateTask(row.id,text,row.notes||'');}
    else await renameRoutineItem(id,text);
    load();
  }

  async function tickTask(row){await completeTask(row.id);load();}
  async function removeTask(row){await deleteTask(row.id);load();}
  async function addNewTask(){const t=newTask.trim();if(!t)return;setNewTask('');await addTask(t);load();}

  async function tickRoutine(id){await setRoutineDone(id,!routine.done[id]);load();}
  async function delRoutine(id){await removeRoutineItem(id);load();}
  async function addNewRoutine(){const t=newRoutine.trim();if(!t)return;setNewRoutine('');await addRoutineItem(t);load();}

  const doneCount=routine.items.filter(i=>routine.done[i.id]).length;

  return(
    <ScrollView style={s.wrap} contentContainerStyle={{paddingBottom:16}} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <Text style={[s.section,{color:accent}]}>TASKS · {tasks.length} OPEN</Text>
      {tasks.map(t=>{
        const key='t:'+t.id;
        return(
          <View key={key} style={s.row}>
            <TouchableOpacity onPress={()=>tickTask(t)} hitSlop={HIT}>
              <Feather name="circle" size={17} color={colors.textDim}/>
            </TouchableOpacity>
            {editing===key?(
              <TextInput style={s.rowEdit} value={editText} onChangeText={setEditText} autoFocus
                onBlur={commitEdit} onSubmitEditing={commitEdit} returnKeyType="done"/>
            ):(
              <TouchableOpacity style={{flex:1}} onPress={()=>beginEdit(key,t.title)} activeOpacity={0.6}>
                <Text style={s.rowT}>{t.title}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={()=>removeTask(t)} hitSlop={HIT}>
              <Feather name="x" size={14} color={colors.textFaint}/>
            </TouchableOpacity>
          </View>
        );
      })}
      {!tasks.length&&<Text style={s.empty}>Nothing open.</Text>}
      <View style={s.addRow}>
        <Feather name="plus" size={14} color={accent}/>
        <TextInput style={s.addInput} value={newTask} onChangeText={setNewTask} placeholder="Add a task…"
          placeholderTextColor={colors.textFaint} onSubmitEditing={addNewTask} returnKeyType="done" blurOnSubmit={false}/>
      </View>

      <Text style={[s.section,{color:accent,marginTop:18}]}>MORNING ROUTINE · {doneCount}/{routine.items.length}</Text>
      {routine.items.map(it=>{
        const key='r:'+it.id;
        const done=!!routine.done[it.id];
        return(
          <View key={key} style={s.row}>
            <TouchableOpacity onPress={()=>tickRoutine(it.id)} hitSlop={HIT}>
              <Feather name={done?'check-circle':'circle'} size={17} color={done?accent:colors.textDim}/>
            </TouchableOpacity>
            {editing===key?(
              <TextInput style={s.rowEdit} value={editText} onChangeText={setEditText} autoFocus
                onBlur={commitEdit} onSubmitEditing={commitEdit} returnKeyType="done"/>
            ):(
              <TouchableOpacity style={{flex:1}} onPress={()=>beginEdit(key,it.label)} activeOpacity={0.6}>
                <Text style={[s.rowT,done&&s.rowDone]}>{it.label}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity onPress={()=>Alert.alert('Remove from routine?',it.label,[
              {text:'Cancel',style:'cancel'},{text:'Remove',style:'destructive',onPress:()=>delRoutine(it.id)},
            ])} hitSlop={HIT}>
              <Feather name="x" size={14} color={colors.textFaint}/>
            </TouchableOpacity>
          </View>
        );
      })}
      {!routine.items.length&&<Text style={s.empty}>No routine items.</Text>}
      <View style={s.addRow}>
        <Feather name="plus" size={14} color={accent}/>
        <TextInput style={s.addInput} value={newRoutine} onChangeText={setNewRoutine} placeholder="Add a routine step…"
          placeholderTextColor={colors.textFaint} onSubmitEditing={addNewRoutine} returnKeyType="done" blurOnSubmit={false}/>
      </View>
    </ScrollView>
  );
});

const HIT={top:8,bottom:8,left:8,right:8};
const s=StyleSheet.create({
  wrap:{flex:1,paddingHorizontal:14,paddingTop:10},
  section:{fontFamily:'monospace',fontSize:9,letterSpacing:2,marginBottom:8},
  row:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:8,borderBottomWidth:1,borderBottomColor:'#141210'},
  rowT:{fontFamily:'monospace',fontSize:11,color:colors.text},
  rowDone:{color:colors.textDim,textDecorationLine:'line-through'},
  rowEdit:{flex:1,fontFamily:'monospace',fontSize:11,color:colors.text,borderBottomWidth:1,borderBottomColor:colors.gold,paddingVertical:2},
  addRow:{flexDirection:'row',alignItems:'center',gap:10,paddingVertical:10},
  addInput:{flex:1,fontFamily:'monospace',fontSize:11,color:colors.text},
  empty:{fontFamily:'monospace',fontSize:9,color:colors.textFaint,paddingVertical:8},
});
