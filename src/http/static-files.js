import { readFile } from "node:fs/promises";

const ASSETS = Object.freeze({
  "/": { file: "../../index.html", type: "text/html; charset=utf-8" },
  "/manifest.webmanifest": { file: "../../manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/assets/console.css": { file: "../../assets/console.css", type: "text/css; charset=utf-8" },
  "/assets/console.js": { file: "../../assets/console.js", type: "text/javascript; charset=utf-8" },
  "/assets/api-client.js": { file: "../../assets/api-client.js", type: "text/javascript; charset=utf-8" },
  "/assets/conversation-history.js": { file: "../../assets/conversation-history.js", type: "text/javascript; charset=utf-8" },
  "/assets/memory-client.js": { file: "../../assets/memory-client.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-input.js": { file: "../../assets/voice-input.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-output.js": { file: "../../assets/voice-output.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-mode.js": { file: "../../assets/voice-mode.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-benchmark.js": { file: "../../assets/voice-benchmark.js", type: "text/javascript; charset=utf-8" },
  "/assets/workspace-navigation.js": { file: "../../assets/workspace-navigation.js", type: "text/javascript; charset=utf-8" },
  "/assets/nova-mark.svg": { file: "../../assets/nova-mark.svg", type: "image/svg+xml" }
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
