import * as THREE from "../vendor/three.module.min.js";
import { createOpalInterior } from "./opalInterior.js";
import { createMoltenInterior } from "./moltenInterior.js";
import { CONTOUR_LIGHTING } from "./contourLighting.js";
import { GLTFLoader } from "../vendor/loaders/GLTFLoader.js";
// Isolated renderer: the shared GLB is read only; all materials and transforms
// belong to this preview. No imports from or mutations of Nova's live runtime.
export function createCoreScene(host, readSignal, readView, onReady, onError, onTelemetry, readVariant = () => "liquid", readInterior = () => false, readInteriorStyle = () => "opal", readAccents = () => ({ hair: false, face: false }), readContours = () => false, readPresence = () => false) {
    let listeningLight = 0, preparingLight = 0, presenceMix = 0;
    let disposed = false, frame = 0, previous = performance.now(), elapsed = 0;
    let energy = 0, input = 0, output = 0, lastWave = -1, fpsFrames = 0, fpsAt = previous;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#020706");
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-label", "Rotatable emerald Nova hologram with internal golden core");
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 40);
    camera.position.set(0, 1.96, 5.6);
    camera.lookAt(0, 1.62, 0);
    const bust = new THREE.Group();
    scene.add(bust);
    const trackedTextures = [];
    const shellUniforms = { uTime: { value: 0 }, uEnergy: { value: 0 }, uRefined: { value: 1 }, uCoreOrigin: { value: new THREE.Vector3(0, 1.91, .19) }, uPlayback: { value: 0 }, uPulseTimes: { value: new THREE.Vector3(-10, -10, -10) }, uPulseStrengths: { value: new THREE.Vector3(0, 0, 0) }, uMolten: { value: 0 }, uHair: { value: 0 }, uFace: { value: 0 }, uHairMap: { value: null }, uContour: { value: 0 } };
    const presenceUniforms = { uPresence: { value: 0 }, uListen: { value: 0 }, uPrepare: { value: 0 } };
    const shell = new THREE.ShaderMaterial({
        uniforms: { ...shellUniforms, ...presenceUniforms }, transparent: true, depthWrite: false, side: THREE.FrontSide,
        vertexShader: `varying vec3 vP; varying vec3 vN; varying vec3 vV; varying vec2 vUv;
      void main(){vP=position;vUv=uv;vec4 mv=modelViewMatrix*vec4(position,1.);vN=normalize(normalMatrix*normal);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
        fragmentShader: `varying vec3 vP;varying vec3 vN;varying vec3 vV;varying vec2 vUv;uniform float uTime;uniform float uEnergy;uniform float uContour;
      uniform vec3 uCoreOrigin;uniform float uRefined;uniform float uPlayback;uniform vec3 uPulseTimes;uniform vec3 uPulseStrengths;
      uniform float uMolten;uniform float uHair;uniform float uFace;uniform sampler2D uHairMap;
      uniform float uPresence;uniform float uListen;uniform float uPrepare;
      float travelling(float d,float born,float strength){float age=uTime-born;return exp(-pow((d-age*.72)/.055,2.))*strength*(1.-smoothstep(.65,1.15,age))*step(0.,age);}
      float reflection(float t,float born,float strength){float age=uTime-born;return exp(-pow((t-age*1.7)/.24,2.))*strength*step(0.,age)*(1.-smoothstep(.45,.8,age));}
      void main(){
        float rim=pow(1.-abs(dot(normalize(vN),normalize(vV))),2.8);
        float h=vP.y-vP.z*.24;
        float bands=h*34.+sin(h*9.)*.38;
        float row=floor(bands);float aa=max(fwidth(bands)*.5,.018);
        float stripe=1.-smoothstep(.035-aa,.035+aa,abs(fract(bands)-.5));
        float dash=fract(vP.x*87.+vP.z*37.+row*.618);
        stripe*=smoothstep(.03,.12,dash)*(1.-smoothstep(.70,.88,dash));
        float variation=.45+.55*pow(.5+.5*sin(row*2.399),2.);
        float surface=stripe*variation;
        float fine=pow(rim,1.5);
        float alpha=.018+surface*.28+rim*.48;
        vec3 emerald=vec3(.0,.78,.39);
        vec3 rgb=emerald*(surface*.85+fine*2.2)*(1.+uEnergy*.12);
        // Surface-bound gold arrivals: only small cheek/temple regions and
        // selected existing emerald rows, never a full-face gold flash.
        float cheek=1.-smoothstep(.55,1.2,length(vec2((abs(vP.x)-.34)/.18,(vP.y-1.83)/.12)));
        float temple=1.-smoothstep(.45,1.15,length(vec2((abs(vP.x)-.48)/.14,(vP.y-2.08)/.12)));
        float zone=max(cheek,temple)*smoothstep(.14,.5,vP.z);
        float d=length((vP-uCoreOrigin)*vec3(1.,1.,.55));
        float pulse=travelling(d,uPulseTimes.x,uPulseStrengths.x)+travelling(d,uPulseTimes.y,uPulseStrengths.y)+travelling(d,uPulseTimes.z,uPulseStrengths.z);
        float selected=smoothstep(.68,.9,.5+.5*sin(row*2.399));
        float gold=clamp(pulse*zone*selected*surface*uPlayback*uRefined*2.4,0.,.65)*(1.-uMolten);
        rgb+=vec3(1.,.78,.38)*gold*2.;alpha+=gold*.55;
        // Use the GLB's own UV-mapped lock texture: pigment belongs to the
        // existing surface, with no overlaid tubes or invented crossing curves.
        float front=smoothstep(-.18,.40,vP.z);
        float sides=smoothstep(.40,.58,abs(vP.x));
        float hairline=mix(1.94,mix(2.60,2.24,sides),front);
        float hairZone=smoothstep(hairline,hairline+.09,vP.y);
        vec3 n=normalize(vN),view=normalize(vV);
        vec3 light=normalize(vec3(-.45,.65,1.));
        float crownLight=max(0.,dot(n,light));
        float fill=max(0.,dot(n,normalize(vec3(.7,.4,.6))));
        vec3 source=texture2D(uHairMap,vUv).rgb;
        float lockTone=dot(source,vec3(.2126,.7152,.0722));
        float pigment=smoothstep(.045,.095,lockTone);
        float warmBody=smoothstep(.018,.065,lockTone);
        float gloss=pow(max(0.,dot(n,normalize(light+view))),44.);
        float broadGloss=pow(max(0.,dot(n,normalize(light+view))),9.);
        vec3 amber=mix(vec3(.27,.085,.012),vec3(.89,.43,.105),warmBody);
        vec3 champagne=vec3(1.,.79,.43);
        vec3 hairEmerald=emerald*(.065+.20*crownLight+.09*fill);
        vec3 hairGold=amber*(.35+.65*crownLight)+champagne*(.37*warmBody+1.05*gloss+.23*broadGloss);
        float dye=hairZone*uHair*pigment;
        // Suppress the cross-cutting hologram rows only in the hair. Its own
        // sculpted locks and UV texture now define the highlight direction.
        rgb=mix(rgb,rgb*.28+hairEmerald,hairZone);
        rgb=mix(rgb,rgb*.20+hairGold,dye*.94);
        alpha+=hairZone*(.13+.10*crownLight)+dye*(.40+.12*gloss);
        float along=(2.15-vP.y)/.31;
        float cheekCurve=.47-.15*clamp(along,0.,1.);
        float reflectionZone=exp(-pow((abs(vP.x)-cheekCurve)/.032,2.))*
          smoothstep(-.1,.05,along)*(1.-smoothstep(.85,1.05,along))*smoothstep(.16,.42,vP.z);
        float flash=reflection(along,uPulseTimes.x,uPulseStrengths.x)+reflection(along,uPulseTimes.y,uPulseStrengths.y)+reflection(along,uPulseTimes.z,uPulseStrengths.z);
        float faceGlow=reflectionZone*min(flash,.7)*uPlayback*uFace*.60;
        rgb+=vec3(1.,.68,.28)*faceGlow*1.5;alpha+=faceGlow*.55;
        ${CONTOUR_LIGHTING}
        // Small central bridge arcs, attached to the actual surface. The
        // envelope ends well before the outer cheeks; no new eye geometry.
        if(uContour<.5){
          float bridgeLift=.075*exp(-pow(vP.x/.13,2.));
          float arcY=vP.y-bridgeLift;
          float bridgeArc=exp(-pow((arcY-1.94)/.0055,2.))+
            .68*exp(-pow((arcY-1.985)/.0045,2.));
          float bridgeMask=(1.-smoothstep(.08,.29,abs(vP.x)))*smoothstep(.38,.58,vP.z);
          float bridgeGold=min(bridgeArc,.9)*bridgeMask*.48;
          rgb+=vec3(1.,.79,.43)*bridgeGold;alpha+=bridgeGold*.30;
        }
        // Tidal presence is light on the existing shell, not an overlay mesh.
        // Broad, soft waves follow model space and stay attached while turning.
        float lower=(1.-smoothstep(1.22,1.39,vP.y))*smoothstep(.04,.22,vP.y);
        float distanceToThroat=length(vec2(vP.x*.83,(vP.y-1.12)*1.12));
        float inward=pow(.5+.5*cos(distanceToThroat*12.+uTime*1.45),6.)*uListen;
        float outward=travelling(distanceToThroat,uPulseTimes.x,uPulseStrengths.x)+
          travelling(distanceToThroat,uPulseTimes.y,uPulseStrengths.y)+travelling(distanceToThroat,uPulseTimes.z,uPulseStrengths.z);
        float quiet=.5+.5*sin(uTime*.85);
        float gathering=exp(-distanceToThroat*5.)*uPrepare;
        float lightAmount=uPresence*lower*(.025*quiet+.18*inward+.14*gathering+min(outward,.8)*uPlayback*.58);
        float attached=surface*.65+rim*.25+.055;
        rgb+=mix(emerald,vec3(1.,.74,.32),clamp(inward*.35+outward*.65+gathering*.5,0.,.75))*lightAmount*(.32+attached*3.);
        alpha+=lightAmount*(.20+attached*.75);
        gl_FragColor=vec4(rgb,clamp(alpha,0.,uContour>.5?.98:.84));
        #include <colorspace_fragment>
      }`,
    });
    // Draw the core first, then write only the nearest bust surface to depth.
    // The translucent colour pass now hides rear hair behind the forehead while
    // retaining the already-rendered internal glow. No mesh removal or opacity mask.
    const shellDepth = new THREE.MeshBasicMaterial({
        colorWrite: false, depthWrite: true, depthTest: true,
        transparent: true, side: THREE.FrontSide,
    });
    const coreAnchor = new THREE.Group();
    coreAnchor.position.set(0, 2.16, 0.02);
    bust.add(coreAnchor);
    function glowTexture(champagne = false) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const ctx = canvas.getContext("2d");
        const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
        g.addColorStop(0, champagne === "molten" ? "rgba(255,218,145,1)" : "rgba(255,247,213,1)");
        g.addColorStop(.13, champagne === "molten" ? "rgba(255,190,85,.85)" : champagne ? "rgba(255,227,165,.85)" : "rgba(255,215,120,.85)");
        g.addColorStop(.35, champagne === "molten" ? "rgba(235,126,30,.24)" : champagne ? "rgba(255,201,112,.24)" : "rgba(255,167,35,.26)");
        g.addColorStop(.7, champagne ? "rgba(236,180,91,.04)" : "rgba(236,137,22,.045)");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, 128, 128);
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        trackedTextures.push(texture);
        return texture;
    }
    const glowMap = glowTexture();
    const champagneMap = glowTexture(true);
    const moltenMap = glowTexture("molten");
    const haloMat = new THREE.SpriteMaterial({ map: glowMap, color: 0xffcf78, transparent: true, opacity: .65, depthWrite: false, blending: THREE.AdditiveBlending });
    const halo = new THREE.Sprite(haloMat);
    halo.scale.set(1.22, 1.44, 1);
    halo.renderOrder = 1;
    coreAnchor.add(halo);
    const seedMaterial = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 } },
        vertexShader: `varying vec3 vP;varying vec3 vN;varying vec3 vV;uniform float uTime;uniform float uEnergy;
      void main(){vP=position;vec3 p=position*(1.+.025*sin(position.y*17.+uTime*1.3));vec4 mv=modelViewMatrix*vec4(p,1.);vN=normalize(normalMatrix*normal);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
        fragmentShader: `varying vec3 vP;varying vec3 vN;varying vec3 vV;uniform float uTime;uniform float uEnergy;
      void main(){float face=abs(dot(normalize(vN),normalize(vV)));float veins=pow(.5+.5*sin(vP.y*29.+vP.x*19.+uTime*1.8),5.);
      vec3 c=mix(vec3(.95,.29,.025),vec3(1.,.82,.39),pow(face,2.));
      gl_FragColor=vec4(c*(.65+veins*.35+uEnergy*1.15),(.28+.5*pow(face,2.))*(.72+uEnergy*.25));
      #include <colorspace_fragment>
      }` });
    const seed = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), seedMaterial);
    seed.scale.set(.15, .27, .15);
    seed.renderOrder = 1;
    coreAnchor.add(seed);
    const liquidMaterial = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms: { uTime: { value: 0 }, uEnergy: { value: 0 }, uMolten: { value: 0 } },
        vertexShader: `varying vec3 vP;varying vec3 vN;varying vec3 vV;uniform float uTime;uniform float uEnergy;
      void main(){vP=position;float t=uTime*.48;
      float flow=sin(position.y*2.7+t)*sin(position.x*2.3-t*.73)*.10+sin(position.z*3.1+position.y*1.8-t*.6)*.07;
      vec3 p=position*(1.+flow);p.x+=.065*sin(position.y*2.4+t*.8);p.y+=.045*sin(position.z*2.8-t*.5);
      vec4 mv=modelViewMatrix*vec4(p,1.);vN=normalize(normalMatrix*normal);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}`,
        fragmentShader: `varying vec3 vP;varying vec3 vN;varying vec3 vV;uniform float uTime;uniform float uEnergy;uniform float uMolten;
      void main(){float face=max(0.,dot(normalize(vN),normalize(vV)));float soft=pow(face,1.8);
      float flow=.84+.16*sin(vP.y*3.4+vP.x*2.6+uTime*.5);
      vec3 c=mix(vec3(.85,.46,.13),vec3(1.,.91,.69),pow(face,2.4));
      float pockets=.5+.5*sin(vP.y*6.+vP.x*3.+sin(vP.z*5.-uTime*.48));
      vec3 molten=mix(vec3(.52,.145,.018),vec3(1.,.78,.40),clamp(pow(face,1.4)*.70+pockets*.30,0.,1.));
      c=mix(c,molten,uMolten);
      gl_FragColor=vec4(c*(.85+uEnergy*.72),soft*flow*(.75+uEnergy*.16));
      #include <colorspace_fragment>
      }` });
    const circuits = [];
    for (let j = 0; j < 3; j++) {
        const points = [];
        for (let i = 0; i <= 160; i++) {
            const a = i / 160 * Math.PI * 2;
            points.push(new THREE.Vector3(Math.cos(a) * (.24 + j * .03), Math.sin(a) * (.30 + j * .035), Math.sin(a * 2 + j) * .07));
        }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: j === 1 ? 0xffefb0 : 0xe7a447, transparent: true, opacity: .48, depthWrite: false, blending: THREE.AdditiveBlending }));
        line.rotation.y = j * Math.PI / 3;
        line.rotation.z = .35 + j * .6;
        line.renderOrder = 1;
        coreAnchor.add(line);
        circuits.push(line);
    }
    // Small internal motes: deterministic positions, no per-frame allocations.
    const motePositions = new Float32Array(120 * 3);
    for (let i = 0; i < 120; i++) {
        const t = i * 2.399, r = .12 + .18 * ((i * 37 % 101) / 101), y = (i / 119 - .5) * .6;
        motePositions.set([Math.cos(t) * r, y, Math.sin(t) * r], i * 3);
    }
    const moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
    const moteMat = new THREE.PointsMaterial({ color: 0xffce72, size: .012, transparent: true, opacity: .65, depthWrite: false, blending: THREE.AdditiveBlending });
    const motes = new THREE.Points(moteGeo, moteMat);
    motes.renderOrder = 1;
    coreAnchor.add(motes);
    const waves = [];
    for (let j = 0; j < 5; j++) {
        const pts = [];
        for (let i = 0; i < 96; i++) {
            const a = i / 96 * Math.PI * 2;
            pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a) * .8, 0));
        }
        const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffd489, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
        line.visible = false;
        line.renderOrder = 3;
        coreAnchor.add(line);
        waves.push({ line, birth: -10, strength: 0 });
    }
    const filaments = [];
    for (let j = 0; j < 7; j++) {
        const pts = [];
        const a = j / 7 * Math.PI * 2;
        for (let k = 0; k < 16; k++) {
            const r = .10 + k * .035;
            pts.push(new THREE.Vector3(Math.cos(a) * r + Math.sin(k * 2.7 + j) * .025, Math.sin(a) * r * .85 + Math.cos(k * 1.8) * .025, Math.sin(a * 2) * r * .45));
        }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffe4a2, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }));
        line.renderOrder = 3;
        coreAnchor.add(line);
        filaments.push(line);
    }
    const pulseTimes = [-10, -10, -10], pulseStrengths = [0, 0, 0];
    let pulseIndex = 0, lastContourPulse = -1, previousOut = 0;
    const guidedFilaments = [];
    const destinations = [new THREE.Vector3(-.37, 1.84, .64), new THREE.Vector3(.37, 1.84, .64), new THREE.Vector3(-.48, 2.08, .43), new THREE.Vector3(.48, 2.08, .43)];
    destinations.forEach((destination, j) => {
        const start = new THREE.Vector3(0, 1.91, .19), middle = start.clone().lerp(destination, .55);
        middle.y += j < 2 ? .045 : .025;
        const curve = new THREE.CatmullRomCurve3([start, middle, destination]);
        const points = curve.getPoints(32);
        points.forEach((p, i) => { const w = Math.sin(i / 32 * Math.PI); p.y += Math.sin(i * 1.7 + j) * .006 * w; });
        const geo = new THREE.BufferGeometry().setFromPoints(points);
        geo.setAttribute("aProgress", new THREE.Float32BufferAttribute(points.map((_, i) => i / 32), 1));
        const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
            uniforms: { uTime: { value: 0 }, uBorn: { value: -10 }, uCoreOffset: { value: new THREE.Vector3() }, uStrength: { value: 0 }, uPlayback: { value: 0 } },
            vertexShader: `attribute float aProgress;varying float vProgress;uniform vec3 uCoreOffset;void main(){vProgress=aProgress;vec3 p=position+uCoreOffset*(1.-aProgress);gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}`,
            fragmentShader: `varying float vProgress;uniform float uTime;uniform float uBorn;uniform float uStrength;uniform float uPlayback;
        void main(){float age=uTime-uBorn;float tip=age*1.65;float light=exp(-pow((vProgress-tip)/.18,2.));
        float fade=step(0.,age)*(1.-smoothstep(.55,.85,age));gl_FragColor=vec4(1.,.79,.42,light*fade*uStrength*uPlayback*.42);
        #include <colorspace_fragment>
        }` });
        const line = new THREE.Line(geo, material);
        line.renderOrder = 3;
        bust.add(line);
        guidedFilaments.push(line);
    });
    // A restrained emerald base, not the previous bright white rings.
    const base = new THREE.Mesh(new THREE.RingGeometry(.62, .63, 96), new THREE.MeshBasicMaterial({ color: 0x008e68, transparent: true, opacity: .24, side: THREE.DoubleSide, depthWrite: false }));
    base.rotation.x = -Math.PI / 2;
    base.position.y = -.015;
    scene.add(base);
    const resize = () => { const w = host.clientWidth, h = host.clientHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.position.z = w / h < .8 ? 7 : 5.6; camera.updateProjectionMatrix(); };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();
    const resources = new Set();
    let interior;
    let molten;
    let arrivalAt = null;
    const loader = new GLTFLoader();
    loader.load("/assets/current-glass/nova.glb", gltf => {
        if (disposed) {
            disposeImported(gltf.scene);
            return;
        }
        gltf.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(gltf.scene), size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3()), scale = 3 / Math.max(size.x, size.y, size.z);
        gltf.scene.traverse(object => { if (!(object instanceof THREE.Mesh))
            return; const geometry = object.geometry.clone(); geometry.applyMatrix4(object.matrixWorld); geometry.translate(-center.x, -box.min.y, -center.z); geometry.scale(scale, scale, scale); resources.add(geometry); if (!interior) {
            interior = createOpalInterior(geometry);
            molten = createMoltenInterior(geometry);
            const imported = Array.isArray(object.material) ? object.material[0] : object.material;
            const source = imported.map;
            if (source) {
                const hairMap = source.clone();
                hairMap.needsUpdate = true;
                shellUniforms.uHairMap.value = hairMap;
                trackedTextures.push(hairMap);
            }
            bust.add(interior.group, molten.group);
            arrivalAt = elapsed;
        } const depthMesh = new THREE.Mesh(geometry, shellDepth); depthMesh.renderOrder = 1.5; bust.add(depthMesh); const mesh = new THREE.Mesh(geometry, shell); mesh.renderOrder = 2; bust.add(mesh); });
        disposeImported(gltf.scene);
        onReady();
    }, undefined, () => onError("The existing nova.glb could not load. Reload this local preview."));
    function disposeImported(root) { root.traverse(o => { if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            for (const value of Object.values(m)) {
                if (value instanceof THREE.Texture)
                    value.dispose();
            }
            m.dispose();
        }
    } }); }
    const onLost = (event) => { event.preventDefault(); onError("The browser lost its graphics context. Stop other 3D tabs, then reload this preview."); };
    renderer.domElement.addEventListener("webglcontextlost", onLost);
    function animate(now) {
        if (disposed)
            return;
        frame = requestAnimationFrame(animate);
        if (document.hidden) {
            previous = now;
            return;
        }
        if (now - previous < 1000 / 30)
            return;
        const dt = Math.min((now - previous) / 1000, .08);
        previous = now;
        elapsed += dt;
        const s = readSignal();
        const out = s.speaking ? s.playback : 0, mic = s.listening && !s.speaking ? s.microphone : 0;
        const interiorOn = readInterior();
        const phase = s.speaking ? "speaking" : s.phase ?? (s.listening ? "listening" : "idle");
        const variant = readVariant(), refined = variant !== "baseline", throat = variant === "throat";
        const moltenLook = throat && readInteriorStyle() === "molten";
        const accents = readAccents();
        shellUniforms.uContour.value = readContours() ? 1 : 0;
        shellUniforms.uMolten.value = moltenLook ? 1 : 0;
        shellUniforms.uHair.value = accents.hair ? 1 : 0;
        shellUniforms.uFace.value = accents.face ? 1 : 0;
        liquidMaterial.uniforms.uMolten.value = moltenLook ? 1 : 0;
        output += (out - output) * (1 - Math.exp(-dt * (out > output ? 28 : 10)));
        input += (mic - input) * (1 - Math.exp(-dt * 9));
        const target = output * .95 + input * .22;
        energy += (target - energy) * (1 - Math.exp(-dt * 12));
        presenceMix += ((readPresence() ? 1 : 0) - presenceMix) * (1 - Math.exp(-dt * 7));
        listeningLight += ((phase === "listening" ? 1 : 0) - listeningLight) * (1 - Math.exp(-dt * 6));
        preparingLight += ((phase === "preparing" ? 1 : 0) - preparingLight) * (1 - Math.exp(-dt * 6));
        presenceUniforms.uPresence.value = presenceMix;
        presenceUniforms.uListen.value = listeningLight;
        presenceUniforms.uPrepare.value = preparingLight;
        const breath = (.035 + presenceMix * .018) * Math.sin(elapsed * .85);
        if (refined) {
            // Neck section measured from the actual GLB: front z ≈ .28, rear ≈ -.39.
            // Centre at z=-.04 keeps the existing liquid seed behind the throat surface.
            coreAnchor.position.set(Math.sin(elapsed * .37) * .012, (throat ? 1.12 : 1.91) + Math.sin(elapsed * .51) * .014, (throat ? -.04 : .19) + Math.cos(elapsed * .31) * .009);
            const stretch = Math.sin(elapsed * .63) * .055;
            seed.scale.set(.235 * (1 + stretch), .19 * (1 - stretch * .7), .205).multiplyScalar(1 + breath * .65 + energy * .17);
            seed.rotation.y = elapsed * .085;
            seed.rotation.z = Math.sin(elapsed * .29) * .13;
            seed.material = liquidMaterial;
            haloMat.map = moltenLook ? moltenMap : champagneMap;
            haloMat.color.setHex(moltenLook ? 0xffd08a : 0xffe3ac);
            halo.scale.set(1.10 + energy * .20, 1.04 + energy * .22, 1);
            haloMat.opacity = .47 + breath + energy * .27;
        }
        else {
            coreAnchor.position.set(0, 2.16, .02);
            seed.material = seedMaterial;
            haloMat.map = glowMap;
            haloMat.color.setHex(0xffcf78);
            seed.scale.set(.15, .27, .15).multiplyScalar(1 + breath + energy * .28);
            seed.rotation.y = elapsed * .17;
            seed.rotation.z = Math.sin(elapsed * .28) * .08;
            halo.scale.set(1.16 + energy * .42, 1.38 + energy * .44, 1);
            haloMat.opacity = .44 + breath + energy * .44;
        }
        if (refined) {
            haloMat.opacity += presenceMix * (listeningLight * .035 + preparingLight * .055);
        }
        seedMaterial.uniforms.uTime.value = elapsed;
        seedMaterial.uniforms.uEnergy.value = energy;
        liquidMaterial.uniforms.uTime.value = elapsed;
        liquidMaterial.uniforms.uEnergy.value = energy;
        shellUniforms.uTime.value = elapsed;
        shellUniforms.uEnergy.value = energy;
        shellUniforms.uCoreOrigin.value.set(0, throat ? 1.12 : 1.91, throat ? -.04 : .19);
        circuits.forEach((c, i) => { c.visible = !refined || i < 2; c.rotation.y = elapsed * (.12 + i * .035) + i * Math.PI / 3; c.material.opacity = refined ? .035 + energy * .045 : .28 + energy * .5; c.scale.setScalar(refined ? .83 : 1); c.rotation.z = .35 + i * .6 + Math.sin(elapsed * .4) * .06; });
        motes.rotation.y = elapsed * .10;
        moteMat.opacity = refined ? .16 + energy * .16 : .40 + energy * .5;
        if (!refined && s.speaking && output > .1 && elapsed - lastWave > .30) {
            const wave = waves.reduce((a, b) => a.birth < b.birth ? a : b);
            wave.birth = elapsed;
            wave.strength = output;
            lastWave = elapsed;
        }
        if (refined && s.speaking && out > .12 && elapsed - lastContourPulse > .55 && (out - previousOut > .045 || elapsed - lastContourPulse > 1.05)) {
            pulseTimes[pulseIndex] = elapsed;
            pulseStrengths[pulseIndex] = Math.min(1, out * 1.5);
            pulseIndex = (pulseIndex + 1) % 3;
            lastContourPulse = elapsed;
        }
        if (!s.speaking) {
            pulseTimes.fill(-10);
            pulseStrengths.fill(0);
        }
        previousOut = out;
        shellUniforms.uRefined.value = refined ? 1 : 0;
        shellUniforms.uPlayback.value = Math.min(1, output * 3);
        shellUniforms.uPulseTimes.value.fromArray(pulseTimes);
        shellUniforms.uPulseStrengths.value.fromArray(pulseStrengths);
        guidedFilaments.forEach((l, j) => { l.visible = refined && !moltenLook; l.material.uniforms.uCoreOffset.value.set(0, throat ? -.79 : 0, throat ? -.23 : 0); const slot = j % 3; l.material.uniforms.uTime.value = elapsed; l.material.uniforms.uBorn.value = pulseTimes[slot] + (j % 2) * .10; l.material.uniforms.uStrength.value = pulseStrengths[slot]; l.material.uniforms.uPlayback.value = Math.min(1, output * 3); });
        let waveCount = 0;
        for (const wave of waves) {
            const age = elapsed - wave.birth;
            if (refined || !s.speaking) {
                wave.birth = -10;
                wave.line.visible = false;
                continue;
            }
            wave.line.visible = age < 1.1;
            if (wave.line.visible) {
                waveCount++;
                wave.line.scale.setScalar(.22 + age * .95);
                wave.line.rotation.y = Math.sin(wave.birth * 1.2) * .45;
                wave.line.material.opacity = (1 - age / 1.1) * wave.strength * .5;
            }
        }
        if (refined && output > .01)
            waveCount = pulseTimes.filter(t => elapsed - t < 1.1).length;
        filaments.forEach((l, i) => { const flicker = Math.max(0, Math.sin(elapsed * 13 + i * 2.7)); l.material.opacity = !refined && s.speaking && out > .12 ? Math.pow(flicker, 14) * output * .7 : 0; });
        const view = readView();
        const yaw = view === "front" ? 0 : view === "quarter" ? -.55 : view === "back" ? Math.PI : Math.sin(elapsed * .24) * .65;
        bust.rotation.y += (yaw - bust.rotation.y) * (1 - Math.exp(-dt * 5));
        interior?.update(elapsed, dt, phase, output, interiorOn && readInteriorStyle() === "opal");
        molten?.update(elapsed, dt, phase, output, interiorOn && readInteriorStyle() === "molten");
        // One quiet acknowledgement on arrival; the whole bust moves coherently.
        const arrivalAge = arrivalAt === null ? 10 : elapsed - arrivalAt;
        bust.rotation.x = interiorOn && arrivalAge < 3 ? Math.sin(arrivalAge / 3 * Math.PI) * .018 : 0;
        renderer.render(scene, camera);
        fpsFrames++;
        if (now - fpsAt > 750) {
            onTelemetry({ fps: Math.round(fpsFrames * 1000 / (now - fpsAt)), coreEnergy: Math.round(energy * 100), waveCount });
            fpsFrames = 0;
            fpsAt = now;
        }
    }
    frame = requestAnimationFrame(animate);
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); renderer.domElement.removeEventListener("webglcontextlost", onLost); scene.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
            m.dispose();
    } }); resources.forEach(g => g.dispose()); seedMaterial.dispose(); liquidMaterial.dispose(); haloMat.dispose(); trackedTextures.forEach(t => t.dispose()); renderer.dispose(); renderer.domElement.remove(); };
}
