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
import PersonaOrb from './PersonaOrb';
import MemorySpiral from './MemorySpiral';
import MemoryPopup from './MemoryPopup';
import Boundary from '../hud/Boundary';
import{getMemoriesByPersona,deletePersonaMemory}from '../../services/database';
import{getPersona,PERSONA_LIST}from '../../personas/personas';

const LEVELS=['group','orb','memory'];
const WHEEL_MID=600;// px of scroll slack on each side of the invisible wheel-catcher

const SAMP=[],SIN=[],COS=[];
for(let k=0;k<=480;k++){const v=-12*Math.PI+(24*Math.PI)*(k/480);SAMP.push(v);SIN.push(Math.sin(v));COS.push(Math.cos(v));}

const SPHERE_PTS=PERSONA_LIST.map((_,i)=>{
  const n=PERSONA_LIST.length;
  const y=1-(i/((n-1)||1))*2;
  const r=Math.sqrt(Math.max(0,1-y*y));
  const th=i*2.399963229728653;
  return{x:Math.cos(th)*r,y,z:Math.sin(th)*r};
});

function touchDist(t){return Math.hypot(t[0].pageX-t[1].pageX,t[0].pageY-t[1].pageY);}

export default function OrbZoom({personaId,color,active,vizRef,personaPics={},onPickPersona,onLaunchGroup,onZoomOut,level='group',onLevelChange}){
  const persona=getPersona(personaId);
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

  const stagePan=useMemo(()=>PanResponder.create({
    onStartShouldSetPanResponderCapture:(e)=>!!e.nativeEvent.touches&&e.nativeEvent.touches.length===2&&levelRef.current!=='memory',
    onMoveShouldSetPanResponderCapture:(e)=>!!e.nativeEvent.touches&&e.nativeEvent.touches.length===2&&levelRef.current!=='memory',
    onPanResponderGrant:(e)=>{
      const t=e.nativeEvent.touches;
      if(t&&t.length===2){
        const d=touchDist(t);pinchRef.current={d0:d,d1:d};
        pinchScale.stopAnimation();pinchTX.stopAnimation();pinchTY.stopAnimation();
        centroidRef.current={
          x:(t[0].pageX+t[1].pageX)/2-originRef.current.x,
          y:(t[0].pageY+t[1].pageY)/2-originRef.current.y,
        };
      }
    },
    onPanResponderMove:(e)=>{
      const t=e.nativeEvent.touches;
      if(t&&t.length===2){
        pinchRef.current.d1=touchDist(t);
        const sc=Math.max(0.55,Math.min(1.8,pinchRef.current.d1/pinchRef.current.d0));
        pinchScale.setValue(sc);
        const c=centroidRef.current||{x:0,y:0};
        pinchTX.setValue((c.x-sizeRef.current.w/2)*(1-sc));
        pinchTY.setValue((c.y-sizeRef.current.h/2)*(1-sc));
      }
    },
    onPanResponderRelease:()=>{
      const{d0,d1}=pinchRef.current;
      pinchRef.current={d0:0,d1:0};
      const r=(d0>0&&d1>0)?d1/d0:1;
      if(r>1.20){deeper(centroidRef.current);}
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
          showsVerticalScrollIndicator={false} scrollEventThrottle={16}
          contentOffset={{x:0,y:WHEEL_MID}} onScroll={onWheelScroll}
          onContentSizeChange={()=>{wheelY.current=WHEEL_MID;wheelScrollRef.current&&wheelScrollRef.current.scrollTo({y:WHEEL_MID,animated:false});}}/>
      )}
      <Animated.View style={{flex:1,opacity:morph.opacity,transform:[{translateX:pinchTX},{translateY:pinchTY},{scale:contentScale}]}}>
        {level==='group'&&(
          <PersonaSphere ref={sphereRef} activeId={personaId} pics={personaPics} onPick={pick} onLaunch={launch}/>
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

// --- The rotatable persona sphere -------------------------------------------

function PersonaSphereInner({activeId,pics,onPick,onLaunch},ref){
  const[size,setSize]=useState({w:Dimensions.get('window').width,h:340});
  const[group,setGroup]=useState([]);
  const[order,setOrder]=useState(()=>PERSONA_LIST.map((_,i)=>i));
  const theta=useRef(new Animated.Value(0.4)).current;
  const phi=useRef(new Animated.Value(0.15)).current;
  const tStart=useRef(0.4),pStart=useRef(0.15);
  const tNow=useRef(0.4),pNow=useRef(0.15);
  const sizeRef=useRef(size);
  const sparkles=useRef(PERSONA_LIST.map(()=>new Animated.Value(Math.random()))).current;

  useEffect(()=>{sizeRef.current=size;},[size]);

  useEffect(()=>{
    let last=0;
    const onMove=({value},which)=>{
      if(which==='t')tNow.current=value;else pNow.current=value;
      const now=Date.now();if(now-last<150)return;last=now;
      const t=tNow.current,p=pNow.current;
      const ct=Math.cos(t),st=Math.sin(t),cp=Math.cos(p),sp=Math.sin(p);
      const z=(i)=>{const pt=SPHERE_PTS[i];const z1=-st*pt.x+ct*pt.z;return sp*pt.y+cp*z1;};
      setOrder(PERSONA_LIST.map((_,i)=>i).sort((a,b)=>z(a)-z(b)));
    };
    const idT=theta.addListener(e=>onMove(e,'t'));
    const idP=phi.addListener(e=>onMove(e,'p'));
    return()=>{theta.removeListener(idT);phi.removeListener(idP);};
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

  const RX=Math.min(size.w,520)*0.36;
  const RY=Math.min(size.w,size.h,520)*0.32;

  // pickAt(x,y): the orb nearest that screen point (front hemisphere), or the
  // frontmost one when no point is given.
  useImperativeHandle(ref,()=>({
    pickAt(x,y){
      const t=tNow.current,p=pNow.current;
      const ct=Math.cos(t),st=Math.sin(t),cp=Math.cos(p),sp=Math.sin(p);
      const cx=sizeRef.current.w/2,cy=sizeRef.current.h*0.42;
      let best=PERSONA_LIST[0].id,score=-Infinity;
      for(let i=0;i<PERSONA_LIST.length;i++){
        const pt=SPHERE_PTS[i];
        const x1=ct*pt.x+st*pt.z;
        const z1=-st*pt.x+ct*pt.z;
        const y2=cp*pt.y-sp*z1;
        const z2=sp*pt.y+cp*z1;
        let sc;
        if(x==null){sc=z2;}
        else{
          if(z2<-0.2)continue;
          const sx=cx+x1*RX,sy=cy+y2*RY;
          sc=z2*140-Math.hypot(sx-x,sy-y);
        }
        if(sc>score){score=sc;best=PERSONA_LIST[i].id;}
      }
      return best;
    },
  }),[RX,RY]);

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
      return{
        p,
        translateX:Animated.multiply(x1,RX),
        translateY:Animated.multiply(y2,RY),
        scale:Animated.multiply(
          z2.interpolate({inputRange:[-1,1],outputRange:[0.5,1.15],extrapolate:'clamp'}),
          sparkles[i].interpolate({inputRange:[0,1],outputRange:[0.9,1.12]})),
        opacity:Animated.multiply(
          z2.interpolate({inputRange:[-1,1],outputRange:[0.22,1],extrapolate:'clamp'}),
          sparkles[i].interpolate({inputRange:[0,1],outputRange:[0.55,1]})),
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
              <View style={[s.orbGlow,{backgroundColor:p.color+'20'}]}>
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
        <Text style={s.trayLabel}>CUSTOM GROUP</Text>
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
const PersonaSphere=forwardRef(PersonaSphereInner);

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
