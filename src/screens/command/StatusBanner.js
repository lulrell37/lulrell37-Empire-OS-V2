// Top-of-screen status banner. Surfaces the current problem — GitHub not
// connected, a repo that failed to create, a build that broke — in plain words,
// and keeps it visible until it's fixed or dismissed. Long messages scroll
// slowly (marquee) so the whole thing can be read without truncation.
import React,{useRef,useEffect,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Animated,Easing}from 'react-native';

const TONE={
  error:{bg:'#2A1414',border:'#7A2E2E',fg:'#E8938C',dot:'#E0555A'},
  warn:{bg:'#2A2312',border:'#7A6326',fg:'#E8C98A',dot:'#D9A441'},
  info:{bg:'#12222A',border:'#265A6B',fg:'#9AD3E0',dot:'#3FA6C0'},
};
// px per character for the 11px monospace label — used to decide if the text
// overflows and needs to scroll. Rough is fine.
const CHAR_W=6.6;
const GAP=64;

export default function StatusBanner({issue,onPress,onDismiss}){
  const tx=useRef(new Animated.Value(0)).current;
  const[cw,setCw]=useState(0);
  const msg=issue?.text||'';
  const textW=msg.length*CHAR_W;
  const scroll=cw>0&&textW>cw;

  useEffect(()=>{
    tx.stopAnimation();
    tx.setValue(0);
    if(!scroll)return;
    const dist=textW+GAP;
    const loop=Animated.loop(Animated.sequence([
      Animated.delay(1200),
      Animated.timing(tx,{toValue:-dist,duration:dist*55,easing:Easing.linear,useNativeDriver:true}),
    ]));
    loop.start();
    return()=>loop.stop();
  },[msg,scroll,textW,cw]);// eslint-disable-line react-hooks/exhaustive-deps

  if(!issue||!msg)return null;
  const t=TONE[issue.severity]||TONE.error;

  return(
    <TouchableOpacity activeOpacity={issue.detail?0.7:1} onPress={()=>issue.detail&&onPress?.(issue)}
      style={[s.wrap,{backgroundColor:t.bg,borderColor:t.border}]}>
      <View style={[s.dot,{backgroundColor:t.dot}]}/>
      <View style={s.clip} onLayout={e=>setCw(e.nativeEvent.layout.width)}>
        <Animated.View style={[s.track,{transform:[{translateX:scroll?tx:0}]}]}>
          <Text numberOfLines={scroll?undefined:2} style={[s.txt,scroll?s.txtScroll:s.txtWrap,{color:t.fg}]}>{msg}</Text>
          {scroll?<Text style={[s.txt,s.txtScroll,{color:t.fg,paddingLeft:GAP}]}>{msg}</Text>:null}
        </Animated.View>
      </View>
      {issue.detail?<Text style={[s.more,{color:t.fg}]}>ⓘ</Text>:null}
      <TouchableOpacity onPress={()=>onDismiss?.()} hitSlop={{top:10,bottom:10,left:10,right:10}}>
        <Text style={[s.x,{color:t.fg}]}>✕</Text>
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const s=StyleSheet.create({
  wrap:{flexDirection:'row',alignItems:'center',gap:9,marginHorizontal:10,marginTop:6,paddingHorizontal:11,paddingVertical:7,borderRadius:7,borderWidth:1},
  dot:{width:6,height:6,borderRadius:3},
  clip:{flex:1,overflow:'hidden'},
  track:{flexDirection:'row',alignItems:'center'},
  txt:{fontFamily:'monospace',fontSize:10,letterSpacing:0.4,lineHeight:14},
  txtScroll:{flexShrink:0},
  txtWrap:{flexShrink:1},
  more:{fontFamily:'monospace',fontSize:12,opacity:0.8},
  x:{fontFamily:'monospace',fontSize:12,opacity:0.7},
});
