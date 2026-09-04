// Live board of S.C.O.U.T.'s outreach pipeline. Reads the local `leads` table,
// which S.C.O.U.T. drives from chat via [LEAD_ADD] / [LEAD_UPDATE] / [LEAD_LOG].
// Shown for S.C.O.U.T. in the Command screen. Mirrors BuildPanel / TradePanel.
import React,{useState,useEffect,useRef,useCallback}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{getAllLeads,deleteLead,getSetting}from '../../services/database';

const POLL_MS=5000;
const ACCENT='#2E86FF';

const STAGE_LABEL={
  inbound:'INBOUND',new:'NEW',contacted:'CONTACTED',replied:'REPLIED',qualifying:'QUALIFYING',
  call_booked:'CALL BOOKED',won:'WON',lost:'LOST',cold:'COLD',
};
const STAGE_COLOR={
  inbound:'#E8C98A',new:'#8A7A55',contacted:'#D9A441',replied:'#4CA3D9',qualifying:'#7C83FF',
  call_booked:'#5FA779',won:'#5FA779',lost:'#C7614B',cold:'#666',
};
const STAGE_ORDER=['inbound','new','contacted','replied','qualifying','call_booked','won','lost','cold'];

function todayStr(){return new Date().toISOString().split('T')[0];}
function touchLabel(d){
  if(!d)return null;
  const t=todayStr();
  if(d<t)return{text:`overdue · ${d}`,color:'#C7614B'};
  if(d===t)return{text:'due today',color:'#D9A441'};
  return{text:`next ${d}`,color:'#5a5145'};
}

export default function LeadsPanel({active}){
  const[leads,setLeads]=useState([]);
  const[collapsed,setCollapsed]=useState(false);
  const[open,setOpen]=useState(null); // expanded lead id
  const[auto,setAuto]=useState(false);
  const alive=useRef(true);

  const load=useCallback(async()=>{
    try{const l=await getAllLeads();if(alive.current)setLeads(l);}catch{}
    try{const a=(await getSetting('auto_scout','0'))==='1';if(alive.current)setAuto(a);}catch{}
  },[]);

  useEffect(()=>{
    alive.current=true;
    if(active){
      load();
      const iv=setInterval(load,POLL_MS);
      return()=>{alive.current=false;clearInterval(iv);};
    }
    return()=>{alive.current=false;};
  },[active,load]);

  if(!leads.length)return null;

  const tally=STAGE_ORDER
    .map(st=>({st,n:leads.filter(l=>l.stage===st).length}))
    .filter(x=>x.n)
    .map(x=>`${x.n} ${STAGE_LABEL[x.st].toLowerCase()}`)
    .join(' · ');

  return(
    <View style={[s.wrap,{borderColor:ACCENT+'33'}]}>
      <TouchableOpacity style={s.hdr} activeOpacity={0.7} onPress={()=>setCollapsed(c=>!c)}>
        <Text style={[s.hdrLabel,{color:ACCENT}]}>◆ PIPELINE · {leads.length} LEAD{leads.length===1?'':'S'}{auto?'  ·  AUTO':''}</Text>
        <Text style={s.hdrChevron}>{collapsed?'▸':'▾'}</Text>
      </TouchableOpacity>
      {!collapsed&&!!tally&&<Text style={s.tally}>{tally}</Text>}
      {!collapsed&&leads.map(l=>{
        const tl=touchLabel(l.next_touch);
        const topLog=(l.log||'').split('\n')[0]||'';
        const isOpen=open===l.id;
        return(
          <View key={l.id} style={s.row}>
            <TouchableOpacity activeOpacity={0.7} onPress={()=>setOpen(isOpen?null:l.id)}>
              <View style={s.rowTop}>
                <Text style={[s.stage,{color:STAGE_COLOR[l.stage]||'#888'}]}>{STAGE_LABEL[l.stage]||l.stage?.toUpperCase()}</Text>
                {!!tl&&<Text style={[s.touch,{color:tl.color}]}>{tl.text}</Text>}
                <View style={{flex:1}}/>
                <TouchableOpacity onPress={()=>{deleteLead(l.id).then(load);}} hitSlop={{top:8,bottom:8,left:8,right:8}}>
                  <Text style={s.x}>✕</Text>
                </TouchableOpacity>
              </View>
              <Text style={s.name} numberOfLines={1}>{l.name}</Text>
              {!!l.business&&<Text style={s.business} numberOfLines={1}>{l.business}</Text>}
              <Text style={s.contact} numberOfLines={1}>{l.contact?l.contact:'needs contact'}</Text>
              {!!l.next_action&&!isOpen&&<Text style={s.next} numberOfLines={1}>→ {l.next_action}</Text>}
              {!!topLog&&!isOpen&&<Text style={s.logLine} numberOfLines={1}>{topLog}</Text>}
            </TouchableOpacity>
            {isOpen&&(
              <View style={s.detail}>
                {!!l.website&&<Text style={s.dK}>site  <Text style={s.dV}>{l.website}</Text></Text>}
                {!!l.segment&&<Text style={s.dK}>seg   <Text style={s.dV}>{l.segment}</Text></Text>}
                {!!l.bottleneck&&<Text style={s.dK}>pain  <Text style={s.dV}>{l.bottleneck}</Text></Text>}
                {!!l.value&&<Text style={s.dK}>value <Text style={s.dV}>{l.value}</Text></Text>}
                {!!l.next_action&&<Text style={s.dK}>next  <Text style={s.dV}>{l.next_action}</Text></Text>}
                {!!l.log&&<Text style={s.log}>{l.log}</Text>}
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const s=StyleSheet.create({
  wrap:{marginHorizontal:10,marginTop:4,borderWidth:1,borderRadius:8,backgroundColor:'#080706',overflow:'hidden'},
  hdr:{flexDirection:'row',justifyContent:'space-between',alignItems:'center',paddingHorizontal:12,paddingVertical:8},
  hdrLabel:{fontFamily:'monospace',fontSize:9,letterSpacing:2},
  hdrChevron:{fontFamily:'monospace',fontSize:9,color:'#555'},
  tally:{fontFamily:'monospace',fontSize:8,color:'#6a6250',letterSpacing:1,paddingHorizontal:12,paddingBottom:6},
  row:{paddingHorizontal:12,paddingVertical:8,borderTopWidth:1,borderTopColor:'#141210',gap:3},
  rowTop:{flexDirection:'row',alignItems:'center',gap:8},
  stage:{fontFamily:'monospace',fontSize:8,fontWeight:'700',letterSpacing:1},
  touch:{fontFamily:'monospace',fontSize:8},
  x:{fontFamily:'monospace',fontSize:10,color:'#5a5145'},
  name:{fontFamily:'monospace',fontSize:11,color:'#C9BEA6'},
  business:{fontFamily:'monospace',fontSize:9,color:'#8a8069'},
  contact:{fontFamily:'monospace',fontSize:8,color:'#6a6250'},
  next:{fontFamily:'monospace',fontSize:9,color:'#7fa8c9',marginTop:1},
  logLine:{fontFamily:'monospace',fontSize:8,color:'#5a5145',marginTop:1},
  detail:{marginTop:6,paddingTop:6,borderTopWidth:1,borderTopColor:'#141210',gap:3},
  dK:{fontFamily:'monospace',fontSize:8,color:'#6a6250',letterSpacing:0.5},
  dV:{color:'#B7AC97'},
  log:{fontFamily:'monospace',fontSize:8,color:'#8a8069',lineHeight:13,marginTop:2},
});
