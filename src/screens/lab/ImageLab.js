// The Laboratory's IMAGE tab — put a photo on the bench and talk it through
// with any persona, live, about exactly the part you're looking at.
//
//  - Drag to move, pinch to zoom, double-tap to zoom into a spot (again to
//    reset), tap to point at something ("what's this?").
//  - Every question carries two pictures: the whole photo, and a crop of
//    precisely what's on screen right now — so "what's this part?" means the
//    part you're zoomed into, not the photo in general.
//  - LIVE: hands-free voice. Talk, they answer in their own voice, the mic
//    reopens. With AUTO on, settling on a new part of the photo gets a short
//    comment on it without asking (it interrupts their previous comment, but
//    never you mid-sentence).
//  - MAKE 3D sends the photo to Meshy (same key as the 3D diagram) and drops
//    the model into the 3D tab when it's ready.
import React,{useEffect,useRef,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,TextInput,ActivityIndicator,ScrollView,Image,Modal}from 'react-native';
import Animated,{useSharedValue,useAnimatedStyle,withTiming,runOnJS}from 'react-native-reanimated';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import*as ImagePicker from 'expo-image-picker';
import*as ImageManipulator from 'expo-image-manipulator';
import{Feather}from '@expo/vector-icons';
import{callPersona}from '../../services/aiService';
import{savePersonaMemory}from '../../services/database';
import{listen,speakAs,stopAll,stopListening,stopSpeaking}from '../../services/labVoice';
import{generateModelFromImage}from '../../services/models3d';
import{PERSONA_LIST,getPersona}from '../../personas/personas';
import useEmpireStore from '../../store/useEmpireStore';
import{colors,space,radius,FONTS}from '../../theme';

const MAX_ZOOM=8;
const SETTLE_MS=750;        // view must sit still this long before AUTO comments
const HISTORY_TURNS=8;

const clampW=(v,lo,hi)=>{'worklet';return v<lo?lo:v>hi?hi:v;};

export default function ImageLab({onModelReady}){
  const[img,setImg]=useState(null);           // {uri,width,height}
  const[pid,setPid]=useState('jarvis');
  const[live,setLive]=useState(false);
  const[auto,setAuto]=useState(true);
  const[status,setStatus]=useState('idle');  // idle | listening | thinking | speaking
  const[heard,setHeard]=useState('');
  const[answer,setAnswer]=useState('');
  const[err,setErr]=useState('');
  const[point,setPoint]=useState(null);       // {ix,iy} in image px
  const[question,setQuestion]=useState('');
  const[make3d,setMake3d]=useState({state:'idle',pct:0,err:''});
  const[ask3d,setAsk3d]=useState(false);

  const setDiagramModel=useEmpireStore(s=>s.setDiagramModel);

  // layout + transform, readable from the UI thread
  const cw=useSharedValue(1),ch=useSharedValue(1),iw=useSharedValue(1),ih=useSharedValue(1);
  const sc=useSharedValue(1),tx=useSharedValue(0),ty=useSharedValue(0);
  const s0=useSharedValue(1),tx0=useSharedValue(0),ty0=useSharedValue(0),kx=useSharedValue(0),ky=useSharedValue(0);
  const[box,setBox]=useState({w:1,h:1});

  const imgRef=useRef(null);
  const overviewRef=useRef(null);   // base64 of the whole photo, small
  const viewRef=useRef({s:1,tx:0,ty:0});
  const pointRef=useRef(null);
  const liveRef=useRef(false);
  const autoRef=useRef(true);
  const pidRef=useRef(pid);
  const turnRef=useRef(0);
  const abortRef=useRef(null);
  const histRef=useRef([]);
  const settleRef=useRef(null);
  const lastCommentRef=useRef(null);
  const lastVoiceAtRef=useRef(0);
  const statusRef=useRef('idle');

  const setSt=(v)=>{statusRef.current=v;setStatus(v);};
  useEffect(()=>{pidRef.current=pid;histRef.current=[];},[pid]);
  useEffect(()=>{autoRef.current=auto;},[auto]);
  useEffect(()=>()=>{liveRef.current=false;turnRef.current++;abortRef.current?.abort();stopAll();clearTimeout(settleRef.current);},[]);

  // ---- picking a photo -------------------------------------------------
  async function pick(fromCamera){
    try{
      const perm=fromCamera?await ImagePicker.requestCameraPermissionsAsync():await ImagePicker.requestMediaLibraryPermissionsAsync();
      if(perm.status!=='granted'){setErr(fromCamera?'Camera access needed — grant it in Settings':'Photo access needed — grant it in Settings');return;}
      const opts={mediaTypes:ImagePicker.MediaTypeOptions.Images,quality:1};
      const r=fromCamera?await ImagePicker.launchCameraAsync(opts):await ImagePicker.launchImageLibraryAsync(opts);
      if(r.canceled||!r.assets?.length)return;
      const a=r.assets[0];
      // Re-encode once: bakes in EXIF rotation (so crop coordinates match what's
      // on screen) and caps the size for fast crops.
      const big=Math.max(a.width||0,a.height||0);
      const acts=big>2400?[{resize:(a.width||0)>=(a.height||0)?{width:2400}:{height:2400}}]:[];
      const norm=await ImageManipulator.manipulateAsync(a.uri,acts,{compress:0.9,format:ImageManipulator.SaveFormat.JPEG});
      const ov=await ImageManipulator.manipulateAsync(norm.uri,[{resize:norm.width>=norm.height?{width:Math.min(768,norm.width)}:{height:Math.min(768,norm.height)}}],{compress:0.6,format:ImageManipulator.SaveFormat.JPEG,base64:true});
      overviewRef.current=ov.base64;
      await interrupt();
      histRef.current=[];lastCommentRef.current=null;
      pointRef.current=null;setPoint(null);setAnswer('');setHeard('');setErr('');
      sc.value=1;tx.value=0;ty.value=0;viewRef.current={s:1,tx:0,ty:0};
      iw.value=norm.width;ih.value=norm.height;
      imgRef.current={uri:norm.uri,width:norm.width,height:norm.height};
      setImg(imgRef.current);
      setMake3d({state:'idle',pct:0,err:''});
      // First look: they say what they see.
      turn('auto','(He just put this photo on the bench. In a sentence or two, say what you see and what stands out — then let him lead.)');
    }catch(e){setErr('Could not open that photo: '+String(e?.message||e).slice(0,140));}
  }

  // ---- geometry ----------------------------------------------------------
  function fitInfo(){
    const im=imgRef.current;if(!im)return null;
    const fit=Math.min(box.w/im.width,box.h/im.height);
    return{fit,dw:im.width*fit,dh:im.height*fit,offX:(box.w-im.width*fit)/2,offY:(box.h-im.height*fit)/2};
  }
  // What's on screen right now, in image pixels.
  function visibleRect(){
    const im=imgRef.current;const f=fitInfo();if(!im||!f)return null;
    const{s,tx:x,ty:y}=viewRef.current;
    const toImg=(px,py)=>{
      const qx=box.w/2+(px-box.w/2-x)/s,qy=box.h/2+(py-box.h/2-y)/s;
      return[(qx-f.offX)/f.fit,(qy-f.offY)/f.fit];
    };
    const[ax,ay]=toImg(0,0),[bx,by]=toImg(box.w,box.h);
    const x0=Math.max(0,Math.min(im.width,ax)),y0=Math.max(0,Math.min(im.height,ay));
    const x1=Math.max(0,Math.min(im.width,bx)),y1=Math.max(0,Math.min(im.height,by));
    return{x0,y0,x1,y1,w:x1-x0,h:y1-y0,zoom:s};
  }

  async function viewImages(){
    const im=imgRef.current;const r=visibleRect();
    if(!im||!r||r.w<8||r.h<8)return{images:overviewRef.current?[{data:overviewRef.current,mime:'image/jpeg'}]:[],desc:'the whole photo',whole:true};
    const whole=r.w>=im.width*0.95&&r.h>=im.height*0.95;
    const crop=await ImageManipulator.manipulateAsync(im.uri,[
      ...(whole?[]:[{crop:{originX:Math.floor(r.x0),originY:Math.floor(r.y0),width:Math.floor(r.w),height:Math.floor(r.h)}}]),
      {resize:r.w>=r.h?{width:Math.min(1024,Math.floor(r.w))}:{height:Math.min(1024,Math.floor(r.h))}},
    ],{compress:0.75,format:ImageManipulator.SaveFormat.JPEG,base64:true});
    const pct=(v,t)=>Math.round(v/t*100);
    const desc=whole?'the whole photo':`zoomed in ${r.zoom.toFixed(1)}x on the region from ${pct(r.x0,im.width)}% to ${pct(r.x1,im.width)}% across and ${pct(r.y0,im.height)}% to ${pct(r.y1,im.height)}% down`;
    let pointDesc='';
    const p=pointRef.current;
    if(p){
      const inView=p.ix>=r.x0&&p.ix<=r.x1&&p.iy>=r.y0&&p.iy<=r.y1;
      pointDesc=inView
        ?` He is pointing at a specific spot: ${pct(p.ix-r.x0,r.w)}% from the left and ${pct(p.iy-r.y0,r.h)}% from the top of ${whole?'the photo':'Image 2'}.`
        :` He marked a spot at ${pct(p.ix,im.width)}% across and ${pct(p.iy,im.height)}% down the whole photo (it's off-screen now).`;
    }
    const images=whole
      ?[{data:crop.base64,mime:'image/jpeg'}]
      :[{data:overviewRef.current,mime:'image/jpeg'},{data:crop.base64,mime:'image/jpeg'}].filter(x=>x.data);
    return{images,desc,whole,pointDesc};
  }

  // ---- talking -----------------------------------------------------------
  async function interrupt(){
    turnRef.current++;
    abortRef.current?.abort();abortRef.current=null;
    await stopAll();
  }

  // kind: 'ask' (he said/typed something) | 'auto' (a look at the current view)
  async function turn(kind,text){
    if(!imgRef.current)return;
    await interrupt();
    const gen=turnRef.current;
    const ac=new AbortController();abortRef.current=ac;
    const id=pidRef.current;const p=getPersona(id);
    setErr('');setSt('thinking');
    if(kind==='ask')setHeard(text);
    try{
      const v=await viewImages();
      if(gen!==turnRef.current)return;
      const frame=`[LABORATORY — Mr. Burrus has a photo open and is going over it with you, live, by voice. ${v.whole?'The image is the whole photo, exactly as he sees it.':'Image 1 is the whole photo for context. Image 2 is exactly what is on his screen right now —'} ${v.whole?'':v.desc+'.'}${v.pointDesc||''} Talk about what he's actually looking at — be specific to that part. This is spoken out loud: 1-4 natural sentences, no lists, no markdown, no "in this image" preamble.]`;
      const msgs=[...histRef.current.slice(-HISTORY_TURNS*2),{role:'user',content:`${frame}\n\n${text}`}];
      const reply=(await callPersona(id,msgs,ac.signal,null,{skipSave:true,images:v.images,maxTokens:450})||'').trim();
      if(gen!==turnRef.current||!reply)return;
      histRef.current=[...histRef.current,{role:'user',content:kind==='ask'?text:'(looked at a new part of the photo)'},{role:'assistant',content:reply}].slice(-HISTORY_TURNS*2);
      lastCommentRef.current=visibleRect();
      setAnswer(reply);
      if(kind==='ask')savePersonaMemory(id,`[Laboratory — talking over a photo] YOU: ${text}\n${p.name}: ${reply}`).catch(()=>{});
      setSt('speaking');
      await speakAs(id,reply,{signal:ac.signal});
      if(gen!==turnRef.current)return;
      setSt('idle');
      if(liveRef.current)listenLoop();
    }catch(e){
      if(e?.name==='AbortError'||gen!==turnRef.current)return;
      setErr(`${p?.name||'They'} couldn't answer: ${String(e?.message||e).slice(0,140)}`);
      setSt('idle');
      if(liveRef.current)listenLoop();
    }
  }

  function listenLoop(){
    if(!liveRef.current)return;
    const gen=turnRef.current;
    setSt('listening');
    listen({onLevel:(m)=>{if(typeof m==='number'&&m>-47)lastVoiceAtRef.current=Date.now();}})
      .then(t=>{
        if(gen!==turnRef.current||!liveRef.current)return;
        if(t)turn('ask',t);
        else listenLoop();
      })
      .catch(e=>{
        if(gen!==turnRef.current)return;
        setErr('Mic problem: '+String(e?.message||e).slice(0,120));
        liveRef.current=false;setLive(false);setSt('idle');
      });
  }

  async function toggleLive(){
    if(liveRef.current){
      liveRef.current=false;setLive(false);
      await interrupt();setSt('idle');
      return;
    }
    liveRef.current=true;setLive(true);
    if(statusRef.current==='idle')listenLoop();
  }

  function sendTyped(){
    const q=question.trim();if(!q)return;
    setQuestion('');
    turn('ask',q);
  }

  async function stopTalking(){
    await interrupt();
    setSt('idle');
    if(liveRef.current)listenLoop();
  }

  // ---- gestures -> JS ----------------------------------------------------
  function onViewSettled(s,x,y){
    viewRef.current={s,tx:x,ty:y};
    clearTimeout(settleRef.current);
    if(!autoRef.current||!imgRef.current)return;
    settleRef.current=setTimeout(()=>{
      // Never talk over him: if he's mid-sentence, his question will carry this view anyway.
      if(Date.now()-lastVoiceAtRef.current<1500)return;
      if(statusRef.current==='thinking')return;
      const r=visibleRect(),last=lastCommentRef.current;
      if(!r)return;
      if(last){
        const zoomChange=Math.max(r.zoom/last.zoom,last.zoom/r.zoom);
        const cx=(r.x0+r.x1)/2-(last.x0+last.x1)/2,cy=(r.y0+r.y1)/2-(last.y0+last.y1)/2;
        const moved=Math.hypot(cx/Math.max(1,r.w),cy/Math.max(1,r.h));
        if(zoomChange<1.35&&moved<0.3)return;
      }
      turn('auto',r.zoom<1.05
        ?'(He zoomed back out to the whole photo. One short line, only if there is something new worth saying; otherwise just a brief acknowledgment.)'
        :'(He just moved in on this part. Tell him what he is looking at here, briefly and specifically. Do not repeat what you already said.)');
    },SETTLE_MS);
  }
  function onPoint(ix,iy){
    pointRef.current={ix,iy};setPoint({ix,iy});
    turn('ask','What is this, right where I\'m pointing?');
  }
  function onGestureStart(){clearTimeout(settleRef.current);}

  const settle=()=>{
    'worklet';
    const fit=Math.min(cw.value/iw.value,ch.value/ih.value);
    const mx=Math.max(0,(iw.value*fit*sc.value-cw.value)/2),my=Math.max(0,(ih.value*fit*sc.value-ch.value)/2);
    const nx=clampW(tx.value,-mx,mx),ny=clampW(ty.value,-my,my);
    tx.value=withTiming(nx,{duration:180});ty.value=withTiming(ny,{duration:180});
    runOnJS(onViewSettled)(sc.value,nx,ny);
  };

  const pinch=Gesture.Pinch()
    .onStart(e=>{
      s0.value=sc.value;tx0.value=tx.value;ty0.value=ty.value;
      kx.value=(e.focalX-cw.value/2-tx.value)/sc.value;ky.value=(e.focalY-ch.value/2-ty.value)/sc.value;
      runOnJS(onGestureStart)();
    })
    .onUpdate(e=>{
      const s=clampW(s0.value*e.scale,1,MAX_ZOOM);
      sc.value=s;
      tx.value=e.focalX-cw.value/2-s*kx.value;ty.value=e.focalY-ch.value/2-s*ky.value;
    })
    .onEnd(()=>{settle();});
  const pan=Gesture.Pan().maxPointers(1)
    .onStart(()=>{tx0.value=tx.value;ty0.value=ty.value;runOnJS(onGestureStart)();})
    .onUpdate(e=>{tx.value=tx0.value+e.translationX;ty.value=ty0.value+e.translationY;})
    .onEnd(()=>{settle();});
  const doubleTap=Gesture.Tap().numberOfTaps(2).maxDistance(20)
    .onEnd(e=>{
      if(sc.value>1.2){sc.value=withTiming(1);tx.value=withTiming(0);ty.value=withTiming(0);runOnJS(onViewSettled)(1,0,0);return;}
      const s=2.5;
      const qx=(e.x-cw.value/2-tx.value)/sc.value,qy=(e.y-ch.value/2-ty.value)/sc.value;
      const fit=Math.min(cw.value/iw.value,ch.value/ih.value);
      const mx=Math.max(0,(iw.value*fit*s-cw.value)/2),my=Math.max(0,(ih.value*fit*s-ch.value)/2);
      const nx=clampW(-s*qx,-mx,mx),ny=clampW(-s*qy,-my,my);
      sc.value=withTiming(s);tx.value=withTiming(nx);ty.value=withTiming(ny);
      runOnJS(onViewSettled)(s,nx,ny);
    });
  const tap=Gesture.Tap().maxDistance(10)
    .onEnd(e=>{
      const fit=Math.min(cw.value/iw.value,ch.value/ih.value);
      const offX=(cw.value-iw.value*fit)/2,offY=(ch.value-ih.value*fit)/2;
      const qx=cw.value/2+(e.x-cw.value/2-tx.value)/sc.value,qy=ch.value/2+(e.y-ch.value/2-ty.value)/sc.value;
      const ix=(qx-offX)/fit,iy=(qy-offY)/fit;
      if(ix<0||iy<0||ix>iw.value||iy>ih.value)return;
      runOnJS(onPoint)(ix,iy);
    });
  const gesture=Gesture.Simultaneous(pinch,pan,Gesture.Exclusive(doubleTap,tap));

  const imgStyle=useAnimatedStyle(()=>({transform:[{translateX:tx.value},{translateY:ty.value},{scale:sc.value}]}));
  const markerStyle=useAnimatedStyle(()=>({transform:[{scale:1/sc.value}]}));

  // ---- photo -> 3D -------------------------------------------------------
  async function makeModel(texture){
    setAsk3d(false);
    const im=imgRef.current;if(!im||make3d.state==='working')return;
    setMake3d({state:'working',pct:0,err:''});
    try{
      const src=await ImageManipulator.manipulateAsync(im.uri,[{resize:im.width>=im.height?{width:Math.min(1024,im.width)}:{height:Math.min(1024,im.height)}}],{compress:0.85,format:ImageManipulator.SaveFormat.JPEG,base64:true});
      const{url}=await generateModelFromImage(`data:image/jpeg;base64,${src.base64}`,{texture},(pct)=>setMake3d(m=>({...m,pct:Math.round(pct||0)})));
      const res=await fetch(url);
      if(!res.ok)throw new Error('Could not download the model ('+res.status+')');
      const buf=await res.arrayBuffer();
      setDiagramModel({buf,subject:'a 3D model made from his photo',textured:texture});
      setMake3d({state:'done',pct:100,err:''});
      onModelReady?.();
    }catch(e){
      setMake3d({state:'idle',pct:0,err:String(e?.message||e).slice(0,180)});
    }
  }

  const persona=getPersona(pid);
  const accent=persona?.color||colors.gold;
  const f=img?fitInfo():null;
  const statusLabel={idle:live?'LIVE':'READY',listening:'LISTENING…',thinking:`${persona?.name||''} IS LOOKING…`,speaking:`${persona?.name||''} IS TALKING`}[status];

  return(
    <View style={st.c}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.personas} style={st.personaBar}>
        {PERSONA_LIST.map(p=>(
          <TouchableOpacity key={p.id} onPress={()=>setPid(p.id)} style={[st.pChip,pid===p.id&&{borderColor:p.color,backgroundColor:p.color+'1A'}]} activeOpacity={0.7}>
            <Text style={[st.pChipT,pid===p.id&&{color:p.color}]}>{p.name}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={st.stage} onLayout={e=>{const{width,height}=e.nativeEvent.layout;cw.value=width;ch.value=height;setBox({w:width,h:height});}}>
        {img&&f?(
          <GestureDetector gesture={gesture}>
            <View style={StyleSheet.absoluteFill}>
              <Animated.View style={[{position:'absolute',left:f.offX,top:f.offY,width:f.dw,height:f.dh},imgStyle]}>
                <Image source={{uri:img.uri}} style={{width:f.dw,height:f.dh}} resizeMode="stretch"/>
                {point&&(
                  <Animated.View pointerEvents="none" style={[st.marker,{left:point.ix*f.fit-9,top:point.iy*f.fit-9,borderColor:accent},markerStyle]}>
                    <View style={[st.markerDot,{backgroundColor:accent}]}/>
                  </Animated.View>
                )}
              </Animated.View>
            </View>
          </GestureDetector>
        ):(
          <View style={st.empty}>
            <Feather name="image" size={28} color={colors.textDim}/>
            <Text style={st.emptyT}>Put a photo on the bench and talk it through with {persona?.name}.</Text>
            <View style={st.emptyRow}>
              <TouchableOpacity style={st.bigBtn} onPress={()=>pick(false)} activeOpacity={0.8}><Feather name="upload" size={13} color={colors.bg}/><Text style={st.bigBtnT}>UPLOAD</Text></TouchableOpacity>
              <TouchableOpacity style={st.bigBtn} onPress={()=>pick(true)} activeOpacity={0.8}><Feather name="camera" size={13} color={colors.bg}/><Text style={st.bigBtnT}>CAMERA</Text></TouchableOpacity>
            </View>
          </View>
        )}
        {img&&(
          <View style={st.statusPill} pointerEvents="none">
            {(status==='thinking')?<ActivityIndicator size="small" color={accent}/>:<View style={[st.dot,{backgroundColor:status==='idle'&&!live?colors.textDim:accent}]}/>}
            <Text style={[st.statusT,{color:status==='idle'&&!live?colors.textDim:accent}]}>{statusLabel}</Text>
          </View>
        )}
        {make3d.state==='working'&&(
          <View style={st.genPill} pointerEvents="none"><ActivityIndicator size="small" color={colors.gold}/><Text style={st.genT}>MAKING 3D… {make3d.pct?`${make3d.pct}%`:''}</Text></View>
        )}
      </View>

      {img&&<Text style={st.hint}>Drag · pinch · double-tap to zoom in/out · tap to point</Text>}

      {(!!heard||!!answer||!!err)&&(
        <View style={st.caption}>
          {!!heard&&<Text style={st.heard} numberOfLines={2}>YOU: {heard}</Text>}
          {!!answer&&<Text style={st.answer}>{answer}</Text>}
          {!!err&&<Text style={st.err}>{err}</Text>}
        </View>
      )}
      {!!make3d.err&&<Text style={st.err}>3D: {make3d.err}</Text>}

      {img&&(
        <>
          <View style={st.controls}>
            <TouchableOpacity style={[st.ctl,live&&{borderColor:accent,backgroundColor:accent+'1A'}]} onPress={toggleLive} activeOpacity={0.7}>
              <Feather name={live?'mic':'mic-off'} size={12} color={live?accent:colors.textDim}/>
              <Text style={[st.ctlT,live&&{color:accent}]}>{live?'LIVE ON':'GO LIVE'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[st.ctl,auto&&{borderColor:colors.gold}]} onPress={()=>setAuto(a=>!a)} activeOpacity={0.7}>
              <Feather name="eye" size={12} color={auto?colors.gold:colors.textDim}/>
              <Text style={[st.ctlT,auto&&{color:colors.gold}]}>{auto?'AUTO ON':'AUTO OFF'}</Text>
            </TouchableOpacity>
            {(status==='speaking'||status==='thinking')&&(
              <TouchableOpacity style={[st.ctl,{borderColor:colors.danger}]} onPress={stopTalking} activeOpacity={0.7}>
                <Feather name="square" size={11} color={colors.danger}/><Text style={[st.ctlT,{color:colors.danger}]}>STOP</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={st.ctl} onPress={()=>setAsk3d(true)} disabled={make3d.state==='working'} activeOpacity={0.7}>
              <Feather name="box" size={12} color={colors.gold}/><Text style={[st.ctlT,{color:colors.gold}]}>MAKE 3D</Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.ctl} onPress={()=>pick(false)} activeOpacity={0.7}>
              <Feather name="refresh-cw" size={11} color={colors.textDim}/><Text style={st.ctlT}>NEW</Text>
            </TouchableOpacity>
            {point&&(
              <TouchableOpacity style={st.ctl} onPress={()=>{pointRef.current=null;setPoint(null);}} activeOpacity={0.7}>
                <Feather name="x" size={11} color={colors.textDim}/><Text style={st.ctlT}>UNPIN</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={st.askRow}>
            <TextInput style={st.askInput} value={question} onChangeText={setQuestion} onSubmitEditing={sendTyped} returnKeyType="send"
              placeholder={`Ask ${persona?.name||''} about what you're looking at…`} placeholderTextColor={colors.textFaint}/>
            <TouchableOpacity style={[st.askBtn,{backgroundColor:accent}]} onPress={sendTyped} disabled={!question.trim()} activeOpacity={0.7}>
              <Feather name="arrow-up" size={13} color={colors.bg}/>
            </TouchableOpacity>
          </View>
        </>
      )}

      <Modal visible={ask3d} transparent animationType="fade" onRequestClose={()=>setAsk3d(false)}>
        <View style={st.modalBg}>
          <View style={st.modal}>
            <Text style={st.modalTitle}>MAKE A 3D MODEL</Text>
            <Text style={st.modalSub}>Meshy builds it from this photo in about 1–3 minutes, using your Meshy credits. It opens in the 3D tab when it's ready.</Text>
            <TouchableOpacity style={st.modalBtn} onPress={()=>makeModel(true)} activeOpacity={0.8}>
              <Text style={st.modalBtnT}>COLORED</Text><Text style={st.modalBtnSub}>Painted with the photo's colors · more credits</Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.modalBtn} onPress={()=>makeModel(false)} activeOpacity={0.8}>
              <Text style={st.modalBtnT}>PLAIN</Text><Text style={st.modalBtnSub}>Shape only, gray · cheaper and a bit faster</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={()=>setAsk3d(false)} style={{alignSelf:'center',padding:space.md}}><Text style={st.modalCancel}>CANCEL</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const st=StyleSheet.create({
  c:{flex:1},
  personaBar:{flexGrow:0,marginBottom:space.sm},
  personas:{gap:6,paddingRight:space.lg},
  pChip:{paddingHorizontal:10,paddingVertical:6,borderRadius:radius.sm,borderWidth:1,borderColor:colors.hairline},
  pChipT:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.textDim,letterSpacing:1},
  stage:{flex:1,minHeight:260,borderRadius:radius.md,overflow:'hidden',backgroundColor:'#050403',borderWidth:1,borderColor:colors.hairline},
  empty:{flex:1,alignItems:'center',justifyContent:'center',gap:space.md,padding:space.lg},
  emptyT:{fontFamily:FONTS.mono,fontSize:11,color:colors.textMuted,textAlign:'center',lineHeight:17},
  emptyRow:{flexDirection:'row',gap:space.md},
  bigBtn:{flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:space.lg,paddingVertical:10,borderRadius:radius.md,backgroundColor:colors.gold},
  bigBtnT:{fontFamily:FONTS.monoMed,fontSize:10,color:colors.bg,letterSpacing:2},
  marker:{position:'absolute',width:18,height:18,borderRadius:9,borderWidth:2,alignItems:'center',justifyContent:'center',backgroundColor:'rgba(0,0,0,0.35)'},
  markerDot:{width:5,height:5,borderRadius:3},
  statusPill:{position:'absolute',top:space.sm,left:space.sm,flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:8,paddingVertical:4,borderRadius:radius.sm,backgroundColor:'rgba(0,0,0,0.6)'},
  dot:{width:6,height:6,borderRadius:3},
  statusT:{fontFamily:FONTS.monoMed,fontSize:8,letterSpacing:1.5},
  genPill:{position:'absolute',top:space.sm,right:space.sm,flexDirection:'row',alignItems:'center',gap:6,paddingHorizontal:8,paddingVertical:4,borderRadius:radius.sm,backgroundColor:'rgba(0,0,0,0.6)'},
  genT:{fontFamily:FONTS.monoMed,fontSize:8,color:colors.gold,letterSpacing:1.5},
  hint:{fontFamily:FONTS.mono,fontSize:8,color:colors.textFaint,letterSpacing:0.5,marginTop:6,textAlign:'center'},
  caption:{marginTop:space.sm,padding:space.md,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.md,maxHeight:150},
  heard:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,marginBottom:4},
  answer:{fontFamily:FONTS.mono,fontSize:12,color:colors.textMuted,lineHeight:18},
  err:{fontFamily:FONTS.mono,fontSize:9,color:colors.danger,marginTop:6,lineHeight:14},
  controls:{flexDirection:'row',flexWrap:'wrap',gap:6,marginTop:space.sm},
  ctl:{flexDirection:'row',alignItems:'center',gap:5,paddingHorizontal:10,paddingVertical:7,borderRadius:radius.sm,borderWidth:1,borderColor:colors.hairline},
  ctlT:{fontFamily:FONTS.monoMed,fontSize:8,color:colors.textDim,letterSpacing:1.5},
  askRow:{flexDirection:'row',alignItems:'center',gap:space.sm,marginTop:space.sm},
  askInput:{flex:1,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.md,paddingHorizontal:space.md,paddingVertical:8,color:colors.text,fontFamily:FONTS.mono,fontSize:12},
  askBtn:{width:34,height:34,borderRadius:radius.md,alignItems:'center',justifyContent:'center'},
  modalBg:{flex:1,backgroundColor:'rgba(0,0,0,0.75)',justifyContent:'center',padding:space.xl},
  modal:{backgroundColor:colors.bg,borderWidth:1,borderColor:colors.hairlineGold,borderRadius:radius.md,padding:space.lg},
  modalTitle:{fontFamily:FONTS.monoMed,fontSize:11,color:colors.gold,letterSpacing:3,marginBottom:6},
  modalSub:{fontFamily:FONTS.mono,fontSize:10,color:colors.textMuted,lineHeight:15,marginBottom:space.md},
  modalBtn:{borderWidth:1,borderColor:colors.hairlineGold,borderRadius:radius.md,padding:space.md,marginTop:space.sm},
  modalBtnT:{fontFamily:FONTS.monoMed,fontSize:11,color:colors.gold,letterSpacing:2},
  modalBtnSub:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,marginTop:3},
  modalCancel:{fontFamily:FONTS.monoMed,fontSize:9,color:colors.textDim,letterSpacing:2},
});
