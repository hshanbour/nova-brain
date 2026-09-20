import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInput } from '../assets/voice-input.js';

test('reports unsupported recognition', () => {
  const voice = createVoiceInput({ dependencies: { SpeechRecognition: undefined } });
  assert.equal(voice.supported, false);
  assert.equal(voice.start('draft'), false);
});

test('persists supported Arabic locale', () => {
  const writes = [];
  class Recognition { start() {} }
  const voice = createVoiceInput({
    dependencies: {
      SpeechRecognition: Recognition,
      storage: { getItem: () => 'en-US', setItem: (...args) => writes.push(args) }
    }
  });
  voice.setLanguage('ar-SA');
  assert.equal(voice.getLanguage(), 'ar-SA');
  assert.deepEqual(writes, [['nova-composer-language', 'ar-SA']]);
  assert.throws(() => voice.setLanguage('fr-FR'));
});

test('retires an English recognizer and creates an Arabic-configured replacement', () => {
  const instances = [];
  class Recognition {
    constructor() { instances.push(this); }
    start() {}
    abort() { this.aborted = true; }
  }
  const voice = createVoiceInput({ dependencies: { SpeechRecognition: Recognition } });
  voice.start('Draft ');
  voice.setLanguage('ar-EG');
  voice.start('Draft ');
  assert.equal(instances.length, 2);
  assert.equal(instances[0].lang, 'en-US');
  assert.equal(instances[0].aborted, true);
  assert.equal(instances[1].lang, 'ar-EG');
});

test('explicit stop reaches complete when recognition ends', () => {
  let instance;
  class Recognition {
    constructor() { instance = this; }
    start() {}
    stop() { this.onend(); }
  }
  const states = [];
  const voice = createVoiceInput({
    dependencies: { SpeechRecognition: Recognition },
    onState: (state) => states.push(state)
  });
  voice.start('');
  voice.stop();
  assert.deepEqual(states, ['recording', 'processing', 'complete']);
  assert.equal(voice.getState(), 'complete');
});

test('samples microphone analyser levels, exposes distinct frequency bars, and safely cleans up', async () => {
  let recognition;
  let frame;
  let cancelled = false;
  let stopped = false;
  let samples = 128;
  const levels = [];
  const spectra = [];
  class Recognition { constructor() { recognition = this; } start() {} stop() { this.onend(); } }
  class AudioContext {
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() {
      return {
        fftSize: 0,
        frequencyBinCount: 128,
        smoothingTimeConstant: 0,
        connect() {},
        disconnect() {},
        getByteTimeDomainData(values) { values.fill(samples); },
        getByteFrequencyData(values) { values.fill(0); values[4] = 220; values[76] = 90; }
      };
    }
    close() {}
  }
  const voice = createVoiceInput({
    dependencies: {
      SpeechRecognition: Recognition,
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() { stopped = true; } }] }) },
      AudioContext,
      requestAnimationFrame: (callback) => { frame = callback; return 1; },
      cancelAnimationFrame: () => { cancelled = true; }
    },
    onAmplitude: (level) => levels.push(level),
    onSpectrum: (spectrum) => spectra.push(spectrum)
  });

  voice.start('');
  await new Promise((resolve) => setImmediate(resolve));
  const silence = levels.at(-1);
  samples = 160;
  frame();

  assert.equal(silence, 0);
  assert.ok(levels.at(-1) > 0);
  assert.equal(spectra.at(-1).length, 64);
  assert.notEqual(spectra.at(-1)[2], spectra.at(-1)[38]);

  voice.stop();
  assert.equal(voice.getState(), 'complete');
  assert.equal(cancelled, true);
  assert.equal(stopped, true);
  assert.equal(recognition.lang, 'en-US');
});
