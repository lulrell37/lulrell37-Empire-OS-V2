// EarthHorizon — Earth curving up along the very bottom edge of the persona
// galaxy (OrbZoom's "group" level). Only a thin sliver of the planet's top is on
// screen; the rest is well below the frame.
//
// Pure art: the whole component is pointerEvents:"none". The tap-to-descend
// target is a PanResponder strip inside PersonaSphereInner.
import React,{useEffect,useMemo,useRef}from 'react';
import{Animated,Dimensions,Easing,StyleSheet,View}from 'react-native';
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
  // Tune here. R big -> the visible limb is a very gentle curve. CAP small ->
  // the planet sits low, only a sliver of its top showing.
  const R=W*3.0;
  const CAP=Math.round(H*0.10); // only a thin sliver of the planet's top on screen
  const CX=W/2;
  const CY=R+Math.round(H*0.015); // nudge the whole globe down a touch more
  // Sun direction — day side brightens toward upper-left, fades to night lower-right.
  const SUN_X=CX-W*0.34, SUN_Y=CY-R-H*0.12;

  const drift=useRef(new Animated.Value(0)).current;

  useEffect(()=>{
    const a=Animated.loop(Animated.sequence([
      Animated.timing(drift,{toValue:1,duration:42000,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
      Animated.timing(drift,{toValue:0,duration:42000,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
    ]));
    a.start();
    return()=>a.stop();
  },[drift]);

  const landDrift={transform:[{translateX:drift.interpolate({inputRange:[0,1],outputRange:[-10,10]})}]};
  const cloudDrift={transform:[{translateX:drift.interpolate({inputRange:[0,1],outputRange:[13,-13]})}]};

  const{land,clouds}=useMemo(()=>{
    const rnd=mulberry32(0x1CE1);
    const tones=['#3F6B4C','#4C6E4F','#6A5B44','#7C6A4E','#8A7A5C'];
    const land=Array.from({length:12},()=>({
      cx:CX+(rnd()*2-1)*W*0.7,cy:6+rnd()*CAP*1.4,
      rx:W*(0.06+rnd()*0.13),ry:CAP*(0.20+rnd()*0.5),
      rot:(rnd()*2-1)*30,fill:tones[(rnd()*tones.length)|0],o:0.32+rnd()*0.22,
    }));
    const clouds=Array.from({length:9},()=>({
      cx:CX+(rnd()*2-1)*W*0.8,cy:rnd()*CAP*0.9,
      rx:W*(0.12+rnd()*0.22),ry:CAP*(0.10+rnd()*0.18),o:0.10+rnd()*0.18,
    }));
    return{land,clouds};
  },[W,CAP,CX]);

  return(
    <View style={[styles.wrap,{height:CAP}]} pointerEvents="none">
      {/* ocean sphere, lit from the sun direction */}
      <Svg width={W} height={CAP} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="eh_ocean" cx={SUN_X} cy={SUN_Y} r={R*1.7} gradientUnits="userSpaceOnUse">
            <Stop offset="0" stopColor="#2C86C4"/>
            <Stop offset="0.28" stopColor="#1667A0"/>
            <Stop offset="0.58" stopColor="#0B406B"/>
            <Stop offset="0.82" stopColor="#062A48"/>
            <Stop offset="1" stopColor="#04182C"/>
          </RadialGradient>
        </Defs>
        <Circle cx={CX} cy={CY} r={R} fill="url(#eh_ocean)"/>
      </Svg>

      {/* continents, clipped to the globe, drifting slowly */}
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

      {/* weather systems */}
      <AView style={[StyleSheet.absoluteFill,cloudDrift]}>
        <Svg width={W} height={CAP}>
          <Defs><ClipPath id="eh_cl"><Circle cx={CX} cy={CY} r={R}/></ClipPath></Defs>
          <G clipPath="url(#eh_cl)">
            {clouds.map((c,i)=>(
              <Ellipse key={i} cx={c.cx} cy={c.cy} rx={c.rx} ry={c.ry} fill="#F4F8FF" opacity={c.o}/>
            ))}
          </G>
        </Svg>
      </AView>

      {/* night-side falloff + atmosphere limb, no space fade */}
      <Svg width={W} height={CAP} style={StyleSheet.absoluteFill}>
        <Defs>
          <RadialGradient id="eh_night" cx={SUN_X} cy={SUN_Y} r={R*2.1} gradientUnits="userSpaceOnUse">
            <Stop offset="0.45" stopColor="#000814" stopOpacity="0"/>
            <Stop offset="0.85" stopColor="#000814" stopOpacity="0.35"/>
            <Stop offset="1" stopColor="#000510" stopOpacity="0.62"/>
          </RadialGradient>
          <RadialGradient id="eh_space" cx="50%" cy="100%" r="70%">
            <Stop offset="0.6" stopColor="#000000" stopOpacity="0"/>
            <Stop offset="0.94" stopColor="#4FB6E8" stopOpacity="0.16"/>
            <Stop offset="1" stopColor="#BEEBFF" stopOpacity="0.30"/>
          </RadialGradient>
        </Defs>
        <Circle cx={CX} cy={CY} r={R} fill="url(#eh_night)"/>
        <Rect x="0" y="0" width={W} height={CAP} fill="url(#eh_space)"/>
        {/* thin bright rim on the limb + a soft outer haze, both cool */}
        <Circle cx={CX} cy={CY} r={R+1.5} fill="none" stroke="#DFF4FF" strokeOpacity="0.6" strokeWidth={1.4}/>
        <Circle cx={CX} cy={CY} r={R+9} fill="none" stroke="#7FD3FF" strokeOpacity="0.14" strokeWidth={14}/>
      </Svg>
    </View>
  );
}

const styles=StyleSheet.create({
  wrap:{position:'absolute',left:0,right:0,bottom:0,overflow:'hidden'},
});
