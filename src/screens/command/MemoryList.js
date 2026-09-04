// The list view of a persona's memory — the calm twin of the spiral graph.
// Same data, same tap target (onNode). Grouped by day, newest first, with a
// coloured category rail on every card.
import React,{useMemo}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity}from 'react-native';
import{categoryMeta}from '../../services/memoryCategories';
import{colors,space,radius,FONTS}from '../../theme';

function dayLabel(d){
  if(!d)return'';
  const t=new Date(d+'T00:00:00');
  if(isNaN(t))return String(d).toUpperCase();
  const now=new Date();now.setHours(0,0,0,0);
  const diff=Math.round((now-t)/86400000);
  if(diff<=0)return'TODAY';
  if(diff===1)return'YESTERDAY';
  if(diff<7)return diff+' DAYS AGO';
  return t.toLocaleDateString(undefined,{month:'short',day:'numeric',year:t.getFullYear()===now.getFullYear()?undefined:'numeric'}).toUpperCase();
}

// Memory rows are stored as "YOU: …\nPERSONA: …". Show the two sides cleanly.
function previews(content){
  const raw=String(content||'').trim();
  const m=raw.match(/^\s*(?:YOU|USER)\s*:\s*([\s\S]*?)(?:\n\s*[A-Z][A-Za-z.\s]{1,20}:\s*([\s\S]*))?$/);
  if(m)return{you:(m[1]||'').replace(/\s+/g,' ').trim(),reply:(m[2]||'').replace(/\s+/g,' ').trim()};
  return{you:'',reply:raw.replace(/\s+/g,' ').trim()};
}

export default function MemoryList({memories,onNode,filter}){
  const sections=useMemo(()=>{
    const list=(memories||[]).filter(m=>!filter||(m.category||'personal')===filter);
    const by={};
    for(const m of list)(by[m.date||'']||(by[m.date||'']=[])).push(m);
    return Object.keys(by).sort((a,b)=>b.localeCompare(a)).map(d=>({day:d,items:by[d]}));
  },[memories,filter]);

  if(!sections.length)return(
    <View style={s.empty}><Text style={s.emptyT}>Nothing here yet.</Text></View>
  );

  return(
    <ScrollView style={{flex:1}} contentContainerStyle={s.pad} showsVerticalScrollIndicator={false}>
      {sections.map(sec=>(
        <View key={sec.day||'undated'} style={s.section}>
          <Text style={s.dayLabel}>{dayLabel(sec.day)}</Text>
          {sec.items.map(m=>{
            const cm=categoryMeta(m.category);
            const p=previews(m.content);
            const pinned=m.pinned_until&&m.pinned_until>Date.now();
            return(
              <TouchableOpacity key={m.id} activeOpacity={0.75} style={s.card} onPress={()=>onNode&&onNode(m)}>
                <View style={[s.rail,{backgroundColor:pinned?'#E8C98A':cm.color}]}/>
                <View style={s.cardBody}>
                  <View style={s.cardHead}>
                    <Text style={[s.cat,{color:cm.color}]}>{cm.label.toUpperCase()}</Text>
                    {pinned&&<Text style={s.pin}>  📌 {Math.max(1,Math.ceil((m.pinned_until-Date.now())/86400000))}d</Text>}
                  </View>
                  {!!p.you&&<Text style={s.you} numberOfLines={2}>{p.you}</Text>}
                  {!!p.reply&&<Text style={s.reply} numberOfLines={p.you?2:3}>{p.reply}</Text>}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}
      <View style={{height:space.xxl}}/>
    </ScrollView>
  );
}

const s=StyleSheet.create({
  pad:{paddingHorizontal:space.lg,paddingTop:space.sm},
  section:{marginBottom:space.lg},
  dayLabel:{fontFamily:FONTS.mono,fontSize:8,letterSpacing:3,color:colors.textDim,marginBottom:space.sm,marginLeft:2},
  card:{flexDirection:'row',backgroundColor:colors.surfaceRaised,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.md,overflow:'hidden',marginBottom:space.sm},
  rail:{width:3},
  cardBody:{flex:1,paddingVertical:space.md,paddingHorizontal:space.md,gap:5},
  cardHead:{flexDirection:'row',alignItems:'center'},
  cat:{fontFamily:FONTS.monoMed,fontSize:7.5,letterSpacing:2},
  pin:{fontFamily:FONTS.mono,fontSize:7.5,letterSpacing:1,color:'#E8C98A'},
  you:{fontFamily:FONTS.mono,fontSize:12,lineHeight:17,color:colors.text},
  reply:{fontFamily:FONTS.mono,fontSize:11,lineHeight:16,color:colors.textMuted},
  empty:{flex:1,alignItems:'center',justifyContent:'center',padding:space.xxl},
  emptyT:{fontFamily:FONTS.mono,fontSize:10,letterSpacing:1,color:colors.textFaint},
});
