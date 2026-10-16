import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { selectWorkspace } from "../assets/workspace-navigation.js";
import { createStaticFileHandler } from "../src/http/static-files.js";

function link(section) {
  const classes = new Set(); const attributes = new Map();
  return { dataset: { section }, classList: { toggle(name, active) { active ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } }, setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); }, getAttribute(name) { return attributes.get(name); } };
}

test("workspace selection hides every inactive workspace and synchronises desktop and mobile links", () => {
  const chat = { id: "chat", hidden: false }; const memory = { id: "memory", hidden: true };
  const links = [link("chat"), link("memory"), link("chat"), link("memory")];
  assert.equal(selectWorkspace({ workspaces: [chat, memory], links, name: "memory" }), "memory");
  assert.equal(chat.hidden, true); assert.equal(memory.hidden, false);
  assert.deepEqual(links.map((item) => item.classList.contains("active")), [false, true, false, true]);
  assert.equal(links[1].getAttribute("aria-current"), "page");
  assert.equal(selectWorkspace({ workspaces: [chat, memory], links, name: "chat" }), "chat");
  assert.equal(chat.hidden, false); assert.equal(memory.hidden, true);
  assert.deepEqual(links.map((item) => item.classList.contains("active")), [true, false, true, false]);
});

test("unknown or default workspace selection safely falls back to Chat", () => {
  const chat = { id: "chat", hidden: true }; const memory = { id: "memory", hidden: false };
  assert.equal(selectWorkspace({ workspaces: [chat, memory], links: [], name: "unknown" }), "chat");
  assert.equal(chat.hidden, false); assert.equal(memory.hidden, true);
});

test("generic hidden CSS wins over workspace display declarations", async () => {
  const css = await readFile(new URL("../assets/console.css", import.meta.url), "utf8");
  assert.match(css, /\.workspace\[hidden\]\{display:none\}/);
});

test("the local Console server exposes every module in the navigation startup import graph", async () => {
  const [consoleSource, voiceV2Source] = await Promise.all([
    readFile(new URL("../assets/console.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/voice-v2.js", import.meta.url), "utf8"),
  ]);
  const importedAssets = [...`${consoleSource}\n${voiceV2Source}`.matchAll(/from\s+["']\.\/(.+?\.js)["']/g)]
    .map((match) => `/assets/${match[1]}`);
  const serveStatic = createStaticFileHandler();

  for (const asset of new Set(importedAssets)) {
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
    assert.equal(await serveStatic({ method: "GET", url: asset }, response), true, `${asset} must be served`);
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["Content-Type"], /^text\/javascript/);
    assert.ok(response.body.length > 0);
  }
});

test("the local Console server exposes the owned first-Reel media with safe MIME types", async () => {
  const requests = [];
  const serveStatic = createStaticFileHandler({
    async loadFile(url) {
      requests.push(String(url));
      return Buffer.from("owned-media");
    }
  });
  for (const [url, expectedType] of [
    ["/assets/social/reels/three-jobs-ai-should-assist-v1.mp4", "video/mp4"],
    ["/assets/social/reels/three-jobs-ai-should-assist-v1-poster.jpg", "image/jpeg"]
  ]) {
    const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
    assert.equal(await serveStatic({ method: "GET", url }, response), true);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["Content-Type"], expectedType);
    assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  }
  assert.equal(requests.length, 2);
});
