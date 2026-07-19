import React,{useEffect,useRef,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView,Animated,Dimensions,StatusBar}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{getHudState,getTasks}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
const{width}=Dimensions.get('window');
export default function MapScreen({navigation}){
  const{setHudState,setTasks}=useEmpireStore();
  const fade=useRef(new Animated.Value(0)).current;
  const pulse=useRef(new Animated.Value(1)).current;
  const[score,setScore]=useState(0);
  const[streak,setStreak]=useState(0);
  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:1000,useNativeDriver:true}).start();
    Animated.loop(Animated.sequence([Animated.timing(pulse,{toValue:1.015,duration:3000,useNativeDriver:true}),Animated.timing(pulse,{toValue:1,duration:3000,useNativeDriver:true})])).start();
    loadData();
  },[]);
  async function loadData(){
    const hud=await getHudState();const tasks=await getTasks();
    setHudState(hud);setTasks(tasks);
    if(hud){setScore(hud.empire_score||0);setStreak(hud.streak||0);}
  }
  return(
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000"/>
      <View style={s.atmosphere}>
        <View style={[s.glow,{top:-100,left:-100,backgroundColor:'#E8C98A08'}]}/>
        <View style={[s.glow,{bottom:-100,right:-100,backgroundColor:'#E8C98A05'}]}/>
      </View>
      <SafeAreaView style={{flex:1}} edges={['top']}>
        <View style={s.header}>
          <View><Text style={s.empireText}>THE EMPIRE</Text><Text style={s.mapText}>KINGDOM MAP</Text></View>
          <TouchableOpacity style={s.scoreChip} onPress={()=>navigation.navigate('HUD')}>
            <Text style={s.scoreNum}>{score}<Text style={s.scorePct}>%</Text></Text>
            <Text style={s.streakText}>{streak}🔥</Text>
          </TouchableOpacity>
        </View>
        <Animated.View style={{flex:1,opacity:fade}}>
          <ScrollView contentContainerStyle={s.mapContent} showsVerticalScrollIndicator={false}>
            <View style={s.mapTitleRow}><View style={s.mapLine}/><Text style={s.mapTitle}>IMPERIUM</Text><View style={s.mapLine}/></View>
            <Animated.View style={{transform:[{scale:pulse}]}}>
              <TouchableOpacity style={s.mainBuilding} onPress={()=>navigation.navigate('Command')} activeOpacity={0.85}>
                <View style={s.mainBuildingInner}>
                  <View style={s.mainBuildingGlow}/>
                  <Text style={s.mainIcon}>⚔</Text>
                  <Text style={s.mainLabel}>THE COLOSSEUM</Text>
                  <Text style={s.mainSublabel}>COMMAND CENTER</Text>
                  <Text style={s.mainDesc}>All 11 Personas · Council · Empire · Custom</Text>
                  <View style={s.mainDivider}/>
                  <Text style={s.mainCta}>ENTER →</Text>
                </View>
              </TouchableOpacity>
            </Animated.View>
            <View style={s.buildingsGrid}>
              {[{label:'THE FORUM',sublabel:'Empire HUD',icon:'◉',color:'#D4A017',screen:'HUD'},{label:'THE LIBRARY',sublabel:'Memory & Notes',icon:'📜',color:'#C89B3C',screen:'Memory'},{label:'THE SENATE',sublabel:'Settings',icon:'⚙',color:'#888',screen:'Settings'}].map(b=>(
                <TouchableOpacity key={b.label} style={[s.building,{borderColor:b.color+'44'}]} onPress={()=>navigation.navigate(b.screen)} activeOpacity={0.85}>
                  <View style={[s.buildingGlow,{backgroundColor:b.color+'08'}]}/>
                  <Text style={[s.buildingIcon,{color:b.color}]}>{b.icon}</Text>
                  <Text style={[s.buildingLabel,{color:b.color}]}>{b.label}</Text>
                  <Text style={s.buildingSublabel}>{b.sublabel}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.bottomRow}><View style={s.mapLine}/><Text style={s.bottomText}>EMPIRE OS V2</Text><View style={s.mapLine}/></View>
          </ScrollView>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}
const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  atmosphere:{position:'absolute',width:'100%',height:'100%'},
  glow:{position:'absolute',width:400,height:400,borderRadius:200},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:20,paddingVertical:14,borderBottomWidth:1,borderBottomColor:'#111'},
  empireText:{fontFamily:'monospace',fontSize:18,fontWeight:'700',color:'#E8C98A',letterSpacing:5},
  mapText:{fontFamily:'monospace',fontSize:9,color:'#333',letterSpacing:4,marginTop:2},
  scoreChip:{alignItems:'center',backgroundColor:'#0A0A0A',borderWidth:1,borderColor:'#E8C98A33',borderRadius:8,paddingHorizontal:14,paddingVertical:8},
  scoreNum:{fontFamily:'monospace',fontSize:20,fontWeight:'700',color:'#E8C98A',textAlign:'center'},
  scorePct:{fontSize:12},streakText:{fontFamily:'monospace',fontSize:10,color:'#555',marginTop:2},
  mapContent:{padding:16,paddingBottom:40},
  mapTitleRow:{flexDirection:'row',alignItems:'center',gap:12,marginBottom:20},
  mapLine:{flex:1,height:1,backgroundColor:'#E8C98A22'},
  mapTitle:{fontFamily:'monospace',fontSize:10,color:'#E8C98A44',letterSpacing:6},
  mainBuilding:{marginBottom:20},
  mainBuildingInner:{borderWidth:1,borderColor:'#E8C98A55',borderRadius:4,padding:28,alignItems:'center',backgroundColor:'#060606',overflow:'hidden'},
  mainBuildingGlow:{position:'absolute',top:0,left:0,right:0,bottom:0,backgroundColor:'#E8C98A04'},
  mainIcon:{fontSize:40,marginBottom:12,color:'#E8C98A'},
  mainLabel:{fontFamily:'monospace',fontSize:18,fontWeight:'700',color:'#E8C98A',letterSpacing:4},
  mainSublabel:{fontFamily:'monospace',fontSize:9,color:'#666',letterSpacing:4,marginTop:4},
  mainDesc:{fontFamily:'monospace',fontSize:10,color:'#333',letterSpacing:1,marginTop:12,textAlign:'center'},
  mainDivider:{width:40,height:1,backgroundColor:'#E8C98A33',marginVertical:16},
  mainCta:{fontFamily:'monospace',fontSize:11,color:'#E8C98A',letterSpacing:4},
  buildingsGrid:{flexDirection:'row',flexWrap:'wrap',gap:12,marginBottom:24},
  building:{width:(width-44)/2,backgroundColor:'#060606',borderWidth:1,borderRadius:4,padding:18,alignItems:'center',overflow:'hidden'},
  buildingGlow:{position:'absolute',top:0,left:0,right:0,bottom:0},
  buildingIcon:{fontSize:24,marginBottom:10},
  buildingLabel:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:2,textAlign:'center',marginBottom:4},
  buildingSublabel:{fontFamily:'monospace',fontSize:8,color:'#444',letterSpacing:2},
  bottomRow:{flexDirection:'row',alignItems:'center',gap:12,marginTop:8},
  bottomText:{fontFamily:'monospace',fontSize:8,color:'#222',letterSpacing:4},
});
