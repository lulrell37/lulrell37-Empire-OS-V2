// The orb screen as one continuous zoom. Pinch out (or +) drills in:
//   group -> orb -> memory regions -> one region -> a single memory
// Pinch in (or -) backs out the same way. In the group level, tap a persona to
// make it active, or drag personas down into the tray to build a custom group.
import React,{useState,useEffect,useMemo,useCallback,useRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView,ActivityIndicator,Dimensions}from 'react-native';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import Animated,{useSharedValue,useAnimatedStyle,withTiming,withSpring,runOnJS,Easing}from 'react-native-reanimated';
import PersonaOrb from './PersonaOrb';
import Boundary from '../hud/Boundary';
import{getMemoriesByPersona,deletePersonaMemory}from '../../services/database';
import{CATEGORIES,categoryMeta}from '../../services/memoryCategories';
import{getPersona,PERSONA_LIST}from '../../personas/personas';

const LEVELS=['group','orb','regions','region','memory'];

export default function OrbZoom({personaId,color,active,vizRef,personaPics={},onPickPersona,onLaunchGroup}){
  const persona=getPersona(personaId);
  const[memories,setMemories]=useState(null);
  const[level,setLevel]=useState('orb');
  const[regionKey,setRegionKey]=useState(null);
  const[memory,setMemory]=useState(null);
  const pinch=useSharedValue(1);
  const enter=useSharedValue(1); // 0 -> 1 on every level change
  const dir=useSharedValue(1);   // 1 = went deeper, -1 = went shallower

  // Zoom-morph each time the level changes: incoming content starts scaled
  // (small when drilling in, large when backing out) and settles to 1x.
  useEffect(()=>{
    enter.value=0;
    enter.value=withTiming(1,{duration:260,easing:Easing.out(Easing.cubic)});
  },[level,regionKey,memory?.id]);// eslint-disable-line react-hooks/exhaustive-deps

  const reload=useCallback(()=>{getMemoriesByPersona(personaId).then(m=>setMemories(m||[])).catch(()=>setMemories([]));},[personaId]);
  useEffect(()=>{setLevel('orb');setRegionKey(null);setMemory(null);setMemories(null);reload();},[personaId,reload]);
  useEffect(()=>{if(level==='regions')reload();},[level,reload]);

  const groups=useMemo(()=>{
    const by={};
    for(const m of memories||[]){const k=m.category||'personal';(by[k]||(by[k]=[])).push(m);}
    return CATEGORIES.filter(c=>by[c.key]?.length).map(c=>({...c,memories:by[c.key],count:by[c.key].length}));
  },[memories]);

  const regionMemories=useMemo(()=>groups.find(g=>g.key===regionKey)?.memories||[],[groups,regionKey]);

  const deeper=useCallback(()=>{
    dir.value=1;
    setLevel(cur=>{
      if(cur==='group')return 'orb';
      if(cur==='orb')return groups.length?'regions':'orb';
      if(cur==='regions'){
        const g=groups.find(x=>x.key===regionKey)||groups[0];
        if(!g)return 'regions';
        setRegionKey(g.key);return 'region';
      }
      if(cur==='region'){
        const first=(groups.find(x=>x.key===regionKey)?.memories||[])[0];
        if(!first)return 'region';
        setMemory(first);return 'memory';
      }
      return cur;
    });
  },[groups,regionKey]);

  const shallower=useCallback(()=>{
    dir.value=-1;
    setLevel(cur=>{
      if(cur==='memory')return 'region';
      if(cur==='region')return 'regions';
      if(cur==='regions')return 'orb';
      if(cur==='orb')return 'group';
      return 'group';
    });
  },[]);

  const gesture=useMemo(()=>Gesture.Pinch()
    .onUpdate(e=>{pinch.value=e.scale;})
    .onEnd(()=>{
      const sc=pinch.value;
      pinch.value=withTiming(1,{duration:180});
      if(sc>1.3)runOnJS(deeper)();
      else if(sc<0.78)runOnJS(shallower)();
    }),[deeper,shallower]);// eslint-disable-line react-hooks/exhaustive-deps

  // live pinch scale on the whole stage
  const animStyle=useAnimatedStyle(()=>({transform:[{scale:Math.min(1.6,Math.max(0.6,pinch.value))}]}));
  // per-level zoom-morph
  const layerStyle=useAnimatedStyle(()=>{
    const from=dir.value>0?0.66:1.34;
    return{opacity:0.1+0.9*enter.value,transform:[{scale:from+(1-from)*enter.value}]};
  });

  function removeMemory(id){
    dir.value=-1;
    deletePersonaMemory(id).catch(()=>{});
    setMemories(prev=>(prev||[]).filter(m=>m.id!==id));
    setMemory(null);setLevel('region');
  }

  const idx=LEVELS.indexOf(level);

  return(
    <View style={s.wrap}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[{flex:1},animStyle]}>
          <Animated.View key={level+':'+(regionKey||'')+':'+(memory?.id||'')} style={[{flex:1},layerStyle]}>
            {level==='group'&&(
              <GroupView activeId={personaId} pics={personaPics}
                onPick={id=>{dir.value=1;onPickPersona?.(id);setLevel('orb');}}
                onLaunch={ids=>{onLaunchGroup?.(ids);}}/>
            )}

            {level==='orb'&&(
              <Boundary label="The visualization"><PersonaOrb viz={vizRef} color={color} active={active}/></Boundary>
            )}

            {level==='regions'&&(
              <RegionsView persona={persona} groups={groups} onPick={k=>{dir.value=1;setRegionKey(k);setLevel('region');}}/>
            )}

            {level==='region'&&(
              <RegionView persona={persona} group={groups.find(g=>g.key===regionKey)} memories={regionMemories}
                onPick={m=>{dir.value=1;setMemory(m);setLevel('memory');}}/>
            )}

            {level==='memory'&&memory&&(
              <MemoryView persona={persona} memory={memory} onDelete={()=>removeMemory(memory.id)}/>
            )}
          </Animated.View>

          {memories===null&&level!=='orb'&&level!=='group'&&<View style={s.loading}><ActivityIndicator color={color}/></View>}
        </Animated.View>
      </GestureDetector>

      {/* depth rail + controls */}
      <View style={s.rail} pointerEvents="box-none">
        <Text style={[s.railLabel,{color}]}>
          {level==='group'?'ALL PERSONAS'
            :level==='orb'?persona.name
            :level==='regions'?`${persona.name} · ${groups.length} REGION${groups.length===1?'':'S'}`
            :level==='region'?`${categoryMeta(regionKey).label.toUpperCase()} · ${regionMemories.length}`
            :memory?.date||''}
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
      {level==='group'&&<Text style={[s.hint,{color}]} pointerEvents="none">◈ TAP A PERSONA · PINCH OUT TO GO BACK</Text>}
    </View>
  );
}

function GroupView({activeId,pics,onPick,onLaunch}){
  const[group,setGroup]=useState([]);
  const trayRef=useRef(null);
  const dropY=useRef(Dimensions.get('window').height-150);

  const add=useCallback(id=>setGroup(g=>g.includes(id)?g:[...g,id]),[]);
  const remove=useCallback(id=>setGroup(g=>g.filter(x=>x!==id)),[]);

  return(
    <View style={{flex:1}}>
      <ScrollView contentContainerStyle={s.groupPad}>
        {PERSONA_LIST.map(p=>(
          <DraggableOrb key={p.id} p={p} on={p.id===activeId} inGroup={group.includes(p.id)}
            getDropY={()=>dropY.current} onTap={onPick} onDropIn={add}/>
        ))}
      </ScrollView>

      <View ref={trayRef} onLayout={()=>{trayRef.current?.measureInWindow?.((x,y)=>{if(y)dropY.current=y;});}} style={s.tray}>
        <Text style={s.trayLabel}>CUSTOM GROUP · drag orbs here</Text>
        <View style={s.trayChips}>
          {group.length===0&&<Text style={s.trayEmpty}>—</Text>}
          {group.map(id=>{const p=getPersona(id);return(
            <TouchableOpacity key={id} style={[s.chip,{borderColor:p.color}]} onPress={()=>remove(id)}>
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

function DraggableOrb({p,on,inGroup,getDropY,onTap,onDropIn}){
  const tx=useSharedValue(0),ty=useSharedValue(0),sc=useSharedValue(1);
  const pan=useMemo(()=>Gesture.Pan()
    .onUpdate(e=>{tx.value=e.translationX;ty.value=e.translationY;sc.value=1.18;})
    .onEnd(e=>{
      const dropped=e.absoluteY>getDropY();
      if(dropped)runOnJS(onDropIn)(p.id);
      else if(Math.abs(e.translationX)<8&&Math.abs(e.translationY)<8)runOnJS(onTap)(p.id);
      tx.value=withSpring(0);ty.value=withSpring(0);sc.value=withTiming(1);
    }),[p.id,onTap,onDropIn]);// eslint-disable-line react-hooks/exhaustive-deps
  const st=useAnimatedStyle(()=>({transform:[{translateX:tx.value},{translateY:ty.value},{scale:sc.value}],zIndex:sc.value>1?20:1,elevation:sc.value>1?20:1}));
  return(
    <GestureDetector gesture={pan}>
      <Animated.View style={[s.gOrb,{borderColor:p.color,backgroundColor:p.color+(inGroup?'33':on?'22':'12')},st]}>
        <Text style={[s.gIcon,{color:p.color}]}>{p.icon}</Text>
        <Text style={s.gName} numberOfLines={1}>{p.name.replace(/\./g,'')}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function RegionsView({persona,groups,onPick}){
  return(
    <View style={s.center}>
      <View style={[s.coreMini,{borderColor:persona.color}]}><Text style={[s.coreT,{color:persona.color}]}>{persona.icon}</Text></View>
      <View style={s.regionWrap}>
        {groups.map(g=>{
          const size=44+Math.min(46,Math.sqrt(g.count)*12);
          return(
            <TouchableOpacity key={g.key} style={[s.region,{width:size,height:size,borderRadius:size/2,borderColor:g.color,backgroundColor:g.color+'18'}]} onPress={()=>onPick(g.key)}>
              <Text style={[s.regionN,{color:g.color}]}>{g.count}</Text>
              <Text style={s.regionL} numberOfLines={1}>{g.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

function RegionView({persona,group,memories,onPick}){
  const c=group?categoryMeta(group.key):{color:persona.color,label:''};
  return(
    <ScrollView contentContainerStyle={s.listPad}>
      {memories.map(m=>(
        <TouchableOpacity key={m.id} style={[s.memRow,{borderLeftColor:c.color}]} onPress={()=>onPick(m)}>
          <Text style={s.memRowDate}>{m.date}</Text>
          <Text style={s.memRowPreview} numberOfLines={2}>{m.content}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function MemoryView({persona,memory,onDelete}){
  const cm=categoryMeta(memory.category);
  return(
    <View style={s.memWrap}>
      <View style={s.memHead}>
        <Text style={[s.memTag,{color:cm.color,borderColor:cm.color+'55'}]}>{cm.label.toUpperCase()}</Text>
        <Text style={s.memDate}>{memory.date}</Text>
      </View>
      <ScrollView style={{flex:1}} contentContainerStyle={{padding:18}}>
        <Text style={s.memText} selectable>{memory.content}</Text>
      </ScrollView>
      <TouchableOpacity style={s.del} onPress={onDelete}><Text style={s.delT}>DELETE THIS MEMORY</Text></TouchableOpacity>
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{flex:1},
  center:{flex:1,alignItems:'center',justifyContent:'center',padding:20},
  loading:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center'},
  rail:{position:'absolute',top:12,left:0,right:0,alignItems:'center'},
  railLabel:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:3},
  dots:{flexDirection:'row',gap:5,marginTop:6},
  dot:{width:5,height:5,borderRadius:2.5,backgroundColor:'#222'},
  zoomCtl:{position:'absolute',right:12,bottom:16,gap:8},
  zBtn:{width:34,height:34,borderRadius:6,borderWidth:1,borderColor:'#222',backgroundColor:'rgba(0,0,0,0.5)',alignItems:'center',justifyContent:'center'},
  zT:{color:'#999',fontSize:18,fontFamily:'monospace'},
  hint:{position:'absolute',bottom:16,left:0,right:0,textAlign:'center',fontFamily:'monospace',fontSize:8,letterSpacing:2,opacity:0.5},
  coreMini:{width:54,height:54,borderRadius:27,borderWidth:1.5,alignItems:'center',justifyContent:'center',marginBottom:18},
  coreT:{fontFamily:'monospace',fontSize:15,fontWeight:'700'},
  regionWrap:{flexDirection:'row',flexWrap:'wrap',justifyContent:'center',alignItems:'center',gap:12,maxWidth:340},
  region:{borderWidth:1,alignItems:'center',justifyContent:'center',padding:4},
  regionN:{fontFamily:'monospace',fontSize:13,fontWeight:'700'},
  regionL:{fontFamily:'monospace',fontSize:6,color:'#999',letterSpacing:1},
  listPad:{padding:12,paddingTop:44,gap:8},
  memRow:{borderWidth:1,borderColor:'#141210',borderLeftWidth:3,borderRadius:6,backgroundColor:'#080706',padding:12},
  memRowDate:{fontFamily:'monospace',fontSize:8,color:'#444',marginBottom:4},
  memRowPreview:{color:'#999',fontSize:12,lineHeight:18},
  memWrap:{flex:1,paddingTop:36},
  memHead:{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:16},
  memTag:{fontFamily:'monospace',fontSize:8,letterSpacing:1,borderWidth:1,borderRadius:3,paddingHorizontal:5,paddingVertical:1},
  memDate:{fontFamily:'monospace',fontSize:9,color:'#444'},
  memText:{color:'#CCC',fontSize:14,lineHeight:22},
  del:{borderTopWidth:1,borderTopColor:'#141414',paddingVertical:13,alignItems:'center'},
  delT:{fontFamily:'monospace',fontSize:9,color:'#C7614B',letterSpacing:2},
  groupPad:{flexDirection:'row',flexWrap:'wrap',justifyContent:'center',alignItems:'center',gap:14,padding:20,paddingTop:44,paddingBottom:120},
  gOrb:{width:76,height:76,borderRadius:38,borderWidth:1.5,alignItems:'center',justifyContent:'center'},
  gIcon:{fontFamily:'monospace',fontSize:15,fontWeight:'700'},
  gName:{fontFamily:'monospace',fontSize:6,color:'#888',letterSpacing:1,marginTop:3},
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
