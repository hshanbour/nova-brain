import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInput } from '../assets/voice-input.js';

class Recognition {
  static instances = [];

  constructor() {
    Recognition.instances.push(this);
    this.started = 0;
  }

  start() {
    this.started += 1;
    this.langAtStart = this.lang;
  }

  stop() {
    this.onend?.();
  }

  emit(text, isFinal = true) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
  }
}

function harness({ meter = true, deferredMeter = false } = {}) {
  Recognition.instances = [];
  const states = [];
  const texts = [];
  const finals = [];
  const errors = [];
  const amplitudes = [];
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  let resolveMedia;
  let rejectMedia;
  const mediaDevices = meter ? {
    getUserMedia: () => deferredMeter
      ? new Promise((resolve, reject) => { resolveMedia = resolve; rejectMedia = reject; })
      : Promise.resolve({ getTracks: () => tracks })
  } : undefined;
  const frames = new Map();
  let frameId = 0;
  const input = createVoiceInput({
    dependencies: {
      SpeechRecognition: Recognition,
      mediaDevices,
      AudioContext: class {
        createAnalyser() {
          return { fftSize: 4, getByteTimeDomainData(values) { values.fill(160); }, disconnect() {} };
        }
        createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
        close() {}
      },
      requestAnimationFrame: (fn) => { const id = ++frameId; frames.set(id, fn); return id; },
      cancelAnimationFrame: (id) => frames.delete(id)
    },
    onState: (value) => states.push(value),
    onText: (text, metadata) => texts.push([text, metadata]),
    onFinal: (text, metadata) => finals.push([text, metadata]),
    onError: (error) => errors.push(error),
    onAmplitude: (value) => amplitudes.push(value)
  });
  return { input, states, texts, finals, errors, amplitudes, tracks, frames, get resolveMedia() { return resolveMedia; }, get rejectMedia() { return rejectMedia; } };
}

test('composer appends editable Arabic-English text and completes without auto-send', async () => {
  const h = harness();
  assert.equal(h.input.start('Draft: '), true);
  const recognition = Recognition.instances[0];
  recognition.emit('مرحبا hello', false);
  assert.deepEqual(h.texts.at(-1), ['Draft: مرحبا hello', { direction: 'rtl', mixed: true, rtlAware: true, editable: true }]);
  recognition.emit('مرحبا hello');
  assert.equal(h.input.stop(), true);
  assert.deepEqual(h.states, ['recording', 'processing', 'complete']);
  assert.deepEqual(h.finals, [['Draft: مرحبا hello', { direction: 'rtl', mixed: true, rtlAware: true, editable: true }]]);
  assert.equal(h.errors.length, 0);
});

test('no-speech restores the exact draft, clears metering, and remains recoverable', async () => {
  const h = harness();
  h.input.start('ابقَ هذه المسودة ');
  await Promise.resolve();
  assert.ok(h.amplitudes.some((value) => value > 0 && value <= 1));
  Recognition.instances[0].onerror({ error: 'no-speech' });
  assert.deepEqual(h.texts.at(-1), ['ابقَ هذه المسودة ', { direction: 'rtl', mixed: false, rtlAware: true, editable: true }]);
  assert.equal(h.amplitudes.at(-1), 0);
  assert.equal(h.errors.at(-1).code, 'no-speech');
  assert.equal(h.input.getState(), 'idle');
  assert.equal(h.input.start('ابقَ هذه المسودة '), true);
});

test('unavailable and late-rejected optional metering do not block recognition', async () => {
  const unavailable = harness({ meter: false });
  assert.equal(unavailable.input.start('draft'), true);
  assert.deepEqual(unavailable.states, ['recording']);
  unavailable.input.stop();

  const delayed = harness({ deferredMeter: true });
  assert.equal(delayed.input.start('draft'), true);
  await Promise.resolve();
  assert.equal(typeof delayed.rejectMedia, 'function');
  delayed.rejectMedia(new Error('late meter failure'));
  await Promise.resolve();
  assert.deepEqual(delayed.states, ['recording']);
  assert.equal(delayed.errors.length, 0);
  delayed.input.stop();
});
