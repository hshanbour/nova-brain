export function createVoiceMode({
  startRecognition, stopRecognition, stopSpeech, speakResponse, sendTurn,
  onState = () => {}, onError = () => {}
}) {
  let active = false; let state = "idle"; let turn = 0;
  const publish = (next) => { state = next; onState({ active, state }); };
  const listen = () => {
    if (!active) return;
    stopSpeech(); publish("listening");
    try { startRecognition(); } catch { active = false; publish("idle"); onError("Voice recognition could not start."); }
  };

  async function acceptFinal(text) {
    const transcript = String(text || "").trim();
    if (!active || state !== "listening" || !transcript) return false;
    const current = ++turn; stopRecognition(); publish("thinking");
    try {
      const result = await sendTurn(transcript);
      if (!active || current !== turn) return false;
      publish("speaking");
      const started = speakResponse(result.message, {
        id: `voice-mode-${current}`,
        onComplete() { if (active && current === turn) listen(); },
        onError() { if (active && current === turn) { publish("error"); onError("Nova could not speak this reply. End Voice or use Test Voice."); } }
      });
      if (!started) { publish("error"); onError("Voice output is unavailable. End Voice or continue in text chat."); }
      return started;
    } catch (error) {
      if (active && current === turn) { publish("error"); onError(error?.message || "Nova could not complete this voice turn."); }
      return false;
    }
  }

  return Object.freeze({
    start() { if (active) return; active = true; turn += 1; listen(); },
    end() { if (!active && state === "idle") return; active = false; turn += 1; stopRecognition(); stopSpeech(); publish("idle"); },
    interrupt() { if (!active) return false; turn += 1; stopSpeech(); stopRecognition(); listen(); return true; },
    recognitionEnded({ hadFinal = false } = {}) { if (active && state === "listening" && !hadFinal) listen(); },
    acceptFinal,
    isActive: () => active,
    getState: () => state
  });
}
