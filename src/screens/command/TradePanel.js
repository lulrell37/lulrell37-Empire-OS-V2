// Live position monitor for T.A.L.O.N.'s trades (any pair). Polls TradeLocker while
// the Command screen is focused — this is the "assisted" boundary: no polling in
// the background, so nothing here runs once the app is closed.
import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ActivityIndicator}from 'react-native';
import{tlPositions,tlClosePosition,tlModifyPosition,tlStatus,tlInstrumentsById}from '../../services/tradeLocker';
import{reconcileOpenTrades}from '../../services/tradeJournal';

const POLL_MS=4500;
const RECONCILE_MS=20000; // fold closed trades into the journal at most this often

export default function TradePanel({active,onEvent}){
  const[positions,setPositions]=useState([]);
  const[names,setNames]=useState({}); // tradableInstrumentId -> symbol
  const[busy,setBusy]=useState(null); // position id being closed, or 'all'
  const[collapsed,setCollapsed]=useState(false);
  const timer=useRef(null);
  const alive=useRef(true);
  const lastReconcile=useRef(0);

  const poll=useCallback(async()=>{
    if(!tlStatus().connected)return;
    try{
      const ps=await tlPositions();
      if(!alive.current)return;
      const open=ps.filter(p=>String(p.tradableInstrumentId)&&Number(p.qty)>0);
      setPositions(open);
      if(Date.now()-lastReconcile.current>RECONCILE_MS){
        lastReconcile.current=Date.now();
        reconcileOpenTrades().catch(()=>{});
      }
      if(open.length&&!Object.keys(names).length){
        tlInstrumentsById().then(m=>{if(alive.current)setNames(m);}).catch(()=>{});
      }
    }catch{}
  },[names]);

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

  async function breakeven(p){
    setBusy(p.id);
    try{
      await tlModifyPosition(p.id,{stopLoss:Number(p.avgPrice)});
      onEvent?.(`— #${p.id} stop → break-even —`);
      await poll();
    }catch(e){onEvent?.(`Break-even failed: ${e.message}`);}
    finally{setBusy(null);}
  }

  if(!positions.length)return null;

  const totalPl=positions.reduce((a,p)=>a+(Number(p.unrealizedPl)||0),0);
  const plColor=totalPl>=0?'#5FA779':'#C7614B';

  return(
    <View style={s.wrap}>
      <TouchableOpacity style={s.hdr} activeOpacity={0.7} onPress={()=>setCollapsed(c=>!c)}>
        <Text style={s.hdrLabel}>◆ POSITIONS · {positions.length} OPEN</Text>
        <View style={s.hdrRight}>
          <Text style={[s.hdrPl,{color:plColor}]}>{totalPl>=0?'+':''}{totalPl.toFixed(2)}</Text>
          <Text style={s.hdrChevron}>{collapsed?'▸':'▾'}</Text>
        </View>
      </TouchableOpacity>
      {!collapsed&&<>
        {positions.map(p=>{
          const pl=Number(p.unrealizedPl)||0;
          const sym=names[String(p.tradableInstrumentId)]||'';
          return(
            <View key={p.id} style={s.row}>
              <Text style={[s.side,{color:p.side==='buy'?'#5FA779':'#C7614B'}]}>{p.side==='buy'?'▲':'▼'} {p.qty}</Text>
              <Text style={s.entry}>{sym?`${sym} `:''}@ {Number(p.avgPrice).toFixed(2)}</Text>
              <Text style={[s.pl,{color:pl>=0?'#5FA779':'#C7614B'}]}>{pl>=0?'+':''}{pl.toFixed(2)}</Text>
              {pl>0&&(
                <TouchableOpacity style={s.beBtn} disabled={!!busy} onPress={()=>breakeven(p)}>
                  {busy===p.id?<ActivityIndicator size="small" color="#D4A017"/>:<Text style={s.beT}>B/E</Text>}
                </TouchableOpacity>
              )}
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
  beBtn:{borderWidth:1,borderColor:'#D4A01755',borderRadius:4,paddingHorizontal:8,paddingVertical:3,minWidth:38,alignItems:'center'},
  beT:{fontFamily:'monospace',fontSize:8,color:'#D4A017',letterSpacing:1},
  closeAll:{alignItems:'center',paddingVertical:8,borderTopWidth:1,borderTopColor:'#141210'},
  closeAllT:{fontFamily:'monospace',fontSize:9,color:'#C7614B',letterSpacing:2},
});
