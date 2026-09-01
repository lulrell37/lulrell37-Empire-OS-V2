// Always-on TradeLocker connection indicator — LIVE / CONNECTING / THROTTLED /
// OFFLINE / NO LOGIN. Reads the cheap synchronous tlHealth() on a timer (the
// trading panel polls keep that state fresh) and fires one lazy connect on mount.
import React,{useState,useEffect,useRef}from 'react';
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

const FAST_MS=3500;   // reflect state changes quickly (sync read, no network)

export default function TradeStatus({active=true,style,onPress,showDetail=false}){
  const[h,setH]=useState(()=>tlHealth());
  const alive=useRef(true);

  useEffect(()=>{
    alive.current=true;
    setH(tlHealth());
    if(!active)return()=>{alive.current=false;};
    // One lazy connect attempt on mount so the pill can show LIVE even on a
    // screen that doesn't otherwise poll (Settings). tlPing no-ops if a real
    // trading call is already running or we're already connected.
    tlPing().then(next=>{if(alive.current)setH(next);}).catch(()=>{});
    // Everything after is a synchronous read of state the trading polls update.
    const fast=setInterval(()=>{if(alive.current)setH(tlHealth());},FAST_MS);
    return()=>{alive.current=false;clearInterval(fast);};
  },[active]);

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
