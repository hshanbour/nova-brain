const DEFAULT_LANGUAGE = 'ar-SA';
const LANGUAGE_STORAGE_KEY = 'nova.composer.dictationLanguage';

export const MICROPHONE_LANGUAGES = Object.freeze([
  { value: 'ar-SA', label: 'العربية (السعودية)' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' }
]);

function supportedLanguage(language) {
  return MICROPHONE_LANGUAGES.some(({ value }) => value === language);
}

function composerMetadata(text) {
  const hasArabic = /[\u0600-\u06ff]/u.test(text);
  const hasLatin = /[A-Za-z]/u.test(text);
  return {
    direction: hasArabic ? 'rtl' : 'ltr',
    mixed: hasArabic && hasLatin,
    rtlAware: hasArabic,
    editable: true
  };
}

function normalizeAmplitude(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function errorDetails(error) {
  const code = error?.error || error?.name || 'unknown';
  const mapped = {
    'not-allowed': ['permission-denied', 'Microphone permission was denied. Your draft was preserved.', false],
    'service-not-allowed': ['permission-denied', 'Speech recognition is unavailable. Your draft was preserved.', false],
    network: ['network', 'Network transcription failed. Check your connection and try again.', true],
    'no-speech': ['no-speech', 'No speech was detected. Your draft was preserved; try again when ready.', true],
    aborted: ['aborted', 'Dictation was stopped. Your draft was preserved.', true],
    'audio-capture': ['audio-capture', 'No usable microphone was found. Your draft was preserved.', false],
    unsupported: ['unsupported', 'Speech recognition is not supported in this browser. Your draft was preserved.', false]
  }[code] || ['unknown', 'Dictation failed unexpectedly. Your draft was preserved.', true];
  return { code: mapped[0], message: mapped[1], recoverable: mapped[2] };
}

export function createVoiceInput(options = {}) {
  const deps = options.dependencies || {};
  const storage = deps.storage || globalThis.localStorage;
  const Recognition = deps.SpeechRecognition || globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  const mediaDevices = deps.mediaDevices || globalThis.navigator?.mediaDevices;
  const AudioContext = deps.AudioContext || globalThis.AudioContext || globalThis.webkitAudioContext;
  const requestFrame = deps.requestAnimationFrame || globalThis.requestAnimationFrame;
  const cancelFrame = deps.cancelAnimationFrame || globalThis.cancelAnimationFrame;
  const publishState = options.onState || (() => {});
  const publishText = options.onText || (() => {});
  const publishFinal = options.onFinal || (() => {});
  const publishError = options.onError || (() => {});
  const publishAmplitude = options.onAmplitude || (() => {});
  const readDraft = options.getDraft || (() => '');
  let language = supportedLanguage(storage?.getItem?.(LANGUAGE_STORAGE_KEY))
    ? storage.getItem(LANGUAGE_STORAGE_KEY)
    : DEFAULT_LANGUAGE;
  let session = null;

  function isCurrent(current) {
    return session === current && !current.terminal;
  }

  function setState(current, next) {
    if (current?.state === next) return;
    current.state = next;
    publishState(next);
  }

  function emitText(current, interim = '') {
    const transcript = `${current.draft}${current.finals}${interim}`;
    publishText(transcript, composerMetadata(transcript));
    return transcript;
  }

  function cleanMeter(current) {
    if (current.frame != null) cancelFrame?.(current.frame);
    current.frame = null;
    current.source?.disconnect?.();
    current.analyser?.disconnect?.();
    current.audioContext?.close?.();
    current.stream?.getTracks?.().forEach((track) => track.stop?.());
    publishAmplitude(0);
  }

  function cleanup(current) {
    cleanMeter(current);
    current.recognition.onresult = null;
    current.recognition.onerror = null;
    current.recognition.onend = null;
  }

  function complete(current) {
    if (!isCurrent(current)) return;
    current.terminal = true;
    const transcript = emitText(current);
    publishFinal(transcript, composerMetadata(transcript));
    cleanup(current);
    setState(current, 'complete');
    if (session === current) session = null;
  }

  function fail(current, source) {
    if (!isCurrent(current)) return;
    current.terminal = true;
    try { current.recognition.stop?.(); } catch {}
    publishText(current.draft, composerMetadata(current.draft));
    cleanup(current);
    publishError(errorDetails(source));
    setState(current, 'error');
    if (session === current) session = null;
  }

  function beginMeter(current) {
    if (!mediaDevices?.getUserMedia || !AudioContext || !requestFrame) return;
    Promise.resolve(mediaDevices.getUserMedia({ audio: true })).then((stream) => {
      if (!isCurrent(current)) {
        stream.getTracks?.().forEach((track) => track.stop?.());
        return;
      }
      current.stream = stream;
      current.audioContext = new AudioContext();
      current.analyser = current.audioContext.createAnalyser();
      current.source = current.audioContext.createMediaStreamSource(stream);
      current.source.connect(current.analyser);
      const samples = new Uint8Array(current.analyser.fftSize || 32);
      const tick = () => {
        if (!isCurrent(current) || current.state !== 'recording') return;
        current.analyser.getByteTimeDomainData(samples);
        let total = 0;
        for (const sample of samples) total += Math.abs(sample - 128) / 128;
        publishAmplitude(normalizeAmplitude(total / samples.length));
        current.frame = requestFrame(tick);
      };
      tick();
    }).catch(() => {
      // Speech recognition remains usable when optional visual metering is unavailable.
    });
  }

  function start(draft = readDraft()) {
    if (session) return false;
    const originalDraft = String(draft ?? '');
    if (!Recognition) {
      publishText(originalDraft, composerMetadata(originalDraft));
      publishAmplitude(0);
      publishError(errorDetails({ error: 'unsupported' }));
      publishState('error');
      return false;
    }

    const recognition = new Recognition();
    const current = {
      draft: originalDraft,
      finals: '',
      recognition,
      terminal: false,
      state: 'idle',
      frame: null,
      stream: null,
      source: null,
      analyser: null,
      audioContext: null
    };
    session = current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;
    recognition.onresult = (event) => {
      if (!isCurrent(current)) return;
      let interim = '';
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript || '';
        if (result.isFinal) current.finals += text;
        else interim += text;
      }
      emitText(current, interim);
    };
    recognition.onerror = (event) => fail(current, event);
    recognition.onend = () => {
      if (!isCurrent(current)) return;
      setState(current, 'processing');
      complete(current);
    };

    setState(current, 'recording');
    beginMeter(current);
    try {
      recognition.start();
      return true;
    } catch (error) {
      fail(current, error);
      return false;
    }
  }

  function stop() {
    if (!session || session.terminal) return false;
    setState(session, 'processing');
    try {
      session.recognition.stop();
    } catch (error) {
      fail(session, error);
    }
    return true;
  }

  function setLanguage(nextLanguage) {
    if (!supportedLanguage(nextLanguage)) return false;
    language = nextLanguage;
    storage?.setItem?.(LANGUAGE_STORAGE_KEY, language);
    return true;
  }

  return {
    start,
    stop,
    setLanguage,
    getLanguage: () => language,
    getState: () => session?.state || 'idle'
  };
}
