import { buildDeveloperWorkspaceHandoffBundle } from "../src/autonomy/developer-workspace-handoff.js";
import { createWindowsCredentialStore, LOCAL_WORKER_CREDENTIALS } from "../src/autonomy/local-worker-credentials.js";

const ADMIN_TARGET = "NOVA_WORKER_ADMIN_TOKEN";
const value = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const previewUrl = value("--preview-url");
if (!previewUrl || !/^https:\/\/[^/]+\.vercel\.app$/i.test(previewUrl)) {
  throw new Error("A bounded Vercel Preview URL is required.");
}
const store = createWindowsCredentialStore();
let adminToken;
let bypassToken;
try {
  [adminToken, bypassToken] = await Promise.all([
    store.get(ADMIN_TARGET),
    store.get(LOCAL_WORKER_CREDENTIALS.vercel),
  ]);
  const bundle = await buildDeveloperWorkspaceHandoffBundle();
  const response = await fetch(`${previewUrl.replace(/\/$/, "")}/api/admin/developer-sessions/real/microphone/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
      "x-vercel-protection-bypass": bypassToken,
    },
    body: JSON.stringify(bundle),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.code || "developer_workspace_handoff_failed"), { code: result.code || "developer_workspace_handoff_failed", status: response.status });
  process.stdout.write(`${JSON.stringify({ sessionId: result.session?.id, providerSessionId: result.session?.providerSessionId, status: result.session?.status, manifestHash: bundle.manifest.manifestHash })}\n`);
} finally {
  adminToken = null;
  bypassToken = null;
}
