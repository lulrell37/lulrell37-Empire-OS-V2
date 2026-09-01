// HUD panel content components. Each renders content only (no outer width /
// scroll wrapper) so the same component works docked in the carousel or inside
// a floating card. Routine and Batman own their edit-mode state locally and
// report results up via onSave / onSaveTemplate.
import React,{useState,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,TextInput,Dimensions,ActivityIndicator}from 'react-native';
import Svg,{Circle}from 'react-native-svg';
import{Feather}from '@expo/vector-icons';
import{useFocusEffect}from '@react-navigation/native';
import{colors,space,radius,type,FONTS}from '../../theme';
import{tlStatus,tlQuote,tlPositions,tlClosePosition}from '../../services/tradeLocker';

const{width}=Dimensions.get('window');
export const PANEL_META={
  briefing:{title:'BRIEFING'},
  businesses:{title:'THE EMPIRE'},
  tasks:{title:'TASKS'},
  routine:{title:'MORNING ROUTINE'},
  batman:{title:'BATMAN PROTOCOL'},
  daily:{title:'DAILY'},
  diagram:{title:'DIAGRAM'},
  market:{title:'GOLD · MARKET'},
};
export const newRoutineId=()=>'r_'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);

export function BriefingPanel({tasksDone,tasksTotal,routineDone,routineTotal,todayBatman}){
  return(
    <>
      <View style={ps.briefRow}>
        <View style={ps.briefIcon}><Feather name="check-square" size={15} color={colors.brass}/></View>
        <View style={{flex:1}}>
          <Text style={ps.briefMain}>{tasksDone} of {tasksTotal} tasks complete</Text>
          <Text style={ps.briefSub}>{tasksTotal-tasksDone} remaining</Text>
        </View>
      </View>
      <View style={ps.briefRow}>
        <View style={ps.briefIcon}><Feather name="sunrise" size={15} color={colors.brass}/></View>
        <View style={{flex:1}}>
          <Text style={ps.briefMain}>{routineDone} of {routineTotal} routine done</Text>
          <Text style={ps.briefSub}>{routineTotal>0&&routineDone>=routineTotal?'Fully complete':'Keep going'}</Text>
        </View>
      </View>
      <View style={ps.briefRow}>
        <View style={ps.briefIcon}><Feather name="activity" size={15} color={colors.brass}/></View>
        <View style={{flex:1}}>
          <Text style={ps.briefMain}>{todayBatman?.label}</Text>
          <Text style={ps.briefSub}>{todayBatman?.desc}</Text>
        </View>
      </View>
      <Text style={ps.briefNote}>Calendar and email require Google Sign-In — not yet connected on this device.</Text>
    </>
  );
}

export function BusinessPanel({businesses,onOpenBiz}){
  return(
    <View style={ps.bizGrid}>
      {businesses.map((b)=>{
        const pct=b.target>0?Math.min(100,Math.round((b.rev/b.target)*100)):0;
        const bizCI=2*Math.PI*25;
        const bizOffset=bizCI-(bizCI*pct/100);
        const color=pct>=66?colors.ringHigh:pct>=33?colors.ringMid:pct>0?colors.ringLow:colors.ringTrack;
        return(
          <TouchableOpacity key={b.name} style={ps.bizItem} onPress={()=>onOpenBiz(b)} activeOpacity={0.7}>
            <View style={ps.bizRing}>
              <Svg width={62} height={62}>
                <Circle cx={31} cy={31} r={25} stroke={colors.ringTrack} strokeWidth={3.5} fill="none"/>
                <Circle cx={31} cy={31} r={25} stroke={color} strokeWidth={3.5} fill="none" strokeDasharray={bizCI} strokeDashoffset={bizOffset} strokeLinecap="round" rotation="-90" origin="31,31"/>
              </Svg>
              <View style={ps.bizRingCore}><Text style={ps.bizPct}>{b.target>0?pct:'—'}</Text></View>
            </View>
            <Text style={ps.bizName} numberOfLines={2}>{b.name}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export function TasksPanel({tasks,onComplete,onEdit,onAdd}){
  return(
    <>
      <View style={ps.headRow}>
        <Text style={ps.headHint}>{tasks.length} open</Text>
        <TouchableOpacity style={ps.addBtn} onPress={onAdd} activeOpacity={0.7}>
          <Feather name="plus" size={11} color={colors.bg}/>
          <Text style={ps.addBtnT}>ADD</Text>
        </TouchableOpacity>
      </View>
      {tasks.map(t=>(
        <TouchableOpacity key={t.id} style={ps.taskRow} onPress={()=>onComplete(t.id)} onLongPress={()=>onEdit(t)} delayLongPress={300} activeOpacity={0.6}>
          <Feather name="circle" size={17} color={colors.textDim}/>
          <Text style={ps.taskName}>{t.title}</Text>
          <Feather name="more-vertical" size={13} color={colors.textFaint}/>
        </TouchableOpacity>
      ))}
      {!tasks.length&&<Text style={ps.emptyText}>No open tasks.</Text>}
      {!!tasks.length&&<Text style={ps.hintText}>Long-press a task to edit or delete.</Text>}
    </>
  );
}

export function RoutinePanel({items,done,onToggle,onSave,onEditingChange}){
  const[edit,setEdit]=useState(false);
  const[draft,setDraft]=useState([]);
  const doneCount=items.filter(i=>done[i.id]).length;
  function setEditing(v){setEdit(v);onEditingChange?.(v);}
  function start(){setDraft(items.map(i=>({...i})));setEditing(true);}
  function setLabel(idx,val){setDraft(d=>d.map((it,i)=>i===idx?{...it,label:val}:it));}
  function move(idx,dir){setDraft(d=>{const n=[...d];const j=idx+dir;if(j<0||j>=n.length)return n;[n[idx],n[j]]=[n[j],n[idx]];return n;});}
  function removeAt(idx){setDraft(d=>d.filter((_,i)=>i!==idx));}
  function add(){setDraft(d=>[...d,{id:newRoutineId(),label:''}]);}
  function save(){
    const clean=draft.map(it=>({id:it.id,label:it.label.trim()})).filter(it=>it.label);
    setEditing(false);
    onSave(clean);
  }
  return(
    <>
      <View style={ps.headRow}>
        {edit?(
          <>
            <TouchableOpacity style={ps.ghostBtn} onPress={()=>setEditing(false)}><Text style={ps.ghostBtnT}>CANCEL</Text></TouchableOpacity>
            <TouchableOpacity style={ps.addBtn} onPress={save} activeOpacity={0.7}><Feather name="check" size={11} color={colors.bg}/><Text style={ps.addBtnT}>DONE</Text></TouchableOpacity>
          </>
        ):(
          <>
            <Text style={ps.headMeta}>{doneCount} / {items.length}</Text>
            <TouchableOpacity style={ps.ghostBtn} onPress={start} activeOpacity={0.7}><Feather name="edit-2" size={10} color={colors.gold}/><Text style={ps.ghostBtnT}>EDIT</Text></TouchableOpacity>
          </>
        )}
      </View>

      {!edit&&items.map(item=>(
        <TouchableOpacity key={item.id} style={ps.taskRow} onPress={()=>onToggle(item.id)} activeOpacity={0.6}>
          <Feather name={done[item.id]?'check-circle':'circle'} size={17} color={done[item.id]?colors.gold:colors.textDim}/>
          <Text style={[ps.taskName,done[item.id]&&ps.taskNameDone]}>{item.label}</Text>
        </TouchableOpacity>
      ))}
      {!edit&&!items.length&&<Text style={ps.emptyText}>No routine items. Tap EDIT to add some.</Text>}

      {edit&&draft.map((item,idx)=>(
        <View key={item.id} style={ps.editRow}>
          <View style={ps.reorderCol}>
            <TouchableOpacity onPress={()=>move(idx,-1)} hitSlop={{top:6,bottom:6,left:6,right:6}}><Feather name="chevron-up" size={16} color={idx===0?colors.textFaint:colors.textDim}/></TouchableOpacity>
            <TouchableOpacity onPress={()=>move(idx,1)} hitSlop={{top:6,bottom:6,left:6,right:6}}><Feather name="chevron-down" size={16} color={idx===draft.length-1?colors.textFaint:colors.textDim}/></TouchableOpacity>
          </View>
          <TextInput style={ps.editInput} value={item.label} onChangeText={v=>setLabel(idx,v)} placeholder="Routine item…" placeholderTextColor={colors.textFaint}/>
          <TouchableOpacity onPress={()=>removeAt(idx)} hitSlop={{top:8,bottom:8,left:8,right:8}}><Feather name="trash-2" size={15} color={colors.danger}/></TouchableOpacity>
        </View>
      ))}
      {edit&&(
        <TouchableOpacity style={ps.addItemRow} onPress={add} activeOpacity={0.7}>
          <Feather name="plus" size={15} color={colors.gold}/>
          <Text style={ps.addItemT}>Add item</Text>
        </TouchableOpacity>
      )}
    </>
  );
}

export function BatmanPanel({template,done,today,onToggleDay,onSaveTemplate,onEditingChange}){
  const[edit,setEdit]=useState(false);
  const[draft,setDraft]=useState([]);
  function setEditing(v){setEdit(v);onEditingChange?.(v);}
  function start(){setDraft(template.map(d=>({...d})));setEditing(true);}
  function setField(idx,field,val){setDraft(d=>d.map((it,i)=>i===idx?{...it,[field]:val}:it));}
  function save(){setEditing(false);onSaveTemplate(draft);}
  return(
    <>
      <View style={ps.headRow}>
        <Text style={ps.headHint}>{edit?'TEMPLATE':'TODAY'}</Text>
        {edit?(
          <View style={ps.headBtns}>
            <TouchableOpacity style={ps.ghostBtn} onPress={()=>setEditing(false)}><Text style={ps.ghostBtnT}>CANCEL</Text></TouchableOpacity>
            <TouchableOpacity style={ps.addBtn} onPress={save} activeOpacity={0.7}><Feather name="check" size={11} color={colors.bg}/><Text style={ps.addBtnT}>DONE</Text></TouchableOpacity>
          </View>
        ):(
          <TouchableOpacity style={ps.ghostBtn} onPress={start} activeOpacity={0.7}><Feather name="edit-2" size={10} color={colors.gold}/><Text style={ps.ghostBtnT}>EDIT</Text></TouchableOpacity>
        )}
      </View>

      {!edit&&<>
        <Text style={ps.batTitle}>{today?.label}</Text>
        <Text style={ps.batDesc}>{today?.desc}</Text>
        <View style={ps.batWeek}>
          {template.map(b=>(
            <TouchableOpacity key={b.day} style={[ps.batDay,b.day===today?.day&&ps.batDayToday]} onPress={()=>onToggleDay(b.day)} activeOpacity={0.7}>
              <Text style={[ps.batDayT,b.day===today?.day&&ps.batDayTToday]}>{b.day}</Text>
              <Feather name="check" size={11} color={done[b.day]?colors.online:'transparent'} style={{marginTop:3}}/>
            </TouchableOpacity>
          ))}
        </View>
      </>}

      {edit&&draft.map((d,idx)=>(
        <View key={d.day} style={ps.batEditRow}>
          <Text style={ps.batEditDay}>{d.day}</Text>
          <View style={{flex:1,gap:6}}>
            <TextInput style={ps.editInput} value={d.label} onChangeText={v=>setField(idx,'label',v)} placeholder="Focus" placeholderTextColor={colors.textFaint}/>
            <TextInput style={[ps.editInput,ps.editInputMulti]} value={d.desc} onChangeText={v=>setField(idx,'desc',v)} placeholder="Description" placeholderTextColor={colors.textFaint} multiline/>
          </View>
        </View>
      ))}
    </>
  );
}

export function DailyPanel({hud}){
  return(
    <>
      <View style={ps.wvfSection}>
        <Text style={ps.wvfLabel}>WORD OF THE DAY</Text>
        <Text style={ps.wordMain}>{hud?.word_of_day||'—'}</Text>
        <Text style={ps.wordPhon}>{hud?.word_phonetic||''}</Text>
        <Text style={ps.wvfText}>{hud?.word_def||''}</Text>
      </View>
      <View style={ps.wvfSection}>
        <Text style={ps.wvfLabel}>VERSE OF THE DAY</Text>
        <Text style={ps.verseText}>“{hud?.verse_of_day||'—'}”</Text>
        <Text style={ps.verseRef}>{hud?.verse_ref||''}</Text>
      </View>
      <View style={[ps.wvfSection,ps.wvfSectionLast]}>
        <Text style={ps.wvfLabel}>FACT OF THE DAY</Text>
        <Text style={ps.wvfText}>{hud?.fact_of_day||'—'}</Text>
      </View>
    </>
  );
}

// Live XAUUSD quote + Atlas's open gold positions. Polls only while the HUD is
// focused (assisted-trading boundary — nothing runs in the background).
export function MarketPanel(){
  const[quote,setQuote]=useState(null);
  const[positions,setPositions]=useState([]);
  const[connected,setConnected]=useState(true);
  const[busy,setBusy]=useState(null);
  const alive=useRef(true);

  const poll=useCallback(async()=>{
    if(!tlStatus().connected){if(alive.current)setConnected(false);return;}
    if(alive.current)setConnected(true);
    try{
      const[q,ps2]=await Promise.all([tlQuote('XAUUSD').catch(()=>null),tlPositions().catch(()=>[])]);
      if(!alive.current)return;
      if(q)setQuote(q);
      setPositions((ps2||[]).filter(p=>Number(p.qty)>0));
    }catch{}
  },[]);

  useFocusEffect(useCallback(()=>{
    alive.current=true;
    poll();
    const iv=setInterval(poll,4500);
    return()=>{alive.current=false;clearInterval(iv);};
  },[poll]));

  async function close(id){
    setBusy(id);
    try{await tlClosePosition(id);await poll();}catch{}
    finally{setBusy(null);}
  }

  if(!connected)return(
    <View style={{paddingVertical:space.xl,alignItems:'center',gap:space.sm}}>
      <Feather name="bar-chart-2" size={20} color={colors.textFaint}/>
      <Text style={ps.mktHint}>TradeLocker not connected.{'\n'}Add your login in Settings › Trading.</Text>
    </View>
  );

  const totalPl=positions.reduce((a,p)=>a+(Number(p.unrealizedPl)||0),0);
  const plColor=totalPl>=0?colors.online:colors.danger;

  return(
    <>
      <View style={ps.mktQuoteRow}>
        <View>
          <Text style={ps.mktLabel}>XAUUSD</Text>
          <Text style={ps.mktMid}>{quote?.mid!=null?quote.mid.toFixed(2):'—'}</Text>
        </View>
        <View style={{alignItems:'flex-end'}}>
          <Text style={ps.mktSub}>BID {quote?.bid??'—'}</Text>
          <Text style={ps.mktSub}>ASK {quote?.ask??'—'}</Text>
        </View>
      </View>

      {positions.length>0?(
        <>
          <View style={ps.mktHeadRow}>
            <Text style={ps.headHint}>{positions.length} OPEN</Text>
            <Text style={[ps.mktTotalPl,{color:plColor}]}>{totalPl>=0?'+':''}{totalPl.toFixed(2)}</Text>
          </View>
          {positions.map(p=>{
            const pl=Number(p.unrealizedPl)||0;
            return(
              <View key={p.id} style={ps.mktPosRow}>
                <Text style={[ps.mktSide,{color:p.side==='buy'?colors.online:colors.danger}]}>{p.side==='buy'?'▲':'▼'} {p.qty}</Text>
                <Text style={ps.mktEntry}>@ {Number(p.avgPrice).toFixed(2)}</Text>
                <Text style={[ps.mktPl,{color:pl>=0?colors.online:colors.danger}]}>{pl>=0?'+':''}{pl.toFixed(2)}</Text>
                <TouchableOpacity style={ps.mktClose} disabled={!!busy} onPress={()=>close(p.id)}>
                  {busy===p.id?<ActivityIndicator size="small" color={colors.danger}/>:<Text style={ps.mktCloseT}>CLOSE</Text>}
                </TouchableOpacity>
              </View>
            );
          })}
        </>
      ):(
        <Text style={ps.emptyText}>No open gold positions.</Text>
      )}
    </>
  );
}

export const ps=StyleSheet.create({
  headRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:space.lg},
  headBtns:{flexDirection:'row',alignItems:'center',gap:space.md},
  headMeta:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:2},
  headHint:{...type.meta,color:colors.textDim},
  addBtn:{flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:space.md,paddingVertical:6,backgroundColor:colors.gold,borderRadius:radius.sm},
  addBtnT:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.bg,letterSpacing:2},
  ghostBtn:{flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:space.sm,paddingVertical:5,borderWidth:1,borderColor:colors.hairlineGold,borderRadius:radius.sm},
  ghostBtnT:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:2},

  briefRow:{flexDirection:'row',alignItems:'center',gap:space.lg,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  briefIcon:{width:26,alignItems:'center'},
  briefMain:{fontFamily:FONTS.mono,fontSize:13,color:colors.text,letterSpacing:0.2},
  briefSub:{fontFamily:FONTS.mono,fontSize:8,color:colors.textDim,marginTop:3,letterSpacing:0.5,lineHeight:13},
  briefNote:{...type.meta,color:colors.textFaint,marginTop:space.xl,lineHeight:15},

  bizGrid:{flexDirection:'row',flexWrap:'wrap',rowGap:space.md,columnGap:space.sm},
  bizItem:{width:(width-space.xl*2-space.sm*2)/3,alignItems:'center',paddingVertical:space.sm},
  bizRing:{width:62,height:62,alignItems:'center',justifyContent:'center'},
  bizRingCore:{position:'absolute',alignItems:'center',justifyContent:'center'},
  bizPct:{fontFamily:FONTS.monoMed,fontSize:12,color:colors.text},
  bizName:{fontFamily:FONTS.mono,fontSize:7,color:colors.textMuted,textAlign:'center',marginTop:space.sm,letterSpacing:0.5,lineHeight:11},

  taskRow:{flexDirection:'row',alignItems:'center',gap:space.md,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  taskName:{fontFamily:FONTS.mono,fontSize:13,color:colors.text,flex:1,letterSpacing:0.2},
  taskNameDone:{color:colors.textFaint,textDecorationLine:'line-through'},
  emptyText:{...type.meta,color:colors.textFaint,marginTop:space.md},
  hintText:{...type.meta,color:colors.textFaint,marginTop:space.md,letterSpacing:0.5},

  editRow:{flexDirection:'row',alignItems:'center',gap:space.sm,paddingVertical:6,borderBottomWidth:1,borderBottomColor:colors.hairline},
  reorderCol:{alignItems:'center'},
  editInput:{flex:1,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.sm,paddingHorizontal:space.md,paddingVertical:8,color:colors.text,fontFamily:FONTS.mono,fontSize:13},
  editInputMulti:{minHeight:38,textAlignVertical:'top'},
  addItemRow:{flexDirection:'row',alignItems:'center',gap:space.sm,paddingVertical:space.md,marginTop:space.sm},
  addItemT:{fontFamily:FONTS.monoMed,fontSize:11,color:colors.gold,letterSpacing:1},

  batTitle:{fontFamily:FONTS.displayMed,fontSize:32,color:colors.text,letterSpacing:0.5,marginBottom:space.xs},
  batDesc:{fontFamily:FONTS.mono,fontSize:9,color:colors.textMuted,lineHeight:16,marginBottom:space.xl},
  batWeek:{flexDirection:'row',gap:6,flexWrap:'wrap'},
  batDay:{flex:1,minWidth:64,alignItems:'center',paddingVertical:space.md,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.sm},
  batDayToday:{borderColor:colors.hairlineGold,backgroundColor:'rgba(232,201,138,0.06)'},
  batDayT:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:1.5},
  batDayTToday:{color:colors.gold},
  batEditRow:{flexDirection:'row',gap:space.md,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  batEditDay:{fontFamily:FONTS.monoMed,fontSize:10,color:colors.gold,letterSpacing:1.5,width:34,paddingTop:10},

  wvfSection:{paddingVertical:space.lg,borderBottomWidth:1,borderBottomColor:colors.hairline},
  wvfSectionLast:{borderBottomWidth:0},
  wvfLabel:{fontFamily:FONTS.mono,fontSize:8,letterSpacing:2.5,color:colors.textDim,marginBottom:space.md},
  wordMain:{...type.word},
  wordPhon:{fontFamily:FONTS.mono,fontSize:10,color:colors.textDim,marginTop:4,marginBottom:space.sm,letterSpacing:0.5},
  wvfText:{fontFamily:FONTS.mono,fontSize:12,color:colors.textMuted,lineHeight:19,letterSpacing:0.2},
  verseText:{...type.verse,marginBottom:space.sm},
  verseRef:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:2},

  mktHint:{fontFamily:FONTS.mono,fontSize:9,color:colors.textFaint,textAlign:'center',lineHeight:15,letterSpacing:0.5},
  mktQuoteRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',paddingBottom:space.lg,borderBottomWidth:1,borderBottomColor:colors.hairline},
  mktLabel:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:2},
  mktMid:{fontFamily:FONTS.displaySemi,fontSize:34,color:colors.goldBright,letterSpacing:1,marginTop:2},
  mktSub:{fontFamily:FONTS.mono,fontSize:9,color:colors.textMuted,letterSpacing:1,marginTop:2},
  mktHeadRow:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginTop:space.lg,marginBottom:space.sm},
  mktTotalPl:{fontFamily:FONTS.monoMed,fontSize:12,fontWeight:'700'},
  mktPosRow:{flexDirection:'row',alignItems:'center',gap:space.md,paddingVertical:space.md,borderBottomWidth:1,borderBottomColor:colors.hairline},
  mktSide:{fontFamily:FONTS.monoMed,fontSize:12,fontWeight:'700',width:52},
  mktEntry:{fontFamily:FONTS.mono,fontSize:11,color:colors.textMuted,flex:1},
  mktPl:{fontFamily:FONTS.monoMed,fontSize:11,fontWeight:'700',width:70,textAlign:'right'},
  mktClose:{borderWidth:1,borderColor:'rgba(199,97,75,0.4)',borderRadius:radius.sm,paddingHorizontal:8,paddingVertical:4,minWidth:52,alignItems:'center'},
  mktCloseT:{fontFamily:FONTS.mono,fontSize:8,color:colors.danger,letterSpacing:1},
});
