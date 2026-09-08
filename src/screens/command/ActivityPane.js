// The ◈ activity section of a persona's orb screen — the third view next to the
// visualization (◉) and the chat (≣). Every persona has one. It shows:
//   LIVE   — what this persona has running right now (the same rows the banner
//            shows: queue jobs, auto-agent cycles, relays, deep research)
//   board  — the persona's own panel, if it has one: T.A.L.O.N. trades,
//            S.C.O.U.T. pipeline, R.O.G.U.E. clips, J.A.R.V.I.S. / Firm builds
//   RECENT — a rolled-up log of this persona's finished work (deep research,
//            watch jobs, saved notes) from the last few days
// These boards used to stack on top of the chat; they live here instead.
import React,{useState,useEffect,useCallback}from 'react';
import{View,Text,StyleSheet,ScrollView}from 'react-native';
import{TRADER_ID}from '../../services/tradeJournal';
import{getPersonaActivity}from '../../services/database';
import TradePanel from './TradePanel';
import TradeStatus from '../../components/TradeStatus';
import TradeRecordBar from './TradeRecordBar';
import LeadsPanel from './LeadsPanel';
import ClipPanel from './ClipPanel';
import WatchPanel from './WatchPanel';
import BuildPanel from './BuildPanel';

const RECENT_WINDOW=1000*60*60*24*4;   // 4 days
const KIND_ICON={research:'🔍',watch:'▶',note:'✎'};
const STATUS_COLOR={running:'#D9A441',done:'#5FA779',failed:'#C7614B',cancelled:'#666',queued:'#8A7A55',editing:'#D9A441'};

function ago(ms){
  if(!ms)return'';
  const s=Math.max(0,Math.floor((Date.now()-ms)/1000));
  if(s<60)return`${s}s`;
  const m=Math.floor(s/60); if(m<60)return`${m}m`;
  const h=Math.floor(m/60); if(h<24)return`${h}h`;
  return`${Math.floor(h/24)}d`;
}

export default function ActivityPane({persona,activity=[],active,project,build={}}){
  const id=persona?.id;
  const col=persona?.color||'#E8C98A';
  const liveRows=activity.filter(a=>a&&a.persona===id);
  const isTrader=id===TRADER_ID;

  const[recent,setRecent]=useState([]);
  const load=useCallback(()=>{
    if(!id)return;
    getPersonaActivity(id,{sinceMs:RECENT_WINDOW,limit:20}).then(setRecent).catch(()=>setRecent([]));
  },[id]);
  useEffect(()=>{
    load();
    if(!active)return;
    const t=setInterval(load,15000);
    return()=>clearInterval(t);
  },[load,active]);

  return(
    <ScrollView style={{flex:1}} contentContainerStyle={s.pad} showsVerticalScrollIndicator={false}>
      <Text style={[s.hdr,{color:col}]}>{(persona?.name||'').replace(/\./g,'')} · ACTIVITY</Text>

      <Text style={s.section}>LIVE</Text>
      {liveRows.length>0?(
        <View style={s.list}>
          {liveRows.map(a=>(
            <View key={a.key} style={[s.row,{borderColor:col+'44'}]}>
              <View style={[s.dot,{backgroundColor:col}]}/>
              <Text style={s.rowT} numberOfLines={2}>{a.label}</Text>
              {a.frac!=null&&(
                <View style={s.progTrack}>
                  <View style={[s.progFill,{width:`${Math.round(Math.max(0,Math.min(1,a.frac))*100)}%`,backgroundColor:col}]}/>
                </View>
              )}
            </View>
          ))}
        </View>
      ):(
        <Text style={s.idle}>Idle — nothing running.</Text>
      )}

      {isTrader&&<>
        <TradeStatus active={active} style={s.gap}/>
        <TradeRecordBar active={active} style={s.gap}/>
        <TradePanel active={active} onEvent={build.onTradeEvent}/>
      </>}
      {id==='scout'&&<LeadsPanel active={active}/>}
      {id==='rogue'&&<ClipPanel active={active}/>}
      {id==='jarvis'&&<BuildPanel active={active} onMerge={build.onMerge} onCancel={build.onCancel} onDelete={build.onDelete} filter={build.jarvisFilter}/>}
      {id==='ara'&&project&&<BuildPanel active={active} title="FIRM BUILD" accent="#00CED1" onMerge={build.onMerge} onCancel={build.onCancel} onDelete={build.onDelete} filter={build.firmFilter}/>}
      <WatchPanel active={active}/>

      <Text style={[s.section,{marginTop:14}]}>RECENT</Text>
      {recent.length>0?(
        <View style={s.list}>
          {recent.map((r,i)=>(
            <View key={r.kind+i} style={s.recentRow}>
              <Text style={s.recentIcon}>{KIND_ICON[r.kind]||'·'}</Text>
              <View style={{flex:1}}>
                <Text style={s.recentT} numberOfLines={1}>{r.label}</Text>
                <Text style={s.recentSub} numberOfLines={1}>
                  {r.detail}
                  {r.status?<Text style={{color:STATUS_COLOR[r.status]||'#8A8172'}}> · {r.status}</Text>:null}
                </Text>
              </View>
              <Text style={s.recentAgo}>{ago(r.at)}</Text>
            </View>
          ))}
        </View>
      ):(
        <Text style={s.idle}>No recent work.</Text>
      )}
    </ScrollView>
  );
}

const s=StyleSheet.create({
  pad:{padding:10,paddingBottom:44,gap:6},
  hdr:{fontFamily:'monospace',fontSize:9,fontWeight:'700',letterSpacing:2,marginBottom:2},
  section:{fontFamily:'monospace',fontSize:7,letterSpacing:2,color:'#5A5A5A',marginTop:4,marginBottom:2},
  list:{gap:5},
  row:{flexDirection:'row',alignItems:'center',gap:8,borderWidth:1,borderRadius:5,paddingHorizontal:9,paddingVertical:7,backgroundColor:'rgba(232,201,138,0.04)',overflow:'hidden'},
  dot:{width:6,height:6,borderRadius:3},
  rowT:{flex:1,fontFamily:'monospace',fontSize:9,letterSpacing:0.3,color:'#9A917F'},
  progTrack:{position:'absolute',left:0,bottom:0,height:2,width:'100%',backgroundColor:'#ffffff10'},
  progFill:{position:'absolute',left:0,bottom:0,height:2,opacity:0.85},
  idle:{fontFamily:'monospace',fontSize:9,letterSpacing:0.5,color:'#4A4A4A',paddingVertical:6},
  gap:{marginHorizontal:0,marginTop:6},
  recentRow:{flexDirection:'row',alignItems:'center',gap:9,paddingVertical:6,borderBottomWidth:1,borderBottomColor:'#141210'},
  recentIcon:{fontSize:10,width:14,textAlign:'center',color:'#8A8172'},
  recentT:{fontFamily:'monospace',fontSize:9,letterSpacing:0.2,color:'#B9B0A0'},
  recentSub:{fontFamily:'monospace',fontSize:7.5,letterSpacing:0.3,color:'#6A6458',marginTop:1},
  recentAgo:{fontFamily:'monospace',fontSize:7.5,color:'#4A4A4A'},
});
