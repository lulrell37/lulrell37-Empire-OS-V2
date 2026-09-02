// A.T.L.A.S.'s running trade record, shown under the TradeLocker pill on her
// screen. Read-only; refreshes when the screen gains focus and on a slow timer.
// Hidden until there is at least one closed trade or an open one.
import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{tradeRecord}from '../../services/tradeJournal';
import{colors,FONTS,radius,space}from '../../theme';

const REFRESH_MS=25000;

export default function TradeRecordBar({active=true,style}){
  const[r,setR]=useState(null);
  const[open,setOpen]=useState(false);
  const alive=useRef(true);

  const load=useCallback(()=>{
    tradeRecord({}).then(x=>{if(alive.current)setR(x);}).catch(()=>{});
  },[]);

  useEffect(()=>{
    alive.current=true;
    if(!active)return()=>{alive.current=false;};
    load();
    const iv=setInterval(load,REFRESH_MS);
    return()=>{alive.current=false;clearInterval(iv);};
  },[active,load]);

  if(!r||(!r.count&&!r.openCount))return null;

  const net=r.net||0;
  const netColor=net>0?colors.online:net<0?colors.danger:colors.textDim;
  const setups=Object.entries(r.bySetup||{});

  return(
    <View style={[s.wrap,style]}>
      <TouchableOpacity style={s.bar} activeOpacity={0.7} onPress={()=>setOpen(o=>!o)}>
        <Text style={s.label}>A.T.L.A.S. RECORD</Text>
        <Text style={s.stat}>{r.wins}W&#8211;{r.losses}L{r.be?`–${r.be}BE`:''}</Text>
        {r.winRate!=null&&<Text style={s.stat}>{r.winRate}%</Text>}
        <Text style={[s.stat,{color:netColor}]}>{net>=0?'+':''}{net.toFixed(2)}</Text>
        {r.avgR!=null&&<Text style={s.stat}>{r.avgR>=0?'+':''}{r.avgR}R</Text>}
        {r.streak>=2&&<Text style={[s.stat,{color:r.streakType==='win'?colors.online:colors.danger}]}>{r.streak}{r.streakType==='win'?'W':'L'}</Text>}
        {!!r.openCount&&<Text style={[s.stat,{color:colors.warn}]}>{r.openCount} open</Text>}
        <Text style={s.chev}>{open?'▾':'▸'}</Text>
      </TouchableOpacity>
      {open&&(
        <View style={s.body}>
          {setups.length>0&&<Text style={s.bySetup}>{setups.map(([k,v])=>`${k}: ${v.wins}/${v.n} (${v.net>=0?'+':''}${v.net.toFixed(2)})`).join('   ')}</Text>}
          {(r.recent||[]).slice(0,5).map(t=>(
            <Text key={t.id} style={s.row} numberOfLines={1}>
              #{t.id} {t.symbol} {t.side} — {(t.outcome||'?').toUpperCase()}
              {t.realized_pl!=null?`  ${t.realized_pl>=0?'+':''}${t.realized_pl}${t.pl_estimated?'~':''}`:''}
              {t.review?`  · ${t.review}`:''}
            </Text>
          ))}
          {!r.count&&<Text style={s.row}>No closed trades yet.</Text>}
        </View>
      )}
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{alignSelf:'stretch'},
  bar:{flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:8,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.sm,paddingHorizontal:space.sm,paddingVertical:5,backgroundColor:'rgba(255,255,255,0.02)'},
  label:{fontFamily:FONTS.mono,fontSize:8,letterSpacing:2,color:'#D4A017'},
  stat:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,fontWeight:'700'},
  chev:{fontFamily:FONTS.mono,fontSize:8,color:colors.textFaint,marginLeft:'auto'},
  body:{borderWidth:1,borderTopWidth:0,borderColor:colors.hairline,borderBottomLeftRadius:radius.sm,borderBottomRightRadius:radius.sm,paddingHorizontal:space.sm,paddingVertical:6,gap:3},
  bySetup:{fontFamily:FONTS.mono,fontSize:8,color:colors.textFaint,letterSpacing:0.5,marginBottom:2},
  row:{fontFamily:FONTS.mono,fontSize:8.5,color:colors.textDim,letterSpacing:0.3},
});
