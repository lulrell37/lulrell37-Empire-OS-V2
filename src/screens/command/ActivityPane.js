// The ◈ activity section of a persona's orb screen — the third view next to the
// visualization (◉) and the chat (≣). One pane that gathers everything the open
// persona has in flight: the live "working" rows the banner also shows (queue
// jobs, auto-agent cycles, relays, deep research), plus that persona's own
// board — T.A.L.O.N.'s trades, S.C.O.U.T.'s pipeline, R.O.G.U.E.'s clips,
// J.A.R.V.I.S.'s builds — and the shared watch-job board for everyone. These
// used to stack on top of the chat; they live here instead.
import React from 'react';
import{View,Text,StyleSheet,ScrollView}from 'react-native';
import{TRADER_ID}from '../../services/tradeJournal';
import TradePanel from './TradePanel';
import TradeStatus from '../../components/TradeStatus';
import TradeRecordBar from './TradeRecordBar';
import LeadsPanel from './LeadsPanel';
import ClipPanel from './ClipPanel';
import WatchPanel from './WatchPanel';
import BuildPanel from './BuildPanel';

export default function ActivityPane({persona,activity=[],active,project,build={}}){
  const id=persona?.id;
  const col=persona?.color||'#E8C98A';
  const rows=activity.filter(a=>a&&a.persona===id);
  const isTrader=id===TRADER_ID;

  return(
    <ScrollView style={{flex:1}} contentContainerStyle={s.pad} showsVerticalScrollIndicator={false}>
      <Text style={[s.hdr,{color:col}]}>{(persona?.name||'').replace(/\./g,'')} · ACTIVITY</Text>

      {rows.length>0?(
        <View style={s.live}>
          {rows.map(a=>(
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
        <Text style={s.idle}>Nothing running right now.</Text>
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
    </ScrollView>
  );
}

const s=StyleSheet.create({
  pad:{padding:10,paddingBottom:40,gap:6},
  hdr:{fontFamily:'monospace',fontSize:9,fontWeight:'700',letterSpacing:2,marginBottom:2},
  live:{gap:5,marginBottom:4},
  row:{flexDirection:'row',alignItems:'center',gap:8,borderWidth:1,borderRadius:5,paddingHorizontal:9,paddingVertical:7,backgroundColor:'rgba(232,201,138,0.04)',overflow:'hidden'},
  dot:{width:6,height:6,borderRadius:3},
  rowT:{flex:1,fontFamily:'monospace',fontSize:9,letterSpacing:0.3,color:'#9A917F'},
  progTrack:{position:'absolute',left:0,bottom:0,height:2,width:'100%',backgroundColor:'#ffffff10'},
  progFill:{position:'absolute',left:0,bottom:0,height:2,opacity:0.85},
  idle:{fontFamily:'monospace',fontSize:9,letterSpacing:0.5,color:'#4A4A4A',paddingVertical:8},
  gap:{marginHorizontal:0,marginTop:6},
});
