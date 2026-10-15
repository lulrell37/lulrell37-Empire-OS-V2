// A plain-JS slider (no native module needed) for the voice speed setting.
// Drag or tap anywhere on the track; snaps to 0.05x steps.
import React,{useRef,useState}from 'react';
import{View,Text,PanResponder,StyleSheet}from 'react-native';

export default function SpeedSlider({value,min,max,onChange,onDone,color='#E8C98A'}){
  const[w,setW]=useState(1);
  const wRef=useRef(1);
  const startX=useRef(0);
  const live=useRef(value);
  live.current=value;
  const fromX=(x)=>{
    const f=Math.min(1,Math.max(0,x/wRef.current));
    return Math.round((min+f*(max-min))*20)/20;
  };
  const pan=useRef(PanResponder.create({
    onStartShouldSetPanResponder:()=>true,
    onMoveShouldSetPanResponder:()=>true,
    onPanResponderTerminationRequest:()=>false,
    onPanResponderGrant:(e)=>{startX.current=e.nativeEvent.locationX;const v=fromX(startX.current);live.current=v;onChange(v);},
    onPanResponderMove:(_,g)=>{const v=fromX(startX.current+g.dx);if(v!==live.current){live.current=v;onChange(v);}},
    onPanResponderRelease:()=>onDone?.(live.current),
    onPanResponderTerminate:()=>onDone?.(live.current),
  })).current;
  const frac=(value-min)/(max-min);
  return(
    <View>
      <View style={st.hit} onLayout={e=>{wRef.current=e.nativeEvent.layout.width||1;setW(wRef.current);}} {...pan.panHandlers}>
        <View style={st.track} pointerEvents="none">
          <View style={[st.fill,{width:frac*w,backgroundColor:color}]}/>
        </View>
        <View pointerEvents="none" style={[st.thumb,{left:frac*w-11,borderColor:color}]}/>
      </View>
      <View style={st.ends}>
        <Text style={st.endT}>{min}x</Text>
        <Text style={[st.valT,{color}]}>{value.toFixed(2)}x</Text>
        <Text style={st.endT}>{max}x</Text>
      </View>
    </View>
  );
}

const st=StyleSheet.create({
  hit:{height:40,justifyContent:'center'},
  track:{height:4,borderRadius:2,backgroundColor:'#1A1A1A',overflow:'hidden'},
  fill:{height:4},
  thumb:{position:'absolute',top:9,width:22,height:22,borderRadius:11,backgroundColor:'#0A0A0A',borderWidth:2},
  ends:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:2},
  endT:{fontFamily:'monospace',fontSize:9,color:'#444'},
  valT:{fontFamily:'monospace',fontSize:12,letterSpacing:1},
});
