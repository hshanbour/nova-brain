import * as THREE from "./vendor/three.module.min.js";

const artwork = "/assets/models/prism-shard-bloom.png";
const width = 1312, height = 1199;
const states = new Set(["listening", "thinking", "speaking", "executing"]);

// A continuous picture mesh shares vertices across the translucent ribbons.
// Landmark weights are in original artwork pixels. The border stays pinned.
const vertexShader = `
  varying vec2 pictureUV;
  uniform vec2 fit;
  uniform vec4 pose;     // turn, roll, lift, ribbon drag
  uniform vec4 face;     // jaw opening, lip rounding, attentive brow, breathing
  uniform float time;
  float region(vec2 p, vec2 centre, vec2 radius) {
    vec2 d = (p - centre) / radius;
    return 1.0 - smoothstep(0.0, 1.0, dot(d,d));
  }
  void main() {
    pictureUV = uv;
    vec2 p = vec2(uv.x * 1312.0, (1.0 - uv.y) * 1199.0);
    vec2 q = p;
    float head = region(p,vec2(840.,425.),vec2(660.,530.));
    float neck = region(p,vec2(740.,866.),vec2(280.,245.));
    float nose = region(p,vec2(983.,485.),vec2(165.,210.));
    float hair = region(p,vec2(342.,357.),vec2(562.,455.));
    float shoulder = region(p,vec2(650.,1090.),vec2(620.,220.));
    float edge = smoothstep(0.,85.,min(min(p.x,1312.-p.x),min(p.y,1199.-p.y)));
    vec2 pivot = p - vec2(758.,900.);
    // Rotate from the base of the neck; depth changes the apparent yaw.
    q += vec2(-pivot.y,pivot.x) * pose.y * (head + .38 * neck);
    q.x += pose.x * (head * 24. + nose * 13. + neck * 6.);
    q.y += pose.z * (head * 13. + neck * 4.);
    q += hair * vec2(19.*pose.w, -12.*pose.w + 5.*sin(time*1.35+p.x*.005)*abs(pose.w));
    q.y -= shoulder * face.w * 5.;
    // Opening separates the visible lips around their existing, sloped seam.
    float seam = 609. + (p.x-944.)*.14;
    float lip = region(p,vec2(944.,613.),vec2(82.,46.));
    float lower = smoothstep(-5.,12.,p.y-seam);
    q.y += lip * face.x * mix(-2.4,10.5,lower);
    q.y += region(p,vec2(936.,716.),vec2(104.,105.)) * 6. * face.x;
    q.x -= lip * (p.x-944.) * .085 * face.y;
    q.y -= region(p,vec2(877.,360.),vec2(108.,43.)) * face.z * 5.;
    q.y -= region(p,vec2(1040.,371.),vec2(62.,44.)) * face.z * 3.;
    q = mix(p,q,edge);
    gl_Position = vec4((q / vec2(1312.,1199.) * 2. - 1.) * vec2(1.,-1.) * fit,0.,1.);
  }`;

const fragmentShader = `
  uniform sampler2D picture;
  uniform float travelling;
  uniform float time;
  varying vec2 pictureUV;
  void main() {
    vec4 colour = texture2D(picture,pictureUV);
    float band = max(0.,1.-abs(fract(time*.35+pictureUV.y*.9)-.5)*12.);
    float highlight = smoothstep(.50,.85,max(colour.r,max(colour.g,colour.b)));
    colour.rgb += colour.rgb * (.13*travelling*band*highlight);
    gl_FragColor = colour;
  }`;

export function createNovaPrismAvatar({canvas, inputLevel=()=>0, outputLevel=()=>0}={}) {
  let state="idle", active=false, frame=0, last=0, elapsed=0, disposed=false;
  let renderer, mesh, texture, material, failed=false, ready=false;
  let turn=0, roll=0, lift=0, drag=0, jaw=0, round=0, brow=0, travel=0;
  let frames=0, sampleTime=0, fps=0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const scene=new THREE.Scene(), camera=new THREE.Camera();
  const uniforms={
    picture:{value:null}, fit:{value:new THREE.Vector2(1,1)},
    pose:{value:new THREE.Vector4()}, face:{value:new THREE.Vector4()},
    time:{value:0}, travelling:{value:0}
  };

  function initialize() {
    if(renderer || failed) return;
    try {
      renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:false,powerPreference:"low-power"});
      renderer.setClearColor(0x000000,0);
      renderer.setPixelRatio(Math.min(devicePixelRatio || 1,1.5));
      material=new THREE.ShaderMaterial({uniforms,vertexShader,fragmentShader,depthTest:false,depthWrite:false});
      mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2,164,150),material);
      mesh.frustumCulled=false;
      scene.add(mesh);
      texture=new THREE.TextureLoader().load(artwork,()=>{
        if(disposed) return;
        ready=true;
        schedule();
      },undefined,()=>{failed=true;});
      texture.generateMipmaps=false;
      texture.minFilter=THREE.LinearFilter;
      uniforms.picture.value=texture;
    } catch { failed=true; }
  }

  function schedule() {
    if(!active || !ready || failed || disposed || frame || document.hidden || state==="idle") return;
    frame=requestAnimationFrame(draw);
  }

  function draw(now) {
    frame=0;
    if(!active || document.hidden || state==="idle") return;
    if(last && now-last<1000/32-1) {schedule();return;}
    const dt=Math.min(.08,(now-(last||now-16))/1000);
    last=now; elapsed+=dt;
    const {width:w,height:h}=canvas.getBoundingClientRect();
    if(!w || !h) return;
    const ratio=renderer.getPixelRatio();
    if(canvas.width!==Math.floor(Math.round(w)*ratio) || canvas.height!==Math.floor(Math.round(h)*ratio))
      renderer.setSize(Math.round(w),Math.round(h),false);
    const aspect=(w/h)/(width/height);
    uniforms.fit.value.set(Math.min(1,1/aspect),Math.min(1,aspect));

    const speaking=state==="speaking", listening=state==="listening";
    const volume=Math.min(1,Math.max(0,(speaking?outputLevel():listening?inputLevel():0)||0));
    const signal=Math.min(1,Math.sqrt(volume)*1.32);
    const ease=(current,target,rate)=>current+(target-current)*(1-Math.exp(-rate*dt));
    const wave=Math.sin(elapsed*.94);
    const targetTurn=listening?.48+.24*signal:state==="thinking"?-.59:speaking?.18+.31*signal:-.26;
    turn=ease(turn,targetTurn+.14*wave,4);
    roll=ease(roll,(listening?-.031:state==="thinking"?.038:speaking?-.012:.018)+.009*wave,4);
    lift=ease(lift,listening?-.28-signal*.32:speaking?.42*signal:state==="thinking"?-.48:.14,5);
    drag=ease(drag,-turn*.86+Math.sin(elapsed*1.16-.8)*.36,2.8);
    jaw=ease(jaw,speaking?signal:0,signal>jaw?31:22);
    round=ease(round,speaking?signal:0,7);
    brow=ease(brow,listening?.55+signal*.4:state==="thinking"?.75:speaking?signal*.32:0,6);
    travel=ease(travel,state==="executing"?1:state==="thinking"?.38:0,5);
    const gain=reduced.matches?.22:1;
    uniforms.pose.value.set(turn,roll,lift,drag).multiplyScalar(gain);
    uniforms.face.value.set(jaw,round,brow,Math.sin(elapsed*1.28)).multiplyScalar(gain);
    uniforms.time.value=elapsed;
    uniforms.travelling.value=travel*gain;
    renderer.render(scene,camera);
    canvas.dataset.prismFrame="moving";
    frames++;
    if(now-sampleTime>=1000) {fps=Math.round(frames*1000/(now-sampleTime));sampleTime=now;frames=0;}
    schedule();
  }

  function clear() {
    if(frame) cancelAnimationFrame(frame);
    frame=0;last=0;
    if(renderer) renderer.clear();
    canvas.dataset.prismFrame="original";
    jaw=round=0;
  }
  const resume=()=>{last=0;schedule();};
  document.addEventListener("visibilitychange",resume);
  const observer=new ResizeObserver(resume);
  observer.observe(canvas);
  const api={
    start(){if(!active){sampleTime=performance.now();frames=0;} active=true;if(state!=="idle")initialize();schedule();return api;},
    stop(){active=false;clear();return api;},
    setState(next){
      const nextState=states.has(next)?next:"idle";
      if(nextState!==state && state==="speaking"){jaw=round=0;}
      state=nextState;
      if(state==="idle"){clear();turn=roll=lift=drag=brow=travel=0;}
      else if(active){initialize();schedule();}
      return api;
    },
    metrics:()=>({fps,ready,failed,state}),
    dispose(){disposed=true;api.stop();observer.disconnect();document.removeEventListener("visibilitychange",resume);
      mesh?.geometry.dispose();material?.dispose();texture?.dispose();renderer?.dispose();}
  };
  return api;
}
