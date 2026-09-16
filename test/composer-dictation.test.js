import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceInput } from '../assets/voice-input.js';

test('publishes editable mixed Arabic-English transcription', () => {
  let instance;
  let text;
  let info;

  class Recognition {
    constructor() {
      instance = this;
    }

    start() {}
  }

  const voice = createVoiceInput({
    dependencies: { SpeechRecognition: Recognition },
    onText: (value, metadata) => {
      text = value;
      info = metadata;
    }
  });

  voice.start('Draft ');
  instance.onresult({
    resultIndex: 0,
    results: [{ 0: { transcript: 'مرحبا Nova' }, isFinal: false }]
  });

  assert.equal(text, 'Draft مرحبا Nova');
  assert.equal(info.direction, 'rtl');
});

test('restores the captured draft after an error', () => {
  let instance;
  let text;

  class Recognition {
    constructor() {
      instance = this;
    }

    start() {}
  }

  const voice = createVoiceInput({
    dependencies: { SpeechRecognition: Recognition },
    onText: (value) => {
      text = value;
    }
  });

  voice.start('before');
  instance.onerror({ error: 'network' });

  assert.equal(text, 'before');
  assert.equal(voice.getState(), 'error');
});
