import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createStaticFileHandler } from "../src/http/static-files.js";

function response() { const headers = new Map(); return { setHeader(name, value) { headers.set(name.toLowerCase(), value); }, end(value) { this.body = value; }, headers }; }

test("console document includes API UI, PWA metadata, and no embedded secrets", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /Nova Brain/); assert.match(html, /id="messageInput"/); assert.match(html, /manifest\.webmanifest/);
  assert.doesNotMatch(html, /OPENAI_API_KEY|sk-[A-Za-z0-9]/);
});

test("console exposes the controlled Mohammad owner profile and Memory workspace", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/console.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /Mohammad Shanbour/);
  assert.match(html, /محمد شنبور/);
  assert.match(html, /id="memoryDialog"[^>]+hidden/);
  assert.doesNotMatch(html, /hshanbour/i);
  assert.match(script, /memoryDialog\.hidden = false/);
  assert.match(script, /data-close-memory/);
});

test("local static handler serves console assets with defensive headers", async () => {
  const serve = createStaticFileHandler({ loadFile: async () => Buffer.from("asset") }); const res = response();
  assert.equal(await serve({ method: "GET", url: "/assets/console.js" }, res), true);
  assert.equal(res.statusCode, 200); assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8"); assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("local static handler ignores unknown and non-GET routes", async () => {
  const serve = createStaticFileHandler();
  assert.equal(await serve({ method: "GET", url: "/api/health" }, response()), false);
  assert.equal(await serve({ method: "POST", url: "/" }, response()), false);
});
