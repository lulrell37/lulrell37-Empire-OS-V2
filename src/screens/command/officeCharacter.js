// One shared rigged body (assets/models/officeWorker.glb — see
// assets/models/LICENSE.md for provenance) cloned per persona, tinted in their
// color, with an optional face photo "plate" parented to the head bone.
//
// The model ships with 44 baked animation clips; THE OFFICE only needs a
// handful of them (see CLIP below). There's no literal "typing" or "playing a
// game" clip in the free set this was built from, so BUSY borrows the seated
// "talking" animation (the closest thing to "visibly doing something at the
// desk") and IDLE is the plain seated-idle loop — a deliberate, documented
// substitution rather than a missing feature.
import*as THREE from 'three';
import{GLTFLoader}from 'three/examples/jsm/loaders/GLTFLoader';
import{clone as cloneSkeleton}from 'three/examples/jsm/utils/SkeletonUtils';
import{Asset}from 'expo-asset';
import*as FileSystem from 'expo-file-system';
import{TextureLoader}from 'expo-three';
import{b64ToArrayBuffer}from './holoMaterial';

const MODEL=require('../../../assets/models/officeWorker.glb');

export const CLIP={
  SIT_IDLE:'Armature|Sitting_Idle_Loop',
  SIT_TALK:'Armature|Sitting_Talking_Loop', // stand-in for "busy" — see file note above
  SIT_ENTER:'Armature|Sitting_Enter',
  SIT_EXIT:'Armature|Sitting_Exit',
  WALK:'Armature|Walk_Formal_Loop',
  STAND_IDLE:'Armature|Idle_Loop',
  STAND_TALK:'Armature|Idle_Talking_Loop',
};
const FADE=0.35; // crossfade seconds between steady-state moods
const WALK_SPEED=1.6; // office units/sec

// The sourced rig's own rest pose (rotation.y = 0) faces -Z, not +Z — verified
// directly from its skeleton: the left ball-of-foot bone sits at a more
// negative Z than the ankle above it (foot_l z=0.036, ball_l z=-0.113), and a
// standing figure's toes point the way it faces. Every place in this file (and
// in OfficeScene.js) that converts between "the world direction we want this
// character facing" and its actual `rotation.y` goes through this constant —
// get it wrong in only one of those places and the body, its walk direction,
// and the face-to-face camera all disagree about which way it's looking
// (exactly what happened before this was pinned down: the camera ended up
// behind the character instead of in front of it).
export const MODEL_FORWARD_OFFSET=Math.PI;
// rotation.y -> the unit vector that rotation actually points the model along,
// in world space.
export function worldForward(rotationY){
  const y=rotationY+MODEL_FORWARD_OFFSET;
  return new THREE.Vector3(Math.sin(y),0,Math.cos(y));
}
// A desired world-facing yaw (0 = toward +Z, see officeLayout.js) -> the
// rotation.y to actually assign so the model faces that way.
export function yawToRotation(yaw){return yaw+MODEL_FORWARD_OFFSET;}

// One shared mesh/skeleton — body type is a non-uniform scale on the hip/spine
// (torso) and limb bones rather than a separate model, so all three "builds"
// reuse the exact same animation clips with no retargeting.
const BODY_SCALE={
  slim:{torso:0.88,limbX:0.9,limbZ:0.9},
  average:{torso:1,limbX:1,limbZ:1},
  heavy:{torso:1.3,limbX:1.15,limbZ:1.15},
};
const TORSO_BONES=['spine_01','spine_02','spine_03'];
const LIMB_BONES=['upperarm_l','upperarm_r','thigh_l','thigh_r'];

let baseGLTF=null;
let loadingPromise=null;

// Call once (e.g. from OfficeScene's onContextCreate) before creating any
// characters. Safe to call multiple times — later calls resolve instantly.
export function preloadOfficeModel(){
  if(baseGLTF)return Promise.resolve(baseGLTF);
  if(loadingPromise)return loadingPromise;
  loadingPromise=(async()=>{
    const asset=Asset.fromModule(MODEL);
    await asset.downloadAsync();
    const b64=await FileSystem.readAsStringAsync(asset.localUri||asset.uri,{encoding:FileSystem.EncodingType.Base64});
    const gltf=await new Promise((res,rej)=>{
      new GLTFLoader().parse(b64ToArrayBuffer(b64),'',res,rej);
    });
    baseGLTF={scene:gltf.scene,animations:gltf.animations};
    return baseGLTF;
  })();
  return loadingPromise;
}

// personaPics stores a `data:image/jpeg;base64,...` string (Settings' existing
// photo picker) — expo-three's asset-based texture loader resolves a `file://`
// path cleanly but not a raw `data:` URI, so this writes it out to a small
// cache file once and hands back that path. Returns null on any failure
// (caller just falls back to the tinted placeholder head).
async function cacheDataUriToFile(personaId,dataUri){
  try{
    const m=/^data:image\/(\w+);base64,(.*)$/.exec(dataUri||'');
    if(!m)return null;
    const[,ext,b64]=m;
    const uri=FileSystem.cacheDirectory+'office_face_'+personaId+'.'+(ext==='jpeg'?'jpg':ext);
    await FileSystem.writeAsStringAsync(uri,b64,{encoding:FileSystem.EncodingType.Base64});
    return uri;
  }catch{return null;}
}

async function loadFaceTexture(personaId,dataUri){
  const uri=await cacheDataUriToFile(personaId,dataUri);
  if(!uri)return null;
  try{
    return await new Promise((res,rej)=>new TextureLoader().load(uri,res,undefined,rej));
  }catch{return null;}
}

// Creates one character. `baseGLTF` must already be loaded (preloadOfficeModel).
// Returns {group, setMood, standUp, sitDown, walkTo, update, dispose}.
export function createOfficeCharacter({persona,bodyType='average'}){
  if(!baseGLTF)throw new Error('preloadOfficeModel() must resolve before createOfficeCharacter()');
  const root=cloneSkeleton(baseGLTF.scene);

  // The base mannequin body goes a neutral skin-ish tone — persona.color now
  // lives on the jacket (below), the monitor screen, the nameplate and the
  // name label, so it reads as "a person wearing that color" rather than "a
  // person made of solid-color plastic." Joint caps stay a soft neutral too.
  const tint=new THREE.Color(persona.color||'#E8C98A');
  const skinTone=new THREE.Color(0xC9AE8C);
  const jointTone=new THREE.Color(0x8a8478);
  root.traverse(o=>{
    if(!o.isMesh||!o.material)return;
    const mats=(Array.isArray(o.material)?o.material:[o.material]).map(m=>{
      const c=m.clone();
      c.color=(m.name==='M_Joints')?jointTone.clone():skinTone.clone();
      return c;
    });
    o.material=Array.isArray(o.material)?mats:mats[0];
  });

  // Body type — scale specific bone groups so slim/average/heavy reads as a
  // build difference on the one shared skeleton.
  const bs=BODY_SCALE[bodyType]||BODY_SCALE.average;
  TORSO_BONES.forEach(n=>{const b=root.getObjectByName(n);if(b)b.scale.setScalar(bs.torso);});
  LIMB_BONES.forEach(n=>{const b=root.getObjectByName(n);if(b)b.scale.set(bs.limbX,1,bs.limbZ);});

  // Anything parented to a bone lives in this rig's bone-local space, which
  // is exactly 100x smaller than the world-scale everything else here is
  // authored in — verified directly: a 0.08-unit box parented to the Head
  // bone measured 8 world units across (nearly the size of the whole body).
  // That ratio comes straight from the "Armature" node's own scale (100,100,
  // 100) sitting above every bone. Divide any size/offset meant for a bone
  // child by BONE_LOCAL_SCALE so it actually reads at the intended real-world
  // size instead of dwarfing the character it's attached to.
  const BONE_LOCAL_SCALE=100;
  const bl=(worldUnits)=>worldUnits/BONE_LOCAL_SCALE;

  // Hair — a small dark cap parented to the head bone, so the silhouette
  // reads as a person instead of a bald peg doll.
  const headBone=root.getObjectByName('Head');
  if(headBone){
    const hair=new THREE.Mesh(
      new THREE.SphereGeometry(bl(0.11),10,8,0,Math.PI*2,0,Math.PI*0.58),
      new THREE.MeshStandardMaterial({color:0x2a2018,roughness:0.75}),
    );
    hair.position.set(0,bl(0.04),0);
    headBone.add(hair);
  }

  // Jacket — a torso block tinted in persona.color, parented to the mid-spine
  // bone so it moves with the body and follows every animation. This (plus
  // the monitor screen, nameplate, and name label) is where persona.color
  // actually shows up now that the base body is a neutral tone.
  const torsoBone=root.getObjectByName('spine_02');
  if(torsoBone){
    const jacket=new THREE.Mesh(
      new THREE.BoxGeometry(bl(0.34),bl(0.42),bl(0.22)),
      new THREE.MeshStandardMaterial({color:tint,roughness:0.55}),
    );
    jacket.position.set(0,bl(0.03),bl(0.01));
    torsoBone.add(jacket);
  }

  // Face "plate" — a small photo card parented to the head bone, not a UV
  // texture wrap (this mesh has no dedicated head UV island to wrap onto).
  // Sits toward -Z, the model's own verified rest-pose forward (see
  // MODEL_FORWARD_OFFSET above) — i.e. in front of the face, not behind the
  // skull. Its texture is filled in async by setFaceTexture() once the
  // Settings photo (if any) has loaded; until then it's simply invisible.
  let facePlate=null;
  if(headBone){
    const geo=new THREE.PlaneGeometry(bl(0.44),bl(0.44));
    const mat=new THREE.MeshBasicMaterial({transparent:true,opacity:0,depthWrite:false});
    facePlate=new THREE.Mesh(geo,mat);
    facePlate.position.set(0,bl(0.06),-bl(0.2));
    facePlate.rotation.y=Math.PI; // plane's default normal faces +Z; flip to face outward with the head
    headBone.add(facePlate);
  }

  const mixer=new THREE.AnimationMixer(root);
  const actionFor=(name)=>{
    const clip=THREE.AnimationClip.findByName(baseGLTF.animations,name);
    return clip?mixer.clipAction(clip):null;
  };
  const actions={};
  Object.entries(CLIP).forEach(([k,name])=>{actions[k]=actionFor(name);});
  let current=null;
  function crossTo(action,{loop=true,fade=FADE}={}){
    if(!action||current===action)return action;
    action.reset();
    action.setLoop(loop?THREE.LoopRepeat:THREE.LoopOnce,loop?Infinity:1);
    action.clampWhenFinished=!loop;
    action.fadeIn(fade).play();
    if(current)current.fadeOut(fade);
    current=action;
    return action;
  }

  const state={mood:'idle',walk:null,oneShotActive:false};

  // Steady moods, driven by CommandScreen's busy/relay signals.
  function setMood(mood){
    if(state.walk||state.oneShotActive)return; // a walk/stand-sit transition owns the animation right now
    state.mood=mood;
    if(mood==='busy')crossTo(actions.SIT_TALK);
    else if(mood==='standIdle')crossTo(actions.STAND_IDLE);
    else if(mood==='talk')crossTo(actions.STAND_TALK);
    else crossTo(actions.SIT_IDLE);
  }

  // One-shot transition — locks out setMood (state.oneShotActive) so the
  // per-frame busy/idle sync in OfficeScene can't stomp it mid-play, and calls
  // back when the (non-looping) clip finishes (three.js's own mixer 'finished'
  // event, filtered to this action).
  function playOnce(action,cb){
    const a=crossTo(action,{loop:false});
    if(!a){cb&&cb();return;}
    state.oneShotActive=true;
    const onFinished=(e)=>{
      if(e.action!==a)return;
      mixer.removeEventListener('finished',onFinished);
      state.oneShotActive=false;
      cb&&cb();
    };
    mixer.addEventListener('finished',onFinished);
  }

  function standUp(cb){playOnce(actions.SIT_EXIT,()=>{crossTo(actions.STAND_IDLE);cb&&cb();});}
  function sitDown(cb){playOnce(actions.SIT_ENTER,()=>{setMood('idle');cb&&cb();});}

  // Walk the character (already standing) to a world-local target on the
  // office floor; calls back on arrival. update() below advances the position.
  // Also locks out setMood, same as a one-shot — state.walk already gates it,
  // this is just belt-and-braces since walk is cleared a tick before onDone
  // fires in update().
  function walkTo(target,cb){
    crossTo(actions.WALK);
    state.walk={target:target.clone(),onDone:cb};
  }
  function isTransitioning(){return!!(state.walk||state.oneShotActive);}

  function update(dt){
    mixer.update(dt);
    if(state.walk){
      const{target,onDone}=state.walk;
      const to=new THREE.Vector3(target.x,root.position.y,target.z);
      const d=to.clone().sub(root.position);
      const dist=d.length();
      if(dist<0.05){
        root.position.copy(to);
        state.walk=null;
        onDone&&onDone();
      }else{
        d.normalize();
        root.position.addScaledVector(d,Math.min(dist,WALK_SPEED*dt));
        root.rotation.y=yawToRotation(Math.atan2(d.x,d.z));
      }
    }
  }

  function setFaceTexture(tex){
    if(!facePlate||!tex)return;
    facePlate.material.map=tex;
    facePlate.material.opacity=1;
    facePlate.material.needsUpdate=true;
  }

  function dispose(){
    mixer.stopAllAction();
    root.traverse(o=>{
      if(o.geometry?.dispose)o.geometry.dispose();
      if(o.material){
        const mats=Array.isArray(o.material)?o.material:[o.material];
        mats.forEach(m=>{if(m.map?.dispose)m.map.dispose();m.dispose?.();});
      }
    });
  }

  setMood('idle');
  return{group:root,setMood,standUp,sitDown,walkTo,update,setFaceTexture,isTransitioning,dispose,userData:{personaId:persona.id}};
}

export{loadFaceTexture};
