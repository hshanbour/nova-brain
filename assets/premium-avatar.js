import * as THREE from "./vendor/three.module.min.js";
import { GLTFLoader } from "./vendor/loaders/GLTFLoader.js";

const VALID_STATES = new Set(["idle", "connecting", "listening", "thinking", "speaking", "executing", "muted", "error"]);

export function createNovaAetherAvatar({ canvas, inputLevel = () => 0, outputLevel = () => 0, maxFps = 36, reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches } = {}) {
  if (!canvas) throw new TypeError("Nova Aether requires a canvas.");
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true });
  } catch (error) {
    canvas.dataset.avatarFallback = "webgl-unavailable";
    return fallbackController(error);
  }

  renderer.setClearColor(0x02060a, 0);
  renderer.setPixelRatio(Math.min(1.5, globalThis.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x03080d, .082);
  const camera = new THREE.PerspectiveCamera(28, 1, .1, 40);
  camera.position.set(0, .03, 7.35);
  const root = new THREE.Group();
  root.position.y = -.04;
  scene.add(root);

  const palette = { cyan: 0x68e7f2, ice: 0xd8fcff, teal: 0x1597a7, navy: 0x061821, mint: 0x72f0cf, rose: 0xff7892 };
  scene.add(new THREE.HemisphereLight(0x9defff, 0x020508, 1.45));
  const key = new THREE.DirectionalLight(0xc8faff, 3.2); key.position.set(3.5, 4.5, 5); scene.add(key);
  const rim = new THREE.PointLight(palette.cyan, 12, 14, 2); rim.position.set(-3.4, 1.2, -1.5); scene.add(rim);
  const warm = new THREE.PointLight(0x7d70ff, 7, 10, 2); warm.position.set(2.5, -1.8, 2); scene.add(warm);

  const faceGeometry = buildFaceGeometry(62, 48);
  const faceMaterial = new THREE.MeshPhysicalMaterial({ color: 0x061c27, emissive: 0x087384, emissiveIntensity: .3, metalness: .58, roughness: .34, clearcoat: .82, clearcoatRoughness: .18, transparent: true, opacity: .58, side: THREE.DoubleSide, flatShading: false });
  const face = new THREE.Mesh(faceGeometry, faceMaterial);
  face.scale.set(.98, 1, 1);
  root.add(face);

  const wireMaterial = new THREE.MeshBasicMaterial({ color: palette.cyan, transparent: true, opacity: .055, wireframe: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const topology = new THREE.Mesh(faceGeometry, wireMaterial);
  topology.scale.set(1.002, 1.002, 1.002);
  root.add(topology);

  const pointUniforms = { uTime: { value: 0 }, uEnergy: { value: 0 }, uOpacity: { value: .42 }, uColor: { value: new THREE.Color(palette.cyan) } };
  const pointMaterial = new THREE.ShaderMaterial({
    uniforms: pointUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `uniform float uTime; uniform float uEnergy; varying float vPulse; void main(){vec3 p=position;float ripple=sin(uTime*1.7+position.y*5.0+position.x*4.0)*(.006+uEnergy*.018);p+=normal*ripple;vec4 mv=modelViewMatrix*vec4(p,1.0);gl_Position=projectionMatrix*mv;gl_PointSize=(1.4+uEnergy*2.7)*(11.0/-mv.z);vPulse=.62+.38*sin(uTime*2.2+position.y*7.0);}`,
    fragmentShader: `uniform vec3 uColor;uniform float uOpacity;varying float vPulse;void main(){vec2 p=gl_PointCoord-.5;float d=dot(p,p);if(d>.25)discard;float glow=smoothstep(.25,0.0,d);gl_FragColor=vec4(uColor,glow*uOpacity*vPulse);}`
  });
  const facePoints = new THREE.Points(faceGeometry, pointMaterial);
  facePoints.scale.set(1.006, 1.006, 1.006);
  root.add(facePoints);

  const contourGroup = buildFaceContours(palette);
  root.add(contourGroup);
  const features = buildFacialFeatures(palette);
  root.add(features.group);
  const hair = buildDataHair(palette);
  root.add(hair.group);
  const neural = buildNeuralHalo(palette);
  root.add(neural.group);
  const ambient = buildAmbientField(palette);
  scene.add(ambient.group);

  const authored = createAuthoredIdentity({ root, palette });
  authored.ready.then(() => {
    face.visible = false;
    topology.visible = false;
    facePoints.visible = false;
    contourGroup.visible = false;
    features.group.visible = false;
  }).catch(() => {});

  const scanMaterial = new THREE.MeshBasicMaterial({ color: palette.mint, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false });
  const scan = new THREE.Mesh(new THREE.PlaneGeometry(3.5, .018), scanMaterial);
  scan.position.z = 1.65; root.add(scan);

  let state = "idle", running = false, disposed = false, frame = 0, lastFrame = 0, measuredAt = performance.now(), measuredFrames = 0, measuredFps = 0;
  let targetYaw = 0, targetPitch = 0, pointerYaw = 0, pointerPitch = 0, viewAngle = "front";
  const interval = 1000 / (reducedMotion ? 18 : Math.max(24, Math.min(48, maxFps)));

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(260, Math.round(rect.width || 700)), height = Math.max(340, Math.round(rect.height || 760));
    if (canvas.width !== Math.round(width * renderer.getPixelRatio()) || canvas.height !== Math.round(height * renderer.getPixelRatio())) renderer.setSize(width, height, false);
    camera.aspect = width / height; camera.updateProjectionMatrix();
  }

  function render(timestamp) {
    if (!running || disposed) return;
    frame = requestAnimationFrame(render);
    if (timestamp - lastFrame < interval) return;
    lastFrame = timestamp; resize();
    const t = timestamp / 1000, input = clamp(inputLevel()), output = clamp(outputLevel());
    const energy = state === "speaking" ? output : state === "listening" ? input : state === "thinking" ? .24 : state === "executing" ? .34 : .07;
    const viewTarget = viewAngle === "profile" ? .98 : viewAngle === "three-quarter" ? .55 : 0;
    targetYaw = viewTarget + pointerYaw + (state === "thinking" ? Math.sin(t * .42) * .09 : Math.sin(t * .2) * .025);
    targetPitch = pointerPitch + Math.sin(t * .31) * .018;
    root.rotation.y += (targetYaw - root.rotation.y) * .055;
    root.rotation.x += (targetPitch - root.rotation.x) * .06;
    root.position.y = -.04 + Math.sin(t * 1.05) * .018;
    const breath = 1 + Math.sin(t * 1.35) * .004;
    root.scale.setScalar(breath);

    pointUniforms.uTime.value = t; pointUniforms.uEnergy.value = energy;
    pointUniforms.uOpacity.value = state === "muted" ? .16 : .34 + energy * .22;
    faceMaterial.emissiveIntensity = .26 + energy * .72;
    wireMaterial.opacity = state === "thinking" ? .11 : state === "executing" ? .14 : .045 + energy * .07;
    features.primary.opacity = .62 + energy * .32;
    features.secondary.opacity = .16 + energy * .2;
    features.speechGroup.scale.y = 1 + (state === "speaking" ? output * .1 : 0);
    features.speechGroup.position.y = state === "speaking" ? -output * .026 : 0;
    hair.hero.opacity = .48 + energy * .24;
    hair.fine.opacity = .18 + energy * .18;
    hair.group.children.forEach((line, index) => { line.position.z = Math.sin(t * .72 + index * .41) * (.004 + energy * .012); });
    authored.group.position.y = -12.6 + Math.sin(t * .9) * .012;
    authored.faceMaterial.emissiveIntensity = .34 + energy * .72;
    authored.hairMaterial.emissiveIntensity = .42 + energy * .88;
    authored.hairMaterial.opacity = .3 + energy * .14;
    authored.eyeMaterial.emissiveIntensity = .9 + energy * 1.4;
    authored.meshes.forEach(mesh => {
      const left = mesh.morphTargetDictionary?.blink_left;
      const right = mesh.morphTargetDictionary?.blink_right;
      if (left !== undefined && right !== undefined) {
        const blink = Math.max(0, Math.sin(t * .74 - 1.2) - .985) * 66;
        mesh.morphTargetInfluences[left] = blink;
        mesh.morphTargetInfluences[right] = blink;
      }
    });
    neural.group.rotation.z = t * (state === "thinking" ? .105 : .025);
    neural.nodes.rotation.y = t * (state === "executing" ? .52 : .13);
    neural.material.opacity = .14 + energy * .4;
    ambient.group.rotation.y = t * .018; ambient.material.opacity = .13 + energy * .18;
    scanMaterial.opacity = state === "executing" ? .45 : Math.max(0, scanMaterial.opacity - .04);
    scan.position.y = state === "executing" ? 1.55 - ((t * .78) % 3.2) : -2;
    rim.intensity = 9 + energy * 18;
    renderer.render(scene, camera);
    measuredFrames += 1;
    if (timestamp - measuredAt >= 1000) { measuredFps = Math.round(measuredFrames * 1000 / (timestamp - measuredAt)); measuredFrames = 0; measuredAt = timestamp; }
  }

  function onPointerMove(event) {
    if (!running) return;
    const rect = canvas.getBoundingClientRect();
    pointerYaw = ((event.clientX - rect.left) / rect.width - .5) * .24;
    pointerPitch = ((event.clientY - rect.top) / rect.height - .5) * .1;
  }
  function onPointerLeave() { pointerYaw = 0; pointerPitch = 0; }
  canvas.addEventListener("pointermove", onPointerMove, { passive: true });
  canvas.addEventListener("pointerleave", onPointerLeave, { passive: true });

  const api = Object.freeze({
    start() { if (!running && !disposed) { running = true; measuredAt = performance.now(); frame = requestAnimationFrame(render); } return api; },
    stop() { running = false; if (frame) cancelAnimationFrame(frame); frame = 0; return api; },
    setState(next) { if (VALID_STATES.has(next)) state = next; return api; },
    setView(next) { if (["front", "three-quarter", "profile"].includes(next)) viewAngle = next; return api; },
    getState: () => state,
    metrics: () => ({ fps: measuredFps, triangles: renderer.info.render.triangles, calls: renderer.info.render.calls, webgl: true, authored: authored.loaded, view: viewAngle }),
    capture: () => canvas.toDataURL("image/png"),
    dispose() { api.stop(); disposed = true; canvas.removeEventListener("pointermove", onPointerMove); canvas.removeEventListener("pointerleave", onPointerLeave); scene.traverse(object => { object.geometry?.dispose?.(); if (Array.isArray(object.material)) object.material.forEach(material => material.dispose?.()); else object.material?.dispose?.(); }); renderer.dispose(); }
  });
  return api;
}

function createAuthoredIdentity({ root, palette }) {
  const group = new THREE.Group();
  group.position.y = -12.6;
  group.scale.setScalar(9);
  group.rotation.y = 0;
  root.add(group);

  const clip = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1.28);
  const faceMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x04141d, emissive: 0x087789, emissiveIntensity: .38,
    metalness: .48, roughness: .27, clearcoat: 1, clearcoatRoughness: .14,
    transparent: true, opacity: .72, side: THREE.DoubleSide, clippingPlanes: [clip]
  });
  const featureMaterial = new THREE.MeshPhysicalMaterial({
    color: palette.cyan, emissive: palette.teal, emissiveIntensity: .72,
    metalness: .35, roughness: .24, transparent: true, opacity: .78,
    side: THREE.DoubleSide, clippingPlanes: [clip]
  });
  const eyeMaterial = new THREE.MeshPhysicalMaterial({
    color: palette.mint, emissive: palette.mint, emissiveIntensity: 1.1,
    metalness: .18, roughness: .16, transparent: true, opacity: .92,
    side: THREE.DoubleSide, clippingPlanes: [clip]
  });
  const eyeBaseMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x071c25, emissive: 0x0b4e5a, emissiveIntensity: .42,
    metalness: .32, roughness: .2, clearcoat: 1, transparent: true, opacity: .9,
    side: THREE.DoubleSide, clippingPlanes: [clip]
  });
  const corneaMaterial = new THREE.MeshPhysicalMaterial({
    color: palette.ice, emissive: palette.teal, emissiveIntensity: .12,
    metalness: 0, roughness: .05, transmission: .25, transparent: true, opacity: .18,
    side: THREE.DoubleSide, clippingPlanes: [clip], depthWrite: false
  });
  const topologyMaterial = new THREE.MeshBasicMaterial({
    color: palette.cyan, transparent: true, opacity: .07, wireframe: true,
    blending: THREE.AdditiveBlending, depthWrite: false, clippingPlanes: [clip]
  });
  const hairMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x062e3c, emissive: palette.cyan, emissiveIntensity: .48,
    metalness: .7, roughness: .24, clearcoat: .8, clearcoatRoughness: .2,
    transparent: true, opacity: .34, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, depthWrite: false, clippingPlanes: [clip]
  });
  const loader = new GLTFLoader();
  const meshes = [];
  const load = path => new Promise((resolve, reject) => loader.load(path, resolve, undefined, reject));
  const controller = { group, meshes, faceMaterial, featureMaterial, eyeMaterial, hairMaterial, loaded: false, ready: null };
  controller.ready = Promise.all([
    load("/assets/models/nova-female-base.glb"),
    load("/assets/models/nova-hair-bob.glb")
  ]).then(([body, hair]) => {
    const configure = (scene, isHair = false) => {
      const overlays = [];
      scene.traverse(object => {
        if (!object.isMesh && !object.isSkinnedMesh) return;
        meshes.push(object);
        const dictionary = object.morphTargetDictionary || {};
        const influence = object.morphTargetInfluences || [];
        const setMorph = (name, value) => { if (dictionary[name] !== undefined) influence[dictionary[name]] = value; };
        setMorph("gender_female", 1);
        setMorph("gender_male", 0);
        setMorph("face_cheekbones_incr", .16);
        setMorph("face_eye_size_incr", .08);
        setMorph("face_eye_tilt_incr", .08);
        setMorph("face_jaw_width_decr", .1);
        setMorph("face_lips_incr", .08);
        const materialName = object.material?.name || "";
        if (isHair) object.material = hairMaterial;
        else if (materialName === "Skin") object.material = faceMaterial;
        else if (materialName === "Iris") object.material = eyeMaterial;
        else if (materialName === "Eye") object.material = eyeBaseMaterial;
        else if (materialName === "Cornea") object.material = corneaMaterial;
        else if (["Eyebrow", "Eyelash"].includes(materialName)) object.material = featureMaterial;
        else object.visible = false;
        object.frustumCulled = false;
        if (!isHair && materialName === "Skin") {
          const overlay = object.clone();
          overlay.material = topologyMaterial;
          overlay.renderOrder = object.renderOrder + 1;
          overlays.push(overlay);
        }
      });
      overlays.forEach(overlay => scene.add(overlay));
      group.add(scene);
    };
    configure(body.scene);
    configure(hair.scene, true);
    controller.loaded = true;
    return controller;
  });
  return controller;
}

function facePatchPoint(u, v) {
  const y = 1.34 - v * 2.67;
  const width = faceWidth(y);
  const x = u * width;
  let z = .62 - .23 * u * u;
  const eyeSockets = gaussian(x, y, -.31, .38, .19, .13) + gaussian(x, y, .31, .38, .19, .13);
  const brows = gaussian(x, y, -.31, .56, .24, .1) + gaussian(x, y, .31, .56, .24, .1);
  const temples = gaussian(x, y, -.68, .46, .2, .3) + gaussian(x, y, .68, .46, .2, .3);
  const cheeks = gaussian(x, y, -.43, -.04, .26, .25) + gaussian(x, y, .43, -.04, .26, .25);
  const noseBridge = gaussian(x, y, 0, .3, .115, .43);
  const noseTip = gaussian(x, y, 0, -.08, .17, .14);
  const philtrum = gaussian(x, y, 0, -.34, .11, .12);
  const lips = gaussian(x, y, 0, -.51, .29, .07);
  const chin = gaussian(x, y, 0, -1.02, .3, .24);
  z += -eyeSockets * .14 + brows * .055 - temples * .055 + cheeks * .13 + noseBridge * .48 + noseTip * .28 - philtrum * .055 + lips * .14 + chin * .12;
  return new THREE.Vector3(x, y, z);
}

function faceWidth(y) {
  const profile = [
    [1.34,.43],[1.12,.64],[.72,.78],[.2,.82],[-.24,.78],[-.62,.68],[-.98,.5],[-1.22,.29],[-1.33,.08]
  ];
  for (let index = 0; index < profile.length - 1; index += 1) {
    const [topY, topWidth] = profile[index], [bottomY, bottomWidth] = profile[index + 1];
    if (y <= topY && y >= bottomY) {
      const amount = (topY - y) / (topY - bottomY);
      return THREE.MathUtils.lerp(topWidth, bottomWidth, amount);
    }
  }
  return y > profile[0][0] ? profile[0][1] : profile.at(-1)[1];
}

function buildFaceGeometry(rows, columns) {
  const positions = [], indices = [];
  for (let row = 0; row <= rows; row += 1) for (let column = 0; column <= columns; column += 1) {
    const point = facePatchPoint(column / columns * 2 - 1, row / rows);
    positions.push(point.x, point.y, point.z);
  }
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const a = row * (columns + 1) + column, b = a + columns + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3)); geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

function buildFaceContours(palette) {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({ color: palette.cyan, transparent: true, opacity: .16, depthWrite: false, blending: THREE.AdditiveBlending });
  for (const row of [3, 10, 17, 24, 31, 38, 45, 52, 59]) {
    const points = [];
    for (let column = 0; column <= 42; column += 1) points.push(facePatchPoint(column / 21 - 1, row / 62));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
  for (const column of [4, 10, 16, 21, 26, 32, 38]) {
    const points = [];
    for (let row = 0; row <= 62; row += 1) points.push(facePatchPoint(column / 21 - 1, row / 62));
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), material));
  }
  return group;
}

function buildFacialFeatures(palette) {
  const group = new THREE.Group(), speechGroup = new THREE.Group(); group.add(speechGroup);
  const primary = new THREE.LineBasicMaterial({ color: palette.ice, transparent: true, opacity: .76, depthWrite: false, blending: THREE.AdditiveBlending });
  const secondary = new THREE.LineBasicMaterial({ color: palette.cyan, transparent: true, opacity: .28, depthWrite: false, blending: THREE.AdditiveBlending });
  const add = (points, material = primary, parent = group) => parent.add(curveLine(points, material));
  add([[-.54,.42,.78],[-.43,.36,1.03],[-.28,.34,1.13],[-.16,.4,1.01]],primary);
  add([[.54,.42,.78],[.43,.36,1.03],[.28,.34,1.13],[.16,.4,1.01]],primary);
  add([[-.52,.4,.8],[-.4,.31,1.01],[-.27,.31,1.09],[-.17,.39,1.0]],secondary);
  add([[.52,.4,.8],[.4,.31,1.01],[.27,.31,1.09],[.17,.39,1.0]],secondary);
  add([[-.55,.55,.72],[-.38,.61,.94],[-.18,.57,.95]],secondary);
  add([[.55,.55,.72],[.38,.61,.94],[.18,.57,.95]],secondary);
  add([[0,.78,.82],[-.035,.46,1.12],[-.02,.13,1.34],[-.13,-.04,1.22],[0,-.09,1.3],[.14,-.04,1.2]],primary);
  add([[-.31,-.43,1.02],[-.16,-.49,1.18],[0,-.46,1.25],[.16,-.49,1.18],[.31,-.43,1.02]],primary,speechGroup);
  add([[-.27,-.51,1.03],[-.13,-.57,1.15],[0,-.58,1.18],[.13,-.57,1.15],[.27,-.51,1.03]],secondary,speechGroup);
  add([[-.7,-.08,.77],[-.55,-.02,.96],[-.38,-.08,1.08]],secondary);
  add([[.7,-.08,.77],[.55,-.02,.96],[.38,-.08,1.08]],secondary);
  add([[-.7,-.3,.78],[-.58,-.66,.84],[-.36,-.99,.91],[0,-1.16,.99],[.36,-.99,.91],[.58,-.66,.84],[.7,-.3,.78]],primary);
  const irisMaterial = new THREE.MeshBasicMaterial({ color: palette.mint, transparent: true, opacity: .7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
  for (const side of [-1, 1]) {
    const iris = new THREE.Mesh(new THREE.RingGeometry(.026, .044, 28), irisMaterial);
    iris.position.set(side * .335, .365, 1.125);
    group.add(iris);
  }
  return { group, speechGroup, primary, secondary };
}

function buildDataHair(palette) {
  const group = new THREE.Group();
  const fine = new THREE.LineBasicMaterial({ color: palette.teal, transparent: true, opacity: .18, blending: THREE.AdditiveBlending, depthWrite: false });
  const hero = new THREE.LineBasicMaterial({ color: palette.cyan, transparent: true, opacity: .52, blending: THREE.AdditiveBlending, depthWrite: false });
  const part = -.13;
  for (let index = 0; index < 26; index += 1) {
    const side = index < 12 ? -1 : 1, lane = index < 12 ? index : index - 12;
    const count = side < 0 ? 11 : 13, p = lane / count;
    const length = side < 0 ? 1.16 + p * .42 : 1.34 + p * .5;
    const sweep = side < 0 ? -.18 - p * .45 : .22 + p * .62;
    const startX = part + side * (.025 + p * .34);
    const endX = side * (.72 + p * .34) + (side > 0 ? .12 : -.02);
    const points = [
      [startX,1.43-p*.08,.18],
      [sweep,1.24-p*.04,.38+p*.08],
      [side*(.72+p*.18),.7,.28+p*.05],
      [side*(.86+p*.2),.05,.15-p*.08],
      [endX,1.3-length,-.02-p*.16]
    ];
    group.add(curveLine(points, index % 4 === 0 ? hero : fine, 44));
  }
  for (const side of [-1,1]) for (let index = 0; index < 3; index += 1) {
    const p = index / 2;
    const curve = new THREE.CatmullRomCurve3(vectors([
      [part + side*(.04+p*.2),1.43,.2],
      [side*(.48+p*.16),1.18,.5],
      [side*(.82+p*.12),.48,.4],
      [side*(.88+p*.18),-.35,.22],
      [side*(.76+p*.25),-1.28-(side>0?.18:0),-.08]
    ]));
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 64, .008 + index * .002, 6, false), new THREE.MeshBasicMaterial({ color: index === 1 ? palette.ice : palette.cyan, transparent: true, opacity: .26 + index * .08, blending: THREE.AdditiveBlending, depthWrite: false }));
    group.add(tube);
  }
  const crown = curveLine([[-.72,.96,.05],[-.58,1.35,-.06],[-.14,1.55,-.12],[.34,1.48,-.1],[.74,1.08,.03]], hero, 54);
  group.add(crown);
  return { group, fine, hero };
}

function buildNeuralHalo(palette) {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({ color: palette.cyan, transparent: true, opacity: .2, blending: THREE.AdditiveBlending, depthWrite: false });
  for (let index = 0; index < 5; index += 1) {
    const curve = new THREE.EllipseCurve(0, 0, 1.38 + index * .13, 1.7 + index * .11, 0, Math.PI * 2, false, index * .22);
    const points = curve.getPoints(120).map(point => new THREE.Vector3(point.x, point.y, -.68-index*.05));
    const line = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material); line.rotation.y = (index - 2) * .1; group.add(line);
  }
  const nodes = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.022, 0), new THREE.MeshBasicMaterial({ color: palette.mint, transparent: true, opacity: .78 }), 22); group.add(nodes);
  const nodeTransform = new THREE.Object3D();
  for (let index = 0; index < 22; index += 1) { const angle = index / 22 * Math.PI * 2; nodeTransform.position.set(Math.cos(angle)*(1.4+index%3*.12),Math.sin(angle)*(1.7+index%2*.1),-.58+Math.sin(index*2.1)*.18); nodeTransform.updateMatrix(); nodes.setMatrixAt(index, nodeTransform.matrix); }
  return { group, nodes, material };
}

function buildAmbientField(palette) {
  const positions = [];
  const random = seededRandom(9017);
  for (let index = 0; index < 560; index += 1) { const radius = 2.1 + random() * 3.7, angle = random() * Math.PI * 2; positions.push(Math.cos(angle)*radius,(random()-.5)*5.8,Math.sin(angle)*radius-1.8); }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position",new THREE.Float32BufferAttribute(positions,3));
  const material = new THREE.PointsMaterial({ color: palette.cyan, size: .012, transparent: true, opacity: .16, depthWrite: false, blending: THREE.AdditiveBlending });
  return { group: new THREE.Points(geometry, material), material };
}

function curveLine(points, material, divisions = 28) { const curve = new THREE.CatmullRomCurve3(vectors(points)); return new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(divisions)), material); }
function vectors(points) { return points.map(([x,y,z]) => new THREE.Vector3(x,y,z)); }
function gaussian(x,y,cx,cy,sx,sy) { return Math.exp(-(((x-cx)/sx)**2+((y-cy)/sy)**2)); }
function clamp(value) { return Math.max(0,Math.min(1,Number(value)||0)); }
function seededRandom(seed) { let value=seed>>>0; return()=>{value=(value*1664525+1013904223)>>>0;return value/4294967296;}; }
function fallbackController(error) { const api=Object.freeze({start:()=>api,stop:()=>api,setState:()=>api,setView:()=>api,getState:()=>"error",metrics:()=>({fps:0,triangles:0,calls:0,webgl:false,error:error?.message||"WebGL unavailable"}),capture:()=>null,dispose(){}});return api; }
