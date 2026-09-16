import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('console uses the canonical composer voice contract', async () => {
  const [consoleJs, voice, html, css] = await Promise.all([
    'assets/console.js',
    'assets/voice-input.js',
    'index.html',
    'assets/console.css'
  ].map((path) => readFile(path, 'utf8')));

  assert.match(consoleJs, /createComposerVoiceControl/);
  assert.match(consoleJs, /composerVoiceWaveform/);
  assert.match(consoleJs, /window\.navigator\?\.mediaDevices/);
  assert.doesNotMatch(consoleJs, /requestAnimationFrame\.bind|cancelAnimationFrame\.bind/);
  assert.match(voice, /recording.*processing.*complete.*error/s);
  assert.match(html, /id="composerVoiceWaveform"/);
  assert.match(html, /type="button"/);
  assert.match(css, /--composer-voice-amplitude/);
  assert.match(css, /\.workspace\[hidden\]\{display:none\}/);
  assert.doesNotMatch(consoleJs, /requestSubmit|sendMessage/);
});
