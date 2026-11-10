import * as THREE from '../vendor/three.module.min.js';
import {TIDE_PULSE_GLSL} from './tideTiming.js';
// Shared field coordinates for the entrance, near/far waves and filament exits.
export const TIDE_FIELD_GLSL=`vec3 tidePoint(float u,float v,float side,float layer,float time,float span){
 float t=time*(layer<.5?.32:.15);float x=.88+u*(span-.88);
 float y=.50+v*.66+layer*.26+u*.65+sin(u*6.2-t+layer*.7+v)*(.22+u*.17)+sin(u*12.+t*.4+v*3.)*.045;
 return vec3(side*x,y,-.50-layer*1.05+v*.22);}`;
export function createEmeraldTide(scene){
 const uniforms={uTime:{value:0},uSpan:{value:4},uMix:{value:0},uListen:{value:0},uRatio:{value:1},uArrival:{value:0},uBust:{value:new THREE.Matrix4()},uTideBorn:{value:new Float32Array(8).fill(-100)},uTideStrength:{value:new Float32Array(8)}};
 const data=[];for(const side of [-1,1])for(let layer=0;layer<2;layer++)for(let row=0;row<44;row++)for(let col=0;col<128;col++)data.push(col/127,row/43,side*(layer+1));
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(data,3));
 const material=new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
 vertexShader:`uniform float uTime,uSpan,uMix,uListen,uRatio,uArrival;varying float vAlpha,vLight,vGold;
 ${TIDE_PULSE_GLSL}
 ${TIDE_FIELD_GLSL}
 void main(){float u=position.x,v=position.y,side=sign(position.z),layer=abs(position.z)-1.;vec3 p=tidePoint(u,v,side,layer,uTime,uSpan);
 float crest=pow(.5+.5*cos(v*24.+sin(u*7.-uTime*.25+layer)*1.6),12.);
 float pulse=tideAt(1.70+u*1.85+layer*.46)*(layer<.5?1.:.42)*(.14+crest*.86);
 float inward=pow(.5+.5*cos(u*15.+uTime*3.4+layer*.8),10.)*uListen;
 float shimmer=.65+.35*sin(u*61.+v*113.+layer*2.);
 float entry=1.-uArrival*.42;
 vGold=clamp(pulse*.9+crest*.18,0.,.95);
 vLight=(.34+crest*1.40+inward*.85+pulse*1.5)*shimmer*(layer<.5?1.:.48);
 float edge=smoothstep(0.,.06,v)*(1.-smoothstep(.90,1.,v));
 float faceClear=1.-(1.-smoothstep(.75,1.1,abs(p.x)))*smoothstep(1.28,1.65,p.y);
 vAlpha=uMix*edge*faceClear*entry*smoothstep(0.,.09,u)*(layer<.5?.78:.42);
 vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp((2.0+crest*1.7+pulse*.8)*uRatio*7./max(3.,-mv.z),1.,4.8);
 }`,fragmentShader:`varying float vAlpha,vLight,vGold;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;float a=1.-smoothstep(.08,.5,d);gl_FragColor=vec4(mix(vec3(.002,.58,.24),vec3(1.,.70,.27),vGold)*vLight,a*vAlpha);
 #include <colorspace_fragment>
 }`});
 const field=new THREE.Points(geometry,material);field.frustumCulled=false;field.renderOrder=0;scene.add(field);
 let bridges=null,bodyLight=null;
 return {attach(exits){
 const bodyPoints=[],travel=[];for(const e of exits)for(let i=0;i<100;i++){bodyPoints.push(...e.curve.getPointAt(i/99).toArray());travel.push(.10+i/99*.95);}
 const bodyGeo=new THREE.BufferGeometry();bodyGeo.setAttribute("position",new THREE.Float32BufferAttribute(bodyPoints,3));bodyGeo.setAttribute("aTravel",new THREE.Float32BufferAttribute(travel,1));
 const bodyMat=new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexShader:`uniform float uTime,uMix,uRatio;uniform mat4 uBust;attribute float aTravel;varying float vPulse;${TIDE_PULSE_GLSL}
 void main(){vPulse=tideAt(aTravel)*uMix;vec4 mv=viewMatrix*uBust*vec4(position,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp((2.2+vPulse*3.)*uRatio*7./max(3.,-mv.z),1.,5.);}`,fragmentShader:`varying float vPulse;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;gl_FragColor=vec4(1.,.68,.25,min(vPulse,.9)*(1.-smoothstep(.05,.5,d)));
 #include <colorspace_fragment>
 }`});bodyLight=new THREE.Points(bodyGeo,bodyMat);bodyLight.frustumCulled=false;bodyLight.renderOrder=.81;scene.add(bodyLight);
 const positions=[],tips=[],sides=[];for(const e of exits)for(let i=0;i<80;i++){positions.push(i/79,0,0);tips.push(...e.tip.toArray());sides.push(e.side,(e.index+.5)/3);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('aTip',new THREE.Float32BufferAttribute(tips,3));g.setAttribute('aSide',new THREE.Float32BufferAttribute(sides,2));
 const m=new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,vertexShader:`uniform float uTime,uSpan,uMix,uRatio,uListen;uniform mat4 uBust;attribute vec3 aTip;attribute vec2 aSide;varying float vAlpha,vGold;
 ${TIDE_PULSE_GLSL}
 ${TIDE_FIELD_GLSL}
 void main(){float t=position.x;vec3 a=(uBust*vec4(aTip,1.)).xyz;vec3 d=tidePoint(0.,aSide.y,aSide.x,0.,uTime,uSpan);
 vec3 b=a+vec3(aSide.x*.15,-.015,-.12);vec3 c=d+vec3(-aSide.x*.18,-.16,.08);
 vec3 p=pow(1.-t,3.)*a+3.*pow(1.-t,2.)*t*b+3.*(1.-t)*t*t*c+t*t*t*d;
 float pulse=tideAt(1.05+t*.65);float inward=pow(.5+.5*cos(t*7.+uTime*3.4),8.)*uListen;
 vAlpha=uMix*(pulse*.82+inward*.10);vGold=clamp(pulse,0.,1.);vec4 mv=viewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;gl_PointSize=clamp((2.+pulse*1.8)*uRatio*7./max(3.,-mv.z),1.,4.8);
 }`,fragmentShader:`varying float vAlpha,vGold;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;gl_FragColor=vec4(mix(vec3(.01,.55,.25),vec3(1.,.76,.36),vGold),vAlpha*(1.-smoothstep(.12,.5,d)));
 #include <colorspace_fragment>
 }`});bridges=new THREE.Points(g,m);bridges.frustumCulled=false;bridges.renderOrder=.78;scene.add(bridges);},
 update(enabled,time,dt,aspect,listen,arrival,ratio,clock,bust){uniforms.uMix.value+=((enabled?1:0)-uniforms.uMix.value)*(1-Math.exp(-dt*7));field.visible=uniforms.uMix.value>.001;if(bridges)bridges.visible=field.visible;if(bodyLight)bodyLight.visible=field.visible;
 uniforms.uTime.value=time;uniforms.uSpan.value=Math.max(1.85,Math.min(5.8,aspect*3.3));uniforms.uListen.value=listen;uniforms.uArrival.value=arrival;uniforms.uRatio.value=ratio;uniforms.uTideBorn.value=clock.born;uniforms.uTideStrength.value=clock.strength;bust.updateMatrixWorld();uniforms.uBust.value.copy(bust.matrixWorld);
 }};
}
