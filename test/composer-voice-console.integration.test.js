import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerVoiceControl } from '../assets/voice-input.js';

class Target {
  constructor(ownerDocument) {
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
    this.value = '';
    this.children = [];
    this.ownerDocument = ownerDocument;
  }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  replaceChildren(...children) { this.children = children; }
  click() { this.listeners.click?.(); }
}

const documentRef = {
  createElement() {
    return { style: {}, dataset: {} };
  }
};

test('composer integration preserves mixed dictation and restores the draft surface after stop', () => {
  let recognition;
  class Recognition { constructor() { recognition = this; } start() {} stop() { this.onend(); } }
  const input = new Target();
  const button = new Target();
  const status = new Target();
  const waveform = new Target(documentRef);
  input.value = 'Draft ';
  const voiceControl = createComposerVoiceControl({ input, button, statusTarget: status, waveformTarget: waveform, dependencies: { SpeechRecognition: Recognition } });

  button.click();
  recognition.onresult({ resultIndex: 0, results: [{ 0: { transcript: 'مرحبا Nova' }, isFinal: false }] });

  assert.equal(input.value, 'Draft مرحبا Nova');
  assert.equal(input.dir, 'rtl');
  assert.equal(button.dataset.voiceState, 'recording');
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(waveform.dataset.voiceState, 'recording');
  assert.equal(status.textContent, 'Listening…');
  assert.equal(waveform.children.length, 64);

  button.click();
  assert.equal(voiceControl.getState(), 'complete');
  assert.equal(input.value, 'Draft مرحبا Nova');
  assert.equal(button.dataset.voiceState, 'complete');
  assert.equal(button.attributes['aria-pressed'], 'false');
  assert.equal(waveform.dataset.voiceState, 'complete');
});

test('composer locale selection configures an Arabic recognizer before dictation starts', () => {
  let recognition;
  class Recognition { constructor() { recognition = this; } start() {} }
  const voiceControl = createComposerVoiceControl({ input: new Target(), button: new Target(), dependencies: { SpeechRecognition: Recognition } });
  voiceControl.setLanguage('ar-SA');
  voiceControl.controller.start('');
  assert.equal(recognition.lang, 'ar-SA');
});

test('committing a recording for send prevents late recognition events from restoring sent text', () => {
  let recognition;
  class Recognition {
    constructor() { recognition = this; }
    start() {}
    abort() { this.aborted = true; }
  }
  const input = new Target();
  const button = new Target();
  const waveform = new Target(documentRef);
  input.value = 'Unsent draft ';
  const voiceControl = createComposerVoiceControl({ input, button, waveformTarget: waveform, dependencies: { SpeechRecognition: Recognition } });

  button.click();
  recognition.onresult({ resultIndex: 0, results: [{ 0: { transcript: 'مرحبا Nova' }, isFinal: true }] });
  assert.equal(input.value, 'Unsent draft مرحبا Nova');

  assert.equal(voiceControl.commit(), true);
  input.value = '';
  recognition.onresult({ resultIndex: 0, results: [{ 0: { transcript: ' must not return' }, isFinal: true }] });
  recognition.onend();

  assert.equal(recognition.aborted, true);
  assert.equal(voiceControl.getState(), 'complete');
  assert.equal(waveform.dataset.voiceState, 'complete');
  assert.equal(input.value, '');
  assert.equal(voiceControl.commit(), false);
});
