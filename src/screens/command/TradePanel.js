// Live position monitor for Atlas's gold trades. Polls TradeLocker while the
// Command screen is focused — this is the "assisted" boundary: no polling in the
// background, so nothing here runs once the app is closed.
import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ActivityIndicator}from 'react-native';
import{tlPositions,tlQuote,tlClosePosition,tlStatus}from '../../services/tradeLocker';

const POLL_MS=4500;

export default function TradePanel({active,onEvent}){
  const[positions,setPositions]=useState([]);
  const[quote,setQuote]=useState(null);
  const[busy,setBusy]=useState(null); // position id being closed, or 'all'
  const[collapsed,setCollapsed]=useState(false);
  const timer=useRef(null);
  const alive=useRef(true);

  const poll=useCallback(async()=>{
    if(!tlStatus().connected)return;
    try{
      const[ps,q]=await Promise.all([tlPositions(),tlQuote('XAUUSD').catch(()=>null)]);
      if(!alive.current)return;
      setPositions(ps.filter(p=>String(p.tradableInstrumentId)&&Number(p.qty)>0));
      if(q)setQuote(q);
    }catch{}
  },[]);

  useEffect(()=>{
    alive.current=true;
    if(active){poll();timer.current=setInterval(poll,POLL_MS);}
    return()=>{alive.current=false;if(timer.current){clearInterval(timer.current);timer.current=null;}};
  },[active,poll]);

  async function close(id){
    setBusy(id);
    try{
      if(id==='all'){for(const p of positions)await tlClosePosition(p.id);}
      else await tlClosePosition(id);
      onEvent?.(id==='all'?`— CLOSE SENT · ${positions.length} position(s) —`:`— CLOSE SENT · #${id} —`);
      await poll();
    }catch(e){onEvent?.(`Close failed: ${e.message}`);}
    finally{setBusy(null);}
  }

  if(!positions.length)return null;

  const totalPl=positions.reduce((a,p)=>a+(Number(p.unrealizedPl)||0),0);
  const plColor=totalPl>=0?'#5FA779':'#C7614B';

  return(
    <View style={s.wrap}>
      <TouchableOpacity style={s.hdr} activeOpacity={0.7} onPress={()=>setCollapsed(c=>!c)}>
        <Text style={s.hdrLabel}>◆ GOLD · {positions.length} OPEN</Text>
        <View style={s.hdrRight}>
          {quote&&<Text style={s.hdrPx}>{quote.mid?.toFixed?.(2)}</Text>}
          <Text style={[s.hdrPl,{color:plColor}]}>{totalPl>=0?'+':''}{totalPl.toFixed(2)}</Text>
          <Text style={s.hdrChevron}>{collapsed?'▸':'▾'}</Text>
        </View>
      </TouchableOpacity>
      {!collapsed&&<>
        {positions.map(p=>{
          const pl=Number(p.unrealizedPl)||0;
          return(
            <View key={p.id} style={s.row}>
              <Text style={[s.side,{color:p.side==='buy'?'#5FA779':'#C7614B'}]}>{p.side==='buy'?'▲':'▼'} {p.qty}</Text>
              <Text style={s.entry}>@ {Number(p.avgPrice).toFixed(2)}</Text>
              <Text style={[s.pl,{color:pl>=0?'#5FA779':'#C7614B'}]}>{pl>=0?'+':''}{pl.toFixed(2)}</Text>
              <TouchableOpacity style={s.closeBtn} disabled={!!busy} onPress={()=>close(p.id)}>
                {busy===p.id?<ActivityIndicator size="small" color="#C7614B"/>:<Text style={s.closeT}>CLOSE</Text>}
              </TouchableOpacity>
            </View>
          );
        })}
        {positions.length>1&&<TouchableOpacity style={s.closeAll} disabled={!!busy} onPress={()=>close('all')}>
          <Text style={s.closeAllT}>{busy==='all'?'CLOSING…':'CLOSE ALL'}</Text>
        </TouchableOpacity>}
      </>}
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{marginHorizontal:10,marginTop:4,borderWidth:1,borderColor:'#1F1B14',borderRadius:8,backgroundColor:'#080706',overflow:'hidden'},
  hdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:12,paddingVertical:8},
  hdrLabel:{fontFamily:'monospace',fontSize:9,color:'#D4A017',letterSpacing:2},
  hdrRight:{flexDirection:'row',alignItems:'center',gap:10},
  hdrPx:{fontFamily:'monospace',fontSize:9,color:'#666'},
  hdrPl:{fontFamily:'monospace',fontSize:11,fontWeight:'700'},
  hdrChevron:{fontFamily:'monospace',fontSize:9,color:'#555'},
  row:{flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:12,paddingVertical:7,borderTopWidth:1,borderTopColor:'#141210'},
  side:{fontFamily:'monospace',fontSize:11,fontWeight:'700',width:44},
  entry:{fontFamily:'monospace',fontSize:10,color:'#777',flex:1},
  pl:{fontFamily:'monospace',fontSize:11,fontWeight:'700',width:76,textAlign:'right'},
  closeBtn:{borderWidth:1,borderColor:'#C7614B55',borderRadius:4,paddingHorizontal:8,paddingVertical:3,minWidth:52,alignItems:'center'},
  closeT:{fontFamily:'monospace',fontSize:8,color:'#C7614B',letterSpacing:1},
  closeAll:{alignItems:'center',paddingVertical:8,borderTopWidth:1,borderTopColor:'#141210'},
  closeAllT:{fontFamily:'monospace',fontSize:9,color:'#C7614B',letterSpacing:2},
});
