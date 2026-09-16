import test from 'node:test';
import assert from 'node:assert/strict';

class Target {
  constructor() {
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = {
      setProperty: (key, value) => {
        this[key] = value;
      }
    };
    this.value = '';
    this.scrollHeight = 20;
  }

  addEventListener(name, listener) {
    this.listeners[name] = listener;
  }

  removeEventListener(name) {
    delete this.listeners[name];
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
  }

  click() {
    this.listeners.click?.();
  }

  replaceChildren(...items) {
    this.items = items;
  }
}

const restoreGlobal = (name, descriptor) => {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete globalThis[name];
};

test('real console integration starts and completes dictation without animation APIs or submitting', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let recognition;
  let submitCalls = 0;

  class Recognition {
    constructor() {
      recognition = this;
    }

    start() {}

    stop() {
      this.onend();
    }
  }

  const nodes = {};
  for (const id of [
    'composerForm',
    'messageInput',
    'voiceButton',
    'composerVoiceStatus',
    'composerVoiceError',
    'composerVoiceWaveform',
    'microphoneLanguage',
    'requestError'
  ]) {
    nodes[`#${id}`] = new Target();
  }

  nodes['#messageInput'].value = 'Draft ';
  nodes['#composerForm'].addEventListener = (name, listener) => {
    if (name === 'submit') {
      nodes['#composerForm'].submitListener = listener;
    }
  };

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: (selector) => nodes[selector],
      createElement: () => new Target()
    }
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      SpeechRecognition: Recognition,
      localStorage: {
        getItem() {
          return null;
        },
        setItem() {}
      },
      navigator: { mediaDevices: undefined }
    }
  });

  try {
    const module = await import(`../assets/console.js?console-test=${Date.now()}`);

    nodes['#voiceButton'].click();
    recognition.onresult({
      resultIndex: 0,
      results: [{ 0: { transcript: 'مرحبا Nova' }, isFinal: false }]
    });

    assert.equal(nodes['#messageInput'].value, 'Draft مرحبا Nova');
    assert.equal(nodes['#messageInput'].dir, 'rtl');
    assert.equal(nodes['#voiceButton'].dataset.voiceState, 'recording');
    assert.equal(nodes['#voiceButton'].attributes['aria-pressed'], 'true');

    nodes['#voiceButton'].click();

    assert.equal(module.voiceControl.getState(), 'complete');
    assert.equal(nodes['#voiceButton'].dataset.voiceState, 'complete');
    assert.equal(nodes['#voiceButton'].attributes['aria-pressed'], 'false');
    assert.equal(submitCalls, 0);
  } finally {
    restoreGlobal('document', originalDocument);
    restoreGlobal('window', originalWindow);
  }
});

test('console locale selection creates an Arabic-configured recognizer before dictation starts', async () => {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let recognition;

  class Recognition {
    constructor() { recognition = this; }
    start() {}
  }

  const nodes = {};
  for (const id of ['composerForm', 'messageInput', 'voiceButton', 'composerVoiceStatus', 'composerVoiceError', 'composerVoiceWaveform', 'microphoneLanguage', 'requestError']) nodes[`#${id}`] = new Target();
  nodes['#microphoneLanguage'].value = 'ar-SA';
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: (selector) => nodes[selector], querySelectorAll: () => [], createElement: () => new Target() } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { SpeechRecognition: Recognition, localStorage: { getItem: () => null, setItem() {} }, navigator: { mediaDevices: undefined } } });

  try {
    await import(`../assets/console.js?arabic-locale-test=${Date.now()}`);
    nodes['#microphoneLanguage'].value = 'ar-SA';
    nodes['#microphoneLanguage'].listeners.change();
    nodes['#voiceButton'].click();
    assert.equal(recognition.lang, 'ar-SA');
  } finally {
    restoreGlobal('document', originalDocument);
    restoreGlobal('window', originalWindow);
  }
});
