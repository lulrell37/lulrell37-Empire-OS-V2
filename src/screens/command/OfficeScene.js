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
//
// The room geometry itself (officeRoom.js) is a separate, dependency-free
// module — it's also loaded directly by a dev-only Node preview script that
// rasters it to a PNG, so layout/framing/detail get checked against an actual
// render before shipping, not just eyeballed in code.
import React,{useRef,useState,useMemo,useCallback,useEffect,forwardRef,useImperativeHandle}from 'react';
import{View,Text,StyleSheet,TouchableOpacity}from 'react-native';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import*as THREE from 'three';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{getPersona,PERSONA_LIST}from '../../personas/personas';
import{desksForFloor,deskFor,floorForPersona,ROOM}from './officeLayout';
import{buildRoom}from './officeRoom';
import{preloadOfficeModel,preloadBodyModel,createOfficeCharacter,loadFaceTexture,yawToRotation,worldForward}from './officeCharacter';
import{disposeObject}from './holoMaterial';
import bodyTypes from '../../../assets/persona-faces/body-types.json';
import bodyModels from '../../../assets/persona-faces/body-models.json';

const DESK_CAM_OFFSET=new THREE.Vector3(0,1.55,2.1); // in front of a seated/standing character, roughly head height
// officeWorker.glb's rig measures 1.83 world units tall at scale 1 (verified
// directly, not assumed) — this brings every character to a consistent ~1.7
// human height regardless of their desk's size. A.R.A.'s desk is bigger
// (desk.scale in officeLayout.js), not her literally — a bigger desk, not a
// giant sitting at it.
const CHAR_SCALE=1.7/1.8287;
const OVERVIEW_VFOV=64; // a wide lens — this + fitOverview() is what makes "the whole floor, no swiping" possible

// Camera height + pull-back so the entire floor fits in frame on a portrait
// phone with no panning required — scaled off the room's own half-width
// (ROOM.halfW+1.5, a small margin) rather than a flat constant, so it stays
// right if the desk layout ever gets wider. The multipliers themselves
// (1.36 / 1.04) aren't derived from FOV trig — a pure top-down "fit the
// width" formula technically also satisfies "everyone's on screen" but wastes
// most of the frame on empty space above the room (checked, looked bad); these
// were calibrated against the dev-only preview raster to actually fill the
// screen at a natural-looking angle. Re-check with that script before
// changing OVERVIEW_VFOV or these numbers.
function fitOverview(){
  const base=ROOM.halfW+1.5;
  return{height:base*1.36,zBack:base*1.04};
}

// unreadPersonas/onLaunchGroup are accepted for parity with OrbZoom's old
// contract (an unread-reply dot per desk, multi-select group launch) but
// aren't wired into the visuals yet — a follow-up, not required for the
// office itself to work.
function OfficeSceneInner({personaId,color,active,vizRef,personaPics,unreadPersonas,busyPersonas,relayBusy,onPickPersona,onLaunchGroup,level='office',onLevelChange},ref){
  const[status,setStatus]=useState('loading');
  const[floor,setFloor]=useState(()=>floorForPersona(personaId));
  const[labels,setLabels]=useState([]); // office level: {id,name,color,x,y} per desk on screen right now
  const engine=useRef({
    floor,level,personaId,
    camDolly:0,startDolly:0, // pinch only — the base framing already fits everyone, no pan needed
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

  // Office level has no pan — the whole floor already fits on screen by
  // design (fitOverview). Pinch still zooms in a bit for anyone who wants a
  // closer look; it's optional, not required to see everyone.
  const gesture=useMemo(()=>{
    const pinch=Gesture.Pinch().runOnJS(true)
      .onStart(()=>{engine.startDolly=engine.camDolly;})
      .onUpdate(e=>{
        if(levelRef.current!=='office')return;
        engine.camDolly=Math.max(-8,Math.min(2,engine.startDolly-(e.scale-1)*10));
      });
    const tap=Gesture.Tap().runOnJS(true).maxDistance(14)
      .onEnd((e,ok)=>{
        if(!ok||levelRef.current!=='office')return;
        const id=raycastAt(e.x,e.y);
        if(id)onPickPersona?.(id);
      });
    return Gesture.Simultaneous(pinch,tap);
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
      asker.walkTo(home,()=>{asker.group.rotation.y=yawToRotation(askerDesk.facing,asker.forwardOffset);asker.sitDown();});
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

  useEffect(()=>{if(level!=='office')setLabels([]);},[level]);

  const switchFloor=useCallback((f)=>{
    if(f===engine.floor)return;
    setFloor(f);
    engine.camDolly=0;
  },[engine]);

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x0d1114,1); // a hint of the world outside the windows, not a void

      const scene=new THREE.Scene();
      const camera=new THREE.PerspectiveCamera(OVERVIEW_VFOV,glW/glH,0.1,300);
      // A bright, daylit-office look — the ceiling panels and window glow
      // (both emissive) carry the "lit room" read; these just fill it in so
      // nothing goes fully black in the corners.
      scene.add(new THREE.AmbientLight(0xffffff,0.9));
      scene.add(new THREE.HemisphereLight(0xBFE3F0,0x3b4652,0.65));
      const key=new THREE.DirectionalLight(0xfff6e6,1.15);key.position.set(4,9,6);scene.add(key);
      const fill=new THREE.DirectionalLight(0xBFE3F0,0.4);fill.position.set(-6,5,-8);scene.add(fill);

      Object.assign(engine,{renderer,scene,camera,raycaster:new THREE.Raycaster(),vw:glW,vh:glH,last:Date.now()});

      const tmpV=new THREE.Vector3();
      let lblAcc=0;
      const midZ=(ROOM.frontZ+ROOM.backZ)/2;

      await preloadOfficeModel();
      // Only load an alt body's ~15MB glb if some persona actually uses it.
      const neededBodyModels=[...new Set(Object.values(bodyModels))].filter(m=>m&&m!=='mannequin');
      await Promise.all(neededBodyModels.map(preloadBodyModel));
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
        const ch=createOfficeCharacter({persona:p,bodyType:bodyTypes[p.id]||'average',bodyModel:bodyModels[p.id]||'mannequin'});
        ch.group.scale.setScalar(CHAR_SCALE);
        ch.group.position.set(desk.x,0,desk.z);
        ch.group.rotation.y=yawToRotation(desk.facing,ch.forwardOffset);
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
            // actually facing right now (worldForward decodes rotation.y the
            // same way the model's own rest pose was measured — see
            // officeCharacter.js) and looks back at them — true face-to-face
            // regardless of which desk or which way they turned to get there.
            const facing=worldForward(ch.group.rotation.y,ch.forwardOffset);
            const camPos=look.clone().addScaledVector(facing,DESK_CAM_OFFSET.z);
            camera.position.lerp(camPos,0.12);
            engine._lookTarget=engine._lookTarget||look.clone();
            engine._lookTarget.lerp(look,0.12);
            camera.lookAt(engine._lookTarget);
          }
        }else{
          const{height,zBack}=fitOverview();
          const dolly=engine.camDolly;
          const camPos=new THREE.Vector3(0,Math.max(6,height+dolly),midZ+zBack+dolly*0.5);
          const target=new THREE.Vector3(0,0.8,midZ-1.5);
          camera.position.lerp(camPos,0.15);
          engine._lookTarget=engine._lookTarget||target.clone();
          engine._lookTarget.lerp(target,0.15);
          camera.lookAt(engine._lookTarget);
        }

        renderer.render(scene,camera);
        gl.endFrameEXP();

        // Name labels over every desk on the current floor, office level only
        // — screen-space projected RN <Text> on top of the GLView, same trick
        // EmpireCityScreen.js uses for its landmark labels. Throttled to ~8fps;
        // it's just text position, no need to run it every frame.
        lblAcc+=dt;
        if(levelRef.current==='office'&&lblAcc>0.12&&room){
          lblAcc=0;
          const out=[];
          for(const d of room.desks){
            const ch=engine.characters[d.id];
            if(!ch)continue;
            tmpV.set(ch.group.position.x,2.05*d.scale,ch.group.position.z).project(camera);
            if(tmpV.z>1||tmpV.z<-1)continue;
            const sx=(tmpV.x*0.5+0.5)*engine.vw,sy=(-tmpV.y*0.5+0.5)*engine.vh;
            if(sx<-40||sx>engine.vw+40||sy<-20||sy>engine.vh+20)continue;
            const persona=getPersona(d.id);
            out.push({id:d.id,name:persona.name,color:persona.color,x:sx,y:sy});
          }
          setLabels(out);
        }
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
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            {labels.map(l=>(
              <View key={l.id} style={[s.label,{left:l.x-55,top:l.y}]}>
                <Text style={[s.labelT,{color:l.color}]} numberOfLines={1}>{l.name.replace(/\./g,'')}</Text>
              </View>
            ))}
          </View>
        )}

        {level==='desk'&&(
          <View style={s.rail} pointerEvents="none">
            <Text style={[s.railT,{color}]}>{getPersona(personaId).name}</Text>
          </View>
        )}

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
  label:{position:'absolute',width:110,alignItems:'center'},
  labelT:{fontFamily:'monospace',fontSize:10,fontWeight:'700',letterSpacing:1,textShadowColor:'#000',textShadowRadius:4,textShadowOffset:{width:0,height:1}},
  rail:{position:'absolute',top:12,left:0,right:0,alignItems:'center'},
  railT:{fontFamily:'monospace',fontSize:11,fontWeight:'700',letterSpacing:3,textShadowColor:'#000',textShadowRadius:4,textShadowOffset:{width:0,height:1}},
  floorCtl:{position:'absolute',right:12,bottom:16,gap:8},
  floorBtn:{paddingVertical:8,paddingHorizontal:12,borderRadius:6,borderWidth:1,borderColor:'#222',backgroundColor:'rgba(0,0,0,0.5)',alignItems:'center'},
  floorT:{color:'#999',fontSize:9,fontFamily:'monospace',fontWeight:'700',letterSpacing:1.5},
});
