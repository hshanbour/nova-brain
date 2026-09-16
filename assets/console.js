import { MICROPHONE_LANGUAGES, createComposerVoiceControl } from './voice-input.js';

const composer = document.querySelector('#composerForm');
const input = document.querySelector('#messageInput');
const button = document.querySelector('#voiceButton');
const requestError = document.querySelector('#requestError');

const resizeInput = () => {
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
};

input?.addEventListener('input', resizeInput);

const voiceControl = input && button
  ? createComposerVoiceControl({
      input,
      button,
      statusTarget: document.querySelector('#composerVoiceStatus'),
      errorTarget: document.querySelector('#composerVoiceError'),
      waveformTarget: document.querySelector('#composerVoiceWaveform'),
      resizeInput,
      dependencies: {
        SpeechRecognition: window.SpeechRecognition || window.webkitSpeechRecognition,
        storage: window.localStorage,
        mediaDevices: window.navigator?.mediaDevices,
        AudioContext: window.AudioContext || window.webkitAudioContext
      }
    })
  : null;

const select = document.querySelector('#microphoneLanguage');
if (select && voiceControl) {
  select.replaceChildren(...MICROPHONE_LANGUAGES.map(({ code, label }) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    return option;
  }));
  select.value = voiceControl.getLanguage();
  select.addEventListener('change', () => voiceControl.setLanguage(select.value));
}

composer?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (requestError) requestError.textContent = '';
  const message = input?.value.trim();
  if (!message) return;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message })
    });
    if (!response.ok) throw new Error('Request failed');
  } catch (error) {
    if (requestError) requestError.textContent = error.message;
  }
});

export { voiceControl };
