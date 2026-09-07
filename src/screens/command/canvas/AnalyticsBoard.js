// P.U.L.S.E.'s board — a read-only snapshot of the Empire's numbers: this
// month's revenue against target by business, the content pipeline, the trading
// record, and the outreach funnel. Shared by the Canvas ([SHOW_ANALYTICS]) and
// the Analytics screen (THE ALMANAC in the city). Polls while mounted.
import React,{useState,useEffect,useCallback,useRef}from 'react';
import{View,Text,StyleSheet,ScrollView,ActivityIndicator}from 'react-native';
import{colors}from '../../../theme';
import{getBusinessesWithRevenue,getContentTally,getAllLeads}from '../../../services/database';
import{tradeRecord}from '../../../services/tradeJournal';

const POLL_MS=8000;
const money=n=>{
  const a=Math.abs(n||0);
  if(a>=1e6)return `$${(n/1e6).toFixed(1)}M`;
  if(a>=1e3)return `$${(n/1e3).toFixed(1)}k`;
  return `$${Math.round(n||0)}`;
};

export default function AnalyticsBoard({accent=colors.gold}){
  const[data,setData]=useState(null);
  const alive=useRef(true);

  const load=useCallback(async()=>{
    try{
      const[biz,tally,leads,rec]=await Promise.all([
        getBusinessesWithRevenue().catch(()=>[]),
        getContentTally().catch(()=>[]),
        getAllLeads().catch(()=>[]),
        tradeRecord({limit:60}).catch(()=>null),
      ]);
      if(!alive.current)return;
      const content={};
      tally.forEach(r=>{content[r.status]=(content[r.status]||0)+r.n;});
      const funnel={};
      leads.forEach(l=>{funnel[l.stage||'new']=(funnel[l.stage||'new']||0)+1;});
      setData({biz,content,funnel,rec,leadTotal:leads.length});
    }catch{if(alive.current)setData({biz:[],content:{},funnel:{},rec:null,leadTotal:0});}
  },[]);

  useEffect(()=>{
    alive.current=true;load();
    const iv=setInterval(load,POLL_MS);
    return()=>{alive.current=false;clearInterval(iv);};
  },[load]);

  if(!data)return <View style={s.loading}><ActivityIndicator color={accent}/></View>;

  const revTotal=data.biz.reduce((a,b)=>a+(b.rev||0),0);
  const targetTotal=data.biz.reduce((a,b)=>a+(b.target||0),0);
  const maxBar=Math.max(1,...data.biz.map(b=>Math.max(b.rev||0,b.target||0)));
  const r=data.rec;
  const c=data.content;
  const posted=c.posted||0;
  const inPipe=(c.queued||0)+(c.awaiting_media||0)+(c.needs_review||0)+(c.approved||0);
  const fEntries=['inbound','new','contacted','replied','qualifying','call_booked','won']
    .map(k=>[k,data.funnel[k]||0]).filter(([,n])=>n);

  return(
    <ScrollView style={s.wrap} contentContainerStyle={{paddingBottom:24}} showsVerticalScrollIndicator={false}>
      <Text style={[s.h,{color:accent}]}>REVENUE · THIS MONTH</Text>
      <View style={s.tiles}>
        <Tile label="Collected" value={money(revTotal)} accent={accent}/>
        <Tile label="Target" value={money(targetTotal)}/>
        <Tile label="Pace" value={targetTotal?`${Math.round((revTotal/targetTotal)*100)}%`:'—'}
          accent={targetTotal&&revTotal/targetTotal>=0.75?colors.online:targetTotal&&revTotal/targetTotal>=0.4?colors.warn:colors.danger}/>
      </View>
      {data.biz.filter(b=>b.rev||b.target).map(b=>(
        <View key={b.name} style={s.barRow}>
          <Text style={s.barName} numberOfLines={1}>{b.name}</Text>
          <View style={s.barTrack}>
            {!!b.target&&<View style={[s.barTarget,{width:`${Math.min(100,(b.target/maxBar)*100)}%`}]}/>}
            <View style={[s.barFill,{width:`${Math.min(100,((b.rev||0)/maxBar)*100)}%`,backgroundColor:accent}]}/>
          </View>
          <Text style={s.barVal}>{money(b.rev||0)}</Text>
        </View>
      ))}
      {!data.biz.some(b=>b.rev||b.target)&&<Text style={s.empty}>No revenue or targets set.</Text>}

      <Text style={[s.h,{color:accent}]}>CONTENT</Text>
      <View style={s.tiles}>
        <Tile label="Posted" value={String(posted)} accent={accent}/>
        <Tile label="In pipeline" value={String(inPipe)}/>
        <Tile label="Needs review" value={String(c.needs_review||0)} accent={c.needs_review?colors.warn:undefined}/>
      </View>

      <Text style={[s.h,{color:accent}]}>TRADING</Text>
      {r&&(r.count||r.openCount)?(
        <>
          <View style={s.tiles}>
            <Tile label="Record" value={`${r.wins}-${r.losses}${r.be?`-${r.be}`:''}`}/>
            <Tile label="Win rate" value={r.winRate!=null?`${r.winRate}%`:'—'}
              accent={r.winRate!=null?(r.winRate>=50?colors.online:colors.danger):undefined}/>
            <Tile label="Net P/L" value={`${r.net>=0?'+':''}${r.net}`} accent={r.net>=0?colors.online:colors.danger}/>
          </View>
          <Text style={s.meta}>
            {r.openCount} open{r.avgR!=null?`  ·  avg ${r.avgR>=0?'+':''}${r.avgR}R`:''}
            {r.streak>=2?`  ·  ${r.streak}${r.streakType==='win'?'W':'L'} streak`:''}
          </Text>
        </>
      ):<Text style={s.empty}>No closed trades yet.</Text>}

      <Text style={[s.h,{color:accent}]}>OUTREACH · {data.leadTotal} LEAD{data.leadTotal===1?'':'S'}</Text>
      {fEntries.length?(
        <View style={s.funnel}>
          {fEntries.map(([k,n])=>(
            <View key={k} style={s.fRow}>
              <Text style={s.fName}>{k.replace('_',' ')}</Text>
              <View style={s.fBarTrack}><View style={[s.fBar,{width:`${Math.min(100,(n/Math.max(1,data.leadTotal))*100)}%`,backgroundColor:accent}]}/></View>
              <Text style={s.fVal}>{n}</Text>
            </View>
          ))}
        </View>
      ):<Text style={s.empty}>No leads in the pipeline.</Text>}
    </ScrollView>
  );
}

function Tile({label,value,accent}){
  return(
    <View style={s.tile}>
      <Text style={[s.tileV,accent&&{color:accent}]} numberOfLines={1}>{value}</Text>
      <Text style={s.tileL}>{label}</Text>
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{flex:1,paddingHorizontal:14,paddingTop:10},
  loading:{flex:1,alignItems:'center',justifyContent:'center'},
  h:{fontFamily:'monospace',fontSize:9,letterSpacing:2,marginTop:18,marginBottom:8},
  tiles:{flexDirection:'row',gap:8},
  tile:{flex:1,borderWidth:1,borderColor:'#1c1913',borderRadius:6,paddingVertical:10,paddingHorizontal:8,backgroundColor:'#0A0907'},
  tileV:{fontFamily:'monospace',fontSize:15,color:colors.text},
  tileL:{fontFamily:'monospace',fontSize:7.5,color:colors.textDim,letterSpacing:1,marginTop:3},
  meta:{fontFamily:'monospace',fontSize:8,color:colors.textDim,marginTop:6,letterSpacing:0.5},
  barRow:{flexDirection:'row',alignItems:'center',gap:8,paddingVertical:5},
  barName:{fontFamily:'monospace',fontSize:9,color:colors.textMuted,width:78},
  barTrack:{flex:1,height:14,backgroundColor:'#141210',borderRadius:3,overflow:'hidden',justifyContent:'center'},
  barTarget:{position:'absolute',height:14,backgroundColor:'#241f16'},
  barFill:{height:14,borderRadius:3},
  barVal:{fontFamily:'monospace',fontSize:8.5,color:colors.textMuted,width:52,textAlign:'right'},
  funnel:{gap:5},
  fRow:{flexDirection:'row',alignItems:'center',gap:8},
  fName:{fontFamily:'monospace',fontSize:8.5,color:colors.textMuted,width:78},
  fBarTrack:{flex:1,height:10,backgroundColor:'#141210',borderRadius:3,overflow:'hidden'},
  fBar:{height:10,borderRadius:3},
  fVal:{fontFamily:'monospace',fontSize:8.5,color:colors.textMuted,width:28,textAlign:'right'},
  empty:{fontFamily:'monospace',fontSize:9,color:colors.textFaint,paddingVertical:6},
});
