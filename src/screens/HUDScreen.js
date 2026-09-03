import React,{useState,useCallback,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,TextInput,Modal}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import{Feather}from '@expo/vector-icons';
import{getHudState,updateHudState,getTasks,getBusinessesWithRevenue,setBusinessTarget,addRevenue,updateEmpireScore,getMorningRoutine,saveMorningRoutine,getBatmanTemplate,saveBatmanTemplate,ensureHudState,DEFAULT_BATMAN}from '../services/database';
import{loadHudTasks,addHudTask,setHudTaskDone,renameHudTask,deleteHudTask}from '../services/hudTasks';
import{colors,space,radius,FONTS}from '../theme';
import{PANEL_META,BriefingPanel,AgendaPanel,BusinessPanel,TasksPanel,RoutinePanel,BatmanPanel,DailyPanel,MarketPanel,BuildBoardPanel}from './hud/panels';
import Boundary from './hud/Boundary';
import{HudFrame,ScoreBar,TelemetryLine,HudModule,HudDivider,useHudPulse}from './hud/HudChrome';

// Order the modules appear in the vertical scroll. [key, display label]
const MODULES=[
  ['briefing','BRIEFING'],
  ['agenda','AGENDA'],
  ['businesses','THE EMPIRE'],
  ['tasks','TASKS'],
  ['routine','MORNING ROUTINE'],
  ['batman','BATMAN PROTOCOL'],
  ['daily','DAILY'],
  ['market','MARKET'],
  ['build','BUILD PIPELINE'],
];

export default function HUDScreen({navigation}){
  const[hud,setHud]=useState(null);
  const[tasks,setTasks]=useState([]);
  const[businesses,setBusinesses]=useState([]);
  const[routineItems,setRoutineItems]=useState([]);
  const[routine,setRoutine]=useState({});          // { [id]: true }
  const[batmanTemplate,setBatmanTemplate]=useState(DEFAULT_BATMAN);
  const[batman,setBatman]=useState({});             // { [day]: true }
  const[newTask,setNewTask]=useState('');
  const[showAddTask,setShowAddTask]=useState(false);
  const[panelEditing,setPanelEditing]=useState(false);
  const[bizModal,setBizModal]=useState(null);
  const[bizTargetInput,setBizTargetInput]=useState('');
  const[bizWeekGoalInput,setBizWeekGoalInput]=useState('');
  const[bizLogInput,setBizLogInput]=useState('');
  const[taskEdit,setTaskEdit]=useState(null);
  const[taskEditInput,setTaskEditInput]=useState('');
  const busyRef=useRef(false);
  busyRef.current=panelEditing||showAddTask||!!taskEdit||!!bizModal;
  const pulse=useHudPulse();

  useFocusEffect(useCallback(()=>{if(!busyRef.current)load();},[]));

  async function load(){
    await ensureHudState(); // roll the day over (score -> 0, checkboxes cleared) if it's a new day
    const h=await getHudState();
    const t=await loadHudTasks();
    const b=await getBusinessesWithRevenue();
    const{items,done}=await getMorningRoutine();
    const bt=await getBatmanTemplate();
    let bat={};try{bat=JSON.parse(h?.batman_protocol||'{}');}catch{}
    setHud(h);setTasks(t);setBusinesses(b);
    setRoutineItems(items);setRoutine(done);
    setBatmanTemplate(bt);setBatman(bat);
    recalcScore(done,bat,t,items.length);
  }

  // Score starts at 0 each day and is earned purely from what's checked:
  //   morning routine 35 · today's workout 30 · tasks 35  (max 100)
  async function recalcScore(r,b,t,routineLen=routineItems.length){
    const rd=Object.values(r).filter(Boolean).length;
    const workoutDone=Object.values(b).filter(Boolean).length>0?1:0;
    const td=t.filter(x=>x.completed).length;
    const tt=t.length;
    const rRatio=routineLen>0?Math.min(1,rd/routineLen):0;
    const taskRatio=tt>0?td/tt:1; // nothing to do counts as done
    const sc=Math.round(Math.min(100,rRatio*35+workoutDone*30+taskRatio*35));
    setHud(prev=>({...prev,empire_score:sc}));
    await updateEmpireScore(sc);
  }

  async function toggleRoutine(id){
    const r={...routine,[id]:!routine[id]};
    setRoutine(r);
    await updateHudState({morning_routine_done:JSON.stringify(r)});
    recalcScore(r,batman,tasks);
  }
  async function toggleBatman(day){
    const b={...batman,[day]:!batman[day]};
    setBatman(b);
    await updateHudState({batman_protocol:JSON.stringify(b)});
    recalcScore(routine,b,tasks);
  }
  async function addNewTask(){
    const title=newTask.trim();
    if(!title)return;
    setNewTask('');setShowAddTask(false);
    await addHudTask(title);
    const t=await loadHudTasks();setTasks(t);
    recalcScore(routine,batman,t);
  }
  async function doneTask(t){
    await setHudTaskDone(t,true);
    const list=await loadHudTasks();setTasks(list);
    recalcScore(routine,batman,list);
  }
  function openTaskEdit(t){setTaskEdit(t);setTaskEditInput(t.title);}
  async function saveTaskEdit(){
    if(!taskEdit)return;
    await renameHudTask(taskEdit,taskEditInput);
    setTaskEdit(null);
    const t=await loadHudTasks();setTasks(t);
  }
  async function removeTask(){
    if(!taskEdit)return;
    await deleteHudTask(taskEdit);
    setTaskEdit(null);
    const t=await loadHudTasks();setTasks(t);
    recalcScore(routine,batman,t);
  }
  async function handleSaveRoutine(clean){
    await saveMorningRoutine(clean);
    const validIds=new Set(clean.map(i=>i.id));
    const prunedDone={};Object.keys(routine).forEach(k=>{if(validIds.has(k))prunedDone[k]=routine[k];});
    await updateHudState({morning_routine_done:JSON.stringify(prunedDone)});
    await load();
    recalcScore(prunedDone,batman,tasks,clean.length);
  }
  async function handleSaveBatman(draft){
    await saveBatmanTemplate(draft);
    await load();
  }

  function openBizModal(b){
    setBizModal(b);
    setBizTargetInput(String(b.target||0));
    setBizWeekGoalInput(String(b.weekGoal||0));
    setBizLogInput('');
  }
  async function saveBizModal(){
    if(!bizModal)return;
    const target=parseFloat(bizTargetInput)||0;
    const weekGoal=parseFloat(bizWeekGoalInput)||0;
    await setBusinessTarget(bizModal.name,target,weekGoal);
    if(bizLogInput.trim()){
      const amt=parseFloat(bizLogInput);
      if(!isNaN(amt)&&amt>0)await addRevenue(bizModal.name,amt);
    }
    setBizModal(null);
    const b=await getBusinessesWithRevenue();setBusinesses(b);
  }

  const score=hud?.empire_score||0;
  const streak=hud?.streak||0;
  const today=new Date().getDay();
  const todayIdx=today===0?6:today-1;
  const todayBatman=batmanTemplate[todayIdx]||DEFAULT_BATMAN[todayIdx];
  const routineDone=routineItems.filter(i=>routine[i.id]).length;
  const tasksDone=tasks.filter(t=>t.completed).length;
  const openTasks=tasks.filter(t=>!t.completed);
  const statusText=score>=75?`${streak} DAY STREAK — HOLDING`:score>=50?'BUILDING TODAY':score>0?'STREAK AT RISK':'DAY NOT STARTED';

  function renderPanel(key){
    switch(key){
      case 'briefing':return <BriefingPanel tasksDone={tasksDone} tasksTotal={tasks.length} routineDone={routineDone} routineTotal={routineItems.length} todayBatman={todayBatman} workoutDone={!!(todayBatman&&batman[todayBatman.day])} onToggleWorkout={()=>todayBatman&&toggleBatman(todayBatman.day)}/>;
      case 'agenda':return <Boundary label="The agenda panel"><AgendaPanel/></Boundary>;
      case 'businesses':return <BusinessPanel businesses={businesses} onOpenBiz={openBizModal}/>;
      case 'tasks':return <TasksPanel tasks={openTasks} onComplete={doneTask} onEdit={openTaskEdit} onAdd={()=>setShowAddTask(true)}/>;
      case 'routine':return <RoutinePanel items={routineItems} done={routine} onToggle={toggleRoutine} onSave={handleSaveRoutine} onEditingChange={setPanelEditing}/>;
      case 'batman':return <BatmanPanel template={batmanTemplate} done={batman} today={todayBatman} onToggleDay={toggleBatman} onSaveTemplate={handleSaveBatman} onEditingChange={setPanelEditing}/>;
      case 'daily':return <DailyPanel hud={hud} onRefreshed={load}/>;
      case 'market':return <Boundary label="The market panel"><MarketPanel/></Boundary>;
      case 'build':return <Boundary label="The build panel"><BuildBoardPanel/></Boundary>;
      default:return null;
    }
  }

  return(
    <SafeAreaView style={s.container} edges={['top','bottom']}>
      <View style={s.header}>
        <TouchableOpacity style={s.brandRow} onPress={()=>navigation.navigate('Map')} hitSlop={{top:10,bottom:10,left:10,right:10}} activeOpacity={0.7}>
          <Feather name="chevron-left" size={15} color={colors.gold}/>
          <Text style={s.brand}>♔ EMPIRE OS</Text>
        </TouchableOpacity>
        <View style={s.onlinePill}><View style={s.onlineDot}/><Text style={s.onlineText}>ONLINE</Text></View>
      </View>

      <TelemetryLine/>

      <ScrollView
        style={{flex:1}}
        contentContainerStyle={s.scroll}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <ScoreBar
          score={score} streak={streak}
          routineDone={routineDone} routineTotal={routineItems.length}
          tasksDone={tasksDone} tasksTotal={tasks.length}
          statusText={statusText} pulse={pulse}
        />

        {MODULES.map(([key,label],i)=>(
          <React.Fragment key={key}>
            {i>0&&<HudDivider/>}
            <HudModule index={String(i+1).padStart(2,'0')} label={label||PANEL_META[key]?.title} pulse={pulse}>
              {renderPanel(key)}
            </HudModule>
          </React.Fragment>
        ))}

        <View style={s.footer}>
          <Text style={s.footerText}>— END OF FEED —</Text>
        </View>
      </ScrollView>

      <Modal visible={showAddTask} transparent animationType="slide">
        <View style={s.modalOver}><View style={s.modalContent}>
          <Text style={s.modalTitle}>NEW TASK</Text>
          <TextInput style={s.modalInput} value={newTask} onChangeText={setNewTask} placeholder="Task title…" placeholderTextColor={colors.textFaint} autoFocus/>
          <View style={s.modalActions}>
            <TouchableOpacity style={[s.modalBtn,s.modalBtnPrimary]} onPress={addNewTask}><Text style={s.modalBtnPrimaryT}>ADD</Text></TouchableOpacity>
            <TouchableOpacity style={[s.modalBtn,s.modalBtnGhost]} onPress={()=>setShowAddTask(false)}><Text style={s.modalBtnGhostT}>CANCEL</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>

      <Modal visible={!!taskEdit} transparent animationType="slide">
        <View style={s.modalOver}><View style={s.modalContent}>
          <Text style={s.modalTitle}>EDIT TASK</Text>
          <TextInput style={s.modalInput} value={taskEditInput} onChangeText={setTaskEditInput} placeholder="Task title…" placeholderTextColor={colors.textFaint} autoFocus/>
          <View style={s.modalActions}>
            <TouchableOpacity style={[s.modalBtn,s.modalBtnPrimary]} onPress={saveTaskEdit}><Text style={s.modalBtnPrimaryT}>SAVE</Text></TouchableOpacity>
            <TouchableOpacity style={[s.modalBtn,s.modalBtnDanger]} onPress={removeTask}><Text style={s.modalBtnDangerT}>DELETE</Text></TouchableOpacity>
            <TouchableOpacity style={[s.modalBtn,s.modalBtnGhost]} onPress={()=>setTaskEdit(null)}><Text style={s.modalBtnGhostT}>CANCEL</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>

      <Modal visible={!!bizModal} transparent animationType="slide">
        <View style={s.modalOver}><View style={s.modalContent}>
          {bizModal&&<>
            <Text style={s.modalTitle}>{bizModal.name}</Text>
            <Text style={s.modalSub}>THIS MONTH · ${bizModal.rev.toLocaleString()}</Text>
            <Text style={s.fieldLabel}>MONTHLY TARGET</Text>
            <TextInput style={s.modalInput} value={bizTargetInput} onChangeText={setBizTargetInput} keyboardType="numeric" placeholderTextColor={colors.textFaint}/>
            <Text style={s.fieldLabel}>WEEKLY GOAL</Text>
            <TextInput style={s.modalInput} value={bizWeekGoalInput} onChangeText={setBizWeekGoalInput} keyboardType="numeric" placeholderTextColor={colors.textFaint}/>
            <Text style={s.fieldLabel}>LOG REVENUE (OPTIONAL)</Text>
            <TextInput style={s.modalInput} value={bizLogInput} onChangeText={setBizLogInput} keyboardType="numeric" placeholder="Amount to add" placeholderTextColor={colors.textFaint}/>
            <View style={s.modalActions}>
              <TouchableOpacity style={[s.modalBtn,s.modalBtnPrimary]} onPress={saveBizModal}><Text style={s.modalBtnPrimaryT}>SAVE</Text></TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn,s.modalBtnGhost]} onPress={()=>setBizModal(null)}><Text style={s.modalBtnGhostT}>CANCEL</Text></TouchableOpacity>
            </View>
          </>}
        </View></View>
      </Modal>

      <HudFrame pulse={pulse}/>
    </SafeAreaView>
  );
}

const s=StyleSheet.create({
  container:{flex:1,backgroundColor:colors.bg},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:space.lg,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  brandRow:{flexDirection:'row',alignItems:'center',gap:space.sm},
  brand:{fontFamily:FONTS.monoMed,fontSize:13,color:colors.gold,letterSpacing:3},
  onlinePill:{flexDirection:'row',alignItems:'center',gap:6,borderWidth:1,borderColor:colors.onlineDim,borderRadius:radius.pill,paddingHorizontal:space.sm,paddingVertical:3},
  onlineDot:{width:5,height:5,borderRadius:2.5,backgroundColor:colors.online},
  onlineText:{fontFamily:FONTS.mono,fontSize:7,color:colors.online,letterSpacing:2.5},

  scroll:{paddingBottom:space.xxxl},
  footer:{alignItems:'center',paddingVertical:space.xl},
  footerText:{fontFamily:FONTS.mono,fontSize:7,color:colors.textFaint,letterSpacing:3},

  modalOver:{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'},
  modalContent:{backgroundColor:colors.card,borderTopWidth:1,borderTopColor:colors.hairlineGold,borderTopLeftRadius:radius.xl,borderTopRightRadius:radius.xl,padding:space.xl},
  modalTitle:{fontFamily:FONTS.monoMed,fontSize:12,color:colors.gold,letterSpacing:3,marginBottom:6},
  modalSub:{fontFamily:FONTS.mono,fontSize:9,color:colors.online,letterSpacing:1.5,marginBottom:space.lg},
  fieldLabel:{fontFamily:FONTS.mono,fontSize:8,color:colors.textDim,letterSpacing:1.5,marginBottom:6,marginTop:space.md},
  modalInput:{backgroundColor:colors.surface,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.md,paddingHorizontal:space.md,paddingVertical:space.md,color:colors.text,fontFamily:FONTS.mono,fontSize:14},
  modalActions:{flexDirection:'row',gap:space.md,marginTop:space.xl},
  modalBtn:{flex:1,paddingVertical:space.md,borderRadius:radius.md,alignItems:'center'},
  modalBtnPrimary:{backgroundColor:colors.gold},
  modalBtnPrimaryT:{fontFamily:FONTS.monoMed,fontSize:10,color:colors.bg,letterSpacing:2},
  modalBtnGhost:{backgroundColor:colors.surface,borderWidth:1,borderColor:colors.hairline},
  modalBtnGhostT:{fontFamily:FONTS.monoMed,fontSize:10,color:colors.textDim,letterSpacing:2},
  modalBtnDanger:{backgroundColor:'rgba(199,97,75,0.12)',borderWidth:1,borderColor:'rgba(199,97,75,0.4)'},
  modalBtnDangerT:{fontFamily:FONTS.monoMed,fontSize:10,color:colors.danger,letterSpacing:2},
});
