import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { assertTwilioSignature } from "../src/phone/twilio-signature.js";
import { parseTwilioMediaMessage } from "../src/phone/twilio-media-protocol.js";
import { createTranscriptionSessionRotator } from "../src/phone/transcription-session-rotator.js";
import { createElevenLabsTelephonyTts } from "../src/phone/elevenlabs-telephony.js";
import { createOpenAiWebSocketTranscriber } from "./openai-transcriber.js";
import { createNovaPhoneBridgeClient } from "./nova-client.js";
import { createRuntimePhoneSession } from "./runtime-session.js";

const STATUS_BODY_LIMIT = 16 * 1024;
const STATUS_ROUTE = /^\/api\/phone\/twilio\/status\/(phone_[a-f0-9]{32})$/;

function readBoundedBody(request, limit = STATUS_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0; let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > limit) {
        settled = true;
        request.resume();
        reject(Object.assign(new Error("Twilio status callback body is too large."), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => { if (!settled) resolve(Buffer.concat(chunks).toString("utf8")); });
    request.on("error", (error) => { if (!settled) reject(error); });
  });
}

function formParameters(rawBody) {
  const parameters = Object.create(null);
  for (const [key, value] of new URLSearchParams(rawBody)) {
    if (parameters[key] === undefined) parameters[key] = value;
    else parameters[key] = Array.isArray(parameters[key]) ? [...parameters[key], value] : [parameters[key], value];
  }
  return parameters;
}

export function bridgeConfig(environment = process.env) {
  const required = ["NOVA_PHONE_BRIDGE_PUBLIC_URL", "NOVA_PHONE_BASE_URL", "OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "VERCEL_AUTOMATION_BYPASS_SECRET"];
  for (const name of required) if (!environment[name]) throw new Error(`${name} is required.`);
  return Object.freeze({ port: Number(environment.PORT || 8080), publicUrl: environment.NOVA_PHONE_BRIDGE_PUBLIC_URL.replace(/\/$/, ""), novaBaseUrl: environment.NOVA_PHONE_BASE_URL.replace(/\/$/, ""), twilioAuthToken: environment.TWILIO_AUTH_TOKEN || null, openAIApiKey: environment.OPENAI_API_KEY, voiceConfig: { voiceV2: { elevenLabsApiKey: environment.ELEVENLABS_API_KEY, elevenLabsVoiceId: environment.ELEVENLABS_VOICE_ID, ttsModel: environment.ELEVENLABS_TTS_MODEL || "eleven_v3_conversational", ttsStability: 0.75, maxSpeechCharacters: 4000 } } });
}

export function createPhoneBridgeServer({ environment = process.env, fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket } = {}) {
  const config = bridgeConfig(environment); const novaClient = createNovaPhoneBridgeClient({ baseUrl: config.novaBaseUrl, protectionBypassSecret: environment.VERCEL_AUTOMATION_BYPASS_SECRET, fetchImpl });
  const sessions = new Set();
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health/live") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ live: true })); return; }
    if (request.method === "GET" && request.url === "/health/ready") { const acceptingCalls = Boolean(config.twilioAuthToken) && sessions.size === 0; response.writeHead(sessions.size === 0 ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify({ ready: sessions.size === 0, acceptingCalls, providerCertificationReady: true })); return; }
    const statusMatch = request.url?.match(STATUS_ROUTE);
    if (request.method === "POST" && statusMatch) {
      try {
        if (!config.twilioAuthToken) throw Object.assign(new Error("Twilio is not configured."), { statusCode: 503 });
        if (String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
          throw Object.assign(new Error("Twilio status callback content type is unsupported."), { statusCode: 415 });
        }
        const rawBody = await readBoundedBody(request);
        const signature = request.headers["x-twilio-signature"];
        assertTwilioSignature({ authToken: config.twilioAuthToken, url: `${config.publicUrl}${request.url}`, signature, parameters: formParameters(rawBody) });
        await novaClient.forwardTwilioStatus({ callIntentId: statusMatch[1], rawBody, signature });
        response.writeHead(204, { "cache-control": "no-store" }).end();
      } catch (error) {
        response.writeHead(Number(error?.statusCode) || 401, { "content-type": "application/json", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: "Phone status callback rejected." }));
      }
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    try {
      if (!config.twilioAuthToken || !request.url?.startsWith("/media") || sessions.size > 0) throw new Error("Bridge is not accepting calls.");
      assertTwilioSignature({ authToken: config.twilioAuthToken, url: `${config.publicUrl}${request.url}`, signature: request.headers["x-twilio-signature"], parameters: {} });
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } catch { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); }
  });
  wss.on("connection", (ws) => {
    sessions.add(ws); let runtime;
    ws.on("message", async (raw) => {
      try {
        const message = parseTwilioMediaMessage(String(raw));
        if (!runtime) {
          if (message.event !== "start") throw new Error("Twilio start must be first.");
          const token = message.start?.customParameters?.novaSessionToken;
          if (!token) throw new Error("Nova phone session token is missing.");
          const transcriber = createTranscriptionSessionRotator({ rotateAfterSeconds: 55 * 60, createSession: () => createOpenAiWebSocketTranscriber({ WebSocketImpl, apiKey: config.openAIApiKey, onError: () => ws.close(1011, "transcription failure") }) });
          const authorized = await novaClient.start({ sessionToken: token, callSid: message.start.callSid, streamSid: message.streamSid });
          runtime = createRuntimePhoneSession({ sendTwilio: (value) => { if (ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify(value)); }, hangup:()=>ws.close(1000,"safe hangup"), transcriber, tts: createElevenLabsTelephonyTts({ config: config.voiceConfig, fetchImpl }), novaClient, authorization: authorized, callIntentId: authorized.callIntentId, maximumDurationSeconds: authorized.maximumDurationSeconds, callSid: message.start.callSid, streamSid: message.streamSid });
          await runtime.start(message);
          return;
        }
        runtime.handle(message);
      } catch { await runtime?.stop("failed", "bridge_failure").catch(() => {}); ws.close(1008, "invalid phone session"); }
    });
    ws.on("close", () => { sessions.delete(ws); void runtime?.stop("completed", "disconnected"); });
  });
  return Object.freeze({ server, listen() { return server.listen(config.port, "0.0.0.0"); }, close() { for (const ws of sessions) ws.close(1001, "bridge shutdown"); return new Promise((resolve) => server.close(resolve)); }, status() { return { activeSessions: sessions.size, acceptingCalls: sessions.size === 0 }; } });
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll("\\", "/"))) createPhoneBridgeServer().listen();
