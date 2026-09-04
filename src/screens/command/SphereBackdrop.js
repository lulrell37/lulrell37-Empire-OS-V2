// Deep-space nebula backdrop for the persona sphere (OrbZoom's "group" level).
// Soft drifting amber/gold clouds + a seeded starfield + centre glow + vignette,
// so the persona orbs read as floating in space rather than on flat black.
//
// react-native-svg + Animated only — no new deps. The two cloud layers drift on
// native-driver transforms; a light twinkle pulses a handful of brighter stars.
// Everything is pointerEvents:none and only mounted on the sphere level, so it
// never competes with the orb gestures or the wheel-zoom catcher behind it.
import React,{useEffect,useMemo,useRef}from 'react';
import{Animated,Dimensions,Easing,StyleSheet,View}from 'react-native';
import Svg,{Defs,RadialGradient,Stop,Rect,Circle,Ellipse}from 'react-native-svg';

const AView=Animated.createAnimatedComponent(View);

function mulberry32(a){
  return function(){
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return((t^t>>>14)>>>0)/4294967296;
  };
}

export default function SphereBackdrop(){
  const{width:W,height:H}=Dimensions.get('window');
  const drift=useRef(new Animated.Value(0)).current;
  const twinkle=useRef(new Animated.Value(0)).current;

  useEffect(()=>{
    const d=Animated.loop(Animated.sequence([
      Animated.timing(drift,{toValue:1,duration:26000,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
      Animated.timing(drift,{toValue:0,duration:26000,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
    ]));
    const t=Animated.loop(Animated.sequence([
      Animated.timing(twinkle,{toValue:1,duration:2600,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
      Animated.timing(twinkle,{toValue:0,duration:2600,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
    ]));
    d.start();t.start();
    return()=>{d.stop();t.stop();};
  },[drift,twinkle]);

  const stars=useMemo(()=>{
    const rnd=mulberry32(74209);
    return Array.from({length:64},()=>({
      x:rnd()*W,y:rnd()*H*0.94,r:0.5+rnd()*1.5,o:0.14+rnd()*0.5,tw:rnd()>0.72,
    }));
  },[W,H]);

  const cloudA={transform:[
    {translateX:drift.interpolate({inputRange:[0,1],outputRange:[-14,14]})},
    {translateY:drift.interpolate({inputRange:[0,1],outputRange:[9,-9]})},
  ]};
  const cloudB={transform:[
    {translateX:drift.interpolate({inputRange:[0,1],outputRange:[11,-13]})},
    {translateY:drift.interpolate({inputRange:[0,1],outputRange:[-7,11]})},
  ]};
  const starO=twinkle.interpolate({inputRange:[0,1],outputRange:[0.55,1]});

  return(
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* base wash: warm near-black, centre glow, starfield, vignette */}
      <Svg style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="sbCore" cx="50%" cy="42%" r="55%">
            <Stop offset="0" stopColor="#3A2A12" stopOpacity="0.55"/>
            <Stop offset="0.55" stopColor="#1A1206" stopOpacity="0.28"/>
            <Stop offset="1" stopColor="#000000" stopOpacity="0"/>
          </RadialGradient>
          <RadialGradient id="sbVig" cx="50%" cy="46%" r="76%">
            <Stop offset="0" stopColor="#000000" stopOpacity="0"/>
            <Stop offset="0.6" stopColor="#000000" stopOpacity="0"/>
            <Stop offset="1" stopColor="#000000" stopOpacity="0.72"/>
          </RadialGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="#050308"/>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#sbCore)"/>
        {stars.map((st,i)=>(
          <Circle key={i} cx={st.x} cy={st.y} r={st.r} fill="#F3E3BE" opacity={st.o}/>
        ))}
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#sbVig)"/>
      </Svg>

      {/* drifting nebula cloud — gold */}
      <AView style={[StyleSheet.absoluteFill,cloudA]}>
        <Svg style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id="sbC1" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#E8C98A" stopOpacity="0.16"/>
              <Stop offset="0.5" stopColor="#C8912E" stopOpacity="0.07"/>
              <Stop offset="1" stopColor="#000000" stopOpacity="0"/>
            </RadialGradient>
          </Defs>
          <Ellipse cx={W*0.4} cy={H*0.36} rx={W*0.52} ry={H*0.26} fill="url(#sbC1)"/>
        </Svg>
      </AView>

      {/* drifting nebula cloud — ember */}
      <AView style={[StyleSheet.absoluteFill,cloudB]}>
        <Svg style={StyleSheet.absoluteFill}>
          <Defs>
            <RadialGradient id="sbC2" cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#B4703C" stopOpacity="0.13"/>
              <Stop offset="0.55" stopColor="#7B3F1E" stopOpacity="0.05"/>
              <Stop offset="1" stopColor="#000000" stopOpacity="0"/>
            </RadialGradient>
          </Defs>
          <Ellipse cx={W*0.66} cy={H*0.54} rx={W*0.46} ry={H*0.3} fill="url(#sbC2)"/>
        </Svg>
      </AView>

      {/* twinkle pass over the brighter stars */}
      <AView style={[StyleSheet.absoluteFill,{opacity:starO}]}>
        <Svg style={StyleSheet.absoluteFill}>
          {stars.filter(s=>s.tw).map((st,i)=>(
            <Circle key={i} cx={st.x} cy={st.y} r={st.r+0.4} fill="#FFFFFF" opacity={0.45}/>
          ))}
        </Svg>
      </AView>
    </View>
  );
}
