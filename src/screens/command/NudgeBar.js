// Slim notification strip on the Command screen. Holds proactive nudges
// (computed on focus) and live problems flagged into the store (GitHub not
// connected, a build that failed, a repo that couldn't be created…). When the
// chips overflow the strip auto-scrolls slowly so you can read them all without
// swiping; touching it pauses that.
import React,{useState,useEffect,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity,Animated,Easing,Alert}from 'react-native';
import{computeNudges}from '../../services/nudges';
import useEmpireStore from '../../store/useEmpireStore';

const TONE={
  error:{border:'#7A2E2E',fg:'#E8938C',x:'#8a4a4a'},
  warn:{border:'#7A6326',fg:'#E8C98A',x:'#6b5a30'},
  info:{border:'#265A6B',fg:'#9AD3E0',x:'#3d6b78'},
};

export default function NudgeBar({active}){
  const[nudges,setNudges]=useState([]);
  const[dismissed,setDismissed]=useState({});
  const firmIssues=useEmpireStore(s=>s.firmIssues);
  const clearFirmIssue=useEmpireStore(s=>s.clearFirmIssue);

  const scrollRef=useRef(null);
  const anim=useRef(new Animated.Value(0)).current;
  const cw=useRef(0);      // visible width
  const contentW=useRef(0); // total content width
  const paused=useRef(false);
  const[overflow,setOverflow]=useState(0);
  const measure=()=>setOverflow(Math.max(0,contentW.current-cw.current));

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

  // Slow auto-scroll when the row overflows.
  useEffect(()=>{
    anim.stopAnimation();
    anim.setValue(0);
    if(!active||overflow<=8||shown.length<2)return;
    const id=anim.addListener(({value})=>{
      if(!paused.current)scrollRef.current?.scrollTo({x:value,animated:false});
    });
    // Scroll to the end, pause, then snap back to the start (no reverse-scroll
    // animation) and go again — a continuous loop instead of a bounce.
    const loop=Animated.loop(Animated.sequence([
      Animated.delay(1500),
      Animated.timing(anim,{toValue:overflow,duration:Math.max(4000,overflow*45),easing:Easing.inOut(Easing.quad),useNativeDriver:false}),
      Animated.delay(1500),
      Animated.timing(anim,{toValue:0,duration:0,useNativeDriver:false}),
    ]));
    loop.start();
    return()=>{loop.stop();anim.removeListener(id);};
  },[active,overflow,shown.length,shown.map(c=>c.key).join('|')]);// eslint-disable-line react-hooks/exhaustive-deps

  if(!shown.length)return null;

  const onChipPress=(n)=>{
    if(n.issue&&n.detail){Alert.alert('What went wrong',n.detail);return;}
    dismissChip(n);
  };
  const dismissChip=(n)=>{
    setDismissed(d=>({...d,[n.key]:true}));
    if(n.issue)clearFirmIssue(n.rawKey);
  };

  return(
    <View style={s.wrap}>
      <Text style={[s.bell,issueChips.length&&{color:TONE.error.fg}]}>◈</Text>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.row}
        onLayout={e=>{cw.current=e.nativeEvent.layout.width;measure();}}
        onContentSizeChange={w=>{contentW.current=w;measure();}}
        onScrollBeginDrag={()=>{paused.current=true;}}
        onScrollEndDrag={()=>{setTimeout(()=>{paused.current=false;},2500);}}
      >
        {shown.map(n=>{
          const tone=TONE[n.severity]||(n.issue?TONE.error:TONE.warn);
          const showDot=n.issue||n.severity==='error'||n.severity==='info';
          return(
            <View key={n.key} style={[s.chip,{borderColor:tone.border+'55'}]}>
              <TouchableOpacity style={s.chipMain} activeOpacity={0.7} onPress={()=>onChipPress(n)}>
                {showDot&&<Text style={[s.dot,{color:tone.fg}]}>{n.severity==='error'?'!':n.severity==='info'?'…':'▲'}</Text>}
                <Text style={[s.chipT,{color:tone.fg}]}>{n.text}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={()=>dismissChip(n)} hitSlop={{top:8,bottom:8,left:6,right:8}}>
                <Text style={[s.chipX,{color:tone.x}]}>×</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12,paddingVertical:5,borderBottomWidth:1,borderBottomColor:'#141210',backgroundColor:'#0A0806'},
  bell:{color:'#D9A441',fontSize:10},
  row:{flexDirection:'row',gap:6,alignItems:'center',paddingRight:12},
  chip:{flexDirection:'row',alignItems:'center',gap:6,borderWidth:1,borderRadius:4,paddingHorizontal:8,paddingVertical:3},
  chipMain:{flexDirection:'row',alignItems:'center',gap:6},
  dot:{fontFamily:'monospace',fontSize:9,fontWeight:'700'},
  chipT:{fontFamily:'monospace',fontSize:8,letterSpacing:0.5},
  chipX:{fontFamily:'monospace',fontSize:10},
});
