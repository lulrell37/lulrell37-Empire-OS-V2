// The orb screen as one continuous zoom. Pinch out (or +) drills in:
//   orb  ->  memory regions  ->  one region's memories  ->  a single memory
// Pinch in (or -) backs out the same way; pinching in from the orb calls
// onZoomOut (the all-personas / group view). No tap-to-open — depth is the UI,
// though tapping a region or a memory jumps straight to it.
import React,{useState,useEffect,useMemo,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView,ActivityIndicator}from 'react-native';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import Animated,{useSharedValue,useAnimatedStyle,withTiming,runOnJS}from 'react-native-reanimated';
import PersonaOrb from './PersonaOrb';
import Boundary from '../hud/Boundary';
import{getMemoriesByPersona,deletePersonaMemory}from '../../services/database';
import{CATEGORIES,categoryMeta}from '../../services/memoryCategories';
import{getPersona,PERSONA_LIST}from '../../personas/personas';

const LEVELS=['group','orb','regions','region','memory'];

export default function OrbZoom({personaId,color,active,vizRef,personaPics={},onPickPersona}){
  const persona=getPersona(personaId);
  const[memories,setMemories]=useState(null);
  const[level,setLevel]=useState('orb');
  const[regionKey,setRegionKey]=useState(null);
  const[memory,setMemory]=useState(null);
  const pinch=useSharedValue(1);

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

  const animStyle=useAnimatedStyle(()=>({transform:[{scale:Math.min(1.6,Math.max(0.6,pinch.value))}]}));

  function removeMemory(id){
    deletePersonaMemory(id).catch(()=>{});
    setMemories(prev=>(prev||[]).filter(m=>m.id!==id));
    setMemory(null);setLevel('region');
  }

  const idx=LEVELS.indexOf(level);

  return(
    <View style={s.wrap}>
      <GestureDetector gesture={gesture}>
        <Animated.View style={[{flex:1},animStyle]}>
          {level==='group'&&(
            <GroupView activeId={personaId} pics={personaPics} onPick={id=>{onPickPersona?.(id);setLevel('orb');}}/>
          )}

          {level==='orb'&&(
            <Boundary label="The visualization"><PersonaOrb viz={vizRef} color={color} active={active}/></Boundary>
          )}

          {level==='regions'&&(
            <RegionsView persona={persona} groups={groups} onPick={k=>{setRegionKey(k);setLevel('region');}}/>
          )}

          {level==='region'&&(
            <RegionView persona={persona} group={groups.find(g=>g.key===regionKey)} memories={regionMemories}
              onPick={m=>{setMemory(m);setLevel('memory');}}/>
          )}

          {level==='memory'&&memory&&(
            <MemoryView persona={persona} memory={memory} onDelete={()=>removeMemory(memory.id)}/>
          )}

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

function GroupView({activeId,pics,onPick}){
  return(
    <ScrollView contentContainerStyle={s.groupPad}>
      {PERSONA_LIST.map(p=>{
        const on=p.id===activeId;
        return(
          <TouchableOpacity key={p.id} style={[s.gOrb,{borderColor:p.color,backgroundColor:p.color+(on?'2A':'12')}]} onPress={()=>onPick(p.id)}>
            <Text style={[s.gIcon,{color:p.color}]}>{p.icon}</Text>
            <Text style={s.gName} numberOfLines={1}>{p.name.replace(/\./g,'')}</Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
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
  groupPad:{flexDirection:'row',flexWrap:'wrap',justifyContent:'center',alignItems:'center',gap:14,padding:24,paddingTop:48},
  gOrb:{width:82,height:82,borderRadius:41,borderWidth:1.5,alignItems:'center',justifyContent:'center'},
  gIcon:{fontFamily:'monospace',fontSize:16,fontWeight:'700'},
  gName:{fontFamily:'monospace',fontSize:6,color:'#888',letterSpacing:1,marginTop:3},
});
