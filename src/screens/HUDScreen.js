import React,{useState,useEffect,useCallback,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,TextInput,Modal,Dimensions}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import Svg,{Circle,Defs,LinearGradient,Stop}from 'react-native-svg';
import{Feather}from '@expo/vector-icons';
import{getHudState,updateHudState,getTasks,addTask,updateTask,deleteTask,completeTask,getBusinessesWithRevenue,setBusinessTarget,addRevenue,updateEmpireScore,getMorningRoutine,saveMorningRoutine,getBatmanTemplate,saveBatmanTemplate,getHudLayout,setPanelLayout,DEFAULT_BATMAN}from '../services/database';
import{colors,space,radius,type,FONTS}from '../theme';
import{PANEL_META,BriefingPanel,BusinessPanel,TasksPanel,RoutinePanel,BatmanPanel,DailyPanel}from './hud/panels';
import FloatingCard from './hud/FloatingCard';
import DiagramPanel from './hud/DiagramPanel';
import Boundary from './hud/Boundary';
const{width}=Dimensions.get('window');
const RS=196,ST=6,CI=2*Math.PI*((RS-ST)/2);
const PANELS=['briefing','businesses','tasks','routine','batman','daily','diagram'];
const NAV=[
  {key:'Command',icon:'terminal',label:'COMMAND'},
  {key:'HUD',icon:'target',label:'HUD'},
  {key:'Memory',icon:'cloud',label:'MEMORY'},
  {key:'Settings',icon:'settings',label:'SETTINGS'},
  {key:'Map',icon:'map',label:'MAP'},
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
  const[panelIndex,setPanelIndex]=useState(0);
  const[panelEditing,setPanelEditing]=useState(false);
  const[bizModal,setBizModal]=useState(null);
  const[bizTargetInput,setBizTargetInput]=useState('');
  const[bizWeekGoalInput,setBizWeekGoalInput]=useState('');
  const[bizLogInput,setBizLogInput]=useState('');
  const[taskEdit,setTaskEdit]=useState(null);
  const[taskEditInput,setTaskEditInput]=useState('');
  const[layout,setLayout]=useState({});            // { [panel]: {detached,x,y,scale,z} }
  const scrollRef=useRef(null);
  const busyRef=useRef(false);
  busyRef.current=panelEditing||showAddTask||!!taskEdit||!!bizModal;

  useFocusEffect(useCallback(()=>{if(!busyRef.current)load();},[]));

  async function load(){
    const h=await getHudState();
    const t=await getTasks();
    const b=await getBusinessesWithRevenue();
    const{items,done}=await getMorningRoutine();
    const bt=await getBatmanTemplate();
    const lay=await getHudLayout();
    setHud(h);setTasks(t);setBusinesses(b);
    setRoutineItems(items);setRoutine(done);
    setBatmanTemplate(bt);setLayout(lay);
    try{setBatman(JSON.parse(h?.batman_protocol||'{}'));}catch{setBatman({});}
  }

  const maxZ=()=>Math.max(0,...PANELS.map(p=>layout[p]?.z||0));
  async function detachPanel(key){
    const n=PANELS.filter(p=>layout[p]?.detached).length;
    const patch={detached:true,x:20+n*16,y:20+n*16,scale:layout[key]?.scale||1,z:maxZ()+1};
    setLayout(l=>({...l,[key]:{...l[key],...patch}}));
    await setPanelLayout(key,{detached:1,x:patch.x,y:patch.y,scale:patch.scale,z:patch.z});
  }
  async function dockPanel(key){
    setLayout(l=>({...l,[key]:{...l[key],detached:false}}));
    await setPanelLayout(key,{detached:0});
  }
  async function bringFront(key){
    const top=maxZ();
    if((layout[key]?.z||0)>=top)return;
    const z=top+1;
    setLayout(l=>({...l,[key]:{...l[key],z}}));
    await setPanelLayout(key,{z});
  }
  async function persistPanel(key,patch){
    setLayout(l=>({...l,[key]:{...l[key],...patch}}));
    await setPanelLayout(key,patch);
  }

  async function recalcScore(r,b,t,routineLen=routineItems.length){
    const rd=Object.values(r).filter(Boolean).length;
    const bd=Object.values(b).filter(Boolean).length>0?1:0;
    const td=t.filter(x=>x.completed).length;
    const tt=t.length;
    const rRatio=routineLen>0?Math.min(1,rd/routineLen):0;
    const sc=Math.round(Math.min(100,25+rRatio*30+(bd*25)+(tt>0?(td/tt)*20:0)));
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
    if(!newTask.trim())return;
    await addTask(newTask.trim());
    setNewTask('');setShowAddTask(false);
    const t=await getTasks();setTasks(t);
    recalcScore(routine,batman,t);
  }
  async function doneTask(id){
    await completeTask(id);
    const t=await getTasks();setTasks(t);
    recalcScore(routine,batman,t);
  }
  function openTaskEdit(t){setTaskEdit(t);setTaskEditInput(t.title);}
  async function saveTaskEdit(){
    if(!taskEdit)return;
    const title=taskEditInput.trim();
    if(title)await updateTask(taskEdit.id,title,taskEdit.notes||'');
    setTaskEdit(null);
    const t=await getTasks();setTasks(t);
  }
  async function removeTask(){
    if(!taskEdit)return;
    await deleteTask(taskEdit.id);
    setTaskEdit(null);
    const t=await getTasks();setTasks(t);
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
  const visiblePanels=PANELS.filter(p=>!layout[p]?.detached);
  const detachedPanels=PANELS.filter(p=>layout[p]?.detached);
  useEffect(()=>{
    if(panelIndex>visiblePanels.length-1){
      const ni=Math.max(0,visiblePanels.length-1);
      setPanelIndex(ni);
      scrollRef.current?.scrollTo({x:ni*width,animated:false});
    }
  },[visiblePanels.length]); // eslint-disable-line react-hooks/exhaustive-deps
  function goToPanel(i){
    const idx=Math.max(0,Math.min(visiblePanels.length-1,i));
    setPanelIndex(idx);
    scrollRef.current?.scrollTo({x:idx*width,animated:true});
  }
  function onScrollEnd(e){
    const idx=Math.max(0,Math.min(visiblePanels.length-1,Math.round(e.nativeEvent.contentOffset.x/width)));
    setPanelIndex(idx);
    scrollRef.current?.scrollTo({x:idx*width,animated:true});
  }

  const score=hud?.empire_score||0;
  const streak=hud?.streak||0;
  const scoreOffset=CI-(CI*score/100);
  const today=new Date().getDay();
  const todayIdx=today===0?6:today-1;
  const todayBatman=batmanTemplate[todayIdx]||DEFAULT_BATMAN[todayIdx];
  const routineDone=routineItems.filter(i=>routine[i.id]).length;
  const tasksDone=tasks.filter(t=>t.completed).length;
  const openTasks=tasks.filter(t=>!t.completed);
  const statusIcon=score>=75?'trending-up':score>=50?'minus':'trending-down';
  const statusText=score>=75?`${streak} DAY STREAK`:score>=50?'BUILDING TODAY':'STREAK AT RISK';

  function renderPanel(key){
    switch(key){
      case 'briefing':return <BriefingPanel tasksDone={tasksDone} tasksTotal={tasks.length} routineDone={routineDone} routineTotal={routineItems.length} todayBatman={todayBatman}/>;
      case 'businesses':return <BusinessPanel businesses={businesses} onOpenBiz={openBizModal}/>;
      case 'tasks':return <TasksPanel tasks={openTasks} onComplete={doneTask} onEdit={openTaskEdit} onAdd={()=>setShowAddTask(true)}/>;
      case 'routine':return <RoutinePanel items={routineItems} done={routine} onToggle={toggleRoutine} onSave={handleSaveRoutine} onEditingChange={setPanelEditing}/>;
      case 'batman':return <BatmanPanel template={batmanTemplate} done={batman} today={todayBatman} onToggleDay={toggleBatman} onSaveTemplate={handleSaveBatman} onEditingChange={setPanelEditing}/>;
      case 'daily':return <DailyPanel hud={hud}/>;
      case 'diagram':return <Boundary label="The diagram card"><DiagramPanel/></Boundary>;
      default:return null;
    }
  }

  return(
    <SafeAreaView style={s.container} edges={['top','bottom']}>
      <View style={s.header}>
        <View style={s.brandRow}>
          <Feather name="hexagon" size={13} color={colors.gold}/>
          <Text style={s.brand}>EMPIRE OS</Text>
        </View>
        <View style={s.onlinePill}><View style={s.onlineDot}/><Text style={s.onlineText}>ONLINE</Text></View>
      </View>

      <View style={s.reactorWrap}>
        <View style={s.reactor}>
          <Svg width={RS} height={RS}>
            <Defs>
              <LinearGradient id="reactorGrad" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={colors.brass}/>
                <Stop offset="0.55" stopColor={colors.gold}/>
                <Stop offset="1" stopColor={colors.goldBright}/>
              </LinearGradient>
            </Defs>
            <Circle cx={RS/2} cy={RS/2} r={(RS-ST)/2} stroke={colors.ringTrack} strokeWidth={ST} fill="none"/>
            <Circle cx={RS/2} cy={RS/2} r={(RS-ST)/2} stroke="url(#reactorGrad)" strokeWidth={ST} fill="none" strokeDasharray={CI} strokeDashoffset={scoreOffset} strokeLinecap="round" rotation="-90" origin={`${RS/2},${RS/2}`}/>
          </Svg>
          <View style={s.reactorCore}>
            <Text style={s.reactorScore}>{score}<Text style={s.reactorPct}>%</Text></Text>
            <Text style={s.reactorLabel}>EMPIRE SCORE</Text>
            <View style={s.reactorStatus}>
              <Feather name={statusIcon} size={9} color={colors.online}/>
              <Text style={s.reactorStatusText}>{statusText}</Text>
            </View>
          </View>
        </View>
      </View>

      <View style={s.dots}>
        {visiblePanels.map((p,i)=>(
          <TouchableOpacity key={p} onPress={()=>goToPanel(i)} style={[s.dot,panelIndex===i&&s.dotActive]}/>
        ))}
      </View>

      <View style={{flex:1}}>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          snapToInterval={width}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          showsHorizontalScrollIndicator={false}
          scrollEnabled={!panelEditing}
          onMomentumScrollEnd={onScrollEnd}
          style={{flex:1}}
        >
          {visiblePanels.map(key=>(
            <ScrollView key={key} style={{width}} contentContainerStyle={s.panelContent} keyboardShouldPersistTaps="handled">
              <View style={s.panelTopBar}>
                <Text style={s.panelLabel}>{PANEL_META[key].title}</Text>
                <TouchableOpacity onPress={()=>detachPanel(key)} hitSlop={{top:10,bottom:10,left:10,right:10}} activeOpacity={0.6}>
                  <Feather name="maximize-2" size={13} color={colors.textDim}/>
                </TouchableOpacity>
              </View>
              {renderPanel(key)}
            </ScrollView>
          ))}
          {!visiblePanels.length&&(
            <View style={[s.panelContent,{width,alignItems:'center',justifyContent:'center',flex:1}]}>
              <Feather name="layout" size={22} color={colors.textFaint}/>
              <Text style={s.allDetached}>Every panel is floating.{'\n'}Dock one to browse the carousel.</Text>
            </View>
          )}
        </ScrollView>

        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          {detachedPanels.map(key=>(
            <FloatingCard
              key={key}
              title={PANEL_META[key].title}
              initial={layout[key]}
              z={layout[key]?.z||0}
              onFront={()=>bringFront(key)}
              onPersist={(patch)=>persistPanel(key,patch)}
              onDock={()=>dockPanel(key)}
            >
              {renderPanel(key)}
            </FloatingCard>
          ))}
        </View>
      </View>

      <View style={s.bottomNav}>
        {NAV.map(n=>{
          const active=n.key==='HUD';
          return(
            <TouchableOpacity key={n.key} style={s.navItem} activeOpacity={0.7}
              onPress={()=>{if(!active)navigation.navigate(n.key);}}>
              <Feather name={n.icon} size={15} color={active?colors.gold:colors.textDim}/>
              <Text style={[s.navLabel,active&&{color:colors.gold}]}>{n.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

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
    </SafeAreaView>
  );
}

const s=StyleSheet.create({
  container:{flex:1,backgroundColor:colors.bg},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:space.lg,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  brandRow:{flexDirection:'row',alignItems:'center',gap:space.sm},
  brand:{fontFamily:FONTS.monoMed,fontSize:13,color:colors.gold,letterSpacing:4},
  onlinePill:{flexDirection:'row',alignItems:'center',gap:6,borderWidth:1,borderColor:colors.onlineDim,borderRadius:radius.pill,paddingHorizontal:space.sm,paddingVertical:3},
  onlineDot:{width:5,height:5,borderRadius:2.5,backgroundColor:colors.online},
  onlineText:{fontFamily:FONTS.mono,fontSize:7,color:colors.online,letterSpacing:2.5},

  reactorWrap:{alignItems:'center',paddingTop:space.lg,paddingBottom:space.sm},
  reactor:{width:RS,height:RS,alignItems:'center',justifyContent:'center'},
  reactorCore:{position:'absolute',alignItems:'center',justifyContent:'center'},
  reactorScore:{fontFamily:FONTS.displaySemi,fontSize:58,color:colors.goldBright,letterSpacing:1},
  reactorPct:{fontFamily:FONTS.display,fontSize:22,color:colors.goldDim},
  reactorLabel:{fontFamily:FONTS.mono,fontSize:8,color:colors.textDim,letterSpacing:4,marginTop:2},
  reactorStatus:{flexDirection:'row',alignItems:'center',gap:5,marginTop:space.sm},
  reactorStatusText:{fontFamily:FONTS.mono,fontSize:8,color:colors.online,letterSpacing:1.5},

  dots:{flexDirection:'row',justifyContent:'center',gap:6,paddingVertical:space.md},
  dot:{width:5,height:5,borderRadius:2.5,backgroundColor:colors.hairline},
  dotActive:{backgroundColor:colors.gold,width:18,borderRadius:2.5},

  panelContent:{paddingHorizontal:space.xl,paddingTop:space.xs,paddingBottom:space.xxxl},
  panelTopBar:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:space.lg},
  panelLabel:{...type.label},
  allDetached:{...type.meta,color:colors.textFaint,textAlign:'center',marginTop:space.md,lineHeight:16},

  bottomNav:{flexDirection:'row',borderTopWidth:1,borderTopColor:colors.hairline,paddingVertical:space.sm,backgroundColor:colors.bg},
  navItem:{flex:1,alignItems:'center',gap:4,paddingVertical:3},
  navLabel:{fontFamily:FONTS.mono,fontSize:7,color:colors.textDim,letterSpacing:1.5},

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
