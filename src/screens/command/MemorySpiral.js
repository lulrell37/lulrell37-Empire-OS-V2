// A persona's memory as one growing spiral.
//   GRAPH — the persona orb sits in the centre; every stored memory is a bead
//           on a single thread that winds outward in date order (oldest hugging
//           the orb, newest out on the rim). Bead colour = memory category, so
//           the type is readable at a glance. The more memories there are, the
//           more turns the thread takes and the wider the whole structure grows.
//           Pinch out / + zooms in toward your fingers; pinch again on a bead
//           opens it. Pinch in / - backs out.
//   LIST  — the same memories as dated cards, filterable by category.
// Both share one category filter (the chips) and one tap target (onNode).
import React,{useState,useMemo,useRef,useEffect,useCallback,useImperativeHandle,forwardRef}from 'react';
import{View,Text,StyleSheet,ScrollView,ActivityIndicator,PanResponder,TouchableOpacity,Animated,Easing}from 'react-native';
import Svg,{Circle,Path,G,Text as SvgText,Defs,RadialGradient,Stop}from 'react-native-svg';
import{CATEGORIES,categoryMeta}from '../../services/memoryCategories';
import{colors,space,radius,FONTS}from '../../theme';
import MemoryList from './MemoryList';

const ACircle=Animated.createAnimatedComponent(Circle);
const AG=Animated.createAnimatedComponent(G);
const SPIN_MS=150000;   // one full turn of the spiral — slow, like a galaxy
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
  const[zoom,setZoom]=useState(1);
  const vp=useRef({w:0,h:0});
  const scroll=useRef({x:0,y:0});
  const origin=useRef({x:0,y:0});
  const rootRef=useRef(null),vRef=useRef(null),hRef=useRef(null);
  const pinch=useRef({d0:0,d1:0,cx:0,cy:0});
  const fade=useRef(new Animated.Value(0)).current;
  const pulse=useRef(new Animated.Value(0)).current;
  const comet=useRef(new Animated.Value(0)).current;
  const spin=useRef(new Animated.Value(0)).current;
  const spinFrac=useRef(0);   // live 0..1 turn fraction, for hit-testing the spun beads

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
    const spinLoop=Animated.loop(Animated.timing(spin,{toValue:1,duration:SPIN_MS,easing:Easing.linear,useNativeDriver:false}));
    const spinId=spin.addListener(({value})=>{spinFrac.current=value;});
    pulseLoop.start();cometLoop.start();spinLoop.start();
    return()=>{pulseLoop.stop();cometLoop.stop();spinLoop.stop();spin.removeListener(spinId);};
  },[fade,pulse,comet,spin]);

  // The spiral. An Archimedean spiral r = b·θ, with θ chosen per bead so the
  // arc-length gap between consecutive memories stays roughly constant (so the
  // beads don't bunch up near the centre and thin out at the rim).
  const layout=useMemo(()=>{
    if(!memories||!memories.length)return null;
    const chron=[...memories].reverse();          // stored newest-first -> oldest-first
    const shown=chron.slice(-MAX_NODES);          // keep the most recent, still oldest-first
    const N=shown.length;
    const ARM=27;                                 // px between successive spiral arms
    const D=24;                                   // arc-length gap between beads
    const R0=30;                                  // clear radius around the persona orb
    const TH0=Math.PI*2.2;                        // start ~1 turn out from dead centre
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
    return{size,cx,cy,nodes,thread,comet:{px,py},coreRad:16+Math.log2(total+1)*1.6};
  },[memories,total]);

  const worldTarget=useCallback((centroid)=>{
    const z=zoom||1;
    if(centroid&&typeof centroid.x==='number')
      return{x:(scroll.current.x+centroid.x)/z,y:(scroll.current.y+Math.max(0,centroid.y-34))/z};
    return{x:(scroll.current.x+(vp.current.w||1)/2)/z,y:(scroll.current.y+(vp.current.h||1)/2)/z};
  },[zoom]);
  const scrollTo=useCallback((sx,sy)=>{
    hRef.current?.scrollTo?.({x:Math.max(0,sx),animated:true});
    vRef.current?.scrollTo?.({y:Math.max(0,sy),animated:true});
  },[]);

  const drillIn=useCallback((centroid)=>{
    if(mode!=='graph'||!layout)return;
    const c=worldTarget(centroid);
    if(zoom<1.85){
      const nz=1.85;setZoom(nz);
      scrollTo(c.x*nz-(vp.current.w||1)/2,c.y*nz-(vp.current.h||1)/2);
      return;
    }
    // already zoomed -> open the nearest bead. The beads are drawn rotated by
    // the galaxy spin, so undo that rotation on the tap point before matching.
    const a=-spinFrac.current*2*Math.PI,ca=Math.cos(a),sa=Math.sin(a);
    const dx=c.x-layout.cx,dy=c.y-layout.cy;
    const px=layout.cx+dx*ca-dy*sa,py=layout.cy+dx*sa+dy*ca;
    let best=null,bd=Infinity;
    for(const n of layout.nodes){
      if(focus&&(n.m.category||'personal')!==focus)continue;
      const dd=Math.hypot(n.x-px,n.y-py);
      if(dd<bd){bd=dd;best=n;}
    }
    if(best&&onNode)onNode(best.m);
  },[mode,layout,zoom,focus,worldTarget,scrollTo,onNode]);

  const drillOut=useCallback(()=>{
    if(zoom>1){setZoom(1);return true;}
    if(focus){setFocus(null);return true;}
    onExit&&onExit();
    return false;
  },[zoom,focus,onExit]);

  useImperativeHandle(ref,()=>({drillIn,drillOut}),[drillIn,drillOut]);

  const pan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponderCapture:(e)=>mode==='graph'&&e.nativeEvent.touches?.length===2,
    onMoveShouldSetPanResponderCapture:(e)=>mode==='graph'&&e.nativeEvent.touches?.length===2,
    onPanResponderGrant:(e)=>{
      const t=e.nativeEvent.touches;
      if(t&&t.length===2){
        const d=Math.hypot(t[0].pageX-t[1].pageX,t[0].pageY-t[1].pageY);
        pinch.current={d0:d,d1:d,
          cx:(t[0].pageX+t[1].pageX)/2-origin.current.x,
          cy:(t[0].pageY+t[1].pageY)/2-origin.current.y};
      }
    },
    onPanResponderMove:(e)=>{
      const t=e.nativeEvent.touches;
      if(t&&t.length===2)pinch.current.d1=Math.hypot(t[0].pageX-t[1].pageX,t[0].pageY-t[1].pageY);
    },
    onPanResponderRelease:()=>{
      const{d0,d1,cx,cy}=pinch.current;pinch.current={d0:0,d1:0,cx:0,cy:0};
      if(d0>0&&d1>0){const r=d1/d0;if(r>1.22)drillIn({x:cx,y:cy});else if(r<0.82)drillOut();}
    },
    onPanResponderTerminationRequest:()=>false,
  }),[mode,drillIn,drillOut]);

  if(memories==null)return(<View style={s.center}><ActivityIndicator color={persona.color}/></View>);
  if(total===0)return(
    <View style={s.center}>
      <View style={[s.coreDot,{borderColor:persona.color}]}><Text style={[s.coreIcon,{color:persona.color}]}>{persona.icon}</Text></View>
      <Text style={s.empty}>{persona.name} has no memories yet.</Text>
      <Text style={s.emptySub}>Everything you talk about is stored here.</Text>
    </View>
  );

  const coreGlow=pulse.interpolate({inputRange:[0,1],outputRange:[0.10,0.24]});
  const spinDeg=spin.interpolate({inputRange:[0,1],outputRange:[0,360]});
  const cometOpacity=comet.interpolate({inputRange:[0,0.05,0.9,1],outputRange:[0,1,1,0]});
  const cometIn=Array.from({length:SAMPLES},(_,i)=>i/(SAMPLES-1));

  return(
    <View ref={rootRef} style={s.wrap} {...(mode==='graph'?pan.panHandlers:{})}
      onLayout={e=>{
        vp.current={w:e.nativeEvent.layout.width,h:e.nativeEvent.layout.height};
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
              onPress={()=>{setMode(mo);setZoom(1);}}>
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
        <Animated.View style={{flex:1,opacity:fade}}>
          <ScrollView ref={vRef} style={{flex:1}} contentContainerStyle={s.stage} showsVerticalScrollIndicator={false}
            scrollEventThrottle={32} onScroll={e=>{scroll.current.y=e.nativeEvent.contentOffset.y;}}>
            <ScrollView ref={hRef} horizontal contentContainerStyle={s.stage} showsHorizontalScrollIndicator={false}
              scrollEventThrottle={32} onScroll={e=>{scroll.current.x=e.nativeEvent.contentOffset.x;}}>
              {layout&&<Svg width={layout.size*zoom} height={layout.size*zoom}>
                <Defs>
                  <RadialGradient id="ms-core" cx="50%" cy="50%" r="50%">
                    <Stop offset="0" stopColor={persona.color} stopOpacity="0.42"/>
                    <Stop offset="1" stopColor={persona.color} stopOpacity="0"/>
                  </RadialGradient>
                </Defs>
                <G scale={zoom}>
                  <ACircle cx={layout.cx} cy={layout.cy} r={layout.coreRad*3.6} fill="url(#ms-core)" opacity={coreGlow}/>

                  {/* the whole spiral turns slowly around the persona, like a galaxy */}
                  <AG rotation={spinDeg} originX={layout.cx} originY={layout.cy}>
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
                  </AG>

                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill={colors.bg} opacity={0.9}/>
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill="none" stroke={persona.color} strokeWidth={1.5}/>
                  <SvgText x={layout.cx} y={layout.cy+4} fill={persona.color} fontSize={13} fontWeight="700"
                    fontFamily={FONTS.mono} textAnchor="middle">{persona.icon}</SvgText>
                </G>
              </Svg>}
            </ScrollView>
          </ScrollView>
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

  stage:{alignItems:'center',justifyContent:'center',minWidth:'100%',minHeight:'100%'},
});
