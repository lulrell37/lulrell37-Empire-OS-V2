// The persona's memory, two ways:
//   GRAPH — a network: a glowing core, one hub per category, one node per stored
//           exchange orbiting its hub. Pinch out / + to drill toward the centre
//           of what you're looking at (all hubs -> one hub -> one memory).
//   LIST  — the same memories as dated cards, filterable by category.
// Both share one category selection and one tap target (onNode).
import React,{useState,useMemo,useRef,useImperativeHandle,forwardRef,useCallback,useEffect}from 'react';
import{View,Text,StyleSheet,ScrollView,ActivityIndicator,PanResponder,TouchableOpacity,Animated}from 'react-native';
import Svg,{Circle,Line,G,Text as SvgText,Defs,RadialGradient,Stop}from 'react-native-svg';
import{CATEGORIES}from '../../services/memoryCategories';
import{colors,space,radius,FONTS}from '../../theme';
import MemoryList from './MemoryList';

const GOLDEN=2.399963229728653;
const ACircle=Animated.createAnimatedComponent(Circle);

function BrainWebInner({persona,memories,onNode,onExit},ref){
  const[mode,setMode]=useState('graph');   // 'graph' | 'list'
  const[focus,setFocus]=useState(null);     // category key, or null for the whole web
  const[zoom,setZoom]=useState(1);
  const vp=useRef({w:0,h:0});
  const scroll=useRef({x:0,y:0});
  const origin=useRef({x:0,y:0});
  const rootRef=useRef(null);
  const vRef=useRef(null),hRef=useRef(null);
  const pinch=useRef({d0:0,d1:0,cx:0,cy:0});
  const fade=useRef(new Animated.Value(0)).current;
  const pulse=useRef(new Animated.Value(0)).current;

  const groups=useMemo(()=>{
    if(!memories)return[];
    const by={};
    for(const m of memories){const k=m.category||'personal';(by[k]||(by[k]=[])).push(m);}
    return CATEGORIES.filter(c=>by[c.key]?.length).map(c=>({...c,memories:by[c.key],count:by[c.key].length}));
  },[memories]);
  const total=memories?.length||0;

  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:420,useNativeDriver:true}).start();
    const loop=Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:1,duration:2600,useNativeDriver:false}),
      Animated.timing(pulse,{toValue:0,duration:2600,useNativeDriver:false}),
    ]));
    loop.start();
    return()=>loop.stop();
  },[fade,pulse]);

  const layout=useMemo(()=>{
    if(!groups.length)return null;
    const maxCount=Math.max(...groups.map(g=>g.count));
    const spreadOf=(count)=>34+Math.sqrt(count)*22;
    const hubRing=140+groups.length*10+Math.sqrt(maxCount)*10;
    const pad=spreadOf(maxCount)+70;
    const sizePx=Math.max(360,(hubRing+pad)*2);
    const cx=sizePx/2,cy=sizePx/2;
    const hubs=groups.map((g,i)=>{
      const a=(i/groups.length)*Math.PI*2-Math.PI/2;
      const hx=cx+Math.cos(a)*hubRing;
      const hy=cy+Math.sin(a)*hubRing;
      const shown=g.memories.slice(0,300);
      const spread=spreadOf(shown.length);
      const nodes=shown.map((m,j)=>{
        const r=spread*Math.sqrt((j+0.55)/shown.length);
        const na=j*GOLDEN+a;
        return{m,x:hx+Math.cos(na)*r,y:hy+Math.sin(na)*r,rad:4.2+Math.min(3.5,70/shown.length)};
      });
      return{...g,hx,hy,hubRad:6+Math.sqrt(g.count)*1.7,nodes};
    });
    return{size:sizePx,cx,cy,hubs,coreRad:22+Math.log2(total+1)*3};
  },[groups,total]);

  const target=useCallback((centroid)=>{
    const z=zoom||1;
    if(centroid&&typeof centroid.x==='number'){
      return{x:(scroll.current.x+centroid.x)/z,y:(scroll.current.y+Math.max(0,centroid.y-34))/z};
    }
    return{x:(scroll.current.x+(vp.current.w||1)/2)/z,y:(scroll.current.y+(vp.current.h||1)/2)/z};
  },[zoom]);

  const scrollTo=useCallback((sx,sy)=>{
    hRef.current?.scrollTo?.({x:Math.max(0,sx),animated:true});
    vRef.current?.scrollTo?.({y:Math.max(0,sy),animated:true});
  },[]);

  const drillIn=useCallback((centroid)=>{
    if(mode!=='graph'||!layout)return;
    const c=target(centroid);
    if(!focus){
      let best=layout.hubs[0],bd=Infinity;
      for(const h of layout.hubs){const d=Math.hypot(h.hx-c.x,h.hy-c.y);if(d<bd){bd=d;best=h;}}
      if(!best)return;
      setFocus(best.key);
      const nz=1.8;setZoom(nz);
      scrollTo(best.hx*nz-(vp.current.w||1)/2,best.hy*nz-(vp.current.h||1)/2);
    }else{
      const h=layout.hubs.find(x=>x.key===focus);
      if(!h||!h.nodes.length)return;
      let best=h.nodes[0],bd=Infinity;
      for(const n of h.nodes){const d=Math.hypot(n.x-c.x,n.y-c.y);if(d<bd){bd=d;best=n;}}
      onNode&&onNode(best.m);
    }
  },[mode,layout,focus,target,scrollTo]);

  const drillOut=useCallback(()=>{
    if(focus){setFocus(null);setZoom(1);return true;}
    if(mode==='graph'&&zoom>1){setZoom(1);return true;}
    onExit&&onExit();
    return false;
  },[focus,mode,zoom,onExit]);

  useImperativeHandle(ref,()=>({drillIn,drillOut}),[drillIn,drillOut]);

  const pickCategory=useCallback((key)=>{
    setFocus(f=>f===key?null:key);
    if(mode==='graph'){
      const next=focus===key?null:key;
      if(next&&layout){
        const h=layout.hubs.find(x=>x.key===next);
        if(h){setZoom(1.8);scrollTo(h.hx*1.8-(vp.current.w||1)/2,h.hy*1.8-(vp.current.h||1)/2);}
      }else setZoom(1);
    }
  },[mode,focus,layout,scrollTo]);

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
          <Text style={s.statLabel}>REGION{groups.length===1?'':'S'}</Text>
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
              onPress={()=>pickCategory(g.key)}>
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
                  <RadialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
                    <Stop offset="0" stopColor={persona.color} stopOpacity="0.5"/>
                    <Stop offset="1" stopColor={persona.color} stopOpacity="0"/>
                  </RadialGradient>
                </Defs>
                <G scale={zoom}>
                  <ACircle cx={layout.cx} cy={layout.cy} r={layout.coreRad*5} fill="url(#coreGlow)" opacity={coreGlow}/>
                  {layout.hubs.map(h=>(
                    <Line key={'l'+h.key} x1={layout.cx} y1={layout.cy} x2={h.hx} y2={h.hy}
                      stroke={h.color} strokeWidth={1.2} opacity={focus&&focus!==h.key?0.04:0.22}/>
                  ))}
                  {layout.hubs.map(h=>{
                    const dim=focus&&focus!==h.key;
                    return(
                      <G key={'g'+h.key} opacity={dim?0.07:1}>
                        <Circle cx={h.hx} cy={h.hy} r={h.hubRad*3.4} fill={h.color} opacity={0.06}/>
                        {h.nodes.map((n,i)=>(
                          <Line key={'nl'+i} x1={h.hx} y1={h.hy} x2={n.x} y2={n.y} stroke={h.color} strokeWidth={0.6} opacity={0.28}/>
                        ))}
                        {h.nodes.map((n,i)=>(
                          <Circle key={'n'+i} cx={n.x} cy={n.y} r={n.rad} fill={h.color} opacity={0.92} onPress={()=>onNode&&onNode(n.m)}/>
                        ))}
                        <Circle cx={h.hx} cy={h.hy} r={h.hubRad} fill={colors.bg} stroke={h.color} strokeWidth={1.6}
                          onPress={()=>pickCategory(h.key)}/>
                        <Circle cx={h.hx} cy={h.hy} r={h.hubRad*0.42} fill={h.color} onPress={()=>pickCategory(h.key)}/>
                        <SvgText x={h.hx} y={h.hy-h.hubRad-7} fill={h.color} fontSize={8.5} fontFamily={FONTS.mono}
                          textAnchor="middle" opacity={dim?0.3:0.95}>{`${h.label.toUpperCase()}  ${h.count}`}</SvgText>
                      </G>
                    );
                  })}
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad+5} fill="none" stroke={persona.color} strokeWidth={0.75} opacity={0.3}/>
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill={colors.bg} opacity={0.9}/>
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} stroke={persona.color} strokeWidth={1.75} fill="none"/>
                  <SvgText x={layout.cx} y={layout.cy+4.5} fill={persona.color} fontSize={13} fontWeight="700"
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

const BrainWeb=forwardRef(BrainWebInner);
export default BrainWeb;

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
