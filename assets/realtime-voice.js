const OPENAI_REALTIME_CALLS = "https://api.openai.com/v1/realtime/calls";

export function createRealtimeVoice({
  mediaDevices = globalThis.navigator?.mediaDevices,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  MediaRecorderImpl = globalThis.MediaRecorder,
  AudioImpl = globalThis.Audio,
  fetchImpl = globalThis.fetch,
  getAudioConstraints = () => ({ audio: true }),
  sendTurn,
  getConversationId = () => null,
  onTranscript = () => {},
  onAssistantTranscript = () => {},
  onSpeaker = () => {},
  onState = () => {},
  onTiming = () => {},
  onError = () => {},
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  if (!mediaDevices?.getUserMedia || typeof RTCPeerConnectionImpl !== "function" || typeof fetchImpl !== "function") throw new TypeError("Realtime Voice browser dependencies are unavailable.");
  let active = false, generation = 0, pc, channel, stream, remoteAudio;
  let lastTranscript = "", lastSpeechEndedAt = 0, assistantTranscript = "", toolInFlight = false;
  let turnRecorder = null, turnStartedAt = 0, speakerPromise = null;

  const publish = (state, detail = {}) => onState({ active, state, mode: "realtime", ...detail });
  const valid = (current) => active && current === generation;

  async function start() {
    if (active) return false;
    active = true;
    const current = ++generation;
    publish("connecting");
    try {
      const sessionResponse = await fetchImpl("/api/voice/realtime/session", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
      const session = await sessionResponse.json().catch(() => null);
      if (!sessionResponse.ok || typeof session?.clientSecret !== "string") throw new Error(session?.error || "Nova could not prepare Realtime Voice.");
      if (!valid(current)) return false;

      stream = await mediaDevices.getUserMedia(getAudioConstraints());
      if (!valid(current)) { stopTracks(stream); return false; }
      pc = new RTCPeerConnectionImpl();
      remoteAudio = new AudioImpl();
      remoteAudio.autoplay = true;
      pc.ontrack = (event) => { remoteAudio.srcObject = event.streams?.[0] || new MediaStream([event.track]); void remoteAudio.play?.().catch?.(() => {}); };
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      channel = pc.createDataChannel("oai-events");
      channel.addEventListener("open", () => { if (valid(current)) publish("listening"); });
      channel.addEventListener("message", (event) => { if (valid(current)) void handleEvent(safeParse(event.data), current); });
      channel.addEventListener("close", () => { if (valid(current)) fail("Realtime Voice connection closed. Start Voice again to reconnect."); });
      pc.addEventListener?.("connectionstatechange", () => {
        if (valid(current) && ["failed", "closed"].includes(pc.connectionState)) fail("Realtime Voice connection was interrupted.");
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const answerResponse = await fetchImpl(OPENAI_REALTIME_CALLS, { method: "POST", body: offer.sdp, headers: { Authorization: `Bearer ${session.clientSecret}`, "Content-Type": "application/sdp" } });
      const answerSdp = await answerResponse.text();
      if (!answerResponse.ok) throw new Error("OpenAI Realtime Voice could not establish the audio connection.");
      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      return true;
    } catch (error) {
      cleanup();
      active = false;
      publish("error");
      onError(error?.message || "Realtime Voice could not start.");
      throw error;
    }
  }

  function end() {
    if (!active && !pc && !stream) return false;
    active = false;
    generation += 1;
    cleanup();
    publish("idle");
    return true;
  }

  function interrupt() {
    if (!active || channel?.readyState !== "open") return false;
    sendEvent({ type: "response.cancel" });
    sendEvent({ type: "output_audio_buffer.clear" });
    publish("listening");
    return true;
  }

  async function handleEvent(event, current) {
    if (!event?.type) return;
    if (event.type === "input_audio_buffer.speech_started") {
      lastTranscript = "";
      lastSpeechEndedAt = 0;
      startTurnRecording();
      publish("listening", { phase: "speech-detected" });
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      lastSpeechEndedAt = now();
      speakerPromise = stopTurnRecording();
      void speakerPromise.then((speaker) => {
        if (speaker) onSpeaker(speaker);
      });
      publish("thinking", { phase: "understanding" });
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      lastTranscript = String(event.transcript || "").trim();
      if (lastTranscript) onTranscript(lastTranscript);
      return;
    }
    if (event.type === "response.output_audio_transcript.delta") {
      assistantTranscript += String(event.delta || "");
      return;
    }
    if (event.type === "response.output_audio_transcript.done") {
      const text = String(event.transcript || assistantTranscript).trim();
      assistantTranscript = "";
      if (text) onAssistantTranscript(text);
      return;
    }
    if (event.type === "response.created") {
      publish("speaking", { phase: "preparing" });
      return;
    }
    if (event.type === "response.done") {
      const calls = Array.isArray(event.response?.output) ? event.response.output.filter((item) => item?.type === "function_call" && item.name === "nova_turn") : [];
      if (calls.length) {
        for (const call of calls) await handleNovaTurn(call, current);
      } else if (lastSpeechEndedAt) {
        onTiming({ stage: "realtime-response-done", measurements: { speechEndToResponseDoneMs: Math.max(0, now() - lastSpeechEndedAt) } });
        publish("listening");
      }
      return;
    }
    if (event.type === "output_audio_buffer.started") {
      if (lastSpeechEndedAt) onTiming({ stage: "realtime-first-audio", measurements: { speechEndToFirstAudioMs: Math.max(0, now() - lastSpeechEndedAt) } });
      publish("speaking", { phase: "playing" });
      return;
    }
    if (event.type === "output_audio_buffer.stopped" || event.type === "output_audio_buffer.cleared") {
      if (!toolInFlight) publish("listening");
      return;
    }
    if (event.type === "error") fail(safeProviderError(event));
  }

  async function handleNovaTurn(call, current) {
    if (toolInFlight || !valid(current)) return;
    toolInFlight = true;
    publish("thinking", { phase: "nova-brain" });
    try {
      const args = safeParse(call.arguments) || {};
      const request = lastTranscript || String(args.request || "").trim();
      if (!request) throw new Error("Nova could not recover the spoken request.");
      const speaker = await boundedSpeaker(speakerPromise, 750);
      const result = await sendTurn(request, { speaker, conversationId: getConversationId() });
      if (!valid(current)) return;
      sendEvent({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ message: result?.message || "Nova could not complete that request.", approvalRequired: Boolean(result?.approval), conversationId: result?.conversationId || null }) } });
      sendEvent({ type: "response.create", response: { tool_choice: "none" } });
    } catch (error) {
      if (valid(current)) {
        sendEvent({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ error: "Nova Brain could not complete this turn safely." }) } });
        sendEvent({ type: "response.create", response: { tool_choice: "none" } });
        onError(error?.message || "Nova Brain could not complete this voice turn.");
      }
    } finally { toolInFlight = false; }
  }

  function startTurnRecording() {
    if (typeof MediaRecorderImpl !== "function" || !stream || turnRecorder) return;
    try {
      const chunks = [];
      const recorder = new MediaRecorderImpl(stream);
      turnStartedAt = now();
      recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) chunks.push(event.data); });
      recorder._novaChunks = chunks;
      recorder.start();
      turnRecorder = recorder;
    } catch { turnRecorder = null; }
  }

  function stopTurnRecording() {
    const recorder = turnRecorder;
    turnRecorder = null;
    if (!recorder || recorder.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      recorder.addEventListener("stop", async () => {
        try {
          const audio = new Blob(recorder._novaChunks || [], { type: recorder.mimeType || "audio/webm" });
          const durationSeconds = Math.max(0.2, (now() - turnStartedAt) / 1000);
          if (!audio.size || durationSeconds < 0.8) return resolve(null);
          const audioBase64 = bytesToBase64(new Uint8Array(await audio.arrayBuffer()));
          const response = await fetchImpl("/api/voice/speaker/recognize", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audioBase64, mimeType: audio.type || "audio/webm", durationSeconds }) });
          const value = await response.json().catch(() => null);
          resolve(response.ok ? value?.speaker || null : null);
        } catch { resolve(null); }
      }, { once: true });
      try { recorder.stop(); }
      catch { resolve(null); }
    });
  }

  function fail(message) {
    if (!active) return;
    active = false;
    generation += 1;
    cleanup();
    publish("error");
    onError(message);
  }

  function cleanup() {
    try { if (turnRecorder && turnRecorder.state !== "inactive") turnRecorder.stop(); } catch {}
    turnRecorder = null;
    try { channel?.close?.(); } catch {}
    try { pc?.close?.(); } catch {}
    stopTracks(stream);
    if (remoteAudio) { try { remoteAudio.pause?.(); remoteAudio.srcObject = null; } catch {} }
    channel = null; pc = null; stream = null; remoteAudio = null; speakerPromise = null; toolInFlight = false;
  }

  function sendEvent(value) {
    if (channel?.readyState === "open") channel.send(JSON.stringify(value));
  }

  return Object.freeze({ start, end, interrupt, isActive: () => active, mode: "realtime" });
}

function stopTracks(stream) { for (const track of stream?.getTracks?.() || []) track.stop?.(); }
function safeParse(value) { try { return JSON.parse(String(value || "")); } catch { return null; } }
function safeProviderError(event) { const code = String(event?.error?.code || "realtime_error").slice(0, 80); return `Realtime Voice error (${code}).`; }
function bytesToBase64(bytes) { let binary = ""; for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); return btoa(binary); }
async function boundedSpeaker(promise, timeoutMs) { if (!promise) return null; return Promise.race([Promise.resolve(promise).catch(() => null), new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))]); }
