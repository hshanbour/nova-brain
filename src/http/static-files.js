import { readFile } from "node:fs/promises";

const ASSETS = Object.freeze({
  ...Object.fromEntries(['current-glass-avatar.js','current-glass-signal.js',...['coreScene.js','opalInterior.js','moltenInterior.js','contourLighting.js','nova.glb'].map(n=>'current-glass/'+n)].map(n=>['/assets/'+n,{file:'../../assets/'+n,type:n.endsWith('.glb')?'model/gltf-binary':'text/javascript; charset=utf-8'}])),
  "/assets/models/prism-edge.jpg":{file:"../../assets/models/prism-edge.jpg",type:"image/jpeg"},
  "/assets/prism-locks.js":{file:"../../assets/prism-locks.js",type:"text/javascript; charset=utf-8"},
  "/assets/prism-bust.js":{file:"../../assets/prism-bust.js",type:"text/javascript; charset=utf-8"},
  "/assets/prism-articulation.js":{file:"../../assets/prism-articulation.js",type:"text/javascript; charset=utf-8"},
  "/assets/models/prism-bust.glb":{file:"../../assets/models/prism-bust.glb",type:"model/gltf-binary"},
  "/assets/vision/camera.js": {"file":"../../assets/vision/camera.js","type":"text/javascript; charset=utf-8"},
  "/assets/vision/hand.task": {"file":"../../assets/vision/hand.task","type":"application/octet-stream"},
  "/assets/vision/object.tflite": {"file":"../../assets/vision/object.tflite","type":"application/octet-stream"},
  "/assets/vision/observation.js": {"file":"../../assets/vision/observation.js","type":"text/javascript; charset=utf-8"},
  "/assets/vision/perception-worker.js": {"file":"../../assets/vision/perception-worker.js","type":"text/javascript; charset=utf-8"},
  "/assets/vision/vision_bundle.mjs": {"file":"../../assets/vision/vision_bundle.mjs","type":"text/javascript; charset=utf-8"},
  "/assets/vision/wasm/vision_wasm_internal.js": {"file":"../../assets/vision/wasm/vision_wasm_internal.js","type":"text/javascript; charset=utf-8"},
  "/assets/vision/wasm/vision_wasm_internal.wasm": {"file":"../../assets/vision/wasm/vision_wasm_internal.wasm","type":"application/wasm"},
  "/assets/vision/wasm/vision_wasm_nosimd_internal.js": {"file":"../../assets/vision/wasm/vision_wasm_nosimd_internal.js","type":"text/javascript; charset=utf-8"},
  "/assets/vision/wasm/vision_wasm_nosimd_internal.wasm": {"file":"../../assets/vision/wasm/vision_wasm_nosimd_internal.wasm","type":"application/wasm"},
  "/": { file: "../../index.html", type: "text/html; charset=utf-8" },
  "/manifest.webmanifest": { file: "../../manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/assets/console.css": { file: "../../assets/console.css", type: "text/css; charset=utf-8" },
  "/assets/owner-phone.css": { file: "../../assets/owner-phone.css", type: "text/css; charset=utf-8" },
  "/assets/console.js": { file: "../../assets/console.js", type: "text/javascript; charset=utf-8" },
  "/assets/matrix-avatar.js": { file: "../../assets/matrix-avatar.js", type: "text/javascript; charset=utf-8" },
  "/assets/premium-avatar.js": { file: "../../assets/premium-avatar.js", type: "text/javascript; charset=utf-8" },
  "/assets/models/prism-shard-bloom.png": { file: "../../assets/models/prism-shard-bloom.png", type: "image/png" },
  "/assets/vendor/three.module.min.js": { file: "../../assets/vendor/three.module.min.js", type: "text/javascript; charset=utf-8" },
  "/assets/vendor/three.core.min.js": { file: "../../assets/vendor/three.core.min.js", type: "text/javascript; charset=utf-8" },
  "/assets/vendor/loaders/GLTFLoader.js": { file: "../../assets/vendor/loaders/GLTFLoader.js", type: "text/javascript; charset=utf-8" },
  "/assets/vendor/utils/BufferGeometryUtils.js": { file: "../../assets/vendor/utils/BufferGeometryUtils.js", type: "text/javascript; charset=utf-8" },
  "/assets/models/nova-female-base.glb": { file: "../../assets/models/nova-female-base.glb", type: "model/gltf-binary" },
  "/assets/models/nova-hair-bob.glb": { file: "../../assets/models/nova-hair-bob.glb", type: "model/gltf-binary" },
  "/assets/models/asset_licenses.json": { file: "../../assets/models/asset_licenses.json", type: "application/json; charset=utf-8" },
  "/assets/approval-presenter.js": { file: "../../assets/approval-presenter.js", type: "text/javascript; charset=utf-8" },
  "/assets/api-client.js": { file: "../../assets/api-client.js", type: "text/javascript; charset=utf-8" },
  "/assets/conversation-history.js": { file: "../../assets/conversation-history.js", type: "text/javascript; charset=utf-8" },
  "/assets/memory-client.js": { file: "../../assets/memory-client.js", type: "text/javascript; charset=utf-8" },
  "/assets/message-markdown.js": { file: "../../assets/message-markdown.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-input.js": { file: "../../assets/voice-input.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-output.js": { file: "../../assets/voice-output.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-mode.js": { file: "../../assets/voice-mode.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-v2-client.js": { file: "../../assets/voice-v2-client.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-capture.js": { file: "../../assets/voice-capture.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-v2.js": { file: "../../assets/voice-v2.js", type: "text/javascript; charset=utf-8" },
  "/assets/realtime-voice.js": { file: "../../assets/realtime-voice.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-control.js": { file: "../../assets/voice-control.js", type: "text/javascript; charset=utf-8" },
  "/assets/speaker-enrollment.js": { file: "../../assets/speaker-enrollment.js", type: "text/javascript; charset=utf-8" },
  "/assets/speaker-familiarity.js": { file: "../../assets/speaker-familiarity.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-benchmark.js": { file: "../../assets/voice-benchmark.js", type: "text/javascript; charset=utf-8" },
  "/assets/workspace-navigation.js": { file: "../../assets/workspace-navigation.js", type: "text/javascript; charset=utf-8" },
  "/assets/project-workspace.js": { file: "../../assets/project-workspace.js", type: "text/javascript; charset=utf-8" },
  "/assets/operational-dashboard.js": { file: "../../assets/operational-dashboard.js", type: "text/javascript; charset=utf-8" },
  "/assets/web-citations.js": { file: "../../assets/web-citations.js", type: "text/javascript; charset=utf-8" },
  "/assets/nova-mark.svg": { file: "../../assets/nova-mark.svg", type: "image/svg+xml" },
  "/assets/social/reels/three-jobs-ai-should-assist-v1.mp4": { file: "../../assets/social/reels/three-jobs-ai-should-assist-v1.mp4", type: "video/mp4" },
  "/assets/social/reels/three-jobs-ai-should-assist-v1-poster.jpg": { file: "../../assets/social/reels/three-jobs-ai-should-assist-v1-poster.jpg", type: "image/jpeg" }
});

export function createStaticFileHandler({ loadFile = readFile } = {}) {
  return async function serveStatic(request, response) {
    if (request.method !== "GET") return false;
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    const asset = ASSETS[pathname];
    if (!asset) return false;
    const body = await loadFile(new URL(asset.file, import.meta.url));
    response.statusCode = 200;
    response.setHeader("Content-Type", asset.type);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.end(body);
    return true;
  };
}
