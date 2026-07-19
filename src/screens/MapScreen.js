import React,{useEffect,useRef,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Animated,Dimensions,StatusBar}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{getHudState,getTasks}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
const{width,height}=Dimensions.get('window');
export default function MapScreen({navigation}){
  const{setHudState,setTasks}=useEmpireStore();
  const fade=useRef(new Animated.Value(0)).current;
  const[score,setScore]=useState(0);const[streak,setStreak]=useState(0);
  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:1000,useNativeDriver:true}).start();
    loadData();
  },[]);
  async function loadData(){
    const hud=await getHudState();const tasks=await getTasks();
    setHudState(hud);setTasks(tasks);
    if(hud){setScore(hud.empire_score||0);setStreak(hud.streak||0);}
  }
  const Building=({label,sublabel,color,style,onPress,size='md'})=>(
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={[s.building,style,{borderColor:color+'66'}]}>
      <View style={[s.buildingRoof,{borderBottomColor:color+'44'}]}/>
      <View style={[s.buildingBody,{backgroundColor:'#0A0800',borderColor:color+'44'}]}>
        <View style={[s.buildingGlow,{backgroundColor:color+'08'}]}/>
        <View style={s.pillars}>
          {[0,1,2,3].map(i=>(<View key={i} style={[s.pillar,{backgroundColor:color+'33'}]}/>))}
        </View>
        <View style={s.buildingInfo}>
          <Text style={[s.buildingLabel,{color}]}>{label}</Text>
          <Text style={s.buildingSublabel}>{sublabel}</Text>
        </View>
      </View>
      <View style={[s.buildingSteps,{borderTopColor:color+'33'}]}/>
    </TouchableOpacity>
  );
  return(
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000"/>
      <View style={s.stars}>
        {[...Array(30)].map((_,i)=>(<View key={i} style={[s.star,{left:(i*137)%width,top:(i*79)%(height*0.6),opacity:0.1+(i%5)*0.08,width:i%3===0?2:1,height:i%3===0?2:1}]}/>))}
      </View>
      <SafeAreaView style={{flex:1}} edges={['top']}>
        <View style={s.header}>
          <View><Text style={s.empireText}>THE EMPIRE</Text><Text style={s.mapText}>KINGDOM MAP</Text></View>
          <TouchableOpacity style={s.scoreChip} onPress={()=>navigation.navigate('HUD')}>
            <Text style={s.scoreNum}>{score}<Text style={s.scorePct}>%</Text></Text>
            <Text style={s.streakText}>{streak}🔥</Text>
          </TouchableOpacity>
        </View>
        <Animated.View style={[s.mapArea,{opacity:fade}]}>
          <View style={s.groundLine}/>
          <View style={s.row1}>
            <Building label="THE COLOSSEUM" sublabel="Command Center" color="#E8C98A" style={s.mainBuilding} onPress={()=>navigation.navigate('Command')}/>
          </View>
          <View style={s.row2}>
            <Building label="THE FORUM" sublabel="Empire HUD" color="#D4A017" style={s.sideBuilding} onPress={()=>navigation.navigate('HUD')}/>
            <View style={s.spacer}/>
            <Building label="THE LIBRARY" sublabel="Memory" color="#C89B3C" style={s.sideBuilding} onPress={()=>navigation.navigate('Memory')}/>
          </View>
          <View style={s.row3}>
            <Building label="THE SENATE" sublabel="Settings" color="#666" style={s.smallBuilding} onPress={()=>navigation.navigate('Settings')}/>
            <View style={s.ground}/>
          </View>
          <View style={s.mapLabel}><View style={s.mapLine}/><Text style={s.mapLabelText}>IMPERIUM</Text><View style={s.mapLine}/></View>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}
const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  stars:{position:'absolute',width:'100%',height:'100%'},
  star:{position:'absolute',backgroundColor:'#E8C98A',borderRadius:1},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:20,paddingVertical:14,borderBottomWidth:1,borderBottomColor:'#111'},
  empireText:{fontFamily:'monospace',fontSize:18,fontWeight:'700',color:'#E8C98A',letterSpacing:5},
  mapText:{fontFamily:'monospace',fontSize:9,color:'#333',letterSpacing:4,marginTop:2},
  scoreChip:{alignItems:'center',backgroundColor:'#0A0A0A',borderWidth:1,borderColor:'#E8C98A33',borderRadius:8,paddingHorizontal:14,paddingVertical:8},
  scoreNum:{fontFamily:'monospace',fontSize:20,fontWeight:'700',color:'#E8C98A',textAlign:'center'},
  scorePct:{fontSize:12},streakText:{fontFamily:'monospace',fontSize:10,color:'#555',marginTop:2},
  mapArea:{flex:1,paddingHorizontal:16,paddingTop:20,paddingBottom:10},
  groundLine:{height:1,backgroundColor:'#E8C98A11',marginBottom:16},
  row1:{alignItems:'center',marginBottom:16},
  row2:{flexDirection:'row',alignItems:'flex-end',marginBottom:12},
  row3:{flexDirection:'row',alignItems:'flex-end',marginBottom:16},
  spacer:{flex:1},
  ground:{flex:1,height:40,borderTopWidth:1,borderTopColor:'#E8C98A11'},
  mainBuilding:{width:width*0.55,height:180},
  sideBuilding:{width:width*0.38,height:130},
  smallBuilding:{width:width*0.28,height:90},
  building:{overflow:'hidden'},
  buildingRoof:{height:30,borderLeftWidth:40,borderRightWidth:40,borderBottomWidth:30,borderLeftColor:'transparent',borderRightColor:'transparent',alignSelf:'center',width:'60%'},
  buildingBody:{flex:1,borderWidth:1,borderTopWidth:0,overflow:'hidden'},
  buildingGlow:{position:'absolute',top:0,left:0,right:0,bottom:0},
  pillars:{flexDirection:'row',justifyContent:'space-around',paddingHorizontal:4,paddingTop:4},
  pillar:{width:4,height:40,borderRadius:1},
  buildingInfo:{position:'absolute',bottom:8,left:0,right:0,alignItems:'center'},
  buildingLabel:{fontFamily:'monospace',fontSize:9,fontWeight:'700',letterSpacing:2,textAlign:'center'},
  buildingSublabel:{fontFamily:'monospace',fontSize:7,color:'#333',letterSpacing:1,marginTop:2},
  buildingSteps:{height:8,borderTopWidth:6,borderTopColor:'transparent',marginHorizontal:8},
  mapLabel:{flexDirection:'row',alignItems:'center',gap:10,marginTop:8},
  mapLine:{flex:1,height:1,backgroundColor:'#E8C98A11'},
  mapLabelText:{fontFamily:'monospace',fontSize:9,color:'#E8C98A22',letterSpacing:6},
});
