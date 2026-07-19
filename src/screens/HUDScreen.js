import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,TextInput,Modal,Dimensions,Animated}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import Svg,{Circle}from 'react-native-svg';
import{getHudState,updateHudState,getTasks,addTask,completeTask,getTotalRevenue,updateEmpireScore}from '../services/database';
const{width}=Dimensions.get('window');
const RS=160,ST=12,CI=2*Math.PI*((RS-ST)/2);
const ROUTINE=['Pray','Charge tech','Calendar','Weather','Analytics','Emails','News','Finances','Study','Empire Sheets','Bible','Meditation','Memory Training','Social media post'];
const BATMAN=[{day:'MON',label:'Raw Power'},{day:'TUE',label:'Combat'},{day:'WED',label:'Hell Day'},{day:'THU',label:'Skill & Precision'},{day:'FRI',label:'Heavy Strength'},{day:'SAT',label:'Endurance & Pain'},{day:'SUN',label:'Active Recovery'}];
export default function HUDScreen({navigation}){
  const[hud,setHud]=useState(null);const[tasks,setTasks]=useState([]);const[rev,setRev]=useState(0);
  const[routine,setRoutine]=useState({});const[batman,setBatman]=useState({});
  const[newTask,setNewTask]=useState('');const[showAdd,setShowAdd]=useState(false);const[tab,setTab]=useState('score');
  const ra=useRef(new Animated.Value(0)).current;
  const AC=Animated.createAnimatedComponent(Circle);
  useEffect(()=>{load();},[]);
  async function load(){
    const h=await getHudState();const t=await getTasks();const r=await getTotalRevenue();
    setHud(h);setTasks(t);setRev(r);
    try{if(h?.morning_routine)setRoutine(JSON.parse(h.morning_routine));}catch{}
    try{if(h?.batman_protocol)setBatman(JSON.parse(h.batman_protocol));}catch{}
    Animated.timing(ra,{toValue:(h?.empire_score||0)/100,duration:1200,useNativeDriver:false}).start();
  }
  async function toggleR(item){const r={...routine,[item]:!routine[item]};setRoutine(r);await updateHudState({morning_routine:JSON.stringify(r)});recalc(r,batman);}
  async function toggleB(day){const b={...batman,[day]:!batman[day]};setBatman(b);await updateHudState({batman_protocol:JSON.stringify(b)});recalc(routine,b);}
  async function recalc(r,b){
    const rd=Object.values(r).filter(Boolean).length;const bd=Object.values(b).filter(Boolean).length>0?1:0;
    const td=tasks.filter(t=>t.completed).length;const tt=tasks.length;
    const sc=Math.round(Math.min(100,25+(rd/14)*30+(bd*25)+(tt>0?(td/tt)*20:0)));
    setHud(prev=>({...prev,empire_score:sc}));await updateEmpireScore(sc);
    Animated.timing(ra,{toValue:sc/100,duration:600,useNativeDriver:false}).start();
  }
  async function addT(){if(!newTask.trim())return;await addTask(newTask.trim());setNewTask('');setShowAdd(false);setTasks(await getTasks());}
  async function doneT(id){await completeTask(id);setTasks(await getTasks());}
  const score=hud?.empire_score||0;const streak=hud?.streak||0;
  const sdo=ra.interpolate({inputRange:[0,1],outputRange:[CI,0]});
  const today=BATMAN[new Date().getDay()===0?6:new Date().getDay()-1]?.day;
  return(<SafeAreaView style={s.c} edges={['top','bottom']}>
    <View style={s.hdr}><TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity><Text style={s.title}>EMPIRE HUD</Text><View style={{width:30}}/></View>
    <View style={s.tabs}>{['score','tasks','routine','batman','revenue'].map(t=>(<TouchableOpacity key={t} style={[s.tab,tab===t&&s.tabA]} onPress={()=>setTab(t)}><Text style={[s.tabT,tab===t&&s.tabTA]}>{t.toUpperCase()}</Text></TouchableOpacity>))}</View>
    <ScrollView style={{flex:1}}>
      {tab==='score'&&<View style={s.sec}>
        <View style={s.ring}>
          <Svg width={RS} height={RS}>
            <Circle cx={RS/2} cy={RS/2} r={(RS-ST)/2} stroke="#1A1A1A" strokeWidth={ST} fill="none"/>
            <AC cx={RS/2} cy={RS/2} r={(RS-ST)/2} stroke="#E8C98A" strokeWidth={ST} fill="none" strokeDasharray={CI} strokeDashoffset={sdo} strokeLinecap="round" rotation="-90" originX={RS/2} originY={RS/2}/>
          </Svg>
          <View style={s.rc}><Text style={s.sn}>{score}</Text><Text style={s.sp}>%</Text><Text style={s.sk}>{streak}🔥</Text></View>
        </View>
        <Text style={s.sl}>{score>=75?'▲ EMPIRE STRONG':score>=50?'— BUILDING TODAY':'▽ RISE UP'}</Text>
      </View>}
      {tab==='tasks'&&<View style={s.sec}>
        <View style={s.sh}><Text style={s.stt}>OPEN TASKS</Text><TouchableOpacity onPress={()=>setShowAdd(true)} style={s.ab}><Text style={s.abt}>+ ADD</Text></TouchableOpacity></View>
        {tasks.filter(t=>!t.completed).map(t=>(<View key={t.id} style={s.ti}><TouchableOpacity onPress={()=>doneT(t.id)}><View style={s.cb}/></TouchableOpacity><Text style={s.tt}>{t.title}</Text></View>))}
        {tasks.filter(t=>t.completed).length>0&&<Text style={s.dl}>✓ {tasks.filter(t=>t.completed).length} completed</Text>}
        <Modal visible={showAdd} transparent animationType="slide">
          <View style={s.mo}><View style={s.am}>
            <Text style={s.mt}>NEW TASK</Text>
            <TextInput style={s.ti2} value={newTask} onChangeText={setNewTask} placeholder="Task title..." placeholderTextColor="#333" autoFocus/>
            <View style={{flexDirection:'row',gap:10}}>
              <TouchableOpacity style={s.sb2} onPress={addT}><Text style={s.sbt}>ADD</Text></TouchableOpacity>
              <TouchableOpacity style={s.can} onPress={()=>setShowAdd(false)}><Text style={s.cant}>CANCEL</Text></TouchableOpacity>
            </View>
          </View></View>
        </Modal>
      </View>}
      {tab==='routine'&&<View style={s.sec}>
        <Text style={s.stt}>MORNING ROUTINE</Text>
        <Text style={s.ssub}>{Object.values(routine).filter(Boolean).length}/14 COMPLETE</Text>
        {ROUTINE.map((item,i)=>(<TouchableOpacity key={item} style={s.ri} onPress={()=>toggleR(item)}>
          <View style={[s.rc2,routine[item]&&s.rcd]}>{routine[item]&&<Text style={s.chk}>✓</Text>}</View>
          <Text style={[s.rl,routine[item]&&s.rld]}>{item}</Text>
          <Text style={s.rn}>{i+1}</Text>
        </TouchableOpacity>))}
      </View>}
      {tab==='batman'&&<View style={s.sec}>
        <Text style={s.stt}>BATMAN PROTOCOL</Text>
        <Text style={s.ssub}>WEEKLY TRAINING SPLIT</Text>
        {BATMAN.map(({day,label})=>(<TouchableOpacity key={day} style={[s.bi,day===today&&s.bit]} onPress={()=>toggleB(day)}>
          <View style={[s.bd,day===today&&{borderColor:'#E8C98A'}]}><Text style={[s.bdt,day===today&&{color:'#E8C98A'}]}>{day}</Text></View>
          <View style={{flex:1}}><Text style={s.bl}>{label}</Text></View>
          {day===today&&<Text style={s.tb}>TODAY</Text>}
          <View style={[s.bc,batman[day]&&s.bcd]}>{batman[day]&&<Text style={s.chk}>✓</Text>}</View>
        </TouchableOpacity>))}
      </View>}
      {tab==='revenue'&&<View style={s.sec}>
        <Text style={s.stt}>EMPIRE REVENUE</Text>
        <View style={s.rv}><Text style={s.rl2}>TOTAL</Text><Text style={s.ra2}>${rev.toLocaleString()}</Text></View>
        <Text style={s.rh}>Tell Atlas to log revenue: "Atlas, log $500 for Empire Digital"</Text>
      </View>}
    </ScrollView>
  </SafeAreaView>);
}
const s=StyleSheet.create({
  c:{flex:1,backgroundColor:'#000'},
  hdr:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#1A1A1A'},
  back:{fontSize:20,color:'#E8C98A'},title:{fontFamily:'monospace',fontSize:14,color:'#E8C98A',fontWeight:'700',letterSpacing:3},
  tabs:{flexDirection:'row',paddingHorizontal:12,paddingVertical:8,borderBottomWidth:1,borderBottomColor:'#111',gap:4,flexWrap:'wrap'},
  tab:{paddingHorizontal:10,paddingVertical:6,borderRadius:6,borderWidth:1,borderColor:'#1A1A1A'},
  tabA:{borderColor:'#E8C98A',backgroundColor:'#E8C98A11'},tabT:{fontFamily:'monospace',fontSize:8,color:'#333',letterSpacing:1},tabTA:{color:'#E8C98A'},
  sec:{padding:20},sh:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:16},
  stt:{fontFamily:'monospace',fontSize:12,color:'#E8C98A',letterSpacing:3,marginBottom:4},
  ssub:{fontFamily:'monospace',fontSize:9,color:'#444',letterSpacing:2,marginBottom:16},
  ring:{alignItems:'center',justifyContent:'center',marginBottom:8,position:'relative'},
  rc:{position:'absolute',alignItems:'center',justifyContent:'center'},
  sn:{fontFamily:'monospace',fontSize:36,fontWeight:'700',color:'#E8C98A'},sp:{fontFamily:'monospace',fontSize:14,color:'#E8C98A88',marginTop:-8},sk:{fontFamily:'monospace',fontSize:12,color:'#888',marginTop:4},
  sl:{fontFamily:'monospace',fontSize:11,color:'#555',letterSpacing:3,textAlign:'center',marginTop:8},
  ab:{paddingHorizontal:12,paddingVertical:6,backgroundColor:'#E8C98A',borderRadius:6},abt:{fontFamily:'monospace',fontSize:10,fontWeight:'700',color:'#000',letterSpacing:1},
  ti:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:10,borderBottomWidth:1,borderBottomColor:'#111'},
  cb:{width:18,height:18,borderWidth:1,borderColor:'#333',borderRadius:4},tt:{color:'#CCC',fontSize:14,flex:1},
  dl:{fontFamily:'monospace',fontSize:10,color:'#333',letterSpacing:2,marginTop:16,textAlign:'center'},
  mo:{flex:1,backgroundColor:'rgba(0,0,0,0.9)',justifyContent:'flex-end'},
  am:{backgroundColor:'#0D0D0D',borderTopWidth:1,borderTopColor:'#222',borderTopLeftRadius:20,borderTopRightRadius:20,padding:24},
  mt:{fontFamily:'monospace',fontSize:12,color:'#E8C98A',letterSpacing:3,marginBottom:16},
  ti2:{backgroundColor:'#111',borderWidth:1,borderColor:'#222',borderRadius:10,padding:14,color:'#DDD',fontSize:16,marginBottom:16},
  sb2:{flex:1,backgroundColor:'#E8C98A',padding:14,borderRadius:8,alignItems:'center'},sbt:{fontFamily:'monospace',fontWeight:'700',color:'#000',fontSize:12,letterSpacing:2},
  can:{flex:1,backgroundColor:'#111',padding:14,borderRadius:8,alignItems:'center',borderWidth:1,borderColor:'#222'},cant:{fontFamily:'monospace',color:'#444',fontSize:12,letterSpacing:2},
  ri:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:10,borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  rc2:{width:20,height:20,borderWidth:1,borderColor:'#333',borderRadius:4,alignItems:'center',justifyContent:'center'},
  rcd:{backgroundColor:'#E8C98A',borderColor:'#E8C98A'},chk:{fontSize:12,color:'#000',fontWeight:'700'},
  rl:{flex:1,color:'#666',fontSize:14},rld:{color:'#444',textDecorationLine:'line-through'},rn:{fontFamily:'monospace',fontSize:10,color:'#2A2A2A'},
  bi:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:12,paddingHorizontal:4,borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  bit:{backgroundColor:'#0D0D0D',borderRadius:8,paddingHorizontal:12},
  bd:{width:36,height:36,borderRadius:8,borderWidth:1,borderColor:'#222',alignItems:'center',justifyContent:'center'},bdt:{fontFamily:'monospace',fontSize:9,color:'#444',fontWeight:'700'},
  bl:{color:'#888',fontSize:13},tb:{fontFamily:'monospace',fontSize:8,color:'#E8C98A',letterSpacing:2},
  bc:{width:20,height:20,borderWidth:1,borderColor:'#333',borderRadius:4,alignItems:'center',justifyContent:'center'},bcd:{backgroundColor:'#E8C98A',borderColor:'#E8C98A'},
  rv:{backgroundColor:'#0A0A0A',borderWidth:1,borderColor:'#E8C98A22',borderRadius:12,padding:24,alignItems:'center',marginBottom:16},
  rl2:{fontFamily:'monospace',fontSize:10,color:'#444',letterSpacing:3},ra2:{fontFamily:'monospace',fontSize:32,fontWeight:'700',color:'#E8C98A',marginTop:8},
  rh:{fontFamily:'monospace',fontSize:10,color:'#333',textAlign:'center',letterSpacing:1,lineHeight:18},
});
