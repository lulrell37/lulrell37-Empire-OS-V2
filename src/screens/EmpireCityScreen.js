// THE EMPIRE — a holographic Roman city that is the app's home / hub.
//
//   1 finger  drag ....... move through the city (pan across the ground)
//   2 fingers drag ....... orbit / rotate the city
//   pinch ................ zoom (out far enough to see the whole city); zoom
//                          right into a landmark to open its screen
//   mouse wheel .......... zoom (Samsung DeX / any attached mouse)
//   tap a landmark ....... fly in and open it
//
// Built on an actual Roman grid plan: the Cardo (N–S) and Decumanus (E–W)
// avenues cross at a colonnaded forum (stepped plaza, central monument, four
// triumphal arches), with a full grid of lesser streets forming insula blocks.
// ~110 buildings fill the subdivided blocks — window-grid facades with
// floor ledges, pilaster strips, rooftop clutter (tanks, penthouses) and one of
// four roof styles; hedged courtyard gardens sit on the odd plot. The forum adds
// a market-stall ring and four plaza statues; four fountains mark the district
// squares. Four detailed landmarks ring the forum, plus the tarellbempire.com
// beacon on the east gate. A crenellated (merloned) perimeter wall with gate
// towers and brazier glows rings the city, an aqueduct runs the west approach,
// cypress rows and streetlights line the avenues, ~30 cars run in-lane and ~46
// pedestrians walk the sidewalks.
//
// Rendered procedurally with three.js primitives + the shared holo material
// (src/screens/command/holoMaterial.js), front-face-only here (cityMat) since
// the whole city is closed geometry seen from outside — half the fragment cost
// of the double-sided default the Laboratory needs for its clipped-open views.
// Static mass (roads, pavement, the whole building stock, the wall, the aqueduct)
// is merged and trees / lights / traffic
// are instanced, so the city still draws in a couple dozen calls; landmarks are
// individual groups. Labels are screen-space projected RN <Text> (see the
// animate loop -> setLabels). No bundled model — ships as an OTA update.
import React,{useRef,useState,useCallback,useMemo,useEffect}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Dimensions,ActivityIndicator,Platform,ScrollView}from 'react-native';
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
import{colors,FONTS}from '../theme';
import{makeHoloUniforms,createHoloMaterial,disposeObject}from './command/holoMaterial';

// The whole city is closed geometry always seen from outside and above — front
// faces only, half the fragment cost of the Laboratory's default double-sided
// material, with no visible difference at this camera range.
function cityMat(uniforms,opts={}){return createHoloMaterial(uniforms,{...opts,doubleSide:false});}

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
// Appends a window-grid facade to `facade`, and every bit of trim (base band,
// cornice, floor ledges, pilaster strips, rooftop clutter, roof cap) to `trim`.
// Everything is merge-ready geometry.
function addBuilding(cx,cz,cellW,cellD,rnd,facade,trim){
  const w=Math.max(1.5,Math.min(cellW-1.2,2.0+rnd()*2.4));
  const d=Math.max(1.5,Math.min(cellD-1.2,2.0+rnd()*2.4));
  const tall=rnd()>0.8;
  const h=tall?(9+rnd()*8):(2.6+rnd()*rnd()*7.2);

  facade.push(box(w,h,d,cx,h/2,cz));
  trim.push(box(w+0.5,0.9,d+0.5,cx,0.45,cz));        // lobby / base band
  trim.push(box(w+0.3,0.28,d+0.3,cx,h-0.14,cz));     // cornice ledge

  // horizontal floor ledges up the facade
  const floors=Math.min(4,Math.max(0,Math.floor(h/2.4)-1));
  for(let f=1;f<=floors;f++){
    trim.push(box(w+0.12,0.06,d+0.12,cx,(h*f)/(floors+1),cz));
  }
  // vertical pilaster strips on the front / back faces of taller blocks
  if(h>6){
    const n=Math.max(2,Math.round(w/1.1));
    for(let p=0;p<n;p++){
      const px=cx-w/2+(w/(n-1))*p;
      trim.push(box(0.12,h-0.7,0.1,px,h/2,cz+d/2+0.02));
      trim.push(box(0.12,h-0.7,0.1,px,h/2,cz-d/2-0.02));
    }
  }

  // rooftop clutter
  trim.push(box(0.55+rnd()*0.5,0.5,0.55+rnd()*0.5,cx+(rnd()-0.5)*w*0.5,h+0.3,cz+(rnd()-0.5)*d*0.5));
  if(rnd()>0.5)trim.push(box(0.4,0.35,0.9,cx+(rnd()-0.5)*w*0.4,h+0.22,cz+(rnd()-0.5)*d*0.4));
  if(tall)trim.push(box(0.06,1.6+rnd()*1.4,0.06,cx+w*0.3,h+1.0,cz-d*0.3)); // antenna mast
  if(rnd()>0.55){                                    // rooftop water tank on a stand
    trim.push(box(0.55,0.4,0.55,cx-w*0.18,h+0.24,cz+d*0.16));
    const tank=new THREE.CylinderGeometry(0.34,0.34,0.72,8);
    tank.translate(cx-w*0.18,h+0.78,cz+d*0.16);
    trim.push(tank);
  }
  if(rnd()>0.72){                                    // rooftop stair penthouse
    trim.push(box(0.9,0.9,0.9,cx+w*0.22,h+0.45,cz-d*0.18));
  }

  // roof cap — four styles
  const roll=rnd();
  if(roll<0.32){                                     // pediment cone
    const c=new THREE.ConeGeometry(Math.min(w,d)*0.52,1.7,4);
    c.rotateY(Math.PI/4);c.translate(cx,h+0.85,cz);
    trim.push(c);
  }else if(roll<0.58){                               // stepped ziggurat cap
    trim.push(box(w*0.72,0.45,d*0.72,cx,h+0.22,cz));
    trim.push(box(w*0.46,0.45,d*0.46,cx,h+0.66,cz));
    trim.push(box(w*0.22,0.55,d*0.22,cx,h+1.15,cz));
  }else if(roll<0.82){                               // colonnade cap
    for(let k=0;k<8;k++){
      const a=(k/8)*Math.PI*2;
      const col=new THREE.CylinderGeometry(0.07,0.07,1.0,6);
      col.translate(cx+Math.cos(a)*w*0.4,h+0.5,cz+Math.sin(a)*d*0.4);
      trim.push(col);
    }
    trim.push(box(w*0.9,0.2,d*0.9,cx,h+1.05,cz));
  }else{                                             // flat roof: parapet + penthouse
    trim.push(box(w+0.2,0.4,0.12,cx,h+0.2,cz+d/2));
    trim.push(box(w+0.2,0.4,0.12,cx,h+0.2,cz-d/2));
    trim.push(box(0.12,0.4,d+0.2,cx+w/2,h+0.2,cz));
    trim.push(box(0.12,0.4,d+0.2,cx-w/2,h+0.2,cz));
    trim.push(box(w*0.4,1.0,d*0.4,cx-w*0.1,h+0.5,cz+d*0.1));
  }
}

// --- one landmark -------------------------------------------------------
// Returns { group, beam } — beam pulses; orbs tagged userData.spin are spun by
// the animate loop.
function buildHero(hero,uniforms){
  const hmat=cityMat(uniforms,{tint:hero.tint,windows:true,opacity:0.5});
  const emat=cityMat(uniforms,{tint:hero.tint,opacity:0.9});
  const g=new THREE.Group();
  g.position.set(hero.at[0],0,hero.at[1]);
  g.name=hero.name;
  const put=(geo,mat,x,y,z)=>{
    const m=new THREE.Mesh(geo,mat||hmat);
    m.position.set(x,y,z);
    g.add(m);return m;
  };
  const merged=(geos,mat)=>{const m=new THREE.Mesh(mergeGeometries(geos),mat||hmat);g.add(m);return m;};

  // stepped stylobate — three shallow rings up to the platform
  put(new THREE.CylinderGeometry(4.4,4.6,0.25,52),emat,0,0.12,0);
  put(new THREE.CylinderGeometry(4.0,4.2,0.25,52),emat,0,0.36,0);
  put(new THREE.CylinderGeometry(3.6,3.8,0.25,52),emat,0,0.60,0);

  if(hero.shape==='rotunda'){                       // HUD — colonnade ring under a dome
    put(new THREE.CylinderGeometry(3.3,3.5,0.4,44),emat,0,0.85,0);
    const cols=[];
    for(let i=0;i<24;i++){
      const a=(i/24)*Math.PI*2;
      const c=new THREE.CylinderGeometry(0.13,0.13,3.2,8);
      c.translate(Math.cos(a)*2.9,2.55,Math.sin(a)*2.9);
      cols.push(c);
      // capital + base blocks
      cols.push(box(0.34,0.2,0.34,Math.cos(a)*2.9,4.2,Math.sin(a)*2.9));
      cols.push(box(0.34,0.2,0.34,Math.cos(a)*2.9,0.95,Math.sin(a)*2.9));
    }
    merged(cols,hmat);
    const frieze=put(new THREE.TorusGeometry(2.95,0.18,8,40),emat,0,4.45,0);frieze.rotation.x=Math.PI/2;
    put(new THREE.CylinderGeometry(2.7,2.9,0.6,40),hmat,0,4.9,0);          // drum
    put(new THREE.SphereGeometry(2.65,36,18,0,Math.PI*2,0,Math.PI/2),hmat,0,5.2,0);
    const oc=put(new THREE.TorusGeometry(0.6,0.1,8,24),emat,0,7.9,0);oc.rotation.x=Math.PI/2;
    put(new THREE.ConeGeometry(0.24,0.9,10),emat,0,8.5,0);                 // finial

  }else if(hero.shape==='towers'){                  // COUNCIL — twin colonnaded towers + lit chamber
    const towerParts=[];
    for(const sx of[-2.8,2.8]){
      towerParts.push(box(2.4,8.6,2.4,sx,4.3,0));
      towerParts.push(box(2.9,0.5,2.9,sx,0.95,0));   // plinth
      towerParts.push(box(2.8,0.4,2.8,sx,8.7,0));    // tower cornice
      for(const fz of[-0.85,-0.28,0.28,0.85]){
        const c=new THREE.CylinderGeometry(0.14,0.14,6.6,8);
        c.translate(sx+fz,3.6,1.4);
        towerParts.push(c);
      }
    }
    merged(towerParts,hmat);
    put(box(8.6,0.8,2.8,0,0,0),emat,0,8.6,0);        // lintel
    put(box(9.2,0.5,3.1,0,0,0),emat,0,9.15,0);       // entablature cap
    put(box(7.4,0.7,2.4,0,0,0),hmat,0,9.7,0);        // attic block
    // warm glass boardroom chamber, visible from outside
    const glass=new THREE.Mesh(
      box(3.4,3.5,2.3,0,0,0),
      new THREE.MeshBasicMaterial({color:0xFFC98A,transparent:true,opacity:0.28,depthWrite:false,side:THREE.DoubleSide,blending:THREE.AdditiveBlending}),
    );
    glass.position.set(0,4.8,0);g.add(glass);
    put(new THREE.CylinderGeometry(1.0,1.0,0.12,20),emat,0,3.75,0);        // table
    const chairs=[];
    for(let i=0;i<8;i++){
      const a=(i/8)*Math.PI*2;
      chairs.push(box(0.3,0.6,0.3,Math.cos(a)*1.45,3.55,Math.sin(a)*1.45));
    }
    merged(chairs,emat);
    // guardian statues flanking the steps
    for(const sx of[-1.6,1.6]){
      put(box(0.6,0.4,0.6,sx,0.9,3.4),emat);
      put(new THREE.CylinderGeometry(0.16,0.22,1.5,8),hmat,sx,1.85,3.4);
      put(new THREE.SphereGeometry(0.22,10,8),hmat,sx,2.75,3.4);
    }

  }else if(hero.shape==='observatory'){             // LABORATORY — orb on a tapered plinth + ring
    put(new THREE.CylinderGeometry(1.6,2.4,1.4,10),hmat,0,1.5,0);
    put(new THREE.CylinderGeometry(1.05,1.4,4.6,8),hmat,0,4.4,0);          // tapered plinth
    // support struts under the orb
    const struts=[];
    for(let i=0;i<4;i++){
      const a=(i/4)*Math.PI*2+Math.PI/4;
      const st=new THREE.CylinderGeometry(0.09,0.09,2.0,6);
      st.rotateZ(0.5);st.translate(Math.cos(a)*1.0,6.6,Math.sin(a)*1.0);
      struts.push(st);
    }
    merged(struts,hmat);
    put(new THREE.TorusGeometry(1.35,0.08,8,28),emat,0,6.9,0).rotation.x=Math.PI/2; // railing
    const orb=put(new THREE.IcosahedronGeometry(1.95,2),emat,0,8.0,0);orb.userData.spin=1;
    const rg=new THREE.Mesh(new THREE.TorusGeometry(2.75,0.06,8,44),emat);
    rg.position.y=8.0;rg.rotation.x=1.15;rg.userData.spin=1;
    g.add(rg);

  }else if(hero.shape==='ziggurat'){                // SETTINGS — stepped ziggurat
    const steps=[[5.6,1.3],[4.6,1.2],[3.6,1.1],[2.6,1.0],[1.6,0.9]];
    let y=0.75;
    for(let i=0;i<steps.length;i++){
      const[sw,sh]=steps[i];
      put(box(sw,sh,sw,0,0,0),i===steps.length-1?emat:hmat,0,y+sh/2,0);
      y+=sh;
    }
    // front stair + shrine with tiny columns
    const stair=[];
    for(let s=0;s<5;s++)stair.push(box(1.3,0.32*(s+1),0.5,0,0.16*(s+1),2.9-s*0.5));
    merged(stair,emat);
    put(box(1.3,1.0,1.3,0,y+0.5,0),emat);
    for(const sx of[-0.45,0.45])for(const sz of[-0.45,0.45])
      put(new THREE.CylinderGeometry(0.08,0.08,0.9,6),hmat,sx,y+0.95,sz);
    put(box(1.5,0.2,1.5,0,y+1.5,0),emat);
    // corner obelisks
    for(const sx of[-2.6,2.6])for(const sz of[-2.6,2.6])
      put(new THREE.CylinderGeometry(0.06,0.28,3.2,4),hmat,sx,1.6,sz).rotation.y=Math.PI/4;

  }else{                                            // MONUMENT — tarellbempire.com beacon
    put(box(2.6,0.6,2.6,0,0,0),hmat,0,1.05,0);
    put(box(1.7,7.2,1.7,0,0,0),hmat,0,4.7,0);
    // fluting
    const flute=[];
    for(let i=0;i<4;i++){
      const a=(i/4)*Math.PI*2;
      flute.push(box(0.1,7.0,0.1,Math.cos(a)*0.9,4.7,Math.sin(a)*0.9));
    }
    merged(flute,hmat);
    put(box(2.7,0.6,2.7,0,0,0),emat,0,8.4,0);
    put(new THREE.TorusGeometry(1.0,0.12,8,24),emat,0,8.9,0).rotation.x=Math.PI/2; // laurel
    const orb=put(new THREE.IcosahedronGeometry(1.2,1),emat,0,10.1,0);orb.userData.spin=1;
  }

  // vertical light beam
  const beam=new THREE.Mesh(
    new THREE.CylinderGeometry(0.5,1.5,26,16,1,true),
    new THREE.MeshBasicMaterial({color:hero.tint,transparent:true,opacity:0.06,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending}),
  );
  beam.position.y=13;
  beam.raycast=()=>{};   // the big soft beam is not a tap target
  g.add(beam);

  g.traverse(o=>{if(o.isMesh)o.userData.heroTarget=hero.name;});
  return{group:g,beam};
}

// Build the whole city.
function buildCity(uniforms){
  const pivot=new THREE.Group();
  const rnd=mulberry32(20260904);
  const matRoad=cityMat(uniforms,{opacity:0.24});
  const matPave=cityMat(uniforms,{opacity:0.12});
  const matStripe=cityMat(uniforms,{tint:0xF3E3BE,opacity:0.7});
  const matBld=cityMat(uniforms,{windows:true,opacity:0.34});
  const matTrim=cityMat(uniforms,{opacity:0.4});
  const matWall=cityMat(uniforms,{opacity:0.3});
  const matTree=cityMat(uniforms,{tint:0x9FC79A,opacity:0.38});
  const matGlow=cityMat(uniforms,{tint:0xF3E3BE,opacity:0.55});
  const matWater=new THREE.MeshBasicMaterial({color:0x8FD8E6,transparent:true,opacity:0.32,depthWrite:false,blending:THREE.AdditiveBlending});

  pivot.add(buildSky());
  const grid=buildGrid();pivot.add(grid);
  // a warm, low, faintly-lit ground so the city has a floor without a black void
  const ground=new THREE.Mesh(new THREE.CircleGeometry(CITY_R+8,72),new THREE.MeshBasicMaterial({color:0x140f07,transparent:true,opacity:0.5}));
  ground.rotation.x=-Math.PI/2;ground.position.y=-0.06;
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
  // zebra crosswalks where the avenues approach the forum
  for(const[ox,oz,horiz]of[[0,6.4,true],[0,-6.4,true],[6.4,0,false],[-6.4,0,false]]){
    for(let b=-3;b<=3;b++){
      if(horiz)stripeGeos.push(box(0.26,0.02,AV_HW*1.7,ox+b*0.6,0.062,oz));
      else stripeGeos.push(box(AV_HW*1.7,0.02,0.26,ox,0.062,oz+b*0.6));
    }
  }
  pivot.add(new THREE.Mesh(mergeGeometries(stripeGeos),matStripe));

  // --- forum: stepped plaza, colonnade + architrave, central monument, arches
  const plazaMat=cityMat(uniforms,{opacity:0.5});
  pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(5.0,5.0,0.12,56),plazaMat).translateY(0.09));
  pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(5.7,5.9,0.12,56),plazaMat).translateY(0.05));
  pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(6.4,6.6,0.12,56),plazaMat).translateY(0.02));
  const cols=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.13,0.13,2.8,8),matTrim,56);
  const dm=new THREE.Object3D();
  for(let i=0;i<56;i++){
    const a=(i/56)*Math.PI*2;
    dm.position.set(Math.cos(a)*5.6,1.45,Math.sin(a)*5.6);dm.updateMatrix();
    cols.setMatrixAt(i,dm.matrix);
  }
  pivot.add(cols);
  const architrave=new THREE.Mesh(new THREE.TorusGeometry(5.6,0.14,8,64),matTrim);
  architrave.rotation.x=Math.PI/2;architrave.position.y=2.95;
  pivot.add(architrave);
  // central monument — column + a slowly turning finial
  const monMat=cityMat(uniforms,{opacity:0.55});
  pivot.add(new THREE.Mesh(box(1.6,0.6,1.6,0,0.3,0),monMat));
  pivot.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5,0.6,6.4,10),monMat).translateY(3.7));
  pivot.add(new THREE.Mesh(box(1.3,0.4,1.3,0,7.1,0),monMat));
  const finial=new THREE.Mesh(new THREE.IcosahedronGeometry(0.7,1),monMat);
  finial.position.y=7.9;finial.userData.spin=1;
  pivot.add(finial);
  // triumphal arches straddling the Cardo & Decumanus at the forum edge
  const archGeos=[];
  for(const[ax,az,horiz]of[[0,7.4,true],[0,-7.4,true],[7.4,0,false],[-7.4,0,false]]){
    const halfGap=AV_HW+0.4;
    if(horiz){
      archGeos.push(box(0.7,4.6,1.2,ax-halfGap,2.3,az));
      archGeos.push(box(0.7,4.6,1.2,ax+halfGap,2.3,az));
      archGeos.push(box(halfGap*2+1.4,1.0,1.4,ax,5.1,az));
      archGeos.push(box(halfGap*2+1.8,0.5,1.6,ax,5.85,az));
    }else{
      archGeos.push(box(1.2,4.6,0.7,ax,2.3,az-halfGap));
      archGeos.push(box(1.2,4.6,0.7,ax,2.3,az+halfGap));
      archGeos.push(box(1.4,1.0,halfGap*2+1.4,ax,5.1,az));
      archGeos.push(box(1.6,0.5,halfGap*2+1.8,ax,5.85,az));
    }
  }
  pivot.add(new THREE.Mesh(mergeGeometries(archGeos),matTrim));

  // --- forum market stalls, ringed just inside the colonnade ---
  const stallGeos=[];
  for(let i=0;i<10;i++){
    const a=(i/10)*Math.PI*2+0.31;
    const sx=Math.cos(a)*4.35,sz=Math.sin(a)*4.35;
    const px=Math.cos(a+Math.PI/2),pz=Math.sin(a+Math.PI/2);
    stallGeos.push(
      box(1.2,0.95,0.8,sx,0.48,sz,-a),                 // counter
      box(1.5,0.09,1.05,sx,1.55,sz,-a),                // awning
      box(0.07,1.05,0.07,sx+px*0.55,1.0,sz+pz*0.55),   // posts
      box(0.07,1.05,0.07,sx-px*0.55,1.0,sz-pz*0.55),
    );
  }
  pivot.add(new THREE.Mesh(mergeGeometries(stallGeos),matGlow));

  // --- four statues on the plaza, at the inter-cardinal points ---
  const statBase=[],statTop=[];
  for(let i=0;i<4;i++){
    const a=Math.PI/4+i*Math.PI/2;
    const x=Math.cos(a)*3.5,z=Math.sin(a)*3.5;
    statBase.push(box(0.85,0.9,0.85,x,0.45,z),box(1.05,0.22,1.05,x,0.98,z));
    const torso=new THREE.CylinderGeometry(0.22,0.32,1.4,8);torso.translate(x,1.75,z);statBase.push(torso);
    const head=new THREE.SphereGeometry(0.24,10,8);head.translate(x,2.62,z);statTop.push(head);
  }
  pivot.add(new THREE.Mesh(mergeGeometries(statBase),matTrim));
  pivot.add(new THREE.Mesh(mergeGeometries(statTop),matGlow));

  // --- pavement slabs + the building stock, block by block ---
  const nearHero=(x,z,r)=>HEROES.some(h=>Math.hypot(x-h.at[0],z-h.at[1])<r);
  const FOUNTAINS=[[21,21],[-21,21],[21,-21],[-21,-21]];
  const nearFountain=(x,z,r)=>FOUNTAINS.some(([fx,fz])=>Math.hypot(x-fx,z-fz)<r);
  const slabGeos=[],facadeGeos=[],trimGeos=[],hedgeGeos=[],gardenPts=[];
  for(let i=0;i<LINES.length-1;i++){
    for(let j=0;j<LINES.length-1;j++){
      const x0=LINES[i],x1=LINES[i+1],z0=LINES[j],z1=LINES[j+1];
      const insL=x0===0?3.0:1.7,insR=x1===0?3.0:1.7;
      const insD=z0===0?3.0:1.7,insU=z1===0?3.0:1.7;
      const bx0=x0+insL,bx1=x1-insR,bz0=z0+insD,bz1=z1-insU;
      const bw=bx1-bx0,bd=bz1-bz0;
      if(bw<1.5||bd<1.5)continue;
      const cx=(bx0+bx1)/2,cz=(bz0+bz1)/2;
      if(Math.hypot(cx,cz)<6.6)continue;            // forum
      if(nearHero(cx,cz,7.2))continue;              // landmark lots
      slabGeos.push(box(bw+1.3,0.05,bd+1.3,cx,0.035,cz));
      // subdivide the block into a small grid of plots — denser than before
      const nx=bw>13?3:bw>7?2:1;
      const nz=bd>13?3:bd>7?2:1;
      const pw=bw/nx,pd=bd/nz;
      for(let a=0;a<nx;a++){
        for(let b=0;b<nz;b++){
          const px=bx0+pw*(a+0.5),pz=bz0+pd*(b+0.5);
          if(nearFountain(px,pz,3.6))continue;          // keep the fountain square clear
          if((nx>1||nz>1)&&rnd()<0.15){                 // hedged courtyard garden in place of a plot
            hedgeGeos.push(
              box(pw*0.66,0.5,0.12,px,0.25,pz+pd*0.3),box(pw*0.66,0.5,0.12,px,0.25,pz-pd*0.3),
              box(0.12,0.5,pd*0.66,px+pw*0.3,0.25,pz),box(0.12,0.5,pd*0.66,px-pw*0.3,0.25,pz),
            );
            gardenPts.push([px,pz]);
            continue;
          }
          if((nx>1||nz>1)&&rnd()<0.09)continue;         // the odd empty lot
          addBuilding(px,pz,pw,pd,rnd,facadeGeos,trimGeos);
        }
      }
    }
  }
  pivot.add(new THREE.Mesh(mergeGeometries(slabGeos),matPave));
  const facadeGeo=mergeGeometries(facadeGeos);
  pivot.add(new THREE.Mesh(facadeGeo,matBld));
  pivot.add(new THREE.Mesh(mergeGeometries(trimGeos),matTrim));
  if(hedgeGeos.length)pivot.add(new THREE.Mesh(mergeGeometries(hedgeGeos),matTree));
  if(gardenPts.length){
    const gt=[];
    for(const[gx,gz]of gardenPts){const c=new THREE.ConeGeometry(0.55,2.1,6);c.translate(gx,1.05,gz);gt.push(c);}
    pivot.add(new THREE.Mesh(mergeGeometries(gt),matTree));
  }
  pivot.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(facadeGeo,24),
    new THREE.LineBasicMaterial({color:0xF3E3BE,transparent:true,opacity:0.2,depthWrite:false}),
  ));

  // --- perimeter wall + gate towers (merged) ---
  const WR=EXTENT+1.6,GAP=AV_HW+1.6,WH=3.2;
  const wallGeos=[];
  const wallRun=(x0,z0,x1,z1)=>{
    const len=Math.hypot(x1-x0,z1-z0);
    const n=Math.max(1,Math.ceil(len/3.2));
    const ang=Math.atan2(z1-z0,x1-x0);
    for(let s=0;s<n;s++){
      const t=(s+0.5)/n;
      wallGeos.push(box(len/n,WH,0.7,x0+(x1-x0)*t,WH/2,z0+(z1-z0)*t,-ang));
      wallGeos.push(box(len/n,0.5,0.95,x0+(x1-x0)*t,WH+0.2,z0+(z1-z0)*t,-ang)); // walkway cap
      if(s%2===0)wallGeos.push(box(len/n*0.5,0.55,0.4,x0+(x1-x0)*t,WH+0.72,z0+(z1-z0)*t,-ang)); // merlon
    }
  };
  for(const zf of[WR,-WR]){wallRun(-WR,zf,-GAP,zf);wallRun(GAP,zf,WR,zf);}
  for(const xf of[WR,-WR]){wallRun(xf,-WR,xf,-GAP);wallRun(xf,GAP,xf,WR);}
  for(const zf of[WR,-WR])for(const xf of[GAP,-GAP,WR,-WR])wallGeos.push(box(1.7,5.6,1.7,xf,2.8,zf));
  for(const xf of[WR,-WR])for(const zf of[GAP,-GAP])wallGeos.push(box(1.7,5.6,1.7,xf,2.8,zf));
  pivot.add(new THREE.Mesh(mergeGeometries(wallGeos),matWall));

  // --- aqueduct running the west approach (merged) ---
  const aqGeos=[],AX=-(WR+3.4);
  for(let z=-16;z<=16;z+=4){
    aqGeos.push(box(1.0,6.8,1.3,AX,3.4,z));                 // pier
    if(z<16){
      aqGeos.push(box(1.0,0.8,4.0,AX,4.4,z+2));             // lower arcade band
      aqGeos.push(box(0.5,1.4,1.0,AX,5.4,z+1));aqGeos.push(box(0.5,1.4,1.0,AX,5.4,z+3));
    }
  }
  aqGeos.push(box(1.1,1.0,36,AX,7.1,0));                    // water channel
  pivot.add(new THREE.Mesh(mergeGeometries(aqGeos),matWall));

  // --- fountains at the four district squares (merged stone + glowing water) ---
  const fountainStone=[];
  for(const[fx,fz]of FOUNTAINS){
    const r1=new THREE.CylinderGeometry(2.1,2.35,0.55,26);r1.translate(fx,0.28,fz);
    const r2=new THREE.CylinderGeometry(1.1,1.3,0.5,18);r2.translate(fx,0.8,fz);
    const st=new THREE.CylinderGeometry(0.16,0.26,1.6,10);st.translate(fx,1.5,fz);
    fountainStone.push(r1,r2,st);
    for(let k=0;k<8;k++){const a=k/8*Math.PI*2;fountainStone.push(box(0.34,0.34,0.34,fx+Math.cos(a)*2.25,0.62,fz+Math.sin(a)*2.25));}
    const w1=new THREE.Mesh(new THREE.CircleGeometry(1.95,22),matWater);w1.rotation.x=-Math.PI/2;w1.position.set(fx,0.52,fz);pivot.add(w1);
    const w2=new THREE.Mesh(new THREE.CircleGeometry(1.0,16),matWater);w2.rotation.x=-Math.PI/2;w2.position.set(fx,1.02,fz);pivot.add(w2);
    const drop=new THREE.Mesh(new THREE.IcosahedronGeometry(0.34,1),cityMat(uniforms,{tint:0x9AD3E0,opacity:0.9}));
    drop.position.set(fx,2.5,fz);drop.userData.spin=1;pivot.add(drop);
  }
  pivot.add(new THREE.Mesh(mergeGeometries(fountainStone),matTrim));

  // --- brazier glows atop the gate towers (instanced) ---
  const brazPos=[[GAP,WR],[-GAP,WR],[GAP,-WR],[-GAP,-WR],[WR,GAP],[WR,-GAP],[-WR,GAP],[-WR,-GAP]];
  const brazMesh=new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.24,8,6),
    new THREE.MeshBasicMaterial({color:0xFFB86A,transparent:true,opacity:0.85,depthWrite:false,blending:THREE.AdditiveBlending}),
    brazPos.length,
  );
  brazMesh.frustumCulled=false;
  brazPos.forEach(([x,z],i)=>{dm.position.set(x,6.0,z);dm.rotation.set(0,0,0);dm.scale.set(1,1,1);dm.updateMatrix();brazMesh.setMatrixAt(i,dm.matrix);});
  pivot.add(brazMesh);

  // --- landmarks ---
  const anchors=[],beams=[];
  for(const hero of HEROES){
    const{group,beam}=buildHero(hero,uniforms);
    pivot.add(group);
    beams.push(beam);
    anchors.push({name:hero.name,pos:new THREE.Vector3(hero.at[0],hero.ly,hero.at[1])});
  }

  // --- cypress trees along the avenues + ringing the forum (instanced) ---
  const treePos=[];
  for(let t=-EXTENT+4;t<=EXTENT-4;t+=3.0){
    if(Math.abs(t)<7)continue;
    treePos.push([AV_HW+1.0,t],[-(AV_HW+1.0),t],[t,AV_HW+1.0],[t,-(AV_HW+1.0)]);
  }
  for(let i=0;i<18;i++){const a=(i/18)*Math.PI*2;treePos.push([Math.cos(a)*7.4,Math.sin(a)*7.4]);}
  const trees=treePos.filter(([x,z])=>!nearHero(x,z,5)&&Math.hypot(x,z)>6);
  const treeMesh=new THREE.InstancedMesh(new THREE.ConeGeometry(0.5,2.6,6),matTree,trees.length);
  treeMesh.frustumCulled=false;
  trees.forEach(([x,z],i)=>{dm.position.set(x,1.3,z);dm.rotation.set(0,0,0);dm.scale.set(1,0.8+((i*37)%50)/50*0.8,1);dm.updateMatrix();treeMesh.setMatrixAt(i,dm.matrix);});
  pivot.add(treeMesh);

  // --- streetlights down the avenues (post + glowing lamp, instanced) ---
  const lampPos=[];
  for(let t=-EXTENT+6;t<=EXTENT-6;t+=5.2){
    if(Math.abs(t)<6)continue;
    lampPos.push([AV_HW+0.4,t],[-(AV_HW+0.4),t],[t,AV_HW+0.4],[t,-(AV_HW+0.4)]);
  }
  const postMesh=new THREE.InstancedMesh(new THREE.CylinderGeometry(0.05,0.06,2.6,5),matTrim,lampPos.length);
  postMesh.frustumCulled=false;
  const lampMesh=new THREE.InstancedMesh(new THREE.SphereGeometry(0.13,8,6),
    new THREE.MeshBasicMaterial({color:0xFFE7B8,transparent:true,opacity:0.9,depthWrite:false,blending:THREE.AdditiveBlending}),lampPos.length);
  lampMesh.frustumCulled=false;
  lampPos.forEach(([x,z],i)=>{
    dm.rotation.set(0,0,0);dm.scale.set(1,1,1);
    dm.position.set(x,1.3,z);dm.updateMatrix();postMesh.setMatrixAt(i,dm.matrix);
    dm.position.set(x,2.7,z);dm.updateMatrix();lampMesh.setMatrixAt(i,dm.matrix);
  });
  pivot.add(postMesh);pivot.add(lampMesh);

  // --- traffic: ~22 cars, correct lane + heading, looping ---
  const cars=[];
  const carMesh=new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.8,0.16,0.34),
    new THREE.MeshBasicMaterial({color:0xF7E6C0,transparent:true,opacity:0.85,depthWrite:false,blending:THREE.AdditiveBlending}),
    30,
  );
  carMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  carMesh.frustumCulled=false;
  for(let i=0;i<30;i++){
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
    46,
  );
  pedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  pedMesh.frustumCulled=false;
  for(let i=0;i<46;i++){
    const horiz=i%2===0;
    const line=ROADS[Math.floor(rnd()*ROADS.length)];
    const side=rnd()>0.5?1:-1;
    const off=(Math.abs(line)<0.001?AV_HW+0.9:ST_HW+0.8)*side;
    peds.push({horiz,line,off,dir:rnd()>0.5?1:-1,pos:(rnd()*2-1)*EXTENT,speed:0.6+rnd()*0.8,ph:rnd()*6.28});
  }
  pivot.add(pedMesh);

  const spinners=[];
  pivot.traverse(o=>{if(o.userData?.spin)spinners.push(o);});
  return{pivot,anchors,spinners,cars,carMesh,peds,pedMesh,beams,grid:grid.userData,dust};
}

function EmpireCity({navigation}){
  const[status,setStatus]=useState('loading');
  const[errMsg,setErrMsg]=useState('');
  const[labels,setLabels]=useState([]);
  const[centered,setCentered]=useState(null); // hero name nearest screen centre
  const setHudState=useEmpireStore(s=>s.setHudState);

  const engine=useRef({
    rotY:0.7,rotX:0.56,startRX:0,startRY:0,
    dolly:0,startDolly:0,baseR:21,minR:2.8,maxR:88,wantEnter:false,
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
    const orbit=Gesture.Pan().runOnJS(true).minPointers(2)
      .onStart(()=>{engine.startRX=engine.rotX;engine.startRY=engine.rotY;engine.idle=0;})
      .onUpdate(e=>{
        engine.rotY=engine.startRY-e.translationX*0.006;
        engine.rotX=Math.max(0.12,Math.min(1.4,engine.startRX-e.translationY*0.005));
        engine.idle=0;
      });
    const move=Gesture.Pan().runOnJS(true).maxPointers(1)
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
    return Gesture.Simultaneous(pinch,orbit,Gesture.Exclusive(tap,move));
  },[engine,raycastAt,enterHero]);

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x000000,1);

      const scene=new THREE.Scene();
      const camera=new THREE.PerspectiveCamera(46,glW/glH,0.1,340);
      // Point light dropped — its per-fragment distance falloff was the priciest
      // light in the scene and the fresnel/emissive glow already carries the
      // read; hemisphere nudged up a touch to keep the center from going flat.
      scene.add(new THREE.AmbientLight(0xffffff,0.92));
      scene.add(new THREE.HemisphereLight(0xF3E3BE,0x1a1206,0.62));
      const kl=new THREE.DirectionalLight(0xfff2d8,1.5);kl.position.set(9,14,7);scene.add(kl);
      const rl=new THREE.DirectionalLight(0xE8C98A,0.85);rl.position.set(-11,6,-9);scene.add(rl);

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

        for(let i=0;i<engine.beams.length;i++){
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

      {/* title */}
      <SafeAreaView style={s.telemetry} edges={['top']} pointerEvents="none">
        <Text style={s.title}>THE EMPIRE</Text>
      </SafeAreaView>

      {/* nav hint */}
      <SafeAreaView style={s.hint} edges={['bottom']} pointerEvents="none">
        <Text style={s.hintText}>DRAG TO MOVE · TWO FINGERS TO ROTATE · PINCH TO ENTER A DISTRICT</Text>
      </SafeAreaView>

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
