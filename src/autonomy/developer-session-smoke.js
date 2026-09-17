import { createDeveloperSessionAdapter } from "./developer-session-adapter.js";
import { createAgentsApiDeveloperProvider } from "../providers/developer-session-providers.js";

export const DEVELOPER_SMOKE_BRANCH = "stage13/control-plane-approved-delivery-runtime";
export const DEVELOPER_SMOKE_TASK_ID = "nova-developer-session-live-smoke";
export const DEVELOPER_SMOKE_BASE_SHA = "911c1bc472e6017fac65146dd14298966a11c26f";
export const DEVELOPER_SMOKE_ALLOWED_PATHS = Object.freeze([
  "assets/console.css",
  "assets/console.js",
  "assets/voice-input.js",
  "index.html",
  "test/composer-dictation.test.js",
  "test/console-static.test.js",
  "test/voice-input.test.js",
  "test/composer-voice-console.integration.test.js",
]);
export const DEVELOPER_SMOKE_FORBIDDEN_PATHS = Object.freeze([
  ".git",
  "package.json",
  "package-lock.json",
  "src",
]);

export class DeveloperSessionSmokeError extends Error {
  constructor(code, message, statusCode = 409) {
    super(message);
    this.name = "DeveloperSessionSmokeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function exactObject(value, allowed, name) {
  const input = value ?? {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new DeveloperSessionSmokeError("developer_smoke_invalid", `${name} must be an object.`, 400);
  }
  const unsupported = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unsupported.length) {
    throw new DeveloperSessionSmokeError("developer_smoke_scope_forbidden", `Unsupported ${name} field: ${unsupported[0]}.`, 403);
  }
  return input;
}

function assertPreview(environment) {
  if (environment.VERCEL_ENV !== "preview" || environment.VERCEL_GIT_COMMIT_REF !== DEVELOPER_SMOKE_BRANCH) {
    throw new DeveloperSessionSmokeError("developer_smoke_preview_only", "Developer session smoke invocation is restricted to the approved Preview branch.", 403);
  }
}

function boundedSession(record) {
  return {
    ...record,
    mutationPerformed: Array.isArray(record.changedPaths) && record.changedPaths.length > 0,
  };
}

export function createDeveloperSessionSmoke({
  environment = process.env,
  storage,
  ownerId,
  providerFactory = createAgentsApiDeveloperProvider,
  idFactory,
  clock,
} = {}) {
  if (!storage?.saveDeveloperSession || !storage?.getDeveloperSession) {
    throw new DeveloperSessionSmokeError("developer_smoke_storage_required", "Durable developer session storage is required.", 503);
  }
  const adapter = () => {
    assertPreview(environment);
    if (!environment.OPENAI_API_KEY) {
      throw new DeveloperSessionSmokeError("developer_smoke_openai_key_missing", "OPENAI_API_KEY is not configured in the approved Preview environment.", 503);
    }
    const model = environment.NOVA_DEVELOPER_MODEL || environment.OPENAI_MODEL;
    if (!model) {
      throw new DeveloperSessionSmokeError("developer_smoke_model_missing", "An inline developer agent model is not configured.", 503);
    }
    const agentsApi = providerFactory({
      apiKey: environment.OPENAI_API_KEY,
      agent: {
        model,
        instructions: "Perform only the supplied non-mutating Nova smoke inspection. Do not modify files, call external systems, push, deploy, or widen scope.",
      },
      environment: {
        type: "openai_hosted",
        network: { access: "disabled" },
        files: [],
        packages: { npm: [], python: [], system: [] },
      },
    });
    return createDeveloperSessionAdapter({
      providers: { agents_api: agentsApi },
      defaultProvider: "agents_api",
      sessionStore: {
        get: (id) => storage.getDeveloperSession(id, ownerId),
        save: (record) => storage.saveDeveloperSession(record, ownerId),
      },
      ...(idFactory ? { idFactory } : {}),
      ...(clock ? { clock } : {}),
    });
  };
  return Object.freeze({
    async start(input) {
      exactObject(input, [], "start request");
      const session = await adapter().startDeveloperSession({
        taskId: DEVELOPER_SMOKE_TASK_ID,
        goal: "Inspect the supplied repository identity and bounded path scope. Report the context only; do not modify files.",
        acceptanceCriteria: [
          "Return the supplied repository, branch, base SHA, and allowed path count.",
          "Perform no mutation, push, deployment, network access, or external side effect.",
        ],
        repository: {
          slug: "hshanbour/nova-brain",
          branch: "feat/nova-brain-mvp-foundation",
          workspace: "server-side-non-mutating-smoke-context",
        },
        baseSha: DEVELOPER_SMOKE_BASE_SHA,
        allowedPaths: [...DEVELOPER_SMOKE_ALLOWED_PATHS],
        forbiddenPaths: [...DEVELOPER_SMOKE_FORBIDDEN_PATHS],
        approvalPolicy: { requireFor: ["any_external_action"], allowPush: false, allowDeploy: false },
        metadata: { mode: "live_non_mutating_smoke", realTaskMutationAuthorized: false },
        dryRun: true,
      });
      return boundedSession(session);
    },
    async get(sessionId) {
      return boundedSession(await adapter().getDeveloperSession({ sessionId }));
    },
    async resume(sessionId, input) {
      const value = exactObject(input, ["approvalDecision", "additionalInstruction"], "resume request");
      if (value.additionalInstruction && value.additionalInstruction !== "Continue the same non-mutating bounded smoke session.") {
        throw new DeveloperSessionSmokeError("developer_smoke_instruction_forbidden", "Only the fixed non-mutating continuation instruction is allowed.", 403);
      }
      return boundedSession(await adapter().resumeDeveloperSession({
        sessionId,
        approvalDecision: value.approvalDecision,
        additionalInstruction: value.additionalInstruction,
      }));
    },
    async cancel(sessionId, input) {
      exactObject(input, [], "cancel request");
      return boundedSession(await adapter().cancelDeveloperSession({ sessionId }));
    },
  });
}
