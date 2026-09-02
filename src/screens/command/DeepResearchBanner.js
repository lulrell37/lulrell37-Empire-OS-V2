// The strip shown while a Deep Research job runs. Owns its own 1-second clock so
// the elapsed time ticks without re-rendering the whole Command screen.
import React,{useState,useEffect}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ActivityIndicator}from 'react-native';
import{getPersona}from '../../personas/personas';
import{drElapsedLabel}from '../../services/deepResearch';

export default function DeepResearchBanner({job,onDismiss}){
  const[,tick]=useState(0);
  useEffect(()=>{
    const iv=setInterval(()=>tick(c=>c+1),1000);
    return()=>clearInterval(iv);
  },[]);
  if(!job)return null;

  const name=getPersona(job.persona||'ara').name;
  const pr=job.progressObj||{};
  const detail=[
    pr.searches?`${pr.searches} search${pr.searches===1?'':'es'}`:null,
    pr.step||job.topic,
  ].filter(Boolean).join(' · ');

  return(
    <View style={s.card}>
      <ActivityIndicator size="small" color="#5B8DEF"/>
      <View style={{flex:1}}>
        <Text style={s.title} numberOfLines={1}>DEEP RESEARCH · {name} · {drElapsedLabel(job.started_at)}</Text>
        <Text style={s.sub} numberOfLines={1}>{detail}</Text>
      </View>
      <TouchableOpacity onPress={onDismiss} hitSlop={{top:10,bottom:10,left:10,right:10}}>
        <Text style={s.x}>×</Text>
      </TouchableOpacity>
    </View>
  );
}

const s=StyleSheet.create({
  card:{flexDirection:'row',alignItems:'center',gap:10,marginHorizontal:10,marginTop:4,paddingHorizontal:12,paddingVertical:8,borderWidth:1,borderColor:'#1E2740',borderRadius:8,backgroundColor:'#070A10'},
  title:{fontFamily:'monospace',fontSize:9,color:'#5B8DEF',letterSpacing:1},
  sub:{fontFamily:'monospace',fontSize:8,color:'#4A5A7A',letterSpacing:0.5,marginTop:2},
  x:{color:'#555',fontSize:18,lineHeight:18},
});
