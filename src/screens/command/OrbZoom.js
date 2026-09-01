// The orb screen as one continuous zoom:
//   persona sphere  ->  the persona you zoomed into  ->  its memory web  ->  a memory
// Pinch out drills in on whatever you are looking at; pinch in backs out.
// The + / - buttons and (on web) the mouse wheel do the same. Opens on the sphere.
//
// Built entirely on React Native's own Animated + PanResponder — no reanimated
// worklets, which is what hard-crashed the earlier 3D version.
import React,{useState,useEffect,useMemo,useCallback,useRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ActivityIndicator,Dimensions,Platform,Animated,PanResponder,Image,Easing}from 'react-native';
import PersonaOrb from './PersonaOrb';
import BrainWeb from './BrainWeb';
import MemoryPopup from './MemoryPopup';
import Boundary from '../hud/Boundary';
import{getMemoriesByPersona,deletePersonaMemory}from '../../services/database';
import{getPersona,PERSONA_LIST}from '../../personas/personas';

const LEVELS=['group','orb','brain'];

// sin/cos lookup covering ±12 turns so the sphere never runs out of range.
const SAMP=[],SIN=[],COS=[];
for(let k=0;k<=480;k++){const v=-12*Math.PI+(24*Math.PI)*(k/480);SAMP.push(v);SIN.push(Math.sin(v));COS.push(Math.cos(v));}

// Personas spread over a unit sphere (Fibonacci).
const SPHERE_PTS=PERSONA_LIST.map((_,i)=>{
  const n=PERSONA_LIST.length;
  const y=1-(i/((n-1)||1))*2;
  const r=Math.sqrt(Math.max(0,1-y*y));
  const th=i*2.399963229728653;
  return{x:Math.cos(th)*r,y,z:Math.sin(th)*r};
});

function touchDist(t){return Math.hypot(t[0].pageX-t[1].pageX,t[0].pageY-t[1].pageY);}

export default function OrbZoom({personaId,color,active,vizRef,personaPics={},onPickPersona,onLaunchGroup}){
  const persona=getPersona(personaId);
  const[memories,setMemories]=useState(null);
  const[level,setLevel]=useState('group');
  const[memory,setMemory]=useState(null);
  const[undo,setUndo]=useState(null);
  const undoTimer=useRef(null);
  const pendingRef=useRef(null);
  const didMount=useRef(false);
  const wrapRef=useRef(null);
  const wheelAcc=useRef(0);
  const pinchRef=useRef({d0:0,d1:0});
  const brainRef=useRef(null);
  const frontRef=useRef(null);   // () => id of the persona currently facing you
  const levelRef=useRef('group');
  const fade=useRef(new Animated.Value(1)).current;

  useEffect(()=>{levelRef.current=level;},[level]);
  useEffect(()=>{
    fade.setValue(0);
    Animated.timing(fade,{toValue:1,duration:200,useNativeDriver:true}).start();
  },[level]);// eslint-disable-line react-hooks/exhaustive-deps

  const reload=useCallback(()=>{getMemoriesByPersona(personaId).then(m=>setMemories(m||[])).catch(()=>setMemories([]));},[personaId]);
  useEffect(()=>{
    if(didMount.current){setLevel('orb');setMemory(null);}
    didMount.current=true;
    setMemories(null);reload();
  },[personaId,reload]);
  useEffect(()=>{if(level==='brain')reload();},[level,reload]);
  useEffect(()=>()=>{
    if(undoTimer.current){clearTimeout(undoTimer.current);if(pendingRef.current)deletePersonaMemory(pendingRef.current.id).catch(()=>{});}
  },[]);

  const pick=useCallback((id)=>{onPickPersona?.(id);setLevel('orb');},[onPickPersona]);
  const launch=useCallback((ids)=>{onLaunchGroup?.(ids);},[onLaunchGroup]);

  // Drill in on whatever you're looking at.
  const deeper=useCallback(()=>{
    const cur=levelRef.current;
    if(cur==='group'){const id=frontRef.current&&frontRef.current();pick(id||PERSONA_LIST[0].id);return;}
    if(cur==='orb'){setLevel('brain');return;}
    if(cur==='brain'){brainRef.current&&brainRef.current.drillIn();return;}
  },[pick]);

  const shallower=useCallback(()=>{
    const cur=levelRef.current;
    if(cur==='brain'){
      if(brainRef.current&&brainRef.current.drillOut())return; // handled inside the web
      setLevel('orb');return;
    }
    if(cur==='orb'){setLevel('group');return;}
  },[]);

  // Two-finger pinch on the stage → change level (unless we're in the brain,
  // which owns its own pinch so it can drill hub -> memory).
  const stagePan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponderCapture:(e)=>!!e.nativeEvent.touches&&e.nativeEvent.touches.length===2&&levelRef.current!=='brain',
    onMoveShouldSetPanResponderCapture:(e)=>!!e.nativeEvent.touches&&e.nativeEvent.touches.length===2&&levelRef.current!=='brain',
    onPanResponderGrant:(e)=>{
      const t=e.nativeEvent.touches;
      if(t&&t.length===2){const d=touchDist(t);pinchRef.current={d0:d,d1:d};}
    },
    onPanResponderMove:(e)=>{
      const t=e.nativeEvent.touches;
      if(t&&t.length===2)pinchRef.current.d1=touchDist(t);
    },
    onPanResponderRelease:()=>{
      const{d0,d1}=pinchRef.current;
      pinchRef.current={d0:0,d1:0};
      if(d0>0&&d1>0){
        const r=d1/d0;
        if(r>1.22)deeper();
        else if(r<0.82)shallower();
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
    <View ref={wrapRef} style={s.wrap} {...stagePan.panHandlers}>
      <Animated.View style={[{flex:1},{opacity:fade}]}>
        {level==='group'&&(
          <PersonaSphere activeId={personaId} pics={personaPics} onPick={pick} onLaunch={launch} frontRef={frontRef}/>
        )}
        {level==='orb'&&(
          <Boundary label="The visualization"><PersonaOrb viz={vizRef} color={color} active={active}/></Boundary>
        )}
        {level==='brain'&&(
          <Boundary label="The memory web">
            <BrainWeb ref={brainRef} persona={persona} memories={memories}
              onNode={m=>setMemory(m)} onExit={()=>setLevel('orb')}/>
          </Boundary>
        )}
      </Animated.View>

      {memories===null&&level==='brain'&&<View style={s.loading}><ActivityIndicator color={color}/></View>}

      <View style={s.rail} pointerEvents="none">
        <Text style={[s.railLabel,{color}]}>
          {level==='group'?'ALL PERSONAS':level==='orb'?persona.name:`${persona.name} · MEMORY`}
        </Text>
        <View style={s.dots}>
          {LEVELS.map((l,i)=>(<View key={l} style={[s.dot,i<=idx&&{backgroundColor:color,opacity:i===idx?1:0.4}]}/>))}
        </View>
      </View>

      <View style={s.zoomCtl} pointerEvents="box-none">
        <TouchableOpacity style={s.zBtn} onPress={shallower}><Text style={s.zT}>−</Text></TouchableOpacity>
        <TouchableOpacity style={s.zBtn} onPress={deeper}><Text style={s.zT}>+</Text></TouchableOpacity>
      </View>

      {level==='orb'&&<Text style={[s.hint,{color}]} pointerEvents="none">◈ PINCH OUT FOR MEMORY · PINCH IN FOR ALL PERSONAS</Text>}
      {level==='group'&&<Text style={[s.hint,{color}]} pointerEvents="none">◈ DRAG TO SPIN · PINCH THE ONE YOU WANT · HOLD TO GROUP</Text>}

      {undo&&<TouchableOpacity style={s.undoBar} activeOpacity={0.8} onPress={undoMemory}>
        <Text style={s.undoT}>Memory deleted</Text>
        <Text style={s.undoAction}>UNDO</Text>
      </TouchableOpacity>}

      {memory&&<MemoryPopup memory={memory} onClose={()=>setMemory(null)} onDelete={m=>removeMemory(m)}/>}
    </View>
  );
}

// --- The rotatable persona sphere -------------------------------------------

function PersonaSphere({activeId,pics,onPick,onLaunch,frontRef}){
  const[size,setSize]=useState({w:Dimensions.get('window').width,h:340});
  const[group,setGroup]=useState([]);
  const[order,setOrder]=useState(()=>PERSONA_LIST.map((_,i)=>i));
  const theta=useRef(new Animated.Value(0.4)).current;   // spin (around vertical)
  const phi=useRef(new Animated.Value(0.15)).current;    // tilt (around horizontal)
  const tStart=useRef(0.4),pStart=useRef(0.15);
  const tNow=useRef(0.4),pNow=useRef(0.15);
  const sparkles=useRef(PERSONA_LIST.map(()=>new Animated.Value(Math.random()))).current;

  // track angles + which orb is facing the viewer
  useEffect(()=>{
    const idT=theta.addListener(({value})=>{tNow.current=value;});
    const idP=phi.addListener(({value})=>{pNow.current=value;});
    return()=>{theta.removeListener(idT);phi.removeListener(idP);};
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  const frontId=useCallback(()=>{
    const t=tNow.current,p=pNow.current;
    const ct=Math.cos(t),st=Math.sin(t),cp=Math.cos(p),sp=Math.sin(p);
    let best=PERSONA_LIST[0].id,bz=-Infinity;
    for(let i=0;i<PERSONA_LIST.length;i++){
      const pt=SPHERE_PTS[i];
      const z1=-st*pt.x+ct*pt.z;
      const z2=sp*pt.y+cp*z1;
      if(z2>bz){bz=z2;best=PERSONA_LIST[i].id;}
    }
    return best;
  },[]);
  useEffect(()=>{if(frontRef)frontRef.current=frontId;return()=>{if(frontRef)frontRef.current=null;};},[frontRef,frontId]);

  // keep front orbs painted last so touches land where you look
  useEffect(()=>{
    let last=0;
    const tick=()=>{
      const now=Date.now();if(now-last<160)return;last=now;
      const t=tNow.current,p=pNow.current;
      const ct=Math.cos(t),st=Math.sin(t),cp=Math.cos(p),sp=Math.sin(p);
      const z=(i)=>{const pt=SPHERE_PTS[i];const z1=-st*pt.x+ct*pt.z;return sp*pt.y+cp*z1;};
      setOrder(PERSONA_LIST.map((_,i)=>i).sort((a,b)=>z(a)-z(b)));
    };
    const idT=theta.addListener(tick);const idP=phi.addListener(tick);
    return()=>{theta.removeListener(idT);phi.removeListener(idP);};
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  // per-orb sparkle
  useEffect(()=>{
    const loops=sparkles.map((v,i)=>Animated.loop(Animated.sequence([
      Animated.delay(i*160),
      Animated.timing(v,{toValue:1,duration:900+((i*137)%700),easing:Easing.inOut(Easing.sin),useNativeDriver:false}),
      Animated.timing(v,{toValue:0,duration:900+((i*211)%700),easing:Easing.inOut(Easing.sin),useNativeDriver:false}),
    ])));
    loops.forEach(l=>l.start());
    return()=>loops.forEach(l=>l.stop());
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  const pan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponder:()=>false,
    onMoveShouldSetPanResponder:(e,g)=>(!e.nativeEvent.touches||e.nativeEvent.touches.length<2)&&(Math.abs(g.dx)>6||Math.abs(g.dy)>6),
    onPanResponderGrant:()=>{
      theta.stopAnimation(v=>{tStart.current=v;});
      phi.stopAnimation(v=>{pStart.current=v;});
    },
    onPanResponderMove:(_,g)=>{
      theta.setValue(tStart.current-g.dx*0.010);
      phi.setValue(Math.max(-1.35,Math.min(1.35,pStart.current+g.dy*0.010)));
    },
    onPanResponderRelease:(_,g)=>{
      Animated.decay(theta,{velocity:-g.vx*0.010,deceleration:0.996,useNativeDriver:false}).start();
    },
  }),[]);// eslint-disable-line react-hooks/exhaustive-deps

  const RX=Math.min(size.w,520)*0.36;
  const RY=Math.min(size.w,size.h,520)*0.32;

  const orbs=useMemo(()=>{
    const cosT=theta.interpolate({inputRange:SAMP,outputRange:COS,extrapolate:'clamp'});
    const sinT=theta.interpolate({inputRange:SAMP,outputRange:SIN,extrapolate:'clamp'});
    const cosP=phi.interpolate({inputRange:SAMP,outputRange:COS,extrapolate:'clamp'});
    const sinP=phi.interpolate({inputRange:SAMP,outputRange:SIN,extrapolate:'clamp'});
    return PERSONA_LIST.map((p,i)=>{
      const pt=SPHERE_PTS[i];
      const x1=Animated.add(Animated.multiply(cosT,pt.x),Animated.multiply(sinT,pt.z));
      const z1=Animated.add(Animated.multiply(sinT,-pt.x),Animated.multiply(cosT,pt.z));
      const y2=Animated.subtract(Animated.multiply(cosP,pt.y),Animated.multiply(sinP,z1));
      const z2=Animated.add(Animated.multiply(sinP,pt.y),Animated.multiply(cosP,z1));
      const spk=sparkles[i].interpolate({inputRange:[0,1],outputRange:[0.55,1]});
      return{
        p,
        translateX:Animated.multiply(x1,RX),
        translateY:Animated.multiply(y2,RY),
        scale:Animated.multiply(z2.interpolate({inputRange:[-1,1],outputRange:[0.5,1.15],extrapolate:'clamp'}),
          sparkles[i].interpolate({inputRange:[0,1],outputRange:[0.9,1.12]})),
        opacity:Animated.multiply(z2.interpolate({inputRange:[-1,1],outputRange:[0.22,1],extrapolate:'clamp'}),spk),
      };
    });
  },[theta,phi,RX,RY]);// eslint-disable-line react-hooks/exhaustive-deps

  const toggle=useCallback((id)=>setGroup(g=>g.includes(id)?g.filter(x=>x!==id):[...g,id]),[]);

  return(
    <View style={{flex:1}} onLayout={e=>{const{width,height}=e.nativeEvent.layout;setSize({w:width,h:height});}}>
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
        {order.map(oi=>orbs[oi]).map(({p,translateX,translateY,scale,opacity})=>(
          <Animated.View key={p.id} style={[s.orbWrap,{opacity,transform:[{translateX},{translateY},{scale}]}]}>
            <TouchableOpacity activeOpacity={0.85} delayLongPress={280}
              onPress={()=>onPick(p.id)} onLongPress={()=>toggle(p.id)}>
              <View style={[s.orbGlow,{backgroundColor:p.color+'20',borderColor:'transparent'}]}>
                {pics[p.id]
                  ?<Image source={{uri:pics[p.id]}} style={s.orbImg}/>
                  :<View style={[s.orbCore,{backgroundColor:p.color,shadowColor:p.color}]}/>}
              </View>
              <Text style={[s.orbName,{color:p.color},group.includes(p.id)&&{fontWeight:'700'}]} numberOfLines={1}>{p.name.replace(/\./g,'')}</Text>
            </TouchableOpacity>
          </Animated.View>
        ))}
      </View>

      <View style={s.tray}>
        <Text style={s.trayLabel}>CUSTOM GROUP · hold an orb to add</Text>
        <View style={s.trayChips}>
          {group.length===0&&<Text style={s.trayEmpty}>—</Text>}
          {group.map(id=>{const p=getPersona(id);return(
            <TouchableOpacity key={id} style={[s.chip,{borderColor:p.color}]} onPress={()=>toggle(id)}>
              <Text style={[s.chipIcon,{color:p.color}]}>{p.icon}</Text>
              <Text style={s.chipX}>×</Text>
            </TouchableOpacity>
          );})}
        </View>
        {group.length>=2&&<TouchableOpacity style={s.launch} onPress={()=>onLaunch(group)}>
          <Text style={s.launchT}>LAUNCH GROUP · {group.length}</Text>
        </TouchableOpacity>}
      </View>
    </View>
  );
}

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
  orbGlow:{width:52,height:52,borderRadius:26,alignItems:'center',justifyContent:'center',overflow:'hidden'},
  orbImg:{width:'100%',height:'100%',borderRadius:26},
  orbCore:{width:18,height:18,borderRadius:9,shadowOpacity:0.9,shadowRadius:8,shadowOffset:{width:0,height:0},elevation:6},
  orbName:{fontFamily:'monospace',fontSize:6,letterSpacing:1,marginTop:4,opacity:0.85},
  tray:{position:'absolute',left:0,right:0,bottom:0,borderTopWidth:1,borderTopColor:'#1F1B14',backgroundColor:'#0A0806',paddingHorizontal:14,paddingTop:8,paddingBottom:12},
  trayLabel:{fontFamily:'monospace',fontSize:7,color:'#6b5a30',letterSpacing:2,marginBottom:6},
  trayChips:{flexDirection:'row',flexWrap:'wrap',gap:6,minHeight:26,alignItems:'center'},
  trayEmpty:{fontFamily:'monospace',fontSize:12,color:'#2a2a2a'},
  chip:{flexDirection:'row',alignItems:'center',gap:4,borderWidth:1,borderRadius:13,paddingHorizontal:8,paddingVertical:3},
  chipIcon:{fontFamily:'monospace',fontSize:9,fontWeight:'700'},
  chipX:{fontFamily:'monospace',fontSize:10,color:'#555'},
  launch:{marginTop:8,backgroundColor:'#E8C98A',borderRadius:6,paddingVertical:9,alignItems:'center'},
  launchT:{fontFamily:'monospace',fontSize:10,color:'#000',fontWeight:'700',letterSpacing:2},
});
