// Always-on TradeLocker connection indicator. Shows the truthful state at all
// times — LIVE / CONNECTING / THROTTLED / OFFLINE / NO LOGIN — polling the
// cheap synchronous tlHealth() every few seconds and running an active tlPing()
// on a slower tick that also re-establishes a dropped session on its own.
import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{tlHealth,tlPing}from '../services/tradeLocker';
import{colors,FONTS,radius,space}from '../theme';

const TONE={
  live:{dot:colors.online,text:colors.online,border:colors.onlineDim},
  connecting:{dot:colors.warn,text:colors.warn,border:'rgba(217,164,65,0.35)'},
  throttled:{dot:colors.warn,text:colors.warn,border:'rgba(217,164,65,0.35)'},
  down:{dot:colors.danger,text:colors.danger,border:'rgba(199,97,75,0.4)'},
  unconfigured:{dot:colors.textFaint,text:colors.textDim,border:colors.hairline},
};

const FAST_MS=3000;   // reflect state changes quickly
const SLOW_MS=20000;  // actively verify + self-heal a dropped session

export default function TradeStatus({active=true,style,onPress,showDetail=false}){
  const[h,setH]=useState(()=>tlHealth());
  const alive=useRef(true);

  const tick=useCallback(async(probe)=>{
    if(probe){
      const next=await tlPing();
      if(alive.current)setH(next);
    }else if(alive.current){
      setH(tlHealth());
    }
  },[]);

  useEffect(()=>{
    alive.current=true;
    if(!active){setH(tlHealth());return()=>{alive.current=false;};}
    tick(true);
    const fast=setInterval(()=>tick(false),FAST_MS);
    const slow=setInterval(()=>tick(true),SLOW_MS);
    return()=>{alive.current=false;clearInterval(fast);clearInterval(slow);};
  },[active,tick]);

  const tone=TONE[h.state]||TONE.connecting;
  const env=h.env&&h.state!=='unconfigured'?` · ${h.env.toUpperCase()}`:'';
  const Wrap=onPress?TouchableOpacity:View;

  return(
    <View style={[s.wrap,style]}>
      <Wrap style={[s.pill,{borderColor:tone.border}]} onPress={onPress} activeOpacity={0.7}>
        <View style={[s.dot,{backgroundColor:tone.dot}]}/>
        <Text style={[s.text,{color:tone.text}]} numberOfLines={1}>TRADELOCKER {h.label}{env}</Text>
      </Wrap>
      {showDetail&&h.detail?<Text style={s.detail} numberOfLines={3}>{h.detail}</Text>:null}
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{alignSelf:'flex-start'},
  pill:{flexDirection:'row',alignItems:'center',gap:6,borderWidth:1,borderRadius:radius.pill,paddingHorizontal:space.sm,paddingVertical:4},
  dot:{width:6,height:6,borderRadius:3},
  text:{fontFamily:FONTS.mono,fontSize:8,letterSpacing:2},
  detail:{fontFamily:FONTS.mono,fontSize:8,color:colors.textFaint,letterSpacing:0.5,lineHeight:13,marginTop:5},
});
