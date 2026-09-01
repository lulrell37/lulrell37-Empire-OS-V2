// The persona's memory, two ways:
//   GRAPH — a brain: a silhouette with sulci and a central fissure, one lobe per
//           category sitting inside it, one neuron per stored exchange clustered
//           around its lobe, white-matter tracts between lobes with signals
//           travelling along them. Pinch out / + drills toward the centre of what
//           you're looking at (all lobes -> one lobe -> one memory).
//   LIST  — the same memories as dated cards, filterable by category.
// Both share one category selection and one tap target (onNode).
import React,{useState,useMemo,useRef,useImperativeHandle,forwardRef,useCallback,useEffect}from 'react';
import{View,Text,StyleSheet,ScrollView,ActivityIndicator,PanResponder,TouchableOpacity,Animated}from 'react-native';
import Svg,{Circle,Line,Path,G,Text as SvgText,Defs,RadialGradient,Stop}from 'react-native-svg';
import{CATEGORIES}from '../../services/memoryCategories';
import{colors,space,radius,FONTS}from '../../theme';
import MemoryList from './MemoryList';

const GOLDEN=2.399963229728653;
const ACircle=Animated.createAnimatedComponent(Circle);

// Blend a #rrggbb toward white by amt (0..1) — for gradient highlights.
function lighten(hex,amt){
  const h=hex.replace('#','');
  const n=h.length===3?h.split('').map(c=>c+c).join(''):h;
  const r=parseInt(n.slice(0,2),16),g=parseInt(n.slice(2,4),16),b=parseInt(n.slice(4,6),16);
  const m=(v)=>Math.round(v+(255-v)*amt).toString(16).padStart(2,'0');
  return `#${m(r)}${m(g)}${m(b)}`;
}

// A top-down brain silhouette as a polygon: an oval with a fuller frontal lobe,
// temporal-lobe bumps low on each side, and a small brain-stem notch at the base.
function brainPolygon(cx,cy,rx,ry){
  const N=76,p=[];
  for(let i=0;i<N;i++){
    const t=i/N*Math.PI*2;                    // 0 = top (frontal), PI = base (occipital)
    let r=1
      +0.055*Math.cos(t)                       // frontal lobe fuller than the back
      +0.05*Math.cos(t*2)                      // flatten the sides a touch (oval, not round)
      -0.028*Math.cos(t*4);
    r+=0.07*Math.exp(-((t-Math.PI*0.72)**2)/0.13);  // right temporal bump
    r+=0.07*Math.exp(-((t-Math.PI*1.28)**2)/0.13);  // left temporal bump
    r-=0.06*Math.exp(-((t-Math.PI)**2)/0.02);        // brain-stem notch at the base
    p.push({x:cx+Math.sin(t)*rx*r,y:cy-Math.cos(t)*ry*r});
  }
  return p;
}

// Closed Catmull-Rom -> cubic Bezier path through the points.
function smoothClosed(p){
  const n=p.length;
  let d=`M ${p[0].x.toFixed(1)} ${p[0].y.toFixed(1)} `;
  for(let i=0;i<n;i++){
    const a=p[(i-1+n)%n],b=p[i],c=p[(i+1)%n],e=p[(i+2)%n];
    d+=`C ${(b.x+(c.x-a.x)/6).toFixed(1)} ${(b.y+(c.y-a.y)/6).toFixed(1)} `
      +`${(c.x-(e.x-b.x)/6).toFixed(1)} ${(c.y-(e.y-b.y)/6).toFixed(1)} `
      +`${c.x.toFixed(1)} ${c.y.toFixed(1)} `;
  }
  return d+'Z';
}

function pointInPoly(x,y,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i].x,yi=poly[i].y,xj=poly[j].x,yj=poly[j].y;
    if(((yi>y)!==(yj>y))&&(x<((xj-xi)*(y-yi))/((yj-yi)||1e-9)+xi))inside=!inside;
  }
  return inside;
}

// Pull (x,y) back along the line to (tx,ty) until it sits inside the silhouette.
function clampInto(x,y,poly,tx,ty){
  if(pointInPoly(x,y,poly))return{x,y};
  let lo=0,hi=1;
  for(let k=0;k<14;k++){const t=(lo+hi)/2;pointInPoly(tx+(x-tx)*t,ty+(y-ty)*t,poly)?lo=t:hi=t;}
  const t=lo*0.9;
  return{x:tx+(x-tx)*t,y:ty+(y-ty)*t};
}

// Quadratic Bezier path from A to B, bowed sideways by k*len.
function arcPath(ax,ay,bx,by,k){
  const mx=(ax+bx)/2,my=(ay+by)/2;
  const nx=-(by-ay),ny=bx-ax,len=Math.hypot(nx,ny)||1;
  return{d:`M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${(mx+nx/len*len*k).toFixed(1)} ${(my+ny/len*len*k).toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`,
    ctrl:{x:mx+nx/len*len*k,y:my+ny/len*len*k}};
}

// 6 sample points along a quadratic Bezier — for animating a signal dot.
function quadSamples(ax,ay,cx,cy,bx,by){
  const px=[],py=[];
  for(let i=0;i<=5;i++){const t=i/5,u=1-t;
    px.push(u*u*ax+2*u*t*cx+t*t*bx);py.push(u*u*ay+2*u*t*cy+t*t*by);}
  return{px,py};
}

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
  const sig=useRef([0,1,2].map(()=>new Animated.Value(0))).current; // signal dots along tracts

  const groups=useMemo(()=>{
    if(!memories)return[];
    const by={};
    for(const m of memories){const k=m.category||'personal';(by[k]||(by[k]=[])).push(m);}
    return CATEGORIES.filter(c=>by[c.key]?.length).map(c=>({...c,memories:by[c.key],count:by[c.key].length}));
  },[memories]);
  const total=memories?.length||0;

  useEffect(()=>{
    Animated.timing(fade,{toValue:1,duration:420,useNativeDriver:true}).start();
    const loops=[Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:1,duration:2600,useNativeDriver:false}),
      Animated.timing(pulse,{toValue:0,duration:2600,useNativeDriver:false}),
    ]))];
    sig.forEach((v,k)=>loops.push(Animated.loop(Animated.sequence([
      Animated.delay(k*900),
      Animated.timing(v,{toValue:1,duration:2400,useNativeDriver:false}),
      Animated.timing(v,{toValue:0,duration:0,useNativeDriver:false}),
      Animated.delay(1600),
    ]))));
    loops.forEach(l=>l.start());
    return()=>loops.forEach(l=>l.stop());
  },[fade,pulse,sig]);

  const layout=useMemo(()=>{
    if(!groups.length)return null;
    const n=groups.length;
    const sizePx=Math.max(420,320+n*46+Math.sqrt(total)*10);
    const cx=sizePx/2,cy=sizePx/2;
    const rx=sizePx*0.40,ry=sizePx*0.44;                 // brain half-extents
    const poly=brainPolygon(cx,cy,rx,ry);
    const outline=smoothClosed(poly);

    // central fissure — a soft S down the midline
    let fissure=`M ${cx.toFixed(1)} ${(cy-ry*0.82).toFixed(1)} `;
    for(let j=1;j<=12;j++){
      const yy=cy-ry*0.82+j/12*ry*1.64;
      const xx=cx+Math.sin(j*0.85)*rx*0.055;
      fissure+=`Q ${(cx+Math.sin((j-0.5)*0.85)*rx*0.09).toFixed(1)} ${(yy-ry*0.068).toFixed(1)} ${xx.toFixed(1)} ${yy.toFixed(1)} `;
    }
    // sulci — mirrored wavy folds
    const sulci=[];
    for(const sgn of[-1,1])for(let k=0;k<6;k++){
      const fy=cy-ry*0.62+(k+0.5)/6*ry*1.24;
      const x0=cx+sgn*rx*0.10,x1=cx+sgn*rx*(0.62+0.22*Math.sin(k*1.3));
      let d=`M ${x0.toFixed(1)} ${fy.toFixed(1)} `;
      for(let j=1;j<=5;j++){
        const xx=x0+(x1-x0)*j/5;
        const yy=fy+Math.sin(j*1.8+k*2.1+sgn)*ry*0.045;
        const cxp=x0+(x1-x0)*(j-0.5)/5;
        const cyp=fy+Math.sin((j-0.5)*1.8+k*2.1+sgn)*ry*0.045+((j%2)?1:-1)*ry*0.03;
        d+=`Q ${cxp.toFixed(1)} ${cyp.toFixed(1)} ${xx.toFixed(1)} ${yy.toFixed(1)} `;
      }
      sulci.push(d);
    }

    // hubs = lobes: serpentine down the two hemispheres, kept inside the silhouette
    const perSide=Math.ceil(n/2);
    const hubs=groups.map((g,i)=>{
      const side=i%2===0?-1:1;
      const row=Math.floor(i/2);
      const frac=(row+0.6)/perSide;
      let hx=cx+side*rx*(0.15+0.32*Math.sin(frac*Math.PI));
      let hy=cy-ry*0.66+frac*ry*1.32;
      ({x:hx,y:hy}=clampInto(hx,hy,poly,cx,cy));
      const shown=g.memories.slice(0,260);
      const spread=26+Math.sqrt(shown.length)*15;
      const nodes=shown.map((m,j)=>{
        const rr=spread*Math.sqrt((j+0.6)/shown.length);
        const na=j*GOLDEN+i;
        let x=hx+Math.cos(na)*rr,y=hy+Math.sin(na)*rr*0.9;
        ({x,y}=clampInto(x,y,poly,hx,hy));
        return{m,x,y,rad:3.4+Math.min(2.6,55/shown.length)};
      });
      return{...g,hx,hy,hubRad:5.5+Math.sqrt(g.count)*1.5,nodes};
    });

    // white-matter tracts: each hub to its two nearest neighbours (dedup)
    const edges=[],seen=new Set();
    hubs.forEach((h,i)=>{
      const near=hubs.map((o,j)=>({j,d:Math.hypot(o.hx-h.hx,o.hy-h.hy)}))
        .filter(o=>o.j!==i).sort((a,b)=>a.d-b.d).slice(0,2);
      for(const o of near){
        const key=i<o.j?`${i}-${o.j}`:`${o.j}-${i}`;
        if(seen.has(key))continue;seen.add(key);
        const a=hubs[i],b=hubs[o.j];
        const arc=arcPath(a.hx,a.hy,b.hx,b.hy,0.12);
        edges.push({key,color:a.color,color2:b.color,d:arc.d,
          samples:quadSamples(a.hx,a.hy,arc.ctrl.x,arc.ctrl.y,b.hx,b.hy)});
      }
    });

    return{size:sizePx,cx,cy,rx,ry,poly,outline,fissure,sulci,hubs,edges,
      coreRad:14+Math.log2(total+1)*2.4};
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
                  <RadialGradient id="brainFill" cx="50%" cy="45%" r="58%">
                    <Stop offset="0" stopColor={persona.color} stopOpacity="0.09"/>
                    <Stop offset="0.62" stopColor={persona.color} stopOpacity="0.03"/>
                    <Stop offset="1" stopColor={persona.color} stopOpacity="0"/>
                  </RadialGradient>
                  <RadialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
                    <Stop offset="0" stopColor={persona.color} stopOpacity="0.42"/>
                    <Stop offset="1" stopColor={persona.color} stopOpacity="0"/>
                  </RadialGradient>
                  {layout.hubs.map(h=>(
                    <RadialGradient key={'ng'+h.key} id={`node-${h.key}`} cx="38%" cy="34%" r="70%">
                      <Stop offset="0" stopColor={lighten(h.color,0.6)} stopOpacity="1"/>
                      <Stop offset="0.5" stopColor={h.color} stopOpacity="0.95"/>
                      <Stop offset="1" stopColor={h.color} stopOpacity="0.4"/>
                    </RadialGradient>
                  ))}
                  {layout.hubs.map(h=>(
                    <RadialGradient key={'hg'+h.key} id={`halo-${h.key}`} cx="50%" cy="50%" r="50%">
                      <Stop offset="0" stopColor={h.color} stopOpacity="0.3"/>
                      <Stop offset="1" stopColor={h.color} stopOpacity="0"/>
                    </RadialGradient>
                  ))}
                </Defs>
                <G scale={zoom}>
                  <Path d={layout.outline} fill="url(#brainFill)"/>
                  <Path d={layout.outline} fill="none" stroke={persona.color} strokeWidth={12} opacity={0.045}/>
                  <Path d={layout.outline} fill="none" stroke={persona.color} strokeWidth={4} opacity={0.1}/>
                  <Path d={layout.outline} fill="none" stroke={lighten(persona.color,0.25)} strokeWidth={1.3} opacity={0.5}/>
                  {layout.sulci.map((d,i)=>(
                    <Path key={'su'+i} d={d} fill="none" stroke={persona.color} strokeWidth={0.8} opacity={0.13}/>
                  ))}
                  <Path d={layout.fissure} fill="none" stroke={persona.color} strokeWidth={1.4} opacity={0.28}/>

                  {layout.edges.map(e=>(
                    <Path key={e.key} d={e.d} fill="none" stroke={e.color} strokeWidth={1} opacity={focus?0.05:0.2}/>
                  ))}
                  <ACircle cx={layout.cx} cy={layout.cy} r={layout.coreRad*4.5} fill="url(#coreGlow)" opacity={coreGlow}/>

                  {layout.hubs.map(h=>{
                    const dim=focus&&focus!==h.key;
                    return(
                      <G key={'g'+h.key} opacity={dim?0.08:1}>
                        <Circle cx={h.hx} cy={h.hy} r={h.hubRad*7} fill={`url(#halo-${h.key})`}/>
                        {h.nodes.map((n,i)=>(
                          <Line key={'nl'+i} x1={h.hx} y1={h.hy} x2={n.x} y2={n.y} stroke={h.color} strokeWidth={0.45} opacity={0.15}/>
                        ))}
                        {h.nodes.map((n,i)=>(
                          <Circle key={'n'+i} cx={n.x} cy={n.y} r={n.rad*1.15} fill={`url(#node-${h.key})`}
                            opacity={0.5+((i*GOLDEN)%1)*0.45} onPress={()=>onNode&&onNode(n.m)}/>
                        ))}
                        <Circle cx={h.hx} cy={h.hy} r={h.hubRad*2} fill={`url(#halo-${h.key})`}/>
                        <Circle cx={h.hx} cy={h.hy} r={h.hubRad} fill={`url(#node-${h.key})`}
                          stroke={lighten(h.color,0.45)} strokeWidth={0.8} onPress={()=>pickCategory(h.key)}/>
                        <Circle cx={h.hx-h.hubRad*0.3} cy={h.hy-h.hubRad*0.32} r={h.hubRad*0.26} fill={lighten(h.color,0.9)} opacity={0.9}/>
                      </G>
                    );
                  })}

                  {layout.edges.slice(0,3).map((e,k)=>(
                    <ACircle key={'sig'+k} r={2.2} fill={lighten(e.color,0.55)}
                      opacity={sig[k].interpolate({inputRange:[0,0.12,0.88,1],outputRange:[0,1,1,0]})}
                      cx={sig[k].interpolate({inputRange:[0,0.2,0.4,0.6,0.8,1],outputRange:e.samples.px})}
                      cy={sig[k].interpolate({inputRange:[0,0.2,0.4,0.6,0.8,1],outputRange:e.samples.py})}/>
                  ))}

                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill={colors.bg} opacity={0.82}/>
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill="none" stroke={persona.color} strokeWidth={1.4}/>
                  <SvgText x={layout.cx} y={layout.cy+4} fill={persona.color} fontSize={12} fontWeight="700"
                    fontFamily={FONTS.mono} textAnchor="middle">{persona.icon}</SvgText>

                  {layout.hubs.map(h=>{
                    const dim=focus&&focus!==h.key;
                    return(
                      <SvgText key={'t'+h.key} x={h.hx} y={h.hy-h.hubRad-7} fill={dim?h.color:lighten(h.color,0.3)}
                        fontSize={8} fontFamily={FONTS.mono} textAnchor="middle" opacity={dim?0.25:0.9}>
                        {`${h.label.toUpperCase()}  ${h.count}`}
                      </SvgText>
                    );
                  })}
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
