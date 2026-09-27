// THE OFFICE's static room geometry — floor, ceiling, walls, windows,
// cubicles, and everyone's desk, each dressed for that persona's actual job
// (see ROLE_THEME below) rather than 25 identical desks in different colors.
// Pure three.js + officeLayout data, no React/RN/GL imports at all, so this
// same module renders both inside OfficeScene.js and in the dev-only preview
// script (scripts/previewOffice.js) used to check this without a device.
import*as THREE from 'three';
import{mergeGeometries}from 'three/examples/jsm/utils/BufferGeometryUtils';
import{getPersona}from '../../personas/personas';
import{desksForFloor,ROOM}from './officeLayout';

export const CEIL_H=4.4;
export const DESK_W=1.5,DESK_D=0.85,DESK_TOP_H=0.05,DESK_LEG_H=0.72;

function mat(color,opts={}){
  return new THREE.MeshStandardMaterial({color:new THREE.Color(color),metalness:0.1,roughness:0.6,...opts});
}
function glow(color,intensity=1.4){
  return new THREE.MeshStandardMaterial({color:new THREE.Color(color),emissive:new THREE.Color(color),emissiveIntensity:intensity,roughness:0.4,toneMapped:false});
}
function glassMat(color,opacity=0.35){
  return new THREE.MeshStandardMaterial({color:new THREE.Color(color),transparent:true,opacity,roughness:0.15,metalness:0.05,side:THREE.DoubleSide});
}
// box geometry, pre-translated (and optionally pre-rotated) so pieces can be
// merged into one draw call — same trick EmpireCityScreen.js uses.
function box(w,h,d,x,y,z,ry){
  const g=new THREE.BoxGeometry(w,h,d);
  if(ry)g.rotateY(ry);
  g.translate(x,y,z);
  return g;
}
function cyl(rt,rb,h,x,y,z,segs){
  return new THREE.CylinderGeometry(rt,rb,h,segs||8).translate(x,y,z);
}
// rotate a desk-local offset (lx along the desk's own width axis, lz along its
// own depth axis) into world X/Z by that desk's facing yaw.
function local(d,lx,lz){
  return{x:d.x+lx*Math.cos(d.facing)-lz*Math.sin(d.facing),z:d.z+lx*Math.sin(d.facing)+lz*Math.cos(d.facing)};
}

const CARPET=0x39424c, CARPET_LINE=0x2a3138;
const WALL=0x817a6c, TRIM=0x2c2620;
const DESKTOP=0x8a6a48, CHAIR=0x2a2a2e;
const CEIL=0x8b8476, CEIL_GRID=0x6d6759;
const WINDOW_GLOW=0xBFE3F0, CEIL_LIGHT=0xFFF3D6, CEIL_LIGHT_BOSS=0xFFE6A8;
const CLUTTER=0x1f2124, PAPER=0xd8d2c2;

// ---------------------------------------------------------------------
// Role themes — a small kit of extra props per desk, keyed off persona.role.
// Everyone still sits at the same desk/chair/monitor (so the room reads as
// one real office, not a prop shop), but what's ON the desk — and one
// signature piece behind/beside it — comes from what they actually do.
// ---------------------------------------------------------------------
const THEME_BY_ID={
  ara:'exec',
  jarvis:'engineer',
  selene:'creative',scribe:'creative',hook:'creative',rogue:'creative',
  stephanie:'academic',sage:'academic',pen:'academic',
  wire:'news',
  scout:'outreach',andrew:'outreach',
  nova:'analytics',pulse:'analytics',
  atlas:'finance',talon:'finance',
  haven:'wellness',
  aisha:'legal',
  abraham:'faith',
  batman:'tactical',
  muse1:'vanity',muse2:'vanity',muse3:'vanity',
  forge:'production',herald:'production',
};
function themeFor(id){return THEME_BY_ID[id]||'generic';}

// Each builder gets the desk record (x,z,facing,scale) and the desktop's
// world height (deskY, i.e. where things sit on top of it), and returns
// {geos:[{key,geometry}], extras:[Mesh]} — `geos` are collected into shared,
// per-theme merged meshes (cheap, since most of a theme's kit is one color);
// `extras` are one-off meshes (e.g. anything glowing in the persona's color).
function themeProps(theme,d,deskY,persona){
  const geos=[],extras=[];
  const push=(key,g)=>geos.push({key,geometry:g});
  const P=(lx,lz)=>local(d,lx,lz);
  const s=d.scale;

  if(theme==='exec'){ // A.R.A. — clean, put-together, nothing cluttered
    let p=P(0.5,-0.15);push('lampBase',cyl(0.05*s,0.06*s,0.35*s,p.x,deskY+0.17*s,p.z,8));
    push('lampArm',box(0.03,0.35,0.03,p.x,deskY+0.5*s,p.z));
    const shade=new THREE.Mesh(new THREE.ConeGeometry(0.09*s,0.14*s,10),glow(0xFFE6A8,0.9));
    shade.position.set(p.x,deskY+0.62*s,p.z);extras.push(shade);
    p=P(-0.35,-0.05);push('tray',box(0.28*s,0.02*s,0.2*s,p.x,deskY+0.02*s,p.z,d.facing));
  }else if(theme==='engineer'){ // J.A.R.V.I.S. — tools, a rolled blueprint
    let p=P(0.5,-0.1);
    const roll=new THREE.CylinderGeometry(0.045*s,0.045*s,0.36*s,10);
    roll.rotateZ(Math.PI/2); // lying on its side, like a rolled-up blueprint
    roll.translate(p.x,deskY+0.045*s,p.z);
    push('blueprint',roll);
    p=P(-0.4,-0.15);push('wrenchA',box(0.22*s,0.02*s,0.04*s,p.x,deskY+0.02*s,p.z,d.facing+0.5));
    push('wrenchB',box(0.22*s,0.02*s,0.04*s,p.x,deskY+0.03*s,p.z,d.facing-0.5));
    const gear=new THREE.Mesh(new THREE.TorusGeometry(0.09*s,0.025*s,6,10),mat(0x9a9a9a,{metalness:0.6,roughness:0.35}));
    p=P(0.15,-0.28);gear.position.set(p.x,deskY+0.1*s,p.z);gear.rotation.x=Math.PI/2;extras.push(gear);
  }else if(theme==='creative'){ // Selene/Scribe/Hook/Rogue — mood board + camera
    let p=P(0,-dep(d)-0.03);
    const board=new THREE.Mesh(new THREE.BoxGeometry(0.62*s,0.42*s,0.02*s),mat(0xEDE6D6));
    board.position.set(p.x,deskY+0.5*s,p.z);board.rotation.y=d.facing;extras.push(board);
    const swatches=[0xEC4899,0xF59E0B,0x14B8A6,0x8E7CC3];
    for(let i=0;i<4;i++){
      const sw=new THREE.Mesh(new THREE.PlaneGeometry(0.11*s,0.09*s),glow(swatches[i],0.6));
      const lx=-0.22+ (i%2)*0.24, lz=0.09-Math.floor(i/2)*0.2;
      const q=local({x:p.x,z:p.z,facing:d.facing},lx,0);
      sw.position.set(q.x,deskY+0.5*s+lz,p.z+0.011);sw.rotation.y=d.facing;
      extras.push(sw);
    }
    p=P(0.5,-0.1);push('cameraBody',box(0.12*s,0.09*s,0.09*s,p.x,deskY+0.06*s,p.z,d.facing));
  }else if(theme==='academic'){ // Stephanie/Sage/Pen — a stack of books
    let p=P(0.45,-0.12);
    const cols=[0x6C8EBF,0xB05A5A,0x4A9E7A];
    for(let i=0;i<3;i++){
      const b=new THREE.Mesh(new THREE.BoxGeometry(0.3*s,0.045*s,0.22*s),mat(cols[i]));
      b.position.set(p.x,deskY+0.045*s*(i+0.5),p.z);b.rotation.y=d.facing+i*0.08;
      extras.push(b);
    }
  }else if(theme==='news'){ // W.I.R.E. — a second monitor + a small antenna
    let p=P(-0.55,-0.32);
    const m2=new THREE.Mesh(new THREE.BoxGeometry(0.4*s,0.26*s,0.025*s),mat(TRIM));
    m2.position.set(p.x,deskY+0.28*s,p.z);m2.rotation.y=d.facing+0.28;extras.push(m2);
    const scr2=new THREE.Mesh(new THREE.PlaneGeometry(0.34*s,0.2*s),glow(0xC75B4A,1.1));
    scr2.position.set(p.x+Math.sin(d.facing+0.28)*0.014,deskY+0.28*s,p.z+Math.cos(d.facing+0.28)*0.014);
    scr2.rotation.y=d.facing+0.28;extras.push(scr2);
  }else if(theme==='outreach'){ // Scout/Andrew — headset + a pipeline board
    let p=P(0.45,0.05);
    const band=new THREE.Mesh(new THREE.TorusGeometry(0.09*s,0.014*s,6,16,Math.PI),mat(0x2a2a2e));
    band.position.set(p.x,deskY+0.12*s,p.z);band.rotation.z=Math.PI;extras.push(band);
    p=P(0,-dep(d)-0.03);
    const board=new THREE.Mesh(new THREE.BoxGeometry(0.5*s,0.36*s,0.02*s),mat(0x24211a));
    board.position.set(p.x,deskY+0.46*s,p.z);board.rotation.y=d.facing;extras.push(board);
    const stages=[0x2E86FF,0x4A9E7A,0xE8C98A];
    for(let i=0;i<3;i++){
      const bar=new THREE.Mesh(new THREE.PlaneGeometry(0.4*s,0.05*s),glow(stages[i],0.5));
      const yy=0.46*s+0.14-0.1*i;
      bar.position.set(p.x,deskY+yy,p.z+0.011);bar.rotation.y=d.facing;extras.push(bar);
    }
  }else if(theme==='analytics'){ // Nova/Pulse — a small chart panel standing up
    let p=P(0.5,-0.1);
    const panel=new THREE.Mesh(new THREE.PlaneGeometry(0.34*s,0.24*s),glow(0x8FB7C9,0.9));
    panel.position.set(p.x,deskY+0.24*s,p.z);panel.rotation.y=d.facing;extras.push(panel);
    push('panelFrame',box(0.36*s,0.26*s,0.015*s,p.x,deskY+0.24*s,p.z,d.facing));
  }else if(theme==='finance'){ // Atlas/Talon — dual monitors + a coin stack
    let p=P(-0.55,-0.32);
    const m2=new THREE.Mesh(new THREE.BoxGeometry(0.4*s,0.26*s,0.025*s),mat(TRIM));
    m2.position.set(p.x,deskY+0.28*s,p.z);m2.rotation.y=d.facing-0.28;extras.push(m2);
    const scr2=new THREE.Mesh(new THREE.PlaneGeometry(0.34*s,0.2*s),glow(0x17C08B,1.1));
    scr2.position.set(p.x+Math.sin(d.facing-0.28)*0.014,deskY+0.28*s,p.z+Math.cos(d.facing-0.28)*0.014);
    scr2.rotation.y=d.facing-0.28;extras.push(scr2);
    p=P(0.5,-0.1);
    for(let i=0;i<4;i++)push('coin',cyl(0.05*s,0.05*s,0.018*s,p.x,deskY+0.009*s+0.018*s*i,p.z,10));
  }else if(theme==='wellness'){ // Haven — a plant + a first-aid accent
    let p=P(0.5,-0.15);
    push('potWell',cyl(0.07*s,0.06*s,0.09*s,p.x,deskY+0.045*s,p.z,8));
    const leaf=new THREE.Mesh(new THREE.ConeGeometry(0.1*s,0.24*s,7),mat(0x3f6b45,{roughness:0.8}));
    leaf.position.set(p.x,deskY+0.2*s,p.z);extras.push(leaf);
    p=P(-0.15,-0.31);
    push('crossA',box(0.14*s,0.03*s,0.015,p.x,deskY+0.28*s,p.z,d.facing));
    push('crossB',box(0.03*s,0.14*s,0.015,p.x,deskY+0.28*s,p.z,d.facing));
  }else if(theme==='legal'){ // Aisha — a stack of law books + a gavel
    let p=P(0.45,-0.12);
    for(let i=0;i<4;i++)push('lawbook',box(0.26*s,0.035*s,0.19*s,p.x,deskY+0.035*s*(i+0.5),p.z,d.facing+(i%2?0.06:-0.05)));
    p=P(-0.4,-0.1);
    push('gavelHead',cyl(0.035*s,0.035*s,0.13*s,p.x,deskY+0.065*s,p.z,8));
    push('gavelHandle',box(0.02*s,0.18*s,0.02*s,p.x,deskY+0.02*s,p.z));
  }else if(theme==='faith'){ // Abraham — an open book + a candle
    let p=P(0.4,-0.1);
    push('bookOpen',box(0.28*s,0.03*s,0.2*s,p.x,deskY+0.03*s,p.z,d.facing));
    p=P(-0.35,-0.12);
    push('candle',cyl(0.03*s,0.035*s,0.16*s,p.x,deskY+0.08*s,p.z,8));
    const flame=new THREE.Mesh(new THREE.ConeGeometry(0.02*s,0.05*s,6),glow(0xFFB86A,1.6));
    flame.position.set(p.x,deskY+0.185*s,p.z);extras.push(flame);
  }else if(theme==='tactical'){ // Batman — a dark tactical map panel
    let p=P(0,-dep(d)-0.03);
    const panel=new THREE.Mesh(new THREE.BoxGeometry(0.6*s,0.4*s,0.02*s),mat(0x111114));
    panel.position.set(p.x,deskY+0.48*s,p.z);panel.rotation.y=d.facing;extras.push(panel);
    const dot=new THREE.Mesh(new THREE.PlaneGeometry(0.5*s,0.32*s),glow(0x4A4A8A,0.7));
    dot.position.set(p.x+Math.sin(d.facing)*0.011,deskY+0.48*s,p.z+Math.cos(d.facing)*0.011);
    dot.rotation.y=d.facing;extras.push(dot);
  }else if(theme==='vanity'){ // MUSE pages — a ring light + a phone-on-stand
    let p=P(0.45,-0.15);
    const ring=new THREE.Mesh(new THREE.TorusGeometry(0.11*s,0.012*s,6,20),glow(0xFFF3D6,0.7));
    ring.position.set(p.x,deskY+0.22*s,p.z);extras.push(ring);
    push('ringStand',cyl(0.012*s,0.012*s,0.22*s,p.x,deskY+0.11*s,p.z,6));
    p=P(-0.35,-0.1);push('phone',box(0.06*s,0.13*s,0.012*s,p.x,deskY+0.075*s,p.z,d.facing));
  }else if(theme==='production'){ // Forge/Herald — an output tray stack
    let p=P(0.45,-0.12);
    for(let i=0;i<3;i++)push('tray',box(0.28*s,0.03*s,0.2*s,p.x,deskY+0.03*s*(i+0.5)+0.01*i,p.z,d.facing));
  }else{ // generic — keyboard/mouse/mug/papers, everyone gets at least this
    let p=P(0,0.02);push('kb',box(0.32*s,0.015*s,0.12*s,p.x,deskY+0.008*s,p.z,d.facing));
    p=P(0.24,0.02);push('mouse',box(0.05*s,0.02*s,0.08*s,p.x,deskY+0.01*s,p.z,d.facing));
  }

  // Everyone gets a mug in their own color, small — cheap, universal, and one
  // more spot of that persona's identity on the desk besides the monitor glow.
  const mp=P(-0.5,-0.05);
  const mug=new THREE.Mesh(new THREE.CylinderGeometry(0.035*s,0.03*s,0.07*s,10),mat(persona.color));
  mug.position.set(mp.x,deskY+0.035*s,mp.z);extras.push(mug);

  return{geos,extras};
}
function dep(d){return DESK_D*d.scale*0.5;}

// ---------------------------------------------------------------------
// Static room geometry for one floor.
// ---------------------------------------------------------------------
export function buildRoom(floor){
  const g=new THREE.Group();
  const desks=desksForFloor(floor);
  const midZ=(ROOM.frontZ+ROOM.backZ)/2, spanZ=ROOM.frontZ-ROOM.backZ;

  // --- floor: base + tile grout lines ---
  const baseFloor=new THREE.Mesh(new THREE.PlaneGeometry(ROOM.halfW*2,spanZ),mat(CARPET,{roughness:0.95}));
  baseFloor.rotation.x=-Math.PI/2;baseFloor.position.set(0,0,midZ); // mutate in place — reassigning .rotation breaks its quaternion sync
  g.add(baseFloor);
  const floorLineGeos=[];
  for(let x=-ROOM.halfW;x<=ROOM.halfW;x+=1.5)floorLineGeos.push(box(0.02,0.005,spanZ,x,0.003,midZ));
  for(let z=ROOM.backZ;z<=ROOM.frontZ;z+=1.5)floorLineGeos.push(box(ROOM.halfW*2,0.005,0.02,0,0.003,z));
  g.add(new THREE.Mesh(mergeGeometries(floorLineGeos),mat(CARPET_LINE)));

  // --- ceiling: base + a subtle tile grid + recessed light panels ---
  const ceilMesh=new THREE.Mesh(new THREE.PlaneGeometry(ROOM.halfW*2,spanZ),mat(CEIL,{roughness:0.9}));
  ceilMesh.rotation.x=Math.PI/2;ceilMesh.position.set(0,CEIL_H,midZ);
  g.add(ceilMesh);
  const ceilLineGeos=[];
  for(let x=-ROOM.halfW;x<=ROOM.halfW;x+=2)ceilLineGeos.push(box(0.02,0.005,spanZ,x,CEIL_H-0.003,midZ));
  for(let z=ROOM.backZ;z<=ROOM.frontZ;z+=2)ceilLineGeos.push(box(ROOM.halfW*2,0.005,0.02,0,CEIL_H-0.003,z));
  g.add(new THREE.Mesh(mergeGeometries(ceilLineGeos),mat(CEIL_GRID)));
  const beamGeos=[];
  for(let z=ROOM.backZ+3;z<ROOM.frontZ-2;z+=6)beamGeos.push(box(ROOM.halfW*2,0.16,0.3,0,CEIL_H-0.1,z));
  g.add(new THREE.Mesh(mergeGeometries(beamGeos),mat(TRIM)));

  const araDesk=desks.find(d=>d.id==='ara');
  const lightGeos=[],bossLightGeos=[];
  for(let z=ROOM.backZ+2;z<ROOM.frontZ-1;z+=3.4)
    for(const x of[-ROOM.halfW*0.5,0,ROOM.halfW*0.5]){
      const overAra=araDesk&&Math.abs(x-araDesk.x)<2&&Math.abs(z-araDesk.z)<2;
      (overAra?bossLightGeos:lightGeos).push(box(overAra?1.8:1.3,0.06,overAra?0.9:0.6,x,CEIL_H-0.05,z));
    }
  g.add(new THREE.Mesh(mergeGeometries(lightGeos),glow(CEIL_LIGHT,1.1)));
  if(bossLightGeos.length)g.add(new THREE.Mesh(mergeGeometries(bossLightGeos),glow(CEIL_LIGHT_BOSS,1.6)));

  // --- walls + trim ---
  g.add(new THREE.Mesh(mergeGeometries([
    box(ROOM.halfW*2,CEIL_H,0.15,0,CEIL_H/2,ROOM.backZ),
    box(0.15,CEIL_H,spanZ,-ROOM.halfW,CEIL_H/2,midZ),
    box(0.15,CEIL_H,spanZ,ROOM.halfW,CEIL_H/2,midZ),
  ]),mat(WALL)));
  g.add(new THREE.Mesh(mergeGeometries([
    box(ROOM.halfW*2,0.14,0.2,0,0.07,ROOM.backZ+0.08),
    box(0.2,0.14,spanZ,-ROOM.halfW+0.08,0.07,midZ),
    box(0.2,0.14,spanZ,ROOM.halfW-0.08,0.07,midZ),
    box(ROOM.halfW*2,0.1,0.2,0,CEIL_H-0.05,ROOM.backZ+0.08), // cornice
  ]),mat(TRIM)));

  // --- windows along the back wall, with mullion dividers (real multi-pane
  // glass, not one glowing rectangle) ---
  const frameGeos=[],winGeos=[],mullionGeos=[];
  for(let x=-ROOM.halfW+2.4;x<=ROOM.halfW-2.4;x+=3.0){
    frameGeos.push(box(2.3,2.5,0.08,x,2.4,ROOM.backZ+0.07));
    winGeos.push(box(2.1,2.3,0.05,x,2.4,ROOM.backZ+0.09));
    mullionGeos.push(box(2.1,0.05,0.06,x,2.4,ROOM.backZ+0.1));      // horizontal bar
    mullionGeos.push(box(2.1,0.05,0.06,x,1.75,ROOM.backZ+0.1));
    mullionGeos.push(box(2.1,0.05,0.06,x,3.05,ROOM.backZ+0.1));
    mullionGeos.push(box(0.05,2.3,0.06,x-0.52,2.4,ROOM.backZ+0.1)); // vertical bars
    mullionGeos.push(box(0.05,2.3,0.06,x+0.52,2.4,ROOM.backZ+0.1));
  }
  g.add(new THREE.Mesh(mergeGeometries(frameGeos),mat(TRIM)));
  g.add(new THREE.Mesh(mergeGeometries(winGeos),glow(WINDOW_GLOW,0.8)));
  g.add(new THREE.Mesh(mergeGeometries(mullionGeos),mat(TRIM)));

  // --- a reception counter near the entrance (+Z), purely a "this is a real
  // lobby" anchor, not tied to any persona ---
  g.add(new THREE.Mesh(mergeGeometries([
    box(3.4,0.95,0.6,0,0.475,ROOM.frontZ-1.2),
    box(3.6,0.08,0.7,0,0.97,ROOM.frontZ-1.2),
  ]),mat(0x4a4038,{roughness:0.5})));
  g.add(new THREE.Mesh(new THREE.PlaneGeometry(2.6,0.6),glow(0xE8C98A,0.5)).translateY(0.6).translateZ(ROOM.frontZ-1.2+0.31));

  // --- framed wall art, evenly spaced along the side walls ---
  const artColors=[0x6C8EBF,0xB05A5A,0x4A9E7A,0xE4572E];
  const spots=[];
  for(const side of[-1,1])
    for(let z=ROOM.backZ+4;z<ROOM.frontZ-3;z+=5)
      spots.push({side,z});
  if(spots.length){
    g.add(new THREE.Mesh(mergeGeometries(spots.map(({side,z})=>box(0.02,0.6,0.44,side*(ROOM.halfW-0.08),2.4,z))),mat(TRIM)));
    spots.forEach(({side,z},i)=>{
      const m=new THREE.Mesh(new THREE.PlaneGeometry(0.44,0.6),mat(artColors[i%artColors.length],{roughness:0.8}));
      m.position.set(side*(ROOM.halfW-0.091),2.4,z);
      m.rotation.y=side>0?-Math.PI/2:Math.PI/2;
      g.add(m);
    });
  }

  // --- cubicle divider panels between neighboring desks — real structure,
  // not open floor ---
  const dividerGeos=[];
  for(let i=0;i<desks.length;i++){
    for(let j=i+1;j<desks.length;j++){
      const a=desks[i],b=desks[j];
      if(Math.abs(a.z-b.z)>0.3)continue; // only same-row neighbors
      const dx=Math.abs(a.x-b.x);
      if(dx>4.4||dx<1.2)continue;
      const mx=(a.x+b.x)/2;
      dividerGeos.push(box(0.05,1.05,DESK_D*Math.max(a.scale,b.scale)*1.3,mx,0.7,(a.z+b.z)/2));
    }
  }
  if(dividerGeos.length)g.add(new THREE.Mesh(mergeGeometries(dividerGeos),glassMat(0x9fb0bd,0.3)));

  // --- desks: shared desktop/legs/chair, per-desk monitor + role props ---
  const deskWorld={};
  const topGeos=[],legGeos=[],chairGeos=[],clutterByTheme={};
  desks.forEach(d=>{
    const w=DESK_W*d.scale,depth=DESK_D*d.scale,legH=DESK_LEG_H*d.scale;
    const cz=d.z+depth*0.55;
    topGeos.push(box(w,DESK_TOP_H,depth,d.x,legH,cz,d.facing));
    for(const sx of[-w*0.42,w*0.42])for(const sz of[-depth*0.35,depth*0.35]){
      const lx=d.x+sx*Math.cos(d.facing)-sz*Math.sin(d.facing);
      const lz=cz+sx*Math.sin(d.facing)+sz*Math.cos(d.facing);
      legGeos.push(box(0.06,legH,0.06,lx,legH/2,lz));
    }
    const chz=d.z-0.55*d.scale;
    chairGeos.push(box(0.42*d.scale,0.42*d.scale,0.42*d.scale,d.x,0.21*d.scale,chz,d.facing));
    chairGeos.push(box(0.4*d.scale,0.55*d.scale,0.06,d.x-0.2*d.scale*Math.sin(d.facing),0.55*d.scale,chz-0.2*d.scale*Math.cos(d.facing),d.facing));

    // monitor — bezel + a screen glowing in this persona's own color
    const persona=getPersona(d.id);
    const monY=legH+0.22*d.scale;
    const monOff=-depth*0.32;
    const monX=d.x+Math.sin(d.facing)*monOff, monZ=cz+Math.cos(d.facing)*monOff;
    const bezel=new THREE.Mesh(new THREE.BoxGeometry(0.5*d.scale,0.32*d.scale,0.03),mat(TRIM));
    bezel.position.set(monX,monY,monZ);bezel.rotation.y=d.facing;g.add(bezel);
    const screen=new THREE.Mesh(new THREE.PlaneGeometry(0.42*d.scale,0.25*d.scale),glow(persona.color,1.3));
    screen.position.set(monX+Math.sin(d.facing)*0.017,monY,monZ+Math.cos(d.facing)*0.017);
    screen.rotation.y=d.facing;g.add(screen);

    // a nameplate on the desk's front edge — a physical, always-visible cue
    // in the same color as the label overlay and the monitor glow
    const npz=cz+depth*0.42;
    const np=new THREE.Mesh(new THREE.BoxGeometry(0.34*d.scale,0.06*d.scale,0.05*d.scale),mat(persona.color,{roughness:0.4}));
    np.position.set(d.x,legH+0.03*d.scale,npz);np.rotation.y=d.facing;g.add(np);

    // role-specific desk props
    const theme=themeFor(d.id);
    const{geos,extras}=themeProps(theme,d,legH,persona);
    extras.forEach(m=>g.add(m));
    if(geos.length){
      clutterByTheme[theme]=clutterByTheme[theme]||[];
      geos.forEach(({geometry})=>clutterByTheme[theme].push(geometry));
    }

    // invisible tap-catcher for the raycaster
    const catcher=new THREE.Mesh(new THREE.CylinderGeometry(1.1*d.scale,1.1*d.scale,2.2,10),
      new THREE.MeshBasicMaterial({visible:false}));
    catcher.position.set(d.x,1.1,d.z);
    catcher.userData.personaTarget=d.id;
    g.add(catcher);
    deskWorld[d.id]=new THREE.Vector3(d.x,0,d.z);
  });
  g.add(new THREE.Mesh(mergeGeometries(topGeos),mat(DESKTOP,{roughness:0.5})));
  g.add(new THREE.Mesh(mergeGeometries(legGeos),mat(TRIM)));
  g.add(new THREE.Mesh(mergeGeometries(chairGeos),mat(CHAIR)));
  Object.entries(clutterByTheme).forEach(([theme,geos])=>{
    if(geos.length)g.add(new THREE.Mesh(mergeGeometries(geos),mat(theme==='legal'||theme==='academic'?0xEDE6D6:CLUTTER)));
  });

  // --- a few potted plants along the window wall ---
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
