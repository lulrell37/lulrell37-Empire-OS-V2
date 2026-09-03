// Live board of build requests. Reads the local build_jobs table (CommandScreen's
// poller keeps it current against GitHub). Shown for J.A.R.V.I.S. (app changes)
// and, filtered to the active client project, for A.R.A. Mirrors TradePanel.
import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{getActiveBuildJobs}from '../../services/database';

const POLL_MS=5000;

// Ordered phases for the stepper. `question` sits on top of `working`.
const PHASES=[
  {key:'queued',label:'FILED'},
  {key:'working',label:'BUILDING'},
  {key:'pr_open',label:'PR READY'},
  {key:'pushed',label:'SHIPPED'},
];
const PHASE_INDEX={queued:0,working:1,question:1,pr_open:2,merging:2,pushed:3};

const STATE_LABEL={
  queued:'QUEUED',working:'WORKING',question:'NEEDS YOU',
  pr_open:'PR READY',merging:'MERGING…',pushed:'PUSHED',failed:'FAILED',
};
const STATE_COLOR={
  queued:'#8A7A55',working:'#D9A441',question:'#C7614B',
  pr_open:'#5FA779',merging:'#D9A441',pushed:'#5FA779',failed:'#C7614B',
};

function elapsed(ms){
  if(!ms)return '';
  const s=Math.max(0,Math.floor((Date.now()-ms)/1000));
  if(s<60)return `${s}s`;
  const m=Math.floor(s/60);
  if(m<60)return `${m}m`;
  return `${Math.floor(m/60)}h ${m%60}m`;
}

function Stepper({state,accent}){
  const cur=PHASE_INDEX[state]??0;
  return(
    <View style={s.stepRow}>
      {PHASES.map((p,i)=>(
        <React.Fragment key={p.key}>
          {i>0&&<View style={[s.stepBar,i<=cur&&{backgroundColor:accent||'#5FA779'}]}/>}
          <View style={s.step}>
            <View style={[s.stepDot,i<cur&&{backgroundColor:accent||'#5FA779',borderColor:accent||'#5FA779'},i===cur&&{borderColor:accent||'#D9A441'}]}/>
            <Text style={[s.stepLabel,i===cur&&{color:accent||'#D9A441'}]}>{p.label}</Text>
          </View>
        </React.Fragment>
      ))}
    </View>
  );
}

export default function BuildPanel({active,onMerge,onCancel,filter,title='BUILD',accent}){
  const[jobs,setJobs]=useState([]);
  const[,setTick]=useState(0);
  const[collapsed,setCollapsed]=useState(false);
  const alive=useRef(true);

  const load=useCallback(async()=>{
    try{
      let j=await getActiveBuildJobs();
      if(typeof filter==='function')j=j.filter(filter);
      if(alive.current)setJobs(j);
    }catch{}
  },[filter]);

  useEffect(()=>{
    alive.current=true;
    if(active){
      load();
      const iv=setInterval(load,POLL_MS);
      const tk=setInterval(()=>setTick(t=>t+1),1000); // keep the elapsed timers moving
      return()=>{alive.current=false;clearInterval(iv);clearInterval(tk);};
    }
    return()=>{alive.current=false;};
  },[active,load]);

  if(!jobs.length)return null;

  return(
    <View style={[s.wrap,accent&&{borderColor:accent+'33'}]}>
      <TouchableOpacity style={s.hdr} activeOpacity={0.7} onPress={()=>setCollapsed(c=>!c)}>
        <Text style={[s.hdrLabel,accent&&{color:accent}]}>◆ {title} · {jobs.length} OPEN</Text>
        <Text style={s.hdrChevron}>{collapsed?'▸':'▾'}</Text>
      </TouchableOpacity>
      {!collapsed&&jobs.map(j=>(
        <View key={j.id||j.issue_number} style={s.row}>
          <View style={s.rowTop}>
            <Text style={[s.state,{color:STATE_COLOR[j.state]||'#888'}]}>{STATE_LABEL[j.state]||j.state?.toUpperCase()}</Text>
            <Text style={s.issue}>#{j.issue_number}{j.pr_number?` · PR #${j.pr_number}`:''}{j.state&&j.state!=='pushed'?` · ${elapsed(j.created_at)}`:''}</Text>
            <TouchableOpacity onPress={()=>onCancel?.(j.id||j.issue_number)} hitSlop={{top:8,bottom:8,left:8,right:8}}>
              <Text style={s.x}>✕</Text>
            </TouchableOpacity>
          </View>
          {j.repo_name&&j.repo_name!=='lulrell37-Empire-OS-V2'&&<Text style={s.repo}>{j.repo_owner}/{j.repo_name}</Text>}
          <Text style={s.title} numberOfLines={2}>{j.title||j.spec||''}</Text>
          <Stepper state={j.state} accent={accent}/>
          {j.state==='question'&&!!j.question&&<Text style={s.q} numberOfLines={4}>{j.question}</Text>}
          {j.state==='pr_open'&&<TouchableOpacity style={[s.merge,accent&&{borderColor:accent+'55'}]} onPress={()=>onMerge?.(j.id||j.issue_number)}>
            <Text style={[s.mergeT,accent&&{color:accent}]}>MERGE & SHIP</Text>
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
  repo:{fontFamily:'monospace',fontSize:8,color:'#5a5145'},
  x:{fontFamily:'monospace',fontSize:10,color:'#5a5145'},
  title:{fontFamily:'monospace',fontSize:10,color:'#B7AC97',lineHeight:14},
  q:{fontFamily:'monospace',fontSize:9,color:'#C7614B',lineHeight:13,marginTop:2},
  merge:{alignSelf:'flex-start',marginTop:6,borderWidth:1,borderColor:'#5FA77955',borderRadius:4,paddingHorizontal:10,paddingVertical:4},
  mergeT:{fontFamily:'monospace',fontSize:8,color:'#5FA779',letterSpacing:1.5},
  stepRow:{flexDirection:'row',alignItems:'center',marginTop:6,marginBottom:2},
  step:{alignItems:'center',gap:3},
  stepDot:{width:8,height:8,borderRadius:4,borderWidth:1.5,borderColor:'#3a352c',backgroundColor:'#0c0b09'},
  stepLabel:{fontFamily:'monospace',fontSize:6.5,color:'#5a5145',letterSpacing:0.5},
  stepBar:{flex:1,height:1.5,backgroundColor:'#2a2620',marginHorizontal:3,marginBottom:9},
});
