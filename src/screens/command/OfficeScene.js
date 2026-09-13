// THE OFFICE — replaces the old orb galaxy (OrbZoom.js) as what CommandScreen
// shows at view==='viz'. Two levels, same contract OrbZoom had:
//   'office' — the current floor's desks, everyone at their own doing
//              whatever they're doing (idle / busy / walking to talk).
//   'desk'   — walked up face-to-face with one persona; the chat composer
//              takes over from here (CommandScreen owns that, untouched).
// No memory-spiral level — dropped for now.
//
// Built on GLView + expo-three + three.js, the same stack as the city
// (EmpireCityScreen.js) and PersonaOrb.js — NOT OrbZoom's bespoke Animated/
// PanResponder math, which only existed because reanimated worklets crashed a
// much earlier 3D attempt at this screen. That risk doesn't apply here: this
// is plain GLView + three, already proven stable elsewhere in this app.
import React,{useRef,useState,useMemo,useCallback,useEffect,forwardRef,useImperativeHandle}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import*as THREE from 'three';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{PERSONA_LIST}from '../../personas/personas';
import{desksForFloor,deskFor,floorForPersona,ROOM}from './officeLayout';
import{preloadOfficeModel,createOfficeCharacter,loadFaceTexture}from './officeCharacter';
import{disposeObject}from './holoMaterial';
import bodyTypes from '../../../assets/persona-faces/body-types.json';

const DESK_W=1.4,DESK_D=0.8,DESK_H=0.78;
const OVERVIEW_HEIGHT=7.5,OVERVIEW_DIST=13;
const DESK_CAM_OFFSET=new THREE.Vector3(0,1.55,2.1); // in front of a seated/standing character, roughly head height

function deskMat(color,opts={}){
  return new THREE.MeshStandardMaterial({color:new THREE.Color(color),metalness:0.15,roughness:0.6,...opts});
}

// Static room geometry for one floor — floor slab, back/side walls, a desk
// (box) per persona. Returns the group plus a lookup of persona id -> desk
// world position, for the camera and for relay "walk over there" targets.
function buildRoom(floor){
  const g=new THREE.Group();
  const desks=desksForFloor(floor);
  const floorGeo=new THREE.PlaneGeometry(ROOM.halfW*2,ROOM.frontZ-ROOM.backZ);
  const floorMesh=new THREE.Mesh(floorGeo,deskMat(0x1b1712,{roughness:0.9}));
  floorMesh.rotation.x=-Math.PI/2;
  floorMesh.position.set(0,0,(ROOM.frontZ+ROOM.backZ)/2);
  g.add(floorMesh);

  const wallMat=deskMat(0x24211a,{roughness:0.95});
  const back=new THREE.Mesh(new THREE.PlaneGeometry(ROOM.halfW*2,6),wallMat);
  back.position.set(0,3,ROOM.backZ);
  g.add(back);
  const left=new THREE.Mesh(new THREE.PlaneGeometry(ROOM.frontZ-ROOM.backZ,6),wallMat);
  left.rotation.y=Math.PI/2;left.position.set(-ROOM.halfW,3,(ROOM.frontZ+ROOM.backZ)/2);
  g.add(left);
  const right=left.clone();right.position.x=ROOM.halfW;right.rotation.y=-Math.PI/2;
  g.add(right);

  const deskWorld={};
  const deskGeo=new THREE.BoxGeometry(1,1,1);
  const deskMesh=deskMat(0x3a2f22);
  desks.forEach(d=>{
    const w=DESK_W*d.scale,dep=DESK_D*d.scale,h=DESK_H*d.scale;
    const desk=new THREE.Mesh(deskGeo,deskMesh);
    desk.scale.set(w,h,dep);
    desk.position.set(d.x,h/2,d.z+dep*0.9);
    desk.rotation.y=d.facing;
    g.add(desk);
    // A generous invisible tap-catcher around the desk+chair area — easier to
    // hit than the character mesh itself, tagged for the raycaster.
    const catcher=new THREE.Mesh(new THREE.CylinderGeometry(1.1*d.scale,1.1*d.scale,2.2,10),
      new THREE.MeshBasicMaterial({visible:false}));
    catcher.position.set(d.x,1.1,d.z);
    catcher.userData.personaTarget=d.id;
    g.add(catcher);
    deskWorld[d.id]=new THREE.Vector3(d.x,0,d.z);
  });
  return{group:g,desks,deskWorld};
}

// unreadPersonas/onLaunchGroup are accepted for parity with OrbZoom's old
// contract (an unread-reply dot per desk, multi-select group launch) but
// aren't wired into the visuals yet — a follow-up, not required for the
// office itself to work.
function OfficeSceneInner({personaId,color,active,vizRef,personaPics,unreadPersonas,busyPersonas,relayBusy,onPickPersona,onLaunchGroup,level='office',onLevelChange},ref){
  const[status,setStatus]=useState('loading');
  const[floor,setFloor]=useState(()=>floorForPersona(personaId));
  const engine=useRef({
    floor,level,personaId,
    camPanX:0,startPanX:0,camDolly:0,startDolly:0,
    active:true,last:Date.now(),
    characters:{},          // id -> character (from officeCharacter.js), all 25, both floors
    roomsByFloor:{},        // floor -> {group,desks,deskWorld}
    relayTarget:null,       // persona id the current asker is mid-walk-to, or null
  }).current;
  const levelRef=useRef(level);
  const personaIdRef=useRef(personaId);
  const busyRef=useRef(busyPersonas);
  useEffect(()=>{levelRef.current=level;},[level]);
  useEffect(()=>{personaIdRef.current=personaId;},[personaId]);
  useEffect(()=>{busyRef.current=busyPersonas;},[busyPersonas]);
  useEffect(()=>{engine.floor=floor;},[floor,engine]);
  useEffect(()=>{engine.active=!!active;},[active,engine]);

  useImperativeHandle(ref,()=>({
    back(){
      if(levelRef.current==='desk'){onLevelChange?.('office');return true;}
      return false;
    },
  }),[onLevelChange]);

  const raycastAt=useCallback((x,y)=>{
    const{camera,raycaster,roomsByFloor,floor:f,vw,vh}=engine;
    if(!camera||!raycaster)return null;
    const room=roomsByFloor[f];
    if(!room)return null;
    raycaster.setFromCamera(new THREE.Vector2((x/vw)*2-1,-(y/vh)*2+1),camera);
    for(const hit of raycaster.intersectObject(room.group,true)){
      let o=hit.object;
      while(o){if(o.userData?.personaTarget)return o.userData.personaTarget;o=o.parent;}
    }
    return null;
  },[engine]);

  const gesture=useMemo(()=>{
    const pan=Gesture.Pan().runOnJS(true).maxPointers(1)
      .onStart(()=>{engine.startPanX=engine.camPanX;})
      .onUpdate(e=>{
        if(levelRef.current!=='office')return;
        const nx=engine.startPanX-e.translationX*0.02;
        engine.camPanX=Math.max(-ROOM.halfW+2,Math.min(ROOM.halfW-2,nx));
      });
    const pinch=Gesture.Pinch().runOnJS(true)
      .onStart(()=>{engine.startDolly=engine.camDolly;})
      .onUpdate(e=>{
        if(levelRef.current!=='office')return;
        engine.camDolly=Math.max(-5,Math.min(6,engine.startDolly-(e.scale-1)*10));
      });
    const tap=Gesture.Tap().runOnJS(true).maxDistance(14)
      .onEnd((e,ok)=>{
        if(!ok||levelRef.current!=='office')return;
        const id=raycastAt(e.x,e.y);
        if(id)onPickPersona?.(id);
      });
    return Gesture.Simultaneous(pinch,Gesture.Race(tap,pan));
  },[engine,raycastAt,onPickPersona]);

  // --- relay walk-over orchestration ------------------------------------
  // At most one relay target at a time in practice (CommandScreen awaits its
  // relay tags one at a time). The asker is whichever persona is currently
  // active in direct chat (personaId) — the main case this is for. If asker
  // and target aren't on the same floor there's no sensible "walk there", so
  // it's skipped (the target still shows busy at their own desk either way).
  useEffect(()=>{
    const targetId=relayBusy&&relayBusy.size?[...relayBusy][0]:null;
    if(targetId===engine.relayTarget)return;
    const prevTarget=engine.relayTarget;
    engine.relayTarget=targetId;
    const asker=engine.characters[personaId];
    const askerDesk=deskFor(personaId);
    if(!asker||!askerDesk)return;
    if(targetId){
      const targetDesk=deskFor(targetId);
      if(!targetDesk||targetDesk.floor!==askerDesk.floor)return; // different floor — skip the walk, just leave them seated
      const spot=new THREE.Vector3(targetDesk.x,0,targetDesk.z+1.3);
      asker.standUp(()=>asker.walkTo(spot,()=>asker.setMood('talk')));
    }else if(prevTarget){
      const home=new THREE.Vector3(askerDesk.x,0,askerDesk.z);
      asker.walkTo(home,()=>{asker.group.rotation.y=askerDesk.facing+Math.PI;asker.sitDown();});
    }
  },[relayBusy,personaId,engine]);

  // --- desk-level (face-to-face) stand up / sit back down -----------------
  const prevLevelRef=useRef(level);
  useEffect(()=>{
    const was=prevLevelRef.current;
    prevLevelRef.current=level;
    if(was===level)return;
    const ch=engine.characters[personaId];
    if(!ch)return;
    if(level==='desk'&&engine.relayTarget!==personaId)ch.standUp?.();
    if(was==='desk'&&level==='office'&&!engine.relayTarget)ch.sitDown?.();
  },[level,personaId,engine]);

  const switchFloor=useCallback((f)=>{
    if(f===engine.floor)return;
    setFloor(f);
    engine.camPanX=0;engine.camDolly=0;
  },[engine]);

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x050403,1);

      const scene=new THREE.Scene();
      const camera=new THREE.PerspectiveCamera(48,glW/glH,0.1,200);
      scene.add(new THREE.AmbientLight(0xffffff,0.75));
      scene.add(new THREE.HemisphereLight(0xE8C98A,0x0a0806,0.5));
      const key=new THREE.DirectionalLight(0xfff2d8,1.1);key.position.set(6,10,8);scene.add(key);

      Object.assign(engine,{renderer,scene,camera,raycaster:new THREE.Raycaster(),vw:glW,vh:glH,last:Date.now()});

      await preloadOfficeModel();
      const rooms={};
      [1,2].forEach(f=>{
        const room=buildRoom(f);
        room.group.visible=(f===engine.floor);
        scene.add(room.group);
        rooms[f]=room;
      });
      engine.roomsByFloor=rooms;

      // One character per persona, both floors, created up front — cheap
      // (SkeletonUtils.clone shares buffers) and keeps floor-switching instant.
      PERSONA_LIST.forEach(p=>{
        const desk=deskFor(p.id);
        if(!desk)return;
        const ch=createOfficeCharacter({persona:p,bodyType:bodyTypes[p.id]||'average'});
        ch.group.scale.setScalar(desk.scale*1.15);
        ch.group.position.set(desk.x,0,desk.z);
        ch.group.rotation.y=desk.facing+Math.PI; // offset against the sourced model's own rest-pose forward axis — verify/tune once rendered
        rooms[desk.floor].group.add(ch.group);
        engine.characters[p.id]=ch;
        const pic=personaPics&&personaPics[p.id];
        if(pic)loadFaceTexture(p.id,pic).then(tex=>tex&&ch.setFaceTexture(tex));
      });
      setStatus('ready');

      const animate=()=>{
        engine.raf=requestAnimationFrame(animate);
        const now=Date.now();
        const dt=Math.min(0.05,(now-engine.last)/1000);
        engine.last=now;
        if(!engine.active)return;

        // Only the on-screen floor's characters actually animate — the other
        // floor sits frozen until you switch to it.
        const room=engine.roomsByFloor[engine.floor];
        if(room){
          for(const id of Object.keys(engine.characters)){
            const desk=deskFor(id);
            if(!desk||desk.floor!==engine.floor)continue;
            const ch=engine.characters[id];
            const isFocus=levelRef.current==='desk'&&id===personaIdRef.current;
            // The current asker, once arrived at the target's desk, is holding
            // a deliberate 'talk' mood set by the relay effect above — the
            // generic busy/idle sync below must not stomp that.
            const isAskerMidRelay=(id===personaIdRef.current&&engine.relayTarget);
            if(isFocus){
              ch.setMood(vizRef&&vizRef.speaking?'talk':'standIdle');
            }else if(!isAskerMidRelay&&!ch.isTransitioning()){
              ch.setMood(busyRef.current&&busyRef.current.has(id)?'busy':'idle');
            }
            ch.update(dt);
          }
        }

        // --- camera ---
        if(levelRef.current==='desk'){
          const ch=engine.characters[personaIdRef.current];
          if(ch){
            const p=ch.group.position;
            const look=new THREE.Vector3(p.x,DESK_CAM_OFFSET.y,p.z);
            // Camera stands in front of whichever way the character is
            // currently facing (their rotation.y, same convention update()
            // uses while walking) and looks back at them — true face-to-face
            // regardless of which desk or which way they turned to get there.
            const facing=new THREE.Vector3(Math.sin(ch.group.rotation.y),0,Math.cos(ch.group.rotation.y));
            const camPos=look.clone().addScaledVector(facing,DESK_CAM_OFFSET.z);
            camera.position.lerp(camPos,0.12);
            engine._lookTarget=engine._lookTarget||look.clone();
            engine._lookTarget.lerp(look,0.12);
            camera.lookAt(engine._lookTarget);
          }
        }else{
          const target=new THREE.Vector3(engine.camPanX,0.6,-1);
          const camPos=new THREE.Vector3(engine.camPanX*0.6,OVERVIEW_HEIGHT,OVERVIEW_DIST+engine.camDolly);
          camera.position.lerp(camPos,0.15);
          engine._lookTarget=engine._lookTarget||target.clone();
          engine._lookTarget.lerp(target,0.15);
          camera.lookAt(engine._lookTarget);
        }

        renderer.render(scene,camera);
        gl.endFrameEXP();
      };
      animate();
    }catch(err){
      if(__DEV__)console.warn('OfficeScene GL error:',err?.message||err);
      setStatus('error');
    }
  }

  useEffect(()=>()=>{
    if(engine.raf)cancelAnimationFrame(engine.raf);
    Object.values(engine.characters||{}).forEach(ch=>ch.dispose?.());
    Object.values(engine.roomsByFloor||{}).forEach(r=>{try{disposeObject(r.group);}catch{}});
    try{engine.renderer?.dispose?.();}catch{}
  },[]);// eslint-disable-line react-hooks/exhaustive-deps

  // Keep each floor group's visibility in sync whenever the selected floor
  // changes (switchFloor / initial mount).
  useEffect(()=>{
    Object.entries(engine.roomsByFloor||{}).forEach(([f,r])=>{r.group.visible=(Number(f)===floor);});
  },[floor,engine]);

  return(
    <GestureDetector gesture={gesture}>
      <View style={s.wrap}
        onLayout={e=>{const{width,height}=e.nativeEvent.layout;engine.vw=width;engine.vh=height;}}>
        <GLView style={{flex:1}} onContextCreate={onContextCreate}/>

        {level==='office'&&(
          <View style={s.floorCtl} pointerEvents="box-none">
            {[1,2].map(f=>(
              <TouchableOpacity key={f} style={[s.floorBtn,floor===f&&{borderColor:color,backgroundColor:color+'22'}]} onPress={()=>switchFloor(f)}>
                <Text style={[s.floorT,floor===f&&{color}]}>FLOOR {f}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

export default forwardRef(OfficeSceneInner);

const s=StyleSheet.create({
  wrap:{flex:1},
  floorCtl:{position:'absolute',right:12,bottom:16,gap:8},
  floorBtn:{paddingVertical:8,paddingHorizontal:12,borderRadius:6,borderWidth:1,borderColor:'#222',backgroundColor:'rgba(0,0,0,0.5)',alignItems:'center'},
  floorT:{color:'#999',fontSize:9,fontFamily:'monospace',fontWeight:'700',letterSpacing:1.5},
});
