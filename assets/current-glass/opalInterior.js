import * as THREE from "../vendor/three.module.min.js";
/** Small authored paths embedded below the actual GLB's front surface.
 * The lookup is built once; no raycasts, texture downloads or mesh edits. */
export function createOpalInterior(geometry) {
    const group = new THREE.Group();
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
        return (weight ? total / weight : .2) - .065;
    }
    const uniforms = {
        uTime: { value: 0 }, uEnergy: { value: 0 }, uListen: { value: 0 },
        uPrepare: { value: 0 }, uReveal: { value: 0 }, uBreath: { value: 0 },
    };
    const material = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        uniforms,
        vertexShader: `varying float vAlong; varying float vCross;
      void main(){vAlong=uv.x;vCross=uv.y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
        fragmentShader: `varying float vAlong;varying float vCross;
      uniform float uTime;uniform float uEnergy;uniform float uListen;
      uniform float uPrepare;uniform float uReveal;uniform float uBreath;
      void main(){
        float reveal=1.-smoothstep(uReveal-.1,uReveal+.08,vAlong);
        float outward=pow(.5+.5*cos(vAlong*10.-uTime*3.8),10.);
        float inward=pow(.5+.5*cos(vAlong*9.+uTime*1.9),8.);
        float shimmer=.5+.5*sin(vAlong*15.+uTime*.85);
        float light=.40+uBreath*.045+uListen*inward*.16+uPrepare*shimmer*.16;
        float gold=outward*uEnergy;
        vec3 opal=mix(vec3(.46,.39,.78),vec3(.73,.57,.77),vAlong*.65);
        vec3 colour=mix(opal,vec3(1.,.80,.43),clamp(gold*1.7,0.,1.));
        float edge=.65+.35*sin(vCross*3.14159);
        gl_FragColor=vec4(colour*(.9+gold),reveal*edge*(light+gold*.4));
        #include <colorspace_fragment>
      }`,
    });
    // Paired tributaries: neck → collarbone → shoulder, plus quieter chest branches.
    const routes = [
        [[.10, 1.08], [.15, .91], [.22, .76], [.43, .64], [.72, .59], [1.02, .45], [1.17, .30]],
        [[.11, 1.06], [.19, .88], [.28, .73], [.49, .60], [.78, .50], [1.09, .31]],
        [[.09, 1.04], [.13, .88], [.21, .71], [.38, .57], [.63, .48], [.88, .30], [.99, .13]],
        [[.08, 1.02], [.11, .85], [.18, .68], [.30, .51], [.44, .36], [.52, .13]],
        [[.08, 1.00], [.09, .82], [.12, .63], [.18, .43], [.20, .12]],
    ];
    for (const side of [-1, 1])
        routes.forEach((route, index) => {
            const points = route.map(([x, y]) => new THREE.Vector3(x * side, y, front(x * side, y)));
            const curve = new THREE.CatmullRomCurve3(points);
            const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 72, index === 0 ? .006 : .004, 4, false), material);
            tube.renderOrder = .8;
            group.add(tube);
        });
    // Short collarbone cross-links give the branching design structure, not a wire cage.
    for (const side of [-1, 1])
        for (let i = 0; i < 3; i++) {
            const x = (.28 + i * .20) * side, y = .66 - i * .07;
            const curve = new THREE.CatmullRomCurve3([
                new THREE.Vector3(x, y, front(x, y)),
                new THREE.Vector3(x + side * .04, y - .04, front(x + side * .04, y - .04)),
                new THREE.Vector3(x + side * .08, y - .09, front(x + side * .08, y - .09)),
            ]);
            const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, .0025, 3, false), material);
            tube.renderOrder = .8;
            group.add(tube);
        }
    let started = null, listen = 0, prepare = 0;
    return {
        group,
        update(time, dt, phase, energy, enabled) {
            group.visible = enabled;
            if (started === null)
                started = time;
            const ease = 1 - Math.exp(-dt * 3);
            listen += ((phase === "listening" ? 1 : 0) - listen) * ease;
            prepare += ((phase === "preparing" ? 1 : 0) - prepare) * ease;
            uniforms.uTime.value = time;
            uniforms.uEnergy.value = phase === "speaking" ? energy : 0;
            uniforms.uListen.value = listen;
            uniforms.uPrepare.value = prepare;
            uniforms.uBreath.value = Math.sin(time * .85);
            uniforms.uReveal.value = Math.min(1.2, (time - started) / 2.2);
        },
    };
}
