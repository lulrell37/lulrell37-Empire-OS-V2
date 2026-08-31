// The persona Brain — every memory this persona holds, laid out as a network:
// a central core, one hub per keyword category, and one node per stored
// exchange orbiting its hub. The brain literally grows as more memories land.
// Tap any node to read that memory in full, verbatim.
import React,{useState,useEffect,useMemo,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Modal,ScrollView,ActivityIndicator}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import Svg,{Circle,Line,G,Text as SvgText}from 'react-native-svg';
import{getMemoriesByPersona,deletePersonaMemory}from '../services/database';
import{CATEGORIES,categoryMeta}from '../services/memoryCategories';
import{getPersona}from '../personas/personas';

const GOLDEN=2.399963229728653;

export default function BrainScreen({navigation,route}){
  const personaId=route?.params?.persona||'jarvis';
  const persona=getPersona(personaId);
  const[memories,setMemories]=useState(null);
  const[selected,setSelected]=useState(null);
  const[focusCat,setFocusCat]=useState(null); // category key to isolate, or null
  const[zoom,setZoom]=useState(1);

  useEffect(()=>{let alive=true;(async()=>{
    try{const m=await getMemoriesByPersona(personaId);if(alive)setMemories(m||[]);}
    catch{if(alive)setMemories([]);}
  })();return()=>{alive=false;};},[personaId]);

  const groups=useMemo(()=>{
    if(!memories)return[];
    const by={};
    for(const m of memories){const k=m.category||'personal';(by[k]||(by[k]=[])).push(m);}
    return CATEGORIES
      .filter(c=>by[c.key]?.length)
      .map(c=>({...c,memories:by[c.key],count:by[c.key].length}));
  },[memories]);

  const total=memories?.length||0;

  // Layout geometry — everything scales off the category count and the biggest hub.
  const layout=useMemo(()=>{
    if(!groups.length)return null;
    const maxCount=Math.max(...groups.map(g=>g.count));
    const spreadOf=(count)=>34+Math.sqrt(count)*22;
    const hubRing=140+groups.length*10+Math.sqrt(maxCount)*10;
    const pad=spreadOf(maxCount)+70;
    const size=Math.max(360,(hubRing+pad)*2);
    const cx=size/2,cy=size/2;
    const hubs=groups.map((g,i)=>{
      const a=(i/groups.length)*Math.PI*2-Math.PI/2;
      const hx=cx+Math.cos(a)*hubRing;
      const hy=cy+Math.sin(a)*hubRing;
      const shown=g.memories.slice(0,300); // cap rendered nodes for perf; count stays full
      const spread=spreadOf(shown.length);
      const nodes=shown.map((m,j)=>{
        const r=spread*Math.sqrt((j+0.55)/shown.length);
        const na=j*GOLDEN+a;
        return{m,x:hx+Math.cos(na)*r,y:hy+Math.sin(na)*r,rad:4.2+Math.min(3.5,70/shown.length)};
      });
      return{...g,hx,hy,hubRad:5+Math.sqrt(g.count)*1.6,nodes};
    });
    return{size,cx,cy,hubs,coreRad:20+Math.log2(total+1)*3};
  },[groups,total]);

  const onNode=useCallback((m)=>setSelected(m),[]);
  const removeMemory=useCallback((id)=>{
    deletePersonaMemory(id).catch(()=>{});
    setMemories(prev=>(prev||[]).filter(m=>m.id!==id));
    setSelected(null);
  },[]);

  if(memories===null)return(
    <SafeAreaView style={s.c} edges={['top','bottom']}>
      <Header persona={persona} navigation={navigation}/>
      <View style={s.center}><ActivityIndicator color={persona.color}/></View>
    </SafeAreaView>
  );

  return(
    <SafeAreaView style={s.c} edges={['top','bottom']}>
      <Header persona={persona} navigation={navigation}/>
      <View style={s.statsRow}>
        <Text style={[s.statBig,{color:persona.color}]}>{total}</Text>
        <Text style={s.statLabel}>MEMOR{total===1?'Y':'IES'}</Text>
        <Text style={s.statDot}>·</Text>
        <Text style={[s.statBig,{color:persona.color}]}>{groups.length}</Text>
        <Text style={s.statLabel}>REGION{groups.length===1?'':'S'}</Text>
      </View>

      {total===0?(
        <View style={s.center}>
          <Text style={s.empty}>{persona.name} has no memories yet.{'\n'}Talk to {persona.name} and this brain fills in.</Text>
        </View>
      ):(
        <>
          <ScrollView style={{flex:1}} contentContainerStyle={s.scrollPad} showsVerticalScrollIndicator={false}>
            <ScrollView horizontal contentContainerStyle={s.scrollPad} showsHorizontalScrollIndicator={false}>
              {layout&&<Svg width={layout.size*zoom} height={layout.size*zoom}>
                <G scale={zoom}>
                  {/* core -> hub links */}
                  {layout.hubs.map(h=>(
                    <Line key={'l'+h.key} x1={layout.cx} y1={layout.cy} x2={h.hx} y2={h.hy}
                      stroke={h.color} strokeWidth={1} opacity={focusCat&&focusCat!==h.key?0.06:0.28}/>
                  ))}
                  {/* hub -> node links + nodes */}
                  {layout.hubs.map(h=>{
                    const dim=focusCat&&focusCat!==h.key;
                    return(
                      <G key={'g'+h.key} opacity={dim?0.1:1}>
                        {h.nodes.map((n,i)=>(
                          <Line key={'nl'+i} x1={h.hx} y1={h.hy} x2={n.x} y2={n.y} stroke={h.color} strokeWidth={0.6} opacity={0.35}/>
                        ))}
                        {h.nodes.map((n,i)=>(
                          <Circle key={'n'+i} cx={n.x} cy={n.y} r={n.rad} fill={h.color} opacity={0.9}
                            onPress={()=>onNode(n.m)}/>
                        ))}
                        <Circle cx={h.hx} cy={h.hy} r={h.hubRad} fill={h.color}
                          onPress={()=>setFocusCat(focusCat===h.key?null:h.key)}/>
                        <SvgText x={h.hx} y={h.hy-h.hubRad-6} fill={h.color} fontSize={9} fontFamily="monospace"
                          textAnchor="middle" opacity={dim?0.3:0.9}>{`${h.label.toUpperCase()} ${h.count}`}</SvgText>
                      </G>
                    );
                  })}
                  {/* core */}
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} fill={persona.color} opacity={0.16}/>
                  <Circle cx={layout.cx} cy={layout.cy} r={layout.coreRad} stroke={persona.color} strokeWidth={1.5} fill="none"/>
                  <SvgText x={layout.cx} y={layout.cy+4} fill={persona.color} fontSize={13} fontWeight="700"
                    fontFamily="monospace" textAnchor="middle">{persona.icon}</SvgText>
                </G>
              </Svg>}
            </ScrollView>
          </ScrollView>

          <View style={s.legend}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:6,paddingHorizontal:12}}>
              {groups.map(g=>(
                <TouchableOpacity key={g.key} style={[s.chip,{borderColor:g.color+(focusCat===g.key?'':'44')},focusCat===g.key&&{backgroundColor:g.color+'1A'}]}
                  onPress={()=>setFocusCat(focusCat===g.key?null:g.key)}>
                  <View style={[s.chipDot,{backgroundColor:g.color}]}/>
                  <Text style={[s.chipT,{color:focusCat===g.key?g.color:'#666'}]}>{g.label} {g.count}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={s.zoomRow}>
              <TouchableOpacity style={s.zoomBtn} onPress={()=>setZoom(z=>Math.max(1,+(z-0.25).toFixed(2)))}><Text style={s.zoomT}>−</Text></TouchableOpacity>
              <TouchableOpacity style={s.zoomBtn} onPress={()=>setZoom(z=>Math.min(2.5,+(z+0.25).toFixed(2)))}><Text style={s.zoomT}>+</Text></TouchableOpacity>
            </View>
          </View>
        </>
      )}

      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={()=>setSelected(null)}>
        <View style={s.modalOver}>
          <View style={s.modalCard}>
            <View style={s.modalHdr}>
              {selected&&(()=>{const cm=categoryMeta(selected.category);return(
                <Text style={[s.modalCat,{color:cm.color,borderColor:cm.color+'55'}]}>{cm.label.toUpperCase()}</Text>
              );})()}
              <Text style={s.modalDate}>{selected?.date}</Text>
              <TouchableOpacity onPress={()=>setSelected(null)}><Text style={s.modalX}>×</Text></TouchableOpacity>
            </View>
            <ScrollView style={{maxHeight:'70%'}} contentContainerStyle={{padding:16}}>
              <Text style={s.modalBody} selectable>{selected?.content}</Text>
            </ScrollView>
            <TouchableOpacity style={s.modalDel} onPress={()=>selected&&removeMemory(selected.id)}>
              <Text style={s.modalDelT}>DELETE THIS MEMORY</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Header({persona,navigation}){
  return(
    <View style={s.hdr}>
      <TouchableOpacity onPress={()=>navigation.goBack()}><Text style={s.back}>←</Text></TouchableOpacity>
      <Text style={[s.title,{color:persona.color}]}>{persona.name} · BRAIN</Text>
      <View style={{width:26}}/>
    </View>
  );
}

const s=StyleSheet.create({
  c:{flex:1,backgroundColor:'#000'},
  center:{flex:1,alignItems:'center',justifyContent:'center',padding:24},
  empty:{fontFamily:'monospace',fontSize:11,color:'#333',textAlign:'center',lineHeight:20,letterSpacing:1},
  hdr:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:16,paddingVertical:12,borderBottomWidth:1,borderBottomColor:'#0D0D0D'},
  back:{fontSize:20,color:'#E8C98A'},
  title:{fontFamily:'monospace',fontSize:12,fontWeight:'700',letterSpacing:3},
  statsRow:{flexDirection:'row',alignItems:'baseline',justifyContent:'center',gap:6,paddingVertical:8},
  statBig:{fontFamily:'monospace',fontSize:16,fontWeight:'700'},
  statLabel:{fontFamily:'monospace',fontSize:8,color:'#444',letterSpacing:2},
  statDot:{color:'#333',fontSize:12,marginHorizontal:4},
  scrollPad:{alignItems:'center',justifyContent:'center',minWidth:'100%',minHeight:'100%'},
  legend:{borderTopWidth:1,borderTopColor:'#0D0D0D',paddingVertical:8,flexDirection:'row',alignItems:'center'},
  chip:{flexDirection:'row',alignItems:'center',gap:5,borderWidth:1,borderRadius:4,paddingHorizontal:8,paddingVertical:4},
  chipDot:{width:6,height:6,borderRadius:3},
  chipT:{fontFamily:'monospace',fontSize:8,letterSpacing:1},
  zoomRow:{flexDirection:'row',gap:4,paddingHorizontal:10},
  zoomBtn:{width:28,height:28,borderRadius:4,borderWidth:1,borderColor:'#222',alignItems:'center',justifyContent:'center'},
  zoomT:{color:'#888',fontSize:16,fontFamily:'monospace'},
  modalOver:{flex:1,backgroundColor:'rgba(0,0,0,0.9)',justifyContent:'center',padding:20},
  modalCard:{backgroundColor:'#0A0A0A',borderWidth:1,borderColor:'#1A1A1A',borderRadius:12,overflow:'hidden'},
  modalHdr:{flexDirection:'row',alignItems:'center',gap:10,padding:12,borderBottomWidth:1,borderBottomColor:'#141414'},
  modalCat:{fontFamily:'monospace',fontSize:8,letterSpacing:1,borderWidth:1,borderRadius:3,paddingHorizontal:5,paddingVertical:1},
  modalDate:{fontFamily:'monospace',fontSize:9,color:'#444',flex:1},
  modalX:{color:'#666',fontSize:22,lineHeight:22},
  modalBody:{color:'#CCC',fontSize:14,lineHeight:22},
  modalDel:{borderTopWidth:1,borderTopColor:'#141414',paddingVertical:13,alignItems:'center'},
  modalDelT:{fontFamily:'monospace',fontSize:9,color:'#C7614B',letterSpacing:2},
});
