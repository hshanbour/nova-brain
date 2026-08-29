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
  if (saved && String(saved.lang).toLowerCase().split("-")[0] === prefix) return saved;
  const exact = voices.find((voice) => String(voice.lang).toLowerCase() === normal);
  if (exact) return exact;
  return voices.find((voice) => String(voice.lang).toLowerCase().split("-")[0] === prefix) ||
    voices.find((voice) => voice.default) || voices[0];
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

export function createVoiceOutput({ synthesis, Utterance, storage, preferredVoiceKey = "nova.voice.preferred", autoSpeakKey = "nova.voice.autoSpeak", onState = () => {}, onVoices = () => {} } = {}) {
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

  function speak(text, { id = "response", locale } = {}) {
    if (!supported) return false;
    const chunks = speechChunks(text); if (!chunks.length) return false;
    stop(); const current = generation; activeId = id; onState({ speaking: true, id });
    const chosenLocale = locale || detectSpeechLocale(text);
    const voice = selectSpeechVoice(voices, chosenLocale, preferredVoice);
    let index = 0;
    const next = () => {
      if (current !== generation) return;
      if (index >= chunks.length) { activeId = null; onState({ speaking: false, id: null }); return; }
      const utterance = new Utterance(chunks[index++]); utterance.lang = voice?.lang || chosenLocale;
      if (voice) utterance.voice = voice;
      utterance.onend = next;
      utterance.onerror = () => { if (current === generation) { generation += 1; synthesis.cancel?.(); activeId = null; onState({ speaking: false, id: null, error: true }); } };
      synthesis.speak(utterance);
    };
    next(); return true;
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
