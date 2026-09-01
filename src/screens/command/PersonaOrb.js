// The JARVIS-style persona visualization: a drifting cloud of light points
// around a soft glowing core, in the persona's colour. At rest it breathes and
// throws the odd sparkle; while the persona speaks the whole cloud blooms
// outward with a one-shot shockwave, then settles.
//
// `viz` is a shared mutable object updated by CommandScreen:
//   { speaking:boolean, amplitude:0..1, color:'#hex', personaId }
// The render loop polls it every frame — no re-renders.
import React,{useRef,useEffect}from 'react';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import*as THREE from 'three';

const N=1800;

export default function PersonaOrb({viz,color='#E8C98A',active=true}){
  const engine=useRef({}).current;
  engine.active=active;

  useEffect(()=>()=>{
    if(engine.raf)cancelAnimationFrame(engine.raf);
    try{engine.renderer?.dispose?.();}catch{}
  },[]); // eslint-disable-line react-hooks/exhaustive-deps

  async function onContextCreate(gl){
    try{
      const w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(w,h);
      renderer.setClearColor(0x000000,0);

      const scene=new THREE.Scene();
      const camera=new THREE.PerspectiveCamera(50,w/h,0.1,100);
      camera.position.z=4;

      const positions=new Float32Array(N*3);
      const aPhase=new Float32Array(N);
      const aFreq=new Float32Array(N);
      const aSize=new Float32Array(N);
      for(let i=0;i<N;i++){
        const y=1-(i/(N-1))*2;
        const r=Math.sqrt(Math.max(0,1-y*y));
        const th=i*2.399963229728653;
        positions[i*3]=Math.cos(th)*r;
        positions[i*3+1]=y;
        positions[i*3+2]=Math.sin(th)*r;
        aPhase[i]=Math.random()*Math.PI*2;
        aFreq[i]=0.5+Math.random()*1.8;
        aSize[i]=1.5+Math.random()*2.6;
      }
      const geo=new THREE.BufferGeometry();
      geo.setAttribute('position',new THREE.BufferAttribute(positions,3));
      geo.setAttribute('aPhase',new THREE.BufferAttribute(aPhase,1));
      geo.setAttribute('aFreq',new THREE.BufferAttribute(aFreq,1));
      geo.setAttribute('aSize',new THREE.BufferAttribute(aSize,1));

      const col=new THREE.Color(color);
      const pointUniforms={uTime:{value:0},uAmp:{value:0},uLit:{value:0},uPulse:{value:0},uColor:{value:col.clone()}};
      const pointsMat=new THREE.ShaderMaterial({
        uniforms:pointUniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
        vertexShader:`
          attribute float aPhase; attribute float aFreq; attribute float aSize;
          uniform float uTime; uniform float uAmp; uniform float uLit; uniform float uPulse;
          varying float vGlow;
          void main(){
            vec3 dir=normalize(position);
            float disp=sin(uTime*aFreq+aPhase)*(0.05+uAmp*0.32);
            disp+=uPulse*0.30*sin(dir.y*5.0-uPulse*14.0+aPhase*0.3);
            vec3 p=dir*(1.0+disp)*(1.0+uAmp*0.22+uLit*0.18+uPulse*0.30);
            vec4 mv=modelViewMatrix*vec4(p,1.0);
            gl_Position=projectionMatrix*mv;
            float tw=pow(max(0.0,sin(uTime*aFreq*0.7+aPhase)),20.0);
            gl_PointSize=min(80.0,aSize*(1.0+uAmp*2.0+uLit*0.9+tw*2.2+uPulse*1.5)*(130.0/max(0.1,-mv.z)));
            vGlow=0.30+uAmp*0.65+uLit*0.5+uPulse*0.5+tw*0.9+0.14*sin(uTime*aFreq*2.0+aPhase);
          }`,
        fragmentShader:`
          precision mediump float;
          uniform vec3 uColor; uniform float uAmp; uniform float uLit; uniform float uPulse;
          varying float vGlow;
          void main(){
            float d=length(gl_PointCoord-0.5);
            if(d>0.5)discard;
            float a=smoothstep(0.5,0.0,d)*vGlow;
            gl_FragColor=vec4(uColor*(1.0+uAmp*0.7+uLit*0.6+uPulse*0.5),a*(0.5+uLit*0.3));
          }`,
      });
      const points=new THREE.Points(geo,pointsMat);
      scene.add(points);

      const glowUniforms={uColor:{value:col.clone()},uAmp:{value:0},uLit:{value:0},uPulse:{value:0}};
      const glowMat=new THREE.ShaderMaterial({
        uniforms:glowUniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.BackSide,
        vertexShader:`
          varying vec3 vN; varying vec3 vP;
          void main(){
            vN=normalize(normalMatrix*normal);
            vec4 mv=modelViewMatrix*vec4(position,1.0);
            vP=mv.xyz;
            gl_Position=projectionMatrix*mv;
          }`,
        fragmentShader:`
          precision mediump float;
          uniform vec3 uColor; uniform float uAmp; uniform float uLit; uniform float uPulse;
          varying vec3 vN; varying vec3 vP;
          void main(){
            float f=pow(1.0-abs(dot(vN,normalize(vP))),2.0);
            gl_FragColor=vec4(uColor*(1.0+uLit*0.5+uPulse*0.4),f*(0.12+uAmp*0.4+uLit*0.33+uPulse*0.3));
          }`,
      });
      const glow=new THREE.Mesh(new THREE.SphereGeometry(0.85,32,24),glowMat);
      scene.add(glow);

      Object.assign(engine,{renderer,scene,camera,points,glow,pointUniforms,glowUniforms,amp:0,spk:0,pulse:0,prevSpeaking:false,last:Date.now()});

      const animate=()=>{
        engine.raf=requestAnimationFrame(animate);
        const now=Date.now();
        const dt=Math.min(0.05,(now-engine.last)/1000);
        engine.last=now;
        if(engine.active===false)return; // screen not focused — hold last frame

        pointUniforms.uTime.value+=dt;
        const speaking=!!viz?.speaking;
        // one-shot bloom on the rising edge of "speaking"
        if(speaking&&!engine.prevSpeaking)engine.pulse=1;
        engine.prevSpeaking=speaking;
        engine.pulse=Math.max(0,engine.pulse-dt*1.6);
        // idle floor raised from 0.05 so the orb never looks dead
        const target=speaking?Math.max(0.12,Math.min(1,viz.amplitude||0.4)):0.12;
        engine.amp+=(target-engine.amp)*Math.min(1,dt*9);
        engine.spk+=((speaking?1:0)-engine.spk)*Math.min(1,dt*4);
        pointUniforms.uAmp.value=engine.amp;
        glowUniforms.uAmp.value=engine.amp;
        pointUniforms.uLit.value=engine.spk;
        glowUniforms.uLit.value=engine.spk;
        pointUniforms.uPulse.value=engine.pulse;
        glowUniforms.uPulse.value=engine.pulse;

        const c=viz?.color||color;
        if(c){pointUniforms.uColor.value.set(c);glowUniforms.uColor.value.set(c);}

        points.rotation.y+=dt*0.16;
        points.rotation.x+=dt*0.05;
        const breathe=1.0+0.03*Math.sin(pointUniforms.uTime.value*0.6);
        const swell=breathe*(1.0+engine.spk*0.26+engine.pulse*0.12);
        points.scale.setScalar(swell);
        glow.scale.setScalar(swell*(1.0+engine.amp*0.3));

        renderer.render(scene,camera);
        gl.endFrameEXP();
      };
      animate();
    }catch(err){
      // Orb is decorative — swallow GL failures rather than crash the screen.
      if(__DEV__)console.warn('PersonaOrb GL error:',err?.message||err);
    }
  }

  return <GLView style={{flex:1}} onContextCreate={onContextCreate}/>;
}
