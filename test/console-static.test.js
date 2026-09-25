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
  assert.match(consoleJs, /showLiveActivityError\(record,cause\.message\);await refreshLiveActivity\(record\)\.catch\(\(\)=>\{\}\)/);
  assert.match(consoleJs, /liveActivityStorageKey/);
  assert.match(consoleJs, /taskErrorLabels\[task\.errorCode\]/);
  assert.doesNotMatch(consoleJs, /live-activity[\s\S]{0,500}JSON\.stringify\(task/);
  assert.doesNotMatch(consoleJs, /textContent\s*=\s*task\.(?:metadata|leaseToken|fingerprint)/);
  assert.match(css, /\.live-activity-card/);
  assert.match(css, /\.live-activity-pulse/);
  assert.match(css, /prefers-reduced-motion:reduce[^}]*\.live-activity-pulse/);
});

async function liveActivitySource() {
  const source = await readFile('assets/console.js', 'utf8');
  const terminalLine = source.split(/\r?\n/).find((line) => line.startsWith('const terminalTaskStates='));
  const elapsedLine = source.split(/\r?\n/).find((line) => line.startsWith('function elapsedLabel('));
  assert.ok(terminalLine); assert.ok(elapsedLine);
  return {
    source,
    terminalStates: new Set(JSON.parse(terminalLine.match(/new Set\((\[[^;]+\])\)/)[1])),
    elapsedLabel: Function(`${elapsedLine};return elapsedLabel;`)(),
  };
}

test('Live Activity elapsed time advances only for nonterminal tasks', async () => {
  const { elapsedLabel } = await liveActivitySource(), originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-09-25T12:00:01.000Z');
    const first = elapsedLabel('2026-09-25T12:00:00.000Z', null, true);
    Date.now = () => Date.parse('2026-09-25T12:00:05.000Z');
    const second = elapsedLabel('2026-09-25T12:00:00.000Z', null, true);
    assert.equal(first, '1s'); assert.equal(second, '5s'); assert.notEqual(first, second);
  } finally { Date.now = originalNow; }
});

test('every authoritative terminal state freezes elapsed time across restoration', async () => {
  const { source, terminalStates, elapsedLabel } = await liveActivitySource(), expected = ['completed','failed','cancelled','expired','blocked'];
  assert.deepEqual([...terminalStates], expected);
  const startedAt = '2026-09-25T12:00:00.000Z', endedAt = '2026-09-25T12:01:07.000Z', frozen = elapsedLabel(startedAt, endedAt, false), originalNow = Date.now;
  try {
    Date.now = () => Date.parse('2026-09-25T13:00:00.000Z'); assert.equal(elapsedLabel(startedAt, endedAt, false), frozen);
    Date.now = () => Date.parse('2026-09-26T13:00:00.000Z'); assert.equal(elapsedLabel(startedAt, endedAt, false), frozen);
  } finally { Date.now = originalNow; }
  assert.equal(frozen, '1m 7s');
  assert.equal(elapsedLabel(startedAt, null, false), '');
  assert.match(source, /endedAt=terminal\?\(task\.completedAt\|\|task\.updatedAt\|\|record\.completedAt\|\|null\):null/);
  assert.match(source, /elapsedLabel\(record\.startedAt,endedAt,!terminal\)/);
});

test('terminal cards remain visible without Stop and stop polling while nonterminal cancellation rules remain intact', async () => {
  const { source, terminalStates } = await liveActivitySource();
  assert.equal(terminalStates.has('blocked'), true);
  assert.match(source, /const cancellable=!terminal&&!task\.leaseOwner&&!task\.leaseToken&&!\["running","waiting_for_approval"\]\.includes\(task\.status\)/);
  assert.match(source, /if\(!terminal\)\{const stop=document\.createElement\("button"\)/);
  assert.match(source, /if\(!terminalTaskStates\.has\(task\.status\)\)record\.timer=setTimeout/);
  assert.match(source, /card\.replaceChildren\(\)/);
  assert.match(source, /liveActivityRecords\.has\(stored\.taskId\)/);
});
