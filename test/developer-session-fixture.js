export const MICROPHONE_ALLOWED_PATHS = Object.freeze([
  "assets/console.css",
  "assets/console.js",
  "assets/voice-input.js",
  "index.html",
  "test/composer-dictation.test.js",
  "test/composer-voice-console.integration.test.js",
  "test/console-static.test.js",
  "test/voice-input.test.js",
]);

export const MICROPHONE_ACCEPTANCE = Object.freeze([
  "microphone control works",
  "Arabic speech can become Arabic text",
  "English speech can become English text",
  "mixed Arabic and English remains natural",
  "transcript remains editable",
  "no automatic send",
  "draft is preserved on failure",
  "recording, processing, complete, and error states are represented",
  "amplitude and waveform behavior works",
  "existing unrelated console functionality is preserved",
]);

export function microphoneDeveloperRequest(overrides = {}) {
  return {
    taskId: "selfdev_1a8f17abea3f043813fc4b5fc5db0e36",
    goal: "Repair Nova composer microphone and dictation behavior while preserving existing console functionality.",
    acceptanceCriteria: [...MICROPHONE_ACCEPTANCE],
    repository: {
      slug: "hshanbour/nova-brain",
      branch: "feat/nova-brain-mvp-foundation",
      workspace: "C:/bounded/nova-brain-microphone-task",
    },
    baseSha: "911c1bc472e6017fac65146dd14298966a11c26f",
    allowedPaths: [...MICROPHONE_ALLOWED_PATHS],
    forbiddenPaths: ["package.json", "package-lock.json"],
    approvalPolicy: { requireFor: ["scope_change", "push", "deploy"], allowPush: false, allowDeploy: false },
    metadata: { fixture: "microphone", realTaskMutationAuthorized: false },
    dryRun: true,
    ...overrides,
  };
}

export function persistentTestStore() {
  const records = new Map();
  return {
    async save(record) { records.set(record.id, structuredClone(record)); },
    async get(id) { const record = records.get(id); return record ? structuredClone(record) : null; },
  };
}
