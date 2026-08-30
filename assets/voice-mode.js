export function createVoiceMode({
  startRecognition, stopRecognition, stopSpeech, speakResponse, sendTurn,
  onState = () => {}, onError = () => {}, onNotice = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancelSchedule = (timer) => clearTimeout(timer),
  retryDelays = [700, 1200, 2000, 3000]
}) {
  let active = false; let state = "idle"; let turn = 0; let silenceCount = 0; let retryTimer = null;
  const publish = (next, detail = {}) => { state = next; onState({ active, state, ...detail }); };
  const clearRetry = () => { if (retryTimer !== null) cancelSchedule(retryTimer); retryTimer = null; };
  const listen = () => {
    clearRetry();
    if (!active) return;
    stopSpeech(); publish("listening");
    try { startRecognition(); }
    catch { active = false; publish("error"); onError("Voice recognition could not start."); }
  };
  const retryRecognition = (code) => {
    if (!active) return false;
    clearRetry();
    const delay = retryDelays[Math.min(silenceCount, retryDelays.length - 1)];
    silenceCount += 1; publish("retrying", { code, delay });
    onNotice(code === "no-speech" ? "No speech heard · retrying…" : "Recognition interrupted · retrying…");
    retryTimer = schedule(() => { retryTimer = null; if (active) listen(); }, delay);
    return true;
  };

  async function acceptFinal(text) {
    const transcript = String(text || "").trim();
    if (!active || state !== "listening" || !transcript) return false;
    silenceCount = 0; clearRetry();
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

  function handleRecognitionError(error = {}) {
    const code = String(error.code || "unknown");
    if (!active) return false;
    if (code === "no-speech" || code === "aborted") return retryRecognition(code);
    clearRetry(); active = false; turn += 1; stopRecognition(); stopSpeech(); publish("error", { code });
    onError(error.message || `Voice input could not continue (${code}).`); return false;
  }

  return Object.freeze({
    start() { if (active) return; active = true; silenceCount = 0; turn += 1; listen(); },
    end() { if (!active && state === "idle") return; active = false; turn += 1; clearRetry(); stopRecognition(); stopSpeech(); publish("idle"); },
    interrupt() { if (!active) return false; turn += 1; clearRetry(); stopSpeech(); stopRecognition(); listen(); return true; },
    recognitionError: handleRecognitionError,
    recognitionEnded({ hadFinal = false, error = null } = {}) { if (error) return; if (active && state === "listening" && !hadFinal) retryRecognition("no-speech"); },
    acceptFinal,
    isActive: () => active,
    getState: () => state
  });
}
