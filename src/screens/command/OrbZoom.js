// The Galaxy screen, as one continuous zoom:
//   persona galaxy  ->  the persona you zoomed into  ->  its memory spiral  ->  a memory
// Pinch out drills in toward wherever your fingers are; pinch in backs out.
// Each level change animates. The + / - buttons and the mouse wheel (web) do the
// same. `level` is owned by the parent so it survives the viz/chat toggle.
//
// Built entirely on React Native's own Animated + PanResponder — no reanimated
// worklets, which is what hard-crashed the earlier 3D version.
import React,{useState,useEffect,useMemo,useCallback,useRef,useImperativeHandle,forwardRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ActivityIndicator,Dimensions,Platform,Animated,PanResponder,Image,Easing,ScrollView,Alert}from 'react-native';
import Svg,{Path}from 'react-native-svg';
import PersonaOrb from './PersonaOrb';
import MemorySpiral from './MemorySpiral';
import MemoryPopup from './MemoryPopup';
import Boundary from '../hud/Boundary';
import{getMemoriesByPersona,deletePersonaMemory,deleteAllPersonaMemory}from '../../services/database';
import{getPersona,PERSONA_LIST}from '../../personas/personas';

const LEVELS=['group','orb','memory'];
const WHEEL_MID=1200;// px of scroll slack each side of the wheel-catcher — big enough one fast notch can't reach an edge

const SAMP=[],SIN=[],COS=[];
for(let k=0;k<=480;k++){const v=-12*Math.PI+(24*Math.PI)*(k/480);SAMP.push(v);SIN.push(Math.sin(v));COS.push(Math.cos(v));}

// Everyone but A.R.A. scattered at random through a 3D volume, seeded so the
// layout is stable across a session; a min-distance pass keeps them from
// clumping. You yaw the cloud and fly forward / back through it; tap an orb to
// open that persona.
//
// A.R.A. gets a fixed seat front-and-centre instead of a random slot — she's
// personal-assistant-to-everyone, so every other orb tethers back to her (see
// the tether layer in PersonaSphereInner). She isn't otherwise special-cased:
// no size boost, no anchor halo, no dedicated pan responder, and she still
// yaws with the rest of the cloud — that extra machinery was tried before and
// reverted for being more trouble than it was worth. Just her seat, and the
// tethers pointing at it.
const ARA_ID='ara';
const ID_INDEX={};
PERSONA_LIST.forEach((p,i)=>{ID_INDEX[p.id]=i;});
const ARA_INDEX=ID_INDEX[ARA_ID];

const SCATTER=(()=>{
  let a=0x9e3779b9;
  const rnd=()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};
  const pts=new Array(PERSONA_LIST.length);
  for(let i=0;i<PERSONA_LIST.length;i++){
    if(i===ARA_INDEX)continue;
    let best=null,bestD=-1;
    for(let tries=0;tries<40;tries++){
      const c={x:(rnd()*2-1)*8.0,y:(rnd()*2-1)*5.4,z:(rnd()*2-1)*4.0};
      let d=99;
      for(let j=0;j<pts.length;j++){if(!pts[j])continue;d=Math.min(d,Math.hypot(pts[j].x-c.x,pts[j].y-c.y,pts[j].z-c.z));}
      if(d>bestD){bestD=d;best=c;}
    }
    pts[i]=best;
  }
  // Front and centre: at the camera's starting dolly (-5.0) this lands her
  // depth ~0.6 — the nearest, biggest orb the moment the galaxy opens.
  if(ARA_INDEX!=null)pts[ARA_INDEX]={x:0,y:0.15,z:-4.4};
  return pts;
})();
const Z_SPAN=6.6;     // half-depth of the cloud; dolly ranges ±(Z_SPAN+2)

function touchDist(t){return Math.hypot(t[0].pageX-t[1].pageX,t[0].pageY-t[1].pageY);}

function OrbZoom({personaId,color,active,vizRef,personaPics={},unreadPersonas,busyPersonas,onPickPersona,onLaunchGroup,level='group',onLevelChange},ref){
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
    // group is the galaxy root — the way to the city map is the EMPIRE OS title
    // in the header; zooming out past the sphere does nothing.
  },[setLvl]);

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
      // At the galaxy level the mouse wheel flies the camera through the cloud —
      // forward toward the back personas, back out to where A.R.A. sits. It
      // never changes zoom level; click an orb (or pinch) to enter a persona.
      if(levelRef.current==='group'){
        sphereRef.current&&sphereRef.current.nudgeDolly&&sphereRef.current.nudgeDolly(e.deltaY*0.006);
        return;
      }
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
    // Galaxy level: wheel flies the camera through the cloud (see the web
    // handler above), no level change.
    if(levelRef.current==='group'){
      sphereRef.current&&sphereRef.current.nudgeDolly&&sphereRef.current.nudgeDolly(dy*0.01);
      if(Math.abs(y-WHEEL_MID)>500)recenterWheel();
      return;
    }
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
  function eraseAllMemory(){
    const n=(memories||[]).length;
    if(!n)return;
    Alert.alert(
      `Erase all of ${persona.name}'s memory?`,
      `This permanently deletes ${n} ${n===1?'memory':'memories'}, pinned ones included. It can't be undone.`,
      [
        {text:'Cancel',style:'cancel'},
        {text:'Erase all',style:'destructive',onPress:async()=>{
          if(pendingRef.current){clearTimeout(undoTimer.current);pendingRef.current=null;setUndo(null);}
          setMemories([]);setMemory(null);
          try{await deleteAllPersonaMemory(personaId);}catch{}
          reload();
        }},
      ],
    );
  }

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
      {/* The galaxy sits on bare black now — no nebula backdrop, no Earth. The
          way to the city map is the EMPIRE OS title in the header. */}
      <Animated.View style={{flex:1,opacity:morph.opacity,transform:[{translateX:pinchTX},{translateY:pinchTY},{scale:contentScale}]}}>
        {level==='group'&&(
          <Boundary label="The persona sphere">
            <PersonaSphere ref={sphereRef} activeId={personaId} pics={personaPics} unreadPersonas={unreadPersonas} busyPersonas={busyPersonas} onPick={pick} onLaunch={launch} pinned={pinned} setPinned={setPinned}/>
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


      {level!=='group'&&(
        <View style={s.rail} pointerEvents="none">
          <Text style={[s.railLabel,{color}]}>{persona.name}</Text>
        </View>
      )}

      <View style={s.zoomCtl} pointerEvents="box-none">
        <TouchableOpacity style={s.zBtn} onPress={()=>shallower()}><Text style={s.zT}>−</Text></TouchableOpacity>
        <TouchableOpacity style={s.zBtn} onPress={()=>deeper()}><Text style={s.zT}>+</Text></TouchableOpacity>
      </View>


      {level==='memory'&&!undo&&(memories||[]).length>0&&(
        <TouchableOpacity style={s.eraseAll} activeOpacity={0.8} onPress={eraseAllMemory}>
          <Text style={s.eraseAllT}>ERASE ALL MEMORY</Text>
        </TouchableOpacity>
      )}

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

function PersonaSphereInner({activeId,pics,unreadPersonas,busyPersonas,onPick,onLaunch,pinned,setPinned},ref){
  const[size,setSize]=useState({w:Dimensions.get('window').width,h:340});
  const[group,setGroup]=useState([]);
  const[order,setOrder]=useState(()=>PERSONA_LIST.map((_,i)=>i));
  const boxRef=useRef(null);
  const originRef=useRef({x:0,y:0});    // this view's on-screen origin, for turning a raw touch page-position into a local one
  const pinnedRef=useRef(pinned);
  useEffect(()=>{pinnedRef.current=pinned;},[pinned]);
  const yaw=useRef(new Animated.Value(0)).current;        // 0 = dead ahead
  const dolly=useRef(new Animated.Value(-5.0)).current;   // start outside the cloud, looking in
  const yStart=useRef(0),dStart=useRef(-5.0);
  const yawNow=useRef(0),dollyNow=useRef(-5.0);
  const glowPulse=useRef(new Animated.Value(0)).current;
  const sizeRef=useRef(size);
  const sparkles=useRef(PERSONA_LIST.map(()=>new Animated.Value(Math.random()))).current;
  // Gentle idle bob — a small vertical drift, deliberately subtle (±4px) after
  // an earlier, much bigger version read as distracting. A.R.A. holds still on
  // her front seat; only the scattered cloud behind her drifts.
  const bobs=useRef(PERSONA_LIST.map(()=>new Animated.Value(Math.random()))).current;
  const bobNow=useRef(PERSONA_LIST.map(()=>0)); // live bob offset per persona, kept in sync via listener below so the tether math can include it — the tether must track the orb's true rendered centre, bob included, or it visibly detaches during the wiggle
  const tetherRefs=useRef({});

  useEffect(()=>{sizeRef.current=size;},[size]);

  const RX=Math.min(size.w,560)*0.12;
  const RY=Math.min(size.h,size.w,560)*0.11;

  // depth of persona i in front of the viewer, given current yaw + dolly
  const depthOf=useCallback((i,yv,dv)=>{
    const pt=SCATTER[i];
    const z1=-pt.x*Math.sin(yv)+pt.z*Math.cos(yv);
    return z1-dv;
  },[]);

  // Screen position + depth for persona i — same projection pickAt uses below.
  const project=useCallback((i,yv,dv)=>{
    const pt=SCATTER[i];
    const cyN=Math.cos(yv),syN=Math.sin(yv);
    const x1=cyN*pt.x+syN*pt.z;
    const depth=(-pt.x*syN+pt.z*cyN)-dv;
    const denom=Math.max(0.4,1.0+depth*0.14);
    const cx=sizeRef.current.w/2,cy=sizeRef.current.h*0.42;
    return{x:cx+(x1*RX)/denom,y:cy+(pt.y*RY)/denom,depth};
  },[RX,RY]);

  // An orb's current screen position — its pinned spot or the cloud projection.
  // Used by the drag responders below for the grab offset.
  // Tether layer: every orb but A.R.A. gets a curved line back to her front
  // seat, redrawn every frame from the same projection that positions the
  // orbs themselves (pinned spot or cloud projection — whichever endpointFor
  // would give it), so the line can never drift off an orb's real centre.
  // Pushed straight onto each <Path> with setNativeProps — an earlier version
  // drove this off the same Animated values as the orb positions and the SVG
  // layer never saw updates once idle drift moved to the native thread, since
  // react-native-svg doesn't propagate props down a nested Animated graph.
  // A plain per-frame recompute sidesteps that entirely.
  useEffect(()=>{
    if(ARA_INDEX==null)return;
    let raf=null;
    const tick=()=>{
      const yv=yawNow.current,dv=dollyNow.current;
      const araPin=pinnedRef.current[ARA_ID];
      const araPt=araPin
        ?{x:sizeRef.current.w/2+araPin.tx,y:sizeRef.current.h*0.42+araPin.ty,depth:0.6}
        :project(ARA_INDEX,yv,dv);
      for(let i=0;i<PERSONA_LIST.length;i++){
        if(i===ARA_INDEX)continue;
        const p=PERSONA_LIST[i];
        const node=tetherRefs.current[p.id];
        if(!node)continue;
        const pin=pinnedRef.current[p.id];
        const pt=pin?{x:sizeRef.current.w/2+pin.tx,y:sizeRef.current.h*0.42+pin.ty,depth:2}:project(i,yv,dv);
        if(!pin)pt.y+=bobNow.current[i]; // must match the orb's true rendered centre, bob included, or the tether visibly detaches during the wiggle
        if(pt.depth<0.3||araPt.depth<-1){node.setNativeProps({opacity:0});continue;}
        const dist=Math.hypot(pt.x-araPt.x,pt.y-araPt.y)||1;
        // Quadratic bezier, control point 2*sag below the chord's midpoint —
        // a quad curve's own midpoint only travels half way to the control
        // point, so this lands the visible dip at exactly `sag` px. Never a
        // straight line, however short the link.
        const sag=Math.max(8,Math.min(56,dist*0.16));
        const mx=(araPt.x+pt.x)/2,my=(araPt.y+pt.y)/2+sag*2;
        const opacity=Math.max(0.05,Math.min(0.38,1.05-pt.depth*0.09));
        node.setNativeProps({
          d:`M${araPt.x.toFixed(1)},${araPt.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`,
          opacity,
        });
      }
      raf=requestAnimationFrame(tick);
    };
    raf=requestAnimationFrame(tick);
    return()=>{if(raf)cancelAnimationFrame(raf);};
  },[project]);

  const endpointFor=useCallback((id,yv,dv)=>{
    const i=ID_INDEX[id];
    const pin=pinnedRef.current[id];
    if(pin)return{x:sizeRef.current.w/2+pin.tx,y:sizeRef.current.h*0.42+pin.ty,depth:2};
    return project(i,yv,dv);
  },[project]);

  // Depth order (which orb draws on top) only needs to change when the camera
  // moves. During idle nothing here fires, so PersonaSphereInner never
  // re-renders and the twinkle runs undisturbed on the native thread.
  useEffect(()=>{
    let last=0;
    const sortNow=()=>{
      const yv=yawNow.current,dv=dollyNow.current;
      setOrder(PERSONA_LIST.map((_,i)=>i).sort((a,b)=>depthOf(b,yv,dv)-depthOf(a,yv,dv))); // far first
    };
    const recompute=()=>{const now=Date.now();if(now-last<120)return;last=now;sortNow();};
    sortNow();                                        // initial depth order
    const idY=yaw.addListener(e=>{yawNow.current=e.value;recompute();});
    const idD=dolly.addListener(e=>{dollyNow.current=e.value;recompute();});
    return()=>{yaw.removeListener(idY);dolly.removeListener(idD);};
  },[depthOf]);// eslint-disable-line react-hooks/exhaustive-deps

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
    // The twinkle (scale + opacity) — a subtle per-orb breathing pulse. Fully
    // native-driven on its own transform layer (see the orbs memo + render), so
    // no orb has any JS-thread animation running while the camera sits still.
    const loops=sparkles.map((v,i)=>Animated.loop(Animated.sequence([
      Animated.delay(i*160),
      Animated.timing(v,{toValue:1,duration:1500+((i*137)%900),easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
      Animated.timing(v,{toValue:0,duration:1500+((i*211)%900),easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
    ])));
    loops.forEach(l=>l.start());
    return()=>loops.forEach(l=>l.stop());
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{
    // Idle bob — small, slow, native-driven vertical drift on the same
    // transform layer as the twinkle above. A.R.A. is excluded: she holds her
    // front seat still, everyone else drifts gently behind her.
    // A listener on each bob mirrors its current offset into bobNow — even
    // though the animation itself runs on the native thread, the tether tick
    // (below) needs the live number so the line's endpoint always lands on
    // the orb's true centre, bob included, and never detaches from it.
    const listenerIds=bobs.map((v,i)=>i===ARA_INDEX?null:v.addListener(({value})=>{bobNow.current[i]=-4*value;}));
    const loops=bobs.map((v,i)=>{
      if(i===ARA_INDEX)return null;
      return Animated.loop(Animated.sequence([
        Animated.delay(i*220),
        Animated.timing(v,{toValue:1,duration:3200+((i*173)%1400),easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
        Animated.timing(v,{toValue:0,duration:3200+((i*241)%1400),easing:Easing.inOut(Easing.sin),useNativeDriver:true}),
      ]));
    });
    loops.forEach(l=>l&&l.start());
    return()=>{
      loops.forEach(l=>l&&l.stop());
      bobs.forEach((v,i)=>{if(listenerIds[i]!=null)v.removeListener(listenerIds[i]);});
    };
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
    // Mouse wheel on the galaxy: fly the camera through the cloud. +dz dollies
    // forward into the cloud; -dz backs out. Clamped to just past either edge.
    nudgeDolly(dz){
      const nv=Math.max(-(Z_SPAN+2),Math.min(Z_SPAN+2,dollyNow.current+dz));
      dollyNow.current=nv;
      Animated.spring(dolly,{toValue:nv,useNativeDriver:false,speed:16,bounciness:0}).start();
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
      return{
        p,
        depth,
        translateX:Animated.divide(Animated.multiply(x1,RX),denom),
        translateY:Animated.divide(Animated.multiply(pt.y,RY),denom),
        // Twinkle rides its own native-driven transform layer (see the render),
        // kept off the JS-driven position/scale below so it stays smooth no
        // matter what the JS thread is doing. Deliberately gentle.
        sparkleScale:sparkles[i].interpolate({inputRange:[0,1],outputRange:[0.97,1.04]}),
        sparkleOpacity:sparkles[i].interpolate({inputRange:[0,1],outputRange:[0.82,1]}),
        // Idle bob rides the same native layer as the twinkle. null for A.R.A.
        // (index ARA_INDEX) — omitted from the transform below so she's still.
        bobY:i===ARA_INDEX?null:bobs[i].interpolate({inputRange:[0,1],outputRange:[0,-4]}),
        // Depth-driven scale/opacity — JS-driven (they track yaw/dolly) but
        // completely static while the camera is still.
        scale:depth.interpolate({inputRange:[0.3,2.2,6,11],outputRange:[1.55,1.12,0.45,0.22],extrapolate:'clamp'}),
        opacity:depth.interpolate({inputRange:[0.15,1.0,6,11],outputRange:[0,1,0.18,0.06],extrapolate:'clamp'}),
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
  // endpointFor gives an orb's real current screen position (cloud-projected
  // or already-pinned, either way) — kept fresh via ref for the same reason
  // onOrbPress is, since the responders below are built once.
  const endpointForRef=useRef(endpointFor);
  useEffect(()=>{endpointForRef.current=endpointFor;},[endpointFor]);

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
        // Yield to the parent (cloud yaw/dolly pan) for as long as we haven't
        // actually committed to THIS orb — otherwise any swipe that happens to
        // start on top of an orb permanently hijacks the touch and the cloud
        // can never be panned or flown past it, no matter how far it moves.
        onPanResponderTerminationRequest:()=>!st.longFired,
        onPanResponderGrant:(e,g)=>{
          st.moved=false;st.longFired=false;
          // Grab offset = where you actually touched minus the orb's real
          // current position (from the projection math, not RN's layout
          // metrics — nativeEvent.locationX/Y is what threw the orb to the
          // top-left before: it's reported relative to the target's
          // pre-transform layout frame, not its actual on-screen position,
          // once the parent has a translate/scale transform applied).
          // Without this offset the orb re-centers on your finger the
          // instant you touch it anywhere off its exact center, which reads
          // as a jump/glitch even though nothing "breaks".
          const{x:ox,y:oy}=endpointForRef.current(p.id,yawNow.current,dollyNow.current);
          st.grabX=(g.x0-originRef.current.x)-ox;
          st.grabY=(g.y0-originRef.current.y)-oy;
          st.longTimer=setTimeout(()=>{if(!st.moved){st.longFired=true;toggle(p.id);}},280);
        },
        onPanResponderMove:(e,g)=>{
          // Movement before the long-press has fired reads as a swipe meant
          // for the cloud, not a grab on this orb — bail out (the parent
          // steals the touch via onPanResponderTerminationRequest above)
          // instead of starting a drag. Dragging an orb now needs a brief
          // hold first, same gesture shape as the long-press-to-select — a
          // quick touch-and-slide no longer instantly repositions it, which
          // is the trade-off for a swipe-through no longer getting stuck.
          if(!st.longFired){
            if(Math.abs(g.dx)>6||Math.abs(g.dy)>6){
              if(st.longTimer){clearTimeout(st.longTimer);st.longTimer=null;}
            }
            return;
          }
          st.moved=true;
          // moveX/moveY are the touch's raw page position — always reliable
          // regardless of transforms. Subtracting the grab offset keeps the
          // orb tracking the same point you grabbed it at, instead of
          // snapping its center to the finger.
          const lx=g.moveX-originRef.current.x-st.grabX;
          const ly=g.moveY-originRef.current.y-st.grabY;
          setPinned(prev=>({...prev,[p.id]:{tx:lx-sizeRef.current.w/2,ty:ly-sizeRef.current.h*0.42}}));
          // the tether layer follows the new pinned spot on its own next tick
        },
        onPanResponderRelease:()=>{
          if(st.longTimer){clearTimeout(st.longTimer);st.longTimer=null;}
          if(!st.moved&&!st.longFired)onOrbPressRef.current(p.id);
          st.longFired=false;st.moved=false;
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
        {/* Tethers — every orb but A.R.A. curves back to her front seat.
            Rendered behind the orbs and updated imperatively every frame
            (see the effect above); `d`/`opacity` here are just placeholders
            until the first tick. */}
        <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
          {PERSONA_LIST.filter(p=>p.id!==ARA_ID).map(p=>(
            <Path key={p.id} ref={r=>{tetherRefs.current[p.id]=r;}} d="M0,0 L0,0" stroke={p.color} strokeWidth={1} fill="none" opacity={0}/>
          ))}
        </Svg>
        {order.map(oi=>orbs[oi]).filter(({p})=>!pinned[p.id]).map(({p,translateX,translateY,scale,opacity,sparkleScale,sparkleOpacity,bobY})=>{
          const selected=group.includes(p.id);
          return(
            <Animated.View key={p.id} style={[s.orbWrap,{opacity,transform:[{translateX},{translateY},{scale}]}]}>
              {/* Twinkle (+ idle bob, if any) live on their own native-driven
                  transform layer, separate from the JS-driven cloud position
                  above. */}
              <Animated.View style={{opacity:sparkleOpacity,transform:bobY?[{scale:sparkleScale},{translateY:bobY}]:[{scale:sparkleScale}]}}>
                <View style={s.orbBox} {...orbResponders[p.id].panHandlers}>
                  <OrbVisual p={p} selected={selected} pic={pics[p.id]} unread={unreadPersonas?.has?.(p.id)} busy={busyPersonas?.has?.(p.id)} glowPulse={glowPulse}/>
                </View>
                <Text style={[s.orbName,{color:p.color},selected&&s.orbNameStrong]} numberOfLines={1}>{p.name.replace(/\./g,'')}</Text>
              </Animated.View>
            </Animated.View>
          );
        })}
        {/* Manually placed orbs render last so they're always on top, decoupled
            from the depth-sorted cloud's position/scale/opacity (dragging one
            fixes it to a screen spot instead of the camera). */}
        {PERSONA_LIST.filter(p=>pinned[p.id]).map(p=>{
          const pin=pinned[p.id];
          const selected=group.includes(p.id);
          const o=orbs[ID_INDEX[p.id]];
          return(
            <View key={p.id} style={[s.orbWrap,{transform:[{translateX:pin.tx},{translateY:pin.ty}]}]}>
              <Animated.View style={{opacity:o.sparkleOpacity,transform:[{scale:o.sparkleScale}]}}>
                <View style={s.orbBox} {...orbResponders[p.id].panHandlers}>
                  <OrbVisual p={p} selected={selected} pic={pics[p.id]} unread={unreadPersonas?.has?.(p.id)} busy={busyPersonas?.has?.(p.id)} glowPulse={glowPulse}/>
                </View>
                <Text style={[s.orbName,{color:p.color},selected&&s.orbNameStrong]} numberOfLines={1}>{p.name.replace(/\./g,'')}</Text>
              </Animated.View>
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
function OrbVisual({p,selected,pic,unread,busy,glowPulse}){
  return(
    <>
      {/* A persona working in the background — a soft gold aura that breathes.
          Rendered first so it sits behind the orb core. */}
      {busy&&<Animated.View pointerEvents="none" style={[s.orbAura,{
        opacity:glowPulse.interpolate({inputRange:[0,1],outputRange:[0.2,0.6]}),
        transform:[{scale:glowPulse.interpolate({inputRange:[0,1],outputRange:[1,1.16]})}],
      }]}/>}
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
  eraseAll:{position:'absolute',left:16,bottom:16,backgroundColor:'rgba(0,0,0,0.5)',borderWidth:1,borderColor:'#5A2020',borderRadius:6,paddingHorizontal:12,paddingVertical:9},
  eraseAllT:{fontFamily:'monospace',fontSize:9,letterSpacing:2,color:'#E05555'},
  undoBar:{position:'absolute',left:16,right:16,bottom:60,backgroundColor:'#161616',borderWidth:1,borderColor:'#2A2A2A',borderRadius:8,flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:12},
  undoT:{fontFamily:'monospace',fontSize:10,color:'#999',letterSpacing:1},
  undoAction:{fontFamily:'monospace',fontSize:10,color:'#E8C98A',fontWeight:'700',letterSpacing:2},

  // marginLeft centres the 68-wide wrap on left:50%; marginTop lands the 52-tall
  // orbBox's CENTRE on top:42%.
  orbWrap:{position:'absolute',left:'50%',top:'42%',marginLeft:-34,marginTop:-26,width:68,alignItems:'center'},
  orbBox:{width:52,height:52},
  // Pulsing ring around an orb held into a custom group (long-press toggles
  // it). Sized just outside orbGlow's own clip so it isn't cropped.
  orbSelRing:{position:'absolute',top:-6,left:-6,right:-6,bottom:-6,borderRadius:32,borderWidth:2},
  // Background-work aura: a filled gold disc with a brighter rim + native glow,
  // pulsed via glowPulse. Sits outside orbGlow's clip so it isn't cropped.
  orbAura:{position:'absolute',top:-15,left:-15,right:-15,bottom:-15,borderRadius:42,
    backgroundColor:'rgba(232,201,138,0.20)',borderWidth:1.5,borderColor:'rgba(232,201,138,0.75)',
    shadowColor:'#E8C98A',shadowOpacity:0.9,shadowRadius:14,shadowOffset:{width:0,height:0},elevation:10},
  orbGlow:{width:52,height:52,borderRadius:26,alignItems:'center',justifyContent:'center',overflow:'hidden'},
  // A reply is waiting — landed while this orb wasn't the one open. Sits
  // outside orbGlow's own clip so the dot isn't cropped by its circle mask.
  orbUnread:{position:'absolute',top:-1,right:8,width:12,height:12,borderRadius:6,backgroundColor:'#E05555',borderWidth:2,borderColor:'#000'},
  orbImg:{width:'100%',height:'100%',borderRadius:26},
  orbCore:{width:18,height:18,borderRadius:9,shadowOpacity:0.9,shadowRadius:8,shadowOffset:{width:0,height:0},elevation:6},
  // Name label — absolutely positioned BELOW the 52px orb box, out of the flex
  // flow, so the wrap sizes to the orb alone and the depth-scale transform
  // pivots on the orb's true centre.
  orbName:{position:'absolute',top:53,left:-22,right:-22,textAlign:'center',fontFamily:'monospace',fontSize:6,letterSpacing:1,opacity:0.85},
  orbNameStrong:{fontSize:7,fontWeight:'700',letterSpacing:1.5,opacity:1},
});
