import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInput } from '../assets/voice-input.js';

class FakeRecognition {
  static instances = [];

  constructor() {
    FakeRecognition.instances.push(this);
    this.startCount = 0;
  }

  start() {
    this.startCount += 1;
    this.langAtStart = this.lang;
  }

  stop() {
    this.onend?.();
  }

  emit(text, isFinal) {
    this.onresult?.({ resultIndex: 0, results: [{ isFinal, 0: { transcript: text } }] });
  }
}

function setup() {
  FakeRecognition.instances = [];
  const values = new Map();
  const texts = [];
  const states = [];
  const errors = [];
  const finals = [];
  const storage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const input = createVoiceInput({
    dependencies: { SpeechRecognition: FakeRecognition, storage },
    onText: (text) => texts.push(text),
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
    onFinal: (text) => finals.push(text)
  });
  return { input, values, texts, states, errors, finals };
}

test('defaults to ar-SA, persists a selected composer locale, and reapplies it before start', () => {
  const h = setup();
  assert.equal(h.input.getLanguage(), 'ar-SA');
  h.input.start('');
  assert.equal(FakeRecognition.instances[0].langAtStart, 'ar-SA');
  FakeRecognition.instances[0].stop();
  assert.equal(h.input.setLanguage('en-US'), true);
  assert.equal(h.values.get('nova.composer.dictationLanguage'), 'en-US');
  h.input.start('');
  assert.equal(FakeRecognition.instances[1].langAtStart, 'en-US');
  assert.equal(h.input.setLanguage('fr-FR'), false);
});

test('interim text is editable, completion is once, and duplicate starts are rejected', () => {
  const h = setup();
  assert.equal(h.input.start('Draft '), true);
  assert.equal(h.input.start('other'), false);
  const recognition = FakeRecognition.instances[0];
  assert.equal(recognition.startCount, 1);
  recognition.emit('مرحبا hello', false);
  assert.equal(h.texts.at(-1), 'Draft مرحبا hello');
  recognition.emit('مرحبا hello', true);
  recognition.stop();
  assert.deepEqual(h.states, ['recording', 'processing', 'complete']);
  assert.deepEqual(h.finals, ['Draft مرحبا hello']);
});

test('no-speech and unsupported recognition preserve editable drafts with structured errors', () => {
  const h = setup();
  h.input.start('Keep me');
  FakeRecognition.instances[0].onerror({ error: 'no-speech' });
  assert.equal(h.texts.at(-1), 'Keep me');
  assert.deepEqual(h.errors.at(-1), {
    code: 'no-speech',
    message: 'No speech was detected. Your draft was preserved; try again when ready.',
    recoverable: true
  });
  const texts = [];
  const errors = [];
  const unsupported = createVoiceInput({
    dependencies: {},
    onText: (text) => texts.push(text),
    onError: (error) => errors.push(error)
  });
  assert.equal(unsupported.start('Existing'), false);
  assert.equal(texts.at(-1), 'Existing');
  assert.equal(errors.at(-1).code, 'unsupported');
});
