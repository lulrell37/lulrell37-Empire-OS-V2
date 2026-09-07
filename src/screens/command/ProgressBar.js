// A thin fill bar. `frac` is 0..1; the width eases to each new value so a
// time-based estimate (see jobEta.jobProgress) reads as steady motion rather
// than a jump on every poll.
import React,{useRef,useEffect}from 'react';
import{View,Animated,StyleSheet}from 'react-native';

export default function ProgressBar({frac=0,color='#E8C98A',track='#1E1B17',height=3}){
  const w=useRef(new Animated.Value(clamp(frac))).current;
  useEffect(()=>{
    Animated.timing(w,{toValue:clamp(frac),duration:600,useNativeDriver:false}).start();
  },[frac]);// eslint-disable-line react-hooks/exhaustive-deps
  return(
    <View style={[s.track,{height,borderRadius:height/2,backgroundColor:track}]}>
      <Animated.View style={[s.fill,{backgroundColor:color,borderRadius:height/2,
        width:w.interpolate({inputRange:[0,1],outputRange:['0%','100%']})}]}/>
    </View>
  );
}
function clamp(n){return Math.max(0,Math.min(1,Number(n)||0));}

const s=StyleSheet.create({
  track:{width:'100%',overflow:'hidden'},
  fill:{height:'100%'},
});
