// The shared "hologram" look — one definition used by both the HUD Laboratory
// diagram (DiagramPanel) and the Empire city map (EmpireCityScreen), so the two
// stay visually identical: translucent gold MeshStandardMaterial with a
// Fresnel rim glow and a slow horizontal scanline injected in-shader.
//
// Also holds the small GL helpers those screens share.
import*as THREE from 'three';

// atob is provided by the RN runtime; guard just in case.
export function b64ToArrayBuffer(b64){
  const bin=(global.atob||atob)(b64);
  const len=bin.length;
  const bytes=new Uint8Array(len);
  for(let i=0;i<len;i++)bytes[i]=bin.charCodeAt(i);
  return bytes.buffer;
}

export function disposeObject(obj){
  if(!obj)return;
  obj.traverse(o=>{
    if(o.geometry?.dispose)o.geometry.dispose();
    if(o.material){
      const mats=Array.isArray(o.material)?o.material:[o.material];
      mats.forEach(m=>{
        if(m.userData?.shared)return; // never dispose a shared material
        for(const key in m){const v=m[key];if(v&&v.isTexture&&v.dispose)v.dispose();}
        m.dispose?.();
      });
    }
  });
}

// Creates the uniform bag the holo shader needs. Pass the same object to every
// createHoloMaterial / injectHoloClip call in one scene and advance uTime each
// frame.
export function makeHoloUniforms(){
  return{
    uFocusActive:{value:0},
    uFocusCenter:{value:new THREE.Vector3()},
    uFocusRadius:{value:1},
    uTime:{value:0},
  };
}

// Injects the "isolate a tapped region" clip into ANY material's shader:
// discards fragments outside a world-space sphere when uFocusActive is on.
export function injectHoloClip(shader,uniforms){
  shader.uniforms.uFocusActive=uniforms.uFocusActive;
  shader.uniforms.uFocusCenter=uniforms.uFocusCenter;
  shader.uniforms.uFocusRadius=uniforms.uFocusRadius;
  shader.vertexShader=shader.vertexShader
    .replace('#include <common>','#include <common>\nvarying vec3 vFocusWP;')
    .replace('#include <begin_vertex>','#include <begin_vertex>\nvFocusWP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  shader.fragmentShader=shader.fragmentShader
    .replace('#include <common>','#include <common>\nuniform float uFocusActive;\nuniform vec3 uFocusCenter;\nuniform float uFocusRadius;\nvarying vec3 vFocusWP;')
    .replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif (uFocusActive > 0.5 && distance(vFocusWP, uFocusCenter) > uFocusRadius) discard;');
}

// The gold hologram material. `tint` lets a caller (e.g. a persona-coloured
// building) shift the base colour while keeping the same glow behaviour.
// `windows:true` etches a procedural lit-window grid into the emissive channel,
// using object-local position — for the city's buildings.
// `doubleSide:false` renders only front faces — half the fragment work on
// closed, always-viewed-from-outside geometry (the city). Defaults to true so
// the Laboratory's clip-and-look-inside behavior (DiagramPanel) is unaffected.
export function createHoloMaterial(uniforms,{tint=0xE8C98A,opacity=0.42,emissive=0x5a4423,windows=false,doubleSide=true}={}){
  const mat=new THREE.MeshStandardMaterial({
    color:new THREE.Color(tint),
    emissive:new THREE.Color(emissive),
    emissiveIntensity:0.55,metalness:0.25,roughness:0.4,
    transparent:true,opacity,side:doubleSide?THREE.DoubleSide:THREE.FrontSide,depthWrite:false,
  });
  mat.userData.shared=true;
  mat.onBeforeCompile=(shader)=>{
    shader.uniforms.uTime=uniforms.uTime;
    injectHoloClip(shader,uniforms);
    let frag='#include <emissivemap_fragment>\n'+
      'float _fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), 3.0);\n'+
      'float _scan = 0.9 + 0.1 * sin(uTime * 3.0 + vFocusWP.y * 26.0);\n'+
      'totalEmissiveRadiance += _fres * vec3(1.0, 0.86, 0.55) * 1.5;\n'+
      'totalEmissiveRadiance *= _scan;\n';
    if(windows){
      shader.vertexShader=shader.vertexShader
        .replace('#include <common>','#include <common>\nvarying vec3 vWinPos;')
        .replace('#include <begin_vertex>','#include <begin_vertex>\nvWinPos = position;');
      shader.fragmentShader=shader.fragmentShader
        .replace('#include <common>','#include <common>\nvarying vec3 vWinPos;');
      frag+=
        'vec3 _wp = vWinPos;\n'+
        'float _fy = abs(fract(_wp.y * 1.15) - 0.5);\n'+
        'float _fx = abs(fract(_wp.x * 1.7) - 0.5);\n'+
        'float _fz = abs(fract(_wp.z * 1.7) - 0.5);\n'+
        'float _win = max(step(_fx,0.3), step(_fz,0.3)) * step(_fy,0.32);\n'+
        'float _lit = fract(sin(dot(floor(vec3(_wp.x*1.7,_wp.y*1.15,_wp.z*1.7)), vec3(12.9898,78.233,37.719))) * 43758.5453);\n'+
        'totalEmissiveRadiance += _win * (0.25 + 0.75*step(0.45,_lit)) * vec3(1.0,0.8,0.48) * 0.9;\n';
    }
    shader.fragmentShader=shader.fragmentShader
      .replace('#include <common>','#include <common>\nuniform float uTime;')
      .replace('#include <emissivemap_fragment>',frag);
  };
  return mat;
}
