// S.C.O.U.T.'s pipeline as an orbital field. Her orb sits at the centre; every
// lead is a dot in orbit around it, its ring set by how warm the lead is:
//
//   cold / new / untouched        -> red,   far outer ring
//   contacted (she reached out)   -> amber, mid ring
//   replied / qualifying / booked -> green, inner ring
//
// A won deal spirals into her orb and is gone; a lost one fades where it sits.
// Whenever S.C.O.U.T. touches a lead (first email, a follow-up, an advance) she
// fires a tracer from the centre to that dot. The field polls the local `leads`
// table every few seconds and animates the differences.
//
// Replaces the old "Leads" city landmark, which opened the Google Sheet.
// Pure JS: a requestAnimationFrame field sim + react-native-svg. No native
// module, so it ships as an OTA update.
import React,{useCallback,useEffect,useRef,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Image}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import Svg,{Circle,Line,G}from 'react-native-svg';
import Boundary from './hud/Boundary';
import{FONTS}from '../theme';
import{getAllLeads,getPersonaPic,getSetting}from '../services/database';

const SCOUT_BLUE='#2E86FF';
const POLL_MS=5000;
const MAX_DOTS=90;                    // most-recently-updated leads shown
const RENDER_MS=32;                   // ~30fps re-render cap (sim still steps every frame)

// stage -> ring tier. won/lost are handled as one-shot exits, not tiers.
const TIER={inbound:0,new:0,cold:0,contacted:1,replied:2,qualifying:2,call_booked:2};
const TIER_RGB=[[224,80,78],[232,184,74],[87,179,107]];   // red / amber / green
const TIER_LABEL=['cold','reached','scheduled'];
const RING_FRAC=[0.90,0.54,0.28];    // ring radius as a fraction of the field radius
const RING_BAND=[[0.80,1.00],[0.46,0.62],[0.22,0.34]];    // per-dot jitter within a ring
const ANG_VEL=[0.10,0.16,0.24];      // rad/sec — inner rings orbit faster
const TOUCH_STAGES=new Set(['contacted','replied','qualifying','call_booked']);
const STAGE_TEXT={
  inbound:'INBOUND',new:'NEW',cold:'COLD',contacted:'CONTACTED',replied:'REPLIED',
  qualifying:'QUALIFYING',call_booked:'CALL BOOKED',won:'WON',lost:'LOST',
};

const tierOf=st=>TIER[st]??0;
const lerp=(a,b,t)=>a+(b-a)*t;
const easeOut=t=>1-(1-t)*(1-t);
const rgbStr=c=>`rgb(${c[0]|0},${c[1]|0},${c[2]|0})`;
// deterministic 0..1 from an integer, so a lead's angle/direction/jitter is
// stable across polls (and across re-opening the screen).
function rand01(n){const x=Math.sin(n*127.1+11.7)*43758.5453;return x-Math.floor(x);}

function ringRadiusFrac(tier,seed){
  const[lo,hi]=RING_BAND[tier];
  return lerp(lo,hi,rand01(seed*3+tier*7));
}
function makeAngVel(tier,seed){
  const mag=ANG_VEL[tier]*(0.75+0.5*rand01(seed*5));
  return rand01(seed*7)<0.5?-mag:mag;
}

export default function LeadOrbitScreen({navigation}){
  return(
    <Boundary label="The lead field">
      <LeadOrbit navigation={navigation}/>
    </Boundary>
  );
}

function LeadOrbit({navigation}){
  const[size,setSize]=useState(null);   // {w,h} of the field area
  const[,setTick]=useState(0);          // bumped ~30fps to re-render the SVG
  const[pic,setPic]=useState(null);
  const[auto,setAuto]=useState(false);
  const[selected,setSelected]=useState(null);
  const[counts,setCounts]=useState({0:0,1:0,2:0,total:0});

  const dotsRef=useRef(new Map());      // id -> dot sim state
  const projRef=useRef([]);             // active tracers
  const seenRef=useRef(new Map());      // id -> last updated_at we processed
  const rafRef=useRef(null);
  const tPrevRef=useRef(0);
  const renderPrevRef=useRef(0);
  const runningRef=useRef(false);
  const sizeRef=useRef(null);

  useEffect(()=>{sizeRef.current=size;},[size]);
  useEffect(()=>{getPersonaPic('scout').then(p=>setPic(p||null)).catch(()=>{});},[]);

  const fireTracer=useCallback((id)=>{
    if(projRef.current.length>16)return;
    projRef.current.push({targetId:id,t:0,dur:0.55});
  },[]);

  // Fold a fresh leads snapshot into the sim: create dots for new leads, retarget
  // dots whose stage moved, and start the exit animation for won / lost / gone.
  const syncLeads=useCallback((leads)=>{
    const dots=dotsRef.current;
    const live=new Set();
    const tally={0:0,1:0,2:0,total:0};

    for(const l of leads){
      live.add(l.id);
      const stage=l.stage||'new';
      const isWon=stage==='won',isLost=stage==='lost';
      if(!isWon&&!isLost){tally[tierOf(stage)]++;tally.total++;}

      const seed=(l.id*2654435761)%2147483647;
      const tier=tierOf(stage);
      let d=dots.get(l.id);

      if(!d){
        d={
          id:l.id,seed,
          ang:rand01(seed)*Math.PI*2,
          angVel:makeAngVel(tier,seed),
          radius:1.22,                                   // fly in from just past the edge
          radiusTarget:ringRadiusFrac(tier,seed),
          color:TIER_RGB[tier].slice(),
          colorTarget:TIER_RGB[tier].slice(),
          scale:0.1,scaleTarget:1,
          bobPhase:rand01(seed*11)*Math.PI*2,bobSpeed:0.7+rand01(seed*13)*0.9,
          tier,state:'live',t:0,flash:1,
          name:l.name,business:l.business,stage,next_action:l.next_action,contact:l.contact,
        };
        dots.set(l.id,d);
      }else{
        d.name=l.name;d.business=l.business;d.stage=stage;d.next_action=l.next_action;d.contact=l.contact;
        if(isWon&&d.state!=='absorb'){d.state='absorb';d.t=0;}
        else if(isLost&&d.state!=='fade'){d.state='fade';d.t=0;}
        else if(d.state==='live'&&tier!==d.tier){
          const advanced=tier<d.tier;
          d.tier=tier;
          d.radiusTarget=ringRadiusFrac(tier,seed);
          d.colorTarget=TIER_RGB[tier].slice();
          d.angVel=makeAngVel(tier,seed);   // new ring speed, same spin direction (seed-fixed)
          if(advanced){fireTracer(l.id);d.scale=1.9;d.flash=1;}
        }
      }

      // A touch that didn't change the ring (a follow-up email) still gets a tracer.
      const prevU=seenRef.current.get(l.id);
      if(prevU!=null&&(l.updated_at||0)>prevU&&TOUCH_STAGES.has(stage)&&d.state==='live'){
        fireTracer(l.id);d.flash=1;
      }
      seenRef.current.set(l.id,l.updated_at||0);
    }

    // Leads deleted from the pipeline drift out and fade.
    for(const[id,d]of dots){
      if(!live.has(id)&&d.state==='live'){d.state='fade';d.t=0;}
    }
    setCounts(tally);
  },[fireTracer]);

  const load=useCallback(async(alive)=>{
    try{
      const l=await getAllLeads();
      if(alive())syncLeads((l||[]).slice(0,MAX_DOTS));
    }catch{}
    try{
      const a=(await getSetting('auto_scout','0'))==='1';
      if(alive())setAuto(a);
    }catch{}
  },[syncLeads]);

  // The field sim — advances every animation frame, re-renders on a ~30fps cap.
  const step=useCallback((now)=>{
    if(!runningRef.current)return;
    rafRef.current=requestAnimationFrame(step);
    const last=tPrevRef.current||now;
    tPrevRef.current=now;
    const dt=Math.min(0.05,(now-last)/1000);

    const dots=dotsRef.current;
    const dead=[];
    for(const d of dots.values()){
      d.ang+=d.angVel*dt;
      d.radius+=(d.radiusTarget-d.radius)*Math.min(1,dt*3);
      for(let i=0;i<3;i++)d.color[i]=lerp(d.color[i],d.colorTarget[i],Math.min(1,dt*2.5));
      d.scale+=(d.scaleTarget-d.scale)*Math.min(1,dt*6);
      d.flash*=Math.exp(-dt*3);
      if(d.state==='absorb'){
        d.t+=dt;
        d.radiusTarget=0;d.colorTarget=[46,134,255];d.scaleTarget=0;
        d.angVel*=1+dt*1.6;                              // whip inward
        if(d.t>1.0)dead.push(d.id);
      }else if(d.state==='fade'){
        d.t+=dt;d.scaleTarget=0;
        if(d.t>0.7)dead.push(d.id);
      }
    }
    for(const id of dead){dots.delete(id);}

    const pr=projRef.current;
    for(let i=pr.length-1;i>=0;i--){
      pr[i].t+=dt;
      if(pr[i].t>=pr[i].dur){
        const d=dots.get(pr[i].targetId);
        if(d)d.flash=1;
        pr.splice(i,1);
      }
    }

    if(now-renderPrevRef.current>=RENDER_MS){
      renderPrevRef.current=now;
      setTick(t=>(t+1)&0xffff);
    }
  },[]);

  useFocusEffect(useCallback(()=>{
    let mounted=true;
    const alive=()=>mounted;
    load(alive);
    const iv=setInterval(()=>load(alive),POLL_MS);
    runningRef.current=true;
    tPrevRef.current=0;renderPrevRef.current=0;
    rafRef.current=requestAnimationFrame(step);
    return()=>{
      mounted=false;
      clearInterval(iv);
      runningRef.current=false;
      if(rafRef.current)cancelAnimationFrame(rafRef.current);
    };
  },[load,step]));

  // Re-fold the current leads once we know the field size (dots need it to exist,
  // though their stored radii are size-independent fractions).
  useEffect(()=>{if(size)load(()=>true);},[size]);// eslint-disable-line react-hooks/exhaustive-deps

  const onFieldLayout=useCallback((e)=>{
    const{width,height}=e.nativeEvent.layout;
    setSize(prev=>(prev&&prev.w===width&&prev.h===height)?prev:{w:width,h:height});
  },[]);

  const geom=size?fieldGeom(size):null;

  const dotPos=useCallback((d,g,nowMs)=>{
    const bob=0.014*Math.sin(nowMs*0.001*d.bobSpeed+d.bobPhase);
    const rr=g.maxR*Math.max(0,d.radius+bob);
    return{x:g.cx+rr*Math.cos(d.ang),y:g.cy+rr*Math.sin(d.ang)};
  },[]);

  const onFieldPress=useCallback((e)=>{
    if(!geom)return;
    const{locationX,locationY}=e.nativeEvent;
    const nowMs=Date.now();
    let hit=null,best=22;
    for(const d of dotsRef.current.values()){
      if(d.state!=='live')continue;
      const{x,y}=dotPos(d,geom,nowMs);
      const dist=Math.hypot(x-locationX,y-locationY);
      if(dist<best){best=dist;hit=d;}
    }
    setSelected(hit?{
      id:hit.id,name:hit.name,business:hit.business,stage:hit.stage,
      next_action:hit.next_action,contact:hit.contact,
    }:null);
  },[geom,dotPos]);

  const nowMs=Date.now();

  return(
    <SafeAreaView style={s.safe} edges={['top','bottom']}>
      <View style={s.header}>
        <TouchableOpacity onPress={()=>navigation.navigate('Map')} hitSlop={{top:12,bottom:12,left:12,right:12}} activeOpacity={0.7}>
          <Text style={s.back}>‹ MAP</Text>
        </TouchableOpacity>
        <View style={s.headTitleWrap}>
          <Text style={s.title}>S.C.O.U.T. · PIPELINE</Text>
          <Text style={s.sub}>
            {counts[0]} cold · {counts[1]} reached · {counts[2]} scheduled{auto?'   ·   AUTO':''}
          </Text>
        </View>
        <View style={{width:44}}/>
      </View>

      <View style={s.legend}>
        {[0,1,2].map(i=>(
          <View key={i} style={s.legendItem}>
            <View style={[s.legendDot,{backgroundColor:rgbStr(TIER_RGB[i])}]}/>
            <Text style={s.legendText}>{TIER_LABEL[i]}</Text>
          </View>
        ))}
      </View>

      <View style={s.field} onLayout={onFieldLayout}>
        {geom&&(
          <>
            <Svg width={size.w} height={size.h}>
              {/* ring guides */}
              {[0,1,2].map(i=>(
                <Circle key={i} cx={geom.cx} cy={geom.cy} r={geom.maxR*RING_FRAC[i]}
                  stroke={rgbStr(TIER_RGB[i])} strokeOpacity={0.10} strokeWidth={1}
                  strokeDasharray="2 7" fill="none"/>
              ))}

              {/* S.C.O.U.T. at the centre */}
              <Circle cx={geom.cx} cy={geom.cy} r={44} fill={SCOUT_BLUE} fillOpacity={0.07}/>
              <Circle cx={geom.cx} cy={geom.cy} r={28} fill={SCOUT_BLUE} fillOpacity={0.13}/>
              {!pic&&<Circle cx={geom.cx} cy={geom.cy} r={13} fill={SCOUT_BLUE} fillOpacity={0.95}/>}
              <Circle cx={geom.cx} cy={geom.cy} r={pic?21:15} stroke={SCOUT_BLUE} strokeOpacity={0.6} strokeWidth={1.5} fill="none"/>

              {/* tracers — centre to the dot she's working */}
              {projRef.current.map((p,idx)=>{
                const d=dotsRef.current.get(p.targetId);
                if(!d)return null;
                const{x,y}=dotPos(d,geom,nowMs);
                const k=easeOut(Math.min(1,p.t/p.dur));
                const hx=lerp(geom.cx,x,k),hy=lerp(geom.cy,y,k);
                const tk=Math.max(0,k-0.22);
                const tx=lerp(geom.cx,x,tk),ty=lerp(geom.cy,y,tk);
                return(
                  <G key={idx}>
                    <Line x1={tx} y1={ty} x2={hx} y2={hy} stroke={SCOUT_BLUE} strokeWidth={2} strokeOpacity={0.85}/>
                    <Circle cx={hx} cy={hy} r={3.2} fill="#CFE7FF"/>
                  </G>
                );
              })}

              {/* lead dots */}
              {[...dotsRef.current.values()].map(d=>{
                const{x,y}=dotPos(d,geom,nowMs);
                const r=Math.max(0.1,2.7*d.scale);
                const col=rgbStr(d.color);
                const isSel=selected&&selected.id===d.id;
                return(
                  <G key={d.id}>
                    {d.flash>0.04&&(
                      <Circle cx={x} cy={y} r={r+3+7*d.flash} fill={col} fillOpacity={0.16*d.flash}/>
                    )}
                    {isSel&&<Circle cx={x} cy={y} r={r+6} stroke="#F3E3BE" strokeOpacity={0.9} strokeWidth={1} fill="none"/>}
                    <Circle cx={x} cy={y} r={r} fill={col} fillOpacity={0.92}/>
                  </G>
                );
              })}
            </Svg>

            {pic&&(
              <Image source={{uri:pic}} style={[s.face,{left:geom.cx-19,top:geom.cy-19}]}/>
            )}

            {/* transparent hit layer for tapping a dot */}
            <View style={StyleSheet.absoluteFill}
              onStartShouldSetResponder={()=>true}
              onResponderRelease={onFieldPress}/>

            {counts.total===0&&(
              <View style={s.emptyWrap} pointerEvents="none">
                <Text style={s.emptyText}>NO LEADS YET</Text>
                <Text style={s.emptySub}>S.C.O.U.T. hasn't added anyone to the pipeline</Text>
              </View>
            )}
          </>
        )}
      </View>

      {selected&&(
        <View style={s.card}>
          <View style={s.cardTop}>
            <Text style={s.cardStage}>{STAGE_TEXT[selected.stage]||String(selected.stage||'').toUpperCase()}</Text>
            <TouchableOpacity onPress={()=>setSelected(null)} hitSlop={{top:10,bottom:10,left:10,right:10}}>
              <Text style={s.cardX}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.cardName} numberOfLines={1}>{selected.name||'—'}</Text>
          {!!selected.business&&<Text style={s.cardBiz} numberOfLines={1}>{selected.business}</Text>}
          <Text style={s.cardMeta} numberOfLines={1}>{selected.contact||'needs contact'}</Text>
          {!!selected.next_action&&<Text style={s.cardNext} numberOfLines={2}>→ {selected.next_action}</Text>}
        </View>
      )}
    </SafeAreaView>
  );
}

// Field centre + radius from the laid-out area. maxR leaves headroom for the
// outer dot band (up to 1.0 of maxR) plus its flash halo.
function fieldGeom({w,h}){
  return{cx:w/2,cy:h/2,maxR:Math.min(w,h)/2*0.84};
}

const s=StyleSheet.create({
  safe:{flex:1,backgroundColor:'#000'},
  header:{flexDirection:'row',alignItems:'center',paddingHorizontal:14,paddingTop:6,paddingBottom:4},
  back:{fontFamily:FONTS.mono,fontSize:10,color:'#7fa8c9',letterSpacing:2,width:44},
  headTitleWrap:{flex:1,alignItems:'center'},
  title:{fontFamily:FONTS.mono,fontSize:11,color:'#C9BEA6',letterSpacing:3},
  sub:{fontFamily:FONTS.mono,fontSize:8,color:'#6a6250',letterSpacing:1,marginTop:2},
  legend:{flexDirection:'row',justifyContent:'center',gap:18,paddingVertical:6},
  legendItem:{flexDirection:'row',alignItems:'center',gap:5},
  legendDot:{width:7,height:7,borderRadius:4},
  legendText:{fontFamily:FONTS.mono,fontSize:8,color:'#8a8069',letterSpacing:1},
  field:{flex:1,position:'relative'},
  face:{position:'absolute',width:38,height:38,borderRadius:19},
  emptyWrap:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center',gap:6},
  emptyText:{fontFamily:FONTS.mono,fontSize:11,color:'#5a5145',letterSpacing:3},
  emptySub:{fontFamily:FONTS.mono,fontSize:8,color:'#3f3a30',letterSpacing:1},
  card:{position:'absolute',left:14,right:14,bottom:16,backgroundColor:'#0A0907',borderWidth:1,borderColor:'#1F1B14',borderRadius:8,padding:12,gap:3},
  cardTop:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},
  cardStage:{fontFamily:FONTS.mono,fontSize:8,color:'#7fa8c9',letterSpacing:2,fontWeight:'700'},
  cardX:{fontFamily:FONTS.mono,fontSize:11,color:'#5a5145'},
  cardName:{fontFamily:FONTS.mono,fontSize:12,color:'#C9BEA6'},
  cardBiz:{fontFamily:FONTS.mono,fontSize:9,color:'#8a8069'},
  cardMeta:{fontFamily:FONTS.mono,fontSize:8,color:'#6a6250',marginTop:1},
  cardNext:{fontFamily:FONTS.mono,fontSize:9,color:'#7fa8c9',marginTop:3},
});
