// The orb screen as one continuous zoom:
//   persona sphere  ->  the persona you zoomed into  ->  its memory spiral  ->  a memory
// Pinch out drills in toward wherever your fingers are; pinch in backs out.
// Each level change animates. The + / - buttons and the mouse wheel (web) do the
// same. `level` is owned by the parent so it survives the viz/chat toggle.
//
// Built entirely on React Native's own Animated + PanResponder — no reanimated
// worklets, which is what hard-crashed the earlier 3D version.
import React,{useState,useEffect,useMemo,useCallback,useRef,useImperativeHandle,forwardRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ActivityIndicator,Dimensions,Platform,Animated,PanResponder,Image,Easing,ScrollView}from 'react-native';
import Svg,{Line}from 'react-native-svg';
import PersonaOrb from './PersonaOrb';
import SphereBackdrop from './SphereBackdrop';
import MemorySpiral from './MemorySpiral';
import MemoryPopup from './MemoryPopup';
import Boundary from '../hud/Boundary';
import{getMemoriesByPersona,deletePersonaMemory}from '../../services/database';
import{getPersona,PERSONA_LIST}from '../../personas/personas';

const LEVELS=['group','orb','memory'];
const WHEEL_MID=1200;// px of scroll slack each side of the wheel-catcher — big enough one fast notch can't reach an edge

const SAMP=[],SIN=[],COS=[];
for(let k=0;k<=480;k++){const v=-12*Math.PI+(24*Math.PI)*(k/480);SAMP.push(v);SIN.push(Math.sin(v));COS.push(Math.cos(v));}

// Personas scattered through a wide 3D volume (not a sphere shell). A.R.A. and
// J.A.R.V.I.S. get fixed, symmetric front-row seats — the two you land on —
// everyone else is seeded further back so they're visible-but-small in the
// background until you dolly forward. The "everyone else" layout is seeded so
// it's stable across a session; a light min-distance pass keeps them from
// clumping. You yaw the cloud and fly forward/back through it.
// Front pair sits a touch off-level from each other (not perfectly mirrored)
// so they read as two individuals side by side rather than a symmetric icon.
const FRONT_Z=-2.6, FRONT_X=0.95, FRONT_Y=0.35;
const SCATTER=(()=>{
  let a=0x9e3779b9;
  const rnd=()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
  const pts=new Array(PERSONA_LIST.length);
  const fixed=[];
  PERSONA_LIST.forEach((p,i)=>{
    if(p.id==='ara'){pts[i]={x:-FRONT_X,y:FRONT_Y,z:FRONT_Z};fixed.push(pts[i]);}
    else if(p.id==='jarvis'){pts[i]={x:FRONT_X,y:-FRONT_Y,z:FRONT_Z};fixed.push(pts[i]);}
  });
  for(let i=0;i<PERSONA_LIST.length;i++){
    if(pts[i])continue;
    let best=null,bestD=-1;
    for(let tries=0;tries<14;tries++){
      const c={x:(rnd()*2-1)*3.6,y:(rnd()*2-1)*2.7,z:0.6+rnd()*3.8};
      let d=99;
      for(const p of pts)if(p)d=Math.min(d,Math.hypot(p.x-c.x,p.y-c.y,p.z-c.z));
      for(const p of fixed)d=Math.min(d,Math.hypot(p.x-c.x,p.y-c.y,p.z-c.z));
      if(d>bestD){bestD=d;best=c;}
    }
    pts[i]=best;
  }
  return pts;
})();
const Z_SPAN=4.4;     // half-depth of the cloud; dolly ranges ±(Z_SPAN+2)

// Org-chart tethers drawn between orbs. Talon and Rogue report through their
// department head (Atlas = finance, Selene = content) rather than straight to
// A.R.A. — everyone else routes through A.R.A. directly. Nothing else is
// tethered; the rest of the cloud just floats.
const SECONDARY_HEAD={talon:'atlas',rogue:'selene'};
const TETHERS=(()=>{
  const pairs=[['atlas','talon'],['selene','rogue']];
  for(const p of PERSONA_LIST){
    if(p.id==='ara'||SECONDARY_HEAD[p.id])continue;
    pairs.push(['ara',p.id]);
  }
  return pairs;
})();
const ID_INDEX={};
PERSONA_LIST.forEach((p,i)=>{ID_INDEX[p.id]=i;});

// Mirrors the orb opacity-by-depth curve used below, as a plain function —
// needed to fade tether lines the same way without going through Animated.
function depthOpacity(depth){
  const pts=[[0.15,0],[1.5,1],[7,0.6],[13,0.1]];
  if(depth<=pts[0][0])return pts[0][1];
  for(let i=1;i<pts.length;i++){
    if(depth<=pts[i][0]){
      const[d0,o0]=pts[i-1],[d1,o1]=pts[i];
      return o0+(o1-o0)*(depth-d0)/(d1-d0);
    }
  }
  return pts[pts.length-1][1];
}

function touchDist(t){return Math.hypot(t[0].pageX-t[1].pageX,t[0].pageY-t[1].pageY);}

function OrbZoom({personaId,color,active,vizRef,personaPics={},unreadPersonas,onPickPersona,onLaunchGroup,onZoomOut,level='group',onLevelChange},ref){
  const persona=getPersona(personaId);
  // Manually dragged orb positions — lifted up here (rather than living inside
  // PersonaSphereInner) so they survive zooming into a persona and back out,
  // not just re-renders of the cloud itself. Reset when OrbZoom unmounts.
  const[pinned,setPinned]=useState({});
  const[memories,setMemories]=useState(null);
  const[memory,setMemory]=useState(null);
  const[undo,setUndo]=useState(null);
  const undoTimer=useRef(null);
  const pendingRef=useRef(null);
  const didMount=useRef(false);
  const wrapRef=useRef(null);
  const wheelAcc=useRef(0);
  const wheelScrollRef=useRef(null);
  const wheelY=useRef(0);
  const pinchRef=useRef({d0:0,d1:0});
  const memRef=useRef(null);
  const sphereRef=useRef(null);
  const levelRef=useRef(level);
  const dirRef=useRef(1);
  const originRef=useRef({x:0,y:0});
  const sizeRef=useRef({w:Dimensions.get('window').width,h:Dimensions.get('window').height});
  const centroidRef=useRef(null);
  const pinchScale=useRef(new Animated.Value(1)).current;
  const pinchTX=useRef(new Animated.Value(0)).current;
  const pinchTY=useRef(new Animated.Value(0)).current;
  const enter=useRef(new Animated.Value(1)).current;

  useEffect(()=>{levelRef.current=level;},[level]);

  const setLvl=useCallback((l,dir)=>{
    dirRef.current=dir||1;
    if(l!==levelRef.current)onLevelChange?.(l);
  },[onLevelChange]);

  useEffect(()=>{
    pinchScale.setValue(1);pinchTX.setValue(0);pinchTY.setValue(0);
    enter.setValue(0);
    Animated.timing(enter,{toValue:1,duration:300,easing:Easing.out(Easing.cubic),useNativeDriver:false}).start();
  },[level]);// eslint-disable-line react-hooks/exhaustive-deps

  const morph=useMemo(()=>{
    const from=dirRef.current>0?0.5:1.6;
    return{
      opacity:enter.interpolate({inputRange:[0,1],outputRange:[0.12,1]}),
      scale:enter.interpolate({inputRange:[0,1],outputRange:[from,1]}),
    };
  },[level]);// eslint-disable-line react-hooks/exhaustive-deps
  const contentScale=useMemo(()=>Animated.multiply(pinchScale,morph.scale),[morph]);// eslint-disable-line react-hooks/exhaustive-deps

  const reload=useCallback(()=>{getMemoriesByPersona(personaId).then(m=>setMemories(m||[])).catch(()=>setMemories([]));},[personaId]);
  useEffect(()=>{
    if(didMount.current){setLvl('orb',1);setMemory(null);}
    didMount.current=true;
    setMemories(null);reload();
  },[personaId,reload]);// eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{if(level==='memory')reload();},[level,reload]);
  useEffect(()=>()=>{
    if(undoTimer.current){clearTimeout(undoTimer.current);if(pendingRef.current)deletePersonaMemory(pendingRef.current.id).catch(()=>{});}
  },[]);

  const pick=useCallback((id)=>{onPickPersona?.(id);setLvl('orb',1);},[onPickPersona,setLvl]);
  const launch=useCallback((ids)=>{onLaunchGroup?.(ids);},[onLaunchGroup]);

  const deeper=useCallback((centroid)=>{
    const cur=levelRef.current;
    const c=(centroid&&typeof centroid.x==='number')?centroid:null;
    if(cur==='group'){
      const id=(sphereRef.current&&sphereRef.current.pickAt(c?c.x:null,c?c.y:null))||PERSONA_LIST[0].id;
      pick(id);return;
    }
    if(cur==='orb'){setLvl('memory',1);return;}
    if(cur==='memory'){memRef.current&&memRef.current.drillIn(c);return;}
  },[pick,setLvl]);

  const shallower=useCallback(()=>{
    const cur=levelRef.current;
    if(cur==='memory'){
      if(memRef.current&&memRef.current.drillOut())return;
      setLvl('orb',-1);return;
    }
    if(cur==='orb'){setLvl('group',-1);return;}
    if(cur==='group'){onZoomOut?.();return;} // zoom out past the sphere -> the city
  },[setLvl,onZoomOut]);

  // Step back one zoom level (memory -> orb -> the persona sphere). Returns true
  // if it consumed the back action, false when already at the sphere so the
  // header's back button can leave for the city.
  const back=useCallback(()=>{
    const cur=levelRef.current;
    if(cur==='memory'){
      if(memRef.current&&memRef.current.drillOut())return true;
      setLvl('orb',-1);return true;
    }
    if(cur==='orb'){setLvl('group',-1);return true;}
    return false;
  },[setLvl]);
  useImperativeHandle(ref,()=>({back}),[back]);

  const stagePan=useMemo(()=>PanResponder.create({
    // Capture two-finger pinches at every level. On group/orb it's a discrete
    // "drill in / out"; on the memory spiral it's driven straight into the
    // spiral's own smooth zoom (the SVG layer there was swallowing the gesture).
    onStartShouldSetPanResponderCapture:(e)=>!!e.nativeEvent.touches&&e.nativeEvent.touches.length===2,
    onMoveShouldSetPanResponderCapture:(e)=>!!e.nativeEvent.touches&&e.nativeEvent.touches.length===2,
    onPanResponderGrant:(e)=>{
      const t=e.nativeEvent.touches;
      if(t&&t.length===2){
        const d=touchDist(t);
        const pcx=(t[0].pageX+t[1].pageX)/2, pcy=(t[0].pageY+t[1].pageY)/2;
        pinchRef.current={d0:d,d1:d,mem:levelRef.current==='memory'};
        pinchScale.stopAnimation();pinchTX.stopAnimation();pinchTY.stopAnimation();
        centroidRef.current={x:pcx-originRef.current.x,y:pcy-originRef.current.y};
        if(pinchRef.current.mem)memRef.current&&memRef.current.pinchStart(pcx,pcy);
      }
    },
    onPanResponderMove:(e)=>{
      const t=e.nativeEvent.touches;
      if(!(t&&t.length===2))return;
      pinchRef.current.d1=touchDist(t);
      if(pinchRef.current.mem){
        const pcx=(t[0].pageX+t[1].pageX)/2, pcy=(t[0].pageY+t[1].pageY)/2;
        memRef.current&&memRef.current.pinchMove(pinchRef.current.d1/pinchRef.current.d0,pcx,pcy);
        return;
      }
      const sc=Math.max(0.55,Math.min(1.8,pinchRef.current.d1/pinchRef.current.d0));
      pinchScale.setValue(sc);
      const c=centroidRef.current||{x:0,y:0};
      pinchTX.setValue((c.x-sizeRef.current.w/2)*(1-sc));
      pinchTY.setValue((c.y-sizeRef.current.h/2)*(1-sc));
    },
    onPanResponderRelease:()=>{
      const{d0,d1,mem}=pinchRef.current;
      pinchRef.current={d0:0,d1:0};
      if(mem){memRef.current&&memRef.current.pinchEnd();return;}
      const r=(d0>0&&d1>0)?d1/d0:1;
      // Getting from the persona sphere into an orb takes a lighter pinch than
      // the other level changes.
      const inAt=levelRef.current==='group'?1.10:1.20;
      if(r>inAt){deeper(centroidRef.current);}
      else if(r<0.83){shallower();}
      else{
        Animated.spring(pinchScale,{toValue:1,useNativeDriver:false}).start();
        Animated.spring(pinchTX,{toValue:0,useNativeDriver:false}).start();
        Animated.spring(pinchTY,{toValue:0,useNativeDriver:false}).start();
      }
    },
    onPanResponderTerminationRequest:()=>false,
  }),[deeper,shallower]);

  useEffect(()=>{
    if(Platform.OS!=='web')return;
    const node=wrapRef.current;
    if(!node||!node.addEventListener)return;
    const onWheel=(e)=>{
      if(e.preventDefault)e.preventDefault();
      wheelAcc.current+=e.deltaY;
      if(wheelAcc.current<-140){wheelAcc.current=0;deeper();}
      else if(wheelAcc.current>140){wheelAcc.current=0;shallower();}
    };
    node.addEventListener('wheel',onWheel,{passive:false});
    return()=>node.removeEventListener('wheel',onWheel);
  },[deeper,shallower]);

  // Android (Samsung DeX / any attached mouse): RN has no `wheel` event on a
  // plain View, but a ScrollView still scrolls from mouse-wheel ACTION_SCROLL
  // motion events. We park an invisible full-bleed ScrollView *behind* the
  // content (wheel events fall through to it since nothing in front consumes
  // them), read its scroll delta, and turn each notch into a level change —
  // then snap it back to the middle so there's always slack both ways.
  const recenterWheel=useCallback(()=>{
    wheelAcc.current=0;wheelY.current=WHEEL_MID;
    requestAnimationFrame(()=>wheelScrollRef.current&&wheelScrollRef.current.scrollTo({y:WHEEL_MID,animated:false}));
  },[]);
  const onWheelScroll=useCallback((e)=>{
    const y=e.nativeEvent.contentOffset.y;
    const dy=y-wheelY.current;
    wheelY.current=y;
    if(!dy)return;
    wheelAcc.current+=dy;
    if(wheelAcc.current<-90){deeper();recenterWheel();}
    else if(wheelAcc.current>90){shallower();recenterWheel();}
    // keep the catcher near the middle even between level changes, so a fast
    // spin can't park it against a content edge where it stops reporting delta
    else if(Math.abs(y-WHEEL_MID)>500)recenterWheel();
  },[deeper,shallower,recenterWheel]);

  function removeMemory(mem){
    if(!mem)return;
    if(pendingRef.current){clearTimeout(undoTimer.current);deletePersonaMemory(pendingRef.current.id).catch(()=>{});}
    setMemories(prev=>(prev||[]).filter(m=>m.id!==mem.id));
    pendingRef.current=mem;
    setUndo({mem});
    undoTimer.current=setTimeout(()=>{deletePersonaMemory(mem.id).catch(()=>{});pendingRef.current=null;setUndo(null);undoTimer.current=null;},4500);
  }
  function undoMemory(){
    if(!undo)return;
    if(undoTimer.current){clearTimeout(undoTimer.current);undoTimer.current=null;}
    pendingRef.current=null;
    setMemories(prev=>[undo.mem,...(prev||[])].sort((a,b)=>(b.created_at||0)-(a.created_at||0)));
    setUndo(null);
  }

  const idx=LEVELS.indexOf(level);

  return(
    <View ref={wrapRef} style={s.wrap} {...stagePan.panHandlers}
      onLayout={()=>{wrapRef.current&&wrapRef.current.measureInWindow&&wrapRef.current.measureInWindow((x,y,w,h)=>{
        originRef.current={x:x||0,y:y||0};if(w&&h)sizeRef.current={w,h};
      });}}>
      {Platform.OS==='android'&&(
        <ScrollView ref={wheelScrollRef} style={StyleSheet.absoluteFill}
          contentContainerStyle={{height:WHEEL_MID*2+Dimensions.get('window').height}}
          showsVerticalScrollIndicator={false} scrollEventThrottle={1}
          contentOffset={{x:0,y:WHEEL_MID}} onScroll={onWheelScroll}
          onContentSizeChange={()=>{wheelY.current=WHEEL_MID;wheelScrollRef.current&&wheelScrollRef.current.scrollTo({y:WHEEL_MID,animated:false});}}/>
      )}
      {level==='group'&&<SphereBackdrop/>}
      <Animated.View style={{flex:1,opacity:morph.opacity,transform:[{translateX:pinchTX},{translateY:pinchTY},{scale:contentScale}]}}>
        {level==='group'&&(
          <Boundary label="The persona sphere">
            <PersonaSphere ref={sphereRef} activeId={personaId} pics={personaPics} unreadPersonas={unreadPersonas} onPick={pick} onLaunch={launch} pinned={pinned} setPinned={setPinned}/>
          </Boundary>
        )}
        {level==='orb'&&(
          <Boundary label="The visualization"><PersonaOrb viz={vizRef} color={color} active={active}/></Boundary>
        )}
        {level==='memory'&&(
          <Boundary label="The memory spiral">
            <MemorySpiral ref={memRef} persona={persona} memories={memories}
              onNode={m=>setMemory(m)} onExit={()=>setLvl('orb',-1)}/>
          </Boundary>
        )}
      </Animated.View>

      {memories===null&&level==='memory'&&<View style={s.loading}><ActivityIndicator color={color}/></View>}

      <View style={s.rail} pointerEvents="none">
        <Text style={[s.railLabel,{color}]}>
          {level==='group'?'':persona.name}
        </Text>
        <View style={s.dots}>
          {LEVELS.map((l,i)=>(<View key={l} style={[s.dot,i<=idx&&{backgroundColor:color,opacity:i===idx?1:0.4}]}/>))}
        </View>
      </View>

      <View style={s.zoomCtl} pointerEvents="box-none">
        <TouchableOpacity style={s.zBtn} onPress={()=>shallower()}><Text style={s.zT}>−</Text></TouchableOpacity>
        <TouchableOpacity style={s.zBtn} onPress={()=>deeper()}><Text style={s.zT}>+</Text></TouchableOpacity>
      </View>


      {undo&&<TouchableOpacity style={s.undoBar} activeOpacity={0.8} onPress={undoMemory}>
        <Text style={s.undoT}>Memory deleted</Text>
        <Text style={s.undoAction}>UNDO</Text>
      </TouchableOpacity>}

      {memory&&<MemoryPopup memory={memory} onClose={()=>setMemory(null)} onDelete={m=>removeMemory(m)}/>}
    </View>
  );
}

// --- The persona cloud -----------------------------------------------------
// Personas scattered through a 3D volume. One-finger drag: left/right yaws the
// whole cloud, up/down flies you forward / back THROUGH it (dolly). Perspective
// spread + depth fade sell the movement; nearest-in-front is what a tap or a
// pinch-in selects.

function PersonaSphereInner({activeId,pics,unreadPersonas,onPick,onLaunch,pinned,setPinned},ref){
  const[size,setSize]=useState({w:Dimensions.get('window').width,h:340});
  const[group,setGroup]=useState([]);
  const[order,setOrder]=useState(()=>PERSONA_LIST.map((_,i)=>i));
  const[tethers,setTethers]=useState([]);
  const boxRef=useRef(null);
  const originRef=useRef({x:0,y:0});    // this view's on-screen origin, for turning a raw touch page-position into a local one
  const pinnedRef=useRef(pinned);
  useEffect(()=>{pinnedRef.current=pinned;},[pinned]);
  const yaw=useRef(new Animated.Value(0)).current;        // 0 = dead ahead, so the front pair sits exactly left/right of center
  const dolly=useRef(new Animated.Value(-4.2)).current;   // start outside, cloud ahead
  const yStart=useRef(0),dStart=useRef(-4.2);
  const yawNow=useRef(0),dollyNow=useRef(-4.2);
  const glowPulse=useRef(new Animated.Value(0)).current;
  const sizeRef=useRef(size);
  const sparkles=useRef(PERSONA_LIST.map(()=>new Animated.Value(Math.random()))).current;
  // Idle drift — a slow, independent bob per orb so the cloud feels alive
  // rather than a static snapshot. Phase/duration staggered per persona.
  const floats=useRef(PERSONA_LIST.map(()=>new Animated.Value(Math.random()))).current;

  useEffect(()=>{sizeRef.current=size;},[size]);

  const RX=Math.min(size.w,560)*0.12;
  const RY=Math.min(size.h,size.w,560)*0.11;

  // depth of persona i in front of the viewer, given current yaw + dolly
  const depthOf=useCallback((i,yv,dv)=>{
    const pt=SCATTER[i];
    const z1=-pt.x*Math.sin(yv)+pt.z*Math.cos(yv);
    return z1-dv;
  },[]);

  // Screen position + depth for persona i — same projection pickAt uses below,
  // shared here so tether lines land exactly on the orbs they connect.
  const project=useCallback((i,yv,dv)=>{
    const pt=SCATTER[i];
    const cyN=Math.cos(yv),syN=Math.sin(yv);
    const x1=cyN*pt.x+syN*pt.z;
    const depth=(-pt.x*syN+pt.z*cyN)-dv;
    const denom=Math.max(0.4,1.0+depth*0.14);
    const cx=sizeRef.current.w/2,cy=sizeRef.current.h*0.42;
    return{x:cx+(x1*RX)/denom,y:cy+(pt.y*RY)/denom,depth};
  },[RX,RY]);

  // A pinned orb's endpoint for tether purposes: its fixed screen position,
  // reported at a mid-range depth so its lines fade the same as anything else
  // in easy view (pinned orbs are deliberately decoupled from the camera).
  const endpointFor=useCallback((id,yv,dv)=>{
    const pin=pinnedRef.current[id];
    if(pin)return{x:sizeRef.current.w/2+pin.tx,y:sizeRef.current.h*0.42+pin.ty,depth:2};
    return project(ID_INDEX[id],yv,dv);
  },[project]);

  const computeTethers=useCallback(()=>{
    const yv=yawNow.current,dv=dollyNow.current;
    setTethers(TETHERS.map(([a,b])=>{
      const pa=endpointFor(a,yv,dv),pb=endpointFor(b,yv,dv);
      const vis=pa.depth>0.35&&pb.depth>0.35;
      return{key:a+'-'+b,x1:pa.x,y1:pa.y,x2:pb.x,y2:pb.y,
        opacity:vis?Math.min(depthOpacity(pa.depth),depthOpacity(pb.depth))*0.55:0};
    }));
  },[endpointFor]);

  useEffect(()=>{
    let last=0;
    const sortNow=()=>{
      const yv=yawNow.current,dv=dollyNow.current;
      setOrder(PERSONA_LIST.map((_,i)=>i).sort((a,b)=>depthOf(b,yv,dv)-depthOf(a,yv,dv))); // far first
      computeTethers();
    };
    const recompute=()=>{const now=Date.now();if(now-last<120)return;last=now;sortNow();};
    sortNow();                                        // initial depth order
    const idY=yaw.addListener(e=>{yawNow.current=e.value;recompute();});
    const idD=dolly.addListener(e=>{dollyNow.current=e.value;recompute();});
    return()=>{yaw.removeListener(idY);dolly.removeListener(idD);};
  },[depthOf,computeTethers]);// eslint-disable-line react-hooks/exhaustive-deps

  // Slow pulse on the ring shown around an orb held into a custom group.
  useEffect(()=>{
    const loop=Animated.loop(Animated.sequence([
      Animated.timing(glowPulse,{toValue:1,duration:700,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
      Animated.timing(glowPulse,{toValue:0,duration:700,easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
    ]));
    loop.start();
    return()=>loop.stop();
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{
    const loops=sparkles.map((v,i)=>Animated.loop(Animated.sequence([
      Animated.delay(i*160),
      Animated.timing(v,{toValue:1,duration:900+((i*137)%700),easing:Easing.inOut(Easing.sin),useNativeDriver:false}),
      Animated.timing(v,{toValue:0,duration:900+((i*211)%700),easing:Easing.inOut(Easing.sin),useNativeDriver:false}),
    ])));
    loops.forEach(l=>l.start());
    return()=>loops.forEach(l=>l.stop());
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{
    // Same as sparkles below: this gets combined (Animated.add) with the
    // fundamentally JS-driven yaw/dolly position math, so it must run
    // JS-driven too — native-driven here throws "Attempting to run JS driven
    // animation on animated node that has been moved to 'native'".
    const loops=floats.map((v,i)=>Animated.loop(Animated.sequence([
      Animated.delay((i*233)%1100),
      Animated.timing(v,{toValue:1,duration:2400+((i*173)%1600),easing:Easing.inOut(Easing.sin),useNativeDriver:false}),
      Animated.timing(v,{toValue:0,duration:2400+((i*197)%1600),easing:Easing.inOut(Easing.sin),useNativeDriver:false}),
    ])));
    loops.forEach(l=>l.start());
    return()=>loops.forEach(l=>l.stop());
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  // pickAt(x,y): the persona nearest that screen point (in front of the viewer),
  // or the nearest one straight ahead when no point is given.
  useImperativeHandle(ref,()=>({
    pickAt(x,y){
      const yv=yawNow.current,dv=dollyNow.current;
      const cyN=Math.cos(yv),syN=Math.sin(yv);
      const cx=sizeRef.current.w/2,cy=sizeRef.current.h*0.42;
      let best=PERSONA_LIST[0].id,score=-Infinity;
      for(let i=0;i<PERSONA_LIST.length;i++){
        const pt=SCATTER[i];
        const x1=cyN*pt.x+syN*pt.z;
        const depth=(-pt.x*syN+pt.z*cyN)-dv;
        if(depth<0.35)continue;                       // behind, or passing through
        const denom=Math.max(0.4,1.0+depth*0.14);
        const sx=cx+(x1*RX)/denom,sy=cy+(pt.y*RY)/denom;
        const sc=x==null?-depth:(-depth*40-Math.hypot(sx-x,sy-y));
        if(sc>score){score=sc;best=PERSONA_LIST[i].id;}
      }
      return best;
    },
  }),[RX,RY]);

  const pan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponder:()=>false,
    onMoveShouldSetPanResponder:(e,g)=>(!e.nativeEvent.touches||e.nativeEvent.touches.length<2)&&(Math.abs(g.dx)>6||Math.abs(g.dy)>6),
    onPanResponderGrant:()=>{
      yaw.stopAnimation(v=>{yStart.current=v;});
      dolly.stopAnimation(v=>{dStart.current=v;});
    },
    onPanResponderMove:(_,g)=>{
      yaw.setValue(yStart.current-g.dx*0.008);
      dolly.setValue(Math.max(-(Z_SPAN+2),Math.min(Z_SPAN+2,dStart.current-g.dy*0.011))); // drag up = fly forward
    },
    onPanResponderRelease:(_,g)=>{
      Animated.decay(yaw,{velocity:-g.vx*0.008,deceleration:0.996,useNativeDriver:false}).start();
    },
  }),[]);// eslint-disable-line react-hooks/exhaustive-deps

  const orbs=useMemo(()=>{
    const cosY=yaw.interpolate({inputRange:SAMP,outputRange:COS,extrapolate:'clamp'});
    const sinY=yaw.interpolate({inputRange:SAMP,outputRange:SIN,extrapolate:'clamp'});
    return PERSONA_LIST.map((p,i)=>{
      const pt=SCATTER[i];
      const x1=Animated.add(Animated.multiply(cosY,pt.x),Animated.multiply(sinY,pt.z));
      const z1=Animated.add(Animated.multiply(-pt.x,sinY),Animated.multiply(pt.z,cosY));
      const depth=Animated.subtract(z1,dolly);
      const denom=Animated.add(1.0,Animated.multiply(depth,0.14))
        .interpolate({inputRange:[0.4,20],outputRange:[0.4,20],extrapolate:'clamp'});
      const bobX=floats[i].interpolate({inputRange:[0,1],outputRange:[-3,3]});
      const bobY=floats[i].interpolate({inputRange:[0,1],outputRange:[-7,7]});
      return{
        p,
        translateX:Animated.add(Animated.divide(Animated.multiply(x1,RX),denom),bobX),
        translateY:Animated.add(Animated.divide(Animated.multiply(pt.y,RY),denom),bobY),
        scale:Animated.multiply(
          depth.interpolate({inputRange:[0.3,2.2,7,14],outputRange:[1.55,1.12,0.62,0.34],extrapolate:'clamp'}),
          sparkles[i].interpolate({inputRange:[0,1],outputRange:[0.92,1.1]})),
        opacity:Animated.multiply(
          depth.interpolate({inputRange:[0.15,1.5,7,13],outputRange:[0,1,0.6,0.1],extrapolate:'clamp'}),
          sparkles[i].interpolate({inputRange:[0,1],outputRange:[0.6,1]})),
      };
    });
  },[yaw,dolly,RX,RY]);// eslint-disable-line react-hooks/exhaustive-deps

  const toggle=useCallback((id)=>setGroup(g=>g.includes(id)?g.filter(x=>x!==id):[...g,id]),[]);
  // Tap while 2+ are held-glowing launches that group; tapping anything else
  // (including a lone held orb) clears the selection and opens it solo —
  // no bottom tray, the glow ring on held orbs *is* the group indicator.
  const onOrbPress=useCallback((id)=>{
    if(group.includes(id)&&group.length>=2){onLaunch(group);setGroup([]);return;}
    if(group.length)setGroup([]);
    onPick(id);
  },[group,onLaunch,onPick]);
  // Kept fresh via ref so the per-orb PanResponders (built once, below) never
  // call a stale closure.
  const onOrbPressRef=useRef(onOrbPress);
  useEffect(()=>{onOrbPressRef.current=onOrbPress;},[onOrbPress]);

  // One PanResponder per persona, built once. A touch that never moves past
  // the threshold is a tap (or, held past 280ms, a long-press to toggle group
  // selection) — same as before. One that moves becomes a free drag: the orb
  // follows your finger and, on release, stays exactly there (`pinned`) until
  // this screen is left.
  const dragRef=useRef({});
  const orbResponders=useMemo(()=>{
    const map={};
    PERSONA_LIST.forEach(p=>{
      const st=dragRef.current[p.id]={moved:false,longTimer:null,longFired:false,grabX:0,grabY:0};
      map[p.id]=PanResponder.create({
        onStartShouldSetPanResponder:()=>true,
        onMoveShouldSetPanResponder:()=>true,
        onPanResponderTerminationRequest:()=>false,
        onPanResponderGrant:(e)=>{
          st.moved=false;st.longFired=false;
          st.grabX=e.nativeEvent.locationX-26;  // where within the 52px orb you grabbed it
          st.grabY=e.nativeEvent.locationY-26;
          st.longTimer=setTimeout(()=>{if(!st.moved){st.longFired=true;toggle(p.id);}},280);
        },
        onPanResponderMove:(e,g)=>{
          if(!st.moved&&(Math.abs(g.dx)>6||Math.abs(g.dy)>6)){
            st.moved=true;
            if(st.longTimer){clearTimeout(st.longTimer);st.longTimer=null;}
          }
          if(!st.moved)return;
          const lx=g.moveX-originRef.current.x-st.grabX;
          const ly=g.moveY-originRef.current.y-st.grabY;
          setPinned(prev=>({...prev,[p.id]:{tx:lx-sizeRef.current.w/2,ty:ly-sizeRef.current.h*0.42}}));
          computeTethers();
        },
        onPanResponderRelease:()=>{
          if(st.longTimer){clearTimeout(st.longTimer);st.longTimer=null;}
          if(!st.moved&&!st.longFired)onOrbPressRef.current(p.id);
          st.longFired=false;
        },
      });
    });
    return map;
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  return(
    <View style={{flex:1}} ref={boxRef}
      onLayout={e=>{
        const{width,height}=e.nativeEvent.layout;setSize({w:width,h:height});
        boxRef.current&&boxRef.current.measureInWindow&&boxRef.current.measureInWindow((x,y)=>{originRef.current={x:x||0,y:y||0};});
      }}>
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {tethers.map(t=>t.opacity>0.02&&(
            <Line key={t.key} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke="#E8C98A" strokeWidth={1} strokeOpacity={t.opacity}/>
          ))}
        </Svg>
        {order.map(oi=>orbs[oi]).filter(({p})=>!pinned[p.id]).map(({p,translateX,translateY,scale,opacity})=>{
          const selected=group.includes(p.id);
          return(
            <Animated.View key={p.id} style={[s.orbWrap,{opacity,transform:[{translateX},{translateY},{scale}]}]}>
              <View style={s.orbBox} {...orbResponders[p.id].panHandlers}>
                <OrbVisual p={p} selected={selected} pic={pics[p.id]} unread={unreadPersonas?.has?.(p.id)} glowPulse={glowPulse}/>
              </View>
              <Text style={[s.orbName,{color:p.color},selected&&{fontWeight:'700'}]} numberOfLines={1}>{p.name.replace(/\./g,'')}</Text>
            </Animated.View>
          );
        })}
        {/* Manually placed orbs render last so they're always on top, fully
            decoupled from the depth-sorted cloud and its idle drift/bob. */}
        {PERSONA_LIST.filter(p=>pinned[p.id]).map(p=>{
          const pin=pinned[p.id];
          const selected=group.includes(p.id);
          return(
            <View key={p.id} style={[s.orbWrap,{transform:[{translateX:pin.tx},{translateY:pin.ty}]}]}>
              <View style={s.orbBox} {...orbResponders[p.id].panHandlers}>
                <OrbVisual p={p} selected={selected} pic={pics[p.id]} unread={unreadPersonas?.has?.(p.id)} glowPulse={glowPulse}/>
              </View>
              <Text style={[s.orbName,{color:p.color},selected&&{fontWeight:'700'}]} numberOfLines={1}>{p.name.replace(/\./g,'')}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}
const PersonaSphere=forwardRef(PersonaSphereInner);

// Shared visual for one orb — the glow ring (while held for a custom group),
// the core/picture, and the unread dot. Used by both the depth-sorted cloud
// and the manually-pinned pass so dragging an orb doesn't change how it looks.
function OrbVisual({p,selected,pic,unread,glowPulse}){
  return(
    <>
      {selected&&<Animated.View style={[s.orbSelRing,{borderColor:p.color,
        opacity:glowPulse.interpolate({inputRange:[0,1],outputRange:[0.45,1]})}]}/>}
      <View style={[s.orbGlow,{backgroundColor:p.color+(selected?'40':'20')}]}>
        {pic
          ?<Image source={{uri:pic}} style={s.orbImg}/>
          :<View style={[s.orbCore,{backgroundColor:p.color,shadowColor:p.color}]}/>}
      </View>
      {unread&&<View style={s.orbUnread}/>}
    </>
  );
}
export default forwardRef(OrbZoom);

const s=StyleSheet.create({
  wrap:{flex:1},
  loading:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center'},
  rail:{position:'absolute',top:12,left:0,right:0,alignItems:'center'},
  railLabel:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:3},
  dots:{flexDirection:'row',gap:5,marginTop:6},
  dot:{width:5,height:5,borderRadius:2.5,backgroundColor:'#222'},
  zoomCtl:{position:'absolute',right:12,bottom:16,gap:8},
  zBtn:{width:34,height:34,borderRadius:6,borderWidth:1,borderColor:'#222',backgroundColor:'rgba(0,0,0,0.5)',alignItems:'center',justifyContent:'center'},
  zT:{color:'#999',fontSize:18,fontFamily:'monospace'},
  hint:{position:'absolute',bottom:16,left:0,right:0,textAlign:'center',fontFamily:'monospace',fontSize:8,letterSpacing:2,opacity:0.5},
  undoBar:{position:'absolute',left:16,right:16,bottom:60,backgroundColor:'#161616',borderWidth:1,borderColor:'#2A2A2A',borderRadius:8,flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:12},
  undoT:{fontFamily:'monospace',fontSize:10,color:'#999',letterSpacing:1},
  undoAction:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',fontWeight:'700',letterSpacing:2},

  orbWrap:{position:'absolute',left:'50%',top:'42%',marginLeft:-34,marginTop:-34,width:68,alignItems:'center'},
  orbBox:{width:52,height:52},
  // Pulsing ring around an orb held into a custom group (long-press toggles
  // it). Sized just outside orbGlow's own clip so it isn't cropped.
  orbSelRing:{position:'absolute',top:-6,left:-6,right:-6,bottom:-6,borderRadius:32,borderWidth:2},
  orbGlow:{width:52,height:52,borderRadius:26,alignItems:'center',justifyContent:'center',overflow:'hidden'},
  // A reply is waiting — landed while this orb wasn't the one open. Sits
  // outside orbGlow's own clip so the dot isn't cropped by its circle mask.
  orbUnread:{position:'absolute',top:-1,right:8,width:12,height:12,borderRadius:6,backgroundColor:'#E05555',borderWidth:2,borderColor:'#000'},
  orbImg:{width:'100%',height:'100%',borderRadius:26},
  orbCore:{width:18,height:18,borderRadius:9,shadowOpacity:0.9,shadowRadius:8,shadowOffset:{width:0,height:0},elevation:6},
  orbName:{fontFamily:'monospace',fontSize:6,letterSpacing:1,marginTop:4,opacity:0.85},
});
