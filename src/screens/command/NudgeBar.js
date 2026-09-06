// Slim notification strip on the Command screen. Holds proactive nudges
// (computed on focus) and live problems flagged into the store (GitHub not
// connected, a build that failed, a repo that couldn't be created…). When the
// chips overflow the strip it runs as a continuous conveyor belt: the row is
// rendered twice and scrolled by exactly one copy's width, then reset to 0 —
// so the first message follows the last one with no gap or snap-back.
import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,Animated,Easing,Alert}from 'react-native';
import{computeNudges}from '../../services/nudges';
import useEmpireStore from '../../store/useEmpireStore';

const TONE={
  error:{border:'#7A2E2E',fg:'#E8938C',x:'#8a4a4a'},
  warn:{border:'#7A6326',fg:'#E8C98A',x:'#6b5a30'},
  info:{border:'#265A6B',fg:'#9AD3E0',x:'#3d6b78'},
};
const GAP=6; // must match s.row / s.copy column gap, so copy B lands exactly where copy A began

export default function NudgeBar({active}){
  const[nudges,setNudges]=useState([]);
  const[dismissed,setDismissed]=useState({});
  const firmIssues=useEmpireStore(s=>s.firmIssues);
  const clearFirmIssue=useEmpireStore(s=>s.clearFirmIssue);

  const scrollRef=useRef(null);
  const anim=useRef(new Animated.Value(0)).current;
  const[cw,setCw]=useState(0);      // visible width
  const[oneW,setOneW]=useState(0);  // width of one copy of the row

  useEffect(()=>{
    let alive=true;
    if(active)computeNudges().then(n=>{if(alive)setNudges(n);}).catch(()=>{});
    return()=>{alive=false;};
  },[active,firmIssues]);

  // Merge: live problems first (errors, then warn/info), then proactive nudges.
  const issueChips=Object.entries(firmIssues).map(([key,v])=>({
    key:'firm:'+key,rawKey:key,text:v.text,detail:v.detail,severity:v.severity||'error',issue:true,
  })).sort((a,b)=>(a.severity==='error'?0:1)-(b.severity==='error'?0:1));
  const nudgeChips=nudges.map(n=>({...n,severity:n.severity||'warn'}));
  const shown=[...issueChips,...nudgeChips].filter(n=>!dismissed[n.key]);

  const belt=active&&oneW>0&&cw>0&&oneW>cw+8&&shown.length>1;

  // Continuous conveyor: linear 0 -> (one copy + gap), then loop straight back to
  // 0. Because copy B is identical and sits exactly one (oneW+GAP) after copy A,
  // the reset is invisible.
  useEffect(()=>{
    anim.stopAnimation();
    anim.setValue(0);
    scrollRef.current?.scrollTo({x:0,animated:false});
    if(!belt)return;
    const span=oneW+GAP;
    const id=anim.addListener(({value})=>{scrollRef.current?.scrollTo({x:value,animated:false});});
    const loop=Animated.loop(Animated.timing(anim,{
      toValue:span,duration:Math.max(5000,span*38),easing:Easing.linear,useNativeDriver:false,
    }));
    loop.start();
    return()=>{loop.stop();anim.removeListener(id);};
  },[belt,oneW,shown.map(c=>c.key).join('|')]);// eslint-disable-line react-hooks/exhaustive-deps

  if(!shown.length)return null;

  const onChipPress=(n)=>{
    if(n.issue&&n.detail){Alert.alert('What went wrong',n.detail);return;}
    dismissChip(n);
  };
  const dismissChip=(n)=>{
    setDismissed(d=>({...d,[n.key]:true}));
    if(n.issue)clearFirmIssue(n.rawKey);
  };

  const renderChip=(n,prefix='')=>{
    const tone=TONE[n.severity]||(n.issue?TONE.error:TONE.warn);
    const showDot=n.issue||n.severity==='error'||n.severity==='info';
    return(
      <View key={prefix+n.key} style={[s.chip,{borderColor:tone.border+'55'}]}>
        <TouchableOpacity style={s.chipMain} activeOpacity={0.7} onPress={()=>onChipPress(n)}>
          {showDot&&<Text style={[s.dot,{color:tone.fg}]}>{n.severity==='error'?'!':n.severity==='info'?'…':'▲'}</Text>}
          <Text style={[s.chipT,{color:tone.fg}]}>{n.text}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={()=>dismissChip(n)} hitSlop={{top:8,bottom:8,left:6,right:8}}>
          <Text style={[s.chipX,{color:tone.x}]}>×</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return(
    <View style={s.wrap}>
      <Text style={[s.bell,issueChips.length&&{color:TONE.error.fg}]}>◈</Text>
      <ScrollView
        ref={scrollRef}
        horizontal
        scrollEnabled={!belt}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.row}
        onLayout={e=>setCw(e.nativeEvent.layout.width)}
      >
        <View style={s.copy} onLayout={e=>setOneW(e.nativeEvent.layout.width)}>
          {shown.map(n=>renderChip(n))}
        </View>
        {belt&&<View style={s.copy} pointerEvents="none">{shown.map(n=>renderChip(n,'belt:'))}</View>}
      </ScrollView>
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12,paddingVertical:5,borderBottomWidth:1,borderBottomColor:'#141210',backgroundColor:'#0A0806'},
  bell:{color:'#D9A441',fontSize:10},
  row:{flexDirection:'row',gap:GAP,alignItems:'center',paddingRight:12},
  copy:{flexDirection:'row',gap:GAP,alignItems:'center'},
  chip:{flexDirection:'row',alignItems:'center',gap:6,borderWidth:1,borderRadius:4,paddingHorizontal:8,paddingVertical:3},
  chipMain:{flexDirection:'row',alignItems:'center',gap:6},
  dot:{fontFamily:'monospace',fontSize:9,fontWeight:'700'},
  chipT:{fontFamily:'monospace',fontSize:8,letterSpacing:0.5},
  chipX:{fontFamily:'monospace',fontSize:10},
});
