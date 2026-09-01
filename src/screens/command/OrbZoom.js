// The orb screen as one continuous zoom:
//   persona sphere  ->  a persona's orb  ->  its memory web  ->  one region hub
// Pinch in/out (or the + / - buttons, or the mouse wheel on web) moves between
// levels. Opens on the sphere.
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
import{categoryMeta}from '../../services/memoryCategories';
import{getPersona,PERSONA_LIST}from '../../personas/personas';

const LEVELS=['group','orb','brain','hub'];

// sin/cos lookup covering ±12 turns so the sphere never runs out of range.
const SAMP=[],SIN=[],COS=[];
for(let k=0;k<=480;k++){const v=-12*Math.PI+(24*Math.PI)*(k/480);SAMP.push(v);SIN.push(Math.sin(v));COS.push(Math.cos(v));}

// Personas spread over a unit sphere (Fibonacci) — px/py/pz per persona.
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
  const[level,setLevel]=useState('group');   // open on the sphere
  const[hubKey,setHubKey]=useState(null);
  const[memory,setMemory]=useState(null);
  const[undo,setUndo]=useState(null);
  const undoTimer=useRef(null);
  const pendingRef=useRef(null);
  const didMount=useRef(false);
  const wrapRef=useRef(null);
  const wheelAcc=useRef(0);
  const pinchRef=useRef({d0:0,d1:0});
  const fade=useRef(new Animated.Value(1)).current;

  useEffect(()=>{
    fade.setValue(0);
    Animated.timing(fade,{toValue:1,duration:200,useNativeDriver:true}).start();
  },[level,hubKey]);// eslint-disable-line react-hooks/exhaustive-deps

  const reload=useCallback(()=>{getMemoriesByPersona(personaId).then(m=>setMemories(m||[])).catch(()=>setMemories([]));},[personaId]);
  useEffect(()=>{
    if(didMount.current){setLevel('orb');setHubKey(null);setMemory(null);}
    didMount.current=true;
    setMemories(null);reload();
  },[personaId,reload]);
  useEffect(()=>{if(level==='brain'||level==='hub')reload();},[level,reload]);
  useEffect(()=>()=>{
    if(undoTimer.current){clearTimeout(undoTimer.current);if(pendingRef.current)deletePersonaMemory(pendingRef.current.id).catch(()=>{});}
  },[]);

  const groupKeys=useMemo(()=>{
    const set=new Set();
    for(const m of memories||[])set.add(m.category||'personal');
    return[...set];
  },[memories]);

  const deeper=useCallback(()=>setLevel(cur=>{
    if(cur==='group')return 'orb';
    if(cur==='orb')return 'brain';
    if(cur==='brain'){
      if(!groupKeys.length)return 'brain';
      setHubKey(k=>k||groupKeys[0]);
      return 'hub';
    }
    return cur;
  }),[groupKeys]);

  const shallower=useCallback(()=>setLevel(cur=>{
    if(cur==='hub')return 'brain';
    if(cur==='brain')return 'orb';
    if(cur==='orb')return 'group';
    return 'group';
  }),[]);

  // Two-finger pinch anywhere on the stage → change level.
  const stagePan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponderCapture:(e)=>e.nativeEvent.touches&&e.nativeEvent.touches.length===2,
    onMoveShouldSetPanResponderCapture:(e)=>e.nativeEvent.touches&&e.nativeEvent.touches.length===2,
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

  // Mouse wheel / trackpad on web.
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

  const pick=useCallback((id)=>{onPickPersona?.(id);setLevel('orb');},[onPickPersona]);
  const launch=useCallback((ids)=>{onLaunchGroup?.(ids);},[onLaunchGroup]);

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
          <PersonaSphere activeId={personaId} pics={personaPics} onPick={pick} onLaunch={launch}/>
        )}
        {level==='orb'&&(
          <Boundary label="The visualization"><PersonaOrb viz={vizRef} color={color} active={active}/></Boundary>
        )}
        {(level==='brain'||level==='hub')&&(
          <Boundary label="The memory web">
            <BrainWeb persona={persona} memories={memories} focusCat={level==='hub'?hubKey:null} onNode={m=>setMemory(m)}/>
          </Boundary>
        )}
      </Animated.View>

      {memories===null&&(level==='brain'||level==='hub')&&<View style={s.loading}><ActivityIndicator color={color}/></View>}

      <View style={s.rail} pointerEvents="none">
        <Text style={[s.railLabel,{color}]}>
          {level==='group'?'ALL PERSONAS'
            :level==='orb'?persona.name
            :level==='brain'?`${persona.name} · MEMORY`
            :`${categoryMeta(hubKey).label.toUpperCase()}`}
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
      {level==='group'&&<Text style={[s.hint,{color}]} pointerEvents="none">◈ DRAG TO SPIN · TAP TO CHOOSE · HOLD TO GROUP</Text>}

      {undo&&<TouchableOpacity style={s.undoBar} activeOpacity={0.8} onPress={undoMemory}>
        <Text style={s.undoT}>Memory deleted</Text>
        <Text style={s.undoAction}>UNDO</Text>
      </TouchableOpacity>}

      {memory&&<MemoryPopup memory={memory} onClose={()=>setMemory(null)} onDelete={m=>removeMemory(m)}/>}
    </View>
  );
}

// --- The rotatable persona sphere -------------------------------------------

function PersonaSphere({activeId,pics,onPick,onLaunch}){
  const[size,setSize]=useState({w:Dimensions.get('window').width,h:340});
  const[group,setGroup]=useState([]);
  const[order,setOrder]=useState(()=>PERSONA_LIST.map((_,i)=>i));
  const theta=useRef(new Animated.Value(0.4)).current;
  const thetaStart=useRef(0.4);
  const pulse=useRef(new Animated.Value(0)).current;

  // Keep front-facing orbs rendered last so taps land on the one you see.
  useEffect(()=>{
    let last=0;
    const id=theta.addListener(({value})=>{
      const now=Date.now();
      if(now-last<170)return;last=now;
      const cz=Math.cos(value),sz=Math.sin(value);
      const idxs=PERSONA_LIST.map((_,i)=>i).sort((a,b)=>
        (-SPHERE_PTS[a].x*sz+SPHERE_PTS[a].z*cz)-(-SPHERE_PTS[b].x*sz+SPHERE_PTS[b].z*cz));
      setOrder(idxs);
    });
    return()=>theta.removeListener(id);
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{
    const loop=Animated.loop(Animated.sequence([
      Animated.timing(pulse,{toValue:1,duration:1600,easing:Easing.inOut(Easing.sin),useNativeDriver:false}),
      Animated.timing(pulse,{toValue:0,duration:1600,easing:Easing.inOut(Easing.sin),useNativeDriver:false}),
    ]));
    loop.start();
    return()=>loop.stop();
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  const pan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponder:()=>false,
    onMoveShouldSetPanResponder:(e,g)=>(!e.nativeEvent.touches||e.nativeEvent.touches.length<2)&&(Math.abs(g.dx)>6||Math.abs(g.dy)>6),
    onPanResponderGrant:()=>{theta.stopAnimation(v=>{thetaStart.current=v;});},
    onPanResponderMove:(_,g)=>{theta.setValue(thetaStart.current-g.dx*0.010);},
    onPanResponderRelease:(_,g)=>{
      Animated.decay(theta,{velocity:-g.vx*0.010,deceleration:0.997,useNativeDriver:false}).start();
    },
  }),[]);// eslint-disable-line react-hooks/exhaustive-deps

  const RX=Math.min(size.w,520)*0.36;
  const RY=Math.min(size.w,size.h,520)*0.30;

  const orbs=useMemo(()=>{
    const cosT=theta.interpolate({inputRange:SAMP,outputRange:COS,extrapolate:'clamp'});
    const sinT=theta.interpolate({inputRange:SAMP,outputRange:SIN,extrapolate:'clamp'});
    const pulseScale=pulse.interpolate({inputRange:[0,1],outputRange:[0.98,1.04]});
    return PERSONA_LIST.map((p,i)=>{
      const pt=SPHERE_PTS[i];
      const rotX=Animated.add(Animated.multiply(cosT,pt.x),Animated.multiply(sinT,pt.z));
      const rotZ=Animated.add(Animated.multiply(sinT,-pt.x),Animated.multiply(cosT,pt.z));
      const depthScale=rotZ.interpolate({inputRange:[-1,1],outputRange:[0.55,1.12],extrapolate:'clamp'});
      return{
        p,
        translateX:Animated.multiply(rotX,RX),
        translateY:pt.y*RY,
        scale:Animated.multiply(depthScale,pulseScale),
        opacity:rotZ.interpolate({inputRange:[-1,1],outputRange:[0.28,1],extrapolate:'clamp'}),
      };
    });
  },[theta,pulse,RX,RY]);

  const toggle=useCallback((id)=>setGroup(g=>g.includes(id)?g.filter(x=>x!==id):[...g,id]),[]);

  return(
    <View style={{flex:1}} onLayout={e=>{const{width,height}=e.nativeEvent.layout;setSize({w:width,h:height});}}>
      <View style={StyleSheet.absoluteFill} {...pan.panHandlers}>
        {order.map(oi=>orbs[oi]).map(({p,translateX,translateY,scale,opacity})=>(
          <Animated.View key={p.id} style={[s.orbWrap,{opacity,transform:[{translateX},{translateY},{scale}]}]}>
            <TouchableOpacity activeOpacity={0.8} delayLongPress={280}
              onPress={()=>onPick(p.id)} onLongPress={()=>toggle(p.id)}
              style={[s.orb,{borderColor:p.color,backgroundColor:p.color+(group.includes(p.id)?'33':p.id===activeId?'26':'14')}]}>
              {pics[p.id]
                ?<Image source={{uri:pics[p.id]}} style={s.orbImg}/>
                :<Text style={[s.orbIcon,{color:p.color}]}>{p.icon}</Text>}
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

  orbWrap:{position:'absolute',left:'50%',top:'44%',marginLeft:-32,marginTop:-32,width:64,height:64},
  orb:{width:64,height:64,borderRadius:32,borderWidth:1.5,alignItems:'center',justifyContent:'center',overflow:'hidden'},
  orbImg:{width:'100%',height:'100%'},
  orbIcon:{fontFamily:'monospace',fontSize:15,fontWeight:'700'},
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
