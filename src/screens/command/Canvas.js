// The Canvas — the visualization panel when a persona has surfaced something
// interactive instead of the orb. One `artifact` object ({kind, ...}) drives it;
// the orb underneath stays mounted so closing the Canvas reveals it again.
//
//   kind 'chart'  -> ChartOverlay (its own header/close, rendered bare)
//   kind 'notes'  -> NotesCanvas  (list <-> a single editable note)
//   kind 'tasks'  -> TasksCanvas  (tasks + morning routine, editable)
//
// Mounts with a quick scale/fade so the orb reads as transforming into it.
// Exposes back() so the header + hardware back pop an inner view (a note ->
// the list) before the whole surface closes.
import React,{useRef,useState,useEffect,useImperativeHandle,forwardRef}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Animated,Easing}from 'react-native';
import{Feather}from '@expo/vector-icons';
import{colors}from '../../theme';
import ChartOverlay from './ChartOverlay';
import NotesCanvas from './canvas/NotesCanvas';
import TasksCanvas from './canvas/TasksCanvas';
import AnalyticsBoard from './canvas/AnalyticsBoard';

const DEFAULT_TITLE={notes:'NOTES',tasks:'TASKS & ROUTINE',chart:'CHART',analytics:'THE ALMANAC'};

export default forwardRef(function Canvas({artifact,accent=colors.gold,onClose},ref){
  const childRef=useRef(null);
  const[title,setTitle]=useState(null);
  const enter=useRef(new Animated.Value(0)).current;

  useEffect(()=>{
    enter.setValue(0);
    Animated.timing(enter,{toValue:1,duration:240,easing:Easing.out(Easing.cubic),useNativeDriver:true}).start();
  },[artifact?.kind,enter]);

  useImperativeHandle(ref,()=>({
    back(){return !!(childRef.current&&childRef.current.back&&childRef.current.back());},
  }),[]);

  if(!artifact)return null;
  const kind=artifact.kind;

  const anim={
    opacity:enter,
    transform:[{scale:enter.interpolate({inputRange:[0,1],outputRange:[0.9,1]})}],
  };

  // Chart carries its own chrome — render it straight, just wrapped for the anim.
  if(kind==='chart'){
    return(
      <Animated.View style={[StyleSheet.absoluteFill,s.bg,anim]}>
        <ChartOverlay spec={artifact.spec} accent={accent} onClose={onClose}/>
      </Animated.View>
    );
  }

  return(
    <Animated.View style={[StyleSheet.absoluteFill,s.bg,anim]}>
      <View style={s.head}>
        <Text style={[s.title,{color:accent}]} numberOfLines={1}>{title||DEFAULT_TITLE[kind]||'CANVAS'}</Text>
        <TouchableOpacity style={s.close} onPress={onClose} hitSlop={{top:8,bottom:8,left:8,right:8}}>
          <Feather name="x" size={13} color={colors.textDim}/>
          <Text style={s.closeT}>CLOSE</Text>
        </TouchableOpacity>
      </View>
      <View style={{flex:1}}>
        {kind==='notes'&&<NotesCanvas ref={childRef} accent={accent} open={artifact.open} onTitle={setTitle}/>}
        {kind==='tasks'&&<TasksCanvas ref={childRef} accent={accent}/>}
        {kind==='analytics'&&<AnalyticsBoard accent={accent}/>}
      </View>
    </Animated.View>
  );
});

const s=StyleSheet.create({
  bg:{backgroundColor:colors.bg},
  head:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',paddingHorizontal:14,paddingTop:12,paddingBottom:8,borderBottomWidth:1,borderBottomColor:'#141210'},
  title:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:2,flex:1},
  close:{flexDirection:'row',alignItems:'center',gap:4,borderWidth:1,borderColor:'#2a2620',borderRadius:4,paddingHorizontal:8,paddingVertical:5},
  closeT:{fontFamily:'monospace',fontSize:8,color:colors.textDim,letterSpacing:1},
});
