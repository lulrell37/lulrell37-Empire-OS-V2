// The Empire — a 3D holographic Roman city that is the app's home / hub.
// Orbit with one finger, pinch to zoom (the zoom tracks toward your fingers,
// same as the persona sphere), tap a landmark to enter that part of the app.
//
// The city is built procedurally from three.js primitives and rendered with the
// shared holo material (src/screens/command/holoMaterial.js) so it matches the
// Laboratory diagram exactly. No bundled model, so this ships as an OTA update.
import React,{useRef,useState,useCallback,useMemo,useEffect}from 'react';
import{View,Text,StyleSheet,TouchableOpacity,Dimensions,ActivityIndicator}from 'react-native';
import{SafeAreaView}from 'react-native-safe-area-context';
import{useFocusEffect}from '@react-navigation/native';
import{GLView}from 'expo-gl';
import{Renderer}from 'expo-three';
import*as THREE from 'three';
import{Gesture,GestureDetector}from 'react-native-gesture-handler';
import{getHudState}from '../services/database';
import useEmpireStore from '../store/useEmpireStore';
import Boundary from './hud/Boundary';
import{makeHoloUniforms,createHoloMaterial,disposeObject}from './command/holoMaterial';

// Landmark id (mesh.name / userData.heroTarget) -> nav route + display.
const HEROES=[
  {name:'Council',   route:'Command',    label:'COUNCIL',    sub:'THE PERSONAS', tint:0xE8C98A, at:[0,3.4]},
  {name:'HUD',       route:'HUD',        label:'THE HUD',    sub:'EMPIRE STATE', tint:0xD4A017, at:[3.6,-1.4]},
  {name:'Laboratory',route:'Laboratory', label:'LABORATORY', sub:'THE DIAGRAM',  tint:0x7FB0D4, at:[-3.6,-1.4]},
  {name:'Settings',  route:'Settings',   label:'SETTINGS',   sub:'THE WORKSHOP', tint:0x8A8A8A, at:[0,-4.2]},
];

function mulberry32(a){
  return function(){
    a|=0;a=a+0x6D2B79F5|0;
    let t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return((t^t>>>14)>>>0)/4294967296;
  };
}

// Build the whole city as one pivot Group. Returns { pivot, anchors } where
// anchors is [{name, pos:Vector3}] for the floating labels.
function buildCity(uniforms){
  const pivot=new THREE.Group();
  const mat=createHoloMaterial(uniforms);
  const add=(geo,x,y,z,ry)=>{
    const m=new THREE.Mesh(geo,mat);
    m.position.set(x,y,z);
    if(ry)m.rotation.y=ry;
    pivot.add(m);
    return m;
  };

  // Ground plateau + forum plaza.
  add(new THREE.CylinderGeometry(11,11.4,0.4,64),0,-0.2,0);
  add(new THREE.CylinderGeometry(3.1,3.1,0.12,48),0,0.02,0);

  // Roman street grid: cardo (N-S) + decumanus (E-W) + a couple of ring roads.
  add(new THREE.BoxGeometry(0.5,0.06,20),0,0.05,0);
  add(new THREE.BoxGeometry(20,0.06,0.5),0,0.05,0);
  add(new THREE.TorusGeometry(6,0.07,8,64),0,0.05,0,Math.PI/2).rotation.x=Math.PI/2;

  // Filler blocks — insulae — on a seeded scatter, kept off the plaza + roads.
  const rnd=mulberry32(20240901);
  for(let i=0;i<70;i++){
    const ang=rnd()*Math.PI*2;
    const rad=3.6+rnd()*6.6;
    const x=Math.cos(ang)*rad, z=Math.sin(ang)*rad;
    if(Math.abs(x)<0.9||Math.abs(z)<0.9)continue; // clear the main streets
    const w=0.5+rnd()*1.1, d=0.5+rnd()*1.1, h=0.6+rnd()*rnd()*4.2;
    add(new THREE.BoxGeometry(w,h,d),x,h/2,z,rnd()*Math.PI);
  }

  // Colonnade ringing the forum.
  const colGeo=new THREE.CylinderGeometry(0.09,0.09,1.5,8);
  const cols=new THREE.InstancedMesh(colGeo,mat,28);
  const dummy=new THREE.Object3D();
  for(let i=0;i<28;i++){
    const a=(i/28)*Math.PI*2;
    dummy.position.set(Math.cos(a)*3.5,0.75,Math.sin(a)*3.5);
    dummy.updateMatrix();
    cols.setMatrixAt(i,dummy.matrix);
  }
  pivot.add(cols);

  // Aqueduct marching in from the east.
  for(let i=0;i<7;i++){
    add(new THREE.BoxGeometry(0.35,2.2+i*0.05,0.35),7.5+i*1.15,1.1,3.2);
    add(new THREE.TorusGeometry(0.5,0.12,6,12,Math.PI),8.07+i*1.15,2.2,3.2,0);
  }

  // Colosseum — an open ellipse ring — to the north-west.
  const colo=new THREE.Mesh(new THREE.CylinderGeometry(1.7,1.9,1.5,40,1,true),mat);
  colo.position.set(-5.5,0.75,4.2);
  colo.scale.set(1,1,0.78);
  pivot.add(colo);

  // Hero landmarks.
  const anchors=[];
  for(const hero of HEROES){
    const hmat=createHoloMaterial(uniforms,{tint:hero.tint});
    const g=new THREE.Group();
    g.position.set(hero.at[0],0,hero.at[1]);
    g.name=hero.name;
    g.userData.heroTarget=hero.name;

    const stamp=(geo,x,y,z)=>{
      const m=new THREE.Mesh(geo,hmat);
      m.position.set(x,y,z);
      m.name=hero.name;
      m.userData.heroTarget=hero.name;
      g.add(m);
      return m;
    };
    // Shared plinth.
    stamp(new THREE.BoxGeometry(2.4,0.5,2.4),0,0.25,0);

    if(hero.name==='Council'){                 // stepped senate portico
      stamp(new THREE.BoxGeometry(2.0,1.7,1.6),0,1.35,0);
      for(let i=0;i<5;i++)stamp(new THREE.CylinderGeometry(0.12,0.12,1.9,10),-0.8+i*0.4,1.45,0.95);
      const ped=stamp(new THREE.ConeGeometry(1.25,0.7,4),0,2.7,0);ped.rotation.y=Math.PI/4;ped.scale.set(1,0.5,0.45);
    }else if(hero.name==='HUD'){                // domed pantheon
      stamp(new THREE.CylinderGeometry(1.15,1.15,1.6,32),0,1.3,0);
      stamp(new THREE.SphereGeometry(1.15,32,16,0,Math.PI*2,0,Math.PI/2),0,2.1,0);
      stamp(new THREE.TorusGeometry(0.25,0.06,8,20),0,3.25,0).rotation.x=Math.PI/2;
    }else if(hero.name==='Laboratory'){         // observatory tower
      stamp(new THREE.CylinderGeometry(0.7,0.95,3.4,20),0,2.2,0);
      const dome=stamp(new THREE.SphereGeometry(0.8,24,16,0,Math.PI*2,0,Math.PI*0.6),0,3.9,0);dome.scale.set(1,0.8,1);
      stamp(new THREE.BoxGeometry(0.12,1.6,0.12),0.55,4.4,0).rotation.z=-0.5;
    }else if(hero.name==='Settings'){           // workshop + gear
      stamp(new THREE.BoxGeometry(2.0,1.5,1.8),0,1.25,0);
      const gear=stamp(new THREE.CylinderGeometry(0.8,0.8,0.18,12),0,2.4,0);
      gear.rotation.x=Math.PI/2;
      gear.userData.spin=1;
      g.userData.gear=gear;
    }
    pivot.add(g);
    anchors.push({name:hero.name,pos:g.position.clone().setY(3.6)});
  }

  const spinners=[];
  pivot.traverse(o=>{if(o.userData?.spin)spinners.push(o);});
  return{pivot,anchors,spinners};
}

function EmpireCity({navigation}){
  const[status,setStatus]=useState('loading');       // loading | ready | error
  const[errMsg,setErrMsg]=useState('');
  const[labels,setLabels]=useState([]);              // [{name,label,sub,x,y,visible}]
  const hud=useEmpireStore(s=>s.hudState);
  const setHudState=useEmpireStore(s=>s.setHudState);

  const engine=useRef({
    rotY:0.7,rotX:0.62,startRX:0,startRY:0,
    dolly:0,startDolly:0,baseR:17,minR:6,maxR:26,
    panX:0,panZ:0,startPanX:0,startPanZ:0,focus:new THREE.Vector3(),
    active:true,idle:0,entering:null,
    vw:Dimensions.get('window').width,vh:Dimensions.get('window').height,
  }).current;

  useEffect(()=>{getHudState().then(h=>{if(h)setHudState(h);}).catch(()=>{});},[]); // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(useCallback(()=>{
    engine.active=true;
    return()=>{engine.active=false;};
  },[engine]));

  useEffect(()=>()=>{
    if(engine.raf)cancelAnimationFrame(engine.raf);
    try{if(engine.pivot)disposeObject(engine.pivot);}catch{}
    try{engine.renderer?.dispose?.();}catch{}
  },[engine]);

  // These only ever touch the stable `engine` ref and `navigation`, so they can
  // be created once — which lets the gesture objects below be memoised and not
  // rebuilt on every label re-render (that would reset an in-flight pinch).
  const enter=useCallback((name)=>{
    if(engine.entering)return;
    const hero=HEROES.find(h=>h.name===name);
    if(hero)engine.entering={route:hero.route,t:0};
  },[engine]);

  const raycastAt=useCallback((x,y)=>{
    const{camera,raycaster,pivot,vw,vh}=engine;
    if(!camera||!raycaster||!pivot)return null;
    const ndc=new THREE.Vector2((x/vw)*2-1,-(y/vh)*2+1);
    raycaster.setFromCamera(ndc,camera);
    for(const hit of raycaster.intersectObject(pivot,true)){
      let o=hit.object;
      while(o){if(o.userData?.heroTarget)return o.userData.heroTarget;o=o.parent;}
    }
    return null;
  },[engine]);

  // Ground-plane hit for "zoom toward the fingers".
  const groundAt=useCallback((x,y)=>{
    const{camera,vw,vh}=engine;
    if(!camera)return null;
    const ndc=new THREE.Vector2((x/vw)*2-1,-(y/vh)*2+1);
    const rc=new THREE.Raycaster();
    rc.setFromCamera(ndc,camera);
    const p=new THREE.Vector3();
    return rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0),0),p)?p:null;
  },[engine]);

  const gesture=useMemo(()=>{
    const pan=Gesture.Pan().runOnJS(true).maxPointers(1)
      .onStart(()=>{engine.startRX=engine.rotX;engine.startRY=engine.rotY;engine.idle=0;})
      .onUpdate(e=>{
        engine.rotY=engine.startRY-e.translationX*0.006;
        engine.rotX=Math.max(0.12,Math.min(1.35,engine.startRX-e.translationY*0.005));
        engine.idle=0;
      });
    const pinch=Gesture.Pinch().runOnJS(true)
      .onStart(e=>{
        engine.startDolly=engine.dolly;
        engine.startPanX=engine.panX;engine.startPanZ=engine.panZ;
        engine.startR=engine.baseR+engine.dolly;
        const g=groundAt(e.focalX??engine.vw/2,e.focalY??engine.vh/2);
        engine.focus.copy(g||new THREE.Vector3());
        engine.idle=0;
      })
      .onUpdate(e=>{
        const n=engine.startDolly-(e.scale-1)*9;
        engine.dolly=Math.max(engine.minR-engine.baseR,Math.min(engine.maxR-engine.baseR,n));
        // Shift the orbit target toward the focal ground point in proportion to
        // how far we've zoomed in, so it stays roughly under the fingers.
        const r=engine.baseR+engine.dolly;
        const k=Math.max(-0.6,Math.min(0.9,1-r/(engine.startR||r)));
        engine.panX=engine.startPanX+(engine.focus.x-engine.startPanX)*k;
        engine.panZ=engine.startPanZ+(engine.focus.z-engine.startPanZ)*k;
        engine.idle=0;
      });
    const tap=Gesture.Tap().runOnJS(true).maxDistance(14)
      .onEnd((e,ok)=>{if(ok){const t=raycastAt(e.x,e.y);if(t)enter(t);}});
    return Gesture.Simultaneous(pinch,Gesture.Race(tap,pan));
  },[engine,groundAt,raycastAt,enter]);

  async function onContextCreate(gl){
    try{
      const glW=gl.drawingBufferWidth,glH=gl.drawingBufferHeight;
      const renderer=new Renderer({gl});
      renderer.setSize(glW,glH);
      renderer.setClearColor(0x000000,0);

      const scene=new THREE.Scene();
      scene.fog=new THREE.FogExp2(0x000000,0.028);
      const camera=new THREE.PerspectiveCamera(46,glW/glH,0.1,200);
      scene.add(new THREE.AmbientLight(0xffffff,0.8));
      const kl=new THREE.DirectionalLight(0xfff2d8,1.35);kl.position.set(6,10,6);scene.add(kl);
      const rl=new THREE.DirectionalLight(0xE8C98A,0.7);rl.position.set(-8,4,-6);scene.add(rl);

      const uniforms=makeHoloUniforms();
      const{pivot,anchors,spinners}=buildCity(uniforms);
      scene.add(pivot);

      Object.assign(engine,{renderer,scene,camera,pivot,anchors,spinners,uniforms,raycaster:new THREE.Raycaster(),last:Date.now()});
      setStatus('ready');

      const tmp=new THREE.Vector3();
      let lblAcc=0;

      const animate=()=>{
        engine.raf=requestAnimationFrame(animate);
        const now=Date.now();
        const dt=Math.min(0.05,(now-engine.last)/1000);
        engine.last=now;
        if(engine.active===false)return;

        uniforms.uTime.value+=dt;
        engine.idle+=dt;
        // Gentle drift when the user isn't touching it.
        if(engine.idle>2&&!engine.entering)engine.rotY+=dt*0.05;

        // Orbit camera around the (panX,0,panZ) target.
        let r=engine.baseR+engine.dolly;
        let tx=engine.panX,tz=engine.panZ;
        if(engine.entering){
          const e=engine.entering;e.t+=dt/0.42;
          const p=Math.min(1,e.t);
          const hero=HEROES.find(h=>h.route===e.route);
          r=THREE.MathUtils.lerp(r,5,p);
          tx=THREE.MathUtils.lerp(tx,hero.at[0],p);
          tz=THREE.MathUtils.lerp(tz,hero.at[1],p);
          if(e.t>=1){
            const route=e.route;engine.entering=null;
            navigation.navigate(route);
            return;
          }
        }
        camera.position.set(
          tx+Math.sin(engine.rotY)*Math.cos(engine.rotX)*r,
          Math.max(1.5,Math.sin(engine.rotX)*r*0.9+1.5),
          tz+Math.cos(engine.rotY)*Math.cos(engine.rotX)*r,
        );
        camera.lookAt(tx,1.2,tz);

        // Spin the Settings gear.
        for(const sp of engine.spinners)sp.rotation.z+=dt*0.9;

        renderer.render(scene,camera);
        gl.endFrameEXP();

        // Project landmark anchors to screen for the RN overlay labels (~8fps).
        lblAcc+=dt;
        if(lblAcc>0.12){
          lblAcc=0;
          const out=[];
          for(const a of engine.anchors){
            tmp.copy(a.pos).applyMatrix4(engine.pivot.matrixWorld).project(camera);
            const meta=HEROES.find(h=>h.name===a.name);
            out.push({
              name:a.name,label:meta.label,sub:meta.sub,tint:'#'+meta.tint.toString(16).padStart(6,'0'),
              x:(tmp.x*0.5+0.5)*engine.vw,
              y:(-tmp.y*0.5+0.5)*engine.vh,
              visible:tmp.z<1&&tmp.x>-1.1&&tmp.x<1.1&&tmp.y>-1.1&&tmp.y<1.1,
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

  const score=hud?.empire_score||0;
  const streak=hud?.streak||0;

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
    <View style={s.container} onLayout={e=>{const{width,height}=e.nativeEvent.layout;engine.vw=width;engine.vh=height;}}>
      <GestureDetector gesture={gesture}>
        <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate}/>
      </GestureDetector>

      {labels.filter(l=>l.visible).map(l=>(
        <TouchableOpacity
          key={l.name}
          activeOpacity={0.8}
          onPress={()=>enter(l.name)}
          style={[s.label,{left:l.x-70,top:l.y-20,borderColor:l.tint+'66'}]}
        >
          <Text style={[s.labelT,{color:l.tint}]}>{l.label}</Text>
          <Text style={s.labelS}>{l.sub}</Text>
        </TouchableOpacity>
      ))}

      <SafeAreaView style={s.hudStrip} edges={['top']} pointerEvents="none">
        <Text style={s.hudBrand}>THE EMPIRE</Text>
        <Text style={s.hudMeta}>{score}%  ·  {streak}🔥</Text>
      </SafeAreaView>

      {status==='loading'&&(
        <View style={s.loading} pointerEvents="none">
          <ActivityIndicator color="#E8C98A"/>
          <Text style={s.loadingT}>RAISING THE CITY…</Text>
        </View>
      )}

      <SafeAreaView style={s.hint} edges={['bottom']} pointerEvents="none">
        <Text style={s.hintT}>DRAG TO ORBIT · PINCH TO ZOOM · TAP A LANDMARK</Text>
      </SafeAreaView>
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
  label:{position:'absolute',width:140,alignItems:'center',backgroundColor:'rgba(0,0,0,0.55)',borderWidth:1,borderRadius:6,paddingVertical:5},
  labelT:{fontFamily:'monospace',fontSize:11,fontWeight:'700',letterSpacing:3},
  labelS:{fontFamily:'monospace',fontSize:7,color:'#8A7E63',letterSpacing:2,marginTop:2},
  hudStrip:{position:'absolute',top:0,left:0,right:0,alignItems:'center',paddingTop:10},
  hudBrand:{fontFamily:'monospace',fontSize:15,fontWeight:'700',color:'#E8C98A',letterSpacing:6},
  hudMeta:{fontFamily:'monospace',fontSize:10,color:'#8A7E63',letterSpacing:2,marginTop:3},
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
