// Lightweight TradeLocker connection pill. Reads the synchronous tlStatus()
// (no network) and makes a lazy tlConnect() on mount so the pill can turn
// green on a screen that doesn't otherwise talk to the broker. After that it
// just re-reads the sync flag on a timer — the trading panel's own polls keep
// the session warm. A failed connect attempt (anything but missing creds)
// retries quietly every 10s instead of sitting on OFFLINE until the user
// happens to leave this screen and come back — the session is memory-only
// (no backend), so every cold app start needs a fresh handshake, and a
// transient failure right at launch (network not up yet, a brief
// TradeLocker hiccup) shouldn't require a manual nudge to recover from.
import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{tlStatus,tlConnect}from '../services/tradeLocker';
import{colors,FONTS,radius,space}from '../theme';

const TONE={
  live:{dot:colors.online,text:colors.online,border:colors.onlineDim},
  connecting:{dot:colors.warn,text:colors.warn,border:'rgba(217,164,65,0.35)'},
  limited:{dot:colors.warn,text:colors.warn,border:'rgba(217,164,65,0.35)'},
  offline:{dot:colors.danger,text:colors.danger,border:'rgba(199,97,75,0.4)'},
  unconfigured:{dot:colors.textFaint,text:colors.textDim,border:colors.hairline},
};
const LABEL={live:'LIVE',connecting:'CONNECTING',limited:'RATE-LIMITED',offline:'OFFLINE',unconfigured:'NO LOGIN'};

const POLL_MS=4000; // sync read only — no network

export default function TradeStatus({active=true,style,onPress}){
  const st=tlStatus();
  const[state,setState]=useState(st.connected?(st.rateLimited?'limited':'live'):'connecting');
  const[env,setEnv]=useState(st.env);
  const alive=useRef(true);

  useEffect(()=>{
    alive.current=true;
    if(!active)return()=>{alive.current=false;};
    let retryTimer=null;
    const tryConnect=()=>{
      if(!alive.current)return;
      setState('connecting');
      tlConnect()
        .then(a=>{if(alive.current){setState(tlStatus().rateLimited?'limited':'live');setEnv(a?.env||tlStatus().env);}})
        .catch(e=>{
          if(!alive.current)return;
          const unconfigured=/not connected|add your login/i.test(e?.message||'');
          setState(unconfigured?'unconfigured':'offline');
          // Missing creds needs the user to act in Settings — don't hammer
          // the API for that. Anything else is worth quietly retrying.
          if(!unconfigured)retryTimer=setTimeout(tryConnect,10000);
        });
    };
    if(!tlStatus().connected)tryConnect();
    const iv=setInterval(()=>{
      if(!alive.current)return;
      const s=tlStatus();
      if(s.connected){setState(s.rateLimited?'limited':'live');setEnv(s.env);}
    },POLL_MS);
    return()=>{alive.current=false;clearInterval(iv);if(retryTimer)clearTimeout(retryTimer);};
  },[active]);

  const tone=TONE[state]||TONE.connecting;
  const envTag=env&&(state==='live'||state==='connecting')?` · ${String(env).toUpperCase()}`:'';
  const Wrap=onPress?TouchableOpacity:View;

  return(
    <View style={[s.wrap,style]}>
      <Wrap style={[s.pill,{borderColor:tone.border}]} onPress={onPress} activeOpacity={0.7}>
        <View style={[s.dot,{backgroundColor:tone.dot}]}/>
        <Text style={[s.text,{color:tone.text}]} numberOfLines={1}>TRADELOCKER {LABEL[state]||''}{envTag}</Text>
      </Wrap>
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{alignSelf:'flex-start'},
  pill:{flexDirection:'row',alignItems:'center',gap:6,borderWidth:1,borderRadius:radius.pill,paddingHorizontal:space.sm,paddingVertical:4},
  dot:{width:6,height:6,borderRadius:3},
  text:{fontFamily:FONTS.mono,fontSize:8,letterSpacing:2},
});
