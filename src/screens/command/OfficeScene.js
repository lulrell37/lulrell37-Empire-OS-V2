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
import{mergeGeometries}from 'three/examples/jsm/utils/BufferGeometryUtils';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{getPersona,PERSONA_LIST}from '../../personas/personas';
import{desksForFloor,deskFor,floorForPersona,ROOM}from './officeLayout';
import{preloadOfficeModel,createOfficeCharacter,loadFaceTexture,yawToRotation,worldForward}from './officeCharacter';
import{disposeObject}from './holoMaterial';
import bodyTypes from '../../../assets/persona-faces/body-types.json';

const DESK_W=1.5,DESK_D=0.85,DESK_TOP_H=0.05,DESK_LEG_H=0.72;
const CEIL_H=4.4;
const OVERVIEW_HEIGHT=7.5,OVERVIEW_DIST=13;
const DESK_CAM_OFFSET=new THREE.Vector3(0,1.55,2.1); // in front of a seated/standing character, roughly head height

function mat(color,opts={}){
  return new THREE.MeshStandardMaterial({color:new THREE.Color(color),metalness:0.1,roughness:0.6,...opts});
}
function glow(color,intensity=1.4){
  return new THREE.MeshStandardMaterial({color:new THREE.Color(color),emissive:new THREE.Color(color),emissiveIntensity:intensity,roughness:0.4,toneMapped:false});
}
// box geometry, pre-translated (and optionally pre-rotated) so pieces can be
// merged into one draw call — same trick EmpireCityScreen.js uses.
function box(w,h,d,x,y,z,ry){
  const g=new THREE.BoxGeometry(w,h,d);
  if(ry)g.rotateY(ry);
  g.translate(x,y,z);
  return g;
}

const CARPET=0x3b4652;      // cool corporate-carpet blue-gray
const WALL=0x6b6255;        // warm plaster, not the same tone as the floor
const TRIM=0x2c2620;        // baseboard / window-frame / desk-leg dark
const DESKTOP=0x8a6a48;     // warm wood-tone desktop
const CEIL=0x847d6f;        // slightly lighter than the walls
const WINDOW_GLOW=0xBFE3F0; // daylight-blue glass
const CEIL_LIGHT=0xFFF3D6;  // warm recessed panel light

// Static room geometry for one floor — floor, walls, windows, a lit ceiling,
// and a desk (desktop + legs + chair + a monitor glowing in that persona's
// color) per persona. Returns the group plus each desk's data, for the camera
// and for relay "walk over there" targets.
function buildRoom(floor){
  const g=new THREE.Group();
  const desks=desksForFloor(floor);
  const midZ=(ROOM.frontZ+ROOM.backZ)/2, spanZ=ROOM.frontZ-ROOM.backZ;

  const floorMesh=new THREE.Mesh(new THREE.PlaneGeometry(ROOM.halfW*2,spanZ),mat(CARPET,{roughness:0.95}));
  floorMesh.rotation.x=-Math.PI/2;floorMesh.position.set(0,0,midZ);
  g.add(floorMesh);
  const ceilMesh=new THREE.Mesh(new THREE.PlaneGeometry(ROOM.halfW*2,spanZ),mat(CEIL,{roughness:0.9}));
  ceilMesh.rotation.x=Math.PI/2;ceilMesh.position.set(0,CEIL_H,midZ);
  g.add(ceilMesh);

  // recessed ceiling light panels, merged, in a grid down the room
  const lightGeos=[];
  for(let z=ROOM.backZ+2;z<ROOM.frontZ-1;z+=3.4)
    for(const x of[-ROOM.halfW*0.5,0,ROOM.halfW*0.5])
      lightGeos.push(box(1.3,0.06,0.6,x,CEIL_H-0.05,z));
  g.add(new THREE.Mesh(mergeGeometries(lightGeos),glow(CEIL_LIGHT,1.1)));

  // walls
  const wallGeos=[
    box(ROOM.halfW*2,CEIL_H,0.15,0,CEIL_H/2,ROOM.backZ),
    box(0.15,CEIL_H,spanZ,-ROOM.halfW,CEIL_H/2,midZ),
    box(0.15,CEIL_H,spanZ,ROOM.halfW,CEIL_H/2,midZ),
  ];
  g.add(new THREE.Mesh(mergeGeometries(wallGeos),mat(WALL)));
  // baseboards + a cornice line, so the walls don't just float into the floor/ceiling
  const trimGeos=[
    box(ROOM.halfW*2,0.14,0.2,0,0.07,ROOM.backZ+0.08),
    box(0.2,0.14,spanZ,-ROOM.halfW+0.08,0.07,midZ),
    box(0.2,0.14,spanZ,ROOM.halfW-0.08,0.07,midZ),
  ];
  g.add(new THREE.Mesh(mergeGeometries(trimGeos),mat(TRIM)));

  // a row of windows along the back wall — the room's clearest "this is a
  // real building, not a void" signal
  const winGeos=[],frameGeos=[];
  for(let x=-ROOM.halfW+2.4;x<=ROOM.halfW-2.4;x+=3.0){
    winGeos.push(box(2.1,2.3,0.05,x,2.4,ROOM.backZ+0.09));
    frameGeos.push(box(2.3,2.5,0.08,x,2.4,ROOM.backZ+0.07));
  }
  g.add(new THREE.Mesh(mergeGeometries(frameGeos),mat(TRIM)));
  g.add(new THREE.Mesh(mergeGeometries(winGeos),glow(WINDOW_GLOW,0.8)));

  const deskWorld={};
  const topGeos=[],legGeos=[],chairGeos=[];
  desks.forEach(d=>{
    const w=DESK_W*d.scale,dep=DESK_D*d.scale,legH=DESK_LEG_H*d.scale;
    const cz=d.z+dep*0.55;
    topGeos.push(box(w,DESK_TOP_H,dep,d.x,legH,cz,d.facing));
    for(const sx of[-w*0.42,w*0.42])for(const sz of[-dep*0.35,dep*0.35]){
      const lx=d.x+sx*Math.cos(d.facing)-sz*Math.sin(d.facing);
      const lz=cz+sx*Math.sin(d.facing)+sz*Math.cos(d.facing);
      legGeos.push(box(0.06,legH,0.06,lx,legH/2,lz));
    }
    // chair, facing the same way as the desk
    const chz=d.z-0.55*d.scale;
    chairGeos.push(box(0.42*d.scale,0.42*d.scale,0.42*d.scale,d.x,0.21*d.scale,chz,d.facing));
    chairGeos.push(box(0.4*d.scale,0.55*d.scale,0.06,d.x-0.2*d.scale*Math.sin(d.facing),0.55*d.scale,chz-0.2*d.scale*Math.cos(d.facing),d.facing));

    // monitor — bezel + a screen glowing in that persona's own color, the
    // clearest "whose desk is this" cue short of reading the name label.
    // Sits toward the desk's far edge (away from the chair), rotated with it.
    const persona=getPersona(d.id);
    const monY=legH+0.22*d.scale;
    const monOff=-dep*0.32; // local offset from desk centre, along its own facing axis
    const monX=d.x+Math.sin(d.facing)*monOff, monZ=cz+Math.cos(d.facing)*monOff;
    const bezel=new THREE.Mesh(new THREE.BoxGeometry(0.5*d.scale,0.32*d.scale,0.03),mat(TRIM));
    bezel.position.set(monX,monY,monZ);bezel.rotation.y=d.facing;
    g.add(bezel);
    const screen=new THREE.Mesh(new THREE.PlaneGeometry(0.42*d.scale,0.25*d.scale),glow(persona.color,1.3));
    screen.position.set(monX+Math.sin(d.facing)*0.017,monY,monZ+Math.cos(d.facing)*0.017);
    screen.rotation.y=d.facing;
    g.add(screen);

    // A generous invisible tap-catcher around the desk+chair area — easier to
    // hit than the character mesh itself, tagged for the raycaster.
    const catcher=new THREE.Mesh(new THREE.CylinderGeometry(1.1*d.scale,1.1*d.scale,2.2,10),
      new THREE.MeshBasicMaterial({visible:false}));
    catcher.position.set(d.x,1.1,d.z);
    catcher.userData.personaTarget=d.id;
    g.add(catcher);
    deskWorld[d.id]=new THREE.Vector3(d.x,0,d.z);
  });
  g.add(new THREE.Mesh(mergeGeometries(topGeos),mat(DESKTOP,{roughness:0.5})));
  g.add(new THREE.Mesh(mergeGeometries(legGeos),mat(TRIM)));
  g.add(new THREE.Mesh(mergeGeometries(chairGeos),mat(0x2a2a2e)));

  // a couple of potted plants scattered along the window wall — cheap warmth
  const potGeos=[],leafGeos=[];
  for(let x=-ROOM.halfW+1.6;x<=ROOM.halfW-1.6;x+=6.2){
    potGeos.push(new THREE.CylinderGeometry(0.22,0.18,0.32,10).translate(x,0.16,ROOM.backZ+0.5));
    leafGeos.push(new THREE.ConeGeometry(0.36,0.9,8).translate(x,0.75,ROOM.backZ+0.5));
  }
  if(potGeos.length){
    g.add(new THREE.Mesh(mergeGeometries(potGeos),mat(0x5a4a3a)));
    g.add(new THREE.Mesh(mergeGeometries(leafGeos),mat(0x3f6b45,{roughness:0.8})));
  }

  return{group:g,desks,deskWorld};
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
      asker.walkTo(home,()=>{asker.group.rotation.y=yawToRotation(askerDesk.facing);asker.sitDown();});
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
    engine.camPanX=0;engine.camDolly=0;
  },[engine]);

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x0d1114,1); // a hint of the world outside the windows, not a void

      const scene=new THREE.Scene();
      const camera=new THREE.PerspectiveCamera(48,glW/glH,0.1,200);
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
        ch.group.rotation.y=yawToRotation(desk.facing);
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
            const facing=worldForward(ch.group.rotation.y);
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
