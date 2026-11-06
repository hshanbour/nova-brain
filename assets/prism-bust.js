import * as T from './vendor/three.module.min.js';
import {GLTFLoader} from './vendor/loaders/GLTFLoader.js';
import {prismLocks} from './prism-locks.js';
import {rest} from './prism-articulation.js';

const vs=`
attribute vec2 uv1,uv2;
varying vec2 originalUV,frontUV,visible;
varying vec3 n;
uniform vec4 lips;uniform float blink,gaze;
void main(){
 originalUV=uv;frontUV=uv1;visible=uv2;n=normal;
 vec3 p=position;
 // Displace the actual contiguous mesh; both texture coordinates remain attached to each vertex.
 float x=p.x-.0625,y=p.y;float front=smoothstep(.28,.56,p.z);
 float mouth=exp(-x*x*28.-y*y*160.)*front;
 float lower=1.-smoothstep(-.025,.025,y);
 p.y-=mouth*(lower*.046+(1.-lower)*-.012)*lips.x;
 p.x+=mouth*x*(.18*lips.z-.24*lips.y);
 p.z+=mouth*.033*lips.y;
 float lids=exp(-pow(abs((abs(x)-.27)/.13),2.)-pow(abs((y-.535)/.055),2.))*front;
 p.y-=lids*blink*.023;p.x+=lids*gaze*.007;
 gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
}`;
const fs=`
uniform sampler2D plate,contact,edgeMaterial;uniform float fraction,energy,thinLock,uncovered;
varying vec2 originalUV,frontUV,visible;varying vec3 n;
void main(){
 vec3 N=normalize(n);
 float a=smoothstep(.06,.70,visible.x)*smoothstep(-.12,.24,dot(N,vec3(-.559,0.,.829)));
 float b=smoothstep(.06,.70,visible.y)*smoothstep(-.12,.24,N.z);
 // Prefer the photograph for this viewpoint. Use the alternate only for uncovered geometry.
 float wA=a*((1.-fraction)+fraction*(1.-b)),wB=b*(fraction+(1.-fraction)*(1.-a));
 vec3 ob=texture2D(plate,originalUV).rgb,fr=texture2D(contact,frontUV).rgb;
 float sum=wA+wB;vec3 surface=(ob*wA+fr*wB)/max(.00001,sum);
 vec3 glass=vec3(.019,.010,.038)+vec3(.15,.077,.21)*pow(max(dot(N,normalize(vec3(-.64,.79,.49))),0.),7.);
 if(thinLock>.5 && max(max(surface.r,surface.g),surface.b)<.017)discard;
 vec3 radiance=mix(glass,surface,smoothstep(.002,.12,sum));
 float side=uncovered*smoothstep(.22,.83,N.x)*(1.-thinLock)*(1.-smoothstep(.02,.095,max(max(radiance.r,radiance.g),radiance.b)));
 vec3 edge=texture2D(edgeMaterial,frontUV).rgb*.68;
 gl_FragColor=vec4(mix(radiance,edge,side)*(1.+energy*.026),1.);
 #include <colorspace_fragment>
}`;
export function createPrismBust({canvas,mouth=()=>rest,outputLevel=()=>0,attention=()=>null}){
 let renderer,root,scene,cam,mat,ribbonMat,textures=[],loading=false,failed=false,active=false,resolution=1,state='idle',frame=0,disposed=false,yaw=34,manual=null,fps=0,frames=0,since=0,last=0;
 let reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 function queue(){if(!disposed&&active&&root&&!frame&&!document.hidden)frame=requestAnimationFrame(render);}
 function render(t){
  frame=0;if(!active||disposed||document.hidden)return;
  if(last&&t-last<32){queue();return;}
  const dt=last?Math.min(.1,(t-last)/1000):.033;last=t;
  const focus=attention(),target=manual??(state==='idle'?34:state==='thinking'?12:state==='executing'?16:focus==null?1:T.MathUtils.clamp((.5-focus)*29,-12,16));
  yaw+=(target-yaw)*(1-Math.exp(-dt*(reduced?10:3.4)));
  root.rotation.y=yaw*Math.PI/180;root.rotation.x=reduced?0:.008*Math.sin(t*.0017);root.rotation.z=reduced?0:.006*Math.sin(t*.0013);
  mat.uniforms.uncovered.value=T.MathUtils.smoothstep(-yaw,0,11);
  mat.uniforms.fraction.value=1-T.MathUtils.smoothstep(yaw,0,34);
  const s=state==='speaking'?(mouth()||rest):rest;
  mat.uniforms.lips.value.set(s.open||0,s.round||0,s.wide||0,s.seal||0);
  mat.uniforms.gaze.value=focus==null?0:(.5-focus)*2;
  mat.uniforms.blink.value=reduced?0:Math.pow(Math.max(0,Math.cos(t*.00137)),180);
  mat.uniforms.energy.value=state==='speaking'?outputLevel():state==='executing'?.7+.3*Math.sin(t*.005):0;
  const w=Math.max(1,Math.min(800,Math.round(canvas.clientWidth*resolution*(devicePixelRatio>1?1.2:1)))),h=Math.round(w*1199/1312);
  if(canvas.width!==w||canvas.height!==h)renderer.setSize(w,h,false);
  renderer.render(scene,cam);canvas.dataset.prismFrame='bust';canvas.dataset.yaw=yaw.toFixed(1);canvas.dataset.fps=String(fps);
  frames++;if(t-since>=1000){fps=Math.round(frames*1000/(t-since));if(frames>=2&&since>0){if(fps<17)resolution=Math.max(.38,resolution*.8);else if(fps>=27)resolution=Math.min(1,resolution+.035);}frames=0;since=t;}queue();
 }
 async function init(){
  if(root||loading||failed||disposed)return;loading=true;
  try{
    renderer=new T.WebGLRenderer({canvas,antialias:false,alpha:true,powerPreference:'low-power'});renderer.setClearColor(0x0c0b12,1);
    const g=await new GLTFLoader().loadAsync('/assets/models/prism-bust.glb');
    textures=await Promise.all([g.parser.getDependency("texture",0),g.parser.getDependency("texture",1),new T.TextureLoader().loadAsync("/assets/models/prism-edge.jpg")]);if(disposed)return;
    textures.forEach(t=>{t.flipY=false;t.colorSpace=T.SRGBColorSpace;t.needsUpdate=true;});
    mat=new T.ShaderMaterial({side:T.DoubleSide,uniforms:{plate:{value:textures[0]},contact:{value:textures[1]},edgeMaterial:{value:textures[2]},uncovered:{value:0},fraction:{value:0},lips:{value:new T.Vector4()},energy:{value:0},thinLock:{value:0},blink:{value:0},gaze:{value:0}},vertexShader:vs,fragmentShader:fs});
    scene=new T.Scene();cam=new T.OrthographicCamera(-1.9,1.38,1.5,-1.4975,.1,30);cam.position.z=8;
    root=g.scene;root.traverse(o=>{if(o.isMesh){o.material.dispose();o.material=mat;}});const fine=prismLocks();ribbonMat=new T.ShaderMaterial({side:T.DoubleSide,vertexShader:vs,fragmentShader:fs,uniforms:{...mat.uniforms,thinLock:{value:1}}});fine.traverse(o=>{if(o.isMesh){o.material.dispose();o.material=ribbonMat;}});root.add(fine);scene.add(root);queue();
  }catch{failed=true;renderer?.dispose();}finally{loading=false;}
 }
 const api={start(){if(disposed)return;active=true;void init();queue();},stop(){active=false;cancelAnimationFrame(frame);frame=0;last=0;},
 setState(s){state=s;queue();},setAngle(v){manual=Number.isFinite(v)?T.MathUtils.clamp(v,-16,34):null;queue();},
 metrics:()=>({ready:!!root,failed,fps,state,yaw}),dispose(){disposed=true;api.stop();document.removeEventListener('visibilitychange',queue);root?.traverse(o=>o.geometry?.dispose());mat?.dispose();ribbonMat?.dispose();textures.forEach(t=>t.dispose());renderer?.dispose();}};
 document.addEventListener('visibilitychange',queue);return api;
}
