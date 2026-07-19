import React,{useEffect,useRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView,Animated,Dimensions,StatusBar}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{PERSONA_LIST}from '../personas/personas';
import{getHudState,getTasks}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
const{width}=Dimensions.get('window');
const BUILDINGS=[
  {personaId:'jarvis',label:'THE TOWER',subtitle:'Command'},
  {personaId:'ara',label:'THE ORACLE',subtitle:'Operations'},
  {personaId:'selene',label:'THE STUDIO',subtitle:'Creative'},
  {personaId:'atlas',label:'THE VAULT',subtitle:'Wealth'},
  {personaId:'rogue',label:'THE ARENA',subtitle:'Content'},
  {personaId:'stephanie',label:'THE ACADEMY',subtitle:'Knowledge'},
  {personaId:'haven',label:'THE SANCTUARY',subtitle:'Wellness'},
  {personaId:'aisha',label:'THE CHAMBER',subtitle:'Legal'},
  {personaId:'ezekiel',label:'SANCTUARY OF TRUTH',subtitle:'Spirit'},
];
export default function KingdomMapScreen({navigation}){
  const{setHudState,setTasks}=useEmpireStore();
  const pulse=useRef(new Animated.Value(1)).current;
  const fade=useRef(new Animated.Value(0)).current;
  const hudState=useEmpireStore(s=>s.hudState);
  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:800,useNativeDriver:true}).start();
    Animated.loop(Animated.sequence([Animated.timing(pulse,{toValue:1.02,duration:2500,useNativeDriver:true}),Animated.timing(pulse,{toValue:1,duration:2500,useNativeDriver:true})])).start();
    getHudState().then(h=>{setHudState(h);});getTasks().then(t=>setTasks(t));
  },[]);
  const score=hudState?.empire_score||0;const streak=hudState?.streak||0;
  return(<View style={s.c}>
    <StatusBar barStyle="light-content" backgroundColor="#000"/>
    <SafeAreaView edges={['top']}>
      <View style={s.hdr}>
        <View><Text style={s.el}>EMPIRE OS</Text><Text style={s.sl}>THE KINGDOM</Text></View>
        <View style={s.hr}>
          <TouchableOpacity style={s.sc} onPress={()=>navigation.navigate('HUD')}><Text style={s.st}>{score}%</Text><Text style={s.sk}>{streak}🔥</Text></TouchableOpacity>
          <TouchableOpacity style={s.hb} onPress={()=>navigation.navigate('HUD')}><Text style={s.hbt}>HUD</Text></TouchableOpacity>
        </View>
      </View>
    </SafeAreaView>
    <Animated.View style={{flex:1,opacity:fade}}>
      <ScrollView contentContainerStyle={s.mc} showsVerticalScrollIndicator={false}>
        <TouchableOpacity style={s.wr} onPress={()=>navigation.navigate('Council')} activeOpacity={0.8}>
          <View style={s.wri}><Text style={s.wi}>⚔</Text><Text style={s.wl}>WAR ROOM</Text><Text style={s.ws}>COUNCIL · EMPIRE · CUSTOM</Text></View>
        </TouchableOpacity>
        <View style={s.grid}>
          {BUILDINGS.map(b=>{
            const p=PERSONA_LIST.find(x=>x.id===b.personaId);if(!p)return null;
            return(<TouchableOpacity key={b.personaId} style={s.bc} onPress={()=>navigation.navigate('Persona',{personaId:b.personaId})} activeOpacity={0.8}>
              <Animated.View style={[s.bi,{borderColor:p.color,transform:[{scale:pulse}]}]}>
                <View style={[s.glow,{backgroundColor:p.color+'15'}]}/>
                <Text style={[s.icon,{color:p.color}]}>{p.icon}</Text>
                <Text style={[s.bl,{color:p.color}]}>{b.label}</Text>
                <Text style={s.bsub}>{b.subtitle}</Text>
                <Text style={s.bp}>{p.name}</Text>
              </Animated.View>
            </TouchableOpacity>);
          })}
        </View>
        <TouchableOpacity style={s.set} onPress={()=>navigation.navigate('Settings')}><Text style={s.setT}>⚙ SETTINGS</Text></TouchableOpacity>
      </ScrollView>
    </Animated.View>
  </View>);
}
const s=StyleSheet.create({
  c:{flex:1,backgroundColor:'#000'},
  hdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:20,paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#1A1A1A'},
  el:{fontFamily:'monospace',fontSize:18,fontWeight:'700',color:'#E8C98A',letterSpacing:4},
  sl:{fontFamily:'monospace',fontSize:9,color:'#555',letterSpacing:3,marginTop:2},
  hr:{flexDirection:'row',alignItems:'center',gap:10},
  sc:{flexDirection:'row',alignItems:'center',backgroundColor:'#111',borderWidth:1,borderColor:'#E8C98A44',borderRadius:20,paddingHorizontal:12,paddingVertical:6,gap:8},
  st:{fontFamily:'monospace',fontSize:13,color:'#E8C98A',fontWeight:'700'},sk:{fontFamily:'monospace',fontSize:12,color:'#888'},
  hb:{backgroundColor:'#E8C98A',paddingHorizontal:14,paddingVertical:7,borderRadius:6},
  hbt:{fontFamily:'monospace',fontSize:11,fontWeight:'700',color:'#000',letterSpacing:2},
  mc:{padding:16,paddingBottom:40},
  wr:{marginBottom:20},wri:{borderWidth:1,borderColor:'#E8C98A',borderRadius:12,padding:20,alignItems:'center',backgroundColor:'#0A0A0A'},
  wi:{fontSize:28,marginBottom:8,color:'#E8C98A'},wl:{fontFamily:'monospace',fontSize:16,fontWeight:'700',color:'#E8C98A',letterSpacing:4},
  ws:{fontFamily:'monospace',fontSize:9,color:'#555',letterSpacing:2,marginTop:4},
  grid:{flexDirection:'row',flexWrap:'wrap',gap:12,justifyContent:'space-between'},
  bc:{width:(width-48)/2,marginBottom:4},
  bi:{borderWidth:1,borderRadius:12,padding:16,alignItems:'center',backgroundColor:'#080808',minHeight:110,justifyContent:'center',overflow:'hidden'},
  glow:{position:'absolute',top:0,left:0,right:0,bottom:0,borderRadius:12},
  icon:{fontFamily:'monospace',fontSize:22,fontWeight:'700',marginBottom:6},
  bl:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:2,textAlign:'center'},
  bsub:{fontFamily:'monospace',fontSize:8,color:'#444',letterSpacing:1,marginTop:2},
  bp:{fontFamily:'monospace',fontSize:8,color:'#333',marginTop:4,letterSpacing:1},
  set:{marginTop:24,alignItems:'center',paddingVertical:14,borderWidth:1,borderColor:'#222',borderRadius:8},
  setT:{fontFamily:'monospace',fontSize:11,color:'#444',letterSpacing:3},
});
