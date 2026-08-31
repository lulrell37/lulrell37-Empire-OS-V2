// HUD diagram card: a 3D model you can rotate (one-finger drag), zoom (pinch)
// and inspect. Tap a spot and everything outside a small sphere around that
// point is clipped away in the fragment shader ("the rest disappears") — works
// on any mesh — and Jarvis explains what you're looking at, out loud.
//
// Two looks: HOLO (translucent gold hologram, default) and REAL (the model's
// own textures). The bundled Avocado.glb is a CC0 throwaway test fixture
// (assets/models/LICENSE.md), replaced by generated models once the backend
// (Item 4) is wired.
import React,{useRef,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,TextInput,ActivityIndicator}from 'react-native';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import{Asset}from 'expo-asset';
import*as FileSystem from 'expo-file-system';
import*as THREE from 'three';
import{GLTFLoader}from 'three/examples/jsm/loaders/GLTFLoader';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{Feather}from '@expo/vector-icons';
import{callPersona}from '../../services/aiService';
import{speak,stopSpeaking}from '../../services/voice';
import{getPersona}from '../../personas/personas';
import{colors,space,radius,FONTS}from '../../theme';

const MODEL=require('../../../assets/models/Avocado.glb');
const VIEW_H=300;
const JARVIS=getPersona('jarvis');
const HS={top:8,bottom:8,left:8,right:8};

function b64ToArrayBuffer(b64){
  const bin=global.atob(b64);
  const len=bin.length;
  const bytes=new Uint8Array(len);
  for(let i=0;i<len;i++)bytes[i]=bin.charCodeAt(i);
  return bytes.buffer;
}

export default function DiagramPanel({subject='an avocado'}){
  const[status,setStatus]=useState('loading'); // loading | ready | error
  const[errMsg,setErrMsg]=useState('');
  const[label,setLabel]=useState(null);        // isolated component name
  const[mode,setMode]=useState('holo');        // holo | real
  const[busy,setBusy]=useState(false);         // waiting on Jarvis
  const[answer,setAnswer]=useState('');        // Jarvis explanation / reply
  const[question,setQuestion]=useState('');

  const engine=useRef({rotX:0,rotY:0,startRX:0,startRY:0,dolly:0,startDolly:0,mode:'holo'}).current;

  function handleTap(x,y){
    const{camera,pivot,raycaster,glW,glH,radius,uniforms}=engine;
    if(!camera||!pivot||!raycaster)return;
    const ndc=new THREE.Vector2((x/glW)*2-1,-(y/glH)*2+1);
    raycaster.setFromCamera(ndc,camera);
    const hits=raycaster.intersectObject(pivot,true);
    if(!hits.length){clearFocus();return;}
    const hit=hits[0];
    pivot.updateMatrixWorld();
    engine.focusLocal=pivot.worldToLocal(hit.point.clone());
    engine.focusActive=true;
    uniforms.uFocusRadius.value=radius*0.24;
    uniforms.uFocusActive.value=1;
    const name=hit.object?.name||'that region';
    setLabel(name);
    explain(name);
  }

  function clearFocus(){
    if(engine.uniforms)engine.uniforms.uFocusActive.value=0;
    engine.focusActive=false;
    setLabel(null);
    setAnswer('');
    stopSpeaking();
  }
  function growFocus(mult){
    const u=engine.uniforms;
    if(u&&engine.focusActive){
      const r=engine.radius||1;
      u.uFocusRadius.value=Math.max(r*0.05,Math.min(r*1.3,u.uFocusRadius.value*mult));
    }
  }

  async function explain(name){
    setBusy(true);setAnswer('');
    try{
      const prompt=`[DIAGRAM] I'm viewing a 3D model of ${subject} and tapped the "${name}". In 2-3 sentences, tell me what that part is and what it does. Speak directly to me, sir — no preamble, no markdown.`;
      const reply=await callPersona('jarvis',[{role:'user',content:prompt}]);
      setAnswer(reply.trim());
      speak(reply,JARVIS.elevenlabsVoiceId,JARVIS.name);
    }catch(e){
      setAnswer('Unable to reach Jarvis: '+String(e?.message||e).slice(0,120));
    }finally{setBusy(false);}
  }
  async function ask(){
    const q=question.trim();
    if(!q||busy)return;
    setQuestion('');setBusy(true);
    try{
      const ctx=label?`I'm viewing a 3D model of ${subject}, focused on the "${label}". `:`I'm viewing a 3D model of ${subject}. `;
      const reply=await callPersona('jarvis',[{role:'user',content:'[DIAGRAM] '+ctx+q+' Answer in 2-4 sentences, spoken directly, no markdown.'}]);
      setAnswer(reply.trim());
      speak(reply,JARVIS.elevenlabsVoiceId,JARVIS.name);
    }catch(e){
      setAnswer('Unable to reach Jarvis: '+String(e?.message||e).slice(0,120));
    }finally{setBusy(false);}
  }

  function toggleMode(){
    const next=engine.mode==='holo'?'real':'holo';
    engine.mode=next;
    setMode(next);
    engine.applyMode?.(next);
  }

  const pan=Gesture.Pan()
    .runOnJS(true)
    .onStart(()=>{engine.startRX=engine.rotX;engine.startRY=engine.rotY;})
    .onUpdate(e=>{
      engine.rotY=engine.startRY+e.translationX*0.01;
      engine.rotX=engine.startRX+e.translationY*0.01;
    });
  const pinch=Gesture.Pinch()
    .runOnJS(true)
    .onStart(()=>{engine.startDolly=engine.dolly;})
    .onUpdate(e=>{
      const n=engine.startDolly-(e.scale-1);
      engine.dolly=n<-0.7?-0.7:n>2.5?2.5:n;
    });
  const tap=Gesture.Tap().runOnJS(true).maxDistance(12).onEnd(e=>handleTap(e.x,e.y));
  const gesture=Gesture.Simultaneous(pinch,Gesture.Race(tap,pan));

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x000000,0);

      const scene=new THREE.Scene();
      const camera=new THREE.PerspectiveCamera(45,glW/glH,0.01,1000);
      scene.add(new THREE.AmbientLight(0xffffff,0.85));
      const key=new THREE.DirectionalLight(0xfff2d8,1.5);key.position.set(3,4,5);scene.add(key);
      const rim=new THREE.DirectionalLight(0xE8C98A,0.8);rim.position.set(-4,-2,-3);scene.add(rim);

      const uniforms={
        uFocusActive:{value:0},
        uFocusCenter:{value:new THREE.Vector3()},
        uFocusRadius:{value:1},
        uTime:{value:0},
      };
      const injectClip=(shader)=>{
        shader.uniforms.uFocusActive=uniforms.uFocusActive;
        shader.uniforms.uFocusCenter=uniforms.uFocusCenter;
        shader.uniforms.uFocusRadius=uniforms.uFocusRadius;
        shader.vertexShader=shader.vertexShader
          .replace('#include <common>','#include <common>\nvarying vec3 vFocusWP;')
          .replace('#include <begin_vertex>','#include <begin_vertex>\nvFocusWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        shader.fragmentShader=shader.fragmentShader
          .replace('#include <common>','#include <common>\nuniform float uFocusActive;\nuniform vec3 uFocusCenter;\nuniform float uFocusRadius;\nvarying vec3 vFocusWP;')
          .replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif (uFocusActive > 0.5 && distance(vFocusWP, uFocusCenter) > uFocusRadius) discard;');
      };

      const holoMat=new THREE.MeshStandardMaterial({
        color:new THREE.Color(0xE8C98A),
        emissive:new THREE.Color(0x5a4423),
        emissiveIntensity:0.55,
        metalness:0.25,roughness:0.4,
        transparent:true,opacity:0.42,
        side:THREE.DoubleSide,depthWrite:false,
      });
      holoMat.onBeforeCompile=(shader)=>{
        shader.uniforms.uTime=uniforms.uTime;
        injectClip(shader);
        shader.fragmentShader=shader.fragmentShader
          .replace('#include <common>','#include <common>\nuniform float uTime;')
          .replace('#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n'+
            'float _fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);\n'+
            'float _scan = 0.9 + 0.1 * sin(uTime * 3.0 + vFocusWP.y * 26.0);\n'+
            'totalEmissiveRadiance += _fres * vec3(1.0, 0.86, 0.55) * 1.5;\n'+
            'totalEmissiveRadiance *= _scan;');
      };

      const asset=Asset.fromModule(MODEL);
      await asset.downloadAsync();
      const b64=await FileSystem.readAsStringAsync(asset.localUri||asset.uri,{encoding:FileSystem.EncodingType.Base64});
      const gltfScene=await new Promise((res,rej)=>{
        new GLTFLoader().parse(b64ToArrayBuffer(b64),'',(g)=>res(g.scene),(err)=>rej(err));
      });

      const box=new THREE.Box3().setFromObject(gltfScene);
      const size=box.getSize(new THREE.Vector3());
      const center=box.getCenter(new THREE.Vector3());
      const maxDim=Math.max(size.x,size.y,size.z)||1;
      const fit=2/maxDim;
      gltfScene.scale.setScalar(fit);
      gltfScene.position.set(-center.x*fit,-center.y*fit,-center.z*fit);

      const originals=new Map();
      gltfScene.traverse(o=>{
        if(o.isMesh&&o.material){
          originals.set(o,o.material);
          const mats=Array.isArray(o.material)?o.material:[o.material];
          mats.forEach(m=>{m.onBeforeCompile=injectClip;m.needsUpdate=true;});
        }
      });

      const pivot=new THREE.Group();
      pivot.add(gltfScene);
      scene.add(pivot);

      const applyMode=(m)=>{
        gltfScene.traverse(o=>{
          if(o.isMesh&&originals.has(o))o.material=m==='holo'?holoMat:originals.get(o);
        });
      };
      applyMode('holo');

      camera.position.set(0,0,4.2);
      camera.lookAt(0,0,0);

      Object.assign(engine,{
        renderer,scene,camera,pivot,raycaster:new THREE.Raycaster(),
        glW,glH,baseCamZ:4.2,radius:1,uniforms,applyMode,
        focusActive:false,focusLocal:null,mode:'holo',
      });
      setStatus('ready');

      const animate=()=>{
        engine.raf=requestAnimationFrame(animate);
        uniforms.uTime.value+=0.016;
        pivot.rotation.y=engine.rotY;
        pivot.rotation.x=engine.rotX;
        pivot.updateMatrixWorld();
        if(engine.focusActive&&engine.focusLocal){
          uniforms.uFocusCenter.value.copy(engine.focusLocal).applyMatrix4(pivot.matrixWorld);
        }
        const targetZ=engine.baseCamZ+engine.dolly-(engine.focusActive?1.4:0);
        camera.position.z+=(targetZ-camera.position.z)*0.12;
        camera.lookAt(0,0,0);
        renderer.render(scene,camera);
        gl.endFrameEXP();
      };
      animate();
    }catch(err){
      setErrMsg(String(err?.message||err).slice(0,180));
      setStatus('error');
    }
  }

  React.useEffect(()=>()=>{
    if(engine.raf)cancelAnimationFrame(engine.raf);
    stopSpeaking();
    try{engine.renderer?.dispose?.();}catch{}
  },[]);

  return(
    <View>
      <View style={st.stage}>
        <GestureDetector gesture={gesture}>
          <GLView style={st.gl} onContextCreate={onContextCreate}/>
        </GestureDetector>
        {status==='loading'&&(
          <View style={st.overlay} pointerEvents="none"><ActivityIndicator color={colors.gold}/><Text style={st.overlayT}>Loading model…</Text></View>
        )}
        {status==='error'&&(
          <View style={st.overlay} pointerEvents="none"><Feather name="alert-triangle" size={18} color={colors.danger}/><Text style={st.overlayT}>{errMsg||'3D failed to load'}</Text></View>
        )}
        <TouchableOpacity style={st.modeChip} onPress={toggleMode} activeOpacity={0.7}>
          <Feather name={mode==='holo'?'zap':'image'} size={10} color={colors.gold}/>
          <Text style={st.modeChipT}>{mode==='holo'?'HOLO':'REAL'}</Text>
        </TouchableOpacity>
      </View>

      <View style={st.bar}>
        {label?(
          <>
            <Text style={st.barLabel} numberOfLines={1}>ISOLATED · {String(label).toUpperCase()}</Text>
            <TouchableOpacity onPress={()=>growFocus(0.8)} style={st.barBtn} hitSlop={HS}><Feather name="minus" size={12} color={colors.gold}/></TouchableOpacity>
            <TouchableOpacity onPress={()=>growFocus(1.3)} style={st.barBtn} hitSlop={HS}><Feather name="plus" size={12} color={colors.gold}/></TouchableOpacity>
            <TouchableOpacity onPress={clearFocus} style={st.barBtn} hitSlop={HS}><Feather name="maximize" size={12} color={colors.gold}/></TouchableOpacity>
          </>
        ):(
          <Text style={st.barHint}>Drag to rotate · pinch to zoom · tap a point to isolate</Text>
        )}
      </View>

      {(busy||answer)&&(
        <View style={st.caption}>
          {busy&&!answer?(
            <View style={st.captionRow}><ActivityIndicator size="small" color={colors.gold}/><Text style={st.captionMeta}>Jarvis is looking…</Text></View>
          ):(
            <Text style={st.captionText}>{answer}</Text>
          )}
        </View>
      )}

      {status==='ready'&&(
        <View style={st.askRow}>
          <TextInput
            style={st.askInput}
            value={question}
            onChangeText={setQuestion}
            placeholder="Ask Jarvis about this…"
            placeholderTextColor={colors.textFaint}
            onSubmitEditing={ask}
            returnKeyType="send"
          />
          <TouchableOpacity style={st.askBtn} onPress={ask} disabled={busy||!question.trim()} activeOpacity={0.7}>
            <Feather name="arrow-up" size={13} color={colors.bg}/>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const st=StyleSheet.create({
  stage:{height:VIEW_H,borderRadius:radius.md,overflow:'hidden',backgroundColor:'#050403',borderWidth:1,borderColor:colors.hairline},
  gl:{flex:1},
  overlay:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center',gap:space.sm},
  overlayT:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:1,textAlign:'center',paddingHorizontal:space.lg},
  modeChip:{position:'absolute',top:space.sm,right:space.sm,flexDirection:'row',alignItems:'center',gap:4,paddingHorizontal:space.sm,paddingVertical:4,borderRadius:radius.sm,borderWidth:1,borderColor:colors.hairlineGold,backgroundColor:'rgba(0,0,0,0.5)'},
  modeChipT:{fontFamily:FONTS.monoMed,fontSize:8,color:colors.gold,letterSpacing:1.5},
  bar:{flexDirection:'row',alignItems:'center',gap:space.sm,marginTop:space.md,minHeight:22},
  barLabel:{flex:1,fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:1.5},
  barHint:{flex:1,fontFamily:FONTS.mono,fontSize:8,color:colors.textDim,letterSpacing:0.5},
  barBtn:{padding:4,borderWidth:1,borderColor:colors.hairlineGold,borderRadius:radius.sm},
  caption:{marginTop:space.md,padding:space.md,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.md},
  captionRow:{flexDirection:'row',alignItems:'center',gap:space.sm},
  captionMeta:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:1},
  captionText:{fontFamily:FONTS.mono,fontSize:12,color:colors.textMuted,lineHeight:19,letterSpacing:0.2},
  askRow:{flexDirection:'row',alignItems:'center',gap:space.sm,marginTop:space.md},
  askInput:{flex:1,backgroundColor:colors.surface,borderWidth:1,borderColor:colors.hairline,borderRadius:radius.md,paddingHorizontal:space.md,paddingVertical:8,color:colors.text,fontFamily:FONTS.mono,fontSize:12},
  askBtn:{width:34,height:34,borderRadius:radius.md,backgroundColor:colors.gold,alignItems:'center',justifyContent:'center'},
});
