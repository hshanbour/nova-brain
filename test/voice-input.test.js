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

  class Recognition {
    start() {}
  }

  const voice = createVoiceInput({
    dependencies: {
      SpeechRecognition: Recognition,
      storage: {
        getItem: () => 'en-US',
        setItem: (...args) => writes.push(args)
      }
    }
  });

  voice.setLanguage('ar-SA');

  assert.equal(voice.getLanguage(), 'ar-SA');
  assert.deepEqual(writes, [['nova-composer-language', 'ar-SA']]);
  assert.throws(() => voice.setLanguage('fr-FR'));
});

test('explicit stop reaches complete when recognition ends', () => {
  let instance;

  class Recognition {
    constructor() {
      instance = this;
    }

    start() {}

    stop() {
      this.onend();
    }
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
