import * as THREE from "./vendor/three.module.min.js";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";

const STATES=new Set(["idle","connecting","listening","thinking","speaking","executing","muted","error"]);
const VIEWS={front:0,"three-quarter":.52,profile:1.02};

// Nova Prism Shard Bloom. The CC0 mesh supplies proportion only; all visible
// skin, eyes and hair are replaced by Nova's non-human prismatic treatment.
export function createNovaPrismAvatar({canvas,inputLevel=()=>0,outputLevel=()=>0,maxFps=36,reducedMotion=globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches}={}){
  if(!canvas)throw new TypeError("Nova Prism requires a canvas.");
  let renderer;try{renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:"high-performance",preserveDrawingBuffer:true});}catch(error){canvas.dataset.avatarFallback="webgl-unavailable";return fallback(error);}
  renderer.setClearColor(0x020208,0);renderer.setPixelRatio(Math.min(1.5,globalThis.devicePixelRatio||1));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.08;renderer.localClippingEnabled=true;
  const scene=new THREE.Scene();scene.fog=new THREE.FogExp2(0x020208,.065);
  const camera=new THREE.PerspectiveCamera(27,1,.1,35);camera.position.set(0,.05,7.45);
  const root=new THREE.Group();root.position.y=-.06;scene.add(root);
  const p={ice:0xe9fbff,cyan:0x58e8ff,violet:0x8f68ff,magenta:0xff66d7,rose:0xff8fb7,amber:0xffc46a};
  scene.add(new THREE.HemisphereLight(0xb8efff,0x080313,.58));
  const key=new THREE.DirectionalLight(0xdafaff,1.85);key.position.set(3.7,4.4,5.5);scene.add(key);
  const violet=new THREE.PointLight(p.violet,20,14,2);violet.position.set(-3.7,1.4,.1);scene.add(violet);
  const rose=new THREE.PointLight(p.magenta,15,12,2);rose.position.set(3.1,-.4,1.2);scene.add(rose);
  const warm=new THREE.PointLight(p.amber,9,10,2);warm.position.set(-.4,-2.2,2.8);scene.add(warm);
  const identity=prismIdentity(root,p),facets=faceFacets(p),hair=prismHair(p),features=syntheticFeatures(p),halo=makeHalo(p),field=ambient(p);
  root.add(facets.group,hair.group,features.group,halo.group);scene.add(field.points);
  const scanMat=new THREE.MeshBasicMaterial({color:p.cyan,transparent:true,opacity:0,side:THREE.DoubleSide,blending:THREE.AdditiveBlending,depthWrite:false});
  const scan=new THREE.Mesh(new THREE.PlaneGeometry(3.9,.022),scanMat);scan.position.z=1.54;root.add(scan);
  let state="idle",running=false,disposed=false,frame=0,last=0,measuredAt=performance.now(),frames=0,fps=0,py=0,pp=0,view="front";
  const interval=1000/(reducedMotion?18:Math.max(24,Math.min(48,maxFps)));
  const resize=()=>{const r=canvas.getBoundingClientRect(),w=Math.max(260,Math.round(r.width||700)),h=Math.max(340,Math.round(r.height||760)),d=renderer.getPixelRatio();if(canvas.width!==Math.round(w*d)||canvas.height!==Math.round(h*d))renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();};
  const render=timestamp=>{if(!running||disposed)return;frame=requestAnimationFrame(render);if(timestamp-last<interval)return;last=timestamp;resize();
    const t=timestamp/1000,input=clamp(inputLevel()),output=clamp(outputLevel()),energy=state==="speaking"?output:state==="listening"?input:state==="thinking"?.28:state==="executing"?.38:.065;
    root.rotation.y+=(VIEWS[view]+py+(state==="thinking"?Math.sin(t*.48)*.075:Math.sin(t*.18)*.018)-root.rotation.y)*.052;root.rotation.x+=(pp+Math.sin(t*.3)*.014-root.rotation.x)*.06;root.position.y=-.06+Math.sin(t*.9)*.018;
    identity.group.position.y=-12.6+Math.sin(t*.9)*.012;identity.face.emissiveIntensity=.22+energy*.7;identity.face.opacity=state==="muted"?.1:.16+energy*.05;identity.edge.opacity=.05+energy*.1;identity.inner.opacity=.008+energy*.018;
    facets.materials.forEach((m,i)=>{m.emissiveIntensity=.56+energy*(i%3===0?1.25:.82);m.opacity=.62+energy*.14;});facets.group.rotation.z=Math.sin(t*.18)*.004;
    hair.materials.forEach((m,i)=>{m.emissiveIntensity=.62+energy*(i%3===0?1.15:.72);m.opacity=.76+energy*.12;});hair.line.opacity=.24+energy*.3;
    hair.ribbons.forEach((r,i)=>{r.rotation.z=Math.sin(t*(.22+i%4*.025)+i*.7)*(.006+energy*.018);r.position.z=Math.sin(t*.42+i*.8)*(.004+energy*.012);});
    hair.shards.forEach((s,i)=>s.scale.setScalar(1+Math.sin(t*1.1+i*.85)*.018+energy*.045));
    hair.crystals.forEach((s,i)=>{s.rotation.z=Math.sin(t*.24+i*.71)*(.006+energy*.012);s.position.z=.12+Math.sin(t*.38+i)*.012;});
    features.primary.opacity=.54+energy*.38;features.secondary.opacity=.16+energy*.26;features.speech.position.y=state==="speaking"?-output*.022:0;features.speech.scale.y=1+(state==="speaking"?output*.13:0);
    halo.group.rotation.z=t*(state==="thinking"?.105:.018);halo.material.opacity=.075+energy*.22;field.points.rotation.y=t*.012;field.material.opacity=.08+energy*.12;
    scanMat.opacity=state==="executing"?.42:Math.max(0,scanMat.opacity-.035);scan.position.y=state==="executing"?1.65-((t*.8)%3.35):-2;violet.intensity=17+energy*24;rose.intensity=12+energy*20;
    renderer.render(scene,camera);frames++;if(timestamp-measuredAt>=1000){fps=Math.round(frames*1000/(timestamp-measuredAt));frames=0;measuredAt=timestamp;}
  };
  const move=e=>{if(!running)return;const r=canvas.getBoundingClientRect();py=((e.clientX-r.left)/r.width-.5)*.2;pp=((e.clientY-r.top)/r.height-.5)*.075;},leave=()=>{py=0;pp=0;};
  canvas.addEventListener("pointermove",move,{passive:true});canvas.addEventListener("pointerleave",leave,{passive:true});
  const api=Object.freeze({start(){if(!running&&!disposed){running=true;measuredAt=performance.now();frame=requestAnimationFrame(render);}return api;},stop(){running=false;if(frame)cancelAnimationFrame(frame);frame=0;return api;},setState(next){if(STATES.has(next))state=next;return api;},setView(next){if(Object.hasOwn(VIEWS,next))view=next;return api;},getState:()=>state,metrics:()=>({fps,triangles:renderer.info.render.triangles,calls:renderer.info.render.calls,webgl:true,authored:identity.loaded,view}),capture:()=>canvas.toDataURL("image/png"),dispose(){api.stop();disposed=true;canvas.removeEventListener("pointermove",move);canvas.removeEventListener("pointerleave",leave);scene.traverse(o=>{o.geometry?.dispose?.();if(Array.isArray(o.material))o.material.forEach(m=>m.dispose?.());else o.material?.dispose?.();});renderer.dispose();}});
  return api;
}
export const createNovaAetherAvatar=createNovaPrismAvatar;

function prismIdentity(root,p){
  const group=new THREE.Group();group.position.y=-12.6;group.scale.setScalar(9);root.add(group);
  const clip=new THREE.Plane(new THREE.Vector3(0,1,0),.92);
  const face=new THREE.MeshPhysicalMaterial({color:0x090617,emissive:0x260850,emissiveIntensity:.28,metalness:.48,roughness:.24,clearcoat:1,clearcoatRoughness:.1,transmission:.02,thickness:.18,iridescence:.55,iridescenceIOR:1.3,iridescenceThicknessRange:[180,520],transparent:true,opacity:.34,side:THREE.DoubleSide,flatShading:true,depthWrite:false,clippingPlanes:[clip]});
  const edge=new THREE.LineBasicMaterial({color:p.ice,transparent:true,opacity:.24,blending:THREE.AdditiveBlending,depthWrite:false,clippingPlanes:[clip]});
  const inner=new THREE.MeshBasicMaterial({color:p.magenta,transparent:true,opacity:.018,wireframe:true,blending:THREE.AdditiveBlending,depthWrite:false,clippingPlanes:[clip]});
  const controller={group,face,edge,inner,loaded:false};
  new GLTFLoader().load("/assets/models/nova-female-base.glb",body=>{const overlays=[];body.scene.traverse(o=>{if(!o.isMesh&&!o.isSkinnedMesh)return;if((o.material?.name||"")!=="Skin"){o.visible=false;return;}o.material=face;o.frustumCulled=false;const d=o.morphTargetDictionary||{},v=o.morphTargetInfluences||[],m=(n,x)=>{if(d[n]!==undefined)v[d[n]]=x;};m("gender_female",1);m("gender_male",0);m("face_cheekbones_incr",.2);m("face_jaw_width_decr",.11);m("face_eye_tilt_incr",.07);const wire=o.clone();wire.material=inner;wire.renderOrder=2;overlays.push(wire);if(!o.isSkinnedMesh){const e=new THREE.LineSegments(new THREE.EdgesGeometry(o.geometry,28),edge);e.renderOrder=3;o.add(e);}});overlays.forEach(x=>body.scene.add(x));group.add(body.scene);controller.loaded=true;},undefined,()=>{canvasFallback(root,p);});
  return controller;
}

function prismHair(p){
  const group=new THREE.Group(),ribbons=[],shards=[],crystals=[],materials=[];
  const paths=[
    [[-.08,1.52,.08],[-.48,1.54,.18],[-1.08,1.22,.2],[-1.62,.63,.08],[-1.9,.06,-.18]],[[-.02,1.56,.02],[-.32,1.7,.02],[-.98,1.66,-.08],[-1.72,1.35,-.28],[-2.18,.95,-.48]],
    [[.02,1.54,.04],[.43,1.62,.2],[1.02,1.45,.27],[1.54,.93,.15],[1.79,.19,-.06]],[[.08,1.48,.06],[.66,1.52,.12],[1.42,1.23,-.02],[2.02,.68,-.26],[2.34,.05,-.54]],
    [[-.18,1.46,.04],[-.72,1.24,.26],[-1.26,.69,.3],[-1.5,-.06,.1],[-1.42,-.78,-.2]],[[.18,1.44,.07],[.78,1.18,.35],[1.24,.55,.31],[1.35,-.19,.09],[1.22,-.94,-.24]],
    [[-.27,1.42,-.04],[-.98,1.16,-.18],[-1.51,.54,-.34],[-1.76,-.32,-.51],[-1.7,-1.18,-.64]],[[.31,1.39,-.06],[1.02,1.11,-.16],[1.56,.42,-.33],[1.78,-.45,-.5],[1.62,-1.35,-.62]],
    [[-.36,1.35,-.22],[-1.2,1.16,-.48],[-1.82,.48,-.7],[-2.03,-.4,-.79],[-1.78,-1.5,-.75]],[[.42,1.34,-.22],[1.24,1.04,-.48],[1.91,.3,-.71],[2.08,-.61,-.78],[1.82,-1.5,-.7]],
    [[-.03,1.57,-.14],[-.52,1.82,-.34],[-1.22,1.83,-.58],[-1.86,1.55,-.8],[-2.36,1.12,-.96]],[[.07,1.58,-.13],[.64,1.8,-.34],[1.38,1.72,-.58],[2.02,1.34,-.82],[2.5,.84,-1.02]]
  ];
  paths.forEach((points,i)=>{const colors=[p.violet,p.magenta,p.cyan,p.rose],m=new THREE.MeshPhysicalMaterial({color:colors[i%4],emissive:colors[i%4],emissiveIntensity:.62,metalness:.42,roughness:.18,clearcoat:1,clearcoatRoughness:.08,transmission:0,thickness:.1,iridescence:.5,iridescenceIOR:1.3,iridescenceThicknessRange:[160,580],transparent:true,opacity:.28,side:THREE.DoubleSide,depthWrite:false});materials.push(m);const r=new THREE.Mesh(ribbon(points,.2+i%3*.045,36),m);r.renderOrder=3;ribbons.push(r);group.add(r);});
  const crystalTriangles=[
    [[-.08,1.42,.12],[-.88,1.86,.08],[-1.7,2.28,-.18]],[[-.12,1.44,.14],[-1.18,1.58,.12],[-2.2,1.83,-.32]],[[-.2,1.38,.14],[-1.35,1.2,.18],[-2.34,1.28,-.3]],
    [[-.28,1.28,.18],[-1.38,.78,.25],[-2.25,.62,-.24]],[[-.4,1.12,.2],[-1.42,.26,.28],[-2.08,-.1,-.2]],[[-.52,.86,.18],[-1.36,-.34,.17],[-1.84,-.78,-.28]],
    [[.02,1.46,.16],[.72,1.92,.12],[1.48,2.16,-.12]],[[.06,1.43,.16],[1.1,1.66,.16],[2.02,1.8,-.28]],[[.16,1.38,.18],[1.28,1.28,.22],[2.22,1.34,-.32]],
    [[.28,1.24,.2],[1.38,.82,.3],[2.18,.66,-.24]],[[.4,1.04,.2],[1.42,.28,.28],[2.05,-.02,-.24]],[[.52,.78,.18],[1.34,-.4,.18],[1.78,-.92,-.3]],
    [[-.64,.15,.2],[-1.26,-.86,.12],[-1.42,-1.58,-.2]],[[.66,.1,.2],[1.23,-.92,.12],[1.35,-1.62,-.2]]
  ];
  const crystalColors=[p.magenta,p.violet,p.cyan,p.rose,p.amber];
  const crown=coloredTriangles(crystalTriangles,crystalColors,.82);crown.mesh.renderOrder=6;crystals.push(crown.mesh);materials.push(crown.material);group.add(crown.mesh);
  const shardMat=new THREE.MeshPhysicalMaterial({color:p.magenta,emissive:p.violet,emissiveIntensity:.7,metalness:.46,roughness:.13,transmission:0,transparent:true,opacity:.74,side:THREE.DoubleSide,depthWrite:false});
  [[-1.48,1.34,.06,-.42],[1.58,1.23,.02,.38],[-1.94,.75,-.35,-.55],[2.02,.46,-.39,.52],[-1.83,-.34,-.42,-.3],[1.73,-.63,-.45,.25],[-1.31,-1.22,-.36,-.18],[1.35,-1.3,-.38,.2]].forEach(([x,y,z,a],i)=>{const s=new THREE.Mesh(new THREE.ConeGeometry(.16+i%2*.05,.72+i%3*.12,3,1,false),shardMat);s.position.set(x,y,z);s.rotation.set(.2,a,a);shards.push(s);group.add(s);});
  const line=new THREE.LineBasicMaterial({color:p.ice,transparent:true,opacity:.24,blending:THREE.AdditiveBlending,depthWrite:false});
  for(let i=0;i<22;i++){const side=i%2?1:-1,lane=i/21,c=new THREE.CatmullRomCurve3(vec([[side*.06,1.54,.1],[side*(.5+lane*.34),1.48-lane*.2,.25],[side*(1.08+lane*.52),.72-lane*.35,.08],[side*(1.18+lane*.58),-.42-lane*.7,-.32]]));group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.getPoints(46)),line));}
  return{group,ribbons,shards,crystals,materials,line};
}

function faceFacets(p){
  const group=new THREE.Group(),materials=[];
  const vertices=[
    [-.72,1.13,.7],[-.22,1.5,.72],[.08,1.48,.76],[.7,1.08,.72],
    [-.82,.58,.88],[-.36,.72,1.16],[0,.84,1.2],[.38,.72,1.15],[.82,.58,.87],
    [-.78,.05,.96],[-.42,.18,1.25],[0,.28,1.42],[.44,.18,1.24],[.78,.05,.96],
    [-.66,-.46,.96],[-.34,-.36,1.24],[0,-.28,1.38],[.35,-.36,1.23],[.66,-.46,.95],
    [-.48,-.94,.88],[0,-1.2,1.03],[.5,-.94,.87]
  ];
  const tris=[[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,8,7],[4,5,10],[4,10,9],[5,6,11],[5,11,10],[6,7,12],[6,12,11],[7,8,13],[7,13,12],[9,10,15],[9,15,14],[10,11,16],[10,16,15],[11,12,17],[11,17,16],[12,13,18],[12,18,17],[14,15,19],[15,16,20],[15,20,19],[16,17,20],[17,18,21],[17,21,20]];
  const colors=[p.violet,p.magenta,p.cyan,p.rose,p.amber];
  const panels=tris.map(tri=>tri.map(index=>vertices[index])),merged=coloredTriangles(panels,colors,.7);merged.mesh.renderOrder=5;materials.push(merged.material);group.add(merged.mesh);return{group,materials};
}

function syntheticFeatures(p){const group=new THREE.Group(),speech=new THREE.Group();group.add(speech);const primary=new THREE.LineBasicMaterial({color:p.ice,transparent:true,opacity:.64,blending:THREE.AdditiveBlending,depthWrite:false}),secondary=new THREE.LineBasicMaterial({color:p.magenta,transparent:true,opacity:.2,blending:THREE.AdditiveBlending,depthWrite:false}),add=(points,m=primary,parent=group)=>parent.add(curve(points,m));
  add([[-.54,.43,1.03],[-.39,.37,1.18],[-.19,.4,1.09]]);add([[.54,.43,1.03],[.39,.37,1.18],[.19,.4,1.09]]);add([[-.58,.55,.9],[-.38,.64,1.04],[-.18,.59,1.03]],secondary);add([[.58,.55,.9],[.38,.64,1.04],[.18,.59,1.03]],secondary);
  add([[0,.82,.96],[-.03,.5,1.22],[-.03,.13,1.37],[-.14,-.04,1.27],[0,-.09,1.33],[.14,-.04,1.26]]);add([[-.31,-.45,1.1],[-.15,-.5,1.25],[0,-.48,1.3],[.15,-.5,1.25],[.31,-.45,1.1]],primary,speech);add([[-.27,-.52,1.09],[-.12,-.58,1.21],[0,-.59,1.24],[.12,-.58,1.21],[.27,-.52,1.09]],secondary,speech);add([[-.67,-.31,.87],[-.55,-.7,.94],[-.32,-1.02,1],[0,-1.17,1.05],[.32,-1.02,1],[.55,-.7,.94],[.67,-.31,.87]]);
  return{group,speech,primary,secondary};}
function makeHalo(p){const group=new THREE.Group(),material=new THREE.LineBasicMaterial({color:p.violet,transparent:true,opacity:.11,blending:THREE.AdditiveBlending,depthWrite:false});for(let i=0;i<4;i++){const e=new THREE.EllipseCurve(0,0,1.65+i*.18,1.86+i*.14,0,Math.PI*2,false,i*.32),points=e.getPoints(130).map(q=>new THREE.Vector3(q.x,q.y,-.72-i*.1)),line=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points),material);line.rotation.y=(i-1.5)*.13;group.add(line);}return{group,material};}
function ambient(p){const positions=[],random=rng(1106);for(let i=0;i<430;i++){const radius=2.2+random()*3.5,a=random()*Math.PI*2;positions.push(Math.cos(a)*radius,(random()-.5)*5.6,Math.sin(a)*radius-1.5);}const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));const material=new THREE.PointsMaterial({color:p.cyan,size:.012,transparent:true,opacity:.1,depthWrite:false,blending:THREE.AdditiveBlending});return{points:new THREE.Points(g,material),material};}
function ribbon(points,width,divisions){const c=new THREE.CatmullRomCurve3(vec(points)),positions=[],uvs=[],indices=[];for(let i=0;i<=divisions;i++){const t=i/divisions,q=c.getPoint(t),tangent=c.getTangent(t).normalize();let side=new THREE.Vector3().crossVectors(tangent,new THREE.Vector3(0,0,1)).normalize();if(side.lengthSq()<.1)side.set(1,0,0);const half=width*(Math.sin(Math.PI*Math.pow(t,.82))*.82+.08)*(1+Math.sin(t*Math.PI*3)*.14);positions.push(q.x+side.x*half,q.y+side.y*half,q.z+side.z*half,q.x-side.x*half,q.y-side.y*half,q.z-side.z*half);uvs.push(t,0,t,1);if(i<divisions){const a=i*2;indices.push(a,a+2,a+1,a+2,a+3,a+1);}}const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));g.setAttribute("uv",new THREE.Float32BufferAttribute(uvs,2));g.setIndex(indices);g.computeVertexNormals();return g;}
function coloredTriangles(triangles,colors,opacity){const positions=[],vertexColors=[];triangles.forEach((tri,i)=>{const c=new THREE.Color(colors[i%colors.length]);tri.forEach(point=>{positions.push(...point);vertexColors.push(c.r,c.g,c.b);});});const geometry=new THREE.BufferGeometry();geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute("color",new THREE.Float32BufferAttribute(vertexColors,3));geometry.computeVertexNormals();const material=new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,opacity,side:THREE.DoubleSide,depthWrite:false,blending:THREE.AdditiveBlending});return{mesh:new THREE.Mesh(geometry,material),material};}
function curve(points,material){const c=new THREE.CatmullRomCurve3(vec(points));return new THREE.Line(new THREE.BufferGeometry().setFromPoints(c.getPoints(34)),material);}
function canvasFallback(root,p){const m=new THREE.MeshPhysicalMaterial({color:p.violet,emissive:p.magenta,transparent:true,opacity:.62,flatShading:true,wireframe:false});const head=new THREE.Mesh(new THREE.IcosahedronGeometry(1.1,3),m);head.scale.set(.76,1.16,.82);root.add(head);}
function vec(points){return points.map(([x,y,z])=>new THREE.Vector3(x,y,z));}function clamp(x){return Math.max(0,Math.min(1,Number(x)||0));}function rng(seed){let v=seed>>>0;return()=>{v=(v*1664525+1013904223)>>>0;return v/4294967296;};}
function fallback(error){const api=Object.freeze({start:()=>api,stop:()=>api,setState:()=>api,setView:()=>api,getState:()=>"error",metrics:()=>({fps:0,triangles:0,calls:0,webgl:false,error:error?.message||"WebGL unavailable"}),capture:()=>null,dispose(){}});return api;}
