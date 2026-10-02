import { twilioMulawToOpenAiPcm } from "./g711.js";

const DEFAULT_PROMPT = "Nova Brain phone call. Preserve English, Arabic, Arabic-English code-switching, names, numbers, Sharp Cuts, Nova Brain, API, booking, and missed-call recovery exactly.";

export function createOpenAiStreamingTranscriber({ sendJson, model = "gpt-live-transcribe", languages = ["en", "ar"], prompt = DEFAULT_PROMPT, delay = "low" }) {
  if (typeof sendJson !== "function") throw new TypeError("sendJson is required.");
  const pending = [];
  const byItemId = new Map();
  let started = false;
  let closed = false;
  let appendedPcmBytes = 0;

  return Object.freeze({
    start() {
      if (closed) throw new Error("Transcription session is closed.");
      if (started) return false;
      started = true;
      sendJson({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model, prompt, keywords: ["Nova Brain", "Sharp Cuts", "API"], languages, delay },
              turn_detection: null,
            },
          },
        },
      });
      return true;
    },
    appendMulaw(payloadBase64) {
      if (!started || closed) throw new Error("Transcription session is not active.");
      const converted = twilioMulawToOpenAiPcm(payloadBase64);
      appendedPcmBytes += converted.pcm.length;
      sendJson({ type: "input_audio_buffer.append", audio: converted.pcm.toString("base64") });
      return converted;
    },
    commit({ turnId } = {}) {
      if (!started || closed) return Promise.reject(new Error("Transcription session is not active."));
      sendJson({ type: "input_audio_buffer.commit" });
      return new Promise((resolve, reject) => pending.push({ turnId: turnId || null, itemId: null, transcript: "", resolve, reject }));
    },
    handleServerEvent(event) {
      if (!event || typeof event.type !== "string") return false;
      if (event.type === "input_audio_buffer.committed") {
        const target = pending.find((item) => !item.itemId);
        if (!target || !event.item_id) return false;
        target.itemId = event.item_id;
        byItemId.set(event.item_id, target);
        return true;
      }
      const item = byItemId.get(event.item_id);
      if (!item) return false;
      if (event.type === "conversation.item.input_audio_transcription.delta") {
        item.transcript += String(event.delta || "");
        return true;
      }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        const transcript = String(event.transcript ?? item.transcript).trim();
        byItemId.delete(event.item_id);
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        item.resolve({ transcript, itemId: event.item_id, turnId: item.turnId });
        return true;
      }
      if (event.type === "conversation.item.input_audio_transcription.failed") {
        byItemId.delete(event.item_id);
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        item.reject(new Error("OpenAI streaming transcription failed safely."));
        return true;
      }
      return false;
    },
    close() {
      if (closed) return false;
      closed = true;
      for (const item of pending.splice(0)) item.reject(new Error("Transcription session closed."));
      byItemId.clear();
      return true;
    },
    metrics() { return { started, closed, appendedPcmBytes, pendingTurns: pending.length }; },
  });
}
