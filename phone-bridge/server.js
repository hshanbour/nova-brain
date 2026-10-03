import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { assertTwilioSignature, assertTwilioWebSocketSignature } from "../src/phone/twilio-signature.js";
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

function safeCategory(error, fallback = "unexpected_failure") {
  const value = String(error?.code || fallback);
  return /^[a-z0-9_]{1,80}$/i.test(value) ? value : fallback;
}

function safeCloseReason(reason) {
  const value = String(reason || "");
  return new Set(["safe hangup", "transcription failure", "invalid phone session", "bridge shutdown"]).has(value)
    ? value.replaceAll(" ", "_")
    : value ? "provider_close" : "none";
}

function externalWebSocketUrl(publicUrl, requestUrl) {
  const url = new URL(requestUrl, `${publicUrl}/`);
  url.protocol = "wss:";
  return url.toString();
}

export function createPhoneBridgeServer({ environment = process.env, fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, logger = console, novaClient: providedNovaClient, createTranscriber, createTts, createRuntime } = {}) {
  const config = bridgeConfig(environment); const novaClient = providedNovaClient || createNovaPhoneBridgeClient({ baseUrl: config.novaBaseUrl, protectionBypassSecret: environment.VERCEL_AUTOMATION_BYPASS_SECRET, fetchImpl });
  const transcriberFactory = createTranscriber || (({ onError }) => createTranscriptionSessionRotator({ rotateAfterSeconds: 55 * 60, createSession: () => createOpenAiWebSocketTranscriber({ WebSocketImpl, apiKey: config.openAIApiKey, onError }) }));
  const ttsFactory = createTts || (() => createElevenLabsTelephonyTts({ config: config.voiceConfig, fetchImpl }));
  const runtimeFactory = createRuntime || createRuntimePhoneSession;
  const diagnostic = (event, metadata = {}) => logger.info?.("[nova-phone-bridge]", { event, ...metadata });
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
    diagnostic("websocket_upgrade_received");
    try {
      if (!config.twilioAuthToken) throw Object.assign(new Error("Bridge is not configured."), { code: "bridge_not_configured" });
      if (!request.url?.startsWith("/media")) throw Object.assign(new Error("Bridge path is invalid."), { code: "invalid_media_path" });
      if (sessions.size > 0) throw Object.assign(new Error("Bridge is busy."), { code: "bridge_busy" });
      const signatureVariant = assertTwilioWebSocketSignature({ authToken: config.twilioAuthToken, externalUrl: externalWebSocketUrl(config.publicUrl, request.url), signature: request.headers["x-twilio-signature"] });
      diagnostic("websocket_upgrade_accepted", { signatureVariant });
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } catch (error) { diagnostic("websocket_upgrade_rejected", { category: safeCategory(error) }); socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); }
  });
  wss.on("connection", (ws) => {
    sessions.add(ws); let runtime; let phase = "awaiting_connected"; let boundStreamSid; let closeInitiator = "remote"; let messageChain = Promise.resolve();
    const closeSafely = (code, reason, initiator = "bridge") => { closeInitiator = initiator; if (ws.readyState === WebSocketImpl.OPEN) ws.close(code, reason); };
    const handleMessage = async (raw) => {
      try {
        const message = parseTwilioMediaMessage(String(raw));
        if (phase === "awaiting_connected") {
          if (message.event !== "connected") throw Object.assign(new Error("Twilio connected must be first."), { code: "connected_required" });
          phase = "awaiting_start"; diagnostic("connected_received"); return;
        }
        if (phase === "awaiting_start") {
          if (message.event !== "start") throw Object.assign(new Error("Twilio start must follow connected."), { code: "start_required" });
          diagnostic("start_received");
          const token = message.start?.customParameters?.novaSessionToken;
          if (!token) throw Object.assign(new Error("Nova phone session token is missing."), { code: "session_token_missing" });
          let authorized;
          try { authorized = await novaClient.start({ sessionToken: token, callSid: message.start.callSid, streamSid: message.streamSid }); }
          catch (error) { diagnostic("session_token_rejected", { category: safeCategory(error, "session_authorization_failed") }); throw error; }
          diagnostic("session_token_accepted");
          boundStreamSid = message.streamSid;
          const transcriber = transcriberFactory({ onError: (error) => { diagnostic("stt_failed", { category: safeCategory(error, "stt_provider_failure") }); closeSafely(1011, "transcription failure"); } });
          runtime = runtimeFactory({ sendTwilio: (value) => { if (ws.readyState === WebSocketImpl.OPEN) ws.send(JSON.stringify(value)); }, hangup:()=>closeSafely(1000,"safe hangup"), transcriber, tts: ttsFactory(), novaClient, authorization: authorized, callIntentId: authorized.callIntentId, maximumDurationSeconds: authorized.maximumDurationSeconds, callSid: message.start.callSid, streamSid: message.streamSid });
          await runtime.start(message);
          phase = "active"; diagnostic("stream_bound"); diagnostic("stt_started"); diagnostic("stream_started"); return;
        }
        if (message.event === "connected" || message.event === "start") throw Object.assign(new Error("Twilio lifecycle event was duplicated."), { code: "duplicate_lifecycle_event" });
        if (message.streamSid && message.streamSid !== boundStreamSid) throw Object.assign(new Error("Twilio stream identity changed."), { code: "stream_identity_mismatch" });
        runtime.handle(message);
        if (message.event === "stop") { phase = "stopped"; diagnostic("stream_stopped", { category: "provider_stop" }); }
      } catch (error) { diagnostic("stream_error", { category: safeCategory(error, "bridge_failure") }); await runtime?.stop("failed", "bridge_failure", { hangupSocket: false }).catch(() => {}); closeSafely(1008, "invalid phone session"); }
    };
    ws.on("message", (raw) => { messageChain = messageChain.then(() => handleMessage(raw)); });
    ws.on("close", (code, reason) => { sessions.delete(ws); diagnostic("websocket_closed", { initiator: closeInitiator, code, reason: safeCloseReason(reason) }); void runtime?.stop("completed", "disconnected", { hangupSocket: false }); });
    ws.on("error", (error) => diagnostic("stream_error", { category: safeCategory(error, "websocket_error") }));
  });
  return Object.freeze({ server, listen() { return server.listen(config.port, "0.0.0.0"); }, close() { for (const ws of sessions) ws.close(1001, "bridge shutdown"); return new Promise((resolve) => server.close(resolve)); }, status() { return { activeSessions: sessions.size, acceptingCalls: sessions.size === 0 }; } });
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll("\\", "/"))) createPhoneBridgeServer().listen();
