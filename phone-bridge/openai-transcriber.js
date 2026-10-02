import { createOpenAiStreamingTranscriber } from "../src/phone/openai-transcription-protocol.js";

export function createOpenAiWebSocketTranscriber({ WebSocketImpl, apiKey, model = "gpt-live-transcribe", onError = () => {} }) {
  if (!WebSocketImpl || !apiKey) throw new TypeError("OpenAI WebSocket and API key are required.");
  let socket; let intentionallyClosed = false; const queued = []; let readyResolve; let readyReject; const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const protocol = createOpenAiStreamingTranscriber({ model, sendJson(message) { const data = JSON.stringify(message); if (socket?.readyState === WebSocketImpl.OPEN) socket.send(data); else queued.push(data); } });
  const fail = (error) => { readyReject(error); protocol.close(); onError(error); };
  return Object.freeze({
    start() {
      socket = new WebSocketImpl("wss://api.openai.com/v1/realtime/transcription_sessions", { headers: { Authorization: `Bearer ${apiKey}` } });
      socket.on("open", () => { readyResolve(true); for (const data of queued.splice(0)) socket.send(data); });
      socket.on("message", (data) => { try { const event = JSON.parse(String(data)); if (event?.type === "error") { const category = [event.error?.type, event.error?.code, event.error?.param].filter(Boolean).join(":") || "unknown"; fail(new Error(`OpenAI streaming transcription provider error (${category}).`)); return; } protocol.handleServerEvent(event); } catch (error) { fail(error); } });
      socket.on("error", fail);
      socket.on("close", (code) => { if (!intentionallyClosed) fail(new Error(`OpenAI streaming transcription socket closed (${Number(code) || "unknown"}).`)); });
      protocol.start(); return true;
    },
    appendMulaw: (payload) => protocol.appendMulaw(payload),
    commit: (input) => protocol.commit(input),
    ready: () => readyPromise,
    handleServerEvent: (event) => protocol.handleServerEvent(event),
    close() { intentionallyClosed = true; protocol.close(); socket?.close(); },
    metrics: () => protocol.metrics(),
  });
}
