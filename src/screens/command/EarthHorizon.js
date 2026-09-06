// EarthHorizon — the top curve of Earth rising along the bottom edge of the
// persona galaxy (OrbZoom's "group" level). Only the top ~quarter of the planet
// sits on screen; the rest is below the frame.
//
// Pure art: the whole component is pointerEvents:"none" so it never touches the
// orb-cloud drag gestures. The tap target (descend to the city) is a separate
// button rendered by OrbZoom on top.
import React,{useEffect,useMemo,useRef}from 'react';
import{Animated,Dimensions,Easing,StyleSheet,Text,View}from 'react-native';
import Svg,{Defs,ClipPath,RadialGradient,Stop,Circle,Ellipse,G,Rect}from 'react-native-svg';

const AView=Animated.createAnimatedComponent(View);

function mulberry32(a){
  return function(){
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return((t^t>>>14)>>>0)/4294967296;
  };
}

export default function EarthHorizon(){
  const{width:W,height:H}=Dimensions.get('window');
  // Tune here. R is large so the visible limb is a gentle curve; CAP is how tall
  // a strip of screen the planet fills from the bottom ("top quarter on screen").
  const R=W*2.15;
  const CAP=Math.round(H*0.26);
  const CX=W/2;
  const CY=R; // circle centred so its apex lands at y=0 of the CAP canvas

  const drift=useRef(new Animated.Value(0)).current;
  const pulse=useRef(new Animated.Value(0)).current;

  useEffect(()=>{
    const a=Animated.loop(Animated.sequence([
      Animated.timing(drift,{toValue:1,duration:34000,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
      Animated.timing(drift,{toValue:0,duration:34000,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
    ]));
    const b=Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:1,duration:2200,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
      Animated.timing(pulse,{toValue:0,duration:2200,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
    ]));
    a.start();b.start();
    return()=>{a.stop();b.stop();};
  },[drift,pulse]);

  const landDrift={transform:[{translateX:drift.interpolate({inputRange:[0,1],outputRange:[-13,13]})}]};
  const cloudDrift={transform:[{translateX:drift.interpolate({inputRange:[0,1],outputRange:[16,-16]})}]};

  const{land,clouds}=useMemo(()=>{
    const rnd=mulberry32(0x1CE1);
    const land=Array.from({length:7},()=>({
      cx:CX+(rnd()*2-1)*W*0.62,cy:8+rnd()*CAP*1.1,
      rx:W*(0.10+rnd()*0.18),ry:CAP*(0.16+rnd()*0.30),
      rot:(rnd()*2-1)*24,fill:rnd()>0.5?'#3C6B4E':'#6E5E3C',o:0.30+rnd()*0.20,
    }));
    const clouds=Array.from({length:6},()=>({
      cx:CX+(rnd()*2-1)*W*0.7,cy:2+rnd()*CAP*0.7,
      rx:W*(0.16+rnd()*0.22),ry:CAP*(0.08+rnd()*0.14),o:0.10+rnd()*0.16,
    }));
    return{land,clouds};
  },[W,CAP,CX]);

  return(
    <View style={[styles.wrap,{height:CAP}]} pointerEvents="none">
      <Svg width={W} height={CAP} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="eh_ocean" cx="50%" cy="6%" fx="40%" fy="-10%" r="125%">
            <Stop offset="0" stopColor="#2E73AC"/>
            <Stop offset="0.34" stopColor="#18466F"/>
            <Stop offset="0.68" stopColor="#0C2A46"/>
            <Stop offset="1" stopColor="#06182B"/>
          </RadialGradient>
        </Defs>
        <Circle cx={CX} cy={CY} r={R} fill="url(#eh_ocean)"/>
      </Svg>

      <AView style={[StyleSheet.absoluteFill,landDrift]}>
        <Svg width={W} height={CAP}>
          <Defs><ClipPath id="eh_land"><Circle cx={CX} cy={CY} r={R}/></ClipPath></Defs>
          <G clipPath="url(#eh_land)">
            {land.map((b,i)=>(
              <Ellipse key={i} cx={b.cx} cy={b.cy} rx={b.rx} ry={b.ry} fill={b.fill}
                opacity={b.o} transform={`rotate(${b.rot} ${b.cx} ${b.cy})`}/>
            ))}
          </G>
        </Svg>
      </AView>

      <AView style={[StyleSheet.absoluteFill,cloudDrift]}>
        <Svg width={W} height={CAP}>
          <Defs><ClipPath id="eh_cl"><Circle cx={CX} cy={CY} r={R}/></ClipPath></Defs>
          <G clipPath="url(#eh_cl)">
            {clouds.map((c,i)=>(
              <Ellipse key={i} cx={c.cx} cy={c.cy} rx={c.rx} ry={c.ry} fill="#EAF4FF" opacity={c.o}/>
            ))}
          </G>
        </Svg>
      </AView>

      <Svg width={W} height={CAP} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="eh_atmo" cx="50%" cy="100%" r="62%">
            <Stop offset="0.55" stopColor="#8FE3FF" stopOpacity="0"/>
            <Stop offset="0.9" stopColor="#8FE3FF" stopOpacity="0.20"/>
            <Stop offset="1" stopColor="#E8C98A" stopOpacity="0.14"/>
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width={W} height={CAP} fill="url(#eh_atmo)"/>
        <Circle cx={CX} cy={CY} r={R+1} fill="none" stroke="#CFF0FF" strokeOpacity="0.55" strokeWidth={1.4}/>
        <Circle cx={CX} cy={CY} r={R+6} fill="none" stroke="#E8C98A" strokeOpacity="0.16" strokeWidth={7}/>
      </Svg>

      <Animated.Text style={[styles.hint,{opacity:pulse.interpolate({inputRange:[0,1],outputRange:[0.35,0.85]})}]}>
        TAP EARTH TO ENTER THE CITY
      </Animated.Text>
    </View>
  );
}

const styles=StyleSheet.create({
  wrap:{position:'absolute',left:0,right:0,bottom:0,overflow:'hidden',alignItems:'center'},
  hint:{position:'absolute',bottom:'14%',fontFamily:'monospace',fontSize:8,letterSpacing:2,color:'#CFE8F5'},
});
