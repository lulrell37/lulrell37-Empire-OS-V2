// The orb screen as one continuous zoom. Pinch out (or +, or scroll up) drills
// in:  persona globe -> a persona's orb -> its memory web -> one region hub.
// Pinch in (or -, or scroll down) backs out the same way.
//
//  - GROUP: every persona as an orb on one rotatable ball. Drag empty space to
//    spin it; tap an orb to make that persona active; drag an orb down into the
//    tray to build a custom group.
//  - ORB:   the persona visualization (PersonaOrb).
//  - BRAIN: the full memory network (BrainWeb). Tap a node -> a small popup.
//  - HUB:   the brain isolated to one category.
import React,{useState,useEffect,useMemo,useCallback,useRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ActivityIndicator,Dimensions,Platform}from 'react-native';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import Animated,{useSharedValue,useAnimatedStyle,withTiming,withSpring,withDecay,withRepeat,runOnJS,Easing}from 'react-native-reanimated';
import PersonaOrb from './PersonaOrb';
import BrainWeb from './BrainWeb';
import MemoryPopup from './MemoryPopup';
import Boundary from '../hud/Boundary';
import{getMemoriesByPersona,deletePersonaMemory}from '../../services/database';
import{categoryMeta}from '../../services/memoryCategories';
import{getPersona,PERSONA_LIST}from '../../personas/personas';

const LEVELS=['group','orb','brain','hub'];

// Personas distributed once on a unit sphere (Fibonacci) for the globe picker.
const GLOBE_PTS=PERSONA_LIST.map((_,i)=>{
  const n=PERSONA_LIST.length;
  const y=1-(i/((n-1)||1))*2;
  const r=Math.sqrt(Math.max(0,1-y*y));
  const th=i*2.399963229728653;
  return{x:Math.cos(th)*r,y,z:Math.sin(th)*r};
});

export default function OrbZoom({personaId,color,active,vizRef,personaPics={},onPickPersona,onLaunchGroup}){
  const persona=getPersona(personaId);
  const[memories,setMemories]=useState(null);
  const[level,setLevel]=useState('orb');
  const[hubKey,setHubKey]=useState(null);
  const[memory,setMemory]=useState(null);
  const[undo,setUndo]=useState(null);
  const undoTimer=useRef(null);
  const pendingRef=useRef(null);
  const wrapRef=useRef(null);
  const wheelAcc=useRef(0);
  const pinch=useSharedValue(1);
  const enter=useSharedValue(1);
  const dir=useSharedValue(1);

  useEffect(()=>{
    enter.value=0;
    enter.value=withTiming(1,{duration:260,easing:Easing.out(Easing.cubic)});
  },[level,hubKey]);// eslint-disable-line react-hooks/exhaustive-deps

  const reload=useCallback(()=>{getMemoriesByPersona(personaId).then(m=>setMemories(m||[])).catch(()=>setMemories([]));},[personaId]);
  useEffect(()=>{setLevel('orb');setHubKey(null);setMemory(null);setMemories(null);reload();},[personaId,reload]);
  useEffect(()=>{if(level==='brain'||level==='hub')reload();},[level,reload]);

  // commit any pending delete if we unmount before the undo window closes
  useEffect(()=>()=>{
    if(undoTimer.current){clearTimeout(undoTimer.current);if(pendingRef.current)deletePersonaMemory(pendingRef.current.id).catch(()=>{});}
  },[]);

  const groupKeys=useMemo(()=>{
    const set=new Set();
    for(const m of memories||[])set.add(m.category||'personal');
    return [...set];
  },[memories]);

  const deeper=useCallback(()=>{
    dir.value=1;
    setLevel(cur=>{
      if(cur==='group')return 'orb';
      if(cur==='orb')return 'brain';
      if(cur==='brain'){
        if(!groupKeys.length)return 'brain';
        setHubKey(k=>k||groupKeys[0]);
        return 'hub';
      }
      return cur;
    });
  },[groupKeys]);// eslint-disable-line react-hooks/exhaustive-deps

  const shallower=useCallback(()=>{
    dir.value=-1;
    setLevel(cur=>{
      if(cur==='hub')return 'brain';
      if(cur==='brain')return 'orb';
      if(cur==='orb')return 'group';
      return 'group';
    });
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  const gesture=useMemo(()=>Gesture.Pinch()
    .onUpdate(e=>{pinch.value=e.scale;})
    .onEnd(()=>{
      const sc=pinch.value;
      pinch.value=withTiming(1,{duration:180});
      if(sc>1.3)runOnJS(deeper)();
      else if(sc<0.78)runOnJS(shallower)();
    }),[deeper,shallower]);// eslint-disable-line react-hooks/exhaustive-deps

  // Mouse wheel / trackpad on web drives the same zoom.
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

  const animStyle=useAnimatedStyle(()=>({transform:[{scale:Math.min(1.6,Math.max(0.6,pinch.value))}]}));
  const layerStyle=useAnimatedStyle(()=>{
    const from=dir.value>0?0.66:1.34;
    return{opacity:0.1+0.9*enter.value,transform:[{scale:from+(1-from)*enter.value}]};
  });

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

  const pickPersona=useCallback((id)=>{dir.value=1;onPickPersona?.(id);setLevel('orb');},[onPickPersona]);// eslint-disable-line react-hooks/exhaustive-deps
  const launchGroup=useCallback((ids)=>{onLaunchGroup?.(ids);},[onLaunchGroup]);

  const idx=LEVELS.indexOf(level);

  return(
    <View ref={wrapRef} style={s.wrap}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[{flex:1},animStyle]}>
          <Animated.View key={level+':'+(hubKey||'')} style={[{flex:1},layerStyle]}>
            {level==='group'&&(
              <PersonaGlobe activeId={personaId} pics={personaPics}
                onPick={pickPersona} onLaunch={launchGroup}/>
            )}

            {level==='orb'&&(
              <Boundary label="The visualization"><PersonaOrb viz={vizRef} color={color} active={active}/></Boundary>
            )}

            {(level==='brain'||level==='hub')&&(
              <Boundary label="The memory web">
                <BrainWeb persona={persona} memories={memories}
                  focusCat={level==='hub'?hubKey:null}
                  onNode={m=>setMemory(m)}/>
              </Boundary>
            )}
          </Animated.View>

          {memories===null&&(level==='brain'||level==='hub')&&<View style={s.loading}><ActivityIndicator color={color}/></View>}
        </Animated.View>
      </GestureDetector>

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

      {level==='orb'&&<Text style={[s.hint,{color}]} pointerEvents="none">◈ ZOOM IN FOR MEMORY · ZOOM OUT FOR ALL PERSONAS</Text>}
      {level==='group'&&<Text style={[s.hint,{color}]} pointerEvents="none">◈ DRAG TO SPIN · TAP AN ORB · DRAG DOWN TO GROUP</Text>}

      {undo&&<TouchableOpacity style={s.undoBar} activeOpacity={0.8} onPress={undoMemory}>
        <Text style={s.undoT}>Memory deleted</Text>
        <Text style={s.undoAction}>UNDO</Text>
      </TouchableOpacity>}

      {memory&&<MemoryPopup memory={memory} onClose={()=>setMemory(null)} onDelete={m=>removeMemory(m)}/>}
    </View>
  );
}

// --- The rotatable persona globe -------------------------------------------

function PersonaGlobe({activeId,pics,onPick,onLaunch}){
  const rotY=useSharedValue(0);
  const rotX=useSharedValue(0.15);
  const dw=useSharedValue(Dimensions.get('window').width);
  const dh=useSharedValue(Dimensions.get('window').height*0.5);
  const shimmer=useSharedValue(0);
  const[group,setGroup]=useState([]);
  const trayRef=useRef(null);
  const dropY=useRef(Dimensions.get('window').height-150);

  useEffect(()=>{
    shimmer.value=withRepeat(withTiming(1,{duration:2600,easing:Easing.inOut(Easing.sin)}),-1,true);
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  const add=useCallback(id=>setGroup(g=>g.includes(id)?g:[...g,id]),[]);
  const remove=useCallback(id=>setGroup(g=>g.filter(x=>x!==id)),[]);

  const spin=useMemo(()=>Gesture.Pan()
    .onChange(e=>{
      rotY.value+=e.changeX*0.007;
      rotX.value=Math.max(-1.15,Math.min(1.15,rotX.value-e.changeY*0.006));
    })
    .onEnd(e=>{rotY.value=withDecay({velocity:e.velocityX*0.006,deceleration:0.997});}),[]);// eslint-disable-line react-hooks/exhaustive-deps

  return(
    <View style={{flex:1}} onLayout={e=>{const{width,height}=e.nativeEvent.layout;dw.value=width;dh.value=height;}}>
      <GestureDetector gesture={spin}>
        <View style={StyleSheet.absoluteFill}>
          {PERSONA_LIST.map((p,i)=>(
            <GlobeOrb key={p.id} p={p} i={i} pt={GLOBE_PTS[i]} on={p.id===activeId} inGroup={group.includes(p.id)}
              rotX={rotX} rotY={rotY} dw={dw} dh={dh} shimmer={shimmer}
              getDropY={()=>dropY.current} onTap={onPick} onDropIn={add}/>
          ))}
        </View>
      </GestureDetector>

      <View ref={trayRef} onLayout={()=>{trayRef.current?.measureInWindow?.((x,y)=>{if(y)dropY.current=y;});}} style={gs.tray}>
        <Text style={gs.trayLabel}>CUSTOM GROUP · drag orbs here</Text>
        <View style={gs.trayChips}>
          {group.length===0&&<Text style={gs.trayEmpty}>—</Text>}
          {group.map(id=>{const p=getPersona(id);return(
            <TouchableOpacity key={id} style={[gs.chip,{borderColor:p.color}]} onPress={()=>remove(id)}>
              <Text style={[gs.chipIcon,{color:p.color}]}>{p.icon}</Text>
              <Text style={gs.chipX}>×</Text>
            </TouchableOpacity>
          );})}
        </View>
        {group.length>=2&&<TouchableOpacity style={gs.launch} onPress={()=>onLaunch(group)}>
          <Text style={gs.launchT}>LAUNCH GROUP · {group.length}</Text>
        </TouchableOpacity>}
      </View>
    </View>
  );
}

function GlobeOrb({p,i,pt,on,inGroup,rotX,rotY,dw,dh,shimmer,getDropY,onTap,onDropIn}){
  const tx=useSharedValue(0),ty=useSharedValue(0),drag=useSharedValue(0);
  const pan=useMemo(()=>Gesture.Pan()
    .onUpdate(e=>{drag.value=1;tx.value=e.translationX;ty.value=e.translationY;})
    .onEnd(e=>{
      const dropped=e.absoluteY>getDropY();
      if(dropped)runOnJS(onDropIn)(p.id);
      else if(Math.abs(e.translationX)<8&&Math.abs(e.translationY)<8)runOnJS(onTap)(p.id);
      tx.value=withSpring(0);ty.value=withSpring(0);drag.value=0;
    }),[p.id,onTap,onDropIn]);// eslint-disable-line react-hooks/exhaustive-deps

  const st=useAnimatedStyle(()=>{
    const w=dw.value||300,h=dh.value||300;
    const R=Math.min(w,h)*0.36;
    const cy=Math.cos(rotY.value),sy=Math.sin(rotY.value);
    const x=pt.x*cy-pt.z*sy;
    const z=pt.x*sy+pt.z*cy;
    const cx2=Math.cos(rotX.value),sx=Math.sin(rotX.value);
    const y2=pt.y*cx2-z*sx;
    const z2=pt.y*sx+z*cx2;
    const depth=(z2+1)/2;          // 0 back .. 1 front
    const persp=0.62+0.38*depth;
    const twk=1+0.045*Math.sin(shimmer.value*6.283+i*1.7);
    return{
      opacity:drag.value?1:(0.3+0.7*depth),
      zIndex:drag.value?999:Math.round(depth*100),
      transform:[
        {translateX:x*R*persp+tx.value},
        {translateY:y2*R*persp+ty.value},
        {scale:(drag.value?1.22:(0.62+0.5*depth))*twk},
      ],
    };
  });

  return(
    <GestureDetector gesture={pan}>
      <Animated.View style={[gs.orb,{borderColor:p.color,backgroundColor:p.color+(inGroup?'33':on?'26':'14')},st]}>
        <Text style={[gs.orbIcon,{color:p.color}]}>{p.icon}</Text>
        <Text style={gs.orbName} numberOfLines={1}>{p.name.replace(/\./g,'')}</Text>
      </Animated.View>
    </GestureDetector>
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
});

const gs=StyleSheet.create({
  orb:{position:'absolute',left:'50%',top:'50%',marginLeft:-32,marginTop:-32,width:64,height:64,borderRadius:32,borderWidth:1.5,alignItems:'center',justifyContent:'center'},
  orbIcon:{fontFamily:'monospace',fontSize:14,fontWeight:'700'},
  orbName:{fontFamily:'monospace',fontSize:5,color:'#888',letterSpacing:1,marginTop:2},
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
