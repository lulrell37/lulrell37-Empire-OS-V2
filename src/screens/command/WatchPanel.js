// Live board of video-watch jobs. Reads the local watch_jobs table (CommandScreen's
// poller keeps it current against the GitHub issue queue in empire-video-watch).
// Shown for every persona in direct text mode — renders nothing when there are no
// active or recently-finished jobs. Mirrors ClipPanel.
import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import*as WebBrowser from 'expo-web-browser';
import{getWatchJobs,updateWatchJob}from '../../services/database';
import{cancelWatchJob}from '../../services/buildAgent';

const POLL_MS=5000;
const ACCENT='#6E56CF';

const LABEL={queued:'QUEUED',watching:'WATCHING',done:'DONE',failed:'FAILED',cancelled:'CANCELLED'};
const COLOR={queued:'#7A6DA8',watching:'#9B87E0',done:'#5FA779',failed:'#C7614B',cancelled:'#666'};

function elapsed(ms){
  if(!ms)return'';
  const s=Math.max(0,Math.floor((Date.now()-ms)/1000));
  if(s<60)return`${s}s`;
  const m=Math.floor(s/60);
  if(m<60)return`${m}m`;
  return`${Math.floor(m/60)}h ${m%60}m`;
}
const open=u=>{if(u)WebBrowser.openBrowserAsync(u).catch(()=>{});};

export default function WatchPanel({active}){
  const[jobs,setJobs]=useState([]);
  const[,setTick]=useState(0);
  const[collapsed,setCollapsed]=useState(false);
  const alive=useRef(true);

  const load=useCallback(async()=>{
    try{
      const all=await getWatchJobs(20);
      const cutoff=Date.now()-3600000; // finished within the last hour still shows
      const list=all.filter(j=>!['done','failed','cancelled'].includes(j.status)||(j.updated_at||0)>cutoff);
      if(alive.current)setJobs(list);
    }catch{}
  },[]);

  useEffect(()=>{
    alive.current=true;
    if(active){
      load();
      const iv=setInterval(load,POLL_MS);
      const tk=setInterval(()=>setTick(t=>t+1),1000);
      return()=>{alive.current=false;clearInterval(iv);clearInterval(tk);};
    }
    return()=>{alive.current=false;};
  },[active,load]);

  if(!jobs.length)return null;
  const openN=jobs.filter(j=>!['done','failed','cancelled'].includes(j.status)).length;

  return(
    <View style={[s.wrap,{borderColor:ACCENT+'33'}]}>
      <TouchableOpacity style={s.hdr} activeOpacity={0.7} onPress={()=>setCollapsed(c=>!c)}>
        <Text style={[s.hdrLabel,{color:ACCENT}]}>◆ WATCHING · {openN} IN FLIGHT</Text>
        <Text style={s.hdrChevron}>{collapsed?'▸':'▾'}</Text>
      </TouchableOpacity>
      {!collapsed&&jobs.map(j=>(
        <View key={j.id} style={s.row}>
          <View style={s.rowTop}>
            <Text style={[s.state,{color:COLOR[j.status]||'#888'}]}>{LABEL[j.status]||j.status?.toUpperCase()}</Text>
            <Text style={s.meta}>#{j.issue_number}{j.status==='queued'||j.status==='watching'?` · ${elapsed(j.created_at)}`:''}</Text>
            {(j.status==='queued'||j.status==='watching')&&(
              <TouchableOpacity onPress={()=>{cancelWatchJob(j.issue_number);updateWatchJob(j.id,{status:'cancelled'}).then(load);}} hitSlop={{top:8,bottom:8,left:8,right:8}}>
                <Text style={s.x}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
          <Text style={s.brief} numberOfLines={2}>{j.focus||'full breakdown'}</Text>
          {j.status==='done'&&!!j.summary&&<Text style={s.summary} numberOfLines={4}>{j.summary}</Text>}
          {j.status==='failed'&&!!j.note&&<Text style={s.err} numberOfLines={3}>{j.note}</Text>}
          {j.status==='done'&&!!j.report_url&&(
            <View style={s.btnRow}>
              <TouchableOpacity style={s.btn} onPress={()=>open(j.report_url)}><Text style={s.btnT}>READ REPORT</Text></TouchableOpacity>
              {!!j.media_url&&<TouchableOpacity style={s.btn} onPress={()=>open(j.media_url)}><Text style={s.btnT}>THE VIDEO</Text></TouchableOpacity>}
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{marginHorizontal:10,marginTop:4,borderWidth:1,borderRadius:8,backgroundColor:'#080706',overflow:'hidden'},
  hdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:12,paddingVertical:8},
  hdrLabel:{fontFamily:'monospace',fontSize:9,letterSpacing:2},
  hdrChevron:{fontFamily:'monospace',fontSize:9,color:'#555'},
  row:{paddingHorizontal:12,paddingVertical:8,borderTopWidth:1,borderTopColor:'#141210',gap:4},
  rowTop:{flexDirection:'row',alignItems:'center',gap:8},
  state:{fontFamily:'monospace',fontSize:8,fontWeight:'700',letterSpacing:1},
  meta:{fontFamily:'monospace',fontSize:8,color:'#666',flex:1},
  x:{fontFamily:'monospace',fontSize:10,color:'#5a5145'},
  brief:{fontFamily:'monospace',fontSize:10,color:'#B7AC97',lineHeight:14},
  summary:{fontFamily:'monospace',fontSize:9,color:'#9B87E0',lineHeight:13},
  err:{fontFamily:'monospace',fontSize:9,color:'#C7614B',lineHeight:13},
  btnRow:{flexDirection:'row',gap:8,marginTop:4},
  btn:{borderWidth:1,borderColor:ACCENT+'66',borderRadius:4,paddingHorizontal:12,paddingVertical:4},
  btnT:{fontFamily:'monospace',fontSize:8,color:ACCENT,letterSpacing:1.5},
});
