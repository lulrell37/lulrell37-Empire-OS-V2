// The persona Brain as a network: a central core, one hub per keyword category,
// and one node per stored exchange orbiting its hub. It is one more level of the
// orb screen's continuous zoom — pinch out to drill toward the centre of what
// you're looking at (all hubs -> one hub -> one memory), pinch in to back out.
import React,{useState,useMemo,useRef,useImperativeHandle,forwardRef,useCallback}from 'react';
import{View,Text,StyleSheet,ScrollView,ActivityIndicator,PanResponder}from 'react-native';
import Svg,{Circle,Line,G,Text as SvgText}from 'react-native-svg';
import{CATEGORIES}from '../../services/memoryCategories';

const GOLDEN=2.399963229728653;

function BrainWebInner({persona,memories,onNode,onExit},ref){
  const[focus,setFocus]=useState(null);   // category key, or null for the whole web
  const[zoom,setZoom]=useState(1);
  const vp=useRef({w:0,h:0});
  const scroll=useRef({x:0,y:0});
  const origin=useRef({x:0,y:0});
  const rootRef=useRef(null);
  const vRef=useRef(null),hRef=useRef(null);
  const pinch=useRef({d0:0,d1:0,cx:0,cy:0});

  const groups=useMemo(()=>{
    if(!memories)return[];
    const by={};
    for(const m of memories){const k=m.category||'personal';(by[k]||(by[k]=[])).push(m);}
    return CATEGORIES.filter(c=>by[c.key]?.length).map(c=>({...c,memories:by[c.key],count:by[c.key].length}));
  },[memories]);
  const total=memories?.length||0;

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
      return{...g,hx,hy,hubRad:5+Math.sqrt(g.count)*1.6,nodes};
    });
    return{size:sizePx,cx,cy,hubs,coreRad:20+Math.log2(total+1)*3};
  },[groups,total]);

  // A point in unscaled SVG coords: the pinch centroid if given (stage-local px),
  // otherwise the centre of the viewport.
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
    if(!layout)return;
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
  },[layout,focus,target,scrollTo]);

  const drillOut=useCallback(()=>{
    if(focus){setFocus(null);setZoom(1);return true;}
    if(zoom>1){setZoom(1);return true;}
    onExit&&onExit();
    return false;
  },[focus,zoom,onExit]);

  useImperativeHandle(ref,()=>({drillIn,drillOut}),[drillIn,drillOut]);

  const pan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponderCapture:(e)=>!!e.nativeEvent.touches&&e.nativeEvent.touches.length===2,
    onMoveShouldSetPanResponderCapture:(e)=>!!e.nativeEvent.touches&&e.nativeEvent.touches.length===2,
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
  }),[drillIn,drillOut]);

  if(memories==null)return(<View style={s.center}><ActivityIndicator color={persona.color}/></View>);
  if(total===0)return(
    <View style={s.center}>
      <Text style={s.empty}>{persona.name} has no memories yet.{'\n'}Talk to {persona.name} and this brain fills in.</Text>
    </View>
  );

  return(
    <View ref={rootRef} style={{flex:1}} {...pan.panHandlers}
      onLayout={e=>{
        vp.current={w:e.nativeEvent.layout.width,h:e.nativeEvent.layout.height};
        rootRef.current&&rootRef.current.measureInWindow&&rootRef.current.measureInWindow((x,y)=>{origin.current={x:x||0,y:y||0};});
      }}>
      <View style={s.statsRow}>
        <Text style={[s.statBig,{color:persona.color}]}>{total}</Text>
        <Text style={s.statLabel}>MEMOR{total===1?'Y':'IES'}</Text>
        <Text style={s.statDot}>·</Text>
        <Text style={[s.statBig,{color:persona.color}]}>{groups.length}</Text>
        <Text style={s.statLabel}>REGION{groups.length===1?'':'S'}</Text>
      </View>

      <ScrollView ref={vRef} style={{flex:1}} contentContainerStyle={s.pad} showsVerticalScrollIndicator={false}
        scrollEventThrottle={32} onScroll={e=>{scroll.current.y=e.nativeEvent.contentOffset.y;}}>
        <ScrollView ref={hRef} horizontal contentContainerStyle={s.pad} showsHorizontalScrollIndicator={false}
          scrollEventThrottle={32} onScroll={e=>{scroll.current.x=e.nativeEvent.contentOffset.x;}}>
          {layout&&<Svg width={layout.size*zoom} height={layout.size*zoom}>
            <G scale={zoom}>
              {layout.hubs.map(h=>(
                <Line key={'l'+h.key} x1={layout.cx} y1={layout.cy} x2={h.hx} y2={h.hy}
                  stroke={h.color} strokeWidth={1} opacity={focus&&focus!==h.key?0.05:0.28}/>
              ))}
              {layout.hubs.map(h=>{
                const dim=focus&&focus!==h.key;
                return(
                  <G key={'g'+h.key} opacity={dim?0.08:1}>
                    {h.nodes.map((n,i)=>(
                      <Line key={'nl'+i} x1={h.hx} y1={h.hy} x2={n.x} y2={n.y} stroke={h.color} strokeWidth={0.6} opacity={0.35}/>
                    ))}
                    {h.nodes.map((n,i)=>(
                      <Circle key={'n'+i} cx={n.x} cy={n.y} r={n.rad} fill={h.color} opacity={0.9} onPress={()=>onNode&&onNode(n.m)}/>
                    ))}
                    <Circle cx={h.hx} cy={h.hy} r={h.hubRad} fill={h.color} onPress={()=>setFocus(f=>f===h.key?null:h.key)}/>
                    <SvgText x={h.hx} y={h.hy-h.hubRad-6} fill={h.color} fontSize={9} fontFamily="monospace"
                      textAnchor="middle" opacity={dim?0.3:0.9}>{`${h.label.toUpperCase()} ${h.count}`}</SvgText>
                  </G>
                );
              })}
              <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill={persona.color} opacity={0.16}/>
              <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} stroke={persona.color} strokeWidth={1.5} fill="none"/>
              <SvgText x={layout.cx} y={layout.cy+4} fill={persona.color} fontSize={13} fontWeight="700"
                fontFamily="monospace" textAnchor="middle">{persona.icon}</SvgText>
            </G>
          </Svg>}
        </ScrollView>
      </ScrollView>

      <Text style={s.foot}>◈ PINCH OUT TO GO DEEPER · PINCH IN TO BACK OUT</Text>
    </View>
  );
}

const BrainWeb=forwardRef(BrainWebInner);
export default BrainWeb;

const s=StyleSheet.create({
  center:{flex:1,alignItems:'center',justifyContent:'center',padding:24},
  empty:{fontFamily:'monospace',fontSize:11,color:'#333',textAlign:'center',lineHeight:20,letterSpacing:1},
  statsRow:{flexDirection:'row',alignItems:'baseline',justifyContent:'center',gap:6,paddingVertical:8},
  statBig:{fontFamily:'monospace',fontSize:16,fontWeight:'700'},
  statLabel:{fontFamily:'monospace',fontSize:8,color:'#444',letterSpacing:2},
  statDot:{color:'#333',fontSize:12,marginHorizontal:4},
  pad:{alignItems:'center',justifyContent:'center',minWidth:'100%',minHeight:'100%'},
  foot:{fontFamily:'monospace',fontSize:7,color:'#333',letterSpacing:2,textAlign:'center',paddingVertical:8,borderTopWidth:1,borderTopColor:'#0D0D0D'},
});
