// HUD diagram card: a 3D model you can rotate (one-finger drag), zoom (pinch)
// and inspect. Tap a spot on the model and everything outside a small sphere
// around that point is clipped away in the fragment shader ("the rest
// disappears") while the camera eases in — works on any mesh, split parts or a
// single fused blob. onIdentify(name, point) fires so Jarvis can explain it.
//
// The bundled Avocado.glb is a throwaway test fixture (CC0, see
// assets/models/LICENSE.md); it is replaced by generated models once the
// backend lands.
import React,{useRef,useState}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,ActivityIndicator}from 'react-native';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import{Asset}from 'expo-asset';
import*as FileSystem from 'expo-file-system';
import*as THREE from 'three';
import{GLTFLoader}from 'three/examples/jsm/loaders/GLTFLoader';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{Feather}from '@expo/vector-icons';
import{colors,space,radius,FONTS}from '../../theme';

const MODEL=require('../../../assets/models/Avocado.glb');
const VIEW_H=300;

function b64ToArrayBuffer(b64){
  const bin=global.atob(b64);
  const len=bin.length;
  const bytes=new Uint8Array(len);
  for(let i=0;i<len;i++)bytes[i]=bin.charCodeAt(i);
  return bytes.buffer;
}

export default function DiagramPanel({onIdentify}){
  const[status,setStatus]=useState('loading'); // loading | ready | error
  const[errMsg,setErrMsg]=useState('');
  const[label,setLabel]=useState(null);

  // All gesture callbacks run on the JS thread (.runOnJS) so they can touch
  // three.js objects and React state directly; the render loop polls engine.*
  const engine=useRef({rotX:0,rotY:0,startRX:0,startRY:0,dolly:0,startDolly:0}).current;

  function handleTap(x,y){
    const{camera,model,raycaster,glW,glH,radius,uniforms}=engine;
    if(!camera||!model||!raycaster)return;
    const ndc=new THREE.Vector2((x/glW)*2-1,-(y/glH)*2+1);
    raycaster.setFromCamera(ndc,camera);
    const hits=raycaster.intersectObject(model,true);
    if(!hits.length){
      engine.focusActive=false;
      uniforms.uFocusActive.value=0;
      setLabel(null);
      return;
    }
    const hit=hits[0];
    model.updateMatrixWorld();
    engine.focusLocal=model.worldToLocal(hit.point.clone());
    engine.focusActive=true;
    uniforms.uFocusRadius.value=radius*0.24;
    uniforms.uFocusActive.value=1;
    const name=hit.object?.name||'component';
    setLabel(name);
    onIdentify?.({name,point:{x:hit.point.x,y:hit.point.y,z:hit.point.z}});
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
      const next=engine.startDolly-(e.scale-1);
      engine.dolly=next<-0.7?-0.7:next>2.5?2.5:next;
    });

  const tap=Gesture.Tap()
    .runOnJS(true)
    .maxDistance(12)
    .onEnd(e=>handleTap(e.x,e.y));

  const gesture=Gesture.Simultaneous(pinch,Gesture.Race(tap,pan));

  function resetFocus(){
    if(engine.uniforms)engine.uniforms.uFocusActive.value=0;
    engine.focusActive=false;
    setLabel(null);
  }
  function growFocus(mult){
    if(engine.uniforms&&engine.focusActive){
      const v=engine.uniforms.uFocusRadius.value*mult;
      engine.uniforms.uFocusRadius.value=Math.max((engine.radius||1)*0.05,Math.min((engine.radius||1)*1.2,v));
    }
  }

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth;
      const glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x000000,0);

      const scene=new THREE.Scene();
      const camera=new THREE.PerspectiveCamera(45,glW/glH,0.01,1000);

      scene.add(new THREE.AmbientLight(0xffffff,0.9));
      const key=new THREE.DirectionalLight(0xfff2d8,1.6);
      key.position.set(3,4,5);
      scene.add(key);
      const rim=new THREE.DirectionalLight(0xE8C98A,0.7);
      rim.position.set(-4,-2,-3);
      scene.add(rim);

      const uniforms={
        uFocusActive:{value:0},
        uFocusCenter:{value:new THREE.Vector3()},
        uFocusRadius:{value:1},
      };

      const asset=Asset.fromModule(MODEL);
      await asset.downloadAsync();
      const uri=asset.localUri||asset.uri;
      const b64=await FileSystem.readAsStringAsync(uri,{encoding:FileSystem.EncodingType.Base64});
      const arrayBuffer=b64ToArrayBuffer(b64);

      const model=await new Promise((resolve,reject)=>{
        new GLTFLoader().parse(arrayBuffer,'',(gltf)=>resolve(gltf.scene),(err)=>reject(err));
      });

      // Fit model to a unit-ish size centred on origin.
      const box=new THREE.Box3().setFromObject(model);
      const size=box.getSize(new THREE.Vector3());
      const center=box.getCenter(new THREE.Vector3());
      const maxDim=Math.max(size.x,size.y,size.z)||1;
      const scale=2/maxDim;
      model.scale.setScalar(scale);
      model.position.set(-center.x*scale,-center.y*scale,-center.z*scale);

      const pivot=new THREE.Group();
      pivot.add(model);
      scene.add(pivot);
      const radius=1; // after fit, model spans ~2 units

      model.traverse(o=>{
        if(o.isMesh&&o.material){
          const mats=Array.isArray(o.material)?o.material:[o.material];
          mats.forEach(m=>{
            m.onBeforeCompile=(shader)=>{
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
            m.needsUpdate=true;
          });
        }
      });

      const baseCamZ=4.2;
      camera.position.set(0,0,baseCamZ);
      camera.lookAt(0,0,0);

      Object.assign(engine,{
        renderer,scene,camera,model:pivot,inner:model,raycaster:new THREE.Raycaster(),
        glW,glH,baseCamZ,radius,uniforms,focusActive:false,focusLocal:null,
      });
      setStatus('ready');

      const animate=()=>{
        engine.raf=requestAnimationFrame(animate);
        pivot.rotation.y=engine.rotY;
        pivot.rotation.x=engine.rotX;
        pivot.updateMatrixWorld();
        if(engine.focusActive&&engine.focusLocal){
          uniforms.uFocusCenter.value.copy(engine.focusLocal).applyMatrix4(pivot.matrixWorld);
        }
        const targetZ=baseCamZ+engine.dolly-(engine.focusActive?1.4:0);
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
    try{engine.renderer?.dispose?.();}catch{}
  },[]);

  return(
    <View>
      <GestureDetector gesture={gesture}>
        <View style={st.stage}>
          <GLView style={st.gl} onContextCreate={onContextCreate}/>
          {status==='loading'&&(
            <View style={st.overlay}><ActivityIndicator color={colors.gold}/><Text style={st.overlayT}>Loading model…</Text></View>
          )}
          {status==='error'&&(
            <View style={st.overlay}><Feather name="alert-triangle" size={18} color={colors.danger}/><Text style={st.overlayT}>{errMsg||'3D failed to load'}</Text></View>
          )}
        </View>
      </GestureDetector>

      <View style={st.bar}>
        {label?(
          <>
            <Text style={st.barLabel} numberOfLines={1}>ISOLATED · {label.toUpperCase()}</Text>
            <TouchableOpacity onPress={()=>growFocus(0.8)} style={st.barBtn} hitSlop={{top:8,bottom:8,left:8,right:8}}><Feather name="minus" size={13} color={colors.gold}/></TouchableOpacity>
            <TouchableOpacity onPress={()=>growFocus(1.25)} style={st.barBtn} hitSlop={{top:8,bottom:8,left:8,right:8}}><Feather name="plus" size={13} color={colors.gold}/></TouchableOpacity>
            <TouchableOpacity onPress={resetFocus} style={st.barBtn} hitSlop={{top:8,bottom:8,left:8,right:8}}><Feather name="maximize" size={13} color={colors.gold}/></TouchableOpacity>
          </>
        ):(
          <Text style={st.barHint}>Drag to rotate · pinch to zoom · tap a point to isolate</Text>
        )}
      </View>
    </View>
  );
}

const st=StyleSheet.create({
  stage:{height:VIEW_H,borderRadius:radius.md,overflow:'hidden',backgroundColor:'#050403',borderWidth:1,borderColor:colors.hairline},
  gl:{flex:1},
  overlay:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center',gap:space.sm},
  overlayT:{fontFamily:FONTS.mono,fontSize:9,color:colors.textDim,letterSpacing:1,textAlign:'center',paddingHorizontal:space.lg},
  bar:{flexDirection:'row',alignItems:'center',gap:space.sm,marginTop:space.md,minHeight:22},
  barLabel:{flex:1,fontFamily:FONTS.monoMed,fontSize:9,color:colors.gold,letterSpacing:1.5},
  barHint:{flex:1,fontFamily:FONTS.mono,fontSize:8,color:colors.textDim,letterSpacing:0.5},
  barBtn:{padding:4,borderWidth:1,borderColor:colors.hairlineGold,borderRadius:radius.sm},
});
