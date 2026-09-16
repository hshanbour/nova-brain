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
