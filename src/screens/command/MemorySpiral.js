// A persona's memory as one growing spiral.
//   GRAPH — the persona orb sits in the centre; every stored memory is a bead
//           on a single thread that winds outward in date order (oldest hugging
//           the orb, newest out on the rim). Bead colour = memory category, so
//           the type is readable at a glance. The more memories there are, the
//           more turns the thread takes and the wider the whole structure grows.
//           Pinch (or + / -) zooms smoothly toward your fingers; drag to pan
//           once you're in. Tap a bead to open it. Pinch back out to leave.
//   LIST  — the same memories as dated cards, filterable by category.
// Both share one category filter (the chips) and one tap target (onNode).
import React,{useState,useMemo,useRef,useEffect,useCallback,useImperativeHandle,forwardRef}from 'react';
import{View,Text,StyleSheet,ScrollView,ActivityIndicator,PanResponder,TouchableOpacity,Animated,Easing}from 'react-native';
import Svg,{Circle,Path,G,Text as SvgText,Defs,RadialGradient,Stop}from 'react-native-svg';
import{CATEGORIES,categoryMeta}from '../../services/memoryCategories';
import{colors,space,radius,FONTS}from '../../theme';
import MemoryList from './MemoryList';

const ACircle=Animated.createAnimatedComponent(Circle);
const SPIN_MS=190000;   // one clockwise turn of the spiral — slow, like a galaxy
const MAX_NODES=420;   // cap the drawn beads; LIST view still shows every memory
const SAMPLES=44;      // points sampled along the thread for the travelling dot

// Blend a #rrggbb toward white by amt (0..1).
function lighten(hex,amt){
  const h=String(hex||'#888888').replace('#','');
  const n=h.length===3?h.split('').map(c=>c+c).join(''):h;
  const r=parseInt(n.slice(0,2),16),g=parseInt(n.slice(2,4),16),b=parseInt(n.slice(4,6),16);
  const m=(v)=>Math.round(v+(255-v)*amt).toString(16).padStart(2,'0');
  return `#${m(r)}${m(g)}${m(b)}`;
}

function MemorySpiralInner({persona,memories,onNode,onExit},ref){
  const[mode,setMode]=useState('graph');   // 'graph' | 'list'
  const[focus,setFocus]=useState(null);     // category key filter, or null
  const[vpSize,setVpSize]=useState({w:0,h:0});   // for the fit-to-view calc
  const origin=useRef({x:0,y:0});           // root position in the window
  const stageBox=useRef({x:0,y:0,width:0,height:0});
  const rootRef=useRef(null);
  const fade=useRef(new Animated.Value(0)).current;
  const pulse=useRef(new Animated.Value(0)).current;
  const comet=useRef(new Animated.Value(0)).current;
  const spin=useRef(new Animated.Value(0)).current;

  // Continuous pan/zoom of the spiral, driven straight onto the native thread so
  // the pinch tracks the fingers instead of jumping between fixed steps.
  const sc=useRef(new Animated.Value(1)).current;   // absolute on-screen scale
  const tx=useRef(new Animated.Value(0)).current;
  const ty=useRef(new Animated.Value(0)).current;
  const view=useRef({s:1,x:0,y:0});                 // committed transform
  const fitRef=useRef(1);
  const gest=useRef(null);                          // live gesture bookkeeping

  const groups=useMemo(()=>{
    if(!memories)return[];
    const by={};
    for(const m of memories){const k=m.category||'personal';(by[k]||(by[k]=[])).push(m);}
    return CATEGORIES.filter(c=>by[c.key]?.length).map(c=>({...c,count:by[c.key].length}));
  },[memories]);
  const total=memories?.length||0;

  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:420,useNativeDriver:true}).start();
    const pulseLoop=Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:1,duration:2600,useNativeDriver:false}),
      Animated.timing(pulse,{toValue:0,duration:2600,useNativeDriver:false}),
    ]));
    const cometLoop=Animated.loop(Animated.sequence([
      Animated.timing(comet,{toValue:1,duration:5200,useNativeDriver:false}),
      Animated.delay(700),
      Animated.timing(comet,{toValue:0,duration:0,useNativeDriver:false}),
      Animated.delay(500),
    ]));
    const spinLoop=Animated.loop(Animated.timing(spin,{toValue:1,duration:SPIN_MS,easing:Easing.linear,useNativeDriver:true}));
    pulseLoop.start();cometLoop.start();spinLoop.start();
    return()=>{pulseLoop.stop();cometLoop.stop();spinLoop.stop();};
  },[fade,pulse,comet,spin]);

  // The spiral. An Archimedean spiral r = b·θ, with θ chosen per bead so the
  // arc-length gap between consecutive memories stays roughly constant (so the
  // beads don't bunch up near the centre and thin out at the rim).
  const layout=useMemo(()=>{
    if(!memories||!memories.length)return null;
    const chron=[...memories].reverse();          // stored newest-first -> oldest-first
    const shown=chron.slice(-MAX_NODES);          // keep the most recent, still oldest-first
    const N=shown.length;
    const coreRad=16+Math.log2(total+1)*1.6;      // persona orb radius
    const ARM=24;                                 // px between successive spiral arms
    const D=20;                                   // arc-length gap between beads
    const R0=coreRad+6;                           // first loop hugs the persona orb
    const TH0=Math.PI*0.35;                       // start just outside the orb, not a turn out
    const b=ARM/(2*Math.PI);
    const raw=shown.map((m,k)=>{
      const th=Math.sqrt(TH0*TH0+(2*k*D)/b);
      return{m,th,r:R0+b*th};
    });
    const maxR=(raw.length?raw[raw.length-1].r:R0)+16;
    const size=Math.max(360,Math.ceil(maxR*2+56));
    const cx=size/2,cy=size/2;
    const nodes=raw.map(({m,th,r},k)=>({
      m,
      x:cx+Math.cos(th)*r,
      y:cy+Math.sin(th)*r,
      rad:3.4+(N>1?k/(N-1):0)*1.9,               // newer beads a touch larger
      color:categoryMeta(m.category).color,
    }));
    let thread=`M ${cx.toFixed(1)} ${cy.toFixed(1)}`;
    for(const n of nodes)thread+=` L ${n.x.toFixed(1)} ${n.y.toFixed(1)}`;
    // sample the thread for the travelling dot
    const px=[],py=[];
    const last=Math.max(1,nodes.length-1);
    for(let i=0;i<SAMPLES;i++){
      const f=(i/(SAMPLES-1))*last;
      const lo=Math.floor(f),hi=Math.min(nodes.length-1,lo+1),frac=f-lo;
      const a=nodes[lo]||{x:cx,y:cy},c=nodes[hi]||a;
      px.push(a.x+(c.x-a.x)*frac);py.push(a.y+(c.y-a.y)*frac);
    }
    return{size,cx,cy,nodes,thread,comet:{px,py},coreRad};
  },[memories,total]);

  // Shrink the whole spiral to fit the visible stage, so the slow rotation turns
  // it in place instead of sweeping the outer arm off-screen. Zoom rides on top.
  const fit=useMemo(()=>{
    if(!layout||!vpSize.w)return 1;
    const box=Math.min(vpSize.w,Math.max(140,vpSize.h-96))-16;
    return Math.max(0.25,Math.min(1,box/layout.size));
  },[layout,vpSize]);
  const MAX_ZOOM=4;   // how far past fit a pinch can go

  // Re-anchor to the fit baseline whenever it changes (first layout, new data),
  // unless the user is currently zoomed in.
  useEffect(()=>{
    const atRest=fitRef.current===1||Math.abs(view.current.s-fitRef.current)<0.02;
    fitRef.current=fit;
    if(atRest){
      view.current={s:fit,x:0,y:0};
      sc.setValue(fit);tx.setValue(0);ty.setValue(0);
    }
  },[fit,sc,tx,ty]);

  const clampPan=useCallback((s,x,y)=>{
    if(!layout)return{x:0,y:0};
    const mx=Math.max(0,(layout.size*s-stageBox.current.width)/2);
    const my=Math.max(0,(layout.size*s-stageBox.current.height)/2);
    return{x:Math.max(-mx,Math.min(mx,x)),y:Math.max(-my,Math.min(my,y))};
  },[layout]);

  const animateTo=useCallback((s,x,y,dur=240)=>{
    view.current={s,x,y};
    const cfg={duration:dur,easing:Easing.out(Easing.cubic),useNativeDriver:true};
    Animated.timing(sc,{toValue:s,...cfg}).start();
    Animated.timing(tx,{toValue:x,...cfg}).start();
    Animated.timing(ty,{toValue:y,...cfg}).start();
  },[sc,tx,ty]);

  const drillIn=useCallback(()=>{
    if(mode!=='graph')return;
    const s=Math.min(fitRef.current*MAX_ZOOM,view.current.s*1.6);
    const p=clampPan(s,view.current.x,view.current.y);
    animateTo(s,p.x,p.y);
  },[mode,clampPan,animateTo]);

  const drillOut=useCallback(()=>{
    if(view.current.s>fitRef.current*1.05){
      const s=Math.max(fitRef.current,view.current.s/1.6);
      const p=s<=fitRef.current*1.02?{x:0,y:0}:clampPan(s,view.current.x,view.current.y);
      animateTo(s,p.x,p.y);
      return true;
    }
    if(focus){setFocus(null);return true;}
    onExit&&onExit();
    return false;
  },[focus,onExit,clampPan,animateTo]);

  useImperativeHandle(ref,()=>({drillIn,drillOut}),[drillIn,drillOut]);

  const stageCenter=()=>({
    x:stageBox.current.x+stageBox.current.width/2,
    y:stageBox.current.y+stageBox.current.height/2,
  });

  const pan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponderCapture:(e)=>mode==='graph'&&(e.nativeEvent.touches?.length||0)>=2,
    onMoveShouldSetPanResponderCapture:(e)=>mode==='graph'&&(e.nativeEvent.touches?.length||0)>=2,
    onMoveShouldSetPanResponder:(e,g)=>mode==='graph'&&(e.nativeEvent.touches?.length||0)===1
      &&view.current.s>fitRef.current*1.05&&(Math.abs(g.dx)>4||Math.abs(g.dy)>4),
    onPanResponderGrant:(e)=>{
      const t=e.nativeEvent.touches,o=origin.current;
      sc.stopAnimation();tx.stopAnimation();ty.stopAnimation();
      if(t&&t.length>=2){
        const d=Math.hypot(t[0].pageX-t[1].pageX,t[0].pageY-t[1].pageY);
        gest.current={kind:'pinch',d0:d,s0:view.current.s,x0:view.current.x,y0:view.current.y,lastR:1,
          fx:(t[0].pageX+t[1].pageX)/2-o.x,fy:(t[0].pageY+t[1].pageY)/2-o.y};
      }else if(t&&t.length===1){
        gest.current={kind:'drag',px:t[0].pageX,py:t[0].pageY,x0:view.current.x,y0:view.current.y};
      }
    },
    onPanResponderMove:(e)=>{
      const gc=gest.current;if(!gc)return;
      const t=e.nativeEvent.touches;
      if(gc.kind==='pinch'&&t&&t.length>=2){
        const d=Math.hypot(t[0].pageX-t[1].pageX,t[0].pageY-t[1].pageY);
        const lo=fitRef.current,hi=fitRef.current*MAX_ZOOM;
        const s=Math.max(lo,Math.min(hi,gc.s0*(d/gc.d0)));
        const ratio=s/gc.s0;gc.lastR=d/gc.d0;
        const c=stageCenter();
        const dxF=gc.fx-c.x,dyF=gc.fy-c.y;
        sc.setValue(s);
        tx.setValue(gc.x0*ratio+dxF*(1-ratio));
        ty.setValue(gc.y0*ratio+dyF*(1-ratio));
      }else if(gc.kind==='drag'&&t&&t.length===1){
        tx.setValue(gc.x0+(t[0].pageX-gc.px));
        ty.setValue(gc.y0+(t[0].pageY-gc.py));
      }
    },
    onPanResponderRelease:()=>{
      const gc=gest.current;gest.current=null;if(!gc)return;
      sc.stopAnimation(s=>{
        tx.stopAnimation(x=>{
          ty.stopAnimation(y=>{
            const p=clampPan(s,x,y);
            view.current={s,x:p.x,y:p.y};
            if(p.x!==x)Animated.spring(tx,{toValue:p.x,useNativeDriver:true}).start();
            if(p.y!==y)Animated.spring(ty,{toValue:p.y,useNativeDriver:true}).start();
            // pinched all the way out and kept squeezing -> leave the spiral
            if(gc.kind==='pinch'&&s<=fitRef.current*1.02&&gc.lastR<0.9)drillOut();
          });
        });
      });
    },
    onPanResponderTerminationRequest:()=>false,
  }),[mode,clampPan,drillOut,sc,tx,ty]);

  if(memories==null)return(<View style={s.center}><ActivityIndicator color={persona.color}/></View>);
  if(total===0)return(
    <View style={s.center}>
      <View style={[s.coreDot,{borderColor:persona.color}]}><Text style={[s.coreIcon,{color:persona.color}]}>{persona.icon}</Text></View>
      <Text style={s.empty}>{persona.name} has no memories yet.</Text>
      <Text style={s.emptySub}>Everything you talk about is stored here.</Text>
    </View>
  );

  const coreGlow=pulse.interpolate({inputRange:[0,1],outputRange:[0.10,0.24]});
  const spinDeg=spin.interpolate({inputRange:[0,1],outputRange:['0deg','360deg']});
  const cometOpacity=comet.interpolate({inputRange:[0,0.05,0.9,1],outputRange:[0,1,1,0]});
  const cometIn=Array.from({length:SAMPLES},(_,i)=>i/(SAMPLES-1));

  return(
    <View ref={rootRef} style={s.wrap} {...(mode==='graph'?pan.panHandlers:{})}
      onLayout={e=>{
        const{width,height}=e.nativeEvent.layout;
        setVpSize(p=>(p.w===width&&p.h===height?p:{w:width,h:height}));
        rootRef.current?.measureInWindow?.((x,y)=>{origin.current={x:x||0,y:y||0};});
      }}>

      <View style={s.header}>
        <View style={s.stats}>
          <Text style={[s.statNum,{color:persona.color}]}>{total}</Text>
          <Text style={s.statLabel}>MEMOR{total===1?'Y':'IES'}</Text>
          <View style={s.statSep}/>
          <Text style={[s.statNum,{color:persona.color}]}>{groups.length}</Text>
          <Text style={s.statLabel}>TYPE{groups.length===1?'':'S'}</Text>
        </View>
        <View style={s.seg}>
          {['graph','list'].map(mo=>(
            <TouchableOpacity key={mo} style={[s.segBtn,mode===mo&&{backgroundColor:persona.color+'1F',borderColor:persona.color+'66'}]}
              onPress={()=>{
                setMode(mo);
                view.current={s:fitRef.current,x:0,y:0};
                sc.setValue(fitRef.current);tx.setValue(0);ty.setValue(0);
              }}>
              <Text style={[s.segT,mode===mo&&{color:persona.color}]}>{mo.toUpperCase()}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipsRow} contentContainerStyle={s.chipsPad}>
        {groups.map(g=>{
          const on=focus===g.key;
          return(
            <TouchableOpacity key={g.key} activeOpacity={0.7}
              style={[s.chip,{borderColor:on?g.color:colors.hairline,backgroundColor:on?g.color+'1A':'transparent'}]}
              onPress={()=>setFocus(f=>f===g.key?null:g.key)}>
              <View style={[s.chipDot,{backgroundColor:g.color}]}/>
              <Text style={[s.chipT,{color:on?g.color:colors.textMuted}]}>{g.label.toUpperCase()}</Text>
              <Text style={[s.chipN,{color:on?g.color:colors.textDim}]}>{g.count}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {mode==='list'?(
        <Animated.View style={{flex:1,opacity:fade}}>
          <MemoryList memories={memories} onNode={onNode} filter={focus}/>
        </Animated.View>
      ):(
        <Animated.View style={[s.stage,{opacity:fade}]}
          onLayout={e=>{stageBox.current=e.nativeEvent.layout;}}>
          {layout&&(
            <Animated.View style={{width:layout.size,height:layout.size,
              transform:[{translateX:tx},{translateY:ty},{scale:sc}]}}>

              {/* spinning layer — turns about its own centre, i.e. the persona */}
              <Animated.View style={[StyleSheet.absoluteFill,{transform:[{rotate:spinDeg}]}]}>
                <Svg width={layout.size} height={layout.size}>
                  <G>
                    <Path d={layout.thread} fill="none" stroke={persona.color}
                      strokeWidth={1} strokeLinejoin="round" opacity={focus?0.06:0.16}/>
                    <ACircle r={2.4} fill={lighten(persona.color,0.5)} opacity={cometOpacity}
                      cx={comet.interpolate({inputRange:cometIn,outputRange:layout.comet.px})}
                      cy={comet.interpolate({inputRange:cometIn,outputRange:layout.comet.py})}/>
                    {layout.nodes.map(n=>{
                      const dim=focus&&(n.m.category||'personal')!==focus;
                      return(
                        <Circle key={n.m.id} cx={n.x} cy={n.y} r={n.rad*(dim?0.7:1.15)}
                          fill={n.color} opacity={dim?0.12:0.92} onPress={()=>onNode&&onNode(n.m)}/>
                      );
                    })}
                  </G>
                </Svg>
              </Animated.View>

              {/* static layer — persona orb + glow stay put while the arm turns */}
              <Svg width={layout.size} height={layout.size} style={StyleSheet.absoluteFill} pointerEvents="none">
                <Defs>
                  <RadialGradient id="ms-core" cx="50%" cy="50%" r="50%">
                    <Stop offset="0" stopColor={persona.color} stopOpacity="0.42"/>
                    <Stop offset="1" stopColor={persona.color} stopOpacity="0"/>
                  </RadialGradient>
                </Defs>
                <G>
                  <ACircle cx={layout.cx} cy={layout.cy} r={layout.coreRad*3.6} fill="url(#ms-core)" opacity={coreGlow}/>
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill={colors.bg} opacity={0.9}/>
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill="none" stroke={persona.color} strokeWidth={1.5}/>
                  <SvgText x={layout.cx} y={layout.cy+4} fill={persona.color} fontSize={13} fontWeight="700"
                    fontFamily={FONTS.mono} textAnchor="middle">{persona.icon}</SvgText>
                </G>
              </Svg>
            </Animated.View>
          )}
        </Animated.View>
      )}
    </View>
  );
}

const MemorySpiral=forwardRef(MemorySpiralInner);
export default MemorySpiral;

const s=StyleSheet.create({
  wrap:{flex:1,paddingTop:44},
  center:{flex:1,alignItems:'center',justifyContent:'center',padding:space.xxl,gap:space.md},
  coreDot:{width:52,height:52,borderRadius:26,borderWidth:1.5,alignItems:'center',justifyContent:'center',marginBottom:space.sm},
  coreIcon:{fontFamily:FONTS.monoMed,fontSize:16},
  empty:{fontFamily:FONTS.mono,fontSize:11,color:colors.textMuted,textAlign:'center',letterSpacing:0.5},
  emptySub:{fontFamily:FONTS.mono,fontSize:9,color:colors.textFaint,textAlign:'center',letterSpacing:1},

  header:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:space.lg,paddingBottom:space.sm},
  stats:{flexDirection:'row',alignItems:'baseline',gap:5},
  statNum:{fontFamily:FONTS.displaySemi,fontSize:26,letterSpacing:0.5},
  statLabel:{fontFamily:FONTS.mono,fontSize:7.5,letterSpacing:2,color:colors.textDim},
  statSep:{width:1,height:12,backgroundColor:colors.hairline,marginHorizontal:space.sm,alignSelf:'center'},
  seg:{flexDirection:'row',gap:4},
  segBtn:{borderWidth:1,borderColor:colors.hairline,borderRadius:radius.sm,paddingHorizontal:space.sm,paddingVertical:5},
  segT:{fontFamily:FONTS.monoMed,fontSize:8,letterSpacing:2,color:colors.textDim},

  chipsRow:{flexGrow:0,marginBottom:space.xs},
  chipsPad:{paddingHorizontal:space.lg,gap:space.xs,paddingVertical:2},
  chip:{flexDirection:'row',alignItems:'center',gap:5,borderWidth:1,borderRadius:radius.pill,paddingHorizontal:space.sm,paddingVertical:4},
  chipDot:{width:5,height:5,borderRadius:3},
  chipT:{fontFamily:FONTS.mono,fontSize:8,letterSpacing:1.5},
  chipN:{fontFamily:FONTS.monoMed,fontSize:8,letterSpacing:0.5},

  stage:{flex:1,alignItems:'center',justifyContent:'center',overflow:'hidden'},
});
