// Renders detached HUD panels as floating cards over the whole app, so a panel
// JARVIS pops out with [HUD_DETACH] stays on screen after you leave the HUD. It
// draws nothing on the HUD screen itself — every module is already in the HUD's
// vertical feed there.
import React,{useState,useEffect,useCallback}from 'react';
import{View,StyleSheet}from 'react-native';
import{getHudLayout,setPanelLayout}from '../../services/database';
import FloatingCard from './FloatingCard';
import FloatPanel from './FloatPanel';
import{PANEL_META}from './panels';

export default function HudFloatLayer({navRef}){
  const[routeName,setRouteName]=useState(null);
  const[layout,setLayout]=useState({});

  const readRoute=useCallback(()=>{
    try{
      const n=navRef&&navRef.isReady?.()?navRef.getCurrentRoute?.()?.name||null:null;
      setRouteName(prev=>prev===n?prev:n);
    }catch{}
  },[navRef]);

  const refresh=useCallback(async()=>{
    readRoute();
    try{setLayout(await getHudLayout());}catch{}
  },[readRoute]);

  // Track the active route off the navigation container ref…
  useEffect(()=>{
    if(!navRef)return;
    readRoute();
    let unsub;
    try{unsub=navRef.addListener?.('state',readRoute);}catch{}
    return()=>{if(typeof unsub==='function')unsub();};
  },[navRef,readRoute]);

  // …and self-heal on a slow poll (also picks up a just-detached panel and
  // cross-device layout sync).
  useEffect(()=>{refresh();},[routeName,refresh]);
  useEffect(()=>{const iv=setInterval(refresh,4000);return()=>clearInterval(iv);},[refresh]);

  if(routeName==='HUD'||routeName==='Splash'||!routeName)return null;

  const keys=Object.keys(layout).filter(k=>layout[k]?.detached);
  if(!keys.length)return null;

  const persist=(key,patch)=>{
    setLayout(l=>({...l,[key]:{...l[key],...patch}}));
    setPanelLayout(key,patch).catch(()=>{});
  };
  const dock=(key)=>{
    setLayout(l=>({...l,[key]:{...l[key],detached:false}}));
    setPanelLayout(key,{detached:0}).catch(()=>{});
  };
  const front=(key)=>{
    const top=Math.max(0,...keys.map(k=>layout[k]?.z||0));
    if((layout[key]?.z||0)>=top)return;
    persist(key,{z:top+1});
  };
  const openHud=()=>{try{navRef?.navigate?.('HUD');}catch{}};

  return(
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {keys.map(key=>(
        <FloatingCard
          key={key}
          title={PANEL_META[key]?.title||key.toUpperCase()}
          initial={layout[key]}
          z={layout[key]?.z||0}
          onFront={()=>front(key)}
          onPersist={(patch)=>persist(key,patch)}
          onDock={()=>dock(key)}
        >
          <FloatPanel kind={key} active onOpenHud={openHud}/>
        </FloatingCard>
      ))}
    </View>
  );
}
