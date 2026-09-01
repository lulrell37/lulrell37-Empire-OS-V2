// The persona Brain, as a network: a central core, one hub per keyword category,
// and one node per stored exchange orbiting its hub. Tap a node to open it.
// Ported from the retired standalone BrainScreen — it now lives as a level
// inside the orb's continuous zoom (OrbZoom), so no header / nav / SafeArea here.
import React,{useState,useMemo,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ScrollView,ActivityIndicator}from 'react-native';
import Svg,{Circle,Line,G,Text as SvgText}from 'react-native-svg';
import{CATEGORIES,categoryMeta}from '../../services/memoryCategories';

const GOLDEN=2.399963229728653;

export default function BrainWeb({persona,memories,focusCat=null,onNode}){
  const[localFocus,setLocalFocus]=useState(null);
  const[zoom,setZoom]=useState(1);
  const focus=focusCat||localFocus;

  const groups=useMemo(()=>{
    if(!memories)return[];
    const by={};
    for(const m of memories){const k=m.category||'personal';(by[k]||(by[k]=[])).push(m);}
    return CATEGORIES.filter(c=>by[c.key]?.length).map(c=>({...c,memories:by[c.key],count:by[c.key].length}));
  },[memories]);

  const total=memories?.length||0;

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
      const shown=g.memories.slice(0,300);
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

  const toggleFocus=useCallback((k)=>{if(focusCat)return;setLocalFocus(f=>f===k?null:k);},[focusCat]);

  if(memories==null)return(<View style={s.center}><ActivityIndicator color={persona.color}/></View>);

  if(total===0)return(
    <View style={s.center}>
      <Text style={s.empty}>{persona.name} has no memories yet.{'\n'}Talk to {persona.name} and this brain fills in.</Text>
    </View>
  );

  return(
    <View style={{flex:1}}>
      <View style={s.statsRow}>
        <Text style={[s.statBig,{color:persona.color}]}>{total}</Text>
        <Text style={s.statLabel}>MEMOR{total===1?'Y':'IES'}</Text>
        <Text style={s.statDot}>·</Text>
        <Text style={[s.statBig,{color:persona.color}]}>{groups.length}</Text>
        <Text style={s.statLabel}>REGION{groups.length===1?'':'S'}</Text>
      </View>

      <ScrollView style={{flex:1}} contentContainerStyle={s.scrollPad} showsVerticalScrollIndicator={false}>
        <ScrollView horizontal contentContainerStyle={s.scrollPad} showsHorizontalScrollIndicator={false}>
          {layout&&<Svg width={layout.size*zoom} height={layout.size*zoom}>
            <G scale={zoom}>
              {layout.hubs.map(h=>(
                <Line key={'l'+h.key} x1={layout.cx} y1={layout.cy} x2={h.hx} y2={h.hy}
                  stroke={h.color} strokeWidth={1} opacity={focus&&focus!==h.key?0.05:0.28}/>
              ))}
              {layout.hubs.map(h=>{
                const dim=focus&&focus!==h.key;
                return(
                  <G key={'g'+h.key} opacity={dim?0.08:1}>
                    {h.nodes.map((n,i)=>(
                      <Line key={'nl'+i} x1={h.hx} y1={h.hy} x2={n.x} y2={n.y} stroke={h.color} strokeWidth={0.6} opacity={0.35}/>
                    ))}
                    {h.nodes.map((n,i)=>(
                      <Circle key={'n'+i} cx={n.x} cy={n.y} r={n.rad} fill={h.color} opacity={0.9} onPress={()=>onNode&&onNode(n.m)}/>
                    ))}
                    <Circle cx={h.hx} cy={h.hy} r={h.hubRad} fill={h.color} onPress={()=>toggleFocus(h.key)}/>
                    <SvgText x={h.hx} y={h.hy-h.hubRad-6} fill={h.color} fontSize={9} fontFamily="monospace"
                      textAnchor="middle" opacity={dim?0.3:0.9}>{`${h.label.toUpperCase()} ${h.count}`}</SvgText>
                  </G>
                );
              })}
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
            <TouchableOpacity key={g.key} style={[s.chip,{borderColor:g.color+(focus===g.key?'':'44')},focus===g.key&&{backgroundColor:g.color+'1A'}]}
              onPress={()=>toggleFocus(g.key)}>
              <View style={[s.chipDot,{backgroundColor:g.color}]}/>
              <Text style={[s.chipT,{color:focus===g.key?g.color:'#666'}]}>{g.label} {g.count}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        <View style={s.zoomRow}>
          <TouchableOpacity style={s.zoomBtn} onPress={()=>setZoom(z=>Math.max(1,+(z-0.25).toFixed(2)))}><Text style={s.zoomT}>−</Text></TouchableOpacity>
          <TouchableOpacity style={s.zoomBtn} onPress={()=>setZoom(z=>Math.min(2.5,+(z+0.25).toFixed(2)))}><Text style={s.zoomT}>+</Text></TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const s=StyleSheet.create({
  center:{flex:1,alignItems:'center',justifyContent:'center',padding:24},
  empty:{fontFamily:'monospace',fontSize:11,color:'#333',textAlign:'center',lineHeight:20,letterSpacing:1},
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
});
