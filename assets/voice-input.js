export const MICROPHONE_LANGUAGES = Object.freeze([
  { code: 'en-US', label: 'English' },
  { code: 'ar-SA', label: 'العربية' },
  { code: 'ar-EG', label: 'العربية (مصر)' }
]);

const languages = new Set(MICROPHONE_LANGUAGES.map(({ code }) => code));
const states = new Set(['idle', 'recording', 'processing', 'complete', 'error']);
const root = typeof window === 'undefined' ? {} : window;

const base = (dependencies = {}) => ({
  SpeechRecognition: root.SpeechRecognition || root.webkitSpeechRecognition,
  storage: root.localStorage,
  mediaDevices: root.navigator?.mediaDevices,
  AudioContext: root.AudioContext || root.webkitAudioContext,
  requestAnimationFrame: root.requestAnimationFrame?.bind(root) || ((callback) => setTimeout(callback, 16)),
  cancelAnimationFrame: root.cancelAnimationFrame?.bind(root) || clearTimeout,
  ...dependencies
});

const metadata = (text) => ({
  text,
  direction: /[\u0600-\u06ff]/.test(text) ? 'rtl' : 'ltr'
});

export function createVoiceInput(options = {}) {
  const dependencies = base(options.dependencies);
  const Recognition = dependencies.SpeechRecognition;
  const callbacks = {
    onState: options.onState || (() => {}),
    onText: options.onText || (() => {}),
    onError: options.onError || (() => {}),
    onAmplitude: options.onAmplitude || (() => {})
  };

  let language = options.language || dependencies.storage?.getItem?.('nova-composer-language') || 'en-US';
  let state = 'idle';
  let recognition;
  let token = 0;
  let draft = '';
  let finalText = '';
  let stream;
  let context;
  let source;
  let analyser;
  let frame;
  let stopped = false;

  if (!languages.has(language)) language = 'en-US';

  const setState = (next) => {
    if (!states.has(next)) return;
    state = next;
    callbacks.onState(next);
  };

  const publishAmplitude = (value) => {
    callbacks.onAmplitude(Math.max(0, Math.min(1, value || 0)));
  };

  const clearMeter = () => {
    if (frame) dependencies.cancelAnimationFrame(frame);
    frame = undefined;
    source?.disconnect?.();
    analyser?.disconnect?.();
    stream?.getTracks?.().forEach((track) => track.stop());
    context?.close?.();
    stream = undefined;
    context = undefined;
    source = undefined;
    analyser = undefined;
    publishAmplitude(0);
  };

  const finish = (next) => {
    clearMeter();
    setState(next);
  };

  const fail = (id, event = {}) => {
    if (id !== token) return;
    callbacks.onText(draft, metadata(draft), false);
    callbacks.onError({
      code: event.error || 'recognition-error',
      message: event.message || 'Microphone transcription failed. Your draft was restored.',
      recoverable: true
    });
    finish('error');
  };

  const meter = async (id) => {
    if (!dependencies.mediaDevices?.getUserMedia || !dependencies.AudioContext) return;

    try {
      stream = await dependencies.mediaDevices.getUserMedia({ audio: true });
      if (id !== token || state !== 'recording') {
        clearMeter();
        return;
      }

      context = new dependencies.AudioContext();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      let smooth = 0;
      const tick = () => {
        if (id !== token || state !== 'recording') return;
        analyser.getByteTimeDomainData(samples);

        let sum = 0;
        for (const value of samples) {
          const normalized = (value - 128) / 128;
          sum += normalized * normalized;
        }

        const raw = Math.sqrt(sum / samples.length);
        const target = raw < .012 ? 0 : Math.min(1, raw * 8);
        smooth += (target - smooth) * (target > smooth ? .42 : .16);
        publishAmplitude(smooth < .008 ? 0 : smooth);
        frame = dependencies.requestAnimationFrame(tick);
      };

      tick();
    } catch {
      publishAmplitude(0);
    }
  };

  const start = (value = '') => {
    if (!Recognition || state === 'recording' || state === 'processing') return false;

    clearMeter();
    draft = value;
    finalText = '';
    stopped = false;
    const id = ++token;
    recognition = new Recognition();
    recognition.lang = language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      if (id !== token) return;

      let interim = '';
      let finalChunk = '';
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0].transcript;
        if (result.isFinal) finalChunk += text;
        else interim += text;
      }

      if (finalChunk) finalText += finalChunk;
      const text = `${draft}${finalText}${interim}`;
      callbacks.onText(text, metadata(text), Boolean(interim));
    };
    recognition.onerror = (event) => fail(id, event);
    recognition.onend = () => {
      if (id !== token) return;
      if (state === 'recording' || (state === 'processing' && stopped)) finish('complete');
    };

    setState('recording');
    publishAmplitude(0);
    meter(id);

    try {
      recognition.start();
      return true;
    } catch (error) {
      fail(id, error);
      return false;
    }
  };

  return {
    supported: Boolean(Recognition),
    start,
    stop() {
      if (state !== 'recording') return false;
      stopped = true;
      setState('processing');
      clearMeter();
      recognition?.stop?.();
      if (!recognition?.stop) finish('complete');
      return true;
    },
    getState: () => state,
    getLanguage: () => language,
    setLanguage(next) {
      if (!languages.has(next)) throw new Error('Unsupported microphone language');
      language = next;
      dependencies.storage?.setItem?.('nova-composer-language', next);
    },
    destroy() {
      token += 1;
      clearMeter();
      recognition?.abort?.();
    }
  };
}

export function createComposerVoiceControl(options = {}) {
  const { input, button, statusTarget, errorTarget, waveformTarget, resizeInput } = options;
  if (!input || !button) throw new Error('Composer voice control requires input and button');

  let controller;
  let lastError = '';
  const render = (state, error = lastError, amplitude = 0) => {
    lastError = error || '';
    button.dataset.voiceState = state;
    button.setAttribute('aria-pressed', String(state === 'recording'));
    button.disabled = !controller.supported || state === 'processing';

    if (statusTarget) {
      statusTarget.textContent = !controller.supported
        ? 'Microphone is unavailable in this browser.'
        : ({
            idle: 'Microphone ready',
            recording: 'Listening…',
            processing: 'Processing dictation…',
            complete: 'Dictation complete',
            error: 'Dictation failed'
          }[state]);
    }

    if (errorTarget) errorTarget.textContent = lastError.message || '';
    if (waveformTarget) waveformTarget.style.setProperty('--composer-voice-amplitude', String(amplitude || 0));
  };

  controller = createVoiceInput({
    language: options.language,
    dependencies: options.dependencies,
    onState: (state) => render(state, state === 'recording' ? '' : lastError),
    onText: (text, info) => {
      input.value = text;
      input.dir = info.direction;
      resizeInput?.();
    },
    onError: (error) => render('error', error, 0),
    onAmplitude: (amplitude) => render(controller.getState(), lastError, amplitude)
  });

  const click = () => {
    if (controller.getState() === 'recording') controller.stop();
    else controller.start(input.value);
  };

  button.addEventListener('click', click);
  render('idle');

  return {
    controller,
    getState: controller.getState,
    getLanguage: controller.getLanguage,
    setLanguage: controller.setLanguage,
    destroy() {
      button.removeEventListener('click', click);
      controller.destroy();
    }
  };
}
