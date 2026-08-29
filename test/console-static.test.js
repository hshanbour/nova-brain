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

test("console exposes desktop and accessible mobile recent-conversation controls without replacing Memory navigation", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /id="recentsList"/); assert.match(html, /id="mobileRecentsList"/);
  assert.match(html, /id="recentsDrawer"[^>]+role="dialog"[^>]+aria-modal="true"[^>]+hidden/);
  assert.match(html, /href="#memory"[^>]+data-section="memory"/);
});

test("Console activates all six workspaces and voice input without fake Soon states",async()=>{const html=await readFile(new URL("../index.html",import.meta.url),"utf8");for(const section of ["chat","projects","activity","memory","tools","approvals"]){assert.match(html,new RegExp(`data-section="${section}"`));assert.match(html,new RegExp(`id="${section}"`));}assert.match(html,/id="voiceButton"/);assert.doesNotMatch(html,/Projects<\/span><small>Soon|Activity<\/span><small>Soon|Tools<\/span><small>Soon|Approvals<\/span><small>Soon/);});

test("shared message rendering gives only Nova messages reusable Speak controls and historical loads stay silent",async()=>{const [html,script]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/console.js",import.meta.url),"utf8")]);assert.match(html,/class="speak-response"[^>]+aria-label="Speak response"[^>]+hidden/);assert.match(script,/if \(isNova && voiceOutput\.supported\)/);assert.match(script,/autoSpeakResponse/);assert.match(script,/for \(const stored of storedMessages\) addMessage\(\{ role: stored\.role, text: stored\.content \}\)/);assert.match(script,/stopVoiceActivity\(\); conversationHistory\.startNew/);assert.match(script,/selectConversation\(id\) \{\s+stopVoiceActivity/);});

test("Console includes compact persistent multilingual voice settings",async()=>{const html=await readFile(new URL("../index.html",import.meta.url),"utf8");for(const id of ["voiceSettingsButton","voiceSettingsDialog","microphoneLanguage","preferredVoice","autoSpeak"])assert.match(html,new RegExp(`id="${id}"`));assert.match(html,/Voice preferences stay in this browser/);});

test("Console exposes local Test Voice diagnostics and conversational Voice Mode",async()=>{const [html,script]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/console.js",import.meta.url),"utf8")]);for(const id of ["testVoiceButton","voiceDiagnostic","voiceModeButton","voiceModeStatus"])assert.match(html,new RegExp(`id="${id}"`));assert.match(script,/createVoiceMode/);assert.match(script,/sendMessage\(text,\{autoSpeakResponse:false,throwOnError:true\}\)/);assert.match(script,/voiceMode\.interrupt\(\)/);assert.match(script,/input\.value="";resizeInput\(\);return sendMessage/);});

test("local static handler serves console assets with defensive headers", async () => {
  const serve = createStaticFileHandler({ loadFile: async () => Buffer.from("asset") }); const res = response();
  assert.equal(await serve({ method: "GET", url: "/assets/console.js" }, res), true);
  assert.equal(res.statusCode, 200); assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8"); assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("local static handler serves the conversation history browser module", async () => {
  const serve = createStaticFileHandler({ loadFile: async (url) => Buffer.from(url.pathname) }); const res = response();
  assert.equal(await serve({ method: "GET", url: "/assets/conversation-history.js" }, res), true);
  assert.equal(res.statusCode, 200); assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("local static handler serves the browser-native voice output module", async () => {
  const serve = createStaticFileHandler({ loadFile: async (url) => Buffer.from(url.pathname) }); const res = response();
  assert.equal(await serve({ method: "GET", url: "/assets/voice-output.js" }, res), true);
  assert.equal(res.statusCode, 200); assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("local static handler serves the conversational voice mode module", async () => {
  const serve = createStaticFileHandler({ loadFile: async (url) => Buffer.from(url.pathname) }); const res = response();
  assert.equal(await serve({ method: "GET", url: "/assets/voice-mode.js" }, res), true);
  assert.equal(res.statusCode, 200); assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("local static handler ignores unknown and non-GET routes", async () => {
  const serve = createStaticFileHandler();
  assert.equal(await serve({ method: "GET", url: "/api/health" }, response()), false);
  assert.equal(await serve({ method: "POST", url: "/" }, response()), false);
});
