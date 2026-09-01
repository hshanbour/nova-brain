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

test("Console activates all seven workspaces and voice input without fake Soon states",async()=>{const html=await readFile(new URL("../index.html",import.meta.url),"utf8");for(const section of ["chat","projects","activity","memory","tools","approvals","voice-benchmark"]){assert.match(html,new RegExp(`data-section="${section}"`));assert.match(html,new RegExp(`id="${section}"`));}assert.match(html,/id="voiceButton"/);assert.doesNotMatch(html,/Projects<\/span><small>Soon|Activity<\/span><small>Soon|Tools<\/span><small>Soon|Approvals<\/span><small>Soon/);});

test("Voice Benchmark is isolated, privacy-labelled, blind-rated, and paid-call locked",async()=>{const [html,script]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/voice-benchmark.js",import.meta.url),"utf8")]);for(const id of ["benchmarkSttSample","benchmarkRecordButton","benchmarkRunStt","benchmarkTtsSample","benchmarkRunTts","benchmarkSpend"])assert.match(html,new RegExp(`id="${id}"`));assert.match(html,/Owner-only · Preview/);assert.match(html,/raw audio is not persisted/i);assert.match(script,/Paid provider calls locked/);assert.match(script,/Submit ratings and reveal/);assert.doesNotMatch(html+script,/OPENAI_API_KEY|DEEPGRAM_API_KEY|AZURE_SPEECH_KEY|ELEVENLABS_API_KEY|sk-[A-Za-z0-9]/);});

test("shared message rendering gives only Nova messages reusable Speak controls and historical loads stay silent",async()=>{const [html,script]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/console.js",import.meta.url),"utf8")]);assert.match(html,/class="speak-response"[^>]+aria-label="Speak response"[^>]+hidden/);assert.match(script,/if \(isNova && voiceOutput\.supported\)/);assert.match(script,/autoSpeakResponse/);assert.match(script,/for \(const stored of storedMessages\) addMessage\(\{ role: stored\.role, text: stored\.content \}\)/);assert.match(script,/stopVoiceActivity\(\); conversationHistory\.startNew/);assert.match(script,/selectConversation\(id\) \{\s+stopVoiceActivity/);});

test("Console retains secondary browser-native voice settings",async()=>{const html=await readFile(new URL("../index.html",import.meta.url),"utf8");for(const id of ["voiceSettingsButton","voiceSettingsDialog","microphoneLanguage","preferredVoice","autoSpeak"])assert.match(html,new RegExp(`id="${id}"`));assert.match(html,/preferences stay in this browser/i);});

test("Console exposes premium Voice V2 while retaining local Test Voice diagnostics",async()=>{const [html,script]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/console.js",import.meta.url),"utf8")]);for(const id of ["testVoiceButton","voiceDiagnostic","voiceModeButton","endVoiceButton","voiceModeStatus","speakerEnrollmentButton"])assert.match(html,new RegExp(`id="${id}"`));assert.match(script,/createMediaVoiceCapture/);assert.match(script,/createVoiceV2/);assert.match(script,/sendMessage\(text,\{autoSpeakResponse:false,throwOnError:true,signal,prepareAssistant,context:\{voice:true,speaker\}\}\)/);assert.match(script,/voiceV2\.interrupt\(\)/);assert.match(script,/input\.value="";resizeInput\(\);return sendMessage/);});
test("speaker enrollment requires explicit numbered start stop and confirm actions",async()=>{const [html,script]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/speaker-enrollment.js",import.meta.url),"utf8")]);assert.match(html,/>Start sample 1</);for(const sample of [1,2,3])assert.match(html,new RegExp(`Sample ${sample}: Not recorded`));assert.match(script,/Stop sample \$\{sampleNumber\}/);assert.match(script,/Confirm sample \$\{sampleNumber\}/);assert.match(script,/samples\.push\(pendingSample\)/);assert.match(script,/samples\.length !== 3/);assert.match(script,/enrollmentController\?\.abort\(\)/);assert.match(script,/currentAttempt !== attempt/);});
test("speaker enrollment rejects synthetic controls and displays recorded duration before confirmation",async()=>{const script=await readFile(new URL("../assets/speaker-enrollment.js",import.meta.url),"utf8");assert.match(script,/!event\.isTrusted/);assert.match(script,/explicitStop = true/);assert.match(script,/awaiting your confirmation/);assert.match(script,/durationSeconds\.toFixed\(1\)/);});
test("speaker enrollment has a stable idempotency key, submit lock, and safe structured errors",async()=>{const script=await readFile(new URL("../assets/speaker-enrollment.js",import.meta.url),"utf8");assert.match(script,/submitInFlight/);assert.match(script,/enrollmentAttemptId \|\|= crypto\.randomUUID\(\)/);assert.match(script,/body: JSON\.stringify\(\{ enrollmentAttemptId/);assert.match(script,/typeof value\?\.detail === "string"/);assert.doesNotMatch(script,/status\.textContent = error\.message/);});
test("speaker enrollment explicitly keeps authenticated requests on the Preview origin",async()=>{const script=await readFile(new URL("../assets/speaker-enrollment.js",import.meta.url),"utf8");assert.match(script,/fetchImpl\("\/api\/speakers\/enroll"/);assert.match(script,/credentials: "same-origin"/);assert.doesNotMatch(script,/https?:\/\/[^"']+\/api\/speakers\/enroll/);});
test("speaker capture stays disabled until real worker readiness succeeds",async()=>{const script=await readFile(new URL("../assets/speaker-enrollment.js",import.meta.url),"utf8");assert.match(script,/button\.disabled = true;\n    status\.textContent = "Checking the private speaker worker/);assert.match(script,/speakerRecognition\?\.available/);assert.match(script,/else \{ button\.disabled = false/);});

test("Voice V2 browser assets expose no server-side provider credentials",async()=>{const sources=await Promise.all(["console.js","voice-v2-client.js","voice-capture.js","voice-v2.js"].map((file)=>readFile(new URL(`../assets/${file}`,import.meta.url),"utf8")));assert.doesNotMatch(sources.join("\n"),/OPENAI_API_KEY|ELEVENLABS_API_KEY|ELEVENLABS_VOICE_ID|sk-[A-Za-z0-9]/);});

test("Voice V2 does not force a locale and uses the same durable Nova chat path",async()=>{const [html,script,capture]=await Promise.all([readFile(new URL("../index.html",import.meta.url),"utf8"),readFile(new URL("../assets/console.js",import.meta.url),"utf8"),readFile(new URL("../assets/voice-capture.js",import.meta.url),"utf8")]);assert.doesNotMatch(html,/id="voiceModeLanguage"/);assert.match(html,/Primary recognition language/);assert.match(script,/client\.send\(message,\{signal,context\}\)/);assert.match(script,/void refreshRecents\(\); return \{ \.\.\.result, preparedAssistant, preparationError \}/);assert.match(script,/Transcribing…/);assert.match(capture,/MediaRecorder/);assert.doesNotMatch(capture,/SpeechRecognition/);});

test("Voice V2 dispatches TTS before assistant rendering and never awaits recents refresh",async()=>{const script=await readFile(new URL("../assets/console.js",import.meta.url),"utf8");assert.ok(script.indexOf("await prepareAssistant(result.message, result)")<script.indexOf('addMessage({ role: "assistant"'));assert.match(script,/void refreshRecents\(\)/);assert.match(script,/\[nova-voice-timing\]/);});

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

test("local static handler serves all premium Voice V2 browser modules", async () => {
  const serve = createStaticFileHandler({ loadFile: async (url) => Buffer.from(url.pathname) });
  for (const path of ["/assets/voice-v2-client.js", "/assets/voice-capture.js", "/assets/voice-v2.js"]) { const res = response(); assert.equal(await serve({ method: "GET", url: path }, res), true); assert.equal(res.statusCode, 200); assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8"); }
});

test("local static handler serves the isolated voice benchmark module", async () => {
  const serve = createStaticFileHandler({ loadFile: async (url) => Buffer.from(url.pathname) }); const res = response();
  assert.equal(await serve({ method: "GET", url: "/assets/voice-benchmark.js" }, res), true); assert.equal(res.statusCode, 200); assert.equal(res.headers.get("content-type"), "text/javascript; charset=utf-8");
});

test("local static handler ignores unknown and non-GET routes", async () => {
  const serve = createStaticFileHandler();
  assert.equal(await serve({ method: "GET", url: "/api/health" }, response()), false);
  assert.equal(await serve({ method: "POST", url: "/" }, response()), false);
});
