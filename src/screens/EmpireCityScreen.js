// THE EMPIRE — a holographic Roman city that is the app's home / hub.
//
//   1 finger  drag ....... orbit / rotate the city
//   2 fingers drag ....... move through the city (pan across the ground)
//   pinch ................ zoom; zoom right into a landmark to open its screen
//   mouse wheel .......... zoom (Samsung DeX / any attached mouse)
//   tap a landmark ....... fly in and open it
//
// Built on an actual Roman grid plan: the Cardo (N–S) and Decumanus (E–W)
// avenues cross at a central forum, with a full grid of lesser streets forming
// insula blocks. ~70 supporting buildings fill the blocks (window-grid facades,
// lobby band, cornice, one of three roof styles). Four detailed landmarks sit at
// the corners of the forum, plus the tarellbempire.com beacon on the east gate.
// ~22 cars run the streets in-lane and ~34 pedestrians walk the sidewalks.
//
// Rendered procedurally with three.js primitives + the shared holo material
// (src/screens/command/holoMaterial.js). Static mass (roads, pavement, the whole
// building stock) is merged so the city still draws in a handful of calls;
// landmarks are individual groups. Labels are screen-space projected RN <Text>
// (see the animate loop -> setLabels). No bundled model — ships as an OTA update.
import React,{useRef,useState,useCallback,useMemo,useEffect}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Dimensions,ActivityIndicator,Platform,ScrollView}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import*as THREE from 'three';
import*as WebBrowser from 'expo-web-browser';
import Svg,{Defs,RadialGradient as SvgRadial,Stop,Rect,Pattern}from 'react-native-svg';
import{mergeGeometries}from 'three/examples/jsm/utils/BufferGeometryUtils';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{getHudState}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
import Boundary from './hud/Boundary';
import{HudFrame,useHudPulse}from './hud/HudChrome';
import{colors,FONTS}from '../theme';
import{makeHoloUniforms,createHoloMaterial,disposeObject}from './command/holoMaterial';

// Landmark id (mesh.userData.heroTarget) -> nav route (or external url) + display.
// `label` is the serif overlay caption, `sub` the system name under it.
// `shape` picks the silhouette in buildHero(). `at` is [x,z]; `ly` the label
// anchor height. The four screen landmarks ring the forum; Web is the east gate.
const HEROES=[
  {name:'HUD',       route:'HUD',       label:'EMPIRE STATE',     sub:'THE HUD',          tint:0xE8C98A, at:[12,12],  ly:8.5,  shape:'rotunda'},
  {name:'Council',   route:'Command',   label:'THE PERSONAS',     sub:'THE COUNCIL',      tint:0xE8C98A, at:[-12,12], ly:10.5, shape:'towers'},
  {name:'Laboratory',route:'Laboratory',label:'THE DIAGRAM',      sub:'THE LABORATORY',   tint:0x9AD3E0, at:[-12,-12],ly:10.5, shape:'observatory'},
  {name:'Settings',  route:'Settings',  label:'THE WORKSHOP',     sub:'SETTINGS',         tint:0x9AA0A6, at:[12,-12], ly:8.5,  shape:'ziggurat'},
  {name:'Web',       url:'https://tarellbempire.com', label:'TARELL B. EMPIRE', sub:'TARELLBEMPIRE.COM', tint:0xF3E3BE, at:[25,0], ly:11, shape:'monument', external:true},
];

const CITY_R=34;         // ground radius
const EXTENT=32;         // half-length of the road grid
const ROAM_BOUND=24;     // how far the camera target can travel
const AV_HW=2.4;         // Cardo / Decumanus half-width
const ST_HW=0.62;        // lesser-street half-width
const SEC=[-27,-18,-9,9,18,27];                 // lesser-street coordinates
const LINES=[-EXTENT,-27,-18,-9,0,9,18,27,EXTENT]; // block boundaries (incl. avenues + edge)
const ROADS=[0,-9,9,-18,18,-27,27];             // every road coordinate on one axis

function mulberry32(a){
  return function(){
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return((t^t>>>14)>>>0)/4294967296;
  };
}

// box geometry, pre-translated (and optionally pre-rotated) so it can be merged.
function box(w,h,d,x,y,z,ry){
  const g=new THREE.BoxGeometry(w,h,d);
  if(ry)g.rotateY(ry);
  g.translate(x,y,z);
  return g;
}

// --- gradient sky dome -----------------------------------------------------
function buildSky(){
  const geo=new THREE.SphereGeometry(170,24,16);
  const mat=new THREE.ShaderMaterial({
    side:THREE.BackSide,depthWrite:false,fog:false,uniforms:{},
    vertexShader:`varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader:`
      varying vec3 vP;
      void main(){
        float t = clamp(vP.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 top     = vec3(0.014, 0.013, 0.026);
        vec3 mid     = vec3(0.040, 0.030, 0.020);
        vec3 horizon = vec3(0.120, 0.082, 0.036);
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.28, t));
        c = mix(c, top, smoothstep(0.28, 0.9, t));
        c += horizon * 0.5 * exp(-pow((t-0.12)*7.0, 2.0));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  return new THREE.Mesh(geo,mat);
}

// --- glowing floor grid --------------------------------------------------
function buildGrid(){
  const g=new THREE.Group();
  const grid=new THREE.GridHelper(CITY_R*2.2,48,new THREE.Color(0xE8C98A),new THREE.Color(0x6b5a30));
  grid.material.transparent=true;grid.material.opacity=0.10;grid.material.depthWrite=false;
  grid.position.y=0.015;
  g.add(grid);
  g.userData.grid=grid.material;
  g.userData.axis=grid.material; // kept for the animate-loop pulse API
  return g;
}

// --- drifting light dust ------------------------------------------------
function buildDust(rnd){
  const N=240;
  const pos=new Float32Array(N*3);
  for(let i=0;i<N;i++){
    const r=rnd()*CITY_R*1.05;const a=rnd()*Math.PI*2;
    pos[i*3]=Math.cos(a)*r;
    pos[i*3+1]=0.3+rnd()*rnd()*16;
    pos[i*3+2]=Math.sin(a)*r;
  }
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
  const mat=new THREE.PointsMaterial({color:0xF3E3BE,size:0.1,transparent:true,opacity:0.45,depthWrite:false,blending:THREE.AdditiveBlending});
  const pts=new THREE.Points(geo,mat);
  pts.userData.base=pos.slice();
  return pts;
}

// --- one supporting building -------------------------------------------
// Appends a window-grid facade to `facade`, and the lobby band / cornice /
// rooftop cap to `trim`. Everything is merge-ready geometry.
function addBuilding(cx,cz,cellW,cellD,rnd,facade,trim){
  const w=Math.max(1.6,Math.min(cellW-1.4,2.2+rnd()*2.2));
  const d=Math.max(1.6,Math.min(cellD-1.4,2.2+rnd()*2.2));
  const tall=rnd()>0.86;
  const h=tall?(9+rnd()*7):(3+rnd()*rnd()*7.5);

  facade.push(box(w,h,d,cx,h/2,cz));
  trim.push(box(w+0.5,1.0,d+0.5,cx,0.5,cz));      // lobby / base band
  trim.push(box(w+0.35,0.32,d+0.35,cx,h-0.16,cz)); // cornice ledge

  const roll=rnd();
  if(roll<0.34){                                   // pediment cone
    const c=new THREE.ConeGeometry(Math.min(w,d)*0.55,1.8,4);
    c.rotateY(Math.PI/4);c.translate(cx,h+0.9,cz);
    trim.push(c);
  }else if(roll<0.67){                             // stepped ziggurat cap
    trim.push(box(w*0.72,0.5,d*0.72,cx,h+0.25,cz));
    trim.push(box(w*0.46,0.5,d*0.46,cx,h+0.72,cz));
    trim.push(box(w*0.24,0.6,d*0.24,cx,h+1.25,cz));
  }else{                                           // colonnade cap
    for(let k=0;k<8;k++){
      const a=(k/8)*Math.PI*2;
      const col=new THREE.CylinderGeometry(0.08,0.08,1.1,6);
      col.translate(cx+Math.cos(a)*w*0.4,h+0.55,cz+Math.sin(a)*d*0.4);
      trim.push(col);
    }
    trim.push(box(w*0.92,0.24,d*0.92,cx,h+1.2,cz));
  }
}

// --- one landmark -------------------------------------------------------
// Returns { group, ring, beam } — ring rotates, beam pulses. Orbs / rings
// tagged userData.spin are spun by the animate loop.
function buildHero(hero,uniforms){
  const hmat=createHoloMaterial(uniforms,{tint:hero.tint,windows:true,opacity:0.5});
  const emat=createHoloMaterial(uniforms,{tint:hero.tint,opacity:0.9});
  const g=new THREE.Group();
  g.position.set(hero.at[0],0,hero.at[1]);
  g.name=hero.name;
  const put=(geo,mat,x,y,z)=>{
    const m=new THREE.Mesh(geo,mat||hmat);
    m.position.set(x,y,z);
    g.add(m);return m;
  };
  const merged=(geos,mat)=>{const m=new THREE.Mesh(mergeGeometries(geos),mat||hmat);g.add(m);return m;};

  // glowing platform disc + inner ring
  put(new THREE.CylinderGeometry(3.7,4.0,0.35,48),emat,0,0.18,0);
  put(new THREE.CylinderGeometry(2.8,2.8,0.06,48),emat,0,0.42,0);

  if(hero.shape==='rotunda'){                       // HUD — colonnade ring under a dome
    put(new THREE.CylinderGeometry(3.4,3.6,0.4,40),emat,0,0.4,0);
    const cols=[];
    for(let i=0;i<16;i++){
      const a=(i/16)*Math.PI*2;
      const c=new THREE.CylinderGeometry(0.13,0.13,3.0,8);
      c.translate(Math.cos(a)*2.9,2.0,Math.sin(a)*2.9);
      cols.push(c);
    }
    merged(cols,hmat);
    const ent=put(new THREE.TorusGeometry(2.95,0.16,8,36),emat,0,3.55,0);ent.rotation.x=Math.PI/2;
    put(new THREE.SphereGeometry(2.7,32,16,0,Math.PI*2,0,Math.PI/2),hmat,0,3.7,0);
    const oc=put(new THREE.TorusGeometry(0.6,0.1,8,24),emat,0,6.4,0);oc.rotation.x=Math.PI/2;

  }else if(hero.shape==='towers'){                  // COUNCIL — twin colonnaded towers + lit chamber
    const towerParts=[];
    for(const sx of[-2.8,2.8]){
      towerParts.push(box(2.3,8.4,2.3,sx,4.2,0));
      for(const fz of[-0.8,0,0.8]){
        const c=new THREE.CylinderGeometry(0.14,0.14,6.4,8);
        c.translate(sx+fz,3.4,1.35);
        towerParts.push(c);
      }
    }
    merged(towerParts,hmat);
    put(box(8.4,0.7,2.7,0,0,0),emat,0,8.4,0);       // lintel
    // warm glass boardroom chamber, visible from outside
    const glass=new THREE.Mesh(
      box(3.3,3.4,2.2,0,0,0),
      new THREE.MeshBasicMaterial({color:0xFFC98A,transparent:true,opacity:0.28,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending}),
    );
    glass.position.set(0,4.7,0);g.add(glass);
    put(new THREE.CylinderGeometry(0.95,0.95,0.12,20),emat,0,3.7,0); // table
    const chairs=[];
    for(let i=0;i<7;i++){
      const a=(i/7)*Math.PI*2;
      chairs.push(box(0.3,0.55,0.3,Math.cos(a)*1.4,3.5,Math.sin(a)*1.4));
    }
    merged(chairs,emat);

  }else if(hero.shape==='observatory'){             // LABORATORY — orb on a tapered plinth + ring
    put(new THREE.CylinderGeometry(1.1,2.2,6.2,6),hmat,0,3.1,0);
    const orb=put(new THREE.IcosahedronGeometry(1.9,2),emat,0,7.7,0);orb.userData.spin=1;
    const ring=new THREE.Mesh(new THREE.TorusGeometry(2.7,0.06,8,44),emat);
    ring.position.y=7.7;ring.rotation.x=1.15;ring.userData.spin=1;
    g.add(ring);

  }else if(hero.shape==='ziggurat'){                // SETTINGS — stepped ziggurat
    const steps=[[5.4,1.3],[4.4,1.2],[3.4,1.1],[2.4,1.0],[1.5,0.9]];
    let y=0.5;
    for(let i=0;i<steps.length;i++){
      const[sw,sh]=steps[i];
      put(box(sw,sh,sw,0,0,0),i===steps.length-1?emat:hmat,0,y+sh/2,0);
      y+=sh;
    }
    put(box(0.9,0.9,0.9,0,0,0),emat,0,y+0.45,0);

  }else{                                            // MONUMENT — tarellbempire.com beacon
    put(box(2.4,0.5,2.4,0,0,0),hmat,0,0.75,0);
    put(box(1.7,7.0,1.7,0,0,0),hmat,0,4.4,0);
    put(box(2.6,0.5,2.6,0,0,0),emat,0,7.9,0);
    const orb=put(new THREE.IcosahedronGeometry(1.15,1),emat,0,9.6,0);orb.userData.spin=1;
  }

  // rotating halo ring around the base
  const ringGeo=new THREE.TorusGeometry(4.5,0.05,8,60);
  ringGeo.rotateX(Math.PI/2);
  const ring=new THREE.Mesh(ringGeo,emat);
  ring.position.y=0.9;
  g.add(ring);

  // vertical light beam
  const beam=new THREE.Mesh(
    new THREE.CylinderGeometry(0.5,1.5,26,16,1,true),
    new THREE.MeshBasicMaterial({color:hero.tint,transparent:true,opacity:0.06,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}),
  );
  beam.position.y=13;
  beam.raycast=()=>{};   // the big soft beam is not a tap target
  g.add(beam);

  g.traverse(o=>{if(o.isMesh)o.userData.heroTarget=hero.name;});
  return{group:g,ring,beam};
}

// Build the whole city.
function buildCity(uniforms){
  const pivot=new THREE.Group();
  const rnd=mulberry32(20260904);
  const matRoad=createHoloMaterial(uniforms,{opacity:0.24});
  const matPave=createHoloMaterial(uniforms,{opacity:0.12});
  const matStripe=createHoloMaterial(uniforms,{tint:0xF3E3BE,opacity:0.7});
  const matBld=createHoloMaterial(uniforms,{windows:true,opacity:0.34});
  const matTrim=createHoloMaterial(uniforms,{opacity:0.4});

  pivot.add(buildSky());
  const grid=buildGrid();pivot.add(grid);
  const ground=new THREE.Mesh(new THREE.CircleGeometry(CITY_R+2,64),new THREE.MeshBasicMaterial({color:0x05040a,transparent:true,opacity:0.85}));
  ground.rotation.x=-Math.PI/2;ground.position.y=-0.05;
  pivot.add(ground);
  const dust=buildDust(rnd);pivot.add(dust);

  // --- roads: Cardo + Decumanus + the lesser-street grid, one merged mesh ---
  const roadGeos=[box(AV_HW*2,0.04,EXTENT*2,0,0.05,0),box(EXTENT*2,0.04,AV_HW*2,0,0.05,0)];
  for(const c of SEC){
    roadGeos.push(box(ST_HW*2,0.04,EXTENT*2,c,0.05,0));
    roadGeos.push(box(EXTENT*2,0.04,ST_HW*2,0,0.05,c));
  }
  pivot.add(new THREE.Mesh(mergeGeometries(roadGeos),matRoad));

  // --- centre-line stripes (avenues get a double line) ---
  const stripeGeos=[
    box(0.06,0.02,EXTENT*2,-0.8,0.065,0),box(0.06,0.02,EXTENT*2,0.8,0.065,0),
    box(EXTENT*2,0.02,0.06,0,0.065,-0.8),box(EXTENT*2,0.02,0.06,0,0.065,0.8),
  ];
  for(const c of SEC){
    stripeGeos.push(box(0.05,0.02,EXTENT*2,c,0.065,0));
    stripeGeos.push(box(EXTENT*2,0.02,0.05,0,0.065,c));
  }
  pivot.add(new THREE.Mesh(mergeGeometries(stripeGeos),matStripe));

  // forum plaza + colonnade
  pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(5.0,5.0,0.12,56),createHoloMaterial(uniforms,{opacity:0.5})).translateY(0.09));
  const cols=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12,0.12,2.6,8),matTrim,40);
  const dm=new THREE.Object3D();
  for(let i=0;i<40;i++){
    const a=(i/40)*Math.PI*2;
    dm.position.set(Math.cos(a)*5.6,1.3,Math.sin(a)*5.6);dm.updateMatrix();
    cols.setMatrixAt(i,dm.matrix);
  }
  pivot.add(cols);

  // --- pavement slabs + the building stock, block by block ---
  const nearHero=(x,z,r)=>HEROES.some(h=>Math.hypot(x-h.at[0],z-h.at[1])<r);
  const slabGeos=[],facadeGeos=[],trimGeos=[];
  for(let i=0;i<LINES.length-1;i++){
    for(let j=0;j<LINES.length-1;j++){
      const x0=LINES[i],x1=LINES[i+1],z0=LINES[j],z1=LINES[j+1];
      const insL=x0===0?3.0:1.7,insR=x1===0?3.0:1.7;
      const insD=z0===0?3.0:1.7,insU=z1===0?3.0:1.7;
      const bx0=x0+insL,bx1=x1-insR,bz0=z0+insD,bz1=z1-insU;
      const bw=bx1-bx0,bd=bz1-bz0;
      if(bw<1.6||bd<1.6)continue;
      const cx=(bx0+bx1)/2,cz=(bz0+bz1)/2;
      if(Math.hypot(cx,cz)<7.5)continue;            // forum
      if(nearHero(cx,cz,8.5))continue;              // landmark lots
      slabGeos.push(box(bw+1.3,0.05,bd+1.3,cx,0.035,cz));
      const split=bw>6.6&&bd>6.6;
      if(split){
        if(bw>=bd){
          addBuilding(cx-bw/4,cz,bw/2,bd,rnd,facadeGeos,trimGeos);
          addBuilding(cx+bw/4,cz,bw/2,bd,rnd,facadeGeos,trimGeos);
        }else{
          addBuilding(cx,cz-bd/4,bw,bd/2,rnd,facadeGeos,trimGeos);
          addBuilding(cx,cz+bd/4,bw,bd/2,rnd,facadeGeos,trimGeos);
        }
      }else{
        addBuilding(cx,cz,bw,bd,rnd,facadeGeos,trimGeos);
      }
    }
  }
  pivot.add(new THREE.Mesh(mergeGeometries(slabGeos),matPave));
  const facadeGeo=mergeGeometries(facadeGeos);
  pivot.add(new THREE.Mesh(facadeGeo,matBld));
  pivot.add(new THREE.Mesh(mergeGeometries(trimGeos),matTrim));
  pivot.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(facadeGeo,24),
    new THREE.LineBasicMaterial({color:0xF3E3BE,transparent:true,opacity:0.2,depthWrite:false}),
  ));

  // --- landmarks ---
  const anchors=[],rings=[],beams=[];
  for(const hero of HEROES){
    const{group,ring,beam}=buildHero(hero,uniforms);
    pivot.add(group);
    rings.push(ring);beams.push(beam);
    anchors.push({name:hero.name,pos:new THREE.Vector3(hero.at[0],hero.ly,hero.at[1])});
  }

  // --- traffic: ~22 cars, correct lane + heading, looping ---
  const cars=[];
  const carMesh=new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.8,0.16,0.34),
    new THREE.MeshBasicMaterial({color:0xF7E6C0,transparent:true,opacity:0.85,depthWrite:false,blending:THREE.AdditiveBlending}),
    22,
  );
  carMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  carMesh.frustumCulled=false;
  for(let i=0;i<22;i++){
    const horiz=i%2===0;
    const line=ROADS[Math.floor(rnd()*ROADS.length)];
    const dir=rnd()>0.5?1:-1;
    cars.push({horiz,line,dir,pos:(rnd()*2-1)*EXTENT,speed:2.2+rnd()*2.4,
      lane:(Math.abs(line)<0.001?1.1:0.5)});
  }
  pivot.add(carMesh);

  // --- ~34 pedestrians walking the sidewalks ---
  const peds=[];
  const pedMesh=new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.09,0.11,0.55,5),
    new THREE.MeshBasicMaterial({color:0xE8C98A,transparent:true,opacity:0.8,depthWrite:false,blending:THREE.AdditiveBlending}),
    34,
  );
  pedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pedMesh.frustumCulled=false;
  for(let i=0;i<34;i++){
    const horiz=i%2===0;
    const line=ROADS[Math.floor(rnd()*ROADS.length)];
    const side=rnd()>0.5?1:-1;
    const off=(Math.abs(line)<0.001?AV_HW+0.9:ST_HW+0.8)*side;
    peds.push({horiz,line,off,dir:rnd()>0.5?1:-1,pos:(rnd()*2-1)*EXTENT,speed:0.6+rnd()*0.8,ph:rnd()*6.28});
  }
  pivot.add(pedMesh);

  const spinners=[];
  pivot.traverse(o=>{if(o.userData?.spin)spinners.push(o);});
  return{pivot,anchors,spinners,cars,carMesh,peds,pedMesh,rings,beams,grid:grid.userData,dust};
}

function EmpireCity({navigation}){
  const[status,setStatus]=useState('loading');
  const[errMsg,setErrMsg]=useState('');
  const[labels,setLabels]=useState([]);
  const[centered,setCentered]=useState(null); // hero name nearest screen centre
  const setHudState=useEmpireStore(s=>s.setHudState);
  const pulse=useHudPulse();

  const engine=useRef({
    rotY:0.7,rotX:0.56,startRX:0,startRY:0,
    dolly:0,startDolly:0,baseR:21,minR:2.8,maxR:38,wantEnter:false,
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
    return()=>{engine.active=false;};
  },[engine]));

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
  },[engine]);

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
    const orbit=Gesture.Pan().runOnJS(true).maxPointers(1)
      .onStart(()=>{engine.startRX=engine.rotX;engine.startRY=engine.rotY;engine.idle=0;})
      .onUpdate(e=>{
        engine.rotY=engine.startRY-e.translationX*0.006;
        engine.rotX=Math.max(0.12,Math.min(1.4,engine.startRX-e.translationY*0.005));
        engine.idle=0;
      });
    const move=Gesture.Pan().runOnJS(true).minPointers(2)
      .onStart(()=>{engine.startPanX=engine.panX;engine.startPanZ=engine.panZ;engine.idle=0;})
      .onUpdate(e=>{
        const sc=0.020*(engine.baseR+engine.dolly)/21;
        const fx=Math.sin(engine.rotY),fz=Math.cos(engine.rotY);
        const rx=Math.cos(engine.rotY),rz=-Math.sin(engine.rotY);
        let nx=engine.startPanX-(rx*e.translationX+fx*e.translationY)*sc;
        let nz=engine.startPanZ-(rz*e.translationX+fz*e.translationY)*sc;
        const d=Math.hypot(nx,nz);
        if(d>ROAM_BOUND){nx=nx/d*ROAM_BOUND;nz=nz/d*ROAM_BOUND;}
        engine.panX=nx;engine.panZ=nz;engine.idle=0;
      });
    const pinch=Gesture.Pinch().runOnJS(true)
      .onStart(()=>{engine.startDolly=engine.dolly;engine.idle=0;})
      .onUpdate(e=>{
        engine.dolly=Math.max(engine.minR-engine.baseR,Math.min(engine.maxR-engine.baseR,engine.startDolly-(e.scale-1)*21));
        engine.idle=0;
      })
      .onEnd(e=>{
        const r=engine.baseR+engine.dolly;
        if(e.scale>1&&r<=engine.minR+0.5)engine.wantEnter=true;
      });
    const tap=Gesture.Tap().runOnJS(true).maxDistance(18)
      .onEnd((e,ok)=>{if(ok){const t=raycastAt(e.x,e.y);if(t){const h=HEROES.find(x=>x.name===t);if(h)enterHero(h);}}});
    return Gesture.Simultaneous(pinch,move,Gesture.Exclusive(tap,orbit));
  },[engine,raycastAt,enterHero]);

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x000000,1);

      const scene=new THREE.Scene();
      scene.fog=new THREE.FogExp2(0x06050b,0.028);
      const camera=new THREE.PerspectiveCamera(46,glW/glH,0.1,340);
      scene.add(new THREE.AmbientLight(0xffffff,0.7));
      const kl=new THREE.DirectionalLight(0xfff2d8,1.5);kl.position.set(9,14,7);scene.add(kl);
      const rl=new THREE.DirectionalLight(0xE8C98A,0.8);rl.position.set(-11,6,-9);scene.add(rl);
      const fl=new THREE.PointLight(0xF3E3BE,0.9,44);fl.position.set(0,7,0);scene.add(fl);

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
        if(engine.idle>3&&!engine.entering&&rNow>engine.baseR-2)engine.rotY+=dt*0.02;
        for(const sp of engine.spinners)sp.rotation.z+=dt*0.8;

        for(let i=0;i<engine.rings.length;i++){
          engine.rings[i].rotation.z+=dt*(0.35+i*0.06);
          const b=engine.beams[i];
          if(b)b.material.opacity=0.05+0.045*(0.5+0.5*Math.sin(T*1.3+i));
        }
        if(engine.grid){
          engine.grid.grid.opacity=0.08+0.05*(0.5+0.5*Math.sin(T*0.6));
        }
        if(engine.dust){
          const p=engine.dust.geometry.attributes.position;const base=engine.dust.userData.base;
          for(let i=0;i<p.count;i++)p.array[i*3+1]=base[i*3+1]+Math.sin(T*0.3+i*1.7)*0.5;
          p.needsUpdate=true;
        }

        // cars — travel their road, correct lane + heading
        for(let i=0;i<engine.cars.length;i++){
          const c=engine.cars[i];
          c.pos+=c.dir*c.speed*dt;
          if(c.pos>EXTENT)c.pos=-EXTENT;else if(c.pos<-EXTENT)c.pos=EXTENT;
          if(c.horiz){
            dummy.position.set(c.pos,0.16,c.line-c.dir*c.lane);
            dummy.rotation.set(0,c.dir>0?0:Math.PI,0);
          }else{
            dummy.position.set(c.line+c.dir*c.lane,0.16,c.pos);
            dummy.rotation.set(0,c.dir>0?-Math.PI/2:Math.PI/2,0);
          }
          dummy.scale.set(1,1,1);dummy.updateMatrix();
          engine.carMesh.setMatrixAt(i,dummy.matrix);
        }
        engine.carMesh.instanceMatrix.needsUpdate=true;

        // pedestrians — walk the sidewalks with a slight bob
        for(let i=0;i<engine.peds.length;i++){
          const p=engine.peds[i];
          p.pos+=p.dir*p.speed*dt;
          if(p.pos>EXTENT)p.pos=-EXTENT;else if(p.pos<-EXTENT)p.pos=EXTENT;
          const y=0.28+Math.abs(Math.sin(T*5+p.ph))*0.05;
          if(p.horiz)dummy.position.set(p.pos,y,p.line+p.off);
          else dummy.position.set(p.line+p.off,y,p.pos);
          dummy.rotation.set(0,0,0);dummy.scale.set(1,1,1);dummy.updateMatrix();
          engine.pedMesh.setMatrixAt(i,dummy.matrix);
        }
        engine.pedMesh.instanceMatrix.needsUpdate=true;

        // camera orbit around (panX,0,panZ)
        let r=engine.baseR+engine.dolly;
        let tx=engine.panX,tz=engine.panZ;
        if(engine.entering){
          const e=engine.entering;e.t=Math.min(1,e.t+dt/0.5);
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

        // pinch-in-to-enter the nearest lined-up landmark
        if(engine.wantEnter&&!engine.entering){
          engine.wantEnter=false;
          let best=null,bestD=1e9;
          for(const a of engine.anchors){
            tmp.copy(a.pos).applyMatrix4(engine.pivot.matrixWorld).project(engine.camera);
            if(tmp.z>1)continue;
            const sx=(tmp.x*0.5+0.5)*engine.vw,sy=(-tmp.y*0.5+0.5)*engine.vh;
            const d=Math.hypot(sx-engine.vw/2,sy-engine.vh/2);
            if(d<bestD){bestD=d;best=a;}
          }
          if(best&&bestD<Math.min(engine.vw,engine.vh)*0.4)enterHero(HEROES.find(h=>h.name===best.name));
        }

        // project anchors -> overlay labels (~8fps)
        lblAcc+=dt;
        if(lblAcc>0.12){
          lblAcc=0;
          const out=[];let near=null,nearD=1e9;
          for(const a of engine.anchors){
            tmp.copy(a.pos).applyMatrix4(engine.pivot.matrixWorld).project(engine.camera);
            const meta=HEROES.find(h=>h.name===a.name);
            const sx=(tmp.x*0.5+0.5)*engine.vw,sy=(-tmp.y*0.5+0.5)*engine.vh;
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

      {/* scanline + vignette overlay */}
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <SvgRadial id="vig" cx="50%" cy="46%" r="72%">
            <Stop offset="0" stopColor="#000000" stopOpacity="0"/>
            <Stop offset="0.62" stopColor="#000000" stopOpacity="0"/>
            <Stop offset="1" stopColor="#000000" stopOpacity="0.6"/>
          </SvgRadial>
          <Pattern id="scan" width="3" height="3" patternUnits="userSpaceOnUse">
            <Rect width="3" height="1" fill="#000000" opacity="0.14"/>
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#scan)"/>
        <Rect x="0" y="0" width="100%" height="100%" fill="url(#vig)"/>
      </Svg>

      {/* landmark labels — screen-space projected */}
      {labels.filter(l=>l.visible).map(l=>{
        const h=HEROES.find(x=>x.name===l.name);
        const isCentered=centered===l.name;
        return(
          <TouchableOpacity
            key={l.name}
            activeOpacity={0.8}
            onPress={()=>enterHero(h)}
            hitSlop={{top:18,bottom:18,left:18,right:18}}
            style={[s.marker,{left:l.x-92,top:l.y-32,borderColor:l.tint+(isCentered?'':'55')}]}
          >
            <View style={[s.markerBr,s.brTL,{borderColor:l.tint}]}/>
            <View style={[s.markerBr,s.brBR,{borderColor:l.tint}]}/>
            <Text style={[s.markerLabel,{color:l.tint}]} numberOfLines={1}>{l.label}</Text>
            <Text style={s.markerSub} numberOfLines={1}>
              {l.sub}{'   '}{l.external?'↗':(isCentered?'▸ ENTER':'⤢')}
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

      {/* title + stat line */}
      <SafeAreaView style={s.telemetry} edges={['top']} pointerEvents="none">
        <Text style={s.title}>THE EMPIRE</Text>
        <Text style={s.statLine}>V DISTRICTS · WALDORF · MD · SYSTEMS ONLINE</Text>
      </SafeAreaView>

      {/* nav hint */}
      <SafeAreaView style={s.hint} edges={['bottom']} pointerEvents="none">
        <Text style={s.hintText}>DRAG TO ROTATE · TWO FINGERS TO MOVE · PINCH TO ENTER A DISTRICT</Text>
      </SafeAreaView>

      <HudFrame pulse={pulse}/>

      {status==='loading'&&(
        <View style={s.loading} pointerEvents="none">
          <ActivityIndicator color={colors.gold}/>
          <Text style={s.loadingT}>RAISING THE CITY…</Text>
        </View>
      )}
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

  marker:{position:'absolute',width:184,alignItems:'center',backgroundColor:'rgba(4,4,7,0.6)',borderWidth:1,borderRadius:3,paddingVertical:6,paddingHorizontal:8},
  markerBr:{position:'absolute',width:9,height:9},
  brTL:{top:-1,left:-1,borderTopWidth:1.5,borderLeftWidth:1.5},
  brBR:{bottom:-1,right:-1,borderBottomWidth:1.5,borderRightWidth:1.5},
  markerLabel:{fontFamily:FONTS.displaySemi,fontSize:16,letterSpacing:1.5},
  markerSub:{fontFamily:FONTS.mono,fontSize:7,color:'#8A7E63',letterSpacing:1.5,marginTop:2},

  reticle:{position:'absolute',left:'50%',top:'50%',width:64,height:64,marginLeft:-32,marginTop:-32},
  retLine:{position:'absolute',backgroundColor:colors.gold,opacity:0.7},
  retTop:{top:0,left:31,width:2,height:14},
  retBottom:{bottom:0,left:31,width:2,height:14},
  retLeft:{left:0,top:31,width:14,height:2},
  retRight:{right:0,top:31,width:14,height:2},

  telemetry:{position:'absolute',top:0,left:0,right:0,alignItems:'center',paddingTop:8},
  title:{fontFamily:FONTS.displaySemi,fontSize:30,color:colors.gold,letterSpacing:6},
  statLine:{fontFamily:FONTS.mono,fontSize:8,color:'#8A7E63',letterSpacing:2.5,marginTop:2},

  hint:{position:'absolute',bottom:0,left:0,right:0,alignItems:'center',paddingBottom:12},
  hintText:{fontFamily:FONTS.mono,fontSize:7,color:'#4A4436',letterSpacing:2},

  loading:{...StyleSheet.absoluteFillObject,alignItems:'center',justifyContent:'center',gap:10},
  loadingT:{fontFamily:FONTS.mono,fontSize:9,color:'#6C6353',letterSpacing:3},

  fallback:{flex:1,backgroundColor:'#000',alignItems:'center',paddingTop:60,gap:10},
  fallbackTitle:{fontFamily:FONTS.displaySemi,fontSize:26,color:colors.gold,letterSpacing:6,marginBottom:4},
  fallbackMsg:{fontFamily:FONTS.mono,fontSize:9,color:'#6C6353',letterSpacing:1,marginBottom:20,textAlign:'center',paddingHorizontal:24},
  fallbackBtn:{width:'80%',borderWidth:1,borderColor:'#1F1B14',borderRadius:8,paddingVertical:16,alignItems:'center',backgroundColor:'#080706'},
  fallbackBtnT:{fontFamily:FONTS.displaySemi,fontSize:16,letterSpacing:2},
  fallbackBtnS:{fontFamily:FONTS.mono,fontSize:7,color:'#4A4436',letterSpacing:2,marginTop:3},
});
