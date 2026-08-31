import React,{useState,useCallback,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,TextInput,Modal,Dimensions}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import Svg,{Circle,Defs,LinearGradient,Stop}from 'react-native-svg';
import{Feather}from '@expo/vector-icons';
import{getHudState,updateHudState,getTasks,addTask,updateTask,deleteTask,completeTask,getBusinessesWithRevenue,setBusinessTarget,addRevenue,updateEmpireScore,getMorningRoutine,saveMorningRoutine,getBatmanTemplate,saveBatmanTemplate,DEFAULT_BATMAN}from '../services/database';
import{colors,space,radius,type,FONTS}from '../theme';
const{width}=Dimensions.get('window');
const RS=196,ST=6,CI=2*Math.PI*((RS-ST)/2);
const PANELS=['briefing','businesses','tasks','routine','batman','daily'];
const NAV=[
  {key:'Command',icon:'terminal',label:'COMMAND'},
  {key:'HUD',icon:'target',label:'HUD'},
  {key:'Memory',icon:'cloud',label:'MEMORY'},
  {key:'Settings',icon:'settings',label:'SETTINGS'},
  {key:'Map',icon:'map',label:'MAP'},
];
const newId=()=>'r_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);

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
  const[bizModal,setBizModal]=useState(null);
  const[bizTargetInput,setBizTargetInput]=useState('');
  const[bizWeekGoalInput,setBizWeekGoalInput]=useState('');
  const[bizLogInput,setBizLogInput]=useState('');
  const[editRoutine,setEditRoutine]=useState(false);
  const[routineDraft,setRoutineDraft]=useState([]);
  const[editBatman,setEditBatman]=useState(false);
  const[batmanDraft,setBatmanDraft]=useState([]);
  const[taskEdit,setTaskEdit]=useState(null);
  const[taskEditInput,setTaskEditInput]=useState('');
  const scrollRef=useRef(null);
  const editingRef=useRef(false);
  editingRef.current=editRoutine||editBatman||!!taskEdit||showAddTask||!!bizModal;

  useFocusEffect(useCallback(()=>{if(!editingRef.current)load();},[]));

  async function load(){
    const h=await getHudState();
    const t=await getTasks();
    const b=await getBusinessesWithRevenue();
    const{items,done}=await getMorningRoutine();
    const bt=await getBatmanTemplate();
    setHud(h);setTasks(t);setBusinesses(b);
    setRoutineItems(items);setRoutine(done);
    setBatmanTemplate(bt);
    try{setBatman(JSON.parse(h?.batman_protocol||'{}'));}catch{setBatman({});}
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

  function startEditRoutine(){setRoutineDraft(routineItems.map(i=>({...i})));setEditRoutine(true);}
  function draftSetLabel(idx,val){setRoutineDraft(d=>d.map((it,i)=>i===idx?{...it,label:val}:it));}
  function draftMove(idx,dir){setRoutineDraft(d=>{const n=[...d];const j=idx+dir;if(j<0||j>=n.length)return n;[n[idx],n[j]]=[n[j],n[idx]];return n;});}
  function draftRemove(idx){setRoutineDraft(d=>d.filter((_,i)=>i!==idx));}
  function draftAdd(){setRoutineDraft(d=>[...d,{id:newId(),label:''}]);}
  async function saveRoutine(){
    const clean=routineDraft.map(it=>({id:it.id,label:it.label.trim()})).filter(it=>it.label);
    await saveMorningRoutine(clean);
    const validIds=new Set(clean.map(i=>i.id));
    const prunedDone={};Object.keys(routine).forEach(k=>{if(validIds.has(k))prunedDone[k]=routine[k];});
    await updateHudState({morning_routine_done:JSON.stringify(prunedDone)});
    setEditRoutine(false);
    await load();
    recalcScore(prunedDone,batman,tasks,clean.length);
  }

  function startEditBatman(){setBatmanDraft(batmanTemplate.map(d=>({...d})));setEditBatman(true);}
  function batmanDraftSet(idx,field,val){setBatmanDraft(d=>d.map((it,i)=>i===idx?{...it,[field]:val}:it));}
  async function saveBatman(){
    await saveBatmanTemplate(batmanDraft);
    setEditBatman(false);
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
  function goToPanel(i){
    const idx=Math.max(0,Math.min(PANELS.length-1,i));
    setPanelIndex(idx);
    scrollRef.current?.scrollTo({x:idx*width,animated:true});
  }
  function onScrollEnd(e){
    const idx=Math.round(e.nativeEvent.contentOffset.x/width);
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
        {PANELS.map((p,i)=>(
          <TouchableOpacity key={p} onPress={()=>goToPanel(i)} style={[s.dot,panelIndex===i&&s.dotActive]}/>
        ))}
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        snapToInterval={width}
        snapToAlignment="start"
        decelerationRate="fast"
        disableIntervalMomentum
        showsHorizontalScrollIndicator={false}
        scrollEnabled={!editRoutine&&!editBatman}
        onMomentumScrollEnd={onScrollEnd}
        style={{flex:1}}
      >
        {/* BRIEFING */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent}>
          <Text style={s.panelLabel}>BRIEFING</Text>
          <View style={s.briefRow}>
            <View style={s.briefIcon}><Feather name="check-square" size={15} color={colors.brass}/></View>
            <View style={{flex:1}}>
              <Text style={s.briefMain}>{tasksDone} of {tasks.length} tasks complete</Text>
              <Text style={s.briefSub}>{tasks.length-tasksDone} remaining</Text>
            </View>
          </View>
          <View style={s.briefRow}>
            <View style={s.briefIcon}><Feather name="sunrise" size={15} color={colors.brass}/></View>
            <View style={{flex:1}}>
              <Text style={s.briefMain}>{routineDone} of {routineItems.length} routine done</Text>
              <Text style={s.briefSub}>{routineItems.length>0&&routineDone>=routineItems.length?'Fully complete':'Keep going'}</Text>
            </View>
          </View>
          <View style={s.briefRow}>
            <View style={s.briefIcon}><Feather name="activity" size={15} color={colors.brass}/></View>
            <View style={{flex:1}}>
              <Text style={s.briefMain}>{todayBatman?.label}</Text>
              <Text style={s.briefSub}>{todayBatman?.desc}</Text>
            </View>
          </View>
          <Text style={s.briefNote}>Calendar and email require Google Sign-In — not yet connected on this device.</Text>
        </ScrollView>

        {/* BUSINESS RINGS */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent}>
          <Text style={s.panelLabel}>THE EMPIRE · REVENUE / TARGET</Text>
          <View style={s.bizGrid}>
            {businesses.map((b)=>{
              const pct=b.target>0?Math.min(100,Math.round((b.rev/b.target)*100)):0;
              const bizCI=2*Math.PI*25;
              const bizOffset=bizCI-(bizCI*pct/100);
              const color=pct>=66?colors.ringHigh:pct>=33?colors.ringMid:pct>0?colors.ringLow:colors.ringTrack;
              return(
                <TouchableOpacity key={b.name} style={s.bizItem} onPress={()=>openBizModal(b)} activeOpacity={0.7}>
                  <View style={s.bizRing}>
                    <Svg width={62} height={62}>
                      <Circle cx={31} cy={31} r={25} stroke={colors.ringTrack} strokeWidth={3.5} fill="none"/>
                      <Circle cx={31} cy={31} r={25} stroke={color} strokeWidth={3.5} fill="none" strokeDasharray={bizCI} strokeDashoffset={bizOffset} strokeLinecap="round" rotation="-90" origin="31,31"/>
                    </Svg>
                    <View style={s.bizRingCore}><Text style={s.bizPct}>{b.target>0?pct:'—'}</Text></View>
                  </View>
                  <Text style={s.bizName} numberOfLines={2}>{b.name}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </ScrollView>

        {/* TASKS */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent}>
          <View style={s.panelHeadRow}>
            <Text style={s.panelLabel}>GOOGLE TASKS · LOCAL</Text>
            <TouchableOpacity style={s.addBtn} onPress={()=>setShowAddTask(true)} activeOpacity={0.7}>
              <Feather name="plus" size={11} color={colors.bg}/>
              <Text style={s.addBtnT}>ADD</Text>
            </TouchableOpacity>
          </View>
          {openTasks.map(t=>(
            <TouchableOpacity key={t.id} style={s.taskRow} onPress={()=>doneTask(t.id)} onLongPress={()=>openTaskEdit(t)} delayLongPress={300} activeOpacity={0.6}>
              <Feather name="circle" size={17} color={colors.textDim}/>
              <Text style={s.taskName}>{t.title}</Text>
              <Feather name="more-vertical" size={13} color={colors.textFaint}/>
            </TouchableOpacity>
          ))}
          {!openTasks.length&&<Text style={s.emptyText}>No open tasks.</Text>}
          {!!openTasks.length&&<Text style={s.hintText}>Long-press a task to edit or delete.</Text>}
        </ScrollView>

        {/* MORNING ROUTINE */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent} keyboardShouldPersistTaps="handled">
          <View style={s.panelHeadRow}>
            <Text style={s.panelLabel}>MORNING ROUTINE</Text>
            {editRoutine?(
              <View style={s.editHeadBtns}>
                <TouchableOpacity style={s.ghostBtn} onPress={()=>setEditRoutine(false)}><Text style={s.ghostBtnT}>CANCEL</Text></TouchableOpacity>
                <TouchableOpacity style={s.addBtn} onPress={saveRoutine} activeOpacity={0.7}><Feather name="check" size={11} color={colors.bg}/><Text style={s.addBtnT}>DONE</Text></TouchableOpacity>
              </View>
            ):(
              <View style={s.editHeadBtns}>
                <Text style={s.panelMeta}>{routineDone} / {routineItems.length}</Text>
                <TouchableOpacity style={s.ghostBtn} onPress={startEditRoutine} activeOpacity={0.7}><Feather name="edit-2" size={10} color={colors.gold}/><Text style={s.ghostBtnT}>EDIT</Text></TouchableOpacity>
              </View>
            )}
          </View>

          {!editRoutine&&routineItems.map(item=>(
            <TouchableOpacity key={item.id} style={s.taskRow} onPress={()=>toggleRoutine(item.id)} activeOpacity={0.6}>
              <Feather name={routine[item.id]?'check-circle':'circle'} size={17} color={routine[item.id]?colors.gold:colors.textDim}/>
              <Text style={[s.taskName,routine[item.id]&&s.taskNameDone]}>{item.label}</Text>
            </TouchableOpacity>
          ))}
          {!editRoutine&&!routineItems.length&&<Text style={s.emptyText}>No routine items. Tap EDIT to add some.</Text>}

          {editRoutine&&routineDraft.map((item,idx)=>(
            <View key={item.id} style={s.editRow}>
              <View style={s.reorderCol}>
                <TouchableOpacity onPress={()=>draftMove(idx,-1)} hitSlop={{top:6,bottom:6,left:6,right:6}}><Feather name="chevron-up" size={16} color={idx===0?colors.textFaint:colors.textDim}/></TouchableOpacity>
                <TouchableOpacity onPress={()=>draftMove(idx,1)} hitSlop={{top:6,bottom:6,left:6,right:6}}><Feather name="chevron-down" size={16} color={idx===routineDraft.length-1?colors.textFaint:colors.textDim}/></TouchableOpacity>
              </View>
              <TextInput style={s.editInput} value={item.label} onChangeText={v=>draftSetLabel(idx,v)} placeholder="Routine item…" placeholderTextColor={colors.textFaint}/>
              <TouchableOpacity onPress={()=>draftRemove(idx)} hitSlop={{top:8,bottom:8,left:8,right:8}}><Feather name="trash-2" size={15} color={colors.danger}/></TouchableOpacity>
            </View>
          ))}
          {editRoutine&&(
            <TouchableOpacity style={s.addItemRow} onPress={draftAdd} activeOpacity={0.7}>
              <Feather name="plus" size={15} color={colors.gold}/>
              <Text style={s.addItemT}>Add item</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {/* BATMAN PROTOCOL */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent} keyboardShouldPersistTaps="handled">
          <View style={s.panelHeadRow}>
            <Text style={s.panelLabel}>BATMAN PROTOCOL{editBatman?' · TEMPLATE':' · TODAY'}</Text>
            {editBatman?(
              <View style={s.editHeadBtns}>
                <TouchableOpacity style={s.ghostBtn} onPress={()=>setEditBatman(false)}><Text style={s.ghostBtnT}>CANCEL</Text></TouchableOpacity>
                <TouchableOpacity style={s.addBtn} onPress={saveBatman} activeOpacity={0.7}><Feather name="check" size={11} color={colors.bg}/><Text style={s.addBtnT}>DONE</Text></TouchableOpacity>
              </View>
            ):(
              <TouchableOpacity style={s.ghostBtn} onPress={startEditBatman} activeOpacity={0.7}><Feather name="edit-2" size={10} color={colors.gold}/><Text style={s.ghostBtnT}>EDIT</Text></TouchableOpacity>
            )}
          </View>

          {!editBatman&&<>
            <Text style={s.batTitle}>{todayBatman?.label}</Text>
            <Text style={s.batDesc}>{todayBatman?.desc}</Text>
            <View style={s.batWeek}>
              {batmanTemplate.map(b=>(
                <TouchableOpacity key={b.day} style={[s.batDay,b.day===todayBatman?.day&&s.batDayToday]} onPress={()=>toggleBatman(b.day)} activeOpacity={0.7}>
                  <Text style={[s.batDayT,b.day===todayBatman?.day&&s.batDayTToday]}>{b.day}</Text>
                  <Feather name="check" size={11} color={batman[b.day]?colors.online:'transparent'} style={{marginTop:3}}/>
                </TouchableOpacity>
              ))}
            </View>
          </>}

          {editBatman&&batmanDraft.map((d,idx)=>(
            <View key={d.day} style={s.batEditRow}>
              <Text style={s.batEditDay}>{d.day}</Text>
              <View style={{flex:1,gap:6}}>
                <TextInput style={s.editInput} value={d.label} onChangeText={v=>batmanDraftSet(idx,'label',v)} placeholder="Focus" placeholderTextColor={colors.textFaint}/>
                <TextInput style={[s.editInput,s.editInputMulti]} value={d.desc} onChangeText={v=>batmanDraftSet(idx,'desc',v)} placeholder="Description" placeholderTextColor={colors.textFaint} multiline/>
              </View>
            </View>
          ))}
        </ScrollView>

        {/* WORD / VERSE / FACT */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent}>
          <Text style={s.panelLabel}>DAILY</Text>
          <View style={s.wvfSection}>
            <Text style={s.wvfLabel}>WORD OF THE DAY</Text>
            <Text style={s.wordMain}>{hud?.word_of_day||'—'}</Text>
            <Text style={s.wordPhon}>{hud?.word_phonetic||''}</Text>
            <Text style={s.wvfText}>{hud?.word_def||''}</Text>
          </View>
          <View style={s.wvfSection}>
            <Text style={s.wvfLabel}>VERSE OF THE DAY</Text>
            <Text style={s.verseText}>“{hud?.verse_of_day||'—'}”</Text>
            <Text style={s.verseRef}>{hud?.verse_ref||''}</Text>
          </View>
          <View style={[s.wvfSection,s.wvfSectionLast]}>
            <Text style={s.wvfLabel}>FACT OF THE DAY</Text>
            <Text style={s.wvfText}>{hud?.fact_of_day||'—'}</Text>
          </View>
        </ScrollView>
      </ScrollView>

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
  panelLabel:{...type.label,marginBottom:space.lg},
  panelMeta:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:2},
  panelHeadRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:space.lg},
  editHeadBtns:{flexDirection:'row',alignItems:'center',gap:space.md},
  addBtn:{flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:space.md,paddingVertical:6,backgroundColor:colors.gold,borderRadius:radius.sm},
  addBtnT:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.bg,letterSpacing:2},
  ghostBtn:{flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:space.sm,paddingVertical:5,borderWidth:1,borderColor:colors.hairlineGold,borderRadius:radius.sm},
  ghostBtnT:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:2},

  briefRow:{flexDirection:'row',alignItems:'center',gap:space.lg,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  briefIcon:{width:26,alignItems:'center'},
  briefMain:{fontFamily:FONTS.mono,fontSize:13,color:colors.text,letterSpacing:0.2},
  briefSub:{fontFamily:FONTS.mono,fontSize:8,color:colors.textDim,marginTop:3,letterSpacing:0.5,lineHeight:13},
  briefNote:{...type.meta,color:colors.textFaint,marginTop:space.xl,lineHeight:15},

  bizGrid:{flexDirection:'row',flexWrap:'wrap',rowGap:space.md,columnGap:space.sm},
  bizItem:{width:(width-space.xl*2-space.sm*2)/3,alignItems:'center',paddingVertical:space.sm},
  bizRing:{width:62,height:62,alignItems:'center',justifyContent:'center'},
  bizRingCore:{position:'absolute',alignItems:'center',justifyContent:'center'},
  bizPct:{fontFamily:FONTS.monoMed,fontSize:12,color:colors.text},
  bizName:{fontFamily:FONTS.mono,fontSize:7,color:colors.textMuted,textAlign:'center',marginTop:space.sm,letterSpacing:0.5,lineHeight:11},

  taskRow:{flexDirection:'row',alignItems:'center',gap:space.md,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  taskName:{fontFamily:FONTS.mono,fontSize:13,color:colors.text,flex:1,letterSpacing:0.2},
  taskNameDone:{color:colors.textFaint,textDecorationLine:'line-through'},
  emptyText:{...type.meta,color:colors.textFaint,marginTop:space.md},
  hintText:{...type.meta,color:colors.textFaint,marginTop:space.md,letterSpacing:0.5},

  editRow:{flexDirection:'row',alignItems:'center',gap:space.sm,paddingVertical:6,borderBottomWidth:1,borderBottomColor:colors.hairline},
  reorderCol:{alignItems:'center'},
  editInput:{flex:1,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.sm,paddingHorizontal:space.md,paddingVertical:8,color:colors.text,fontFamily:FONTS.mono,fontSize:13},
  editInputMulti:{minHeight:38,textAlignVertical:'top'},
  addItemRow:{flexDirection:'row',alignItems:'center',gap:space.sm,paddingVertical:space.md,marginTop:space.sm},
  addItemT:{fontFamily:FONTS.monoMed,fontSize:11,color:colors.gold,letterSpacing:1},

  batTitle:{fontFamily:FONTS.displayMed,fontSize:32,color:colors.text,letterSpacing:0.5,marginBottom:space.xs},
  batDesc:{fontFamily:FONTS.mono,fontSize:9,color:colors.textMuted,lineHeight:16,marginBottom:space.xl},
  batWeek:{flexDirection:'row',gap:6,flexWrap:'wrap'},
  batDay:{flex:1,minWidth:64,alignItems:'center',paddingVertical:space.md,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.sm},
  batDayToday:{borderColor:colors.hairlineGold,backgroundColor:'rgba(232,201,138,0.06)'},
  batDayT:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:1.5},
  batDayTToday:{color:colors.gold},
  batEditRow:{flexDirection:'row',gap:space.md,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  batEditDay:{fontFamily:FONTS.monoMed,fontSize:10,color:colors.gold,letterSpacing:1.5,width:34,paddingTop:10},

  wvfSection:{paddingVertical:space.lg,borderBottomWidth:1,borderBottomColor:colors.hairline},
  wvfSectionLast:{borderBottomWidth:0},
  wvfLabel:{fontFamily:FONTS.mono,fontSize:8,letterSpacing:2.5,color:colors.textDim,marginBottom:space.md},
  wordMain:{...type.word},
  wordPhon:{fontFamily:FONTS.mono,fontSize:10,color:colors.textDim,marginTop:4,marginBottom:space.sm,letterSpacing:0.5},
  wvfText:{fontFamily:FONTS.mono,fontSize:12,color:colors.textMuted,lineHeight:19,letterSpacing:0.2},
  verseText:{...type.verse,marginBottom:space.sm},
  verseRef:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:2},

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
