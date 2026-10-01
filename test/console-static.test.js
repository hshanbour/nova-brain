import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('console uses the canonical composer voice contract', async () => {
  const [consoleJs, voice, html, css, approvalPresenter] = await Promise.all([
    'assets/console.js',
    'assets/voice-input.js',
    'index.html',
    'assets/console.css',
    'assets/approval-presenter.js'
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
  assert.match(consoleJs, /isDurableTaskId\(durableTask\?\.id\)/);
  assert.match(consoleJs, /isDurableTaskId\(item\?\.taskId\)/);
  assert.match(consoleJs, /const liveActivity=result\.durableTask\?\.id\?ensureLiveActivity\(result\.durableTask\):null/);
  assert.match(consoleJs, /if\(!liveActivity\)\{const assistant=addMessage/);
  assert.match(consoleJs, /renderSafeMarkdown\(body,text\)/);
  assert.match(consoleJs, /createConversationBindingState/);
  assert.match(consoleJs, /conversationBinding\.queue\(id\)/);
  assert.match(consoleJs, /conversationBinding\.finish\(client\.conversationId\)/);
  assert.match(consoleJs, /renderConversationMessages\(restored\.id,restored\.messages\)/);
  assert.match(consoleJs, /conversationBinding\.canSend\(client\.conversationId\)/);
  assert.match(consoleJs, /submittedBinding=conversationBinding\.capture\(\)/);
  assert.match(consoleJs, /conversationBinding\.adopt\(submittedBinding,submittedConversationId,result\.conversationId\)/);
  assert.match(consoleJs, /input\.disabled = value \|\| conversationBinding\.pending/);
  assert.match(consoleJs, /if \(conversationBinding\.pending\) return/);
  assert.match(consoleJs, /artifact_delivery_execute:"Ship approved artifact"/);
  assert.match(consoleJs, /renderConversationMessages\(id,storedMessages\)/);
  assert.match(consoleJs, /restoreLiveActivities\(storedMessages\)/);
  assert.match(consoleJs, /restoreSynchronousApprovals\(conversationId\)/);
  assert.match(consoleJs, /ownerMemoryClient\.approvals\(\{status:"pending",conversationId,limit:100\}\)/);
  assert.match(consoleJs, /data-approval-id|dataset\.approvalId/);
  assert.match(consoleJs, /if\(result\.approval\)await approvalPresenter\.upsert/);
  assert.match(consoleJs, /client\.conversationId!==conversationId\|\|conversationBinding\.displayedId!==conversationId/);
  assert.match(consoleJs, /button\.textContent=decision==="approved"\?"Approve":"Reject"/);
  assert.doesNotMatch(approvalPresenter, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(approvalPresenter, /\["From".*\["To".*\["CC".*\["BCC".*\["Subject".*\["Body"/s);
  assert.match(approvalPresenter, /SECRET_KEY/);
  assert.match(consoleJs, /id:stored\.id,role:stored\.role,text:stored\.content,sequence:stored\.sequence,createdAt:stored\.createdAt/);
  assert.match(consoleJs, /if\(id\)\{const existing=.*data-message-id/s);
  assert.match(consoleJs, /addMessage\(\{id:report\.id,role:report\.role,text:report\.content,sequence:report\.sequence,createdAt:report\.createdAt\}\)/);
  assert.match(consoleJs, /await reconcileConversation\(failedConversationId\)/);
  assert.match(consoleJs, /id:result\.id,role: "assistant"/);
  assert.match(consoleJs, /optimisticUser\.dataset\.messageId=result\.userMessageId/);
  assert.match(consoleJs, /durableTaskRecordsFromMessages\(storedMessages,client\.conversationId\)/);
  assert.match(consoleJs, /liveActivityRecords\.has\(stored\.taskId\)/);
  assert.match(consoleJs, /ensureLiveActivity/);
  assert.match(consoleJs, /refreshLiveActivity/);
  assert.match(consoleJs, /task\.stateVersion/);
  assert.match(consoleJs, /task\.taskType==="coding_orchestration"&&\/\^coding_/);
  assert.match(consoleJs, /record\.taskId=delegatedId/);
  assert.match(consoleJs, /Preparing integration/);
  assert.match(consoleJs, /Codex inspecting repository/);
  assert.match(consoleJs, /Running tests/);
  assert.match(consoleJs, /Creating local commit/);
  assert.match(consoleJs, /Retry awaiting approval/);
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
  assert.match(css, /\.synchronous-approval-card/);
  assert.match(css, /\.live-activity-pulse/);
  assert.match(css, /prefers-reduced-motion:reduce[^}]*\.live-activity-pulse/);
  assert.match(css, /\.message-markdown h1/);
  assert.match(css, /\.markdown-table-wrap\{[^}]*overflow-x:auto/);
  assert.match(css, /\.message-markdown \[dir="auto"\]/);
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
  assert.match(source, /endedAt=terminal\?\(task\.completedAt\|\|task\.updatedAt\|\|record\.completedAt\|\|null\):truth&&!active\?/);
  assert.match(source, /elapsedLabel\(truth\?\.activeElapsedStartedAt\|\|record\.startedAt,endedAt,active\)/);
  assert.match(source, /pulse\.hidden=!active/);
});

test('terminal cards remain visible without Stop and stop polling while nonterminal cancellation rules remain intact', async () => {
  const { source, terminalStates } = await liveActivitySource();
  assert.equal(terminalStates.has('blocked'), true);
  assert.match(source, /const cancellable=!terminal&&!task\.leaseOwner&&!task\.leaseToken&&!\["running","waiting_for_approval"\]\.includes\(task\.status\)/);
  assert.match(source, /if\(!terminal\)\{const stop=document\.createElement\("button"\)/);
  assert.match(source, /if\(!terminalTaskStates\.has\(task\.status\)\)record\.timer=setTimeout/);
  assert.match(source, /else void syncTerminalTaskReport\(record,task\)/);
  assert.match(source, /terminalTaskReportFromMessages\(result\.messages\|\|\[\],task\)/);
  assert.match(source, /card\.replaceChildren\(\)/);
  assert.match(source, /liveActivityRecords\.has\(stored\.taskId\)/);
});
