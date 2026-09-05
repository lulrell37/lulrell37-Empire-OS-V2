// One HUD panel, self-contained, for the floating layer — it fetches its own
// data and writes straight through, so a minimized panel keeps working anywhere
// in the app. Edits that need the full-screen HUD (business detail, the task
// edit sheet) jump there via onOpenHud.
import React,{useState,useEffect,useCallback,useRef}from 'react';
import{View,Text,TextInput,TouchableOpacity,StyleSheet}from 'react-native';
import{getHudState,updateHudState,getBusinessesWithRevenue,getMorningRoutine,saveMorningRoutine,getBatmanTemplate,saveBatmanTemplate,updateEmpireScore,ensureHudState,DEFAULT_BATMAN}from '../../services/database';
import{loadHudTasks,addHudTask,setHudTaskDone}from '../../services/hudTasks';
import{BriefingPanel,AgendaPanel,BusinessPanel,TasksPanel,RoutinePanel,BatmanPanel,DailyPanel,MarketPanel,BuildBoardPanel}from './panels';
import{colors,FONTS,space}from '../../theme';

export default function FloatPanel({kind,active=true,onOpenHud}){
  // Panels that already fetch everything themselves.
  if(kind==='agenda')return <AgendaPanel active={active}/>;
  if(kind==='market')return <MarketPanel active={active}/>;
  if(kind==='build')return <BuildBoardPanel active={active}/>;
  return <FloatDataPanel kind={kind} active={active} onOpenHud={onOpenHud}/>;
}

function FloatDataPanel({kind,active,onOpenHud}){
  const[hud,setHud]=useState(null);
  const[tasks,setTasks]=useState([]);
  const[businesses,setBusinesses]=useState([]);
  const[routineItems,setRoutineItems]=useState([]);
  const[routine,setRoutine]=useState({});
  const[batmanTpl,setBatmanTpl]=useState(DEFAULT_BATMAN);
  const[batman,setBatman]=useState({});
  const[adding,setAdding]=useState(false);
  const[newTitle,setNewTitle]=useState('');
  const alive=useRef(true);

  const load=useCallback(async()=>{
    try{await ensureHudState();}catch{}
    const[h,t,b,mr,bt]=await Promise.all([
      getHudState().catch(()=>null),
      loadHudTasks().catch(()=>[]),
      getBusinessesWithRevenue().catch(()=>[]),
      getMorningRoutine().catch(()=>({items:[],done:{}})),
      getBatmanTemplate().catch(()=>DEFAULT_BATMAN),
    ]);
    if(!alive.current)return;
    setHud(h);setTasks(t);setBusinesses(b);
    setRoutineItems(mr.items||[]);setRoutine(mr.done||{});
    setBatmanTpl(bt||DEFAULT_BATMAN);
    try{setBatman(JSON.parse(h?.batman_protocol||'{}'));}catch{setBatman({});}
  },[]);

  useEffect(()=>{
    alive.current=true;
    load();
    const iv=active?setInterval(load,30000):null;
    return()=>{alive.current=false;if(iv)clearInterval(iv);};
  },[active,load]);

  const recalc=useCallback(async(r,bm,ts)=>{
    const rd=Object.values(r).filter(Boolean).length;
    const workout=Object.values(bm).filter(Boolean).length>0?1:0;
    const td=ts.filter(x=>x.completed).length,tt=ts.length;
    const rRatio=routineItems.length>0?Math.min(1,rd/routineItems.length):0;
    const taskRatio=tt>0?td/tt:1;
    const sc=Math.round(Math.min(100,rRatio*35+workout*30+taskRatio*35));
    setHud(p=>({...p,empire_score:sc}));
    try{await updateEmpireScore(sc);}catch{}
  },[routineItems]);

  const toggleRoutine=async(id)=>{
    const r={...routine,[id]:!routine[id]};setRoutine(r);
    try{await updateHudState({morning_routine_done:JSON.stringify(r)});}catch{}
    recalc(r,batman,tasks);
  };
  const toggleBatman=async(day)=>{
    const bm={...batman,[day]:!batman[day]};setBatman(bm);
    try{await updateHudState({batman_protocol:JSON.stringify(bm)});}catch{}
    recalc(routine,bm,tasks);
  };
  const completeTask=async(t)=>{
    await setHudTaskDone(t,true);
    const list=await loadHudTasks();
    if(!alive.current)return;
    setTasks(list);recalc(routine,batman,list);
  };
  const submitAdd=async()=>{
    const v=newTitle.trim();setNewTitle('');setAdding(false);
    if(!v)return;
    await addHudTask(v);
    const list=await loadHudTasks();
    if(!alive.current)return;
    setTasks(list);recalc(routine,batman,list);
  };

  const today=new Date().getDay();
  const todayIdx=today===0?6:today-1;
  const todayBatman=batmanTpl[todayIdx]||DEFAULT_BATMAN[todayIdx];
  const openTasks=tasks.filter(t=>!t.completed);
  const tasksDone=tasks.filter(t=>t.completed).length;
  const routineDone=routineItems.filter(i=>routine[i.id]).length;

  switch(kind){
    case 'briefing':
      return <BriefingPanel tasksDone={tasksDone} tasksTotal={tasks.length}
        routineDone={routineDone} routineTotal={routineItems.length}
        todayBatman={todayBatman} workoutDone={!!(todayBatman&&batman[todayBatman.day])}
        onToggleWorkout={()=>todayBatman&&toggleBatman(todayBatman.day)}/>;
    case 'tasks':
      return(
        <>
          <TasksPanel tasks={openTasks} onComplete={completeTask}
            onEdit={()=>onOpenHud?.()} onAdd={()=>setAdding(true)}/>
          {adding&&(
            <View style={fs.addRow}>
              <TextInput style={fs.addInput} value={newTitle} onChangeText={setNewTitle}
                placeholder="New task…" placeholderTextColor={colors.textFaint}
                autoFocus onSubmitEditing={submitAdd}/>
              <TouchableOpacity onPress={submitAdd}><Text style={fs.addGo}>ADD</Text></TouchableOpacity>
            </View>
          )}
        </>
      );
    case 'businesses':
      return <BusinessPanel businesses={businesses} onOpenBiz={()=>onOpenHud?.()} onAddBiz={()=>onOpenHud?.()}/>;
    case 'routine':
      return <RoutinePanel items={routineItems} done={routine} onToggle={toggleRoutine}
        onSave={async(clean)=>{try{await saveMorningRoutine(clean);}catch{}load();}}/>;
    case 'batman':
      return <BatmanPanel template={batmanTpl} done={batman} today={todayBatman}
        onToggleDay={toggleBatman}
        onSaveTemplate={async(t)=>{try{await saveBatmanTemplate(t);}catch{}load();}}/>;
    case 'daily':
      return <DailyPanel hud={hud} onRefreshed={load}/>;
    default:
      return <Text style={fs.dash}>—</Text>;
  }
}

const fs=StyleSheet.create({
  addRow:{flexDirection:'row',alignItems:'center',gap:space.sm,marginTop:space.sm},
  addInput:{flex:1,fontFamily:FONTS.mono,fontSize:12,color:colors.text,borderBottomWidth:1,borderBottomColor:colors.hairline,paddingVertical:4},
  addGo:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:2,paddingHorizontal:6},
  dash:{fontFamily:FONTS.mono,fontSize:10,color:colors.textFaint},
});
