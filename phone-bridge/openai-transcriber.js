import { createOpenAiStreamingTranscriber } from "../src/phone/openai-transcription-protocol.js";

export function createOpenAiWebSocketTranscriber({ WebSocketImpl, apiKey, model = "gpt-live-transcribe", onError = () => {} }) {
  if (!WebSocketImpl || !apiKey) throw new TypeError("OpenAI WebSocket and API key are required.");
  let socket; const queued = []; let readyResolve; let readyReject; const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const protocol = createOpenAiStreamingTranscriber({ model, sendJson(message) { const data = JSON.stringify(message); if (socket?.readyState === WebSocketImpl.OPEN) socket.send(data); else queued.push(data); } });
  return Object.freeze({
    start() {
      socket = new WebSocketImpl("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "realtime=v1" } });
      socket.on("open", () => { readyResolve(true); for (const data of queued.splice(0)) socket.send(data); });
      socket.on("message", (data) => { try { protocol.handleServerEvent(JSON.parse(String(data))); } catch (error) { onError(error); } });
      socket.on("error", (error) => { readyReject(error); protocol.close(); onError(error); });
      protocol.start(); return true;
    },
    appendMulaw: (payload) => protocol.appendMulaw(payload),
    commit: (input) => protocol.commit(input),
    ready: () => readyPromise,
    handleServerEvent: (event) => protocol.handleServerEvent(event),
    close() { protocol.close(); socket?.close(); },
    metrics: () => protocol.metrics(),
  });
}
