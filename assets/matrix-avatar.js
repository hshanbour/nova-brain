const STATES = new Set(["idle", "connecting", "listening", "thinking", "speaking", "executing", "muted", "error"]);
const VARIANTS = new Set(["particle", "wireframe", "entity"]);

export function createMatrixAvatar({ canvas, variant = "particle", state = "idle", inputLevel = () => 0, outputLevel = () => 0, maxFps = 30, raf = globalThis.requestAnimationFrame?.bind(globalThis), caf = globalThis.cancelAnimationFrame?.bind(globalThis), now = () => globalThis.performance?.now?.() ?? Date.now(), dpr = () => Math.min(1.5, globalThis.devicePixelRatio || 1) } = {}) {
  if (!canvas?.getContext) throw new TypeError("Matrix avatar requires a canvas.");
  const context = canvas.getContext("2d", { alpha: true });
  const points = buildHeadPoints(760), strands = buildHairStrands();
  let currentVariant = VARIANTS.has(variant) ? variant : "particle";
  let currentState = STATES.has(state) ? state : "idle";
  let running = false, frame = 0, lastFrame = 0, disposed = false, measuredFrames = 0, measuredAt = now(), measuredFps = 0;
  const interval = 1000 / Math.max(12, Math.min(60, maxFps));

  function resize() {
    const rect = canvas.getBoundingClientRect?.() || { width: canvas.width || 320, height: canvas.height || 420 };
    const ratio = dpr();
    const width = Math.max(180, Math.round(rect.width || 320));
    const height = Math.max(220, Math.round(rect.height || 420));
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
    return { width, height };
  }

  function render(timestamp = now()) {
    if (!running || disposed) return;
    frame = raf?.(render) || 0;
    if (timestamp - lastFrame < interval) return;
    lastFrame = timestamp;
    const size = resize(), t = timestamp / 1000;
    const input = clamp(inputLevel()), output = clamp(outputLevel());
    draw(context, size, points, strands, { variant: currentVariant, state: currentState, t, input, output });
    measuredFrames += 1;
    if (timestamp - measuredAt >= 1000) { measuredFps = Math.round(measuredFrames * 1000 / (timestamp - measuredAt)); measuredFrames = 0; measuredAt = timestamp; }
  }

  function start() { if (!running && !disposed) { running = true; lastFrame = 0; frame = raf?.(render) || 0; } return api; }
  function stop() { running = false; if (frame) caf?.(frame); frame = 0; return api; }
  function setState(next) { if (STATES.has(next)) currentState = next; return api; }
  function setVariant(next) { if (VARIANTS.has(next)) currentVariant = next; return api; }
  function dispose() { stop(); disposed = true; context.clearRect(0, 0, canvas.width, canvas.height); }
  const api = Object.freeze({ start, stop, dispose, setState, setVariant, getState: () => currentState, getVariant: () => currentVariant, metrics: () => ({ fps: measuredFps, pointCount: points.length, running }) });
  return api;
}

function draw(ctx, { width, height }, points, strands, { variant, state, t, input, output }) {
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2, cy = height * .48, scale = Math.min(width, height) * .255;
  const energy = state === "speaking" ? output : state === "listening" ? input : state === "thinking" || state === "executing" ? .22 : .07;
  const muted = state === "muted", error = state === "error";
  const rotY = Math.sin(t * .38) * .16 + (state === "thinking" ? t * .09 : 0);
  const rotX = Math.sin(t * .27) * .035;
  const pulse = 1 + Math.sin(t * 2.1) * .012 + energy * .1;
  const projected = points.map((point, index) => {
    const dissolve = variant === "entity" ? Math.sin(t * 1.7 + index * .37) * (state === "executing" ? .12 : .035) : 0;
    return project({ x: point.x * pulse + dissolve * point.nx, y: point.y * pulse, z: point.z * pulse + dissolve, rotY, rotX, scale, cx, cy });
  });
  const hue = error ? "255,95,126" : muted ? "111,127,142" : state === "executing" ? "105,242,194" : "104,220,255";
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  if (variant === "wireframe") drawWireframe(ctx, projected, points, hue, energy, t);
  else drawParticles(ctx, projected, points, hue, energy, t, variant);
  drawHair(ctx, strands, { rotY, rotX, scale, cx, cy }, hue, energy, t, variant);
  if (state === "executing") drawScan(ctx, width, height, t, hue);
  if (state === "speaking") drawSpeechAura(ctx, cx, cy, scale, output, hue);
  ctx.restore();
}

function drawParticles(ctx, projected, points, hue, energy, t, variant) {
  for (let i = 0; i < projected.length; i += 1) {
    const p = projected[i], source = points[i];
    if (p.depth < 0) continue;
    const shimmer = .55 + .45 * Math.sin(t * 2.4 + i * .71);
    const opacity = Math.max(.08, Math.min(.9, (.18 + p.depth * .25 + energy * .8) * shimmer));
    const radius = variant === "entity" ? .65 + p.depth * 1.5 + energy * 1.2 : .45 + p.depth * 1.15 + energy;
    ctx.fillStyle = `rgba(${hue},${opacity})`;
    ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
    if (source.feature && i % 3 === 0) { ctx.fillStyle = `rgba(225,252,255,${Math.min(1, opacity + .2)})`; ctx.fillRect(p.x, p.y, 1.1, 1.1); }
  }
}

function drawWireframe(ctx, projected, points, hue, energy, t) {
  ctx.lineWidth = .55 + energy;
  for (let i = 0; i < projected.length; i += 3) {
    const p = projected[i], q = projected[(i + 13) % projected.length];
    if (p.depth < .05 || q.depth < .05 || Math.hypot(p.x - q.x, p.y - q.y) > 42) continue;
    ctx.strokeStyle = `rgba(${hue},${.12 + .2 * Math.sin(t + i) ** 2 + energy * .35})`;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
  }
  drawParticles(ctx, projected.filter((_, i) => i % 5 === 0), points.filter((_, i) => i % 5 === 0), hue, energy, t, "particle");
}

function drawHair(ctx, strands, transform, hue, energy, t, variant) {
  ctx.lineWidth = variant === "wireframe" ? .8 : 1.1;
  for (let s = 0; s < strands.length; s += 1) {
    const strand = strands[s]; ctx.beginPath();
    strand.forEach((point, index) => {
      const moved = { ...point, x: point.x + Math.sin(t * .8 + s + point.y * 2) * (.012 + energy * .025) };
      const p = project({ ...moved, ...transform });
      if (index) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    });
    ctx.strokeStyle = `rgba(${hue},${.18 + (s % 5) * .035 + energy * .25})`; ctx.stroke();
  }
}

function drawScan(ctx, width, height, t, hue) { const y = (t * 92) % (height + 80) - 40; const gradient = ctx.createLinearGradient(0, y - 26, 0, y + 26); gradient.addColorStop(0, `rgba(${hue},0)`); gradient.addColorStop(.5, `rgba(${hue},.18)`); gradient.addColorStop(1, `rgba(${hue},0)`); ctx.fillStyle = gradient; ctx.fillRect(0, y - 26, width, 52); }
function drawSpeechAura(ctx, cx, cy, scale, output, hue) { for (let i = 0; i < 3; i += 1) { ctx.strokeStyle = `rgba(${hue},${.1 + output * .25 - i * .025})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(cx, cy, scale * (1.02 + i * .1 + output * .12), scale * (1.3 + i * .08 + output * .16), 0, 0, Math.PI * 2); ctx.stroke(); } }

function project({ x, y, z, rotY, rotX, scale, cx, cy }) {
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY), cosX = Math.cos(rotX), sinX = Math.sin(rotX);
  const x1 = x * cosY - z * sinY, z1 = x * sinY + z * cosY;
  const y1 = y * cosX - z1 * sinX, z2 = y * sinX + z1 * cosX;
  const perspective = 3.7 / (3.7 + z2);
  return { x: cx + x1 * scale * perspective, y: cy + y1 * scale * perspective, depth: Math.max(0, perspective) };
}

function buildHeadPoints(count) {
  const random = seededRandom(74621), values = [];
  for (let i = 0; i < count; i += 1) {
    const u = random(), v = random(), theta = Math.acos(1 - 2 * u), phi = Math.PI * 2 * v;
    let y = Math.cos(theta) * 1.18;
    const jaw = y > .2 ? 1 : Math.max(.58, .92 + y * .28);
    let x = Math.sin(theta) * Math.cos(phi) * .79 * jaw;
    const z = Math.sin(theta) * Math.sin(phi) * .72;
    if (y < -.72) x *= .78;
    const feature = (Math.abs(y + .08) < .09 && Math.abs(x) > .15 && Math.abs(x) < .52 && z < -.2) || (y < -.52 && Math.abs(x) < .36 && z < -.28);
    values.push({ x, y, z, nx: random() * 2 - 1, feature });
  }
  return values;
}

function buildHairStrands() {
  const strands = [];
  for (let s = 0; s < 24; s += 1) {
    const side = s < 12 ? -1 : 1, lane = s % 12, strand = [];
    for (let i = 0; i < 22; i += 1) { const p = i / 21; strand.push({ x: side * (.28 + lane * .035 + Math.sin(p * Math.PI) * .12), y: -1.02 + p * 1.7, z: .04 + Math.cos(p * Math.PI) * .42 }); }
    strands.push(strand);
  }
  return strands;
}

function seededRandom(seed) { let value = seed >>> 0; return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 4294967296; }; }
function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
