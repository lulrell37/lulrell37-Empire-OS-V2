// W.I.R.E.'s news board on the Canvas ([SHOW_NEWS]) — the same NewsPanel the HUD
// shows, wrapped in a scroll view. Reads hud_state; the newsWire engine keeps it
// current. Re-reads while mounted so a brief that lands stays fresh.
import React,{useState,useEffect,useCallback,useRef}from 'react';
import{ScrollView,StyleSheet}from 'react-native';
import{colors}from '../../../theme';
import{getHudState}from '../../../services/database';
import{NewsPanel}from '../../hud/panels';

export default function NewsCanvas({accent=colors.gold}){
  const[hud,setHud]=useState(null);
  const alive=useRef(true);

  const load=useCallback(async()=>{
    try{const h=await getHudState();if(alive.current)setHud(h);}catch{}
  },[]);

  useEffect(()=>{
    alive.current=true;
    load();
    const iv=setInterval(load,8000);
    return()=>{alive.current=false;clearInterval(iv);};
  },[load]);

  return(
    <ScrollView style={s.wrap} contentContainerStyle={s.content}>
      <NewsPanel hud={hud} onRefreshed={load}/>
    </ScrollView>
  );
}

const s=StyleSheet.create({
  wrap:{flex:1},
  content:{padding:14,paddingBottom:40},
});
