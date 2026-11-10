import {TIDE_PULSE_GLSL} from './tideTiming.js';
import * as THREE from "../vendor/three.module.min.js";
/** Six shaded, tapered channels inset below the unchanged GLB surface.
 * No fluid simulation, extra render targets, external assets or audio sources. */
export function createMoltenInterior(geometry) {
    const group = new THREE.Group(), exits=[];
    const positions = geometry.getAttribute("position");
    const grid = new Float32Array(81 * 81).fill(-Infinity);
    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
        if (y < 0 || y > 1.4 || Math.abs(x) > 1.4)
            continue;
        const col = Math.round((x + 1.4) / 2.8 * 80), row = Math.round(y / 1.4 * 80);
        grid[row * 81 + col] = Math.max(grid[row * 81 + col], z);
    }
    function front(x, y) {
        const col = Math.round((x + 1.4) / 2.8 * 80), row = Math.round(y / 1.4 * 80);
        let total = 0, weight = 0;
        for (let dy = -2; dy <= 2; dy++)
            for (let dx = -2; dx <= 2; dx++) {
                const xx = col + dx, yy = row + dy;
                if (xx < 0 || xx > 80 || yy < 0 || yy > 80)
                    continue;
                const z = grid[yy * 81 + xx];
                if (!Number.isFinite(z))
                    continue;
                const w = 1 / (1 + dx * dx + dy * dy);
                total += z * w;
                weight += w;
            }
        return (weight ? total / weight : .2) - .115;
    }
    const uniforms = {
        uTide:{value:0},uTideBorn:{value:new Float32Array(8).fill(-100)},uTideStrength:{value:new Float32Array(8)},uTime: { value: 0 }, uFlow: { value: 0 }, uEnergy: { value: 0 }, uListen: { value: 0 },
        uPrepare: { value: 0 }, uReveal: { value: 0 }, uBreath: { value: 0 },
        uSpeaking: { value: 0 }, uBorn: { value: new THREE.Vector3(-10, -10, -10) },
        uStrength: { value: new THREE.Vector3() },
    };
    const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.NormalBlending, uniforms,
        vertexShader: `attribute float aBranch;attribute float aInner;varying vec2 vUv;varying float vBranch;varying float vInner;
      varying vec3 vN;varying vec3 vView;
      void main(){vUv=uv;vBranch=aBranch;vInner=aInner;vec4 mv=modelViewMatrix*vec4(position,1.);
        vN=normalize(normalMatrix*normal);vView=-mv.xyz;gl_Position=projectionMatrix*mv;}`,
        fragmentShader: `varying vec2 vUv;varying float vBranch;varying float vInner;varying vec3 vN;varying vec3 vView;
      uniform float uTime;uniform float uFlow;uniform float uEnergy;uniform float uListen;
      uniform float uPrepare;uniform float uReveal;uniform float uBreath;uniform float uSpeaking;
      uniform vec3 uBorn;uniform vec3 uStrength;uniform float uTide;
      ${TIDE_PULSE_GLSL}
      float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
      float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
      float surge(float born,float strength){float age=uTime-born-vBranch*.026;
        float speed=.62+strength*.43;
        return exp(-pow((vUv.x-age*speed)/(.085+strength*.055),2.))*strength*
          step(0.,age)*(1.-smoothstep(1.1,1.6,age));}
      void main(){
        float along=vUv.x;vec3 n=normalize(vN),view=normalize(vView);
        float face=max(0.,dot(n,view));
        float front=pow(face,.65);
        float grain=noise(vec2(along*22.-uFlow,vUv.y*7.+vBranch*4.));
        float detail=noise(vec2(along*65.-uFlow*.7,vUv.y*15.+vBranch*7.));
        float pockets=smoothstep(.28,.69,grain*.82+detail*.18);
        float inward=pow(.5+.5*cos(along*19.+uTime*2.9+vBranch*.7),8.)*uListen;
        float gathering=exp(-along*6.)*uPrepare*(.7+.3*sin(uTime*2.+vBranch*.5));
        float pulse=mix((surge(uBorn.x,uStrength.x)+surge(uBorn.y,uStrength.y)+surge(uBorn.z,uStrength.z))*uSpeaking,tideAt(.10+along*.95),uTide);
        float heat=clamp(.16+pockets*.69+inward*.25+gathering*.45+pulse*.55,0.,1.);
        vec3 bronze=vec3(.055,.016,.004), amber=vec3(.52,.145,.018), champagne=vec3(1.,.78,.40);
        vec3 molten=mix(amber,champagne,smoothstep(.30,.9,heat));
        vec3 colour=mix(bronze,molten,front*(.53+heat*.47));
        float sheen=pow(max(0.,dot(n,normalize(view+vec3(-.5,.8,1.)))),20.);
        colour+=vec3(.35,.24,.10)*sheen*(.2+pockets*.5+pulse*.25);
        // Hot inclusions float within the amber body; they never whiten the whole channel.
        float hot=smoothstep(.65,.94,heat)*pow(face,3.);
        colour=mix(colour,vec3(1.,.86,.57),hot*.72);
        colour*=.88+uBreath*.035+gathering*.15+pulse*.25;
        colour+=uTide*vec3(1.,.65,.23)*pulse*.9;
        colour*=1.-uPrepare*smoothstep(.15,.8,along)*.38;
        float reveal=1.-smoothstep(uReveal-.045,uReveal+.055,along);
        float opacity;
        if(vInner<.5){
          // Amber glass envelope: warm transmission, bronze edge, narrow gold reflection.
          float edge=pow(1.-face,1.5);
          colour=mix(vec3(.12,.035,.007),vec3(.64,.29,.065),front*.7);
          colour+=vec3(.54,.34,.12)*sheen*.65;
          opacity=(.30+edge*.22+sheen*.13)*reveal;
        }else{
          colour=mix(colour,vec3(1.,.78,.40),clamp(pulse*.7,0.,.55));
          opacity=reveal*(.28+pockets*.16+inward*.18+gathering*.25+min(pulse,.85)*.7);
        }
        gl_FragColor=vec4(colour,clamp(opacity,0.,.92));
        #include <colorspace_fragment>
      }`,
    });
    const routes = [
        [[.075, 1.08], [.12, .94], [.20, .81], [.34, .72], [.54, .64], [.77, .58], [.98, .45], [1.12, .33]],
        [[.055, 1.04], [.10, .89], [.16, .74], [.23, .62], [.37, .49], [.58, .40], [.72, .24]],
        [[.035, 1.00], [.055, .84], [.09, .69], [.12, .55], [.18, .38], [.22, .18]],
    ];
    for (const side of [-1, 1])
        routes.forEach((route, index) => {
            const branch = index + (side === 1 ? 3 : 0);
            const points = route.map(([x, y], i) => {
                const p = i / (route.length - 1), xx = x * side + (side === 1 ? .018 * Math.sin(p * 5.) : 0);
                const yy = y + (side === 1 ? .025 * Math.sin(p * 4.) : 0);
                return new THREE.Vector3(xx, yy, front(xx, yy) - .018 * Math.sin(p * 6. + branch));
            });
            const curve = new THREE.CatmullRomCurve3(points);
            exits.push({tip:points.at(-1).clone(),side,index,curve});
            const tubular = 96, radial = 10;
            const tube = new THREE.TubeGeometry(curve, tubular, 1, radial, false);
            const pos = tube.getAttribute("position");
            const branchData = new Float32Array(pos.count).fill(branch);
            for (let i = 0; i <= tubular; i++) {
                const t = i / tubular, centre = curve.getPointAt(t);
                const taper = Math.pow(Math.sin(Math.PI * Math.min(.995, t * .88 + .055)), .45) * (1 - t * .45);
                const radius = (index === 0 ? .016 : index === 1 ? .0125 : .0095) * taper * (1 - t * .55) *
                    (1 + .13 * Math.sin(t * 23 + branch) + .045 * Math.sin(t * 47 - branch));
                for (let j = 0; j <= radial; j++) {
                    const k = i * (radial + 1) + j;
                    pos.setXYZ(k, centre.x + (pos.getX(k) - centre.x) * radius, centre.y + (pos.getY(k) - centre.y) * radius, centre.z + (pos.getZ(k) - centre.z) * radius);
                }
            }
            tube.setAttribute("aBranch", new THREE.BufferAttribute(branchData, 1));
            tube.setAttribute("aInner", new THREE.BufferAttribute(new Float32Array(pos.count), 1));
            tube.computeVertexNormals();
            tube.computeBoundingSphere();
            const glowGeometry = tube.clone(), glowPositions = glowGeometry.getAttribute("position");
            for (let i = 0; i <= tubular; i++) {
                const centre = curve.getPointAt(i / tubular);
                for (let j = 0; j <= radial; j++) {
                    const k = i * (radial + 1) + j;
                    glowPositions.setXYZ(k, centre.x + (pos.getX(k) - centre.x) * .55, centre.y + (pos.getY(k) - centre.y) * .55, centre.z + (pos.getZ(k) - centre.z) * .55);
                }
            }
            glowGeometry.computeVertexNormals();
            glowGeometry.computeBoundingSphere();
            glowGeometry.setAttribute("aInner", new THREE.BufferAttribute(new Float32Array(pos.count).fill(1), 1));
            const glow = new THREE.Mesh(glowGeometry, material);
            glow.renderOrder = .79;
            group.add(glow);
            const mesh = new THREE.Mesh(tube, material);
            mesh.renderOrder = .8;
            group.add(mesh);
        });
    let age = 0, wasEnabled = false, listen = 0, prepare = 0, speaking = 0, flow = 0;
    let previousEnergy = 0, lastPulse = -10, slot = 0;
    const born = [-10, -10, -10], strength = [0, 0, 0];
    return { group, material, exits, update(time, dt, phase, energy, enabled, tide=null) {
            uniforms.uTide.value=tide?1:0;if(tide){uniforms.uTideBorn.value=tide.born;uniforms.uTideStrength.value=tide.strength;}
            group.visible = enabled;
            if (!enabled)
                wasEnabled = false;
            if (enabled && !wasEnabled) {
                age = 0;
                born.fill(-10);
                strength.fill(0);
                listen = prepare = speaking = 0;
                previousEnergy = 0;
            }
            if (enabled) {
                wasEnabled = true;
                age += dt;
            }
            const ease = 1 - Math.exp(-dt * 6);
            listen += ((phase === "listening" ? 1 : 0) - listen) * ease;
            prepare += ((phase === "preparing" ? 1 : 0) - prepare) * ease;
            speaking += ((phase === "speaking" ? 1 : 0) - speaking) * (1 - Math.exp(-dt * 14));
            if (phase !== "speaking") {
                born.fill(-10);
                strength.fill(0);
                previousEnergy = 0;
            }
            else {
                if (energy > .10 && time - lastPulse > .22 && (energy - previousEnergy > .025 || time - lastPulse > .68)) {
                    born[slot] = time;
                    strength[slot] = Math.min(1, energy * 1.9);
                    slot = (slot + 1) % 3;
                    lastPulse = time;
                }
                previousEnergy = energy;
            }
            flow += dt * (.045 - listen * .24 + speaking * (.12 + energy * .28));
            uniforms.uTime.value = time;
            uniforms.uFlow.value = flow;
            uniforms.uEnergy.value = energy;
            uniforms.uListen.value = listen;
            uniforms.uPrepare.value = prepare;
            uniforms.uSpeaking.value = speaking;
            uniforms.uBorn.value.fromArray(born);
            uniforms.uStrength.value.fromArray(strength);
            uniforms.uBreath.value = Math.sin(time * .85);
            uniforms.uReveal.value = enabled ? Math.min(1.1, age / 2.8) : 1.1;
        } };
}
