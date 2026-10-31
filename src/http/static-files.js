import { readFile } from "node:fs/promises";

const ASSETS = Object.freeze({
  "/": { file: "../../index.html", type: "text/html; charset=utf-8" },
  "/manifest.webmanifest": { file: "../../manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
  "/assets/console.css": { file: "../../assets/console.css", type: "text/css; charset=utf-8" },
  "/assets/console.js": { file: "../../assets/console.js", type: "text/javascript; charset=utf-8" },
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
  "/assets/voice-control.js": { file: "../../assets/voice-control.js", type: "text/javascript; charset=utf-8" },
  "/assets/speaker-enrollment.js": { file: "../../assets/speaker-enrollment.js", type: "text/javascript; charset=utf-8" },
  "/assets/speaker-familiarity.js": { file: "../../assets/speaker-familiarity.js", type: "text/javascript; charset=utf-8" },
  "/assets/voice-benchmark.js": { file: "../../assets/voice-benchmark.js", type: "text/javascript; charset=utf-8" },
  "/assets/workspace-navigation.js": { file: "../../assets/workspace-navigation.js", type: "text/javascript; charset=utf-8" },
  "/assets/project-workspace.js": { file: "../../assets/project-workspace.js", type: "text/javascript; charset=utf-8" },
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
