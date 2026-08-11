import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,TextInput,Modal,Dimensions}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import Svg,{Circle}from 'react-native-svg';
import{getHudState,updateHudState,getTasks,addTask,completeTask,getBusinessesWithRevenue,setBusinessTarget,addRevenue,updateEmpireScore}from '../services/database';
const{width}=Dimensions.get('window');
const RS=200,ST=10,CI=2*Math.PI*((RS-ST)/2);
const ROUTINE=['Pray','Charge tech','Calendar','Weather','Analytics','Emails','News','Finances','Study','Empire Sheets','Bible','Meditation','Memory Training','Social media post'];
const BATMAN=[{day:'MON',label:'Raw Power',desc:'Deadlifts, Bench Press, Pull-Ups, Squats, Overhead Press · 6×3-5'},{day:'TUE',label:'Combat',desc:'3+ hours martial arts, heavy bag, acrobatics'},{day:'WED',label:'Hell Day',desc:'Full body circuit 8-10 rounds + 10+ mile run'},{day:'THU',label:'Skill & Precision',desc:'Martial arts, detective work, parkour'},{day:'FRI',label:'Heavy Strength',desc:'Same as Monday, heavier'},{day:'SAT',label:'Endurance & Pain',desc:'2-4 hour conditioning, ruck march, swimming'},{day:'SUN',label:'Active Recovery',desc:'Mobility, meditation, study, plan'}];
const PANELS=['briefing','businesses','tasks','routine','batman','daily'];

export default function HUDScreen({navigation}){
  const[hud,setHud]=useState(null);
  const[tasks,setTasks]=useState([]);
  const[businesses,setBusinesses]=useState([]);
  const[routine,setRoutine]=useState({});
  const[batman,setBatman]=useState({});
  const[newTask,setNewTask]=useState('');
  const[showAddTask,setShowAddTask]=useState(false);
  const[panelIndex,setPanelIndex]=useState(0);
  const[bizModal,setBizModal]=useState(null);
  const[bizTargetInput,setBizTargetInput]=useState('');
  const[bizWeekGoalInput,setBizWeekGoalInput]=useState('');
  const[bizLogInput,setBizLogInput]=useState('');
  const scrollRef=useRef(null);

  useEffect(()=>{load();},[]);

  async function load(){
    const h=await getHudState();
    const t=await getTasks();
    const b=await getBusinessesWithRevenue();
    setHud(h);setTasks(t);setBusinesses(b);
    try{if(h?.morning_routine_done)setRoutine(JSON.parse(h.morning_routine_done));}catch{}
    try{if(h?.batman_protocol)setBatman(JSON.parse(h.batman_protocol));}catch{}
  }

  async function toggleRoutine(item){
    const r={...routine,[item]:!routine[item]};
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
  async function recalcScore(r,b,t){
    const rd=Object.values(r).filter(Boolean).length;
    const bd=Object.values(b).filter(Boolean).length>0?1:0;
    const td=t.filter(x=>x.completed).length;
    const tt=t.length;
    const sc=Math.round(Math.min(100,25+(rd/14)*30+(bd*25)+(tt>0?(td/tt)*20:0)));
    setHud(prev=>({...prev,empire_score:sc}));
    await updateEmpireScore(sc);
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
  const todayBatman=BATMAN[today===0?6:today-1];
  const routineDone=Object.values(routine).filter(Boolean).length;
  const tasksDone=tasks.filter(t=>t.completed).length;

  return(
    <SafeAreaView style={s.container} edges={['top','bottom']}>
      <View style={s.header}>
        <Text style={s.empireOS}>♔ EMPIRE OS</Text>
        <View style={s.onlinePill}><View style={s.onlineDot}/><Text style={s.onlineText}>ONLINE</Text></View>
      </View>

      <View style={s.reactorWrap}>
        <View style={s.reactor}>
          <Svg width={RS} height={RS}>
            <Circle cx={RS/2} cy={RS/2} r={(RS-ST)/2} stroke="#1A1A1A" strokeWidth={ST} fill="none"/>
            <Circle cx={RS/2} cy={RS/2} r={(RS-ST)/2} stroke="#E8C98A" strokeWidth={ST} fill="none" strokeDasharray={CI} strokeDashoffset={scoreOffset} strokeLinecap="round" rotation="-90" origin={`${RS/2},${RS/2}`}/>
          </Svg>
          <View style={s.reactorCore}>
            <Text style={s.reactorScore}>{score}<Text style={s.reactorPct}>%</Text></Text>
            <Text style={s.reactorLabel}>EMPIRE SCORE</Text>
            <Text style={s.reactorSub}>{score>=75?'▲ '+streak+' DAY STREAK':score>=50?'— BUILDING TODAY':'▽ STREAK AT RISK'}</Text>
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
        onMomentumScrollEnd={onScrollEnd}
        style={{flex:1}}
      >
        {/* BRIEFING */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent}>
          <Text style={s.panelLabel}>BRIEFING</Text>
          <View style={s.briefRow}>
            <Text style={s.briefIcon}>TASKS</Text>
            <View style={{flex:1}}>
              <Text style={s.briefMain}>{tasksDone} of {tasks.length} complete</Text>
              <Text style={s.briefSub}>{tasks.length-tasksDone} remaining</Text>
            </View>
          </View>
          <View style={s.briefRow}>
            <Text style={s.briefIcon}>ROUTINE</Text>
            <View style={{flex:1}}>
              <Text style={s.briefMain}>{routineDone} of 14 done</Text>
              <Text style={s.briefSub}>{routineDone>=14?'Fully complete':'Keep going'}</Text>
            </View>
          </View>
          <View style={s.briefRow}>
            <Text style={s.briefIcon}>TRAINING</Text>
            <View style={{flex:1}}>
              <Text style={s.briefMain}>{todayBatman.label}</Text>
              <Text style={s.briefSub}>{todayBatman.desc}</Text>
            </View>
          </View>
          <Text style={s.briefNote}>Calendar and email require Google Sign-In — not yet connected on this device.</Text>
        </ScrollView>

        {/* BUSINESS RINGS */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent}>
          <Text style={s.panelLabel}>THE EMPIRE · REVENUE / TARGET</Text>
          <View style={s.bizGrid}>
            {businesses.map((b,i)=>{
              const pct=b.target>0?Math.min(100,Math.round((b.rev/b.target)*100)):0;
              const bizCI=2*Math.PI*26;
              const bizOffset=bizCI-(bizCI*pct/100);
              const color=pct>=66?'#4a9e7a':pct>=33?'#c49a4a':pct>0?'#b05a5a':'#1A1A1A';
              return(
                <TouchableOpacity key={b.name} style={s.bizItem} onPress={()=>openBizModal(b)}>
                  <View style={s.bizRing}>
                    <Svg width={64} height={64}>
                      <Circle cx={32} cy={32} r={26} stroke="#1A1A1A" strokeWidth={4} fill="none"/>
                      <Circle cx={32} cy={32} r={26} stroke={color} strokeWidth={4} fill="none" strokeDasharray={bizCI} strokeDashoffset={bizOffset} strokeLinecap="round" rotation="-90" origin="32,32"/>
                    </Svg>
                    <View style={s.bizRingCore}><Text style={s.bizPct}>{b.target>0?pct+'%':'—'}</Text></View>
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
            <TouchableOpacity style={s.addBtn} onPress={()=>setShowAddTask(true)}><Text style={s.addBtnT}>+ ADD</Text></TouchableOpacity>
          </View>
          {tasks.filter(t=>!t.completed).map(t=>(
            <TouchableOpacity key={t.id} style={s.taskRow} onPress={()=>doneTask(t.id)}>
              <View style={s.chk}/>
              <Text style={s.taskName}>{t.title}</Text>
            </TouchableOpacity>
          ))}
          {!tasks.filter(t=>!t.completed).length&&<Text style={s.emptyText}>No open tasks.</Text>}
        </ScrollView>

        {/* MORNING ROUTINE */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent}>
          <Text style={s.panelLabel}>MORNING ROUTINE</Text>
          <Text style={s.panelMeta}>{routineDone} / 14</Text>
          {ROUTINE.map(item=>(
            <TouchableOpacity key={item} style={s.taskRow} onPress={()=>toggleRoutine(item)}>
              <View style={[s.chk,routine[item]&&s.chkDone]}>{routine[item]&&<Text style={s.chkMark}>✓</Text>}</View>
              <Text style={[s.taskName,routine[item]&&s.taskNameDone]}>{item}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* BATMAN PROTOCOL */}
        <ScrollView style={{width}} contentContainerStyle={s.panelContent}>
          <Text style={s.panelLabel}>BATMAN PROTOCOL · TODAY</Text>
          <Text style={s.batTitle}>{todayBatman.label}</Text>
          <Text style={s.batDesc}>{todayBatman.desc}</Text>
          <View style={s.batWeek}>
            {BATMAN.map(b=>(
              <TouchableOpacity key={b.day} style={[s.batDay,b.day===todayBatman.day&&s.batDayToday]} onPress={()=>toggleBatman(b.day)}>
                <Text style={[s.batDayT,b.day===todayBatman.day&&s.batDayTToday]}>{b.day}</Text>
                {batman[b.day]&&<Text style={s.batDone}>✓</Text>}
              </TouchableOpacity>
            ))}
          </View>
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
            <Text style={s.verseText}>"{hud?.verse_of_day||'—'}"</Text>
            <Text style={s.verseRef}>{hud?.verse_ref||''}</Text>
          </View>
          <View style={s.wvfSection}>
            <Text style={s.wvfLabel}>FACT OF THE DAY</Text>
            <Text style={s.wvfText}>{hud?.fact_of_day||'—'}</Text>
          </View>
        </ScrollView>
      </ScrollView>

      <View style={s.bottomNav}>
        <TouchableOpacity style={s.navItem} onPress={()=>navigation.navigate('Command')}>
          <Text style={s.navIcon}>✕</Text><Text style={s.navLabel}>COMMAND</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.navItem} onPress={()=>{}}>
          <Text style={[s.navIcon,{color:'#E8C98A'}]}>◉</Text><Text style={[s.navLabel,{color:'#E8C98A'}]}>HUD</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.navItem} onPress={()=>navigation.navigate('Memory')}>
          <Text style={s.navIcon}>☁</Text><Text style={s.navLabel}>MEMORY</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.navItem} onPress={()=>navigation.navigate('Settings')}>
          <Text style={s.navIcon}>⚙</Text><Text style={s.navLabel}>SETTINGS</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.navItem} onPress={()=>navigation.navigate('Map')}>
          <Text style={s.navIcon}>🗺</Text><Text style={s.navLabel}>MAP</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={showAddTask} transparent animationType="slide">
        <View style={s.modalOver}><View style={s.modalContent}>
          <Text style={s.modalTitle}>NEW TASK</Text>
          <TextInput style={s.modalInput} value={newTask} onChangeText={setNewTask} placeholder="Task title..." placeholderTextColor="#333" autoFocus/>
          <View style={{flexDirection:'row',gap:10,marginTop:16}}>
            <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#E8C98A'}]} onPress={addNewTask}><Text style={[s.modalBtnT,{color:'#000'}]}>ADD</Text></TouchableOpacity>
            <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={()=>setShowAddTask(false)}><Text style={[s.modalBtnT,{color:'#555'}]}>CANCEL</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>

      <Modal visible={!!bizModal} transparent animationType="slide">
        <View style={s.modalOver}><View style={s.modalContent}>
          {bizModal&&<>
            <Text style={s.modalTitle}>{bizModal.name}</Text>
            <Text style={s.modalSub}>THIS MONTH: ${bizModal.rev.toLocaleString()}</Text>
            <Text style={s.fieldLabel}>MONTHLY TARGET</Text>
            <TextInput style={s.modalInput} value={bizTargetInput} onChangeText={setBizTargetInput} keyboardType="numeric" placeholderTextColor="#333"/>
            <Text style={s.fieldLabel}>WEEKLY GOAL</Text>
            <TextInput style={s.modalInput} value={bizWeekGoalInput} onChangeText={setBizWeekGoalInput} keyboardType="numeric" placeholderTextColor="#333"/>
            <Text style={s.fieldLabel}>LOG REVENUE (OPTIONAL)</Text>
            <TextInput style={s.modalInput} value={bizLogInput} onChangeText={setBizLogInput} keyboardType="numeric" placeholder="Amount to add" placeholderTextColor="#333"/>
            <View style={{flexDirection:'row',gap:10,marginTop:16}}>
              <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#E8C98A'}]} onPress={saveBizModal}><Text style={[s.modalBtnT,{color:'#000'}]}>SAVE</Text></TouchableOpacity>
              <TouchableOpacity style={[s.modalBtn,{backgroundColor:'#111',borderWidth:1,borderColor:'#333'}]} onPress={()=>setBizModal(null)}><Text style={[s.modalBtnT,{color:'#555'}]}>CANCEL</Text></TouchableOpacity>
            </View>
          </>}
        </View></View>
      </Modal>
    </SafeAreaView>
  );
}

const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:16,paddingVertical:8,borderBottomWidth:1,borderBottomColor:'#111'},
  empireOS:{fontFamily:'monospace',fontSize:14,fontWeight:'700',color:'#E8C98A',letterSpacing:2},
  onlinePill:{flexDirection:'row',alignItems:'center',gap:5,borderWidth:1,borderColor:'#4CAF5055',borderRadius:12,paddingHorizontal:8,paddingVertical:3},
  onlineDot:{width:6,height:6,borderRadius:3,backgroundColor:'#4CAF50'},
  onlineText:{fontFamily:'monospace',fontSize:8,color:'#4CAF50',letterSpacing:2},
  reactorWrap:{alignItems:'center',paddingTop:14,paddingBottom:6},
  reactor:{width:RS,height:RS,alignItems:'center',justifyContent:'center'},
  reactorCore:{position:'absolute',alignItems:'center',justifyContent:'center'},
  reactorScore:{fontFamily:'monospace',fontSize:44,fontWeight:'700',color:'#E8C98A'},
  reactorPct:{fontSize:18,color:'#E8C98A88'},
  reactorLabel:{fontFamily:'monospace',fontSize:9,color:'#555',letterSpacing:3,marginTop:2},
  reactorSub:{fontFamily:'monospace',fontSize:9,color:'#4CAF50',letterSpacing:1,marginTop:8},
  dots:{flexDirection:'row',justifyContent:'center',gap:6,paddingVertical:8},
  dot:{width:5,height:5,borderRadius:2.5,backgroundColor:'#222'},
  dotActive:{backgroundColor:'#E8C98A',width:16,borderRadius:3},
  panelContent:{padding:18,paddingBottom:30},
  panelLabel:{fontFamily:'monospace',fontSize:9,letterSpacing:3,color:'#555',marginBottom:12},
  panelMeta:{fontFamily:'monospace',fontSize:9,color:'#E8C98A',letterSpacing:1,marginBottom:12,marginTop:-8},
  panelHeadRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:12},
  addBtn:{paddingHorizontal:10,paddingVertical:5,backgroundColor:'#E8C98A',borderRadius:4},
  addBtnT:{fontFamily:'monospace',fontSize:9,fontWeight:'700',color:'#000',letterSpacing:1},
  briefRow:{flexDirection:'row',alignItems:'center',gap:14,paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#111'},
  briefIcon:{fontFamily:'monospace',fontSize:8,color:'#555',letterSpacing:1,width:56},
  briefMain:{color:'#DDD',fontSize:14},
  briefSub:{fontFamily:'monospace',fontSize:8,color:'#555',marginTop:2},
  briefNote:{fontFamily:'monospace',fontSize:8,color:'#333',marginTop:16,lineHeight:16},
  bizGrid:{flexDirection:'row',flexWrap:'wrap',gap:10},
  bizItem:{width:(width-36-20)/3,alignItems:'center',paddingVertical:10},
  bizRing:{width:64,height:64,alignItems:'center',justifyContent:'center'},
  bizRingCore:{position:'absolute',alignItems:'center',justifyContent:'center'},
  bizPct:{fontFamily:'monospace',fontSize:10,color:'#DDD'},
  bizName:{fontFamily:'monospace',fontSize:7,color:'#888',textAlign:'center',marginTop:6,lineHeight:11},
  taskRow:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:10,borderBottomWidth:1,borderBottomColor:'#111'},
  chk:{width:18,height:18,borderWidth:1,borderColor:'#333',borderRadius:4,alignItems:'center',justifyContent:'center'},
  chkDone:{backgroundColor:'#E8C98A',borderColor:'#E8C98A'},
  chkMark:{fontSize:11,color:'#000',fontWeight:'700'},
  taskName:{color:'#CCC',fontSize:14,flex:1},
  taskNameDone:{color:'#444',textDecorationLine:'line-through'},
  emptyText:{fontFamily:'monospace',fontSize:10,color:'#333',marginTop:10},
  batTitle:{fontFamily:'monospace',fontSize:22,color:'#DDD',marginBottom:4},
  batDesc:{fontFamily:'monospace',fontSize:9,color:'#888',marginBottom:20,lineHeight:16},
  batWeek:{flexDirection:'row',gap:6,flexWrap:'wrap'},
  batDay:{flex:1,minWidth:70,alignItems:'center',paddingVertical:10,borderWidth:1,borderColor:'#1A1A1A',borderRadius:4},
  batDayToday:{borderColor:'#E8C98A66',backgroundColor:'#E8C98A11'},
  batDayT:{fontFamily:'monospace',fontSize:9,color:'#555',letterSpacing:1},
  batDayTToday:{color:'#E8C98A'},
  batDone:{color:'#4CAF50',fontSize:10,marginTop:2},
  wvfSection:{paddingVertical:14,borderBottomWidth:1,borderBottomColor:'#111'},
  wvfLabel:{fontFamily:'monospace',fontSize:8,letterSpacing:2,color:'#555',marginBottom:8},
  wordMain:{fontFamily:'monospace',fontSize:20,color:'#E8C98A'},
  wordPhon:{fontFamily:'monospace',fontSize:10,color:'#555',marginTop:2,marginBottom:6},
  wvfText:{color:'#AAA',fontSize:13,lineHeight:20},
  verseText:{fontFamily:'monospace',fontSize:13,color:'#CCC',lineHeight:20,marginBottom:6},
  verseRef:{fontFamily:'monospace',fontSize:9,color:'#555',letterSpacing:1},
  bottomNav:{flexDirection:'row',borderTopWidth:1,borderTopColor:'#111',paddingVertical:6,backgroundColor:'#000'},
  navItem:{flex:1,alignItems:'center',paddingVertical:3},
  navIcon:{fontSize:12,color:'#444',marginBottom:2},
  navLabel:{fontFamily:'monospace',fontSize:6,color:'#444',letterSpacing:1},
  modalOver:{flex:1,backgroundColor:'rgba(0,0,0,0.92)',justifyContent:'flex-end'},
  modalContent:{backgroundColor:'#0A0A0A',borderTopWidth:1,borderTopColor:'#1A1A1A',borderTopLeftRadius:16,borderTopRightRadius:16,padding:20},
  modalTitle:{fontFamily:'monospace',fontSize:12,color:'#E8C98A',letterSpacing:3,marginBottom:6},
  modalSub:{fontFamily:'monospace',fontSize:9,color:'#4CAF50',letterSpacing:1,marginBottom:16},
  fieldLabel:{fontFamily:'monospace',fontSize:8,color:'#555',letterSpacing:1,marginBottom:6,marginTop:10},
  modalInput:{backgroundColor:'#111',borderWidth:1,borderColor:'#222',borderRadius:8,padding:12,color:'#DDD',fontSize:14},
  modalBtn:{flex:1,padding:12,borderRadius:8,alignItems:'center'},
  modalBtnT:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:2},
});
