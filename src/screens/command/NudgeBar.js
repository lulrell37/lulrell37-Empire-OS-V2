// Slim proactive-nudge strip on the Command screen. Refreshes when the screen
// gains focus. Dismissals are session-only — they come back next launch if still
// true.
import React,{useState,useEffect}from 'react';
import{View,Text,StyleSheet,ScrollView,TouchableOpacity}from 'react-native';
import{computeNudges}from '../../services/nudges';

export default function NudgeBar({active}){
  const[nudges,setNudges]=useState([]);
  const[dismissed,setDismissed]=useState({});

  useEffect(()=>{
    let alive=true;
    if(active)computeNudges().then(n=>{if(alive)setNudges(n);}).catch(()=>{});
    return()=>{alive=false;};
  },[active]);

  const shown=nudges.filter(n=>!dismissed[n.key]);
  if(!shown.length)return null;

  return(
    <View style={s.wrap}>
      <Text style={s.bell}>◈</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.row}>
        {shown.map(n=>(
          <TouchableOpacity key={n.key} style={s.chip} activeOpacity={0.7} onPress={()=>setDismissed(d=>({...d,[n.key]:true}))}>
            <Text style={s.chipT}>{n.text}</Text>
            <Text style={s.chipX}>×</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{flexDirection:'row',alignItems:'center',gap:8,paddingHorizontal:12,paddingVertical:5,borderBottomWidth:1,borderBottomColor:'#141210',backgroundColor:'#0A0806'},
  bell:{color:'#D9A441',fontSize:10},
  row:{flexDirection:'row',gap:6,alignItems:'center'},
  chip:{flexDirection:'row',alignItems:'center',gap:6,borderWidth:1,borderColor:'#D9A44133',borderRadius:4,paddingHorizontal:8,paddingVertical:3},
  chipT:{fontFamily:'monospace',fontSize:8,color:'#D9A441',letterSpacing:0.5},
  chipX:{fontFamily:'monospace',fontSize:10,color:'#6b5a30'},
});
