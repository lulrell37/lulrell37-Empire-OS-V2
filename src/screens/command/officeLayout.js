// Desk layout data for THE OFFICE — pure data, no rendering. Kept separate from
// OfficeScene.js so "who sits where" can be adjusted without touching any
// three.js code.
//
// Coordinates are office-local units (floor plane X/Z, Y=0 is the floor).
// `facing` is a yaw in radians: 0 = facing toward +Z, the room's "front" —
// where the overview camera sits and where the entrance/elevator lives — so
// a desk-tap's face-to-face camera arrives already looking at the character
// head-on instead of walking around to their back. `scale` multiplies the
// desk + character size — only A.R.A.'s is boosted.
import{PERSONA_LIST}from '../../personas/personas';

// Floor 1 — the main desk: everyone Mr. Burrus talks to day-to-day. A.R.A. sits
// front-and-centre with the biggest desk; the rest fan out behind her in two
// rows.
export const FLOOR1_IDS=['ara','jarvis','selene','stephanie','atlas','haven','rogue','aisha'];
// Floor 2 — everyone else (specialists, page ops, reports-to chains).
export const FLOOR2_IDS=PERSONA_LIST.map(p=>p.id).filter(id=>!FLOOR1_IDS.includes(id));

function row(ids,z,gap){
  const n=ids.length;
  const startX=-(gap*(n-1))/2;
  return ids.map((id,i)=>({id,x:startX+i*gap,z,facing:0,scale:1}));
}

function floor1Desks(){
  const desks=[{id:'ara',x:0,z:5,facing:0,scale:1.6}];
  desks.push(...row(['jarvis','selene','stephanie','atlas'],1,4));
  desks.push(...row(['haven','rogue','aisha'],-4,4.5));
  return desks;
}

function floor2Desks(){
  const rows=[
    ['scribe','hook','sage','wire','scout'],
    ['nova','pulse','talon','abraham','batman'],
    ['andrew','pen','muse1','muse2','muse3'],
    ['forge','herald'],
  ];
  const zs=[5,1,-3,-7];
  const desks=[];
  rows.forEach((ids,i)=>desks.push(...row(ids,zs[i],4)));
  return desks;
}

// { floor: 1|2 } -> [{id,x,z,facing,scale}]
const LAYOUT={1:floor1Desks(),2:floor2Desks()};
export function desksForFloor(floor){return LAYOUT[floor]||[];}
export function floorForPersona(id){return FLOOR1_IDS.includes(id)?1:2;}
export function deskFor(id){
  const floor=floorForPersona(id);
  const desk=desksForFloor(floor).find(d=>d.id===id);
  return desk?{...desk,floor}:null;
}

// Room bounds per floor, used to size the floor/walls and clamp the camera pan.
export const ROOM={halfW:11,frontZ:8,backZ:-9};
