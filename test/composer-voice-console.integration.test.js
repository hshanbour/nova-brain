import test from 'node:test';
import assert from 'node:assert/strict';
import { createComposerVoiceControl } from '../assets/voice-input.js';

class Target {
  constructor() { this.dataset = {}; this.attributes = {}; this.listeners = {}; this.style = { setProperty: (key, value) => { this.style[key] = value; } }; this.value = ''; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  removeEventListener(name) { delete this.listeners[name]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  click() { this.listeners.click?.(); }
}

test('composer integration starts and completes editable dictation without submitting', () => {
  let recognition;
  class Recognition { constructor() { recognition = this; } start() {} stop() { this.onend(); } }
  const input = new Target(); const button = new Target(); const status = new Target(); const waveform = new Target();
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
  button.click();
  assert.equal(voiceControl.getState(), 'complete');
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
