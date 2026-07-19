cat > src/screens/MapScreen.js << 'MAPEOF'
import React,{useEffect,useRef,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Animated,Dimensions,StatusBar,ImageBackground,ScrollView}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import Svg,{Rect,Circle,Polygon,Path,G,Text as SvgText,Defs,RadialGradient,Stop}from 'react-native-svg';
import{getHudState,getTasks}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
const{width,height}=Dimensions.get('window');
const W=width;const H=height*0.7;
export default function MapScreen({navigation}){
  const{setHudState,setTasks}=useEmpireStore();
  const fade=useRef(new Animated.Value(0)).current;
  const glow1=useRef(new Animated.Value(0.3)).current;
  const glow2=useRef(new Animated.Value(0.5)).current;
  const[score,setScore]=useState(0);const[streak,setStreak]=useState(0);
  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:1200,useNativeDriver:true}).start();
    Animated.loop(Animated.sequence([Animated.timing(glow1,{toValue:0.8,duration:2000,useNativeDriver:true}),Animated.timing(glow1,{toValue:0.3,duration:2000,useNativeDriver:true})])).start();
    Animated.loop(Animated.sequence([Animated.timing(glow2,{toValue:1,duration:3000,useNativeDriver:true}),Animated.timing(glow2,{toValue:0.4,duration:3000,useNativeDriver:true})])).start();
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
      <SafeAreaView style={{flex:1}} edges={['top']}>
        <View style={s.header}>
          <View><Text style={s.empireText}>THE EMPIRE</Text><Text style={s.mapText}>KINGDOM MAP</Text></View>
          <TouchableOpacity style={s.scoreChip} onPress={()=>navigation.navigate('HUD')}>
            <Text style={s.scoreNum}>{score}<Text style={s.scorePct}>%</Text></Text>
            <Text style={s.streakText}>{streak}🔥</Text>
          </TouchableOpacity>
        </View>
        <Animated.View style={{flex:1,opacity:fade}}>
          <ScrollView contentContainerStyle={{paddingBottom:20}}>
            <View style={s.mapContainer}>
              <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
                <Defs>
                  <RadialGradient id="bg" cx="50%" cy="50%" r="50%">
                    <Stop offset="0%" stopColor="#0a0800" stopOpacity="1"/>
                    <Stop offset="100%" stopColor="#000000" stopOpacity="1"/>
                  </RadialGradient>
                  <RadialGradient id="glow_gold" cx="50%" cy="50%" r="50%">
                    <Stop offset="0%" stopColor="#E8C98A" stopOpacity="0.15"/>
                    <Stop offset="100%" stopColor="#E8C98A" stopOpacity="0"/>
                  </RadialGradient>
                </Defs>
                {/* Sky/ground background */}
                <Rect x="0" y="0" width={W} height={H} fill="url(#bg)"/>
                {/* Ground plane */}
                <Rect x="0" y={H*0.55} width={W} height={H*0.45} fill="#080600" opacity="0.8"/>
                {/* Grid lines on ground */}
                {[...Array(8)].map((_,i)=>(
                  <Path key={`gl${i}`} d={`M ${W*0.1+(i*(W*0.8/7))} ${H*0.55} L ${W*0.5} ${H*0.9}`} stroke="#E8C98A" strokeWidth="0.3" opacity="0.15"/>
                ))}
                {[...Array(5)].map((_,i)=>(
                  <Path key={`gh${i}`} d={`M ${W*0.05} ${H*0.58+(i*0.07*H)} L ${W*0.95} ${H*0.58+(i*0.07*H)}`} stroke="#E8C98A" strokeWidth="0.3" opacity="0.1"/>
                ))}
                {/* Stars */}
                {[...Array(40)].map((_,i)=>(
                  <Circle key={`s${i}`} cx={(i*97)%W} cy={(i*53)%(H*0.5)} r="0.8" fill="#E8C98A" opacity={0.2+((i%5)*0.1)}/>
                ))}
                {/* Atmospheric glow behind main tower */}
                <Circle cx={W*0.5} cy={H*0.3} r={80} fill="#E8C98A" opacity="0.04"/>
                <Circle cx={W*0.5} cy={H*0.3} r={120} fill="#E8C98A" opacity="0.02"/>
                {/* ── THE COLOSSEUM (center, largest) ── */}
                <G>
                  {/* Base shadow */}
                  <Rect x={W*0.32} y={H*0.52} width={W*0.36} height={H*0.08} rx="4" fill="#E8C98A" opacity="0.05"/>
                  {/* Main structure */}
                  <Rect x={W*0.35} y={H*0.22} width={W*0.3} height={H*0.3} rx="2" fill="#1A1200" stroke="#E8C98A" strokeWidth="1" opacity="0.9"/>
                  {/* Pillars */}
                  {[0,1,2,3,4].map(i=>(<Rect key={`p${i}`} x={W*0.36+(i*(W*0.28/4))} y={H*0.23} width={W*0.015} height={H*0.28} fill="#E8C98A" opacity="0.3"/>))}
                  {/* Roof */}
                  <Polygon points={`${W*0.35},${H*0.22} ${W*0.65},${H*0.22} ${W*0.5},${H*0.08}`} fill="#1A1200" stroke="#E8C98A" strokeWidth="1.5" opacity="0.9"/>
                  {/* Roof glow */}
                  <Polygon points={`${W*0.35},${H*0.22} ${W*0.65},${H*0.22} ${W*0.5},${H*0.08}`} fill="#E8C98A" opacity="0.05"/>
                  {/* Windows */}
                  <Rect x={W*0.44} y={H*0.32} width={W*0.05} height={H*0.06} rx="1" fill="#E8C98A" opacity="0.2"/>
                  <Rect x={W*0.51} y={H*0.32} width={W*0.05} height={H*0.06} rx="1" fill="#E8C98A" opacity="0.2"/>
                  {/* Crown ornament */}
                  <Circle cx={W*0.5} cy={H*0.08} r="4" fill="#E8C98A" opacity="0.8"/>
                  {/* Steps */}
                  <Rect x={W*0.38} y={H*0.52} width={W*0.24} height={H*0.015} rx="1" fill="#E8C98A" opacity="0.2"/>
                  <Rect x={W*0.4} y={H*0.535} width={W*0.2} height={H*0.015} rx="1" fill="#E8C98A" opacity="0.15"/>
                  {/* Label */}
                  <SvgText x={W*0.5} y={H*0.62} textAnchor="middle" fill="#E8C98A" fontSize="11" fontWeight="bold" letterSpacing="3" opacity="0.9">THE COLOSSEUM</SvgText>
                  <SvgText x={W*0.5} y={H*0.635} textAnchor="middle" fill="#E8C98A" fontSize="7" letterSpacing="2" opacity="0.5">COMMAND CENTER</SvgText>
                </G>
                {/* ── THE FORUM (left) ── */}
                <G>
                  <Rect x={W*0.05} y={H*0.42} width={W*0.2} height={H*0.13} rx="2" fill="#120D00" stroke="#D4A017" strokeWidth="0.8" opacity="0.85"/>
                  {[0,1,2].map(i=>(<Rect key={`fp${i}`} x={W*0.06+(i*(W*0.18/2))} y={H*0.43} width={W*0.012} height={H*0.11} fill="#D4A017" opacity="0.25"/>))}
                  <Polygon points={`${W*0.05},${H*0.42} ${W*0.25},${H*0.42} ${W*0.15},${H*0.33}`} fill="#120D00" stroke="#D4A017" strokeWidth="0.8" opacity="0.85"/>
                  <Circle cx={W*0.15} cy={H*0.33} r="2.5" fill="#D4A017" opacity="0.7"/>
                  <SvgText x={W*0.15} y={H*0.58} textAnchor="middle" fill="#D4A017" fontSize="8" fontWeight="bold" letterSpacing="2" opacity="0.8">THE FORUM</SvgText>
                  <SvgText x={W*0.15} y={H*0.592} textAnchor="middle" fill="#D4A017" fontSize="6" letterSpacing="1" opacity="0.4">EMPIRE HUD</SvgText>
                </G>
                {/* ── THE LIBRARY (right) ── */}
                <G>
                  <Rect x={W*0.75} y={H*0.42} width={W*0.2} height={H*0.13} rx="2" fill="#0D0A00" stroke="#C89B3C" strokeWidth="0.8" opacity="0.85"/>
                  {[0,1,2].map(i=>(<Rect key={`lp${i}`} x={W*0.76+(i*(W*0.18/2))} y={H*0.43} width={W*0.012} height={H*0.11} fill="#C89B3C" opacity="0.25"/>))}
                  <Polygon points={`${W*0.75},${H*0.42} ${W*0.95},${H*0.42} ${W*0.85},${H*0.33}`} fill="#0D0A00" stroke="#C89B3C" strokeWidth="0.8" opacity="0.85"/>
                  <Circle cx={W*0.85} cy={H*0.33} r="2.5" fill="#C89B3C" opacity="0.7"/>
                  <SvgText x={W*0.85} y={H*0.58} textAnchor="middle" fill="#C89B3C" fontSize="8" fontWeight="bold" letterSpacing="2" opacity="0.8">THE LIBRARY</SvgText>
                  <SvgText x={W*0.85} y={H*0.592} textAnchor="middle" fill="#C89B3C" fontSize="6" letterSpacing="1" opacity="0.4">MEMORY</SvgText>
                </G>
                {/* ── THE SENATE (far left, smaller) ── */}
                <G>
                  <Rect x={W*0.02} y={H*0.58} width={W*0.14} height={H*0.08} rx="1" fill="#0A0A0A" stroke="#666" strokeWidth="0.6" opacity="0.8"/>
                  {[0,1].map(i=>(<Rect key={`sp${i}`} x={W*0.03+(i*(W*0.12/1))} y={H*0.585} width={W*0.01} height={H*0.07} fill="#666" opacity="0.2"/>))}
                  <Polygon points={`${W*0.02},${H*0.58} ${W*0.16},${H*0.58} ${W*0.09},${H*0.52}`} fill="#0A0A0A" stroke="#666" strokeWidth="0.6" opacity="0.8"/>
                  <SvgText x={W*0.09} y={H*0.68} textAnchor="middle" fill="#666" fontSize="7" fontWeight="bold" letterSpacing="2" opacity="0.7">THE SENATE</SvgText>
                </G>
                {/* Roads connecting buildings */}
                <Path d={`M ${W*0.25} ${H*0.55} L ${W*0.35} ${H*0.55}`} stroke="#E8C98A" strokeWidth="1" opacity="0.1" strokeDasharray="4,4"/>
                <Path d={`M ${W*0.65} ${H*0.55} L ${W*0.75} ${H*0.55}`} stroke="#E8C98A" strokeWidth="1" opacity="0.1" strokeDasharray="4,4"/>
                <Path d={`M ${W*0.16} ${H*0.66} L ${W*0.09} ${H*0.66}`} stroke="#666" strokeWidth="0.8" opacity="0.1" strokeDasharray="3,3"/>
              </Svg>
              {/* Invisible tap zones over SVG buildings */}
              <TouchableOpacity style={[s.tapZone,{left:W*0.32,top:H*0.08,width:W*0.36,height:H*0.5}]} onPress={()=>navigation.navigate('Command')} activeOpacity={0.7}/>
              <TouchableOpacity style={[s.tapZone,{left:W*0.04,top:H*0.32,width:W*0.22,height:H*0.3}]} onPress={()=>navigation.navigate('HUD')} activeOpacity={0.7}/>
              <TouchableOpacity style={[s.tapZone,{left:W*0.74,top:H*0.32,width:W*0.22,height:H*0.3}]} onPress={()=>navigation.navigate('Memory')} activeOpacity={0.7}/>
              <TouchableOpacity style={[s.tapZone,{left:W*0.01,top:H*0.5,width:W*0.16,height:H*0.22}]} onPress={()=>navigation.navigate('Settings')} activeOpacity={0.7}/>
            </View>
            {/* Legend */}
            <View style={s.legend}>
              {[{label:'THE COLOSSEUM',sub:'Command',color:'#E8C98A',screen:'Command'},{label:'THE FORUM',sub:'HUD',color:'#D4A017',screen:'HUD'},{label:'THE LIBRARY',sub:'Memory',color:'#C89B3C',screen:'Memory'},{label:'THE SENATE',sub:'Settings',color:'#666',screen:'Settings'}].map(b=>(
                <TouchableOpacity key={b.label} style={s.legendItem} onPress={()=>navigation.navigate(b.screen)}>
                  <View style={[s.legendDot,{backgroundColor:b.color}]}/>
                  <View><Text style={[s.legendLabel,{color:b.color}]}>{b.label}</Text><Text style={s.legendSub}>{b.sub}</Text></View>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
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
  mapContainer:{width:W,height:H,position:'relative'},
  tapZone:{position:'absolute',backgroundColor:'transparent'},
  legend:{flexDirection:'row',flexWrap:'wrap',gap:12,padding:16,borderTopWidth:1,borderTopColor:'#0D0D0D'},
  legendItem:{flexDirection:'row',alignItems:'center',gap:8,width:'45%'},
  legendDot:{width:6,height:6,borderRadius:3},
  legendLabel:{fontFamily:'monospace',fontSize:8,fontWeight:'700',letterSpacing:1},
  legendSub:{fontFamily:'monospace',fontSize:7,color:'#333',letterSpacing:1},
});
