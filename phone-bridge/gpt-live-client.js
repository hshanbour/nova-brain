import { WebSocket } from "ws";
import { createGptLivePrototypeController } from "../src/phone/gpt-live-prototype.js";

const LIVE_URL = "wss://api.openai.com/v1/live/sessions";

export function createGptLivePrototypeClient({
  apiKey,
  voice = "marin",
  history = [],
  delegate,
  onAudio,
  onClearAudio,
  WebSocketImpl = WebSocket,
  timeoutMs = 15_000,
} = {}) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for GPT-Live certification.");
  let socket;
  let readyResolve;
  let readyReject;
  let closedResolve;
  let closeTimer;
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closedPromise = new Promise((resolve) => { closedResolve = resolve; });
  const controller = createGptLivePrototypeController({
    delegate,
    onAudio,
    onClearAudio,
    send(event) {
      if (!socket || socket.readyState !== WebSocketImpl.OPEN) throw Object.assign(new Error("GPT-Live socket is not ready."), { code: "gpt_live_socket_not_ready" });
      socket.send(JSON.stringify(event));
    },
  });

  function connect() {
    if (socket) return false;
    socket = new WebSocketImpl(LIVE_URL, { headers: { Authorization: `Bearer ${apiKey}`, "OpenAI-Beta": "realtime=v1" } });
    const timer = setTimeout(() => readyReject(Object.assign(new Error("GPT-Live connection timed out."), { code: "gpt_live_connect_timeout" })), timeoutMs);
    timer.unref?.();
    socket.on("open", () => controller.start({ voice, history }));
    socket.on("message", async (raw) => {
      let event;
      try { event = JSON.parse(String(raw)); }
      catch { return; }
      try {
        await controller.handleServerEvent(event);
        if (event.type === "session.started") { clearTimeout(timer); readyResolve(controller.snapshot()); }
        if (event.type === "session.closed") { clearTimeout(closeTimer); closedResolve(controller.snapshot()); socket.close(); }
      } catch (error) {
        clearTimeout(timer);
        readyReject(error);
      }
    });
    socket.on("error", () => readyReject(Object.assign(new Error("GPT-Live transport failed."), { code: "gpt_live_transport_failed" })));
    socket.on("close", () => closedResolve(controller.snapshot()));
    return true;
  }

  return Object.freeze({
    connect,
    ready() { return readyPromise; },
    appendAudio(audio) { return controller.appendAudio(audio); },
    callerSpeechStarted() { return controller.callerSpeechStarted(); },
    callerSpeechEnded() { return controller.callerSpeechEnded(); },
    correctRunningDelegations() { return controller.correctRunningDelegations(); },
    close() {
      if (!controller.close()) return closedPromise;
      closeTimer = setTimeout(() => { socket?.terminate?.(); closedResolve(controller.snapshot()); }, timeoutMs);
      closeTimer.unref?.();
      return closedPromise;
    },
    snapshot() { return controller.snapshot(); },
    contract() { return Object.freeze({ endpoint: LIVE_URL, secretExposed: false, rawAudioPersisted: false }); },
  });
}
