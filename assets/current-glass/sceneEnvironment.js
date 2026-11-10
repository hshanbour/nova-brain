import * as THREE from '../vendor/three.module.min.js';

// One inexpensive background draw, no post-processing or additional render loop.
// Scene selection is visual state only: it never owns or restarts Voice Mode.
export const GLASS_SCENES = Object.freeze([
  ['baseline', 'Current Glass'], ['studio', 'Emerald Studio'],
  ['chamber', 'Reflective Chamber'], ['halo', 'Living Halo'],
  ['emerald','Emerald Tide'], ['tides','Tidal Currents · before'], ['aurora','Aurora Weave'],
]);
export function createSceneEnvironment(scene) {
  const uniforms = { uTime:{value:0}, uAspect:{value:1}, uWeights:{value:new THREE.Vector3()},
    uListen:{value:0}, uSpeak:{value:0}, uPrepare:{value:0} };
  const material = new THREE.ShaderMaterial({depthWrite:false, depthTest:false, uniforms,
    vertexShader:`varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,1.,1.);}`,
    fragmentShader:`varying vec2 vUv;uniform float uTime,uAspect,uListen,uSpeak,uPrepare;uniform vec3 uWeights;
      float glow(vec2 p,vec2 c,vec2 size){return exp(-dot((p-c)/size,(p-c)/size));}
      void main(){
        vec2 p=vUv-.5;p.x*=uAspect;
        vec3 emerald=vec3(.025,.30,.18),gold=vec3(.55,.33,.12);
        float breath=.92+.08*sin(uTime*.65);
        vec3 base=vec3(.0006,.0021,.0018);
        // Studio: two broad softboxes, with a quiet listening light on the left.
        vec3 studio=emerald*glow(p,vec2(-.43,.14),vec2(.28,.64))*(.23+uListen*.19);
        studio+=gold*glow(p,vec2(.44,.08),vec2(.25,.55))*(.07+uSpeak*.10);
        studio+=emerald*glow(p,vec2(0.,.15),vec2(.6,.7))*.055;
        // Chamber: receding curved walls, a horizon and an elliptical reflection.
        float roomX=p.x/min(1.,uAspect*.85);
        float wall=exp(-pow((abs(roomX)-(.50+p.y*.20))/.018,2.));
        float outer=exp(-pow((abs(roomX)-(.76+p.y*.32))/.028,2.));
        vec3 room=emerald*(wall*.16+outer*.07)*smoothstep(-.4,-.28,p.y);
        room+=emerald*glow(p,vec2(0.,.17),vec2(.65,.57))*(.095+uListen*.07);
        room+=gold*glow(p,vec2(0.,-.40),vec2(.43,.043))*(.27+uSpeak*.19);
        room+=gold*glow(p,vec2(0.,-.32),vec2(.20,.13))*.045;
        room+=emerald*exp(-pow((p.y+.39)/.003,2.))*.045;
        // Halo: a breathing elliptical light field, never a full-screen flash.
        vec2 h=p-vec2(0.,.10);h.x*=.89;
        float r=length(h),a=atan(h.y,h.x),radius=min(.35,uAspect*.46)+.006*sin(uTime*.55);
        float ring=exp(-pow((r-radius)/.0035,2.));
        float veil=exp(-pow((r-radius)/.045,2.));
        float arc=pow(.5+.5*sin(a*2.-uTime*.23),7.);
        float inner=exp(-pow((r-radius+.025+.004*sin(a*3.+uTime*.28))/.0017,2.));
        vec3 halo=emerald*(ring*.42+veil*.10+inner*.10)*(1.+uListen*.65);
        halo+=gold*(ring+veil*.12)*arc*(.22+uSpeak*.45+uPrepare*.15);
        halo+=emerald*glow(p,vec2(0.,.1),vec2(.34,.37))*.025;
        vec3 color=base+(studio*uWeights.x+room*uWeights.y+halo*uWeights.z)*breath;
        gl_FragColor=vec4(color,1.);
        #include <colorspace_fragment>
      }` });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2,2), material);
  mesh.frustumCulled=false;mesh.renderOrder=-100;scene.add(mesh);
  const target=new THREE.Vector3();
  return { update(name,time,dt,aspect,listen,speak,prepare){
    target.set(name==='studio'?1:(name==='emerald'?.24:(name==='tides'||name==='aurora'?.16:0)),name==='chamber'?1:0,name==='halo'?1:0);
    uniforms.uWeights.value.lerp(target,1-Math.exp(-dt*5));
    uniforms.uTime.value=time;uniforms.uAspect.value=aspect;
    uniforms.uListen.value=listen;uniforms.uSpeak.value=speak;uniforms.uPrepare.value=prepare;
  }};
}
