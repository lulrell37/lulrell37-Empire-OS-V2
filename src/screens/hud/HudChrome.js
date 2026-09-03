// Tony-Stark-style HUD chrome for the (redesigned) HUD screen: an animated
// frame overlay, a compact animated Empire Score bar, a ticking telemetry line,
// and the module wrapper each section sits in.
//
// Kept cheap: a shared `pulse` (opacity heartbeat) and one scan-line sweep drive
// the whole screen's chrome. JS-driven (not native) so a value can feed both an
// opacity and a layout prop without RN's mixed-driver warning.
import React,{useEffect,useRef,useState}from 'react';
import{View,Text,StyleSheet,Animated,Easing,Dimensions}from 'react-native';
import{colors,space,radius,FONTS}from '../../theme';

const{width:SCREEN_W,height:SCREEN_H}=Dimensions.get('window');

// A 0→1→0 heartbeat other bits of chrome subscribe to for their glow.
export function useHudPulse(){
  const pulse=useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    const loop=Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:1,duration:1400,easing:Easing.inOut(Easing.quad),useNativeDriver:false}),
      Animated.timing(pulse,{toValue:0,duration:1400,easing:Easing.inOut(Easing.quad),useNativeDriver:false}),
    ]));
    loop.start();
    return()=>loop.stop();
  },[pulse]);
  return pulse;
}

// --- Full-screen frame: corner brackets + a slow vertical scan sweep ---------
export function HudFrame({pulse}){
  const scan=useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    const loop=Animated.loop(Animated.timing(scan,{toValue:1,duration:7200,easing:Easing.linear,useNativeDriver:false}));
    loop.start();
    return()=>loop.stop();
  },[scan]);
  const glow=pulse.interpolate({inputRange:[0,1],outputRange:[0.28,0.7]});
  const y=scan.interpolate({inputRange:[0,1],outputRange:[-40,SCREEN_H+40]});
  const B=22;
  return(
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Animated.View style={[c.br,c.tl,{width:B,height:B,opacity:glow}]}/>
      <Animated.View style={[c.br,c.tr,{width:B,height:B,opacity:glow}]}/>
      <Animated.View style={[c.br,c.bl,{width:B,height:B,opacity:glow}]}/>
      <Animated.View style={[c.br,c.brr,{width:B,height:B,opacity:glow}]}/>
      {/* edge tick ladder */}
      <View style={c.ladder} pointerEvents="none">
        {Array.from({length:11}).map((_,i)=>(
          <View key={i} style={[c.tick,i%5===0&&c.tickLong]}/>
        ))}
      </View>
      <Animated.View style={[c.scan,{transform:[{translateY:y}]}]}>
        <View style={c.scanCore}/>
        <View style={c.scanFade}/>
      </Animated.View>
    </View>
  );
}

// --- Compact Empire Score bar ----------------------------------------------
export function ScoreBar({score=0,streak=0,routineDone=0,routineTotal=0,tasksDone=0,tasksTotal=0,statusText='',pulse}){
  const fill=useRef(new Animated.Value(0)).current;
  useEffect(()=>{
    Animated.timing(fill,{toValue:Math.max(0,Math.min(100,score))/100,duration:900,easing:Easing.out(Easing.cubic),useNativeDriver:false}).start();
  },[score,fill]);
  const dotGlow=pulse.interpolate({inputRange:[0,1],outputRange:[0.35,1]});
  const w=fill.interpolate({inputRange:[0,1],outputRange:['0%','100%']});
  return(
    <View style={c.scoreWrap}>
      <View style={c.scoreTopRow}>
        <View style={c.scoreLabelCol}>
          <Text style={c.scoreLabel}>EMPIRE SCORE</Text>
          <Text style={c.scoreStatus}>{statusText||'—'}</Text>
        </View>
        <View style={c.scoreNumRow}>
          <Text style={c.scoreNum}>{score}</Text>
          <Text style={c.scorePct}>%</Text>
        </View>
      </View>
      <View style={c.track}>
        <Animated.View style={[c.trackFill,{width:w}]}/>
        {/* 10% segment ticks */}
        <View style={c.trackTicks} pointerEvents="none">
          {Array.from({length:9}).map((_,i)=>(<View key={i} style={c.trackTick}/>))}
        </View>
        <Animated.View style={[c.trackHead,{left:w,opacity:dotGlow}]}/>
      </View>
      <View style={c.scoreMetaRow}>
        <Metric label="STREAK" value={`${streak}D`}/>
        <Metric label="ROUTINE" value={`${routineDone}/${routineTotal}`}/>
        <Metric label="TASKS" value={`${tasksDone}/${tasksTotal}`}/>
        <Animated.View style={[c.liveDot,{opacity:dotGlow}]}/>
      </View>
    </View>
  );
}
function Metric({label,value}){
  return(
    <View style={c.metric}>
      <Text style={c.metricValue}>{value}</Text>
      <Text style={c.metricLabel}>{label}</Text>
    </View>
  );
}

// --- Telemetry strip -------------------------------------------------------
export function TelemetryLine(){
  const[now,setNow]=useState(()=>fmt());
  useEffect(()=>{const iv=setInterval(()=>setNow(fmt()),1000);return()=>clearInterval(iv);},[]);
  return(
    <View style={c.telemetry}>
      <Text style={c.telemetryText} numberOfLines={1}>WALDORF·MD  {now}  ·  SYS ONLINE  ·  EMPIRE OS v2</Text>
      <Blink/>
    </View>
  );
}
function fmt(){
  try{
    return new Date().toLocaleTimeString('en-US',{hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});
  }catch{return '';}
}
function Blink(){
  const o=useRef(new Animated.Value(1)).current;
  useEffect(()=>{
    const loop=Animated.loop(Animated.sequence([
      Animated.timing(o,{toValue:0,duration:60,delay:900,useNativeDriver:false}),
      Animated.timing(o,{toValue:1,duration:60,useNativeDriver:false}),
    ]));
    loop.start();return()=>loop.stop();
  },[o]);
  return <Animated.View style={[c.cursor,{opacity:o}]}/>;
}

// --- Module wrapper each section sits in ----------------------------------
export function HudModule({index,label,pulse,children,live=true}){
  const dotGlow=pulse.interpolate({inputRange:[0,1],outputRange:[0.3,1]});
  return(
    <View style={c.module}>
      <View style={c.modBracketTL}/>
      <View style={c.modBracketBR}/>
      <View style={c.modHeader}>
        <Text style={c.modIndex}>{index}</Text>
        <View style={c.modAccent}/>
        <Text style={c.modLabel}>{label}</Text>
        <View style={{flex:1}}/>
        {live&&<Animated.View style={[c.modDot,{opacity:dotGlow}]}/>}
        <Text style={c.modBars}>▚▚</Text>
      </View>
      <View style={c.modBody}>{children}</View>
    </View>
  );
}

// --- Divider between modules --------------------------------------------
export function HudDivider(){
  return(
    <View style={c.divider}>
      <View style={c.divLine}/>
      <View style={c.divDiamond}/>
      <View style={c.divLine}/>
    </View>
  );
}

const c=StyleSheet.create({
  // frame
  br:{position:'absolute',borderColor:colors.gold},
  tl:{top:6,left:6,borderTopWidth:1.5,borderLeftWidth:1.5},
  tr:{top:6,right:6,borderTopWidth:1.5,borderRightWidth:1.5},
  bl:{bottom:6,left:6,borderBottomWidth:1.5,borderLeftWidth:1.5},
  brr:{bottom:6,right:6,borderBottomWidth:1.5,borderRightWidth:1.5},
  ladder:{position:'absolute',left:2,top:'32%',gap:7},
  tick:{width:4,height:1,backgroundColor:colors.goldFaint},
  tickLong:{width:9,backgroundColor:colors.goldDim},
  scan:{position:'absolute',left:0,right:0,height:60},
  scanCore:{height:1,backgroundColor:'rgba(232,201,138,0.5)'},
  scanFade:{flex:1,backgroundColor:'rgba(232,201,138,0.035)'},

  // score bar
  scoreWrap:{paddingHorizontal:space.xl,paddingTop:space.md,paddingBottom:space.lg},
  scoreTopRow:{flexDirection:'row',alignItems:'flex-end',justifyContent:'space-between'},
  scoreLabelCol:{gap:3},
  scoreLabel:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:3},
  scoreStatus:{fontFamily:FONTS.mono,fontSize:8,color:colors.online,letterSpacing:1.5},
  scoreNumRow:{flexDirection:'row',alignItems:'flex-start'},
  scoreNum:{fontFamily:FONTS.displaySemi,fontSize:44,lineHeight:46,color:colors.goldBright,letterSpacing:1},
  scorePct:{fontFamily:FONTS.display,fontSize:18,color:colors.goldDim,marginTop:4},
  track:{height:5,backgroundColor:colors.ringTrack,borderRadius:2.5,marginTop:8,overflow:'visible',justifyContent:'center'},
  trackFill:{position:'absolute',left:0,top:0,bottom:0,backgroundColor:colors.gold,borderRadius:2.5},
  trackTicks:{position:'absolute',left:0,right:0,top:0,bottom:0,flexDirection:'row',justifyContent:'space-evenly',alignItems:'center'},
  trackTick:{width:1,height:5,backgroundColor:colors.bg,opacity:0.6},
  trackHead:{position:'absolute',width:3,height:11,marginLeft:-1.5,backgroundColor:colors.goldBright,borderRadius:1},
  scoreMetaRow:{flexDirection:'row',alignItems:'center',gap:space.lg,marginTop:10},
  metric:{},
  metricValue:{fontFamily:FONTS.monoMed,fontSize:11,color:colors.text,letterSpacing:0.5},
  metricLabel:{fontFamily:FONTS.mono,fontSize:7,color:colors.textDim,letterSpacing:1.5,marginTop:1},
  liveDot:{width:5,height:5,borderRadius:2.5,backgroundColor:colors.online,marginLeft:'auto'},

  // telemetry
  telemetry:{flexDirection:'row',alignItems:'center',paddingHorizontal:space.xl,paddingVertical:4,borderBottomWidth:1,borderBottomColor:colors.hairline,gap:6},
  telemetryText:{flex:1,fontFamily:FONTS.mono,fontSize:7.5,color:colors.textDim,letterSpacing:1.5},
  cursor:{width:5,height:9,backgroundColor:colors.gold},

  // module
  module:{marginHorizontal:space.lg,backgroundColor:colors.card,borderWidth:1,borderColor:colors.hairlineGold,borderRadius:radius.md,overflow:'hidden'},
  modBracketTL:{position:'absolute',top:0,left:0,width:10,height:10,borderTopWidth:1.5,borderLeftWidth:1.5,borderColor:colors.goldDim},
  modBracketBR:{position:'absolute',bottom:0,right:0,width:10,height:10,borderBottomWidth:1.5,borderRightWidth:1.5,borderColor:colors.goldDim},
  modHeader:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:space.md,paddingTop:space.md,paddingBottom:space.sm},
  modIndex:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.goldDim,letterSpacing:1},
  modAccent:{width:14,height:2,backgroundColor:colors.gold},
  modLabel:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:3},
  modDot:{width:4,height:4,borderRadius:2,backgroundColor:colors.online},
  modBars:{fontFamily:FONTS.mono,fontSize:8,color:colors.goldFaint,letterSpacing:1},
  modBody:{paddingHorizontal:space.md,paddingBottom:space.md,paddingTop:2},

  // divider
  divider:{flexDirection:'row',alignItems:'center',justifyContent:'center',gap:8,paddingVertical:space.sm},
  divLine:{width:36,height:1,backgroundColor:colors.hairline},
  divDiamond:{width:4,height:4,backgroundColor:colors.goldFaint,transform:[{rotate:'45deg'}]},
});
