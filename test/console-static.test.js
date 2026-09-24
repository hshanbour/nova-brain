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
  assert.match(consoleJs, /activeSendController = new AbortController|new AbortController\(\); activeSendController = controller/);
  assert.match(consoleJs, /activeSendController\?\.abort\(\)/);
  assert.match(consoleJs, /value \? "Stop" : "Send"/);
  assert.match(consoleJs, /composerVoiceWaveform/);
  assert.match(consoleJs, /window\.navigator\?\.mediaDevices/);
  assert.doesNotMatch(consoleJs, /requestAnimationFrame\.bind|cancelAnimationFrame\.bind/);
  assert.match(voice, /recording.*processing.*complete.*error/s);
  assert.match(html, /id="composerVoiceWaveform"/);
  assert.match(html, /id="composerVoiceWaveform" data-voice-state="idle"/);
  assert.match(html, /class="app-shell"/);
  assert.match(html, /href="#chat"/);
  assert.match(html, /href="#memory"/);
  assert.match(html, /id="voiceModeButton"/);
  assert.match(html, /id="endVoiceButton"/);
  assert.match(html, /type="button"/);
  assert.match(css, /--composer-voice-amplitude/);
  assert.match(css, /#composerVoiceWaveform\[data-voice-state="recording"\]\{display:flex\}/);
  assert.match(css, /\.composer textarea,#composerVoiceWaveform\{grid-column:1;grid-row:1/);
  assert.match(css, /\.composer-actions\{grid-column:2;grid-row:1/);
  assert.doesNotMatch(css, /inset:50% 112px auto 24px/);
  assert.match(css, /#composerVoiceWaveform\[data-voice-state="recording"\]\{padding:0 18px/);
  assert.match(css, /textarea\{visibility:hidden\}/);
  assert.match(css, /height:calc\(4px \+ var\(--composer-voice-amplitude\)\)/);
  assert.doesNotMatch(css, /composer-voice-amplitude\) \* 12px/);
  assert.match(css, /\.workspace\[hidden\]\{display:none\}/);
  assert.match(consoleJs, /createVoiceV2/);
  assert.match(consoleJs, /createComposerVoiceControl/);
  assert.match(consoleJs, /voiceControl\.commit\(\); stopVoiceActivity\(\); input\.value = ""/);
  assert.match(consoleJs, /result\.durableTask\?\.id/);
  assert.match(consoleJs, /restoreLiveActivities\(storedMessages\)/);
  assert.match(consoleJs, /restoreLiveActivities\(restored\.messages\)/);
  assert.match(consoleJs, /durableTaskRecordsFromMessages\(storedMessages,client\.conversationId\)/);
  assert.match(consoleJs, /liveActivityRecords\.has\(stored\.taskId\)/);
  assert.match(consoleJs, /ensureLiveActivity/);
  assert.match(consoleJs, /refreshLiveActivity/);
  assert.match(consoleJs, /task\.stateVersion/);
  assert.match(consoleJs, /terminalTaskStates/);
  assert.match(consoleJs, /task\.status==="blocked"\|\|task\.status==="paused"\|\|terminalTaskStates\.has\(task\.status\)/);
  assert.ok(consoleJs.indexOf('task.status==="blocked"')<consoleJs.indexOf("/apply|patch|edit|mutat/"));
  assert.match(consoleJs, /task\.leaseOwner/);
  assert.match(consoleJs, /matchingApprovals/);
  assert.match(consoleJs, /item\?\.arguments\?\.taskId===task\.id/);
  assert.match(consoleJs, /ownerMemoryClient\.cancelTask/);
  assert.match(consoleJs, /ownerMemoryClient\.decideApproval/);
  assert.match(consoleJs, /liveActivityStorageKey/);
  assert.match(consoleJs, /taskErrorLabels\[task\.errorCode\]/);
  assert.doesNotMatch(consoleJs, /live-activity[\s\S]{0,500}JSON\.stringify\(task/);
  assert.doesNotMatch(consoleJs, /textContent\s*=\s*task\.(?:metadata|leaseToken|fingerprint)/);
  assert.match(css, /\.live-activity-card/);
  assert.match(css, /\.live-activity-pulse/);
  assert.match(css, /prefers-reduced-motion:reduce[^}]*\.live-activity-pulse/);
});
