export const MAX_SPEECH_CHARACTERS = 12000;
export const MAX_SPEECH_CHUNKS = 80;
export const MAX_CHUNK_CHARACTERS = 220;

export function detectSpeechLocale(text = "") {
  const arabic = (text.match(/[\u0600-\u06ff]/g) || []).length;
  const latin = (text.match(/[A-Za-zÀ-ž]/g) || []).length;
  if (arabic > latin) return "ar";
  const samples = [
    ["fr", /\b(?:bonjour|merci|avec|pour|vous|une|est)\b/i],
    ["es", /\b(?:hola|gracias|con|para|una|que)\b/i],
    ["de", /\b(?:hallo|danke|und|mit|für|ist)\b/i],
    ["it", /\b(?:ciao|grazie|con|per|una|che)\b/i],
    ["ro", /\b(?:salut|mulțumesc|pentru|este)\b/i],
    ["tr", /\b(?:merhaba|teşekkür|için|bir)\b/i]
  ];
  return samples.find(([, pattern]) => pattern.test(text))?.[0] || "en-GB";
}

export function selectSpeechVoice(voices = [], locale = "en-GB", preferred = "") {
  if (!voices.length) return null;
  const normal = String(locale).toLowerCase();
  const prefix = normal.split("-")[0];
  const saved = voices.find((voice) => voice.voiceURI === preferred || voice.name === preferred);
  const exact = voices.find((voice) => String(voice.lang).toLowerCase() === normal);
  if (exact) return exact;
  if (saved && String(saved.lang).toLowerCase().split("-")[0] === prefix) return saved;
  return voices.find((voice) => String(voice.lang).toLowerCase().split("-")[0] === prefix) ||
    voices.find((voice) => voice.default) || voices[0];
}

export function hasLanguageVoice(voices = [], locale = "") {
  const prefix = String(locale).toLowerCase().split("-")[0];
  return Boolean(prefix && voices.some((voice) => String(voice.lang || "").toLowerCase().split("-")[0] === prefix));
}

export function sanitiseSpeechText(value = "") {
  return String(value)
    .replace(/```[\s\S]*?```/g, " Code block omitted from speech. ")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9._~-]+)\b/gi, " sensitive value omitted ")
    .replace(/(?:postgres(?:ql)?):\/\/\S+/gi, " database address omitted ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, " link ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/([!?.,])\1{2,}/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_SPEECH_CHARACTERS);
}

export function speechChunks(value, maximum = MAX_CHUNK_CHARACTERS) {
  const text = sanitiseSpeechText(value);
  if (!text) return [];
  const sentences = text.match(/[^.!?؟\n]+[.!?؟]?|\n+/g) || [text];
  const chunks = [];
  for (const sentence of sentences) {
    let remaining = sentence.trim();
    while (remaining && chunks.length < MAX_SPEECH_CHUNKS) {
      if (remaining.length <= maximum) { chunks.push(remaining); break; }
      const boundary = remaining.lastIndexOf(" ", maximum);
      const end = boundary > maximum / 2 ? boundary : maximum;
      chunks.push(remaining.slice(0, end).trim()); remaining = remaining.slice(end).trim();
    }
    if (chunks.length >= MAX_SPEECH_CHUNKS) break;
  }
  return chunks;
}

function errorName(event) {
  return String(event?.error || "unknown").replace(/[^a-z0-9_-]/gi, "").slice(0, 60) || "unknown";
}

export function createVoiceOutput({
  synthesis, Utterance, storage,
  preferredVoiceKey = "nova.voice.preferred", autoSpeakKey = "nova.voice.autoSpeak",
  onState = () => {}, onVoices = () => {}, onDiagnostic = () => {},
  schedule = (callback, delay) => setTimeout(callback, delay), startDelay = 80, chunkDelay = 35,
  rate = 1, pitch = 1, volume = 1
} = {}) {
  const supported = Boolean(synthesis && Utterance);
  let preferredVoice = storage?.getItem(preferredVoiceKey) || "";
  let autoSpeak = storage?.getItem(autoSpeakKey) === "true";
  let activeId = null; let generation = 0; let voices = supported ? synthesis.getVoices() || [] : [];
  const publishVoices = () => { voices = synthesis.getVoices() || []; onVoices([...voices]); };
  if (supported) {
    synthesis.addEventListener?.("voiceschanged", publishVoices);
    if ("onvoiceschanged" in synthesis && !synthesis.addEventListener) synthesis.onvoiceschanged = publishVoices;
  }

  function stop() {
    generation += 1; synthesis?.cancel?.();
    if (activeId !== null) { activeId = null; onState({ speaking: false, id: null }); }
  }

  function speak(text, { id = "response", locale, onComplete = () => {}, onError = () => {} } = {}) {
    if (!supported) return false;
    const chunks = speechChunks(text); if (!chunks.length) return false;
    generation += 1; const current = generation; synthesis.cancel?.(); activeId = id;
    onState({ speaking: false, starting: true, id });
    const chosenLocale = locale || detectSpeechLocale(text);
    let index = 0; let voice; let fallbackUsed = false;

    const finish = () => {
      if (current !== generation) return;
      activeId = null; onState({ speaking: false, id: null }); onComplete();
    };
    const fail = (reason) => {
      if (current !== generation) return;
      generation += 1; synthesis.cancel?.(); activeId = null;
      const message = `Browser speech failed (${reason}). Try Test Voice or choose another installed voice.`;
      onDiagnostic(message); onState({ speaking: false, id: null, error: reason }); onError(reason);
    };
    const candidates = () => {
      publishVoices(); const first = selectSpeechVoice(voices, chosenLocale, preferredVoice);
      const ordered = [first, ...voices.filter((item) => item !== first), null];
      return ordered.filter((item, position) => ordered.indexOf(item) === position);
    };
    let available = [];
    const next = () => {
      if (current !== generation) return;
      if (index >= chunks.length) { finish(); return; }
      const chunk = chunks[index]; let started = false;
      const utterance = new Utterance(chunk); utterance.lang = voice?.lang || chosenLocale;
      if (voice) utterance.voice = voice;
      utterance.rate = rate; utterance.pitch = pitch; utterance.volume = volume;
      utterance.onstart = () => {
        if (current !== generation) return;
        started = true;
        const compatible = hasLanguageVoice([voice].filter(Boolean), chosenLocale);
        const compatibleInstalled = hasLanguageVoice(voices, chosenLocale);
        const diagnostic = chosenLocale.toLowerCase().startsWith("ar") && !compatible
          ? `${compatibleInstalled ? "Arabic browser voice unavailable." : "No Arabic browser voice is installed."} Using fallback voice ${voice?.name || "browser default"} (${utterance.lang}).`
          : `Speaking with ${voice?.name || "browser default"} (${utterance.lang}).`;
        onDiagnostic(diagnostic);
        onState({ speaking: true, starting: false, id, voice: voice?.name || "browser default", locale: utterance.lang, requestedLocale: chosenLocale, fallback: !compatible });
      };
      utterance.onend = () => {
        if (current !== generation) return;
        if (!started) { retryOrFail("ended-before-start"); return; }
        index += 1; fallbackUsed = false;
        if (index >= chunks.length) finish();
        else schedule(() => { if (current === generation) next(); }, chunkDelay);
      };
      utterance.onerror = (event) => { if (current === generation) retryOrFail(errorName(event)); };
      synthesis.speak(utterance);
    };
    const retryOrFail = (reason) => {
      if (current !== generation) return;
      if (!fallbackUsed && available.length) {
        fallbackUsed = true; synthesis.cancel?.(); voice = available.shift();
        onDiagnostic(`Browser speech reported ${reason}; retrying with ${voice?.name || "the browser default voice"}.`);
        schedule(() => { if (current === generation) { if (synthesis.paused) synthesis.resume?.(); next(); } }, startDelay);
        return;
      }
      fail(reason);
    };
    schedule(() => {
      if (current !== generation) return;
      if (synthesis.paused) synthesis.resume?.();
      available = candidates(); voice = available.shift(); next();
    }, startDelay);
    return true;
  }

  return Object.freeze({
    supported,
    speak,
    stop,
    isSpeaking: () => activeId !== null,
    activeId: () => activeId,
    getVoices: () => [...voices],
    getPreferredVoice: () => preferredVoice,
    setPreferredVoice(value = "") { preferredVoice = String(value); storage?.setItem(preferredVoiceKey, preferredVoice); },
    getAutoSpeak: () => autoSpeak,
    setAutoSpeak(value) { autoSpeak = Boolean(value); storage?.setItem(autoSpeakKey, String(autoSpeak)); },
    refreshVoices: publishVoices
  });
}
