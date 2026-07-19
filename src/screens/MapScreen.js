import React,{useEffect,useRef,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Animated,Dimensions,StatusBar,Image}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{getHudState,getTasks}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
const{width,height}=Dimensions.get('window');
export default function MapScreen({navigation}){
  const{setHudState,setTasks}=useEmpireStore();
  const fade=useRef(new Animated.Value(0)).current;
  const[score,setScore]=useState(0);const[streak,setStreak]=useState(0);
  useEffect(()=>{Animated.timing(fade,{toValue:1,duration:1000,useNativeDriver:true}).start();loadData();},[]);
  async function loadData(){const hud=await getHudState();const tasks=await getTasks();setHudState(hud);setTasks(tasks);if(hud){setScore(hud.empire_score||0);setStreak(hud.streak||0);}}
  const mapH=height*0.78;
  return(
    <View style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000"/>
      <SafeAreaView style={{flex:1}} edges={['top']}>
        <View style={s.header}>
          <View><Text style={s.empireText}>THE EMPIRE</Text><Text style={s.mapText}>KINGDOM MAP</Text></View>
          <TouchableOpacity style={s.scoreChip} onPress={()=>navigation.navigate('HUD')}>
            <Text style={s.scoreNum}>{score}<Text style={s.scorePct}>%</Text></Text>
            <Text style={s.streakText}>{streak}🔥</Text>
          </TouchableOpacity>
        </View>
        <Animated.View style={{flex:1,opacity:fade}}>
          <View style={[s.mapContainer,{height:mapH}]}>
            <Image
              source={require('../../assets/file_000000001b5481f58fb0a3ce739e8390.png')}
              style={s.mapImage}
              resizeMode="cover"
            />
            <TouchableOpacity style={[s.zone,{left:width*0.33,top:mapH*0.28,width:width*0.34,height:mapH*0.28}]} onPress={()=>navigation.navigate('Command')} activeOpacity={0.7}>
              <View style={s.zoneLabel}><Text style={s.zoneLabelText}>COUNCIL</Text></View>
            </TouchableOpacity>
            <TouchableOpacity style={[s.zone,{left:width*0.66,top:mapH*0.4,width:width*0.3,height:mapH*0.22}]} onPress={()=>navigation.navigate('HUD')} activeOpacity={0.7}>
              <View style={s.zoneLabel}><Text style={[s.zoneLabelText,{color:'#D4A017'}]}>HUD</Text></View>
            </TouchableOpacity>
            <TouchableOpacity style={[s.zone,{left:width*0.04,top:mapH*0.38,width:width*0.26,height:mapH*0.2}]} onPress={()=>navigation.navigate('Memory')} activeOpacity={0.7}>
              <View style={s.zoneLabel}><Text style={[s.zoneLabelText,{color:'#C89B3C'}]}>MEMORY</Text></View>
            </TouchableOpacity>
            <TouchableOpacity style={[s.zone,{left:width*0.04,top:mapH*0.62,width:width*0.22,height:mapH*0.16}]} onPress={()=>navigation.navigate('Settings')} activeOpacity={0.7}>
              <View style={s.zoneLabel}><Text style={[s.zoneLabelText,{color:'#666'}]}>SETTINGS</Text></View>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}
const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  header:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:20,paddingVertical:14,borderBottomWidth:1,borderBottomColor:'#111'},
  empireText:{fontFamily:'monospace',fontSize:18,fontWeight:'700',color:'#E8C98A',letterSpacing:5},
  mapText:{fontFamily:'monospace',fontSize:9,color:'#333',letterSpacing:4,marginTop:2},
  scoreChip:{alignItems:'center',backgroundColor:'#0A0A0A',borderWidth:1,borderColor:'#E8C98A33',borderRadius:8,paddingHorizontal:14,paddingVertical:8},
  scoreNum:{fontFamily:'monospace',fontSize:20,fontWeight:'700',color:'#E8C98A',textAlign:'center'},
  scorePct:{fontSize:12},streakText:{fontFamily:'monospace',fontSize:10,color:'#555',marginTop:2},
  mapContainer:{width:'100%',position:'relative'},
  mapImage:{width:'100%',height:'100%'},
  zone:{position:'absolute',alignItems:'center',justifyContent:'flex-end',paddingBottom:6},
  zoneLabel:{backgroundColor:'rgba(0,0,0,0.75)',paddingHorizontal:10,paddingVertical:4,borderRadius:4,borderWidth:1,borderColor:'#E8C98A55'},
  zoneLabelText:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',letterSpacing:3,fontWeight:'700'},
});
