export const MICROPHONE_LANGUAGES = Object.freeze([
  ["English (UK)", "en-GB"], ["English (US)", "en-US"], ["Arabic", "ar-SA"],
  ["French", "fr-FR"], ["Spanish", "es-ES"], ["German", "de-DE"],
  ["Italian", "it-IT"], ["Romanian", "ro-RO"], ["Turkish", "tr-TR"]
]);

const RECOGNITION_ERRORS = Object.freeze({
  unsupported: { recoverable: false, message: "Voice input is not supported in this browser." },
  "no-speech": { recoverable: true, message: "No speech heard." },
  aborted: { recoverable: true, message: "Voice recognition was interrupted." },
  "not-allowed": { recoverable: false, message: "Microphone permission was denied." },
  "service-not-allowed": { recoverable: false, message: "Browser speech recognition is blocked." },
  "audio-capture": { recoverable: false, message: "No working microphone was found." },
  network: { recoverable: false, message: "Browser speech recognition could not reach its service." }
});

function recognitionError(code) {
  const safeCode = String(code || "unknown").replace(/[^a-z0-9_-]/gi, "").slice(0, 60) || "unknown";
  return Object.freeze({ code: safeCode, ...(RECOGNITION_ERRORS[safeCode] || { recoverable: false, message: `Voice input could not continue (${safeCode}).` }) });
}

export function createVoiceInput({ SpeechRecognition, onText, onFinal, onEnd, onState, onError, storage, languageKey = "nova.voice.inputLanguage", defaultLanguage = "en-GB" }) {
  let language = storage?.getItem(languageKey) || defaultLanguage;
  if (!SpeechRecognition) return Object.freeze({
    supported: false,
    start() { onError?.(recognitionError("unsupported")); }, stop() {},
    getLanguage() { return language; },
    setLanguage(value) { language = String(value || defaultLanguage); storage?.setItem(languageKey, language); }
  });

  const recognition = new SpeechRecognition();
  recognition.continuous = false; recognition.interimResults = true;
  let finalText = ""; let active = false; let lastError = null;
  recognition.onstart = () => { active = true; onState?.("listening", { language }); };
  recognition.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript;
      if (event.results[index].isFinal) finalText += `${finalText ? " " : ""}${text}`;
      else interim += text;
    }
    onText?.(`${finalText}${interim}`.trim());
  };
  recognition.onerror = (event) => {
    active = false; lastError = recognitionError(event.error); onState?.("idle", { language, error: lastError.code }); onError?.(lastError);
  };
  recognition.onend = () => {
    active = false; const completed = finalText.trim(); const error = lastError;
    finalText = ""; lastError = null; onState?.("idle", { language, error: error?.code });
    if (completed) onFinal?.(completed);
    onEnd?.({ hadFinal: Boolean(completed), error: error?.code || null });
  };
  return Object.freeze({
    supported: true,
    start() {
      finalText = ""; lastError = null; recognition.lang = language; active = true;
      try { recognition.start(); } catch (error) { active = false; throw error; }
    },
    stop() { if (active) recognition.stop(); },
    getLanguage() { return language; },
    setLanguage(value) { language = String(value || defaultLanguage); storage?.setItem(languageKey, language); }
  });
}
