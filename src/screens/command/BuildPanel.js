// Live board of JARVIS build requests, shown on the Command screen while JARVIS
// is active. Reads the local build_jobs table (CommandScreen's poller keeps it
// current against GitHub). Mirrors TradePanel.
import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{getActiveBuildJobs}from '../../services/database';

const POLL_MS=5000;

const STATE_LABEL={
  queued:'QUEUED',working:'WORKING',question:'NEEDS YOU',
  pr_open:'PR READY',merging:'MERGING…',pushed:'PUSHED',
};
const STATE_COLOR={
  queued:'#8A7A55',working:'#D9A441',question:'#C7614B',
  pr_open:'#5FA779',merging:'#D9A441',pushed:'#5FA779',
};

export default function BuildPanel({active,onMerge,onCancel}){
  const[jobs,setJobs]=useState([]);
  const[collapsed,setCollapsed]=useState(false);
  const alive=useRef(true);

  const load=useCallback(async()=>{
    try{const j=await getActiveBuildJobs();if(alive.current)setJobs(j);}catch{}
  },[]);

  useEffect(()=>{
    alive.current=true;
    if(active){load();const iv=setInterval(load,POLL_MS);return()=>{alive.current=false;clearInterval(iv);};}
    return()=>{alive.current=false;};
  },[active,load]);

  if(!jobs.length)return null;

  return(
    <View style={s.wrap}>
      <TouchableOpacity style={s.hdr} activeOpacity={0.7} onPress={()=>setCollapsed(c=>!c)}>
        <Text style={s.hdrLabel}>◆ BUILD · {jobs.length} OPEN</Text>
        <Text style={s.hdrChevron}>{collapsed?'▸':'▾'}</Text>
      </TouchableOpacity>
      {!collapsed&&jobs.map(j=>(
        <View key={j.issue_number} style={s.row}>
          <View style={s.rowTop}>
            <Text style={[s.state,{color:STATE_COLOR[j.state]||'#888'}]}>{STATE_LABEL[j.state]||j.state?.toUpperCase()}</Text>
            <Text style={s.issue}>#{j.issue_number}{j.pr_number?` · PR #${j.pr_number}`:''}</Text>
            <TouchableOpacity onPress={()=>onCancel?.(j.issue_number)} hitSlop={{top:8,bottom:8,left:8,right:8}}>
              <Text style={s.x}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={s.title} numberOfLines={2}>{j.title||j.spec||''}</Text>
          {j.state==='question'&&!!j.question&&<Text style={s.q} numberOfLines={4}>{j.question}</Text>}
          {j.state==='pr_open'&&<TouchableOpacity style={s.merge} onPress={()=>onMerge?.(j.issue_number)}>
            <Text style={s.mergeT}>MERGE & SHIP</Text>
          </TouchableOpacity>}
        </View>
      ))}
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{marginHorizontal:10,marginTop:4,borderWidth:1,borderColor:'#1F1B14',borderRadius:8,backgroundColor:'#080706',overflow:'hidden'},
  hdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:12,paddingVertical:8},
  hdrLabel:{fontFamily:'monospace',fontSize:9,color:'#D4A017',letterSpacing:2},
  hdrChevron:{fontFamily:'monospace',fontSize:9,color:'#555'},
  row:{paddingHorizontal:12,paddingVertical:8,borderTopWidth:1,borderTopColor:'#141210',gap:4},
  rowTop:{flexDirection:'row',alignItems:'center',gap:8},
  state:{fontFamily:'monospace',fontSize:8,fontWeight:'700',letterSpacing:1},
  issue:{fontFamily:'monospace',fontSize:8,color:'#666',flex:1},
  x:{fontFamily:'monospace',fontSize:10,color:'#5a5145'},
  title:{fontFamily:'monospace',fontSize:10,color:'#B7AC97',lineHeight:14},
  q:{fontFamily:'monospace',fontSize:9,color:'#C7614B',lineHeight:13,marginTop:2},
  merge:{alignSelf:'flex-start',marginTop:6,borderWidth:1,borderColor:'#5FA77955',borderRadius:4,paddingHorizontal:10,paddingVertical:4},
  mergeT:{fontFamily:'monospace',fontSize:8,color:'#5FA779',letterSpacing:1.5},
});
