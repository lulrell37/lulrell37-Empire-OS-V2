// The Empire — a holographic command city that is the app's home / hub.
//
//   1 finger  drag ....... orbit the city
//   2 fingers drag ....... move through the city (pan across the ground)
//   pinch ................ zoom; zoom right into a landmark to open its screen
//   mouse wheel .......... zoom (Samsung DeX / any attached mouse)
//   tap a landmark ....... fly in and open it
//
// Rendered procedurally with three.js primitives + the shared holo material
// (src/screens/command/holoMaterial.js). Atmosphere is a gradient sky sphere,
// a glowing floor grid, drifting light-dust and exponential fog; each landmark
// is a distinct structure with a rotating halo and a vertical light beam. A HUD
// frame + telemetry overlay ties it to the rest of Empire OS. No bundled model —
// ships as an OTA update.
import React,{useRef,useState,useCallback,useMemo,useEffect}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Dimensions,ActivityIndicator,Animated,Easing,Platform,ScrollView}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import*as THREE from 'three';
import*as WebBrowser from 'expo-web-browser';
import{mergeGeometries}from 'three/examples/jsm/utils/BufferGeometryUtils';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{getHudState}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
import Boundary from './hud/Boundary';
import{HudFrame,useHudPulse}from './hud/HudChrome';
import{colors,FONTS}from '../theme';
import{makeHoloUniforms,createHoloMaterial,disposeObject}from './command/holoMaterial';

// Landmark id (mesh.userData.heroTarget) -> nav route (or external url) + display.
// `shape` picks the silhouette in buildHero(). Spread on a wide pentagon.
const HEROES=[
  {name:'Council',   route:'Command',   label:'THE COUNCIL',      sub:'THE PERSONAS',    tint:0xE8C98A, at:[0,15],    shape:'spire'},
  {name:'HUD',       route:'HUD',       label:'THE HUD',          sub:'EMPIRE STATE',    tint:0xE8C98A, at:[15,4],    shape:'dome'},
  {name:'Web',       url:'https://tarellbempire.com', label:'TARELL B. EMPIRE', sub:'TARELLBEMPIRE.COM', tint:0xF3E3BE, at:[10,-13], shape:'monument', external:true},
  {name:'Settings',  route:'Settings',  label:'SETTINGS',         sub:'THE WORKSHOP',    tint:0x9AA0A6, at:[-10,-13], shape:'workshop'},
  {name:'Laboratory',route:'Laboratory',label:'LABORATORY',       sub:'THE DIAGRAM',     tint:0x9AD3E0, at:[-15,4],   shape:'obelisk'},
];

const CITY_R=30;          // ground radius
const ROAM_BOUND=22;      // how far the camera target can travel

function mulberry32(a){
  return function(){
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return((t^t>>>14)>>>0)/4294967296;
  };
}

// --- gradient sky dome -----------------------------------------------------
function buildSky(){
  const geo=new THREE.SphereGeometry(160,24,16);
  const mat=new THREE.ShaderMaterial({
    side:THREE.BackSide,depthWrite:false,fog:false,
    uniforms:{},
    vertexShader:`varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader:`
      varying vec3 vP;
      void main(){
        float t = clamp(vP.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 top     = vec3(0.015, 0.014, 0.028);
        vec3 mid     = vec3(0.040, 0.030, 0.020);
        vec3 horizon = vec3(0.115, 0.080, 0.035);
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.28, t));
        c = mix(c, top, smoothstep(0.28, 0.9, t));
        // faint vignette glow toward the horizon band
        c += horizon * 0.5 * exp(-pow((t-0.12)*7.0, 2.0));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(geo,mat);
}

// --- glowing floor grid --------------------------------------------------
function buildGrid(){
  const g=new THREE.Group();
  const grid=new THREE.GridHelper(CITY_R*2.4,44,new THREE.Color(0xE8C98A),new THREE.Color(0x6b5a30));
  grid.material.transparent=true;grid.material.opacity=0.16;grid.material.depthWrite=false;
  grid.position.y=0.02;
  g.add(grid);
  // brighter primary axes
  const axis=new THREE.GridHelper(CITY_R*2.4,4,new THREE.Color(0xF3E3BE),new THREE.Color(0xF3E3BE));
  axis.material.transparent=true;axis.material.opacity=0.28;axis.material.depthWrite=false;
  axis.position.y=0.03;
  g.add(axis);
  g.userData.grid=grid.material;
  g.userData.axis=axis.material;
  return g;
}

// --- drifting light dust ------------------------------------------------
function buildDust(rnd){
  const N=260;
  const pos=new Float32Array(N*3);
  for(let i=0;i<N;i++){
    const r=rnd()*CITY_R*1.1;const a=rnd()*Math.PI*2;
    pos[i*3]=Math.cos(a)*r;
    pos[i*3+1]=0.3+rnd()*rnd()*16;
    pos[i*3+2]=Math.sin(a)*r;
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  const mat=new THREE.PointsMaterial({color:0xF3E3BE,size:0.11,transparent:true,opacity:0.5,depthWrite:false,blending:THREE.AdditiveBlending});
  const pts=new THREE.Points(geo,mat);
  pts.userData.base=pos.slice();
  return pts;
}

// --- one landmark -------------------------------------------------------
// Returns { group, ring, beam } — ring rotates, beam pulses.
function buildHero(hero,uniforms){
  const hmat=createHoloMaterial(uniforms,{tint:hero.tint,windows:true,opacity:0.5});
  const emat=createHoloMaterial(uniforms,{tint:hero.tint,opacity:0.9});
  const g=new THREE.Group();
  g.position.set(hero.at[0],0,hero.at[1]);
  g.name=hero.name;g.userData.heroTarget=hero.name;
  const put=(geo,mat,x,y,z)=>{
    const m=new THREE.Mesh(geo,mat||hmat);
    m.position.set(x,y,z);m.userData.heroTarget=hero.name;
    g.add(m);return m;
  };

  // glowing platform disc + inner ring
  put(new THREE.CylinderGeometry(3.6,3.9,0.35,48),emat,0,0.18,0);
  put(new THREE.CylinderGeometry(2.7,2.7,0.06,48),emat,0,0.42,0);

  if(hero.shape==='spire'){                                   // council — stepped spire + crown
    put(new THREE.BoxGeometry(3.4,0.5,3.4),hmat,0,0.7,0);
    put(new THREE.CylinderGeometry(1.5,1.9,5.5,6),hmat,0,3.6,0);
    put(new THREE.CylinderGeometry(0.7,1.5,2.6,6),hmat,0,7.4,0);
    const crown=put(new THREE.ConeGeometry(1.0,1.8,6),emat,0,9.4,0);crown.rotation.y=Math.PI/6;
  }else if(hero.shape==='dome'){                              // hud — pantheon dome + oculus ring
    put(new THREE.CylinderGeometry(2.6,2.8,3.4,40),hmat,0,2.4,0);
    put(new THREE.SphereGeometry(2.6,40,20,0,Math.PI*2,0,Math.PI/2),hmat,0,4.0,0);
    const oc=put(new THREE.TorusGeometry(0.7,0.12,10,28),emat,0,6.7,0);oc.rotation.x=Math.PI/2;
  }else if(hero.shape==='obelisk'){                           // laboratory — tapered obelisk + orbiting node
    put(new THREE.CylinderGeometry(0.35,1.7,8.5,4),hmat,0,4.7,0).rotation.y=Math.PI/4;
    const cap=put(new THREE.OctahedronGeometry(0.9),emat,0,9.6,0);cap.userData.spin=1;
  }else if(hero.shape==='workshop'){                          // settings — bunker + gear
    put(new THREE.BoxGeometry(4.2,3.0,4.0),hmat,0,2.1,0);
    const gear=put(new THREE.CylinderGeometry(1.9,1.9,0.4,12),emat,0,4.2,0);
    gear.rotation.x=Math.PI/2;gear.userData.spin=1;
    put(new THREE.BoxGeometry(0.35,2.4,0.35),hmat,1.9,5.0,1.9);
  }else{                                                      // monument — tarellbempire.com beacon
    put(new THREE.BoxGeometry(2.4,0.5,2.4),hmat,0,0.75,0);
    put(new THREE.BoxGeometry(1.7,7.0,1.7),hmat,0,4.4,0);
    put(new THREE.BoxGeometry(2.6,0.5,2.6),emat,0,7.9,0);
    const orb=put(new THREE.IcosahedronGeometry(1.15,1),emat,0,9.6,0);orb.userData.spin=1;
  }

  // rotating halo ring around the base
  const ringGeo=new THREE.TorusGeometry(4.4,0.05,8,60);
  ringGeo.rotateX(Math.PI/2);
  const ring=new THREE.Mesh(ringGeo,emat);
  ring.position.y=0.9;ring.userData.heroTarget=hero.name;
  g.add(ring);

  // vertical light beam
  const beamGeo=new THREE.CylinderGeometry(0.5,1.4,26,16,1,true);
  const beamMat=new THREE.MeshBasicMaterial({color:hero.tint,transparent:true,opacity:0.06,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});
  const beam=new THREE.Mesh(beamGeo,beamMat);
  beam.position.y=13;
  g.add(beam);

  return{group:g,ring,beam};
}

// Build the whole city. Static mass (streets, insulae) is merged so a big city
// still draws cheaply; landmarks are individual groups.
function buildCity(uniforms){
  const pivot=new THREE.Group();
  const rnd=mulberry32(20260904);
  const matPlain=createHoloMaterial(uniforms,{opacity:0.30});
  const matBld=createHoloMaterial(uniforms,{windows:true,opacity:0.34});

  const box=(w,h,d,x,y,z,ry)=>{
    const g=new THREE.BoxGeometry(w,h,d);
    if(ry)g.rotateY(ry);
    g.translate(x,y,z);
    return g;
  };

  pivot.add(buildSky());
  const grid=buildGrid();pivot.add(grid);
  // dark ground disc just under the grid to hide the far edge
  const ground=new THREE.Mesh(new THREE.CircleGeometry(CITY_R+2,64),new THREE.MeshBasicMaterial({color:0x05040a,transparent:true,opacity:0.82}));
  ground.rotation.x=-Math.PI/2;ground.position.y=-0.05;
  pivot.add(ground);
  const dust=buildDust(rnd);pivot.add(dust);

  // forum plaza
  pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(4.6,4.6,0.1,56),createHoloMaterial(uniforms,{opacity:0.5})).translateY(0.06));

  // radial + ring roads -> one merged mesh
  const roadGeos=[];
  for(let i=0;i<8;i++){
    const a=(i/8)*Math.PI*2;
    const g=new THREE.BoxGeometry(0.35,0.04,CITY_R*1.7);
    g.rotateY(a);g.translate(0,0.05,0);roadGeos.push(g);
  }
  for(const R of[9,17,25]){
    const t=new THREE.TorusGeometry(R,0.06,6,80);
    t.rotateX(Math.PI/2);t.translate(0,0.05,0);roadGeos.push(t);
  }
  pivot.add(new THREE.Mesh(mergeGeometries(roadGeos),matPlain));

  // insulae — seeded scatter off the plaza / landmark lots -> merged solid + edge glow
  const bldGeos=[];
  for(let i=0;i<190;i++){
    const ang=rnd()*Math.PI*2;
    const rad=6+rnd()*(CITY_R-8);
    const x=Math.cos(ang)*rad, z=Math.sin(ang)*rad;
    if(HEROES.some(h=>Math.hypot(x-h.at[0],z-h.at[1])<6))continue;
    const w=0.8+rnd()*1.8, d=0.8+rnd()*1.8;
    const tall=rnd()>0.9;
    const h=tall?(6+rnd()*11):(1.0+rnd()*rnd()*6.5);
    bldGeos.push(box(w,h,d,x,h/2,z,rnd()*Math.PI));
    if(rnd()>0.6)bldGeos.push(box(w*0.5,0.5+rnd()*1.5,d*0.5,x,h+0.35,z));
  }
  const bldGeo=mergeGeometries(bldGeos);
  pivot.add(new THREE.Mesh(bldGeo,matBld));
  const edges=new THREE.LineSegments(
    new THREE.EdgesGeometry(bldGeo,32),
    new THREE.LineBasicMaterial({color:0xF3E3BE,transparent:true,opacity:0.22,depthWrite:false}),
  );
  pivot.add(edges);

  // colonnade ringing the forum (instanced)
  const cols=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.11,0.11,2.4,8),matPlain,44);
  const dm=new THREE.Object3D();
  for(let i=0;i<44;i++){
    const a=(i/44)*Math.PI*2;
    dm.position.set(Math.cos(a)*5.0,1.2,Math.sin(a)*5.0);dm.updateMatrix();
    cols.setMatrixAt(i,dm.matrix);
  }
  pivot.add(cols);

  // --- landmarks ---
  const anchors=[],rings=[],beams=[];
  for(const hero of HEROES){
    const{group,ring,beam}=buildHero(hero,uniforms);
    pivot.add(group);
    rings.push(ring);beams.push(beam);
    anchors.push({name:hero.name,pos:group.position.clone().setY(7.5)});
  }

  // --- traffic: light streaks running the ring roads ---
  const cars=[];
  const carMesh=new THREE.InstancedMesh(new THREE.BoxGeometry(0.7,0.05,0.14),new THREE.MeshBasicMaterial({color:0xF3E3BE,transparent:true,opacity:0.6,depthWrite:false,blending:THREE.AdditiveBlending}),30);
  carMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for(let i=0;i<30;i++)cars.push({r:[9,17,25][i%3]+((i%2)?0.3:-0.3),a:rnd()*Math.PI*2,speed:(0.25+rnd()*0.5)*((i%2)?1:-1)});
  pivot.add(carMesh);

  const spinners=[];
  pivot.traverse(o=>{if(o.userData?.spin)spinners.push(o);});
  return{pivot,anchors,spinners,cars,carMesh,rings,beams,grid:grid.userData,dust};
}

function EmpireCity({navigation}){
  const[status,setStatus]=useState('loading');
  const[errMsg,setErrMsg]=useState('');
  const[labels,setLabels]=useState([]);
  const[centered,setCentered]=useState(null); // hero name nearest screen centre
  const setHudState=useEmpireStore(s=>s.setHudState);
  const fade=useRef(new Animated.Value(0)).current;
  const pulse=useHudPulse();

  const engine=useRef({
    rotY:0.7,rotX:0.58,startRX:0,startRY:0,
    dolly:0,startDolly:0,baseR:19,minR:2.6,maxR:34,wantEnter:false,
    panX:0,panZ:0,startPanX:0,startPanZ:0,
    active:true,idle:0,entering:null,navigated:false,
    vw:Dimensions.get('window').width,vh:Dimensions.get('window').height,
  }).current;

  // --- mouse-wheel zoom (DeX / attached mouse) ---
  const containerRef=useRef(null);
  const wheelScrollRef=useRef(null);
  const wheelY=useRef(0);
  const WHEEL_MID=1200;

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
    if(!dy)return;
    wheelY.current=y;
    applyWheelZoom(dy);
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
    engine.dolly=0;engine.wantEnter=false;
    fade.stopAnimation();
    Animated.timing(fade,{toValue:0,duration:420,easing:Easing.out(Easing.cubic),useNativeDriver:true}).start();
    return()=>{engine.active=false;};
  },[engine,fade]));

  useEffect(()=>()=>{
    if(engine.raf)cancelAnimationFrame(engine.raf);
    try{if(engine.pivot)disposeObject(engine.pivot);}catch{}
    try{engine.renderer?.dispose?.();}catch{}
  },[engine]);

  const enterHero=useCallback((hero)=>{
    if(!hero)return;
    if(hero.external){WebBrowser.openBrowserAsync(hero.url).catch(()=>{});return;}
    if(engine.entering)return;
    engine.entering={route:hero.route,name:hero.name,t:0};
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
    const move=Gesture.Pan().runOnJS(true).maxPointers(1)
      .onStart(()=>{engine.startPanX=engine.panX;engine.startPanZ=engine.panZ;engine.idle=0;})
      .onUpdate(e=>{
        const s=0.020*(engine.baseR+engine.dolly)/19;
        const fx=Math.sin(engine.rotY), fz=Math.cos(engine.rotY);
        const rx=Math.cos(engine.rotY), rz=-Math.sin(engine.rotY);
        let nx=engine.startPanX - (rx*e.translationX + fx*e.translationY)*s;
        let nz=engine.startPanZ - (rz*e.translationX + fz*e.translationY)*s;
        const d=Math.hypot(nx,nz);
        if(d>ROAM_BOUND){nx=nx/d*ROAM_BOUND;nz=nz/d*ROAM_BOUND;}
        engine.panX=nx;engine.panZ=nz;engine.idle=0;
      });
    const orbit=Gesture.Pan().runOnJS(true).minPointers(2)
      .onStart(()=>{engine.startRX=engine.rotX;engine.startRY=engine.rotY;engine.idle=0;})
      .onUpdate(e=>{
        engine.rotY=engine.startRY-e.translationX*0.006;
        engine.rotX=Math.max(0.12,Math.min(1.4,engine.startRX-e.translationY*0.005));
        engine.idle=0;
      });
    const pinch=Gesture.Pinch().runOnJS(true)
      .onStart(()=>{engine.startDolly=engine.dolly;engine.idle=0;})
      .onUpdate(e=>{
        engine.dolly=Math.max(engine.minR-engine.baseR,Math.min(engine.maxR-engine.baseR,engine.startDolly-(e.scale-1)*19));
        engine.idle=0;
      })
      .onEnd(e=>{
        const r=engine.baseR+engine.dolly;
        if(e.scale>1&&r<=engine.minR+0.5)engine.wantEnter=true;
      });
    const tap=Gesture.Tap().runOnJS(true).maxDistance(18)
      .onEnd((e,ok)=>{if(ok){const t=raycastAt(e.x,e.y);if(t){const h=HEROES.find(x=>x.name===t);if(h)enterHero(h);}}});
    return Gesture.Simultaneous(pinch,orbit,Gesture.Exclusive(tap,move));
  },[engine,raycastAt,enterHero]);

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x000000,1);

      const scene=new THREE.Scene();
      scene.fog=new THREE.FogExp2(0x06050b,0.030);
      const camera=new THREE.PerspectiveCamera(46,glW/glH,0.1,320);
      scene.add(new THREE.AmbientLight(0xffffff,0.7));
      const kl=new THREE.DirectionalLight(0xfff2d8,1.5);kl.position.set(9,14,7);scene.add(kl);
      const rl=new THREE.DirectionalLight(0xE8C98A,0.8);rl.position.set(-11,6,-9);scene.add(rl);
      const fl=new THREE.PointLight(0xF3E3BE,0.9,40);fl.position.set(0,7,0);scene.add(fl);

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

        const T=engine.uniforms.uTime.value+=dt;
        engine.idle+=dt;
        const rNow=engine.baseR+engine.dolly;
        if(engine.idle>3&&!engine.entering&&rNow>engine.baseR-2)engine.rotY+=dt*0.022;
        for(const sp of engine.spinners)sp.rotation.z+=dt*0.8;

        // halo rings + beams
        for(let i=0;i<engine.rings.length;i++){
          engine.rings[i].rotation.z+=dt*(0.35+i*0.06);
          const b=engine.beams[i];
          if(b)b.material.opacity=0.05+0.045*(0.5+0.5*Math.sin(T*1.3+i));
        }
        // grid pulse
        if(engine.grid){
          engine.grid.grid.opacity=0.12+0.06*(0.5+0.5*Math.sin(T*0.6));
          engine.grid.axis.opacity=0.22+0.10*(0.5+0.5*Math.sin(T*0.6+1.0));
        }
        // dust drift
        if(engine.dust){
          const p=engine.dust.geometry.attributes.position;const base=engine.dust.userData.base;
          for(let i=0;i<p.count;i++){
            p.array[i*3+1]=base[i*3+1]+Math.sin(T*0.3+i*1.7)*0.5;
          }
          p.needsUpdate=true;
        }
        // traffic streaks
        for(let i=0;i<engine.cars.length;i++){
          const c=engine.cars[i];c.a+=c.speed*dt;
          dummy.position.set(Math.cos(c.a)*c.r,0.12,Math.sin(c.a)*c.r);
          dummy.rotation.set(0,-c.a+(c.speed>0?0:Math.PI),0);
          dummy.updateMatrix();engine.carMesh.setMatrixAt(i,dummy.matrix);
        }
        engine.carMesh.instanceMatrix.needsUpdate=true;

        // camera orbit around (panX,0,panZ)
        let r=engine.baseR+engine.dolly;
        let tx=engine.panX,tz=engine.panZ;
        if(engine.entering){
          const e=engine.entering;e.t=Math.min(1,e.t+dt/0.45);
          const hero=HEROES.find(h=>h.name===e.name);
          r=THREE.MathUtils.lerp(r,3.2,e.t);
          tx=THREE.MathUtils.lerp(tx,hero.at[0],e.t);
          tz=THREE.MathUtils.lerp(tz,hero.at[1],e.t);
          if(e.t>=1&&!engine.navigated){engine.navigated=true;navigation.navigate(e.route);return;}
        }
        engine.camera.position.set(
          tx+Math.sin(engine.rotY)*Math.cos(engine.rotX)*r,
          Math.max(1.5,Math.sin(engine.rotX)*r*0.92+1.5),
          tz+Math.cos(engine.rotY)*Math.cos(engine.rotX)*r,
        );
        engine.camera.lookAt(tx,1.4,tz);

        engine.renderer.render(engine.scene,engine.camera);
        gl.endFrameEXP();

        // zoom-into-a-landmark on a held pinch-in
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
            enterHero(HEROES.find(h=>h.name===best.name));
          }
        }

        // project anchors -> overlay labels (~8fps)
        lblAcc+=dt;
        if(lblAcc>0.12){
          lblAcc=0;
          const out=[];let near=null,nearD=1e9;
          for(const a of engine.anchors){
            tmp.copy(a.pos).applyMatrix4(engine.pivot.matrixWorld).project(engine.camera);
            const meta=HEROES.find(h=>h.name===a.name);
            const sx=(tmp.x*0.5+0.5)*engine.vw, sy=(-tmp.y*0.5+0.5)*engine.vh;
            const vis=tmp.z<1&&tmp.x>-1.15&&tmp.x<1.15&&tmp.y>-1.2&&tmp.y<1.2;
            if(vis){const d=Math.hypot(sx-engine.vw/2,sy-engine.vh/2);if(d<nearD){nearD=d;near=a.name;}}
            out.push({
              name:a.name,label:meta.label,sub:meta.sub,external:!!meta.external,
              tint:'#'+meta.tint.toString(16).padStart(6,'0'),
              x:sx,y:sy,visible:vis,
            });
          }
          setLabels(out);
          setCentered(near&&nearD<Math.min(engine.vw,engine.vh)*0.22?near:null);
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
          <TouchableOpacity key={h.name} style={s.fallbackBtn} onPress={()=>h.external?WebBrowser.openBrowserAsync(h.url).catch(()=>{}):navigation.navigate(h.route)}>
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

      {/* landmark markers */}
      {labels.filter(l=>l.visible).map(l=>{
        const h=HEROES.find(x=>x.name===l.name);
        const isCentered=centered===l.name;
        return(
          <TouchableOpacity
            key={l.name}
            activeOpacity={0.8}
            onPress={()=>enterHero(h)}
            hitSlop={{top:18,bottom:18,left:18,right:18}}
            style={[s.marker,{left:l.x-84,top:l.y-30,borderColor:l.tint+(isCentered?'':'55')}]}
          >
            <View style={[s.markerBr,s.brTL,{borderColor:l.tint}]}/>
            <View style={[s.markerBr,s.brBR,{borderColor:l.tint}]}/>
            <Text style={[s.markerLabel,{color:l.tint}]} numberOfLines={1}>{l.label}</Text>
            <Text style={s.markerSub} numberOfLines={1}>
              {l.sub}{'  '}{l.external?'↗':(isCentered?'▸ ENTER':'⤢')}
            </Text>
          </TouchableOpacity>
        );
      })}

      {/* centre reticle when a landmark is lined up */}
      {centered&&(
        <View style={s.reticle} pointerEvents="none">
          <View style={[s.retLine,s.retTop]}/><View style={[s.retLine,s.retBottom]}/>
          <View style={[s.retLine,s.retLeft]}/><View style={[s.retLine,s.retRight]}/>
        </View>
      )}

      {/* telemetry header */}
      <SafeAreaView style={s.telemetry} edges={['top']} pointerEvents="none">
        <Text style={s.telemetryBrand}>♔ THE EMPIRE</Text>
        <Text style={s.telemetryMeta}>{HEROES.length} SECTORS · WALDORF·MD · SYS ONLINE</Text>
      </SafeAreaView>

      {/* nav hint */}
      <SafeAreaView style={s.hint} edges={['bottom']} pointerEvents="none">
        <Text style={s.hintText}>DRAG TO ORBIT · TWO FINGERS TO MOVE · PINCH TO ENTER A SECTOR</Text>
      </SafeAreaView>

      <HudFrame pulse={pulse}/>

      {status==='loading'&&(
        <View style={s.loading} pointerEvents="none">
          <ActivityIndicator color={colors.gold}/>
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

  marker:{position:'absolute',width:168,alignItems:'center',backgroundColor:'rgba(4,4,7,0.62)',borderWidth:1,borderRadius:3,paddingVertical:6,paddingHorizontal:6},
  markerBr:{position:'absolute',width:8,height:8},
  brTL:{top:-1,left:-1,borderTopWidth:1.5,borderLeftWidth:1.5},
  brBR:{bottom:-1,right:-1,borderBottomWidth:1.5,borderRightWidth:1.5},
  markerLabel:{fontFamily:FONTS.monoMed,fontSize:10,fontWeight:'700',letterSpacing:2.5},
  markerSub:{fontFamily:FONTS.mono,fontSize:7,color:'#8A7E63',letterSpacing:1.5,marginTop:3},

  reticle:{position:'absolute',left:'50%',top:'50%',width:64,height:64,marginLeft:-32,marginTop:-32},
  retLine:{position:'absolute',backgroundColor:colors.gold,opacity:0.7},
  retTop:{top:0,left:31,width:2,height:14},
  retBottom:{bottom:0,left:31,width:2,height:14},
  retLeft:{left:0,top:31,width:14,height:2},
  retRight:{right:0,top:31,width:14,height:2},

  telemetry:{position:'absolute',top:0,left:0,right:0,alignItems:'center',paddingTop:10},
  telemetryBrand:{fontFamily:FONTS.monoMed,fontSize:14,fontWeight:'700',color:colors.gold,letterSpacing:5},
  telemetryMeta:{fontFamily:FONTS.mono,fontSize:8,color:'#8A7E63',letterSpacing:2,marginTop:4},

  hint:{position:'absolute',bottom:0,left:0,right:0,alignItems:'center',paddingBottom:12},
  hintText:{fontFamily:FONTS.mono,fontSize:7,color:'#4A4436',letterSpacing:2},

  loading:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center',gap:10},
  loadingT:{fontFamily:FONTS.mono,fontSize:9,color:'#6C6353',letterSpacing:3},

  fallback:{flex:1,backgroundColor:'#000',alignItems:'center',paddingTop:60,gap:10},
  fallbackTitle:{fontFamily:FONTS.mono,fontSize:18,fontWeight:'700',color:colors.gold,letterSpacing:6,marginBottom:4},
  fallbackMsg:{fontFamily:FONTS.mono,fontSize:9,color:'#6C6353',letterSpacing:1,marginBottom:20,textAlign:'center',paddingHorizontal:24},
  fallbackBtn:{width:'80%',borderWidth:1,borderColor:'#1F1B14',borderRadius:8,paddingVertical:16,alignItems:'center',backgroundColor:'#080706'},
  fallbackBtnT:{fontFamily:FONTS.mono,fontSize:13,fontWeight:'700',letterSpacing:3},
  fallbackBtnS:{fontFamily:FONTS.mono,fontSize:7,color:'#4A4436',letterSpacing:2,marginTop:3},
});
