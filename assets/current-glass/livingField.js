import * as THREE from '../vendor/three.module.min.js';

// Fixed GPU particle sheets: no per-frame allocations or CPU particle simulation.
export function createLivingField(scene) {
  const count=2*3*100*32, data=new Float32Array(count*3);let k=0;
  for(const side of [-1,1])for(let layer=0;layer<3;layer++)for(let row=0;row<32;row++)for(let col=0;col<100;col++)
    data.set([(col+.37*(row%2))/100,row/31,side*(layer+1)],k++*3);
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(data,3));
  const uniforms={uTime:{value:0},uMix:{value:0},uAurora:{value:0},uSpan:{value:4},uListen:{value:0},uSpeak:{value:0},uArrival:{value:0},uRatio:{value:1},uBorn:{value:new THREE.Vector3(-10,-10,-10)},uStrength:{value:new THREE.Vector3()}};
  const material=new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,
    vertexShader:`uniform float uTime,uMix,uAurora,uSpan,uListen,uSpeak,uArrival,uRatio;uniform vec3 uBorn,uStrength;
      varying float vLight,vGold,vAlpha;
      float pulse(float d,float born,float strength){float age=uTime-born;return exp(-pow((d-age*1.9)/.22,2.))*strength*step(0.,age)*(1.-smoothstep(1.7,3.4,age));}
      void main(){float u=position.x,v=position.y,side=sign(position.z),layer=abs(position.z)-1.;
        float t=uTime*(.36+layer*.065);float x=.70+u*(uSpan-.70);
        float y=.20+v*.83+u*.80+sin(u*7.-t+layer*.9+v*2.)*.22+sin(u*13.+t*.6+v*4.)*.07;
        float z=-.72-layer*.72+v*.32;
        vec3 tide=vec3(x*side,y,z);
        vec3 aurora=vec3(side*(.84+u*(uSpan-.84)+sin(v*5.-t+u*3.+layer)*.36),.10+v*2.8+sin(u*4.+t*.4)*.15,-1.-layer*.85+sin(v*5.+u*3.-t)*.34);
        vec3 p=mix(tide,aurora,uAurora);
        float d=length(vec2(p.x,(p.y-1.12)*.7));
        float wave=pulse(d,uBorn.x,uStrength.x)+pulse(d,uBorn.y,uStrength.y)+pulse(d,uBorn.z,uStrength.z);
        float gather=pow(.5+.5*cos(d*7.+uTime*2.5),9.)*max(uListen,uArrival*.9);
        float ridge=mix(pow(.5+.5*sin(v*19.+sin(u*7.-t)*1.5+layer*2.),14.),pow(.5+.5*sin(u*24.+sin(v*5.-t)*2.+layer*2.),12.),uAurora);
        float stream=pow(.5+.5*sin(u*11.-uTime*.55+v*3.+layer),10.);
        float sparkle=.55+.45*fract(sin(dot(position.xy+layer,vec2(127.1,311.7)))*43758.5453);
        vGold=clamp(ridge*(.48+stream*.50)+wave*.90,0.,1.);
        vLight=(.38+ridge*2.1+stream*.35+gather*1.3+wave*2.1)*sparkle;
        float faceClear=1.-(1.-smoothstep(.70,1.10,abs(p.x)))*smoothstep(1.28,1.7,p.y);
        vAlpha=uMix*faceClear*mix(1.,smoothstep(0.,.12,v)*(1.-smoothstep(.82,1.,v)),uAurora)*(.58-layer*.10)*(.4+smoothstep(0.,.14,u)*.6);
        vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
        gl_PointSize=clamp((2.2+ridge*2.1+wave*1.1)*uRatio*7./max(3.,-mv.z),1.,5.);
      }`,
    fragmentShader:`varying float vLight,vGold,vAlpha;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;
      float soft=1.-smoothstep(.12,.5,d);vec3 emerald=vec3(.002,.48,.20),gold=vec3(.95,.57,.16);
      gl_FragColor=vec4(mix(emerald,gold,vGold)*vLight,soft*vAlpha);
      #include <colorspace_fragment>
    }`});
  const points=new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=0;scene.add(points);
  return {update(name,time,dt,aspect,listen,speak,born,strength,arrival,pixelRatio){
    const enabled=name==='tides'||name==='aurora',ease=1-Math.exp(-dt*5);
    uniforms.uMix.value+=((enabled?1:0)-uniforms.uMix.value)*ease;
    points.visible=uniforms.uMix.value>.001;
    uniforms.uAurora.value+=((name==='aurora'?1:0)-uniforms.uAurora.value)*ease;
    uniforms.uTime.value=time;uniforms.uSpan.value=Math.max(1.75,Math.min(6,aspect*3.3));
    uniforms.uListen.value=listen;uniforms.uSpeak.value=speak;uniforms.uArrival.value=arrival;uniforms.uRatio.value=pixelRatio;
    uniforms.uBorn.value.fromArray(born);uniforms.uStrength.value.fromArray(strength);
  }};
}

// Targets are sampled from the existing transformed GLB triangles, including its hair.
export function createAssemblyParticles(geometry,bust){
  const pos=geometry.getAttribute('position'),indices=geometry.index?.array;
  const triangles=(indices?.length||pos.count)/3,areas=new Float32Array(triangles);
  const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();let area=0;
  for(let i=0;i<triangles;i++){a.fromBufferAttribute(pos,indices?indices[i*3]:i*3);b.fromBufferAttribute(pos,indices?indices[i*3+1]:i*3+1);c.fromBufferAttribute(pos,indices?indices[i*3+2]:i*3+2);area+=b.sub(a).cross(c.sub(a)).length();areas[i]=area;}
  let seed=7419;const rand=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const count=8500,targets=new Float32Array(count*3),seeds=new Float32Array(count);
  for(let i=0;i<count;i++){const at=rand()*area;let low=0,high=triangles-1;while(low<high){const m=(low+high)>>1;if(areas[m]<at)low=m+1;else high=m;}
    const t=low*3;a.fromBufferAttribute(pos,indices?indices[t]:t);b.fromBufferAttribute(pos,indices?indices[t+1]:t+1);c.fromBufferAttribute(pos,indices?indices[t+2]:t+2);
    const r=Math.sqrt(rand()),q=rand();a.multiplyScalar(1-r).addScaledVector(b,r*(1-q)).addScaledVector(c,r*q);targets.set([a.x,a.y,a.z+.008],i*3);seeds[i]=rand();}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(targets,3));g.setAttribute('aSeed',new THREE.BufferAttribute(seeds,1));
  const uniforms={uProgress:{value:1},uTime:{value:0},uRatio:{value:1}};
  const mat=new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,depthTest:false,blending:THREE.AdditiveBlending,
    vertexShader:`attribute float aSeed;uniform float uProgress,uTime,uRatio;varying float vAlpha,vGold;
      void main(){float side=position.x<0.?-1.:1.;float delay=position.y*.065+aSeed*.09;
        float gather=smoothstep(delay,.66+delay,uProgress);
        vec3 start=vec3(side*(2.5+aSeed*2.8),.10+fract(aSeed*41.73)*2.8,-.5-fract(aSeed*17.31)*1.4);
        vec3 p=mix(start,position,gather);float arc=sin(gather*3.14159);
        p.y+=arc*(.30+.65*aSeed);p.z+=sin(gather*6.28+aSeed*12.)*arc*.35;
        p.x+=sin(uTime*1.5+aSeed*30.)*(1.-gather)*.12;
        float collected=smoothstep(.78,.95,gather);
        vAlpha=smoothstep(0.,.06,uProgress)*(1.-smoothstep(.84,1.,uProgress))*(.38+collected*.62);
        vGold=step(.88,aSeed)*(.3+collected*.7);
        vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
        gl_PointSize=clamp((1.5+aSeed*1.9)*uRatio*6./max(3.,-mv.z),1.,4.);
      }`,
    fragmentShader:`varying float vAlpha,vGold;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;gl_FragColor=vec4(mix(vec3(.03,.94,.55),vec3(1.,.79,.40),vGold),(1.-smoothstep(.12,.5,d))*vAlpha);
      #include <colorspace_fragment>
    }`});
  const points=new THREE.Points(g,mat);points.renderOrder=3;points.frustumCulled=false;points.visible=false;bust.add(points);
  return {update(progress,time,ratio){points.visible=progress<1;uniforms.uProgress.value=progress;uniforms.uTime.value=time;uniforms.uRatio.value=ratio;}};
}
