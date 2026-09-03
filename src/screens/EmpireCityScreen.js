// The Empire — a 3D holographic Roman city that is the app's home / hub.
//
//   1 finger  drag ....... orbit the city
//   2 fingers drag ....... move through the city (pan across the ground)
//   pinch ................ zoom; zoom right into a landmark to open its screen
//   mouse wheel .......... zoom (Samsung DeX / any attached mouse) — see the
//                          invisible ScrollView catcher below, same trick as OrbZoom
//
// Built procedurally from three.js primitives, rendered with the shared holo
// material (src/screens/command/holoMaterial.js) so it matches the Laboratory
// diagram. No bundled model — ships as an OTA update.
import React,{useRef,useState,useCallback,useMemo,useEffect}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Dimensions,ActivityIndicator,Animated,Easing,Platform,ScrollView}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import*as THREE from 'three';
import{mergeGeometries}from 'three/examples/jsm/utils/BufferGeometryUtils';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{getHudState}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
import Boundary from './hud/Boundary';
import{makeHoloUniforms,createHoloMaterial,disposeObject}from './command/holoMaterial';

// Landmark id (mesh.userData.heroTarget) -> nav route + display. Spread wide so
// you travel between them.
const HEROES=[
  {name:'Council',   route:'Command',    label:'COUNCIL',    sub:'THE PERSONAS', tint:0xE8C98A, at:[0,13]},
  {name:'HUD',       route:'HUD',        label:'THE HUD',    sub:'EMPIRE STATE', tint:0xD4A017, at:[13.5,-3]},
  {name:'Laboratory',route:'Laboratory', label:'LABORATORY', sub:'THE DIAGRAM',  tint:0x7FB0D4, at:[-13.5,-3]},
  {name:'Settings',  route:'Settings',   label:'SETTINGS',   sub:'THE WORKSHOP', tint:0x8A8A8A, at:[0,-14]},
];

const CITY_R=26;          // ground radius
const ROAM_BOUND=20;      // how far the camera target can travel

function mulberry32(a){
  return function(){
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return((t^t>>>14)>>>0)/4294967296;
  };
}

// Build the whole city as one pivot Group. The static mass (streets, insulae,
// aqueduct) is merged into a handful of geometries so a big city still draws
// cheaply.
function buildCity(uniforms){
  const pivot=new THREE.Group();
  const matPlain=createHoloMaterial(uniforms);                         // ground, roads, colonnade
  const matBld=createHoloMaterial(uniforms,{windows:true});            // every building
  const matCar=createHoloMaterial(uniforms,{tint:0xF3E3BE,opacity:0.6});
  const matPed=createHoloMaterial(uniforms,{tint:0xB48E56,opacity:0.55});

  const box=(w,h,d,x,y,z,ry)=>{
    const g=new THREE.BoxGeometry(w,h,d);
    if(ry)g.rotateY(ry);
    g.translate(x,y,z);
    return g;
  };

  // Ground plateau + forum plaza (kept as their own meshes — big, few).
  pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(CITY_R,CITY_R+0.6,0.4,72),matPlain).translateY(-0.2));
  pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(4.2,4.2,0.12,56),matPlain).translateY(0.03));

  // Street grid + two ring roads -> one merged mesh.
  const roadGeos=[];
  for(let i=-3;i<=3;i++){
    roadGeos.push(box(0.4,0.05,CITY_R*2,i*6,0.05,0));
    roadGeos.push(box(CITY_R*2,0.05,0.4,0,0.05,i*6));
  }
  for(const R of[8,15]){
    const t=new THREE.TorusGeometry(R,0.07,6,72);
    t.rotateX(Math.PI/2);t.translate(0,0.06,0);roadGeos.push(t);
  }
  pivot.add(new THREE.Mesh(mergeGeometries(roadGeos),matPlain));

  // Insulae — seeded scatter, off the plaza / road lines / landmark lots -> merged.
  const rnd=mulberry32(20260901);
  const bldGeos=[];
  for(let i=0;i<210;i++){
    const ang=rnd()*Math.PI*2;
    const rad=5+rnd()*(CITY_R-6);
    const x=Math.cos(ang)*rad, z=Math.sin(ang)*rad;
    if((Math.abs(x)%6)<1.1||(Math.abs(z)%6)<1.1)continue;
    if(HEROES.some(h=>Math.hypot(x-h.at[0],z-h.at[1])<5))continue;
    const w=0.7+rnd()*1.7, d=0.7+rnd()*1.7;
    const h=0.9+rnd()*rnd()*7.5;
    bldGeos.push(box(w,h,d,x,h/2,z,rnd()*Math.PI));
    if(rnd()>0.65)bldGeos.push(box(w*0.55,0.6+rnd()*1.6,d*0.55,x,h+0.4,z));
  }
  pivot.add(new THREE.Mesh(mergeGeometries(bldGeos),matBld));

  // Colonnade ringing the forum (instanced).
  const cols=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11,0.11,2.0,8),matPlain,40);
  const dm=new THREE.Object3D();
  for(let i=0;i<40;i++){
    const a=(i/40)*Math.PI*2;
    dm.position.set(Math.cos(a)*4.6,1.0,Math.sin(a)*4.6);dm.updateMatrix();
    cols.setMatrixAt(i,dm.matrix);
  }
  pivot.add(cols);

  // Aqueduct marching across the city -> merged.
  const aqGeos=[];
  for(let i=0;i<15;i++){
    aqGeos.push(box(0.4,3.0+i*0.03,0.4,-CITY_R+2+i*2.0,1.5,7.5));
    const t=new THREE.TorusGeometry(0.62,0.13,6,12,Math.PI);
    t.translate(-CITY_R+3+i*2.0,3.0,7.5);aqGeos.push(t);
  }
  pivot.add(new THREE.Mesh(mergeGeometries(aqGeos),matPlain));

  // Colosseum to the north-west.
  const colo=new THREE.Mesh(new THREE.CylinderGeometry(2.6,2.9,2.2,44,1,true),matBld);
  colo.position.set(-9,1.1,11);colo.scale.set(1,1,0.8);
  pivot.add(colo);

  // --- Traffic: cars run the grid lines, wrapping at the edges ---
  const cars=[];
  const carMesh=new THREE.InstancedMesh(new THREE.BoxGeometry(0.55,0.28,0.28),matCar,26);
  carMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for(let i=0;i<26;i++){
    const onX=rnd()>0.5;
    const lane=(Math.floor(rnd()*7)-3)*6;
    cars.push({onX,lane,pos:(rnd()*2-1)*CITY_R,dir:rnd()>0.5?1:-1,speed:2.5+rnd()*3.5});
  }
  pivot.add(carMesh);

  // --- Pedestrians: drift along the ring roads and plaza edge ---
  const people=[];
  const pedMesh=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07,0.07,0.42,5),matPed,60);
  pedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for(let i=0;i<60;i++){
    people.push({r:[4.6,8,15][Math.floor(rnd()*3)]+rnd()*0.8,a:rnd()*Math.PI*2,speed:(0.15+rnd()*0.35)*(rnd()>0.5?1:-1)});
  }
  pivot.add(pedMesh);

  // --- Hero landmarks: bigger, distinct silhouettes, each on its own lot ---
  const anchors=[];
  for(const hero of HEROES){
    const hmat=createHoloMaterial(uniforms,{tint:hero.tint,windows:true});
    const g=new THREE.Group();
    g.position.set(hero.at[0],0,hero.at[1]);
    g.name=hero.name;g.userData.heroTarget=hero.name;

    const put=(geo,x,y,z)=>{
      const m=new THREE.Mesh(geo,hmat);
      m.position.set(x,y,z);
      m.userData.heroTarget=hero.name;
      g.add(m);return m;
    };
    put(new THREE.BoxGeometry(5.2,0.6,5.2),0,0.3,0);           // plinth
    put(new THREE.BoxGeometry(4.6,0.3,4.6),0,0.75,0);          // step

    if(hero.name==='Council'){                                  // senate portico
      put(new THREE.BoxGeometry(3.8,3.4,3.0),0,2.6,0);
      for(let i=0;i<7;i++)put(new THREE.CylinderGeometry(0.16,0.16,3.6,10),-1.8+i*0.6,2.7,1.7);
      const ped=put(new THREE.ConeGeometry(2.3,1.3,4),0,5.2,0);ped.rotation.y=Math.PI/4;ped.scale.set(1,0.5,0.5);
    }else if(hero.name==='HUD'){                                // domed pantheon
      put(new THREE.CylinderGeometry(2.3,2.3,3.2,36),0,2.5,0);
      put(new THREE.SphereGeometry(2.3,36,18,0,Math.PI*2,0,Math.PI/2),0,4.1,0);
      put(new THREE.TorusGeometry(0.5,0.1,8,22),0,6.4,0).rotation.x=Math.PI/2;
    }else if(hero.name==='Laboratory'){                         // observatory tower
      put(new THREE.CylinderGeometry(1.5,2.0,6.6,22),0,4.2,0);
      const dome=put(new THREE.SphereGeometry(1.7,26,18,0,Math.PI*2,0,Math.PI*0.6),0,7.6,0);dome.scale.set(1,0.8,1);
      put(new THREE.BoxGeometry(0.16,3.0,0.16),1.1,8.6,0).rotation.z=-0.5;
    }else if(hero.name==='Settings'){                           // workshop + gear
      put(new THREE.BoxGeometry(4.0,3.0,3.6),0,2.4,0);
      const gear=put(new THREE.CylinderGeometry(1.6,1.6,0.35,12),0,4.6,0);
      gear.rotation.x=Math.PI/2;gear.userData.spin=1;
      put(new THREE.BoxGeometry(0.3,2.0,0.3),1.6,5.6,1.6);
    }
    pivot.add(g);
    anchors.push({name:hero.name,pos:g.position.clone().setY(6.5)});
  }

  const spinners=[];
  pivot.traverse(o=>{if(o.userData?.spin)spinners.push(o);});
  return{pivot,anchors,spinners,cars,carMesh,people,pedMesh};
}

function EmpireCity({navigation}){
  const[status,setStatus]=useState('loading');
  const[errMsg,setErrMsg]=useState('');
  const[labels,setLabels]=useState([]);
  const setHudState=useEmpireStore(s=>s.setHudState);
  const fade=useRef(new Animated.Value(0)).current;   // black wash for page-change

  const engine=useRef({
    rotY:0.7,rotX:0.62,startRX:0,startRY:0,
    dolly:0,startDolly:0,baseR:17,minR:2.4,maxR:30,wantEnter:false,
    panX:0,panZ:0,startPanX:0,startPanZ:0,
    active:true,idle:0,entering:null,navigated:false,
    vw:Dimensions.get('window').width,vh:Dimensions.get('window').height,
  }).current;

  // --- mouse-wheel zoom (DeX / attached mouse) ---------------------------
  // RN has no `wheel` event on a plain View and Gesture.Pinch never fires from a
  // wheel, so on Android we park an invisible ScrollView behind the GLView and
  // turn its scroll delta into engine.dolly. On web we bind a real wheel event.
  const containerRef=useRef(null);
  const wheelScrollRef=useRef(null);
  const wheelY=useRef(0);
  const WHEEL_MID=1200;   // generous slack each way so one fast notch can't reach an edge

  const applyWheelZoom=useCallback((delta)=>{
    if(!delta)return;
    const lo=engine.minR-engine.baseR,hi=engine.maxR-engine.baseR;
    engine.dolly=Math.max(lo,Math.min(hi,engine.dolly+delta*0.02));
    engine.idle=0;
  },[engine]);

  const recenterWheel=useCallback(()=>{
    wheelY.current=WHEEL_MID;
    requestAnimationFrame(()=>wheelScrollRef.current&&wheelScrollRef.current.scrollTo({y:WHEEL_MID,animated:false}));
  },[]);

  const onWheelScroll=useCallback((e)=>{
    const y=e.nativeEvent.contentOffset.y;
    const dy=y-wheelY.current;
    if(!dy)return;                       // ignore the echo from our own recentre scrollTo
    wheelY.current=y;
    applyWheelZoom(dy);
    // Snap back to the middle after every notch, not just past a threshold —
    // otherwise a fast spin drives the catcher to a content edge, where further
    // scrolling that way yields no delta and the zoom silently dies until you
    // spin back the other way.
    recenterWheel();
  },[applyWheelZoom,recenterWheel]);

  useEffect(()=>{
    if(Platform.OS!=='web')return;
    const node=containerRef.current;
    if(!node||!node.addEventListener)return;
    const onWheel=(ev)=>{if(ev.preventDefault)ev.preventDefault();applyWheelZoom(ev.deltaY);};
    node.addEventListener('wheel',onWheel,{passive:false});
    return()=>node.removeEventListener('wheel',onWheel);
  },[applyWheelZoom]);

  useEffect(()=>{getHudState().then(h=>{if(h)setHudState(h);}).catch(()=>{});},[]); // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(useCallback(()=>{
    engine.active=true;engine.entering=null;engine.navigated=false;
    engine.dolly=0;engine.wantEnter=false;   // reset the zoom so you're not stuck mid-enter
    fade.stopAnimation();
    Animated.timing(fade,{toValue:0,duration:420,easing:Easing.out(Easing.cubic),useNativeDriver:true}).start();
    return()=>{engine.active=false;};
  },[engine,fade]));

  useEffect(()=>()=>{
    if(engine.raf)cancelAnimationFrame(engine.raf);
    try{if(engine.pivot)disposeObject(engine.pivot);}catch{}
    try{engine.renderer?.dispose?.();}catch{}
  },[engine]);

  const startEnter=useCallback((route)=>{
    if(engine.entering)return;
    engine.entering={route,t:0};
    Animated.timing(fade,{toValue:1,duration:430,easing:Easing.in(Easing.cubic),useNativeDriver:true}).start();
  },[engine,fade]);

  const raycastAt=useCallback((x,y)=>{
    const{camera,raycaster,pivot,vw,vh}=engine;
    if(!camera||!raycaster||!pivot)return null;
    raycaster.setFromCamera(new THREE.Vector2((x/vw)*2-1,-(y/vh)*2+1),camera);
    for(const hit of raycaster.intersectObject(pivot,true)){
      let o=hit.object;
      while(o){if(o.userData?.heroTarget)return o.userData.heroTarget;o=o.parent;}
    }
    return null;
  },[engine]);

  const gesture=useMemo(()=>{
    // 1 finger -> move across the city, oriented to where the camera faces
    const move=Gesture.Pan().runOnJS(true).maxPointers(1)
      .onStart(()=>{engine.startPanX=engine.panX;engine.startPanZ=engine.panZ;engine.idle=0;})
      .onUpdate(e=>{
        const s=0.020*(engine.baseR+engine.dolly)/17;
        const fx=Math.sin(engine.rotY), fz=Math.cos(engine.rotY);   // toward camera on ground
        const rx=Math.cos(engine.rotY), rz=-Math.sin(engine.rotY);  // screen-right on ground
        let nx=engine.startPanX - (rx*e.translationX + fx*e.translationY)*s;
        let nz=engine.startPanZ - (rz*e.translationX + fz*e.translationY)*s;
        const d=Math.hypot(nx,nz);
        if(d>ROAM_BOUND){nx=nx/d*ROAM_BOUND;nz=nz/d*ROAM_BOUND;}
        engine.panX=nx;engine.panZ=nz;engine.idle=0;
      });
    // 2 fingers -> orbit / adjust the view
    const orbit=Gesture.Pan().runOnJS(true).minPointers(2)
      .onStart(()=>{engine.startRX=engine.rotX;engine.startRY=engine.rotY;engine.idle=0;})
      .onUpdate(e=>{
        engine.rotY=engine.startRY-e.translationX*0.006;
        engine.rotX=Math.max(0.12,Math.min(1.4,engine.startRX-e.translationY*0.005));
        engine.idle=0;
      });
    // pinch -> zoom continuously. You can get right up to a building; you only
    // dive into a screen by *keeping* the pinch-in going once you're already at
    // the closest zoom (or by tapping a landmark).
    const pinch=Gesture.Pinch().runOnJS(true)
      .onStart(()=>{engine.startDolly=engine.dolly;engine.idle=0;})
      .onUpdate(e=>{
        engine.dolly=Math.max(engine.minR-engine.baseR,Math.min(engine.maxR-engine.baseR,engine.startDolly-(e.scale-1)*17));
        engine.idle=0;
      })
      .onEnd(e=>{
        const r=engine.baseR+engine.dolly;
        if(e.scale>1&&r<=engine.minR+0.5)engine.wantEnter=true;
      });
    // tap directly on a landmark -> open it
    const tap=Gesture.Tap().runOnJS(true).maxDistance(18)
      .onEnd((e,ok)=>{if(ok){const t=raycastAt(e.x,e.y);if(t){const h=HEROES.find(x=>x.name===t);if(h)startEnter(h.route);}}});
    return Gesture.Simultaneous(pinch,orbit,Gesture.Exclusive(tap,move));
  },[engine,raycastAt,startEnter]);

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x000000,0);

      const scene=new THREE.Scene();
      scene.fog=new THREE.FogExp2(0x000000,0.022);
      const camera=new THREE.PerspectiveCamera(48,glW/glH,0.1,240);
      scene.add(new THREE.AmbientLight(0xffffff,0.8));
      const kl=new THREE.DirectionalLight(0xfff2d8,1.35);kl.position.set(8,12,8);scene.add(kl);
      const rl=new THREE.DirectionalLight(0xE8C98A,0.7);rl.position.set(-10,5,-8);scene.add(rl);

      const uniforms=makeHoloUniforms();
      const city=buildCity(uniforms);
      scene.add(city.pivot);
      Object.assign(engine,{renderer,scene,camera,uniforms,raycaster:new THREE.Raycaster(),last:Date.now(),...city});
      setStatus('ready');

      const tmp=new THREE.Vector3();
      const dummy=new THREE.Object3D();
      let lblAcc=0;

      const animate=()=>{
        engine.raf=requestAnimationFrame(animate);
        const now=Date.now();
        const dt=Math.min(0.05,(now-engine.last)/1000);
        engine.last=now;
        if(engine.active===false)return;

        engine.uniforms.uTime.value+=dt;
        engine.idle+=dt;
        const rNow=engine.baseR+engine.dolly;
        // only drift at the overview zoom, not while the user has zoomed in
        if(engine.idle>2.5&&!engine.entering&&rNow>engine.baseR-2)engine.rotY+=dt*0.03;
        for(const sp of engine.spinners)sp.rotation.z+=dt*0.9;

        // traffic
        for(let i=0;i<engine.cars.length;i++){
          const c=engine.cars[i];
          c.pos+=c.dir*c.speed*dt;
          if(c.pos>CITY_R)c.pos=-CITY_R;else if(c.pos<-CITY_R)c.pos=CITY_R;
          dummy.position.set(c.onX?c.pos:c.lane,0.2,c.onX?c.lane:c.pos);
          dummy.rotation.set(0,c.onX?(c.dir>0?Math.PI/2:-Math.PI/2):(c.dir>0?0:Math.PI),0);
          dummy.updateMatrix();engine.carMesh.setMatrixAt(i,dummy.matrix);
        }
        engine.carMesh.instanceMatrix.needsUpdate=true;
        // pedestrians
        for(let i=0;i<engine.people.length;i++){
          const p=engine.people[i];
          p.a+=p.speed*dt;
          dummy.position.set(Math.cos(p.a)*p.r,0.22,Math.sin(p.a)*p.r);
          dummy.rotation.set(0,0,0);dummy.updateMatrix();
          engine.pedMesh.setMatrixAt(i,dummy.matrix);
        }
        engine.pedMesh.instanceMatrix.needsUpdate=true;

        // camera: orbit around (panX,0,panZ)
        let r=engine.baseR+engine.dolly;
        let tx=engine.panX,tz=engine.panZ;
        if(engine.entering){
          const e=engine.entering;e.t=Math.min(1,e.t+dt/0.45);
          const hero=HEROES.find(h=>h.route===e.route);
          r=THREE.MathUtils.lerp(r,3.2,e.t);
          tx=THREE.MathUtils.lerp(tx,hero.at[0],e.t);
          tz=THREE.MathUtils.lerp(tz,hero.at[1],e.t);
          if(e.t>=1&&!engine.navigated){engine.navigated=true;navigation.navigate(e.route);return;}
        }
        engine.camera.position.set(
          tx+Math.sin(engine.rotY)*Math.cos(engine.rotX)*r,
          Math.max(1.4,Math.sin(engine.rotX)*r*0.92+1.4),
          tz+Math.cos(engine.rotY)*Math.cos(engine.rotX)*r,
        );
        engine.camera.lookAt(tx,1.3,tz);

        engine.renderer.render(engine.scene,engine.camera);
        gl.endFrameEXP();

        // zoom-into-a-landmark: only when the user has pinched fully in and kept
        // pushing (engine.wantEnter, set in pinch.onEnd) and a landmark sits near
        // screen centre. Tapping a landmark is the other way in.
        if(engine.wantEnter&&!engine.entering){
          engine.wantEnter=false;
          let best=null,bestD=1e9;
          for(const a of engine.anchors){
            tmp.copy(a.pos).applyMatrix4(engine.pivot.matrixWorld).project(engine.camera);
            if(tmp.z>1)continue;
            const sx=(tmp.x*0.5+0.5)*engine.vw, sy=(-tmp.y*0.5+0.5)*engine.vh;
            const d=Math.hypot(sx-engine.vw/2,sy-engine.vh/2);
            if(d<bestD){bestD=d;best=a;}
          }
          if(best&&bestD<Math.min(engine.vw,engine.vh)*0.4){
            startEnter(HEROES.find(h=>h.name===best.name).route);
          }
        }

        // project landmark anchors for the overlay labels (~8fps)
        lblAcc+=dt;
        if(lblAcc>0.12){
          lblAcc=0;
          const out=[];
          for(const a of engine.anchors){
            tmp.copy(a.pos).applyMatrix4(engine.pivot.matrixWorld).project(engine.camera);
            const meta=HEROES.find(h=>h.name===a.name);
            out.push({
              name:a.name,label:meta.label,sub:meta.sub,tint:'#'+meta.tint.toString(16).padStart(6,'0'),
              x:(tmp.x*0.5+0.5)*engine.vw,
              y:(-tmp.y*0.5+0.5)*engine.vh,
              visible:tmp.z<1&&tmp.x>-1.15&&tmp.x<1.15&&tmp.y>-1.15&&tmp.y<1.15,
            });
          }
          setLabels(out);
        }
      };
      animate();
    }catch(err){
      setErrMsg(String(err?.message||err).slice(0,180));
      setStatus('error');
    }
  }

  if(status==='error'){
    return(
      <SafeAreaView style={s.fallback} edges={['top','bottom']}>
        <Text style={s.fallbackTitle}>THE EMPIRE</Text>
        <Text style={s.fallbackMsg}>City view unavailable{errMsg?` · ${errMsg}`:''}</Text>
        {HEROES.map(h=>(
          <TouchableOpacity key={h.name} style={s.fallbackBtn} onPress={()=>navigation.navigate(h.route)}>
            <Text style={[s.fallbackBtnT,{color:'#'+h.tint.toString(16).padStart(6,'0')}]}>{h.label}</Text>
            <Text style={s.fallbackBtnS}>{h.sub}</Text>
          </TouchableOpacity>
        ))}
      </SafeAreaView>
    );
  }

  return(
    <View ref={containerRef} style={s.container} onLayout={e=>{const{width,height}=e.nativeEvent.layout;engine.vw=width;engine.vh=height;}}>
      {Platform.OS==='android'&&(
        <ScrollView ref={wheelScrollRef} style={StyleSheet.absoluteFill}
          contentContainerStyle={{height:WHEEL_MID*2+Dimensions.get('window').height}}
          showsVerticalScrollIndicator={false} scrollEventThrottle={1}
          contentOffset={{x:0,y:WHEEL_MID}} onScroll={onWheelScroll}
          onContentSizeChange={()=>recenterWheel()}/>
      )}
      <GestureDetector gesture={gesture}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate}/>
      </GestureDetector>

      {labels.filter(l=>l.visible).map(l=>{
        const h=HEROES.find(x=>x.name===l.name);
        return(
          <TouchableOpacity
            key={l.name}
            activeOpacity={0.7}
            onPress={()=>startEnter(h.route)}
            hitSlop={{top:16,bottom:16,left:16,right:16}}
            style={[s.label,{left:l.x-72,top:l.y-22,borderColor:l.tint+'88'}]}
          >
            <Text style={[s.labelT,{color:l.tint}]}>{l.label}</Text>
            <Text style={s.labelS}>{l.sub}  ⤢</Text>
          </TouchableOpacity>
        );
      })}

      <SafeAreaView style={s.hudStrip} edges={['top']} pointerEvents="none">
        <Text style={s.hudBrand}>THE EMPIRE</Text>
      </SafeAreaView>

      {status==='loading'&&(
        <View style={s.loading} pointerEvents="none">
          <ActivityIndicator color="#E8C98A"/>
          <Text style={s.loadingT}>RAISING THE CITY…</Text>
        </View>
      )}

      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill,{backgroundColor:'#000',opacity:fade}]}/>
    </View>
  );
}

export default function EmpireCityScreen(props){
  return(
    <Boundary label="The Empire city">
      <EmpireCity {...props}/>
    </Boundary>
  );
}

const s=StyleSheet.create({
  container:{flex:1,backgroundColor:'#000'},
  label:{position:'absolute',width:140,alignItems:'center',backgroundColor:'rgba(0,0,0,0.5)',borderWidth:1,borderRadius:6,paddingVertical:5},
  labelT:{fontFamily:'monospace',fontSize:11,fontWeight:'700',letterSpacing:3},
  labelS:{fontFamily:'monospace',fontSize:7,color:'#8A7E63',letterSpacing:2,marginTop:2},
  hudStrip:{position:'absolute',top:0,left:0,right:0,alignItems:'center',paddingTop:10},
  hudBrand:{fontFamily:'monospace',fontSize:15,fontWeight:'700',color:'#E8C98A',letterSpacing:6},
  hint:{position:'absolute',bottom:0,left:0,right:0,alignItems:'center',paddingBottom:10},
  hintT:{fontFamily:'monospace',fontSize:8,color:'#4A4436',letterSpacing:2},
  loading:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center',gap:10},
  loadingT:{fontFamily:'monospace',fontSize:9,color:'#6C6353',letterSpacing:3},
  fallback:{flex:1,backgroundColor:'#000',alignItems:'center',paddingTop:60,gap:10},
  fallbackTitle:{fontFamily:'monospace',fontSize:18,fontWeight:'700',color:'#E8C98A',letterSpacing:6,marginBottom:4},
  fallbackMsg:{fontFamily:'monospace',fontSize:9,color:'#6C6353',letterSpacing:1,marginBottom:20,textAlign:'center',paddingHorizontal:24},
  fallbackBtn:{width:'80%',borderWidth:1,borderColor:'#1F1B14',borderRadius:8,paddingVertical:16,alignItems:'center',backgroundColor:'#080706'},
  fallbackBtnT:{fontFamily:'monospace',fontSize:13,fontWeight:'700',letterSpacing:3},
  fallbackBtnS:{fontFamily:'monospace',fontSize:7,color:'#4A4436',letterSpacing:2,marginTop:3},
});
