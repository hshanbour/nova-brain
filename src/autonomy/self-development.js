import { createHash, randomUUID } from "node:crypto";
import {createActiveContinuation,assertActiveImplementationPlan,canonicalContentHash,planLifecycleMetadata,rebindEquivalentImplementationPlan} from "./self-development-plan-lifecycle.js";
import {recoverFailedLocalRead} from "./failed-local-read-recovery.js";
import {describePlanningScopeRecovery,recoverPlanningScope,PLANNING_SCOPE_RECOVERY_TOOL} from "./planning-scope-recovery.js";
import {describeExecutionScopeRecovery,recoverExecutionScope,EXECUTION_SCOPE_RECOVERY_TOOL} from "./execution-scope-recovery.js";
import {describeFullTestScopeRecovery,recoverFullTestScope,FULL_TEST_SCOPE_RECOVERY_TOOL,describeFailedFullTestRetry,recoverFailedFullTestRetry,FAILED_FULL_TEST_RETRY_TOOL} from "./full-test-scope-recovery.js";
import {describeReviewRemediation,recoverReviewRemediation,REVIEW_REMEDIATION_TOOL,describeRejectedReviewPlanContinuation,recoverRejectedReviewPlanContinuation,REJECTED_REVIEW_PLAN_CONTINUATION_TOOL,describeSourceBoundReviewReplan,recoverSourceBoundReviewReplan,SOURCE_BOUND_REVIEW_REPLAN_TOOL} from "./review-remediation-scope.js";
import {recoveryHash} from "./failed-local-read-recovery.js";
import {describeEvidenceBoundReviewReplan,recoverEvidenceBoundReviewReplan,EVIDENCE_BOUND_REVIEW_REPLAN_TOOL,describeImplementationContentReviewReplan,recoverImplementationContentReviewReplan,IMPLEMENTATION_CONTENT_REVIEW_REPLAN_TOOL,describeSourceLiteralReviewReplan,recoverSourceLiteralReviewReplan,SOURCE_LITERAL_REVIEW_REPLAN_TOOL,describeObservableLinkageReviewReplan,recoverObservableLinkageReviewReplan,OBSERVABLE_LINKAGE_REVIEW_REPLAN_TOOL,describeSemanticEvidenceReviewReplan,recoverSemanticEvidenceReviewReplan,SEMANTIC_EVIDENCE_REVIEW_REPLAN_TOOL,describeFailedSemanticReadRecovery,recoverFailedSemanticReadRecovery,FAILED_SEMANTIC_READ_RECOVERY_TOOL,describeTestIdentityInventoryReviewReplan,recoverTestIdentityInventoryReviewReplan,TEST_IDENTITY_INVENTORY_REPLAN_TOOL} from "./review-remediation-scope.js";
import {deterministicScopeAuthority,focusedTestRelationshipEvidence,sourceOwnershipEvidence} from "./focused-test-evidence-relevance.js";
import {MAX_AUTHORIZED_NEW_SOURCE_PATHS,deriveSourceCreationAuthorities,safeNewSourcePath,verifySourceCreationRecord} from "./source-creation-authority.js";

const REPOSITORY = "hshanbour/nova-brain",
  BRANCH = "feat/nova-brain-mvp-foundation",
  CONTROL_PLANE_BRANCH = "stage13/control-plane-approved-delivery-runtime",
  FULL_TEST_EVIDENCE_EXPANSION_FIX_SHA = "2c7181426cd614597a8d4806f5e06181032a4e0f",
  SHA = /^[a-f0-9]{40}$/,
  REVIEW_HASH = /^[a-f0-9]{64}$/,
  DELIVERY_ATTESTATION_SHA = "58ab99b426fed92d8e36e8493718b4fc62935d08";
const PROTECTED =
  /(^|\/)(src\/(policy|storage|autonomy)|\.github|vercel\.json|api\/index\.js)(\/|$)|approval|credential|secret|production|worker-runtime/i;
const SECRET = /token|secret|password|authorization|api.?key|private.?key/i;
const CAPABILITIES = Object.freeze([
  "repo_read_remote",
  "reasoning",
  "repo_mutate_local",
  "test_local",
  "github_write",
  "vercel_preview",
  "scheduler",
]);
const DURABLE_INTAKE_MAX_LENGTH = 4_000;
const DURABLE_INTAKE_ACTION =
  /\b(add|build|change|create|develop|edit|finish|fix|implement|improve|modify|refactor|restore|run|update|verify)\b/i;
const IMPLEMENTATION_GOAL = DURABLE_INTAKE_ACTION;
const persistedIntent = (request, legacyText = "") => {
  if (["implementation", "analysis_only"].includes(request?.intent))
    return request.intent;
  return IMPLEMENTATION_GOAL.test(legacyText || request?.userGoal || "")
    ? "implementation"
    : "analysis_only";
};
const DURABLE_INTAKE_TARGET =
  /\b(nova|console|frontend|backend|runtime|repository|repo|codebase|source|files?|tests?|preview|deployment)\b/i;
const CONVERSATIONAL_OR_ADVICE_REQUEST =
  /^(?:should|how|what|why|when|where|who|explain|review|analy[sz]e|compare|recommend|tell\s+me)\b/i;
const SELF_DEVELOPMENT_TASK_REFERENCE = /\bselfdev_[a-f0-9]{32}\b/gi;
const EXISTING_TASK_CONTROL_CLAUSE =
  /(?:^|[\r\n.!?])\s*(?:please\s+)?(continue|recover|resume|retry|approve|reject|clarify|answer|respond|provide|cancel|pause|stop)\b/i;
const EXPECTED_TASK_VERSION =
  /\b(?:expected\s*version|expectedVersion)\s*(?::|=|#)?\s*(\d+)\b/i;

export function isDurableSelfDevelopmentRequest(value) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message || message.length > DURABLE_INTAKE_MAX_LENGTH || CONVERSATIONAL_OR_ADVICE_REQUEST.test(message)) return false;
  return DURABLE_INTAKE_ACTION.test(message) && DURABLE_INTAKE_TARGET.test(message);
}
export function parseExistingTaskControlRequest(value) {
  const message = typeof value === "string" ? value.trim() : "";
  if (!message) return null;
  const taskIds = [...new Set(message.match(SELF_DEVELOPMENT_TASK_REFERENCE) || [])];
  const action = message.match(EXISTING_TASK_CONTROL_CLAUSE)?.[1]?.toLowerCase();
  if (!action || taskIds.length === 0) return null;
  if (taskIds.length !== 1)
    throw new SelfDevelopmentError(
      "existing_task_reference_ambiguous",
      "Existing-task control requires exactly one durable task ID.",
      400,
    );
  const versionMatch = message.match(EXPECTED_TASK_VERSION);
  const expectedVersion = versionMatch ? Number(versionMatch[1]) : null;
  if (versionMatch && !Number.isSafeInteger(expectedVersion))
    throw new SelfDevelopmentError(
      "existing_task_version_invalid",
      "Existing-task control requires a valid expectedVersion.",
      400,
    );
  const actionClass=["recover","resume","retry"].includes(action)
    ? "recovery"
    : action === "continue"
      ? "continue"
      : ["approve","reject"].includes(action)
        ? "approval"
        : ["clarify","answer","respond","provide"].includes(action)
          ? "clarification"
          : "control";
  return Object.freeze({
    route: "existing_task_control",
    taskId: taskIds[0],
    action: actionClass,
    requestedVerb: action,
    expectedVersion,
  });
}
export function validateExistingTaskControlRequest(request, task) {
  if (!request) return null;
  if (!task || task.taskType !== "self_development" || task.id !== request.taskId)
    throw new SelfDevelopmentError(
      "existing_task_not_found",
      "The referenced durable task was not found.",
      404,
    );
  if (
    request.expectedVersion !== null &&
    task.stateVersion !== request.expectedVersion
  )
    throw new SelfDevelopmentError(
      "existing_task_stale_version",
      "The referenced durable task changed before this control request.",
      409,
    );
  if (
    request.action === "recovery" &&
    !["blocked", "failed", "expired", "paused"].includes(task.status)
  )
    throw new SelfDevelopmentError(
      "existing_task_control_ineligible",
      "The referenced durable task is not at a recoverable boundary.",
      409,
    );
  if (
    request.action === "continue" &&
    ["completed", "cancelled"].includes(task.status)
  )
    throw new SelfDevelopmentError(
      "existing_task_control_ineligible",
      "The referenced durable task is already terminal.",
      409,
    );
  if (request.action === "approval" && task.status !== "waiting_for_approval")
    throw new SelfDevelopmentError(
      "existing_task_control_ineligible",
      "The referenced durable task is not waiting for approval.",
      409,
    );
  if (request.action === "clarification" && task.status !== "blocked")
    throw new SelfDevelopmentError(
      "existing_task_control_ineligible",
      "The referenced durable task is not waiting for clarification.",
      409,
    );
  if (
    request.action === "control" &&
    ["completed", "failed", "cancelled", "expired"].includes(task.status)
  )
    throw new SelfDevelopmentError(
      "existing_task_control_ineligible",
      "The referenced durable task is already terminal.",
      409,
    );
  return Object.freeze({
    ...request,
    task: Object.freeze({
      id: task.id,
      status: task.status,
      stateVersion: task.stateVersion,
      currentPhase: task.currentPhase || null,
      errorCode: task.errorCode || null,
    }),
  });
}
const REPLAN_PROTECTED =
  /(^|\/)(?:src\/(?:voice|policy|storage|autonomy)(?:\/|$)|speaker-worker(?:\/|$)|api\/index\.js$|\.github(?:\/|$)|assets\/(?:voice-(?!input(?:\.|$))|speaker-)[^/]*(?:\/|$))|ecapa|elevenlabs|voice-control|production|credential|secret|token/i;
const DISCOVERY_STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "another", "before", "current",
  "existing", "finish", "from", "have", "implementation", "implement", "into",
  "make", "modify", "must", "only", "preserve", "repair", "request", "should",
  "task", "that", "their", "there", "these", "this", "through", "using", "verify",
  "with", "without", "work", "working", "your",
]);
const DISCOVERY_TOKEN_ALIASES = Object.freeze({
  microphone: ["microphone", "mic", "voice", "audio", "speech", "input"],
  mic: ["microphone", "mic", "voice", "audio", "speech", "input"],
  waveform: ["waveform", "audio", "voice", "amplitude", "level"],
  recording: ["recording", "record", "voice", "audio", "input"],
  dictation: ["dictation", "speech", "voice", "input"],
  console: ["console", "composer", "frontend", "ui"],
  composer: ["composer", "console", "input", "frontend", "ui"],
  frontend: ["frontend", "console", "ui"],
});
const DISCOVERY_DOCUMENTATION_TERMS = new Set([
  "doc", "docs", "documentation", "markdown", "readme",
]);
const DISCOVERY_QUERY_STOP_WORDS = new Set([
  ...DISCOVERY_STOP_WORDS,
  "control", "focused", "regression", "technology",
]);
const DISCOVERY_MAX_QUERIES = 8;
const DISCOVERY_RESULTS_PER_QUERY = 24;
const DISCOVERY_MAX_ALTERNATIVES_PER_QUERY = 10;
const DISCOVERY_MAX_TARGETED_TEST_QUERIES = 4;
const DISCOVERY_TARGETED_TEST_RESULTS_PER_QUERY = 12;
const DISCOVERY_MAX_QUERY_LENGTH = 180;
const STRUCTURED_SCOPE_RECOVERY_MAX_ATTEMPTS = 1;
const STRUCTURED_SCOPE_RECOVERY_RUNTIME_MINUTES = 15;
const STRUCTURED_SCOPE_RECOVERY_CLASS = "structured_scope_rediscovery";
const CONSTRAINT_ENFORCEMENTS = new Set(["scope_selection","preservation_assessment","omit_git_push","omit_preview_deploy","existing_delivery_approval"]);
const legacyConstraintEnforcements=type=>type==="preserve"?["preservation_assessment"]:["scope_selection"];
const constraintEnforcements=item=>item?.enforcements||legacyConstraintEnforcements(item?.type);
const hasConstraintEnforcement=(request,enforcement)=>(request?.constraints||[]).some(item=>constraintEnforcements(item).includes(enforcement));
const TASK_DIFF_DIGESTS = Object.freeze({
  git_sha1: /^[a-f0-9]{40}$/i,
  sha256: /^[a-f0-9]{64}$/i,
});
const LEGACY_TASK_DIFF_EVIDENCE = Object.freeze({
  selfdev_10721df97b8cbc63c70d4171f6f4a440: Object.freeze({
    semantic: "task_diff",
    algorithm: "git_sha1",
    digest: "a901d364098ffc719aceab431dc63ac19ddb3731",
    expectedVersion: 43,
    targetPath: "test/voice-input.test.js",
  }),
});
const HISTORICAL_DIVERGED_APPROVED_DELIVERY = Object.freeze({
  recoveryClass: "historical_diverged_approved_delivery_integration_recovery",
  taskId: "selfdev_10721df97b8cbc63c70d4171f6f4a440",
  fromStateVersion: 280,
  currentStep: 308,
  failedStepId: "309:push",
  approvalId: "fb4e62f7-9189-4151-ac11-c620e934d3aa",
  minimumFirstParentSha: "523386be918a4072e7990f559e6870f5c652498a",
  secondParentSha: "5818ce4a8b0eb13285971cfcede009c7ae0d5aad",
  mergeBaseSha: "e8fe14200c1cd2060aca9328b38036b771be6cba",
  reviewHash: "f1ed0eddac728d408160c564c0944cc506630d1de2da611e980672684c61dd10",
  allowedPaths: Object.freeze([
    "assets/voice-input.js",
    "test/composer-dictation.test.js",
    "test/voice-input.test.js",
  ]),
  repository: REPOSITORY,
  branch: BRANCH,
  runtimeMinutes: 10,
  maxContinuationSteps: 3,
});
const HISTORICAL_DELIVERY_REPOSITORY_HISTORY_KEYS = Object.freeze([
  "approvedDeliveryRecoveryHistory",
  "approvedDeliveryHandoffRecoveryHistory",
  "approvedDeliveryRuntimeRecoveryHistory",
  "approvedDeliveryHandoffRuntimeRecoveryHistory",
]);
const HISTORICAL_V288_APPROVAL_CONTRACT_DELIVERY = Object.freeze({
  recoveryClass: "historical_v288_approval_contract_delivery_runtime_recovery",
  taskId: "selfdev_10721df97b8cbc63c70d4171f6f4a440",
  fromStateVersion: 288,
  currentStep: 310,
  approvalId: "b624260c-4cf2-4d4a-8e52-bf0efdede8dc",
  commitSha: "911c1bc472e6017fac65146dd14298966a11c26f",
  firstParentSha: "c60e7dd036b8faa6ff655ec8eb0b702a7f671d20",
  secondParentSha: "5818ce4a8b0eb13285971cfcede009c7ae0d5aad",
  repository: REPOSITORY,
  branch: BRANCH,
  runtimeMinutes: 5,
  maxAdditionalDeliverySteps: 1,
});
export class SelfDevelopmentError extends Error {
  constructor(code, message, statusCode = 409, safeDiagnostics) {
    super(message);
    this.name = "SelfDevelopmentError";
    this.code = code;
    this.statusCode = statusCode;
    if (safeDiagnostics) this.safeDiagnostics = safeDiagnostics;
  }
}
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const TERMINAL_RETRY_CONTRACT_VERSION = "self-development-terminal-retry-v1",
  TERMINAL_RETRY_STATUSES = new Set(["failed", "cancelled"]),
  MAX_TERMINAL_RETRY_DEPTH = 32;
const isTerminalRetryPredecessor = (task) => {
  if (TERMINAL_RETRY_STATUSES.has(task?.status)) return true;
  if (
    task?.status !== "blocked" ||
    task.errorCode !== "structured_scope_recovery_exhausted" ||
    !task.completedAt ||
    task.leaseOwner ||
    task.leaseToken
  )
    return false;
  const history = task.metadata?.structuredScopeRecoveryHistory;
  const latest = Array.isArray(history) ? history.at(-1) : null;
  return (
    latest?.status === "exhausted" &&
    Number(latest.attempt) === Number(latest.maxAttempts)
  );
};
const terminalSuccessorIdentity = (rootRequestFingerprint, predecessor) => {
  const successorFingerprint = hash({
    version: TERMINAL_RETRY_CONTRACT_VERSION,
    rootRequestFingerprint,
    predecessorTaskId: predecessor.id,
    predecessorTerminalStateVersion: predecessor.stateVersion,
  });
  return Object.freeze({
    taskId: `selfdev_${successorFingerprint.slice(0, 32)}`,
    metadata: Object.freeze({
      rootRequestFingerprint,
      supersedesTaskId: predecessor.id,
      retryContractVersion: TERMINAL_RETRY_CONTRACT_VERSION,
      predecessorTerminal: Object.freeze({
        status: predecessor.status,
        stateVersion: predecessor.stateVersion,
        completedAt: predecessor.completedAt || null,
        errorCode: predecessor.errorCode || null,
      }),
    }),
  });
};
const gitBlobHash = (value) => {
  const content=Buffer.from(String(value??""),"utf8");
  return createHash("sha1").update(Buffer.from(`blob ${content.length}\0`)).update(content).digest("hex");
};
const clean = (value) => {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET.test(key) ? "[REDACTED]" : clean(item),
      ]),
    );
  return value;
};
const boundedText = (value, name, max = 2000) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new SelfDevelopmentError(
      "invalid_input",
      `${name} is required.`,
      400,
    );
  return value.trim();
};
const safePath = (value) => {
  const path = boundedText(value, "scope path", 240).replaceAll("\\", "/");
  if (path.startsWith("/") || path.includes("..") || SECRET.test(path))
    throw new SelfDevelopmentError(
      "invalid_scope",
      "Self-development scope contains a protected or invalid path.",
      400,
    );
  return path;
};
const rawDiscoveryTokens = (value) =>
  String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
const discoveryGoalText = (value) => {
  const kept = [];
  let preservationBlock = false;
  for (const rawLine of String(value || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^preserve(?:\s+all\b[^:]*)?:?$/i.test(line) || /^do not regress:?$/i.test(line)) {
      preservationBlock = true;
      continue;
    }
    if (preservationBlock && /^[A-Z][A-Z\s/_-]{2,}:?$/.test(line)) preservationBlock = false;
    if (preservationBlock || /^(?:do not|don't|must not|no unrelated)\b/i.test(line)) continue;
    kept.push(rawLine);
  }
  return kept.join("\n");
};
const discoveryTokens = (value) => {
  const tokens = rawDiscoveryTokens(value), expanded = new Set();
  for (const token of tokens) {
    if (token.length < 3 || DISCOVERY_STOP_WORDS.has(token)) continue;
    expanded.add(token);
    for (const alias of DISCOVERY_TOKEN_ALIASES[token] || []) expanded.add(alias);
  }
  return expanded;
};
const regexEscape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const discoverySearches = (request) => {
  const phrases = (request.scope.searchTerms || [])
    .filter((term) => typeof term === "string" && term.trim())
    .slice(0, DISCOVERY_MAX_QUERIES)
    .map((term) => term.trim());
  const concepts = phrases.length ? phrases : [request.userGoal || ""], searches = [], seenQueries = new Set();
  for (const concept of concepts) {
    const selected = [], seen = new Set();
    let length = 0;
    const add = (alternative) => {
      const escaped = regexEscape(alternative.toLowerCase());
      if (!escaped || seen.has(escaped) || selected.length >= DISCOVERY_MAX_ALTERNATIVES_PER_QUERY || length + escaped.length + (selected.length ? 1 : 0) > DISCOVERY_MAX_QUERY_LENGTH) return;
      selected.push(escaped);
      seen.add(escaped);
      length += escaped.length + (selected.length > 1 ? 1 : 0);
    };
    add(concept.trim());
    for (const token of rawDiscoveryTokens(concept)) {
      if (token.length < 4 || DISCOVERY_QUERY_STOP_WORDS.has(token)) continue;
      add(token);
      for (const alias of DISCOVERY_TOKEN_ALIASES[token] || []) add(alias);
    }
    const query = selected.join("|");
    if (!query || seenQueries.has(query)) continue;
    seenQueries.add(query);
    searches.push({ query, mode: "regex" });
  }
  if (searches.length) return searches;
  return [{ query: regexEscape(request.userGoal || "").slice(0, DISCOVERY_MAX_QUERY_LENGTH), mode: "literal" }];
};
const discoveryPath = (value) => {
  const path = typeof value === "string" ? value : value?.path;
  if (typeof path !== "string") return null;
  const normalized = path.replaceAll("\\", "/");
  const repositoryRelative = /^[a-z0-9._/-]+$/i.test(normalized) && !normalized.startsWith("/") && !normalized.includes("..");
  const fileLike = normalized.includes("/") || /^[a-z0-9][a-z0-9._-]*\.[a-z0-9]+$/i.test(normalized);
  return repositoryRelative && fileLike && !SECRET.test(normalized) ? normalized : null;
};
export const isExactMissingBranchSchemaDiagnostic = (diagnostic, {stepType, templateTool}={}) =>
  (diagnostic?.tool === "repo_apply_patch" ||
    (!diagnostic?.tool && stepType === "apply_patch" && templateTool === "repo_apply_patch")) &&
  diagnostic?.fieldPath === "repo_apply_patch.branch" &&
  diagnostic?.validationCode === "required_field_missing" &&
  (diagnostic?.received === "missing" || diagnostic?.received?.type === "missing") &&
  (diagnostic?.expected === "required" || diagnostic?.expected?.type === "required");
const taskDiffEvidence = (task, targetPath, expectedVersion) => {
  const stored = task.metadata?.failedAttemptEvidence?.taskDiff;
  const evidence = stored || LEGACY_TASK_DIFF_EVIDENCE[task.id];
  if (
    !evidence ||
    evidence.semantic !== "task_diff" ||
    !TASK_DIFF_DIGESTS[evidence.algorithm]?.test(evidence.digest || "") ||
    (evidence.expectedVersion !== undefined &&
      evidence.expectedVersion !== expectedVersion) ||
    (evidence.targetPath !== undefined && evidence.targetPath !== targetPath)
  )
    throw new SelfDevelopmentError(
      "create_conflict_evidence_missing",
      "Exact durable task-diff evidence is unavailable or invalid.",
    );
  return Object.freeze({
    semantic: "task_diff",
    algorithm: evidence.algorithm,
    digest: evidence.digest.toLowerCase(),
  });
};
const annotation = (
  index,
  type,
  capability,
  input,
  expectedOutput,
  successCondition,
  { retry = "bounded", approval = false } = {},
) => ({
  type,
  input,
  capability,
  expectedOutput,
  successCondition,
  retryClassification: retry,
  approvalRequired: approval,
  idempotencyIdentity: `self-development:${index}:${hash([type, clean(input)])}`,
});

const stepOrdinal = (step) => {
  const match = /^(\d+):/.exec(String(step?.stepId || ""));
  return match ? Number(match[1]) : null;
};
const RECOVERY_SIDE_EFFECT_STEPS = new Set([
  "apply_patch", "run_focused_tests", "run_full_tests", "inspect_diff",
  "commit", "review_commit", "push", "deploy_preview",
]);
export function resolveSemanticPlanApplyState(task, steps, failureCode, {planStepTypes=["plan_implementation"]}={}) {
  const ordered = steps.map((step) => ({step, ordinal: stepOrdinal(step)}))
    .filter((entry) => entry.ordinal !== null).sort((a, b) => a.ordinal - b.ordinal);
  const failedApplies = ordered.filter(({step}) => step.stepType === "apply_patch" && step.status === "failed" && step.errorCode === failureCode);
  if (!failedApplies.length) throw new SelfDevelopmentError("semantic_recovery_state_unresolved", "The intended failed mutation attempt cannot be resolved.");
  const failedOrdinal = Math.max(...failedApplies.map((entry) => entry.ordinal));
  const failures = failedApplies.filter((entry) => entry.ordinal === failedOrdinal);
  if (failures.length !== 1) throw new SelfDevelopmentError("semantic_recovery_state_ambiguous", "The failed mutation history is ambiguous.");
  const failed = failures[0];
  const laterMutationAttempts = ordered.filter(({step, ordinal}) => ordinal > failed.ordinal && step.stepType === "apply_patch");
  const plans = ordered.filter(({step, ordinal}) => ordinal < failed.ordinal && planStepTypes.includes(step.stepType) && step.status === "completed" && step.result?.implementationPlan);
  if (!plans.length || laterMutationAttempts.length) throw new SelfDevelopmentError("semantic_recovery_state_unresolved", "A unique latest implementation plan and mutation attempt are required.");
  const plannedOrdinal = Math.max(...plans.map((entry) => entry.ordinal));
  const latestPlans = plans.filter((entry) => entry.ordinal === plannedOrdinal);
  if (latestPlans.length !== 1) throw new SelfDevelopmentError("semantic_recovery_state_ambiguous", "Multiple unsuperseded implementation plans cannot be distinguished.");
  const planned = latestPlans[0], planTemplate = task.metadata?.steps?.[planned.ordinal - 1], failedTemplate = task.metadata?.steps?.[failed.ordinal - 1];
  const mutationReported = failed.step.result?.mutationApplied === true || failed.step.result?.changed === true || (Array.isArray(failed.step.result?.changedFiles) && failed.step.result.changedFiles.length > 0);
  const completedAfterPlan = ordered.some(({step, ordinal}) => ordinal > planned.ordinal && RECOVERY_SIDE_EFFECT_STEPS.has(step.stepType) && step.status === "completed");
  if (!planStepTypes.includes(planTemplate?.type) || failedTemplate?.type !== "apply_patch" || mutationReported) throw new SelfDevelopmentError("semantic_recovery_state_unresolved", "The durable plan or no-mutation boundary cannot be proven.");
  return {failed:failed.step, failedOrdinal:failed.ordinal, planned:planned.step, plannedOrdinal:planned.ordinal, planTemplate, remaining:task.metadata.steps.slice(failed.ordinal - 1), completedAfterPlan};
}

export function createSelfDevelopmentService({
  runtime,
  storage,
  ownerId,
  approvedBranch = BRANCH,
  repository = REPOSITORY,
  currentCommit,
  runtimeVersion,
  verifyRemote,
  compareRemoteEvidence,
  verifyDeployment,
  resolvePathState,
  structuredIntake,
  clock = () => new Date(),
} = {}) {
  if (!runtime || !storage || !ownerId)
    throw new Error("Self-development dependencies are required.");
  function structure(input, { canonicalIntent, canonicalConstraintBindings = false } = {}) {
    const userGoal = boundedText(
        input?.userGoal || input?.goal,
        "user_goal",
        DURABLE_INTAKE_MAX_LENGTH,
      ),
      targetBranch = input?.targetBranch || approvedBranch,
      targetRepository = input?.repository || repository,
      environment = input?.environment || "preview";
    if (
      targetBranch !== approvedBranch ||
      ["main", "master"].includes(targetBranch)
    )
      throw new SelfDevelopmentError(
        "branch_not_allowed",
        "Only the approved feature branch is allowed.",
        403,
      );
    if (targetRepository !== repository)
      throw new SelfDevelopmentError(
        "repository_not_resolved",
        "The requested repository could not be resolved to Nova Brain.",
        400,
      );
    if (environment !== "preview")
      throw new SelfDevelopmentError(
        "production_target_forbidden",
        "Self-development V1 is Preview-only.",
        403,
      );
    const startingCommit = input?.startingCommit || currentCommit;
    if (!SHA.test(startingCommit || ""))
      throw new SelfDevelopmentError(
        "invalid_input",
        "An exact deployed starting commit could not be resolved.",
        400,
      );
    const projectValue = String(input?.targetProject || "nova-brain")
        .trim()
        .toLowerCase(),
      knownProjects = new Set([
        "nova-brain",
        "nova brain",
        "hshanbour/nova-brain",
        "nova-test-project",
      ]);
    if (!knownProjects.has(projectValue))
      throw new SelfDevelopmentError(
        "project_not_found",
        "The requested project could not be resolved to Nova Brain.",
        400,
      );
    const targetProject = "nova-brain";
    const rawScope = input.scope || {};
    if (
      !rawScope ||
      typeof rawScope !== "object" ||
      Array.isArray(rawScope) ||
      !Array.isArray(rawScope.paths || []) ||
      !Array.isArray(rawScope.searchTerms || []) ||
      !Array.isArray(rawScope.focusedTests || []) ||
      !Array.isArray(rawScope.patch?.files || [])
    )
      throw new SelfDevelopmentError(
        "invalid_scope",
        "Self-development scope must use bounded path, search, patch-file, and focused-test arrays.",
        400,
      );
    const paths = (rawScope.paths || []).map(safePath),
      patchFiles = (rawScope.patch?.files || []).map((file) => {
        if (!file || typeof file !== "object" || Array.isArray(file))
          throw new SelfDevelopmentError(
            "invalid_scope",
            "Each patch file must contain a bounded path and content.",
            400,
          );
        return {
          path: safePath(file.path),
          content: boundedText(file.content, "patch content", 50000),
        };
      });
    if (paths.length > 30 || patchFiles.length > 20)
      throw new SelfDevelopmentError(
        "scope_too_large",
        "Self-development scope is too large.",
        400,
      );
    const focusedTests = (rawScope.focusedTests || []).map(safePath);
    if (focusedTests.length > 30)
      throw new SelfDevelopmentError(
        "scope_too_large",
        "Focused test scope is too large.",
        400,
      );
    if (
      input.acceptanceCriteria !== undefined &&
      !Array.isArray(input.acceptanceCriteria)
    )
      throw new SelfDevelopmentError(
        "invalid_input",
        "Acceptance criteria must be an array.",
        400,
      );
    const acceptanceCriteria = (
      input.acceptanceCriteria?.length
        ? input.acceptanceCriteria
        : [
            "Inspect and produce a bounded implementation plan for the requested improvement.",
            "Preserve main, Production, approval, and Preview safety boundaries.",
            "Run relevant focused and full tests before any reviewed commit.",
          ]
    ).map((item) => boundedText(item, "acceptance criterion", 500));
    if (acceptanceCriteria.length > 30)
      throw new SelfDevelopmentError(
        "invalid_input",
        "Too many acceptance criteria were supplied.",
        400,
      );
    if (input.constraints !== undefined && !Array.isArray(input.constraints))
      throw new SelfDevelopmentError("invalid_input", "Structured constraints must be an array.", 400);
    const constraints=(input.constraints||[]).map(item=>{
      if(!item||typeof item!=="object"||Array.isArray(item)||!["preserve","exclude","boundary"].includes(item.type))throw new SelfDevelopmentError("invalid_input","Each structured constraint must have a supported type and requirement.",400);
      const enforcements=canonicalConstraintBindings?item.enforcements:legacyConstraintEnforcements(item.type);
      if(!Array.isArray(enforcements)||!enforcements.length||enforcements.length>2||new Set(enforcements).size!==enforcements.length||enforcements.some(value=>!CONSTRAINT_ENFORCEMENTS.has(value))||item.type==="preserve"&&(enforcements.length!==1||enforcements[0]!=="preservation_assessment")||item.type==="exclude"&&(enforcements.length!==1||enforcements[0]!=="scope_selection")||item.type==="boundary"&&enforcements.includes("omit_git_push")&&!enforcements.includes("omit_preview_deploy"))throw new SelfDevelopmentError("invalid_input","Each trusted structured constraint must have a supported enforcement binding.",400);
      const normalized={type:item.type,requirement:boundedText(item.requirement,"constraint",500)};
      return canonicalConstraintBindings?{...normalized,enforcements:[...enforcements]}:normalized;
    });
    if(constraints.length>12)throw new SelfDevelopmentError("invalid_input","Too many structured constraints were supplied.",400);
    if (
      input.maxRepairIterations !== undefined &&
      (!Number.isInteger(input.maxRepairIterations) ||
        input.maxRepairIterations < 1 ||
        input.maxRepairIterations > 3)
    )
      throw new SelfDevelopmentError(
        "invalid_repair_limit",
        "Repair limit must be an integer from 1 to 3.",
        400,
      );
    if (
      input.runtimeBudgetMinutes !== undefined &&
      (!Number.isInteger(input.runtimeBudgetMinutes) ||
        input.runtimeBudgetMinutes < 15 ||
        input.runtimeBudgetMinutes > 120)
    )
      throw new SelfDevelopmentError(
        "invalid_runtime_budget",
        "Runtime budget must be an integer from 15 to 120 minutes.",
        400,
      );
    const intake=input.intake===undefined?null:input.intake;
    if(intake!==null&&(!intake||intake.version!==1||!REVIEW_HASH.test(intake.sourceRequestHash||"")||!REVIEW_HASH.test(intake.specificationHash||"")||(intake.canonicalIntent!==undefined&&!['implementation','analysis_only'].includes(intake.canonicalIntent))))throw new SelfDevelopmentError("invalid_input","Trusted intake binding is invalid.",400);
    if(canonicalIntent!==undefined&&(!intake||!['implementation','analysis_only'].includes(canonicalIntent)||intake.canonicalIntent!==canonicalIntent))throw new SelfDevelopmentError("invalid_input","Trusted canonical intent binding is invalid.",400);
    const protectedPaths = [...paths, ...patchFiles.map((x) => x.path)].filter(
        (path) => PROTECTED.test(path),
      ),
      riskLevel = protectedPaths.length ? "high" : "medium",
      maxRepairIterations = input.maxRepairIterations ?? 3,
      runtimeBudgetMinutes = input.runtimeBudgetMinutes ?? 60;
    return Object.freeze({
      kind: "self_development_task",
      userGoal,
      targetProject,
      targetBranch,
      repository: targetRepository,
      environment,
      scope: clean({
        paths,
        inspectPath: rawScope.inspectPath ? safePath(rawScope.inspectPath) : "",
        searchTerms: (rawScope.searchTerms || [])
          .slice(0, 10)
          .map((x) => boundedText(x, "search term", 120)),
        patch: { files: patchFiles },
        focusedTests,
      }),
      acceptanceCriteria,
      constraints,
      scopeAuthority: paths.length || patchFiles.length || focusedTests.length ? "explicit" : "discovery_only",
      ...(intake?{intake:clean(intake)}:{}),
      riskLevel,
      protectedPaths,
      requiredCapabilities: CAPABILITIES,
      approvalBoundaries: {
        localSafeOperations: "policy_controlled",
        protectedArchitecture: "strong_exact_approval",
        gitPush: "exact_task_branch_sha_args",
        previewCreation: "existing_policy",
        production: "forbidden",
      },
      maxRepairIterations,
      runtimeBudgetMinutes,
      status: "structured",
      startingCommit,
      intent: canonicalIntent ?? persistedIntent(null, userGoal),
    });
  }
  const requestFingerprint = (request) => {
    if(request.intake?.sourceRequestHash)return hash({version:"chat-native-durable-intake-v1",sourceRequestHash:request.intake.sourceRequestHash,targetProject:request.targetProject,targetBranch:request.targetBranch,repository:request.repository,environment:request.environment,startingCommit:request.startingCommit,maxRepairIterations:request.maxRepairIterations,runtimeBudgetMinutes:request.runtimeBudgetMinutes,approvalBoundaries:request.approvalBoundaries});
    const identity = { ...request };
    delete identity.intent;
    return hash(identity);
  };
  const evidenceCandidates = (request) => {
    const candidates = [
      ...new Set([
        ...(request.scope.paths || []),
        ...(request.scope.focusedTests || []),
      ]),
    ];
    if (
      candidates.length < 2 ||
      candidates.length > 12 ||
      candidates.some((path) => REPLAN_PROTECTED.test(path)) ||
      !candidates.some((path) => !path.startsWith("test/")) ||
      !candidates.some((path) => path.startsWith("test/"))
    )
      return null;
    return candidates;
  };
  const resolveDiscoveryCandidates = async (request, steps) => {
    const discovered = new Set(), searched = new Set(), discoveryEvidence = new Map();
    for (const step of steps.filter((item) => item.status === "completed" && ["inspect_repo", "search_code"].includes(item.stepType))) {
      const values = step.stepType === "inspect_repo"
        ? [...(step.result?.files || []), ...(step.result?.items || [])]
        : [...(step.result?.matches || []), ...(step.result?.files || []), ...(step.result?.items || [])];
      for (const value of values) {
        const path = discoveryPath(value);
        if (path) {
          discovered.add(path);
          const current = discoveryEvidence.get(path) || { inventory: false, matches: [] };
          if (step.stepType === "search_code") {
            searched.add(path);
            const rawText = typeof value?.text === "string" ? value.text.replace(/\s+/g, " ").trim() : "", text = rawText.slice(0, 240);
            if (text && current.matches.length < 3)
              current.matches.push({
                stepId: step.stepId,
                query: String(step.input?.arguments?.query || "").slice(0, 180),
                ...(Number.isInteger(value?.line) ? { line: value.line } : {}),
                text,
                truncated: rawText.length > text.length,
              });
          } else current.inventory = true;
          discoveryEvidence.set(path, current);
        }
      }
    }
    const goalText = discoveryGoalText([request.userGoal,...(request.acceptanceCriteria||[]),...(request.scope?.searchTerms||[])].join("\n")), goal = discoveryTokens(goalText), goalCounts = new Map(), goalRaw = rawDiscoveryTokens(goalText);
    for (const token of goalRaw) {
      if (token.length >= 3 && !DISCOVERY_STOP_WORDS.has(token))
        goalCounts.set(token, Math.min(3, (goalCounts.get(token) || 0) + 1));
    }
    const documentationRequested = [...goalCounts].some(([token]) => DISCOVERY_DOCUMENTATION_TERMS.has(token));
    const ownershipFor=path=>sourceOwnershipEvidence(path,discoveryEvidence.get(path)?.matches||[],{userGoal:goalText});
    const score = (path) => {
      if (/^(?:docs?\/|readme(?:\.|$))/i.test(path) && !documentationRequested) return 0;
      const tokens = [...new Set(rawDiscoveryTokens(path).filter((token) => token.length >= 3 && !DISCOVERY_STOP_WORDS.has(token)))];
      let value = 0, semanticMatches = 0;
      for (const token of tokens) {
        const count = goalCounts.get(token) || 0;
        if (count) value += count * (token.length > 5 ? 5 : 3);
        else if (goal.has(token)) { value += 3; semanticMatches += 1; }
      }
      if (semanticMatches >= 2) value += 3;
      if (searched.has(path)) value += 6;
      const ownership=ownershipFor(path);
      if(ownership)value+=10+ownership.matchedTokens.length*2;
      return value;
    }, safe = (path) => !REPLAN_PROTECTED.test(path) && /\.(?:c?js|mjs|ts|tsx|jsx|css|html|md)$/i.test(path);
    const rankedSources = [...discovered]
      .filter((path) => !path.startsWith("test/") && safe(path) && score(path) > 0)
      .sort((a, b) => score(b) - score(a) || a.localeCompare(b));
    const strongest = rankedSources.length ? score(rankedSources[0]) : 0,
      minimumConfidence = Math.max(4, Math.ceil(strongest * 0.35)),
      sources = rankedSources.filter((path) => score(path) >= minimumConfidence).slice(0, 6);
    if (!sources.length) return null;
    // A saturated goal-level search can return only source/context matches even
    // after ownership is clear. Reserve a separate, bounded test-only retrieval
    // opportunity derived exclusively from repository-grounded source evidence.
    // These searches discover evidence; focusedTestRelationshipEvidence remains
    // the authority gate and rejects unrelated results.
    const targetedTestSearches = [], targetedTestSearchKeys = new Set();
    const addTargetedTestSearch = (query, mode) => {
      const normalized = String(query || "").trim().slice(0, DISCOVERY_MAX_QUERY_LENGTH), key = `${mode}:${normalized}`;
      if (!normalized || targetedTestSearchKeys.has(key) || targetedTestSearches.length >= DISCOVERY_MAX_TARGETED_TEST_QUERIES) return;
      targetedTestSearchKeys.add(key);
      targetedTestSearches.push({query:normalized,mode,path:"test",limit:DISCOVERY_TARGETED_TEST_RESULTS_PER_QUERY});
    };
    for (const source of sources) {
      const stem = source.split("/").at(-1).replace(/\.(?:c?js|mjs|ts|tsx|jsx|css|html|md)$/i, ""),
        stemTokens = rawDiscoveryTokens(stem).filter(token => token.length >= 3 && !DISCOVERY_QUERY_STOP_WORDS.has(token)),
        ownershipTokens = ownershipFor(source)?.matchedTokens || [];
      if (stem.length >= 3) addTargetedTestSearch(stem, "filename");
      const contentAnchors = [...new Set([...ownershipTokens, ...stemTokens])]
        .filter(token => token.length >= 4 && /^[a-z0-9_-]+$/i.test(token))
        .slice(0, DISCOVERY_MAX_ALTERNATIVES_PER_QUERY);
      if (contentAnchors.length) addTargetedTestSearch(contentAnchors.map(regexEscape).join("|"), "regex");
      if (targetedTestSearches.length >= DISCOVERY_MAX_TARGETED_TEST_QUERIES) break;
    }
    const matchesByPath=new Map([...discoveryEvidence].map(([path,value])=>[path,value.matches]));
    const sourceAssociation = (path) => focusedTestRelationshipEvidence(path, sources,{matchesByPath});
    const testScore = (path) => score(path) + sourceAssociation(path).matchedTokens.length * 2;
    const tests = [...discovered]
      // A search hit can be incidental (for example, a runtime test containing
      // a quoted product prompt). Focused tests must also be related by path to
      // at least one selected implementation source before they become
      // mutation-authoritative planner evidence.
      .filter((path) => path.startsWith("test/") && safe(path) && sourceAssociation(path).related && testScore(path) > 0)
      .sort((a, b) => testScore(b) - testScore(a) || a.localeCompare(b)).slice(0, 6);
    const inferredTestEvidence = new Map();
    if (!tests.length && typeof resolvePathState === "function") {
      const inferred = [];
      for (const source of sources) {
        const stem = source.split("/").at(-1).replace(/\.(?:c?js|mjs|ts|tsx|jsx|css|html|md)$/i, "");
        inferred.push(`test/${stem}.test.js`, `test/${stem}-static.test.js`, `test/composer-${stem}.integration.test.js`);
      }
      for (const path of [...new Set(inferred)].slice(0, 18)) {
        const state = await resolvePathState(path, request.startingCommit);
        if (state?.existsInCommit && !REPLAN_PROTECTED.test(path)) {
          tests.push(path);
          inferredTestEvidence.set(path, focusedTestRelationshipEvidence(path, sources,{matchesByPath}));
        }
        if (tests.length >= 6) break;
      }
    }
    if (!tests.length) return {candidatePaths:[...sources],candidateEvidence:sources.map(path=>{
      const evidence=discoveryEvidence.get(path)||{inventory:false,matches:[]},ownership=ownershipFor(path);
      return{path,role:"source",inventory:evidence.inventory===true,matches:evidence.matches,...(ownership?{ownership}:{})};
    }),sourceCreationAuthorities:deriveSourceCreationAuthorities([...discovered],{userGoal:request.userGoal}),targetedTestSearches};
    const candidatePaths = [...new Set([...sources, ...tests])].slice(0, 12), candidateEvidence = candidatePaths.map((path) => {
      const evidence = discoveryEvidence.get(path) || { inventory: false, matches: [] }, relationship = path.startsWith("test/") ? focusedTestRelationshipEvidence(path, sources,{matchesByPath}) : null,ownership=path.startsWith("test/")?null:ownershipFor(path);
      return {
        path,
        role: path.startsWith("test/") ? "focused_test" : "source",
        inventory: evidence.inventory === true,
        matches: evidence.matches,
        ...(ownership?{ownership}:{}),
        ...(path.startsWith("test/") ? {
          relationship: relationship?.related ? {
            sourcePath: relationship.sourcePath,
            matchedTokens: relationship.matchedTokens,
            basis: relationship.basis||(inferredTestEvidence.has(path) ? "existing_bound_commit_path_relation" : "repository_search_path_relation"),
          } : null,
        } : {}),
      };
    });
    return {candidatePaths,candidateEvidence,sourceCreationAuthorities:deriveSourceCreationAuthorities([...discovered],{userGoal:request.userGoal}),targetedTestSearches};
  };
  const structuredScopeMetadata = (resolution, extra = {}) => ({
    version: resolution.version,
    status: resolution.status,
    decisionHash: resolution.decisionHash,
    providerUsage: resolution.providerUsage || null,
    validationAttempts: resolution.validationAttempts ?? 1,
    unresolvedEvidence: (resolution.unresolvedEvidence || []).map((item) => ({
      category: item.category,
      concepts: [...item.concepts],
    })),
    unresolvedEvidenceFingerprints: (resolution.unresolvedEvidence || []).map(hash),
    constraintCoverage: resolution.constraintCoverage,
    constraintBindings: resolution.constraintBindings,
    authorizedCreatePathHashes:(resolution.sourceCreationRecords||[]).map(record=>hash(record)),
    authoritySource:resolution.authoritySource||"model_assisted_deterministic_validation",
    ...(resolution.certificateHash?{certificateHash:resolution.certificateHash}:{}),
    ...(resolution.deterministicCertificateStatus?{deterministicCertificateStatus:resolution.deterministicCertificateStatus}:{}),
    ...(resolution.deterministicCertificateReason?{deterministicCertificateReason:resolution.deterministicCertificateReason}:{}),
    ...extra,
  });
  const structuredScopeRecoveryConcepts = (resolution) => [
    ...new Set(
      (resolution.unresolvedEvidence || [])
        .flatMap((item) => item.concepts || [])
        .map((item) => String(item).trim())
        .filter((item) => item.length >= 2 && item.length <= 80 && /^[a-z0-9][a-z0-9 _-]*$/i.test(item)),
    ),
  ].slice(0, DISCOVERY_MAX_QUERIES);
  const resolveStructuredScope = async (input) => {
    let lastError;
    for (let validationAttempts = 1; validationAttempts <= 2; validationAttempts += 1) {
      try {
        return {
          ...(await structuredIntake.resolveScope(input)),
          validationAttempts,
        };
      } catch (error) {
        lastError = error;
        if (
          validationAttempts === 2 ||
          !["structured_intake_invalid", "structured_scope_invalid"].includes(error?.code)
        )
          throw Object.assign(error, {
            safeDiagnostics: {
              ...error?.safeDiagnostics,
              scopeValidationAttempts: validationAttempts,
            },
          });
      }
    }
    throw lastError;
  };
  const appendScopeRediscovery = ({ steps, base, request, concepts, targetedTestSearches = [] }) => {
    const recoveryRequest = {
      ...request,
      scope: { ...request.scope, searchTerms: concepts },
    };
    for (const [index, search] of discoverySearches(recoveryRequest).entries())
      steps.push(
        annotation(
          base + steps.length + 1,
          "search_code",
          "repo_read_remote",
          {
            tool: "repo_search",
            arguments: {
              query: search.query,
              mode: search.mode,
              path: request.scope.inspectPath || ".",
              limit: DISCOVERY_RESULTS_PER_QUERY,
            },
          },
          `Additional repository evidence for unresolved scope concept ${index + 1}`,
          "Read-only recovery evidence returned",
          { retry: "safe_read" },
        ),
      );
    for (const [index, search] of targetedTestSearches.slice(0, DISCOVERY_MAX_TARGETED_TEST_QUERIES).entries())
      steps.push(
        annotation(
          base + steps.length + 1,
          "search_code",
          "repo_read_remote",
          { tool: "repo_search", arguments: search },
          `Targeted focused-test evidence from grounded source ownership ${index + 1}`,
          "Bounded test-only repository evidence returned",
          { retry: "safe_read" },
        ),
      );
    steps.push(
      annotation(
        base + steps.length + 1,
        "plan_patch",
        "reasoning",
        {
          goal: request.userGoal,
          acceptanceCriteria: request.acceptanceCriteria,
          scope: [],
        },
        "Bounded rediscovery decision",
        "Recovery remains discovery-only",
        { retry: "new_evidence_required" },
      ),
      annotation(
        base + steps.length + 2,
        "summarize",
        "reasoning",
        { summary: "Nova self-development bounded scope rediscovery completed." },
        "Durable recovery checkpoint",
        "Scope must be resolved before implementation",
        { retry: "not_retryable" },
      ),
    );
    return steps;
  };
  const appendEvidenceBoundImplementation = ({
    steps,
    base = 0,
    taskId,
    candidates,
    branch,
    currentCommit,
    request,
    authorizedCreatePaths=request?.scope?.authorizedCreatePaths||[],
  }) => {
    const add = (...args) =>
      steps.push(annotation(base + steps.length + 1, ...args));
    for (const path of candidates)
      add(
        "read_files",
        "repo_read_remote",
        {
          tool: "repo_read",
          arguments: { path, startLine: 1, endLine: 1000 },
        },
        `Complete contents of ${path}`,
        "Evidence candidate is read before implementation planning",
        { retry: "safe_read" },
      );
    add(
      "plan_implementation",
      "reasoning",
      {
        tool: "self_development_plan_implementation",
        arguments: { taskId, candidatePaths: candidates, currentCommit, authorizedCreatePaths },
      },
      "Nova-generated structured implementation plan",
      "Plan is generated only from durable evidence",
      { retry: "new_evidence_required" },
    );
    add(
      "apply_patch",
      "repo_mutate_local",
      {
        tool: "repo_apply_patch",
        arguments: {
          branch,
          currentCommit: "$CURRENT_COMMIT",
          files: "$IMPLEMENTATION_FILES",
        },
      },
      "Bounded evidence-generated files changed",
      "Hands applies only the validated Nova plan",
      { retry: "repair_required" },
    );
    add(
      "run_focused_tests",
      "test_local",
      {
        tool: "test_run",
        arguments: { files: "$IMPLEMENTATION_TESTS", timeoutMs: 180000 },
      },
      "Focused test report",
      "All Nova-selected focused tests pass",
      { retry: "repair_required" },
    );
    add(
      "run_full_tests",
      "test_local",
      { tool: "test_run_full", arguments: { timeoutMs: 180000 } },
      "Full test report",
      "Complete suite passes",
      { retry: "repair_required" },
    );
    add(
      "inspect_diff",
      "repo_read_remote",
      { tool: "repo_diff", arguments: { paths: "$IMPLEMENTATION_PATHS" } },
      "Complete bounded diff review",
      "Diff contains only evidence-generated scope",
      { retry: "safe_read" },
    );
    add(
      "commit",
      "repo_mutate_local",
      {
        tool: "git_commit",
        arguments: {
          paths: "$IMPLEMENTATION_PATHS",
          branch,
          message: "Complete bounded Nova self-development task",
        },
      },
      "Exact local commit SHA",
      "One reviewed local commit created",
      { retry: "idempotent_commit" },
    );
    add(
      "review_commit",
      "repo_read_remote",
      {
        tool: "repo_review_commit",
        arguments: {
          commitSha: "$CURRENT_COMMIT",
          paths: "$IMPLEMENTATION_PATHS",
        },
      },
      "Exact immutable commit review",
      "Commit exactly matches the reviewed bounded change-set",
      { retry: "not_retryable" },
    );
    if(!hasConstraintEnforcement(request,"omit_git_push")) add(
      "push",
      "github_write",
      {
        tool: "git_push",
        arguments: { branch, commitSha: "$CURRENT_COMMIT" },
      },
      "Approved remote feature commit",
      "Exact push approval succeeds",
      { retry: "approval_bound", approval: true },
    );
    if(!hasConstraintEnforcement(request,"omit_preview_deploy")){
      add(
        "deploy_preview",
        "vercel_preview",
        {
          tool: "preview_deploy",
          arguments: { branch, commitSha: "$CURRENT_COMMIT" },
        },
        "Git-backed Preview deployment",
        "Preview deployment created",
        { retry: "idempotent_deploy", approval: true },
      );
      add(
        "wait",
        "scheduler",
        { delayMs: 5000 },
        "Bounded deployment wait",
        "Task reschedules without busy-looping",
        { retry: "bounded_wait" },
      );
      add(
        "verify_preview",
        "vercel_preview",
        {
          tool: "preview_verify",
          arguments: {
            deploymentId: "$DEPLOYMENT_ID",
            path: "/api/health",
            expectedStatus: 200,
            commitSha: "$CURRENT_COMMIT",
          },
        },
        "Protected Preview verification",
        "Exact SHA Preview health succeeds",
        { retry: "repair_required" },
      );
    }
  };
  function plan(request, taskId) {
    const steps = [],
      add = (...args) => steps.push(annotation(steps.length + 1, ...args)),
      root = request.scope.inspectPath || ".";
    add(
      "inspect_repo",
      "repo_read_remote",
      { tool: "repo_list", arguments: { path: root, limit: 250 } },
      "Bounded repository inventory",
      "Repository paths returned",
      { retry: "safe_read" },
    );
    const searches = discoverySearches(request);
    for (const [index, search] of searches.entries())
      add(
        "search_code",
        "repo_read_remote",
        {
          tool: "repo_search",
          arguments: {
            query: search.query,
            mode: search.mode,
            path: root,
            limit: DISCOVERY_RESULTS_PER_QUERY,
          },
        },
        `Relevant implementation matches for discovery concept ${index + 1}`,
        "Search evidence returned",
        { retry: "safe_read" },
      );
    const patchPaths = new Set(
      request.scope.patch.files.map((file) => file.path),
    );
    for (const path of request.scope.paths
      .filter((path) => !patchPaths.has(path))
      .slice(0, 10))
      add(
        "read_files",
        "repo_read_remote",
        { tool: "repo_read", arguments: { path } },
        `Contents of ${path}`,
        "File read succeeds",
        { retry: "safe_read" },
      );
    const files = request.scope.patch.files,
      proposedPaths = new Set(files.map((file) => file.path)),
      evidence =
        request.intent === "implementation" ? evidenceCandidates(request) : null,
      candidates =
        evidence &&
        (!files.length || evidence.every((path) => proposedPaths.has(path)))
          ? evidence
          : null;
    if (candidates) {
      appendEvidenceBoundImplementation({
        steps,
        taskId,
        candidates,
        branch: request.targetBranch,
        currentCommit: request.startingCommit,
        request,
      });
    } else add(
      "plan_patch",
      "reasoning",
      {
        goal: request.userGoal,
        acceptanceCriteria: request.acceptanceCriteria,
        scope: request.scope.paths,
      },
      "Bounded implementation decision",
      "Plan stays within declared scope",
      { retry: "new_evidence_required" },
    );
    if (files.length && !candidates) {
      if (request.riskLevel === "high")
        add(
          "authorize_protected_change",
          "reasoning",
          {
            tool: "self_development_protected_change",
            arguments: {
              repository: request.repository,
              branch: request.targetBranch,
              startingCommit: request.startingCommit,
              paths: files.map((x) => x.path),
              scopeHash: hash(files),
            },
          },
          "Exact protected-change approval",
          "Approved action exactly matches protected scope",
          { retry: "not_retryable", approval: true },
        );
      add(
        "apply_patch",
        "repo_mutate_local",
        {
          tool: "repo_apply_patch",
          arguments: { branch: request.targetBranch, files },
        },
        "Bounded files changed",
        "Only declared files are modified",
        { retry: "repair_required" },
      );
      if (request.scope.focusedTests.length)
        add(
          "run_focused_tests",
          "test_local",
          {
            tool: "test_run",
            arguments: { files: request.scope.focusedTests, timeoutMs: 180000 },
          },
          "Focused test report",
          "All focused tests pass",
          { retry: "repair_required" },
        );
      add(
        "run_full_tests",
        "test_local",
        { tool: "test_run_full", arguments: { timeoutMs: 180000 } },
        "Full test report",
        "Complete suite passes",
        { retry: "repair_required" },
      );
      add(
        "inspect_diff",
        "repo_read_remote",
        { tool: "repo_diff", arguments: { paths: files.map((x) => x.path) } },
        "Bounded reviewed diff",
        "Diff contains only declared scope",
        { retry: "safe_read" },
      );
      add(
        "commit",
        "repo_mutate_local",
        {
          tool: "git_commit",
          arguments: {
            paths: files.map((x) => x.path),
            branch: request.targetBranch,
            message: "Complete bounded Nova self-development task",
          },
        },
        "Exact local commit SHA",
        "One local commit created",
        { retry: "idempotent_commit" },
      );
      add(
        "review_commit",
        "repo_read_remote",
        {
          tool: "repo_review_commit",
          arguments: {
            commitSha: "$CURRENT_COMMIT",
            paths: files.map((x) => x.path),
          },
        },
        "Exact immutable commit review",
        "Commit exactly matches the reviewed bounded change-set",
        { retry: "not_retryable" },
      );
      if(!hasConstraintEnforcement(request,"omit_git_push")) add(
        "push",
        "github_write",
        {
          tool: "git_push",
          arguments: {
            branch: request.targetBranch,
            commitSha: "$CURRENT_COMMIT",
          },
        },
        "Approved remote feature commit",
        "Exact push approval succeeds",
        { retry: "approval_bound", approval: true },
      );
      if(!hasConstraintEnforcement(request,"omit_preview_deploy")){
        add(
          "deploy_preview",
          "vercel_preview",
          {
            tool: "preview_deploy",
            arguments: {
              branch: request.targetBranch,
              commitSha: "$CURRENT_COMMIT",
            },
          },
          "Git-backed Preview deployment",
          "Preview deployment created",
          { retry: "idempotent_deploy", approval: true },
        );
        add(
          "wait",
          "scheduler",
          { delayMs: 5000 },
          "Bounded deployment wait",
          "Task reschedules without busy-looping",
          { retry: "bounded_wait" },
        );
        add(
          "verify_preview",
          "vercel_preview",
          {
            tool: "preview_verify",
            arguments: {
              deploymentId: "$DEPLOYMENT_ID",
              path: "/api/health",
              expectedStatus: 200,
              commitSha: "$CURRENT_COMMIT",
            },
          },
          "Protected Preview verification",
          "Exact SHA Preview health succeeds",
          { retry: "repair_required" },
        );
      }
    }
    add(
      "summarize",
      "reasoning",
      {
        summary: files.length
          ? "Nova self-development task completed after Preview verification."
          : "Nova self-development discovery and planning completed.",
      },
      "Durable owner-facing summary",
      "All planned acceptance gates completed",
      { retry: "not_retryable" },
    );
    return Object.freeze(steps);
  }
  async function resolveTrustedProductCommit({ signal } = {}) {
    if (typeof verifyRemote !== "function")
      throw new SelfDevelopmentError(
        "repository_not_resolved",
        "The approved Nova feature branch could not be resolved safely.",
        503,
      );
    const remote = await verifyRemote({
      repository,
      branch: approvedBranch,
      requiredAncestors: [],
      ...(signal ? { signal } : {}),
    });
    if (!SHA.test(remote?.currentTip || ""))
      throw new SelfDevelopmentError(
        "repository_not_resolved",
        "The approved Nova feature branch did not return an exact commit.",
        503,
      );
    return remote.currentTip;
  }
  async function create(input, { signal, canonicalIntent, canonicalConstraintBindings = false, originConversationId, originRunId } = {}) {
    const parsed = structure(input, { canonicalIntent, canonicalConstraintBindings }),
      request = Object.freeze({
        ...parsed,
        targetProject: "nova-brain",
        targetBranch: approvedBranch,
        repository,
        environment: "preview",
        startingCommit: await resolveTrustedProductCommit({ signal }),
      }),
      fingerprint = requestFingerprint(request),
      rootTaskId = `selfdev_${fingerprint.slice(0, 32)}`;
    let taskId = rootTaskId,
      predecessor = null,
      successorMetadata = null;
    for (let depth = 0; depth <= MAX_TERMINAL_RETRY_DEPTH; depth += 1) {
      const prior = await runtime.get(taskId);
      if (!prior) break;
      const rootFingerprint =
        prior.metadata?.rootRequestFingerprint ||
        prior.metadata?.selfDevelopmentRequestFingerprint;
      if (
        rootFingerprint !== fingerprint ||
        (predecessor &&
          (prior.metadata?.supersedesTaskId !== predecessor.id ||
            prior.metadata?.retryContractVersion !==
              TERMINAL_RETRY_CONTRACT_VERSION ||
            prior.metadata?.predecessorTerminal?.status !==
              predecessor.status ||
            prior.metadata?.predecessorTerminal?.stateVersion !==
              predecessor.stateVersion))
      )
        throw new SelfDevelopmentError(
          "durable_task_create_failed",
          "Existing task identity does not match this request.",
        );
      if (!isTerminalRetryPredecessor(prior))
        return {
          request,
          plan: prior.metadata.steps,
          task: prior,
          idempotent: true,
          dispatch: { status: "scheduled", durable: true },
        };
      if (depth === MAX_TERMINAL_RETRY_DEPTH)
        throw new SelfDevelopmentError(
          "durable_task_create_failed",
          "Terminal task retry depth is exhausted.",
        );
      predecessor = prior;
      const successor = terminalSuccessorIdentity(fingerprint, predecessor);
      taskId = successor.taskId;
      successorMetadata = successor.metadata;
    }
    const steps = plan(request, taskId);
    let task;
    try {
      task = await runtime.create({
        id: taskId,
        title: `Self-development: ${request.userGoal.slice(0, 80)}`,
        objective: request.userGoal,
        taskType: "self_development",
        projectId: request.targetProject,
        branch: request.targetBranch,
        startingCommit: request.startingCommit,
        maxSteps: Math.min(100, steps.length + request.maxRepairIterations * 6),
        maxRetries: 1,
        maxRuntimeMinutes: request.runtimeBudgetMinutes,
        metadata: {
          steps,
          maxRepairIterations: request.maxRepairIterations,
          selfDevelopment: request,
          selfDevelopmentRequestFingerprint: fingerprint,
          ...(successorMetadata || {}),
          repairHistory: [],
          autoDispatch: true,
          ...(originConversationId?{terminalReporting:{version:1,conversationId:originConversationId,runId:originRunId||null}}:{}),
        },
      });
    } catch (error) {
      const concurrent = await runtime.get(taskId).catch(() => null);
      if (
        (concurrent?.metadata?.rootRequestFingerprint ||
          concurrent?.metadata?.selfDevelopmentRequestFingerprint) ===
          fingerprint &&
        (!predecessor ||
          (concurrent.metadata?.supersedesTaskId === predecessor.id &&
            concurrent.metadata?.retryContractVersion ===
              TERMINAL_RETRY_CONTRACT_VERSION &&
            concurrent.metadata?.predecessorTerminal?.status ===
              predecessor.status &&
            concurrent.metadata?.predecessorTerminal?.stateVersion ===
              predecessor.stateVersion))
      )
        return {
          request,
          plan: concurrent.metadata.steps,
          task: concurrent,
          idempotent: true,
          dispatch: { status: "scheduled", durable: true },
        };
      throw new SelfDevelopmentError(
        "durable_task_create_failed",
        "The durable Self-Development task could not be created safely.",
        503,
      );
    }
    for (const [action, summary] of [
      [
        "self_development_request_received",
        "Self-development request received.",
      ],
      [
        "self_development_scope_resolved",
        "Self-development scope and risk resolved.",
      ],
      ["self_development_plan_created", "Bounded Worker plan created."],
      [
        "self_development_auto_dispatch_scheduled",
        "Durable background continuation scheduled.",
      ],
    ])
      await storage.appendActivity({
        ownerId,
        projectId: task.projectId,
        runId: task.id,
        action,
        status: "completed",
        summary,
        metadata: {
          taskId: task.id,
          riskLevel: request.riskLevel,
          stepCount: steps.length,
        },
      });
    return {
      request,
      plan: steps,
      task,
      idempotent: false,
      dispatch: { status: "scheduled", durable: true },
    };
  }
  async function createTrustedIntake(userGoal, {signal,costContext,originConversationId,originRunId} = {}) {
    if (!isDurableSelfDevelopmentRequest(userGoal))
      throw new SelfDevelopmentError(
        "invalid_input",
        "The request is not an explicit Nova implementation task.",
        400,
      );
    if(!structuredIntake?.specify)throw new SelfDevelopmentError("structured_intake_unavailable","Chat-native durable intake is unavailable.",503);
    let specification;
    try{specification=await structuredIntake.specify(userGoal,{signal,costContext});}
    catch(error){if(["cost_budget_exhausted","model_price_unconfigured"].includes(error?.code))throw error;throw new SelfDevelopmentError(error?.code||"structured_intake_invalid","Nova could not establish a safe durable task specification.",409,error?.safeDiagnostics);}
    if(specification.intent!=="implementation")throw new SelfDevelopmentError("structured_intake_intent_conflict","Deterministic durable routing and structured intake intent did not agree.",409,{boundary:"canonical_intent",deterministicIntent:"implementation",structuredIntent:specification.intent||null});
    if(specification.status!=="ready")return{clarificationRequired:true,message:specification.clarificationQuestion||"The implementation request requires clarification.",providerUsage:specification.providerUsage||null};
    return create({
      userGoal:specification.objective,
      acceptanceCriteria:specification.acceptanceCriteria,
      constraints:specification.constraints,
      intake:{version:1,sourceRequestHash:hash(userGoal.trim()),specificationHash:specification.specificationHash,canonicalIntent:specification.intent,providerUsage:specification.providerUsage||null,scopeNormalization:specification.scopeNormalization||{discardedExplicitPaths:0,discardedFocusedTests:0}},
      scope: {
        paths: specification.explicitPaths,
        searchTerms: specification.searchTerms,
        focusedTests: specification.focusedTests,
        patch: { files: [] },
      },
    }, { signal, canonicalIntent: specification.intent, canonicalConstraintBindings: true, originConversationId, originRunId });
  }
  async function get(taskId) {
    const task = await runtime.get(taskId);
    if (!task || task.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    return {
      task,
      steps: await runtime.steps(task.id),
      request: task.metadata?.selfDevelopment,
    };
  }
  async function replanDiscoveryOnly(taskId, input) {
    const allowed = new Set([
      "expectedVersion",
      "runtimeBudgetMinutes",
      "candidatePaths",
    ]);
    if (
      !input ||
      Object.keys(input).some((key) => !allowed.has(key)) ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "replan_invalid",
        "An exact task version and bounded evidence candidates are required.",
        400,
      );
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before discovery-only replanning.",
      );
    const request = current.metadata?.selfDevelopment,
      steps = await runtime.steps(current.id),
      scopeRecoveryHistory = current.metadata?.structuredScopeRecoveryHistory || [],
      completedTypes = steps
        .filter((step) => step.status === "completed")
        .map((step) => step.stepType),
      requiredDiscovery = [
        "inspect_repo",
        "search_code",
        "plan_patch",
        "summarize",
      ];
    const priorApprovals = await storage.listApprovals(ownerId, { limit: 100 });
    const failedScopeSummary = steps.some(
      (step) =>
        step.stepType === "summarize" &&
        step.status === "failed" &&
        step.errorCode === "implementation_scope_required",
    );
    const eligibleTerminal =
      (current.status === "completed" &&
        requiredDiscovery.every((type) => completedTypes.includes(type))) ||
      (current.status === "blocked" &&
        current.errorCode === "implementation_scope_required" &&
        ["inspect_repo", "search_code", "plan_patch"].every((type) =>
          completedTypes.includes(type),
        ) &&
        failedScopeSummary) ||
      (current.status === "blocked" &&
        current.errorCode === "structured_scope_unresolved" &&
        scopeRecoveryHistory.length === 0 &&
        ["inspect_repo", "search_code", "plan_patch"].every((type) =>
          completedTypes.includes(type),
        ));
    const hasDeliveryEvidence =
      steps.some((step) =>
        [
          "apply_patch",
          "commit",
          "review_commit",
          "push",
          "deploy_preview",
        ].includes(step.stepType),
      ) ||
      priorApprovals.some((approval) => approval.runId === current.id) ||
      current.currentCommit !== current.startingCommit ||
      current.approvalState ||
      current.metadata?.lastDeploymentId ||
      current.metadata?.selfDevelopmentDeliveryAttestation;
    if (
      !eligibleTerminal ||
      current.branch !== approvedBranch ||
      request?.targetBranch !== approvedBranch ||
      request?.environment !== "preview" ||
      persistedIntent(request, current.objective) !== "implementation" ||
      request?.scope?.patch?.files?.length ||
      request?.scope?.paths?.length ||
      request?.scope?.focusedTests?.length ||
      scopeRecoveryHistory.length > STRUCTURED_SCOPE_RECOVERY_MAX_ATTEMPTS ||
      hasDeliveryEvidence
    )
      throw new SelfDevelopmentError(
        "discovery_replan_precondition_failed",
        "Only an exact completed discovery-only implementation task may be replanned.",
      );
    const runtimeBudgetMinutes = input.runtimeBudgetMinutes ?? 60;
    if (
      !Number.isInteger(runtimeBudgetMinutes) ||
      runtimeBudgetMinutes < 15 ||
      runtimeBudgetMinutes > 90
    )
      throw new SelfDevelopmentError(
        "invalid_runtime_budget",
        "Recovery runtime budget must be an integer from 15 to 90 minutes.",
        400,
      );
    const discoveryResolution = input.candidatePaths ? null : await resolveDiscoveryCandidates(request, steps);
    let resolvedCandidatePaths = input.candidatePaths ?? discoveryResolution?.candidatePaths,scopeResolution=null;
    if(!input.candidatePaths&&resolvedCandidatePaths&&structuredIntake?.resolveScope){
      const authorityRequest={...request,intent:persistedIntent(request,current.objective)},evidenceByPath=new Map(discoveryResolution.candidateEvidence.map(item=>[item.path,item])),certificate=deterministicScopeAuthority({request:authorityRequest,candidatePaths:resolvedCandidatePaths,candidateEvidence:discoveryResolution.candidateEvidence}),certificatePaths=certificate.resolved?[...certificate.sourcePaths,...certificate.testPaths]:[],baselineStates=certificate.resolved&&typeof resolvePathState==="function"?await Promise.all(certificatePaths.map(path=>resolvePathState(path,current.currentCommit))):[],baselineBound=certificatePaths.every((path,index)=>baselineStates[index]?.existsInCommit===true||evidenceByPath.get(path)?.inventory===true),baselineCertified=certificate.resolved&&!(discoveryResolution.sourceCreationAuthorities||[]).length&&baselineBound;
      if(baselineCertified){
        const decision={version:4,status:"resolved",sourcePaths:[...certificate.sourcePaths],newSourcePaths:[],testPaths:[...certificate.testPaths],sourceCreationRecords:[],constraintCoverage:[],constraintBindings:(request.constraints||[]).map((item,constraintIndex)=>({constraintIndex,type:item.type,enforcements:[...(item.enforcements||[])]})),unresolvedEvidence:[],authoritySource:"deterministic_repository_certificates",certificateHash:hash({repository:request.repository,branch:current.branch,currentCommit:current.currentCommit,candidatePaths:resolvedCandidatePaths,candidateEvidence:discoveryResolution.candidateEvidence,sourcePaths:certificate.sourcePaths,testPaths:certificate.testPaths})};
        scopeResolution={...decision,decisionHash:hash(decision),providerUsage:null,validationAttempts:0};
      }else try{
        scopeResolution=await resolveStructuredScope({request,candidatePaths:resolvedCandidatePaths,candidateEvidence:discoveryResolution.candidateEvidence,sourceCreationAuthorities:discoveryResolution.sourceCreationAuthorities,costContext:{taskId:current.id}});
        if(scopeResolution.status==="resolved"){
          const validated=deterministicScopeAuthority({request:authorityRequest,candidatePaths:resolvedCandidatePaths,candidateEvidence:discoveryResolution.candidateEvidence,selectedSourcePaths:scopeResolution.sourcePaths,selectedTestPaths:scopeResolution.testPaths,allowCertifiedSubset:(scopeResolution.newSourcePaths||[]).length>0});
          const selectedPaths=[...scopeResolution.sourcePaths,...scopeResolution.testPaths],selectedStates=validated.resolved&&typeof resolvePathState==="function"?await Promise.all(selectedPaths.map(path=>resolvePathState(path,current.currentCommit))):[],selectedBaselineCertified=validated.resolved&&selectedPaths.every((path,index)=>selectedStates[index]?.existsInCommit===true||evidenceByPath.get(path)?.inventory===true);
          if(!selectedBaselineCertified){
            const reason=validated.reason||"baseline_binding_incomplete",unresolvedEvidence=[{category:reason.startsWith("focused_test")?"focused_test":"source_ownership",concepts:[reason.replaceAll("_"," ")]}],decision={version:4,status:"blocked",sourcePaths:[],newSourcePaths:[],testPaths:[],sourceCreationRecords:[],constraintCoverage:scopeResolution.constraintCoverage||[],constraintBindings:scopeResolution.constraintBindings||[],unresolvedEvidence,authoritySource:"deterministic_repository_certificates",providerUsage:scopeResolution.providerUsage||null,validationAttempts:scopeResolution.validationAttempts||1};
            scopeResolution={...decision,decisionHash:hash(decision)};
          }
        }
      }
      catch(error){if(["cost_budget_exhausted","model_price_unconfigured"].includes(error?.code))throw error;throw new SelfDevelopmentError(error?.code||"structured_scope_invalid","Nova could not establish a safe mutation-authoritative scope.",409,{...error?.safeDiagnostics,recoveryTransitionScheduled:false,recoveryAttemptConsumed:false});}
      scopeResolution={...scopeResolution,deterministicCertificateStatus:baselineCertified?"complete":"incomplete",...(!baselineCertified?{deterministicCertificateReason:certificate.resolved?"baseline_binding_incomplete":certificate.reason}:{})};
      if(scopeResolution.status!=="resolved"){
        const now=clock().toISOString(),concepts=structuredScopeRecoveryConcepts(scopeResolution),attempt=scopeRecoveryHistory.length+1;
        const needsFocusedTestEvidence=(scopeResolution.unresolvedEvidence||[]).some(item=>item.category==="focused_test"),targetedTestSearches=needsFocusedTestEvidence?discoveryResolution.targetedTestSearches:[];
        if(attempt<=STRUCTURED_SCOPE_RECOVERY_MAX_ATTEMPTS&&(concepts.length||targetedTestSearches.length)){
          const base=current.metadata.steps.length,continuation=[];
          appendScopeRediscovery({steps:continuation,base,request,concepts,targetedTestSearches});
          const activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:continuation.length,repairLimit:0,recoveryClass:STRUCTURED_SCOPE_RECOVERY_CLASS,runtimeStartedAt:now,runtimeMinutes:STRUCTURED_SCOPE_RECOVERY_RUNTIME_MINUTES}),blockedWaitStartedAt=current.completedAt||current.updatedAt||null,blockedWaitMs=blockedWaitStartedAt?Math.max(0,new Date(now).getTime()-new Date(blockedWaitStartedAt).getTime()):null;
          const record={version:2,attempt,maxAttempts:STRUCTURED_SCOPE_RECOVERY_MAX_ATTEMPTS,attemptAccounting:"reserved_at_transition",fromStateVersion:current.stateVersion,baseStep:base,startingCommit:current.startingCommit,currentCommit:current.currentCommit,decisionHash:scopeResolution.decisionHash,candidatePathsHash:hash(resolvedCandidatePaths),candidateEvidenceHash:hash(discoveryResolution.candidateEvidence),unresolvedEvidence:(scopeResolution.unresolvedEvidence||[]).map(item=>({category:item.category,concepts:[...item.concepts]})),unresolvedEvidenceFingerprints:(scopeResolution.unresolvedEvidence||[]).map(hash),concepts,conceptsHash:hash(concepts),providerUsage:scopeResolution.providerUsage||null,continuationStepIds:continuation.map((step,index)=>`${base+index+1}:${step.type}`),continuationGenerationId:activeContinuation.generationId,runtimeWindow:{runtimeStartedAt:activeContinuation.runtimeStartedAt,runtimeDeadline:activeContinuation.runtimeDeadline,runtimeMinutes:activeContinuation.runtimeMinutes},runtimeResumeCount:0,maxRuntimeResumes:1,blockedWaitStartedAt,blockedWaitMs,status:"scheduled",createdAt:now};
          const recovered=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"scope_rediscovery",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,maxSteps:Math.min(100,Math.max(current.maxSteps,base+continuation.length+request.maxRepairIterations*6)),metadata:{...current.metadata,steps:[...current.metadata.steps,...continuation],requiredCapability:"repo_read_remote",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata.continuationHistory||[]),activeContinuation],structuredScopeResolution:structuredScopeMetadata(scopeResolution,{recoveryAttempt:attempt}),structuredScopeRecoveryHistory:[...scopeRecoveryHistory,record]}},current.stateVersion);
          if(!recovered)throw new SelfDevelopmentError("version_conflict","Task changed during bounded scope rediscovery scheduling.");
          await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_scope_rediscovery_scheduled",status:"queued",summary:"Nova scheduled one bounded read-only scope rediscovery pass.",metadata:{taskId:current.id,decisionHash:scopeResolution.decisionHash,attempt,maxAttempts:STRUCTURED_SCOPE_RECOVERY_MAX_ATTEMPTS,conceptsHash:record.conceptsHash,continuationStepIds:record.continuationStepIds}});
          return{task:recovered,evidenceStepIds:[],scopeHash:null,continuationSteps:continuation.map(step=>step.type),scopeRecovery:record};
        }
        const exhausted=scopeRecoveryHistory.length>=STRUCTURED_SCOPE_RECOVERY_MAX_ATTEMPTS,errorCode=exhausted?"structured_scope_recovery_exhausted":"structured_scope_unresolved",blockedReason=exhausted?"Nova exhausted the single bounded scope rediscovery pass without establishing safe authority.":"Nova could not establish a safe mutation-authoritative scope or bounded recovery concepts.";
        const blocked=await storage.updateAutonomyTask(current.id,ownerId,{status:"blocked",currentPhase:"scope_resolution",errorCode,blockedReason,completedAt:now,metadata:{...current.metadata,requiredCapability:null,activeContinuation:null,structuredScopeResolution:structuredScopeMetadata(scopeResolution,{recoveryAttempt:scopeRecoveryHistory.length,recoveryExhausted:exhausted}),structuredScopeRecoveryHistory:scopeRecoveryHistory.map((item,index)=>index===scopeRecoveryHistory.length-1?{...item,status:"exhausted",exhaustedAt:now}:item),...(current.metadata?.structuredScopeContinuation?{structuredScopeContinuation:{...current.metadata.structuredScopeContinuation,status:"exhausted",completedAt:now}}:{})}},current.stateVersion);
        if(!blocked)throw new SelfDevelopmentError("version_conflict","Task changed during structured scope resolution.");
        await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:exhausted?"self_development_scope_rediscovery_exhausted":"self_development_scope_resolution_blocked",status:"blocked",summary:blockedReason,metadata:{taskId:current.id,decisionHash:scopeResolution.decisionHash,recoveryAttempt:scopeRecoveryHistory.length,recoveryExhausted:exhausted}});
        return{task:blocked,evidenceStepIds:[],scopeHash:null,continuationSteps:[]};
      }
      resolvedCandidatePaths=[...scopeResolution.sourcePaths,...scopeResolution.testPaths];
    }
    if (
      !Array.isArray(resolvedCandidatePaths) ||
      resolvedCandidatePaths.length < 2 ||
      resolvedCandidatePaths.length > 12
    )
      throw new SelfDevelopmentError(
        "replan_scope_empty",
        "Implementation recovery requires 2-12 evidence candidate files.",
        400,
      );
    const candidates = [...new Set(resolvedCandidatePaths.map(safePath))],authorizedCreatePaths=[],inventory = new Set(
      steps
        .filter(
          (step) =>
            step.stepType === "inspect_repo" && step.status === "completed",
        )
        .flatMap((step) => step.result?.files || step.result?.items || [])
        .map((item) =>
          safePath(typeof item === "string" ? item : item?.path || ""),
        ),
    );
    const sourceCreationRecords=scopeResolution?.sourceCreationRecords||[],newSourcePaths=scopeResolution?.newSourcePaths||[];
    if(sourceCreationRecords.length!==newSourcePaths.length)throw new SelfDevelopmentError("source_creation_authority_invalid","Every proposed new source path requires one exact creation-authority record.",400);
    if(sourceCreationRecords.length){
      if(sourceCreationRecords.length>MAX_AUTHORIZED_NEW_SOURCE_PATHS)throw new SelfDevelopmentError("replan_scope_too_large","New source creation scope exceeds the bounded limit.",400);
      const proposed=[...newSourcePaths].map(safePath).sort(),recordPaths=sourceCreationRecords.map(record=>safePath(record?.path)).sort();
      if(proposed.length!==recordPaths.length||new Set(recordPaths).size!==recordPaths.length||JSON.stringify(proposed)!==JSON.stringify(recordPaths))throw new SelfDevelopmentError("source_creation_authority_invalid","Authorized source creation records must exactly match the structured scope decision.",400);
      for(const record of sourceCreationRecords){
        const path=safePath(record.path),frozen={...record,baselineCommit:current.currentCommit,baselineExists:false},state=typeof resolvePathState==="function"?await resolvePathState(path,current.currentCommit):null;
        if(safeNewSourcePath(path)!==path||REPLAN_PROTECTED.test(path)||!verifySourceCreationRecord(frozen)||!record.evidencePaths?.every(evidence=>inventory.has(safePath(evidence))))throw new SelfDevelopmentError("source_creation_authority_invalid","New source creation authority is not repository-grounded or targets a protected path.",403,{path,mutationApplied:false});
        if(!state||state.existsInCommit||state.existsInWorktree||state.staged||state.untracked)throw new SelfDevelopmentError("source_creation_precondition_failed","Authorized source creation requires proven baseline and workspace nonexistence.",409,{path,mutationApplied:false});
        authorizedCreatePaths.push(frozen);
      }
    }
    for (const path of candidates) {
      if (!inventory.has(path)) {
        if (typeof resolvePathState !== "function")
          throw new SelfDevelopmentError(
            "replan_scope_not_discovered",
            "Every candidate path must be present in durable repository discovery evidence.",
            400,
          );
        const pathState = await resolvePathState(path, current.currentCommit);
        if (!pathState?.existsInCommit)
          throw new SelfDevelopmentError(
            "replan_scope_not_discovered",
            "Every candidate path must be present in durable repository discovery evidence or the exact bound commit.",
            400,
          );
      }
      if (REPLAN_PROTECTED.test(path))
        throw new SelfDevelopmentError(
          "replan_protected_scope",
          "Discovery-only recovery cannot target protected Voice or runtime architecture.",
          403,
        );
    }
    if (
      !candidates.some((path) => !path.startsWith("test/")) ||
      !candidates.some((path) => path.startsWith("test/"))
    )
      throw new SelfDevelopmentError(
        "replan_scope_empty",
        "Evidence candidates must include implementation and focused-test files.",
        400,
      );
    const evidenceStepIds = steps
        .filter(
          (step) =>
            requiredDiscovery.includes(step.stepType) &&
            step.status === "completed",
        )
        .map((step) => step.stepId),
      base = current.metadata.steps.length,
      continuation = [];
    appendEvidenceBoundImplementation({
      steps: continuation,
      base,
      taskId: current.id,
      candidates,
      branch: current.branch,
      currentCommit: current.currentCommit,
      request,
      authorizedCreatePaths,
    });
    continuation.push(
      annotation(
        base + continuation.length + 1,
        "summarize",
        "reasoning",
        {
          summary:
            "Nova self-development task completed after Preview verification.",
        },
        "Durable owner-facing summary",
        "All planned acceptance gates completed",
        { retry: "not_retryable" },
      ),
    );
    const now = clock().toISOString(),
      scopeHash = hash({candidates,authorizedCreatePaths}),
      replanRecord = {
        fromStatus: current.status,
        fromStateVersion: current.stateVersion,
        previousStartedAt: current.startedAt,
        previousCompletedAt: current.completedAt,
        evidenceStepIds,
        candidatePaths: candidates,
        ...(discoveryResolution ? { candidateEvidenceHash: hash(discoveryResolution.candidateEvidence) } : {}),
        scopeSource: input.candidatePaths ? "explicit_durable_evidence" : "automatic_durable_discovery",
        scopeHash,
        authorizedCreatePathsHash:hash(authorizedCreatePaths),
        createdAt: now,
      };
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        currentStep: base,
        currentPhase: "replan_implementation",
        nextRunAt: now,
        startedAt: now,
        completedAt: null,
        errorCode: null,
        resultSummary: null,
        retryCount: 0,
        maxRuntimeMinutes: runtimeBudgetMinutes,
        blockedReason: null,
        maxSteps: Math.min(
          100,
          base +
            continuation.length +
            (current.metadata.maxRepairIterations || 2) * 6,
        ),
        metadata: {
          ...current.metadata,
          selfDevelopment: {
            ...request,
            intent: persistedIntent(request, current.objective),
            scopeAuthority: "resolved_discovery",
            scope:{...request.scope,paths:candidates.filter(path=>!path.startsWith("test/")),focusedTests:candidates.filter(path=>path.startsWith("test/")),authorizedCreatePaths},
          },
          steps: [...current.metadata.steps, ...continuation],
          requiredCapability: "repo_read_remote",
          autoDispatch: true,
          activeContinuation: null,
          discoveryOnlyReplanHistory: [
            ...(current.metadata.discoveryOnlyReplanHistory || []),
            replanRecord,
          ],
          ...(scopeResolution?{structuredScopeResolution:structuredScopeMetadata(scopeResolution,{recoveryAttempt:scopeRecoveryHistory.length})}:{}),
          ...(scopeRecoveryHistory.length?{structuredScopeRecoveryHistory:scopeRecoveryHistory.map((item,index)=>index===scopeRecoveryHistory.length-1?{...item,status:"resolved",resolvedAt:now,resolvedDecisionHash:scopeResolution?.decisionHash||null}:item)}:{}),
          ...(current.metadata?.structuredScopeContinuation?{structuredScopeContinuation:{...current.metadata.structuredScopeContinuation,status:"resolved",completedAt:now,decisionHash:scopeResolution?.decisionHash||null}}:{}),
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during discovery-only replanning.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_replanned_after_discovery_only_completion",
      status: "queued",
      summary:
        "Completed discovery-only task reopened with an evidence-bound implementation continuation.",
      metadata: {
        taskId: current.id,
        previousStateVersion: current.stateVersion,
        evidenceStepIds,
        scopeHash,
        runtimeBudgetMinutes,
        continuationStepCount: continuation.length,
      },
    });
    return {
      task: updated,
      evidenceStepIds,
      scopeHash,
      continuationSteps: continuation.map((step) => step.type),
    };
  }
  async function recoverStructuredScope(taskId, input = {}) {
    const allowed = new Set(["expectedVersion", "runtimeBudgetMinutes"]);
    if (
      Object.keys(input).some((key) => !allowed.has(key)) ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "scope_recovery_invalid",
        "An exact blocked task version is required.",
        400,
      );
    const idempotentRecovery = async () => {
      const task = await runtime.get(taskId),
        recovery = task?.metadata?.structuredScopeRecoveryHistory?.at(-1);
      if (
        task?.status === "queued" &&
        task.currentPhase === "scope_rediscovery" &&
        recovery?.status === "scheduled" &&
        (recovery.fromStateVersion === input.expectedVersion || recovery.runtimeResumeFromStateVersion === input.expectedVersion)
      )
        return { task, scopeRecovery: recovery, idempotent: true };
      return null;
    };
    const replay = await idempotentRecovery();
    if (replay) return replay;
    const expired = await runtime.get(taskId), expiredRecovery=expired?.metadata?.structuredScopeRecoveryHistory?.at(-1);
    const scopeRecoveryExpiry=expired?.status==="expired"&&expired.errorCode==="max_runtime_reached"&&expiredRecovery?.status==="scheduled"&&(expired.currentPhase==="scope_rediscovery"||expired.metadata?.activeContinuation?.recoveryClass===STRUCTURED_SCOPE_RECOVERY_CLASS);
    if(expired?.stateVersion===input.expectedVersion&&scopeRecoveryExpiry){
      const steps=await runtime.steps(expired.id),base=Number.isInteger(expiredRecovery.baseStep)?expiredRecovery.baseStep:expired.currentStep,pending=(expired.metadata?.steps||[]).slice(base),request=expired.metadata?.selfDevelopment,priorResumes=expiredRecovery.runtimeResumeCount||0,noRecoveryAction=expired.currentStep===base&&!steps.some(step=>Number.parseInt(step.stepId,10)>base),safePlan=pending.length>0&&pending.every(step=>["search_code","plan_patch","summarize"].includes(step.type)),sameBaseline=expired.startingCommit===expiredRecovery.startingCommit&&expired.currentCommit===expiredRecovery.currentCommit&&expired.currentCommit===request?.startingCommit,noAuthority=request?.scopeAuthority==="discovery_only"&&!request?.scope?.paths?.length&&!request?.scope?.focusedTests?.length&&!request?.scope?.patch?.files?.length,noLease=!expired.leaseOwner&&!expired.leaseToken&&!expired.leaseExpiresAt,noDelivery=!expired.approvalState&&!expired.metadata?.lastDeploymentId&&!expired.metadata?.selfDevelopmentDeliveryAttestation&&!steps.some(step=>["apply_patch","commit","review_commit","push","deploy_preview"].includes(step.stepType));
      if(noRecoveryAction&&safePlan&&sameBaseline&&noAuthority&&noLease&&noDelivery&&expiredRecovery.attempt===1&&expiredRecovery.maxAttempts===STRUCTURED_SCOPE_RECOVERY_MAX_ATTEMPTS&&priorResumes<1){
        const now=clock().toISOString(),activeContinuation=createActiveContinuation({task:expired,startStep:base,plannedSteps:pending.length,repairLimit:0,recoveryClass:STRUCTURED_SCOPE_RECOVERY_CLASS,runtimeStartedAt:now,runtimeMinutes:STRUCTURED_SCOPE_RECOVERY_RUNTIME_MINUTES}),resumedRecord={...expiredRecovery,version:2,runtimeResumeCount:priorResumes+1,runtimeResumeFromStateVersion:expired.stateVersion,runtimeResumedAt:now,continuationGenerationId:activeContinuation.generationId,runtimeWindow:{runtimeStartedAt:activeContinuation.runtimeStartedAt,runtimeDeadline:activeContinuation.runtimeDeadline,runtimeMinutes:activeContinuation.runtimeMinutes}};
        const resumed=await storage.updateAutonomyTask(expired.id,ownerId,{status:"queued",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata:{...expired.metadata,activeContinuation,continuationHistory:[...(expired.metadata.continuationHistory||[]),activeContinuation],structuredScopeRecoveryHistory:[...expired.metadata.structuredScopeRecoveryHistory.slice(0,-1),resumedRecord],requiredCapability:"repo_read_remote",autoDispatch:true}},expired.stateVersion);
        if(!resumed){const raced=await idempotentRecovery();if(raced)return raced;throw new SelfDevelopmentError("version_conflict","Task changed during bounded scope-rediscovery runtime recovery.");}
        await storage.appendActivity({ownerId,projectId:expired.projectId,runId:expired.id,action:"self_development_scope_rediscovery_runtime_resumed",status:"queued",summary:"Nova resumed the same unused bounded scope-rediscovery attempt with one fresh execution window.",metadata:{taskId:expired.id,attempt:resumedRecord.attempt,runtimeResumeCount:resumedRecord.runtimeResumeCount,maxRuntimeResumes:resumedRecord.maxRuntimeResumes,runtimeWindow:resumedRecord.runtimeWindow,fromStateVersion:expired.stateVersion}});
        return{task:resumed,scopeRecovery:resumedRecord,idempotent:false};
      }
      throw new SelfDevelopmentError("scope_recovery_expiry_ineligible","Only an exact pre-action scope-rediscovery expiry may resume its existing bounded attempt.",409);
    }
    try {
      return {
        ...(await replanDiscoveryOnly(taskId, input)),
        idempotent: false,
      };
    } catch (error) {
      if (error?.code === "version_conflict") {
        const raced = await idempotentRecovery();
        if (raced) return raced;
      }
      throw error;
    }
  }
  async function recoverImplementationPlan(taskId, input) {
    if (
      !input ||
      Object.keys(input).some((key) => key !== "expectedVersion") ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "implementation_plan_recovery_invalid",
        "An exact task version is required.",
        400,
      );
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    const priorPartialEvidenceRecovery=(current.metadata?.implementationPlanRecoveryHistory||[]).find(item=>["partial_repair_plan_evidence_rebind","task_owned_local_read_recovery"].includes(item.recoveryClass)&&item.previousStateVersion===input.expectedVersion);
    if(priorPartialEvidenceRecovery&&current.status!=="failed")return{task:current,recoveredStepId:priorPartialEvidenceRecovery.failedStepId,idempotent:true};
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before implementation-plan recovery.",
      );
    const partialSteps=await runtime.steps(current.id),latestFailed=partialSteps.filter(step=>step.status==="failed").at(-1),partialRecord=(current.metadata?.partialRepairPlanRecoveryHistory||[]).at(-1),latestRebind=(current.metadata?.implementationPlanRecoveryHistory||[]).at(-1),failureEvidence=latestFailed?.input?.arguments?.failureEvidence,requiredPaths=partialRecord?.requiredPaths,partialEntries=partialRecord?.entries,partialFailure=latestFailed?.stepId===`${current.currentStep+1}:plan_repair`&&latestFailed.stepType==="plan_repair"&&latestFailed.errorCode==="implementation_evidence_incomplete"&&failureEvidence?.code==="repair_plan_incomplete"&&["Task-owned repair evidence no longer matches its durable lineage.","Every candidate file must be read completely before implementation planning."].includes(latestFailed.result?.message),generationBound=partialRecord?.activeContinuation?.generationId===current.metadata?.activeContinuation?.generationId||latestRebind?.recoveryClass==="partial_repair_plan_evidence_rebind"&&latestRebind?.fingerprint===partialRecord?.fingerprint&&latestRebind?.sourcePlanStepId===partialRecord?.sourcePlanStepId&&latestRebind?.sourceApplyStepId===partialRecord?.sourceApplyStepId&&/^[0-9a-f]{40}$/i.test(latestRebind?.runtimeVersion||"")&&current.metadata?.activeContinuation?.recoveryClass==="partial_repair_plan_evidence_rebind"&&current.metadata?.activeContinuation?.runtimeStartedAt===latestRebind?.recoveredAt,lineageExact=current.branch===approvedBranch&&current.metadata?.selfDevelopment?.repository===repository&&/^[0-9a-f]{40}$/i.test(runtimeVersion||"")&&partialRecord?.taskId===current.id&&partialRecord.repository===repository&&partialRecord.branch===approvedBranch&&partialRecord.currentCommit===current.currentCommit&&typeof partialRecord.workspaceRoot==="string"&&partialRecord.workspaceRoot.length>0&&Array.isArray(requiredPaths)&&requiredPaths.length>0&&requiredPaths.length<=12&&new Set(requiredPaths).size===requiredPaths.length&&Array.isArray(partialEntries)&&partialEntries.length===requiredPaths.length&&partialEntries.every(entry=>requiredPaths.includes(entry.path)&&/^[0-9a-f]{64}$/i.test(entry.contentHash||""))&&generationBound&&!current.leaseOwner&&!current.leaseToken&&!current.approvalState&&!partialSteps.some(step=>Number.parseInt(step.stepId,10)>Number.parseInt(latestFailed.stepId,10)),partialExact=current.status==="failed"&&current.errorCode==="implementation_evidence_incomplete"&&partialFailure&&lineageExact&&partialRecord.fingerprint===failureEvidence?.fingerprint&&partialRecord.sourcePlanStepId===failureEvidence?.sourcePlanStepId&&partialRecord.sourceApplyStepId===failureEvidence?.sourceApplyStepId&&JSON.stringify(requiredPaths)===JSON.stringify(failureEvidence?.requiredPaths);
    const localReadFailure=latestFailed?.stepId===`${current.currentStep+1}:read_files`&&latestFailed.stepType==="read_files"&&latestFailed.errorCode==="remote_repository_failed"&&latestFailed.result?.message==="Repository request failed with status 404.";
    if(current.status==="failed"&&current.errorCode==="remote_repository_failed"&&localReadFailure&&lineageExact){
      const remaining=current.metadata.steps.slice(current.currentStep),leadingReads=remaining.findIndex(step=>step.type!=="read_files"),readCount=leadingReads===-1?remaining.length:leadingReads,readSteps=remaining.slice(0,readCount),failedPath=latestFailed.input?.arguments?.path;
      if(readCount<1||readCount>12||readSteps[0]?.input?.arguments?.path!==failedPath||readSteps.some(step=>step.input?.tool!=="repo_read"||!requiredPaths.includes(step.input?.arguments?.path))||remaining[readCount]?.type!=="plan_repair")throw new SelfDevelopmentError("implementation_plan_recovery_precondition_failed","The exact bounded task-owned local-read continuation is unavailable.");
      const base=current.metadata.steps.length,localReads=readSteps.map((step,index)=>({...step,capability:"repo_read_remote",input:{tool:"repo_read_task_owned_local",arguments:{path:step.input.arguments.path}},idempotencyIdentity:`self-development:task-owned-local-read:${base+index+1}:${createHash("sha256").update(`${current.id}:${current.stateVersion}:${step.input.arguments.path}:${partialRecord.fingerprint}`).digest("hex")}`})),nextSteps=[...localReads,...remaining.slice(readCount)].map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:local-read-recovery:${base+index+1}`}));
      if(nextSteps.length>21)throw new SelfDevelopmentError("implementation_plan_recovery_precondition_failed","The task-owned local-read continuation exceeds its bounded budget.");
      const now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass:"task_owned_local_read_recovery",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"task_owned_local_read_recovery",previousStateVersion:current.stateVersion,failedStepId:latestFailed.stepId,sourcePlanStepId:partialRecord.sourcePlanStepId,sourceApplyStepId:partialRecord.sourceApplyStepId,fingerprint:partialRecord.fingerprint,runtimeVersion:runtimeVersion||null,readPaths:localReads.map(step=>step.input.arguments.path),historicalContinuationGenerationId:partialRecord.activeContinuation.generationId,activeContinuation,recoveredAt:now};
      const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentPhase:"read_files",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:"repo_read_remote",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],implementationPlanRecoveryHistory:[...(current.metadata?.implementationPlanRecoveryHistory||[]),record]}},current.stateVersion);
      if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during task-owned local-read recovery.");
      await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_implementation_plan_recovered",status:"waiting_for_worker",summary:"The exact attested task-owned local-read continuation was restored.",metadata:{taskId:current.id,...record}});
      return{task:updated,recoveredStepId:latestFailed.stepId,idempotent:false};
    }
    if(partialExact){
      const remaining=current.metadata.steps.slice(current.currentStep),base=current.metadata.steps.length;
      if(remaining.length<1||remaining.length>15||remaining[0]?.type!=="plan_repair")throw new SelfDevelopmentError("implementation_plan_recovery_precondition_failed","The exact bounded partial-repair continuation is unavailable.");
      const reads=requiredPaths.map((path,index)=>({type:"read_files",capability:"repo_read_remote",input:{tool:"repo_read_task_owned_local",arguments:{path}},expectedOutput:`Complete current task-owned contents of ${path}`,successCondition:"Current complete-file evidence is recorded before repair planning",retryClassification:"safe_read",approvalRequired:false,idempotencyIdentity:`self-development:partial-evidence-reread:${base+index+1}:${createHash("sha256").update(`${current.id}:${current.stateVersion}:${path}:${partialRecord.fingerprint}`).digest("hex")}`})),continuation=[...reads,...remaining];
      if(continuation.length>30)throw new SelfDevelopmentError("implementation_plan_recovery_precondition_failed","The exact bounded read-evidence continuation is unavailable.");
      const nextSteps=continuation.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:partial-evidence-rebind:${base+index+1}`})),now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass:"partial_repair_plan_evidence_rebind",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"partial_repair_plan_evidence_rebind",previousStateVersion:current.stateVersion,failedStepId:latestFailed.stepId,sourcePlanStepId:partialRecord.sourcePlanStepId,sourceApplyStepId:partialRecord.sourceApplyStepId,fingerprint:partialRecord.fingerprint,runtimeVersion:runtimeVersion||null,readPaths:requiredPaths,recoveredAt:now},reboundPartialRecord={...partialRecord,runtimeVersion:runtimeVersion||null,activeContinuation,reboundAt:now};
      const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"read_files",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:"repo_read_remote",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],partialRepairPlanRecoveryHistory:[...(current.metadata?.partialRepairPlanRecoveryHistory||[]),reboundPartialRecord],implementationPlanRecoveryHistory:[...(current.metadata?.implementationPlanRecoveryHistory||[]),record]}},current.stateVersion);
      if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during partial repair evidence recovery.");
      await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_implementation_plan_recovered",status:"queued",summary:"The exact task-owned partial-repair evidence continuation was rebound to the active runtime.",metadata:{taskId:current.id,...record}});
      return{task:updated,recoveredStepId:latestFailed.stepId,idempotent:false};
    }
    const steps = await runtime.steps(current.id),
      failed = steps.find(
        (step) =>
          step.stepId === `${current.currentStep + 1}:plan_implementation` &&
          step.status === "failed" &&
          step.errorCode === "implementation_plan_invalid",
      ),
      reads = steps.filter(
        (step) => step.stepType === "read_files" && step.status === "completed",
      ),
      approvals = await storage.listApprovals(ownerId, { limit: 100 }),
      unsafe =
        steps.some((step) =>
          [
            "apply_patch",
            "commit",
            "review_commit",
            "push",
            "deploy_preview",
          ].includes(step.stepType),
        ) || approvals.some((approval) => approval.runId === current.id),
      candidates =
        current.metadata?.discoveryOnlyReplanHistory?.at(-1)?.candidatePaths ||
        [];
    if (
      current.status !== "failed" ||
      current.errorCode !== "implementation_plan_invalid" ||
      !failed ||
      candidates.length < 2 ||
      candidates.some(
        (path) =>
          !reads.some(
            (step) =>
              (step.result?.path || step.input?.arguments?.path) === path,
          ),
      ) ||
      unsafe ||
      current.currentCommit !== current.startingCommit
    )
      throw new SelfDevelopmentError(
        "implementation_plan_recovery_precondition_failed",
        "Only the exact pre-mutation planner-format failure may be recovered.",
      );
    const now = clock().toISOString(),
      record = {
        failedStepId: failed.stepId,
        previousStateVersion: current.stateVersion,
        validationIssues: failed.result?.diagnostics?.validationIssues || [],
        outputShapeHash: failed.result?.diagnostics?.outputShapeHash || null,
        recoveredAt: now,
      },
      updated = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "queued",
          currentPhase: "plan_implementation_recovery",
          nextRunAt: now,
          startedAt: now,
          completedAt: null,
          errorCode: null,
          retryCount: 0,
          blockedReason: null,
          metadata: {
            ...current.metadata,
            requiredCapability: "reasoning",
            autoDispatch: true,
            implementationPlanRecoveryHistory: [
              ...(current.metadata.implementationPlanRecoveryHistory || []),
              record,
            ],
          },
        },
        current.stateVersion,
      );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during implementation-plan recovery.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_implementation_plan_recovered",
      status: "queued",
      summary:
        "Exact pre-mutation planner-format failure requeued with bounded schema correction.",
      metadata: {
        taskId: current.id,
        failedStepId: failed.stepId,
        previousStateVersion: current.stateVersion,
        validationIssues: record.validationIssues,
        outputShapeHash: record.outputShapeHash,
      },
    });
    return { task: updated, recoveredStepId: failed.stepId };
  }
  async function recoverFailedTaskOwnedLocalRead(taskId,input,actor){
    return recoverFailedLocalRead({taskId,input,actor,runtime,storage,ownerId,repository,approvedBranch,runtimeVersion,verifyRemote,clock});
  }
  async function recoverImplementationSchema(taskId, input) {
    if (!input || Object.keys(input).some((key) => key !== "expectedVersion") || !Number.isInteger(input.expectedVersion))
      throw new SelfDevelopmentError("implementation_schema_recovery_invalid", "An exact task version is required.", 400);
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError("task_not_found", "Self-development task not found.", 404);
    const prior = current.metadata?.implementationSchemaRecoveryHistory?.find((item) => item.previousStateVersion === input.expectedVersion);
    if (prior && current.status !== "failed") return { task: current, recoveredStepId: prior.failedStepId, idempotent: true };
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError("version_conflict", "Task changed before implementation-schema recovery.");
    const steps = await runtime.steps(current.id), semantic = resolveSemanticPlanApplyState(current, steps, "schema_mismatch",{planStepTypes:["plan_implementation","plan_repair"]}), {failed, planned, planTemplate, remaining, completedAfterPlan: unsafeAfterPlan} = semantic, approvals = await storage.listApprovals(ownerId, { limit: 100 }), schemaMessage = String(failed?.result?.message || ""), diagnostic=failed?.result?.diagnostics, repairBranchMissing=isExactMissingBranchSchemaDiagnostic(diagnostic,{stepType:failed?.stepType,templateTool:remaining[0]?.input?.tool}), legacyCurrentCommit=schemaMessage.includes("repo_apply_patch.currentCommit"), exactFailedStep=failed.stepId===`${current.currentStep+1}:apply_patch`;
    if (current.status !== "failed" || current.errorCode !== "schema_mismatch" || (!repairBranchMissing&&!legacyCurrentCommit) || !exactFailedStep || current.branch!==approvedBranch || ["main","master"].includes(current.branch) || remaining[0]?.type !== "apply_patch" || unsafeAfterPlan || current.leaseOwner || current.approvalState || approvals.some((approval) => approval.runId === current.id) || current.metadata?.lastDeploymentId || current.metadata?.selfDevelopmentDeliveryAttestation)
      throw new SelfDevelopmentError("implementation_schema_recovery_precondition_failed", "Only the exact pre-mutation implementation bridge schema failure may be recovered.");
    const canonicalPatch={...remaining[0],input:{...remaining[0].input,tool:"repo_apply_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}}}, continuation=repairBranchMissing?[canonicalPatch,...remaining.slice(1)]:[{...planTemplate}, ...remaining], base = current.metadata.steps.length, nextSteps = continuation.map((step, index) => ({...step, idempotencyIdentity: `${step.idempotencyIdentity || `self-development:${step.type}`}:schema-recovery:${base + index + 1}`})), now = clock().toISOString(), record = {failedStepId: failed.stepId, plannedStepId: planned.stepId, previousStateVersion: current.stateVersion, fieldPath: repairBranchMissing?"repo_apply_patch.branch":"repo_apply_patch.currentCommit", expected: repairBranchMissing?"required exact task branch":"declared string commit binding", received: repairBranchMissing?"missing":"string", validationCode: repairBranchMissing?"required_field_missing":"unsupported_field", schemaVersion: diagnostic?.schemaVersion||"1", recoveredAt: now};
    if (!repairBranchMissing && base + nextSteps.length > current.maxSteps)
      throw new SelfDevelopmentError("implementation_schema_recovery_budget_exceeded", "The existing bounded step budget cannot contain schema recovery.");
    const activeContinuation=repairBranchMissing?createActiveContinuation({task:current,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.selfDevelopment?.repairLimit??2,recoveryClass:"repair_apply_patch_schema_binding",runtimeStartedAt:now,runtimeMinutes:15}):current.metadata?.activeContinuation;
    const updated = await storage.updateAutonomyTask(current.id, ownerId, {status:"queued",currentStep:base,currentPhase:"plan_implementation_schema_recovery",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,metadata:{...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:repairBranchMissing?"repo_mutate_local":"reasoning",autoDispatch:true,...(repairBranchMissing?{activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation]}:{}),implementationSchemaRecoveryHistory:[...(current.metadata.implementationSchemaRecoveryHistory || []),record]}}, current.stateVersion);
    if (!updated) throw new SelfDevelopmentError("version_conflict", "Task changed during implementation-schema recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_implementation_schema_recovered",status:"queued",summary:"Exact pre-mutation implementation bridge schema failure requeued for canonical replanning.",metadata:{taskId:current.id,failedStepId:failed.stepId,previousStateVersion:current.stateVersion,fieldPath:record.fieldPath,expected:record.expected,received:record.received,validationCode:record.validationCode,schemaVersion:record.schemaVersion}});
    return { task: updated, recoveredStepId: failed.stepId, idempotent: false };
  }
  async function recoverFocusedTestSchema(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("focused_test_schema_recovery_invalid","Exact version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.focusedTestSchemaRecoveryHistory?.find(item=>item.previousStateVersion===input.expectedVersion);if(prior&&current.status!=="failed")return{task:current,recoveredStepId:prior.failedStepId,idempotent:true};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before focused-test schema recovery.");
    const steps=await runtime.steps(current.id),failed=steps.filter(step=>step.status==="failed").at(-1),diagnostic=failed?.result?.diagnostics,failedOrdinal=Number.parseInt(failed?.stepId||"",10),exactStep=failed?.stepId===`${current.currentStep+1}:run_focused_tests`,exactDiagnostic=failed?.stepType==="run_focused_tests"&&failed?.errorCode==="schema_mismatch"&&diagnostic?.tool==="test_run"&&diagnostic?.fieldPath==="test_run.files"&&diagnostic?.validationCode==="required_field_missing"&&diagnostic?.received?.type==="missing",approvals=await storage.listApprovals(ownerId,{limit:100}),plan=current.metadata?.selfDevelopmentImplementationPlan;
    if(current.status!=="failed"||current.errorCode!=="schema_mismatch"||!exactStep||!exactDiagnostic||!Number.isInteger(failedOrdinal)||!plan?.provenance||current.metadata?.activeImplementationPlanGeneration!==plan.provenance.generationId||plan.provenance.taskId!==current.id||plan.provenance.currentCommit!==current.currentCommit||current.branch!==approvedBranch||current.leaseOwner||current.approvalState||approvals.some(item=>item.runId===current.id)||current.metadata?.lastDeploymentId||current.metadata?.selfDevelopmentDeliveryAttestation)throw new SelfDevelopmentError("focused_test_schema_recovery_precondition_failed","Only the exact active-plan pre-test files binding failure may be recovered.");
    assertActiveImplementationPlan(current,plan.files);const remaining=current.metadata.steps.slice(failedOrdinal),focused={...current.metadata.steps[failedOrdinal-1],input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}}},continuation=[focused,...remaining],base=current.metadata.steps.length,nextSteps=continuation.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:focused-test-schema-recovery:${base+index+1}`})),now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass:"focused_test_files_binding",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"focused_test_files_binding",previousStateVersion:current.stateVersion,failedStepId:failed.stepId,fieldPath:"test_run.files",validationCode:"required_field_missing",planGenerationId:plan.provenance.generationId,recoveredAt:now};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentPhase:"focused_test_schema_recovery",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:"test_local",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],focusedTestSchemaRecoveryHistory:[...(current.metadata?.focusedTestSchemaRecoveryHistory||[]),record]}},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during focused-test schema recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_focused_test_schema_recovered",status:"waiting_for_worker",summary:"Exact pre-test focused-test files binding was restored for bounded continuation.",metadata:{taskId:current.id,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,fieldPath:record.fieldPath,validationCode:record.validationCode,planGenerationId:record.planGenerationId}});return{task:updated,recoveredStepId:failed.stepId,idempotent:false};
  }
  async function recoverStaleBasePatchConflict(taskId, input) {
    if (!input || Object.keys(input).some((key) => !["expectedVersion","workspace"].includes(key)) || !Number.isInteger(input.expectedVersion) || !input.workspace || Object.keys(input.workspace).some((key) => !["head","clean"].includes(key)) || !SHA.test(input.workspace.head || "") || input.workspace.clean !== true)
      throw new SelfDevelopmentError("stale_base_recovery_invalid", "Exact version and clean controlled-workspace attestation are required.", 400);
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development") throw new SelfDevelopmentError("task_not_found", "Self-development task not found.", 404);
    const prior = current.metadata?.baseRevisionHistory?.find((item) => item.previousStateVersion === input.expectedVersion);
    if (prior && current.status !== "failed") return {task:current,previousBaseCommit:prior.previousBaseCommit,newBaseCommit:prior.newBaseCommit,idempotent:true};
    if (current.stateVersion !== input.expectedVersion) throw new SelfDevelopmentError("version_conflict", "Task changed before base-revision recovery.");
    if (!verifyRemote || !SHA.test(currentCommit || "") || input.workspace.head !== currentCommit) throw new SelfDevelopmentError("base_revision_verification_unavailable", "The exact deployed branch tip and controlled workspace must agree.", 503);
    const steps=await runtime.steps(current.id), semantic=resolveSemanticPlanApplyState(current,steps,"patch_conflict"), {failed,planned,planTemplate,remaining,completedAfterPlan}=semantic, approvals=await storage.listApprovals(ownerId,{limit:100}), completedDelivery=steps.some((step)=>["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"), oldCommit=current.currentCommit;
    if (current.status!=="failed"||current.errorCode!=="patch_conflict"||!String(failed.result?.message||"").includes("Expected existing content does not match")||current.branch!==approvedBranch||["main","master"].includes(current.branch)||current.startingCommit!==oldCommit||oldCommit===currentCommit||completedAfterPlan||completedDelivery||approvals.some((approval)=>approval.runId===current.id)||current.metadata?.lastDeploymentId||current.metadata?.selfDevelopmentDeliveryAttestation||current.leaseOwner||remaining[0]?.type!=="apply_patch") throw new SelfDevelopmentError("stale_base_recovery_precondition_failed","Only the exact clean pre-commit stale-base patch conflict may be recovered.");
    const remote=await verifyRemote({repository,branch:current.branch,requiredAncestors:[oldCommit,currentCommit]});
    if(remote.currentTip!==currentCommit||remote.ancestors?.[oldCommit]!==true||remote.ancestors?.[currentCommit]!==true) throw new SelfDevelopmentError("base_revision_ancestry_mismatch","The new base is not the exact live descendant tip.");
    const implementation=planned.result.implementationPlan, evidencePaths=[...new Set([...(implementation.evidencePaths||[]),...implementation.files.map((file)=>file.path)].map(safePath))];
    if(!evidencePaths.length||evidencePaths.length>12||evidencePaths.some((path)=>REPLAN_PROTECTED.test(path))) throw new SelfDevelopmentError("stale_base_evidence_invalid","Bounded implementation evidence cannot be refreshed.");
    const base=current.metadata.steps.length, reads=evidencePaths.map((path,index)=>annotation(base+index+1,"read_files","repo_read_remote",{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}},`Current contents of ${path}`,"New-base evidence is read before replanning",{retry:"safe_read"})), replan={...planTemplate,input:{...planTemplate.input,arguments:{...planTemplate.input.arguments,taskId:current.id,candidatePaths:evidencePaths,currentCommit}},idempotencyIdentity:`${planTemplate.idempotencyIdentity||"self-development:plan_implementation"}:base-refresh:${currentCommit}`}, continuation=[...reads,replan,...remaining], maxSteps=Math.min(100,base+continuation.length);
    if(maxSteps<base+continuation.length) throw new SelfDevelopmentError("stale_base_recovery_budget_exceeded","Bounded recovery exceeds the safe step maximum.");
    const now=clock().toISOString(), record={previousBaseCommit:oldCommit,newBaseCommit:currentCommit,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,invalidatedEvidencePaths:evidencePaths,workingTreeClean:true,ancestryVerified:true,recoveredAt:now};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"stale_base_evidence_refresh",currentCommit,maxSteps,nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...current.metadata,steps:[...current.metadata.steps,...continuation],requiredCapability:"repo_read_remote",autoDispatch:true,selfDevelopmentImplementationPlan:null,baseRevisionHistory:[...(current.metadata.baseRevisionHistory||[]),record],staleContentEvidence:[...(current.metadata.staleContentEvidence||[]),{baseCommit:oldCommit,paths:evidencePaths,invalidatedAt:now}]}},current.stateVersion);
    if(!updated) throw new SelfDevelopmentError("version_conflict","Task changed during base-revision recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_base_revision_advanced",status:"queued",summary:"Task base advanced along verified feature history; stale content evidence requires bounded refresh.",metadata:{taskId:current.id,previousBaseCommit:oldCommit,newBaseCommit:currentCommit,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,invalidatedEvidencePaths:evidencePaths,workingTreeClean:true,ancestryVerified:true,maxSteps}});
    return{task:updated,previousBaseCommit:oldCommit,newBaseCommit:currentCommit,invalidatedEvidencePaths:evidencePaths,idempotent:false};
  }
  const canonicalWorkspaceRoot=value=>typeof value==="string"?value.replaceAll("\\","/").replace(/\/$/,"").replace(/^([a-z]):/i,(_,drive)=>`${drive.toUpperCase()}:`):value;
  const exactDirtyEvidence=(left,right)=>Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((item,index)=>item?.path===right[index]?.path&&item?.hashAlgorithm==="git_sha1"&&right[index]?.hashAlgorithm==="git_sha1"&&item?.hash===right[index]?.hash);
  async function recoverHandsCommitMismatch(taskId,input,{failureCode="commit_mismatch",recoveryClass="commit_mismatch_descendant_rebind",recoveryRoute="recover-hands-commit-mismatch"}={}){
    if(!input||Object.keys(input).some(key=>!["expectedVersion","runtimeVersion","workspace"].includes(key))||!Number.isInteger(input.expectedVersion)||!input.workspace||Object.keys(input.workspace).some(key=>!["root","gitTopLevel","head","clean","changedFiles"].includes(key))||!SHA.test(input.workspace.head||"")||typeof input.workspace.root!=="string"||input.workspace.root!==input.workspace.gitTopLevel||typeof input.workspace.clean!=="boolean"||(runtimeVersion!==undefined&&(!SHA.test(input.runtimeVersion||"")||input.runtimeVersion!==runtimeVersion)))
      throw new SelfDevelopmentError("hands_context_recovery_invalid","Exact version and bounded repository context are required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.handsContextRecoveryHistory?.find(item=>item.previousStateVersion===input.expectedVersion),priorPartial=current.metadata?.partialRepairPlanRecoveryHistory?.find(item=>item.previousStateVersion===input.expectedVersion);if(prior&&current.status!=="failed")return{task:current,recoveredStepId:prior.failedStepId,idempotent:true};if(priorPartial&&current.status!=="failed")return{task:current,recoveredStepId:priorPartial.failedStepId,requiredPaths:priorPartial.requiredPaths,recoveryCode:"repair_plan_incomplete",mutationApplied:false,idempotent:true};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before Hands-context recovery.");
    const steps=await runtime.steps(current.id),semantic=resolveSemanticPlanApplyState(current,steps,failureCode,{planStepTypes:["plan_implementation","plan_repair"]}),{failed,planned,planTemplate,remaining,completedAfterPlan}=semantic,approvals=await storage.listApprovals(ownerId,{limit:100}),oldCommit=current.currentCommit,newCommit=input.workspace.head,noMutation=failed?.result?.mutationApplied!==true&&failed?.result?.changed!==true&&!(failed?.result?.changedFiles||[]).length;
    if(current.status!=="failed"||current.errorCode!==failureCode||!failed||!planned||!noMutation||(runtimeVersion!==undefined&&current.metadata?.selfDevelopment?.repository!==repository)||current.branch!==approvedBranch||["main","master"].includes(current.branch)||!SHA.test(oldCommit||"")||!SHA.test(newCommit||"")||completedAfterPlan||approvals.some(approval=>approval.runId===current.id)||current.metadata?.lastDeploymentId||current.metadata?.selfDevelopmentDeliveryAttestation||current.leaseOwner||current.leaseToken||remaining[0]?.type!=="apply_patch")throw new SelfDevelopmentError("hands_context_recovery_precondition_failed","Only the exact pre-mutation Hands repository-context mismatch may be recovered.");
    if(!verifyRemote||!compareRemoteEvidence)throw new SelfDevelopmentError("hands_context_verification_unavailable","Remote ancestry and evidence verification are required.",503);
    const remote=await verifyRemote({repository,branch:current.branch,requiredAncestors:[oldCommit,newCommit]});if(remote.currentTip!==newCommit||remote.ancestors?.[oldCommit]!==true||remote.ancestors?.[newCommit]!==true)throw new SelfDevelopmentError("hands_context_ancestry_mismatch","The controlled checkout is not the exact live descendant feature tip.");
    const implementation=planned.result.implementationPlan,hasBoundPlan=Boolean(implementation?.provenance);if(hasBoundPlan)assertActiveImplementationPlan(current,implementation.files);const declaredDirty=Array.isArray(input.workspace.changedFiles)?input.workspace.changedFiles:[],replaceOnly=implementation.files.every(file=>file.operation==="replace"),expectedDirty=implementation.files.map(file=>({path:safePath(file.path),hashAlgorithm:"git_sha1",hash:gitBlobHash(file.expectedContent)})).sort((a,b)=>a.path.localeCompare(b.path)),expectedDirtyByPath=new Map(expectedDirty.map(item=>[item.path,item])),actualDirty=declaredDirty.map(item=>({path:safePath(item?.path),hashAlgorithm:item?.hashAlgorithm,hash:String(item?.hash||"").toLowerCase(),...(item?.contentHash?{contentHash:String(item.contentHash).toLowerCase()}:{})})).sort((a,b)=>a.path.localeCompare(b.path)),taskOwnedDirty=input.workspace.clean===false&&["commit_mismatch","working_tree_dirty"].includes(failureCode)&&hasBoundPlan&&replaceOnly&&actualDirty.length>0&&actualDirty.length<=expectedDirty.length&&actualDirty.every(item=>{const expected=expectedDirtyByPath.get(item.path);return expected&&item.hashAlgorithm==="git_sha1"&&item.hash===expected.hash;});
    if(failureCode==="working_tree_dirty"&&input.workspace.clean===false&&!taskOwnedDirty){
      const priorApply=steps.filter(step=>step.stepType==="apply_patch"&&step.status==="completed"&&stepOrdinal(step)<semantic.plannedOrdinal).at(-1),priorApplyOrdinal=stepOrdinal(priorApply),priorPlan=steps.filter(step=>["plan_implementation","plan_repair"].includes(step.stepType)&&step.status==="completed"&&stepOrdinal(step)<priorApplyOrdinal).at(-1),priorFiles=priorPlan?.result?.implementationPlan?.files,durableLineage=priorApply?.result?.taskOwnedDirtyLineage,lineageHasSourceApply=durableLineage&&Object.prototype.hasOwnProperty.call(durableLineage,"sourceApplyStepId"),canonicalSourceApplyStepId=lineageHasSourceApply?durableLineage.sourceApplyStepId:priorApply?.stepId,lineageEntries=Array.isArray(durableLineage?.entries)?durableLineage.entries.map(item=>({path:safePath(item?.path),contentHash:String(item?.contentHash||"").toLowerCase()})).sort((a,b)=>a.path.localeCompare(b.path)):[],completeLineageValid=durableLineage?.version===1&&durableLineage.taskId===current.id&&durableLineage.repository===repository&&durableLineage.branch===current.branch&&durableLineage.currentCommit===current.currentCommit&&canonicalSourceApplyStepId===priorApply?.stepId&&durableLineage.sourcePlanStepId===priorPlan?.stepId&&lineageEntries.length>0&&lineageEntries.length<=12&&new Set(lineageEntries.map(item=>item.path)).size===lineageEntries.length&&lineageEntries.every(item=>REVIEW_HASH.test(item.contentHash)&&!REPLAN_PROTECTED.test(item.path)),legacyPaths=Array.isArray(priorApply?.result?.files)?[...new Set(priorApply.result.files.map(safePath))].sort():[],appliedPaths=completeLineageValid?lineageEntries.map(item=>item.path):durableLineage==null?legacyPaths:[],priorByPath=new Map((priorFiles||[]).map(file=>[safePath(file.path),file])),lineageByPath=new Map(lineageEntries.map(item=>[item.path,item])),actualByPath=new Map(actualDirty.map(item=>[item.path,item])),entries=appliedPaths.map(path=>completeLineageValid?{...actualByPath.get(path),contentHash:lineageByPath.get(path)?.contentHash}:(()=>{const file=priorByPath.get(path);return typeof file?.content==="string"?{path,hashAlgorithm:"git_sha1",hash:gitBlobHash(file.content),contentHash:canonicalContentHash(file.content)}:null;})()),entryByPath=new Map(entries.filter(Boolean).map(item=>[item.path,item])),activePaths=[...new Set(implementation.files.map(file=>safePath(file.path)))].sort(),attestations=(await storage.listActivity(ownerId,{runId:current.id,limit:100})).filter(item=>item.action==="self_development_workspace_attested"),attestationEvent=attestations[0],attestation=attestationEvent?.metadata,attestationMatches=attestationEvent?.status==="completed"&&attestation?.attestationVersion===1&&attestation.representation==="current_verified_workspace_linked_to_historical_apply"&&attestation.historicalProvenanceClaim===false&&attestation.taskId===current.id&&attestation.taskStateVersion===current.stateVersion&&attestation.repository===repository&&attestation.branch===current.branch&&canonicalWorkspaceRoot(attestation.workspaceRoot)===canonicalWorkspaceRoot(input.workspace.root)&&attestation.productHead===current.currentCommit&&attestation.liveBranchTip===newCommit&&attestation.runtimeVersion===(runtimeVersion||null)&&typeof attestation.workerId==="string"&&Boolean(attestation.workerId.trim())&&attestation.sourceApplyStepId===priorApply?.stepId&&attestation.sourcePlanStepId===priorPlan?.stepId&&attestation.sourceApplyFingerprint===priorApply?.operationFingerprint&&exactDirtyEvidence(attestation.dirtyFiles,actualDirty)&&(!completeLineageValid||attestation.dirtyFiles.every((item,index)=>item?.contentHash===actualDirty[index]?.contentHash&&item?.contentHash===lineageEntries[index]?.contentHash)),exactPriorOutput=entries.length===appliedPaths.length&&entries.every(Boolean)&&actualDirty.length===entries.length&&actualDirty.every(item=>{const expected=entryByPath.get(item.path);return expected&&item.hashAlgorithm==="git_sha1"&&SHA.test(item.hash)&&(completeLineageValid?item.contentHash===expected.contentHash:item.hash===expected.hash);}),incompletePlan=activePaths.length<appliedPaths.length&&activePaths.every(path=>entryByPath.has(path)),scopeBound=appliedPaths.length>0&&appliedPaths.length<=12&&(completeLineageValid||appliedPaths.every(path=>(priorPlan.result.implementationPlan.evidencePaths||[]).map(safePath).includes(path)&&!REPLAN_PROTECTED.test(path))),workspaceBound=Boolean(attestationMatches);
      if(exactPriorOutput&&incompletePlan&&scopeBound&&workspaceBound){
        const base=current.metadata.steps.length,now=clock().toISOString(),failureEvidence={version:1,code:"repair_plan_incomplete",fingerprint:hash([current.id,current.stateVersion,priorPlan.stepId,priorApply.stepId,entries]),requiredPaths:appliedPaths,sourcePlanStepId:priorPlan.stepId,sourceApplyStepId:priorApply.stepId,mutationApplied:false},replan={...planTemplate,input:{...planTemplate.input,arguments:{...planTemplate.input.arguments,taskId:current.id,candidatePaths:appliedPaths,currentCommit:"$CURRENT_COMMIT",failureEvidence}},idempotencyIdentity:`${planTemplate.idempotencyIdentity||"self-development:plan_repair"}:complete-dirty-set:${base+1}`},continuation=[replan,...remaining],nextSteps=continuation.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:partial-repair-recovery:${base+index+1}`})),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass:"task_owned_dirty_partial_plan_replan",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"task_owned_dirty_partial_plan_replan",taskId:current.id,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,incompletePlanStepId:planned.stepId,sourcePlanStepId:priorPlan.stepId,sourceApplyStepId:priorApply.stepId,sourceApplyFingerprint:priorApply.operationFingerprint,repository,currentCommit:current.currentCommit,runtimeVersion:runtimeVersion||null,branch:current.branch,workspaceRoot:input.workspace.root,requiredPaths:appliedPaths,entries,fingerprint:failureEvidence.fingerprint,mutationApplied:false,activeContinuation,recoveredAt:now},generations=(current.metadata?.implementationPlanGenerations||[]).map(item=>item.authority==="active"?{...item,authority:"superseded",supersededReason:"repair_plan_incomplete"}:item);
        const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"plan_repair",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:"reasoning",autoDispatch:true,selfDevelopmentImplementationPlan:null,activeImplementationPlanGeneration:null,implementationPlanGenerations:generations,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],partialRepairPlanRecoveryHistory:[...(current.metadata?.partialRepairPlanRecoveryHistory||[]),record]}},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during partial repair-plan recovery.");
        await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_partial_repair_plan_recovery",status:"queued",summary:"A proven task-owned dirty set requires Nova to regenerate a complete bounded repair plan.",metadata:{taskId:current.id,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,requiredPaths:appliedPaths,sourcePlanStepId:priorPlan.stepId,sourceApplyStepId:priorApply.stepId,mutationApplied:false,continuationGenerationId:activeContinuation.generationId}});return{task:updated,recoveredStepId:failed.stepId,requiredPaths:appliedPaths,recoveryCode:"repair_plan_incomplete",mutationApplied:false,idempotent:false};
      }
    }
    if((failureCode==="working_tree_dirty"&&input.workspace.clean!==false)||(input.workspace.clean===true&&declaredDirty.length)||(input.workspace.clean===false&&!taskOwnedDirty))throw new SelfDevelopmentError("hands_context_recovery_dirty_unproven","A dirty checkout is allowed only when every changed file exactly matches the active plan's pre-mutation content.",400);
    const evidencePaths=[...new Set([...(implementation.evidencePaths||[]),...implementation.files.map(file=>file.path)].map(safePath))];if(!evidencePaths.length||evidencePaths.length>12||evidencePaths.some(path=>REPLAN_PROTECTED.test(path)))throw new SelfDevelopmentError("hands_context_evidence_invalid","Bounded implementation evidence cannot be verified.");
    const evidence=await compareRemoteEvidence({repository,paths:evidencePaths,oldCommit,newCommit}),changedPaths=evidencePaths.filter(path=>evidence[path]?.equivalent!==true),base=current.metadata.steps.length;
    const reads=changedPaths.map((path,index)=>annotation(base+index+1,"read_files","repo_read_remote",{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}},`Current contents of ${path}`,"Rebound evidence is read before replanning",{retry:"safe_read"})),replan=changedPaths.length?{...planTemplate,input:{...planTemplate.input,arguments:{...planTemplate.input.arguments,taskId:current.id,candidatePaths:evidencePaths,currentCommit:newCommit}},idempotencyIdentity:`${planTemplate.idempotencyIdentity||"self-development:plan_implementation"}:hands-rebind:${newCommit}`}:null,continuation=[...reads,...(replan?[replan]:[]),...remaining],nextSteps=continuation.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:hands-context-recovery:${base+index+1}`}));
    const reboundTask={...current,currentCommit:newCommit},reboundPlan=changedPaths.length?null:hasBoundPlan?rebindEquivalentImplementationPlan({task:reboundTask,plan:implementation,evidence:implementation.files.filter(file=>file.operation==="replace").map(file=>({path:file.path,content:file.expectedContent}))}):implementation,reboundMetadata=hasBoundPlan&&reboundPlan?planLifecycleMetadata(reboundTask,reboundPlan):current.metadata,now=clock().toISOString(),activeContinuation=createActiveContinuation({task:reboundTask,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass,runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,plannedStepId:planned.stepId,semanticPlanOrdinal:semantic.plannedOrdinal,semanticApplyOrdinal:semantic.failedOrdinal,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,runtimeVersion:runtimeVersion||null,ancestryVerified:true,evidence:Object.fromEntries(evidencePaths.map(path=>[path,{oldBlob:evidence[path].oldSha,newBlob:evidence[path].newSha,equivalent:evidence[path].equivalent===true}])),invalidatedEvidencePaths:changedPaths,repositoryRoot:input.workspace.root,gitTopLevel:input.workspace.gitTopLevel,workingTreeClean:input.workspace.clean,taskOwnedDirtyFiles:taskOwnedDirty?actualDirty:[],previousPlanGenerationId:implementation.provenance?.generationId||null,newPlanGenerationId:reboundPlan?.provenance?.generationId||null,activeContinuation,recoveredAt:now},requiredCapability=changedPaths.length?"repo_read_remote":"repo_mutate_local",status=changedPaths.length?"queued":"waiting_for_worker";
    let updated;try{updated=await storage.updateAutonomyTask(current.id,ownerId,{status,currentStep:base,currentPhase:"hands_repository_context_recovery",currentCommit:newCommit,nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata:{...reboundMetadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability,autoDispatch:true,selfDevelopmentImplementationPlan:changedPaths.length?null:reboundPlan,activeImplementationPlanGeneration:changedPaths.length?null:reboundPlan?.provenance?.generationId||current.metadata.activeImplementationPlanGeneration,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],handsContextRecoveryHistory:[...(current.metadata.handsContextRecoveryHistory||[]),record],baseRevisionHistory:[...(current.metadata.baseRevisionHistory||[]),{previousBaseCommit:oldCommit,newBaseCommit:newCommit,previousStateVersion:current.stateVersion,ancestryVerified:true,recoveredAt:now}] }},current.stateVersion);}catch(error){const internalCode=typeof error?.code==="string"&&/^[a-z0-9_]{1,80}$/i.test(error.code)&&!SECRET.test(error.code)?error.code:"storage_error";throw new SelfDevelopmentError("hands_context_recovery_persistence_failed","Hands-context recovery could not be persisted safely.",500,{recoveryRoute,recoveryClass,stage:"persistence",operation:"update_autonomy_task",taskId:current.id,stepId:failed.stepId,stepType:failed.stepType,internalCode,mutationStarted:true,mutationCompleted:false});}if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during Hands-context recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_hands_context_recovered",status,summary:"Exact pre-mutation Hands repository context and descendant task base were verified for bounded continuation.",metadata:{taskId:current.id,previousStateVersion:current.stateVersion,failedStepId:failed.stepId,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,ancestryVerified:true,invalidatedEvidencePaths:changedPaths,repositoryRoot:input.workspace.root,continuationGenerationId:activeContinuation.generationId,continuationStepBudget:activeContinuation.maxSteps}});
    return{task:updated,recoveredStepId:failed.stepId,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,invalidatedEvidencePaths:changedPaths,evidence,idempotent:false};
  }
  const recoverHandsWorkingTreeDirty=(taskId,input)=>recoverHandsCommitMismatch(taskId,input,{failureCode:"working_tree_dirty",recoveryClass:"task_owned_dirty_patch_resume",recoveryRoute:"recover-hands-working-tree-dirty"});
  async function attestHandsWorkspace(taskId,input,actor={}){
    const workspace=actor.workspaceProof,allowed=new Set(["expectedVersion","runtimeVersion","workerId","sourceApplyStepId","workspaceProof","workspaceProofSignature"]),workspaceKeys=new Set(["root","gitTopLevel","repository","branch","head","liveTip","clean","changedFiles"]);
    if(!input||Object.keys(input).some(key=>!allowed.has(key))||!Number.isInteger(input.expectedVersion)||!SHA.test(input.runtimeVersion||"")||input.runtimeVersion!==runtimeVersion||typeof input.workerId!=="string"||!input.workerId.trim()||!/^\d+:apply_patch$/.test(input.sourceApplyStepId||"")||!workspace||Object.keys(workspace).some(key=>!workspaceKeys.has(key))||typeof workspace.root!=="string"||workspace.root!==workspace.gitTopLevel||workspace.repository!==repository||workspace.branch!==approvedBranch||!SHA.test(workspace.head||"")||!SHA.test(workspace.liveTip||"")||workspace.clean!==false||actor.actorType!=="scoped_local_worker")throw new SelfDevelopmentError("workspace_attestation_invalid","Exact authenticated local-worker repository proof is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before workspace attestation.");
    if(current.status!=="failed"||current.currentCommit!==workspace.head||current.branch!==workspace.branch||current.metadata?.selfDevelopment?.repository!==workspace.repository||current.leaseOwner||current.leaseToken)throw new SelfDevelopmentError("workspace_attestation_precondition_failed","Only an exact failed task-bound repair state may be attested.");
    if(!verifyRemote)throw new SelfDevelopmentError("workspace_attestation_verification_unavailable","Live branch verification is required.",503);
    const remote=await verifyRemote({repository,branch:current.branch,requiredAncestors:[current.currentCommit]});if(remote.currentTip!==workspace.liveTip||workspace.liveTip!==current.currentCommit||remote.ancestors?.[current.currentCommit]!==true)throw new SelfDevelopmentError("workspace_attestation_remote_mismatch","Product HEAD and live branch tip must agree.");
    const steps=await runtime.steps(current.id),apply=steps.find(step=>step.stepId===input.sourceApplyStepId&&step.stepType==="apply_patch"&&step.status==="completed"),applyOrdinal=stepOrdinal(apply),plan=steps.filter(step=>["plan_implementation","plan_repair"].includes(step.stepType)&&step.status==="completed"&&stepOrdinal(step)<applyOrdinal).sort((a,b)=>stepOrdinal(a)-stepOrdinal(b)).at(-1),files=plan?.result?.implementationPlan?.files,latestApply=steps.filter(step=>step.stepType==="apply_patch"&&step.status==="completed").sort((a,b)=>stepOrdinal(a)-stepOrdinal(b)).at(-1),focusedFailure=steps.find(step=>stepOrdinal(step)===applyOrdinal+1&&step.stepType==="run_focused_tests"&&step.status==="failed"&&step.errorCode==="test_failed"),focusedDiagnostics=focusedFailure?.result?.diagnostics,focusedPlanPaths=new Set((plan?.result?.implementationPlan?.focusedTests||[]).map(item=>safePath(typeof item==="string"?item:item.path))),focusedFailedPaths=(focusedDiagnostics?.failedFiles||[]).map(safePath),noLaterStep=focusedFailure&&!steps.some(step=>stepOrdinal(step)>stepOrdinal(focusedFailure)),durableLineage=apply?.result?.taskOwnedDirtyLineage,lineageHasSourceApply=durableLineage&&Object.prototype.hasOwnProperty.call(durableLineage,"sourceApplyStepId"),canonicalSourceApplyStepId=lineageHasSourceApply?durableLineage.sourceApplyStepId:apply?.stepId,lineageEntries=Array.isArray(durableLineage?.entries)?durableLineage.entries.map(item=>({path:safePath(item?.path),contentHash:String(item?.contentHash||"").toLowerCase()})).sort((a,b)=>a.path.localeCompare(b.path)):[],completeLineageValid=durableLineage?.version===1&&durableLineage.taskId===current.id&&durableLineage.repository===repository&&durableLineage.branch===current.branch&&durableLineage.currentCommit===current.currentCommit&&canonicalSourceApplyStepId===apply?.stepId&&durableLineage.sourcePlanStepId===plan?.stepId&&lineageEntries.length>0&&lineageEntries.length<=12&&new Set(lineageEntries.map(item=>item.path)).size===lineageEntries.length&&lineageEntries.every(item=>REVIEW_HASH.test(item.contentHash)&&!REPLAN_PROTECTED.test(item.path)),testFailedEligible=current.errorCode==="test_failed"&&apply===latestApply&&current.currentStep===applyOrdinal&&plan?.stepType==="plan_repair"&&current.repairIteration>0&&focusedFailure&&noLaterStep&&typeof focusedDiagnostics?.fingerprint==="string"&&focusedDiagnostics.fingerprint&&focusedFailedPaths.length>0&&focusedFailedPaths.every(path=>focusedPlanPaths.has(path))&&completeLineageValid,workingTreeEligible=current.errorCode==="working_tree_dirty",attestationClass=testFailedEligible?"post_apply_focused_test_failure":"pre_mutation_working_tree_dirty";
    if(!workingTreeEligible&&!testFailedEligible)throw new SelfDevelopmentError("workspace_attestation_precondition_failed","Only exact pre-mutation dirt or an immediately post-apply bounded focused-test failure may be attested.");
    const legacyPaths=Array.isArray(apply?.result?.files)?[...new Set(apply.result.files.map(safePath))].sort():[],byPath=new Map((files||[]).map(file=>[safePath(file.path),file])),legacyExpected=legacyPaths.map(path=>{const file=byPath.get(path);return typeof file?.content==="string"?{path,hashAlgorithm:"git_sha1",hash:gitBlobHash(file.content)}:null;}),actual=(workspace.changedFiles||[]).map(item=>({path:safePath(item?.path),hashAlgorithm:item?.hashAlgorithm,hash:String(item?.hash||"").toLowerCase(),...(item?.contentHash?{contentHash:String(item.contentHash).toLowerCase()}:{})})).sort((a,b)=>a.path.localeCompare(b.path)),dirtyExact=completeLineageValid?actual.length===lineageEntries.length&&actual.every((item,index)=>item.path===lineageEntries[index].path&&item.hashAlgorithm==="git_sha1"&&SHA.test(item.hash)&&item.contentHash===lineageEntries[index].contentHash):durableLineage==null&&workingTreeEligible&&legacyPaths.length>0&&legacyPaths.length<=12&&!legacyExpected.some(item=>!item)&&actual.length===legacyExpected.length&&actual.every((item,index)=>item.path===legacyExpected[index].path&&item.hashAlgorithm==="git_sha1"&&item.hash===legacyExpected[index].hash);
    if(!apply||!plan||!dirtyExact)throw new SelfDevelopmentError("workspace_attestation_dirty_lineage_mismatch","Current dirty bytes do not exactly match the completed same-task apply lineage.");
    const sameDirtyEvidence=(left,right)=>exactDirtyEvidence(left,right)&&(!completeLineageValid||left.every((item,index)=>item?.contentHash===right[index]?.contentHash)),attestations=(await storage.listActivity(ownerId,{runId:current.id,limit:100})).filter(item=>item.action==="self_development_workspace_attested"),latest=attestations[0],value=latest?.metadata,exactPrior=latest?.status==="completed"&&value?.attestationVersion===1&&value.representation==="current_verified_workspace_linked_to_historical_apply"&&value.attestationClass===attestationClass&&value.historicalProvenanceClaim===false&&value.taskId===current.id&&value.taskStateVersion===current.stateVersion&&value.repository===repository&&value.branch===current.branch&&canonicalWorkspaceRoot(value.workspaceRoot)===canonicalWorkspaceRoot(workspace.root)&&value.productHead===current.currentCommit&&value.liveBranchTip===workspace.liveTip&&value.runtimeVersion===input.runtimeVersion&&value.workerId===input.workerId.trim()&&value.sourceApplyStepId===apply.stepId&&value.sourcePlanStepId===plan.stepId&&value.sourceApplyFingerprint===apply.operationFingerprint&&sameDirtyEvidence(value.dirtyFiles,actual);if(exactPrior)return{attestation:value,idempotent:true};
    const attestation={attestationId:randomUUID(),attestationVersion:1,representation:"current_verified_workspace_linked_to_historical_apply",attestationClass,historicalProvenanceClaim:false,taskId:current.id,taskStateVersion:current.stateVersion,repository,branch:current.branch,workspaceRoot:canonicalWorkspaceRoot(workspace.root),productHead:current.currentCommit,liveBranchTip:workspace.liveTip,runtimeVersion:input.runtimeVersion,workerId:input.workerId.trim(),sourceApplyStepId:apply.stepId,sourcePlanStepId:plan.stepId,sourceApplyFingerprint:apply.operationFingerprint,dirtyFiles:actual,supersedesAttestationId:value?.attestationId||null,attestedAt:clock().toISOString()};
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_workspace_attested",status:"completed",summary:"The authenticated local worker attested the current workspace state for a completed same-task apply lineage.",metadata:attestation});return{attestation,idempotent:false};
  }
  const recoverRepositoryContextFailure=(taskId,input)=>recoverHandsCommitMismatch(taskId,input,{failureCode:"repository_context_unproven",recoveryClass:"repository_context_descendant_rebind"});
  async function recoverPlanLifecycle(taskId,input){
    if(!input||Object.keys(input).some(key=>!["expectedVersion","workspace"].includes(key))||!Number.isInteger(input.expectedVersion)||!input.workspace||Object.keys(input.workspace).some(key=>!["root","gitTopLevel","head","clean"].includes(key))||!SHA.test(input.workspace.head||"")||input.workspace.clean!==true||input.workspace.root!==input.workspace.gitTopLevel)throw new SelfDevelopmentError("plan_lifecycle_recovery_invalid","Exact version and clean repository proof are required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.planLifecycleRecoveryHistory?.find(item=>item.previousStateVersion===input.expectedVersion);if(prior&&current.status!=="failed")return{task:current,idempotent:true,recovery:prior};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before plan-lifecycle recovery.");
    const steps=await runtime.steps(current.id),semantic=resolveSemanticPlanApplyState(current,steps,"patch_conflict"),{failed,planned,planTemplate,remaining,completedAfterPlan}=semantic,approvals=await storage.listApprovals(ownerId,{limit:100}),oldCommit=current.currentCommit,newCommit=currentCommit;
    const noMutation=failed.result?.mutationApplied!==true&&failed.result?.changed!==true&&!(failed.result?.changedFiles||[]).length;
    if(current.status!=="failed"||current.errorCode!=="patch_conflict"||!String(failed.result?.message||"").includes("Expected existing content does not match")||!noMutation||completedAfterPlan||approvals.some(item=>item.runId===current.id)||current.metadata?.lastDeploymentId||current.metadata?.selfDevelopmentDeliveryAttestation||current.leaseOwner||remaining[0]?.type!=="apply_patch"||current.branch!==approvedBranch||input.workspace.head!==newCommit||!SHA.test(newCommit||""))throw new SelfDevelopmentError("plan_lifecycle_recovery_precondition_failed","Only the exact pre-mutation stale-plan conflict may be recovered.");
    if(!verifyRemote||!compareRemoteEvidence)throw new SelfDevelopmentError("plan_lifecycle_verification_unavailable","Remote ancestry and evidence verification are required.",503);
    const remote=await verifyRemote({repository,branch:current.branch,requiredAncestors:[oldCommit,newCommit]});if(remote.currentTip!==newCommit||remote.ancestors?.[oldCommit]!==true||remote.ancestors?.[newCommit]!==true)throw new SelfDevelopmentError("plan_lifecycle_ancestry_mismatch","The corrective commit is not the exact descendant feature tip.");
    const implementation=planned.result.implementationPlan,evidencePaths=[...new Set([...(implementation.evidencePaths||[]),...implementation.files.map(file=>file.path)].map(safePath))];if(!evidencePaths.length||evidencePaths.length>12||evidencePaths.some(path=>REPLAN_PROTECTED.test(path)))throw new SelfDevelopmentError("plan_lifecycle_evidence_invalid","Bounded plan evidence cannot be refreshed.");
    const evidence=await compareRemoteEvidence({repository,paths:evidencePaths,oldCommit,newCommit}),base=current.metadata.steps.length,reads=evidencePaths.map((path,index)=>annotation(base+index+1,"read_files","repo_read_remote",{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}},`Complete contents of ${path}`,"Authoritative current-generation evidence is read before replanning",{retry:"safe_read"})),replan={...planTemplate,input:{...planTemplate.input,arguments:{...planTemplate.input.arguments,taskId:current.id,candidatePaths:evidencePaths,currentCommit:newCommit}},idempotencyIdentity:`${planTemplate.idempotencyIdentity||"self-development:plan_implementation"}:plan-generation:${newCommit}:${base}`},continuation=[...reads,replan,...remaining],nextSteps=continuation.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||`self-development:${step.type}`}:continuation:${base+index+1}`}));
    const rebound={...current,currentCommit:newCommit},now=clock().toISOString(),activeContinuation=createActiveContinuation({task:rebound,startStep:base,plannedSteps:nextSteps.length,repairLimit:current.metadata?.maxRepairIterations??2,recoveryClass:"plan_provenance_descendant_rebind",runtimeStartedAt:now,runtimeMinutes:15}),generations=(current.metadata?.implementationPlanGenerations||[]).map(item=>item.authority==="active"?{...item,authority:"superseded",supersededReason:"descendant_rebind_requires_replan"}:item),record={previousStateVersion:current.stateVersion,failedStepId:failed.stepId,plannedStepId:planned.stepId,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,evidence:Object.fromEntries(evidencePaths.map(path=>[path,{oldBlob:evidence[path].oldSha,newBlob:evidence[path].newSha,equivalent:evidence[path].equivalent===true}])),supersededPlanHash:implementation.planHash||null,activeContinuation,recoveredAt:now};
    const metadata={...current.metadata,steps:[...current.metadata.steps,...nextSteps],requiredCapability:"repo_read_remote",autoDispatch:true,selfDevelopmentImplementationPlan:null,activeImplementationPlanGeneration:null,implementationPlanGenerations:generations,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],planLifecycleRecoveryHistory:[...(current.metadata?.planLifecycleRecoveryHistory||[]),record],baseRevisionHistory:[...(current.metadata?.baseRevisionHistory||[]),{previousBaseCommit:oldCommit,newBaseCommit:newCommit,previousStateVersion:current.stateVersion,ancestryVerified:true,recoveredAt:now}]};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"plan_lifecycle_recovery",currentCommit:newCommit,nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,retryCount:0,blockedReason:null,checkpoint:{...current.checkpoint,pendingStep:null},metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during plan-lifecycle recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_plan_generation_recovered",status:"queued",summary:"Stale implementation authority was superseded and a bounded evidence-backed continuation was created.",metadata:{taskId:current.id,previousStateVersion:current.stateVersion,previousCurrentCommit:oldCommit,newCurrentCommit:newCommit,failedStepId:failed.stepId,evidencePaths,continuationGenerationId:activeContinuation.generationId,continuationStepBudget:activeContinuation.maxSteps}});
    return{task:updated,idempotent:false,recovery:record};
  }
  async function recoverFocusedTestEvidence(taskId, input) {
    if (
      !input ||
      Object.keys(input).some((key) => key !== "expectedVersion") ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "focused_test_evidence_recovery_invalid",
        "An exact task version is required.",
        400,
      );
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before focused-test evidence recovery.",
      );
    const steps = await runtime.steps(current.id),
      failed = steps.find(
        (step) =>
          step.stepId === `${current.currentStep + 1}:plan_implementation` &&
          step.status === "failed" &&
          step.errorCode === "implementation_scope_violation" &&
          step.result?.diagnostics?.validationIssues?.some((issue) =>
            [
              "focused_test_evidence_required",
              "focused_test_evidence_rejected",
            ].includes(issue),
          ),
      ),
      approvals = await storage.listApprovals(ownerId, { limit: 100 }),
      unsafe =
        steps.some((step) =>
          [
            "apply_patch",
            "run_focused_tests",
            "run_full_tests",
            "commit",
            "review_commit",
            "push",
            "deploy_preview",
          ].includes(step.stepType),
        ) || approvals.some((approval) => approval.runId === current.id);
    if (
      current.status !== "failed" ||
      current.errorCode !== "implementation_scope_violation" ||
      !failed ||
      unsafe ||
      current.currentCommit !== current.startingCommit
    )
      throw new SelfDevelopmentError(
        "focused_test_evidence_recovery_precondition_failed",
        "Only the exact pre-mutation focused-test evidence failure may be recovered.",
      );
    const now = clock().toISOString(),
      updated = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "queued",
          currentPhase: "focused_test_evidence_recovery",
          nextRunAt: now,
          startedAt: now,
          completedAt: null,
          errorCode: null,
          retryCount: 0,
          blockedReason: null,
          metadata: {
            ...current.metadata,
            requiredCapability: "reasoning",
            autoDispatch: true,
            focusedTestEvidenceRecoveryHistory: [
              ...(current.metadata.focusedTestEvidenceRecoveryHistory || []),
              {
                failedStepId: failed.stepId,
                previousStateVersion: current.stateVersion,
                recoveredAt: now,
              },
            ],
          },
        },
        current.stateVersion,
      );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during focused-test evidence recovery.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_focused_test_evidence_recovered",
      status: "queued",
      summary:
        "Exact pre-mutation focused-test evidence failure requeued for bounded expansion.",
      metadata: {
        taskId: current.id,
        failedStepId: failed.stepId,
        previousStateVersion: current.stateVersion,
      },
    });
    return { task: updated, recoveredStepId: failed.stepId };
  }
  async function recoverCreateConflict(taskId, input) {
    const allowed = new Set([
      "expectedVersion",
      "targetPath",
      "taskDiffHash",
      "workingTree",
    ]);
    if (
      !input ||
      Object.keys(input).some((key) => !allowed.has(key)) ||
      !Number.isInteger(input.expectedVersion) ||
      !Object.values(TASK_DIFF_DIGESTS).some((pattern) =>
        pattern.test(input.taskDiffHash || ""),
      ) ||
      input.workingTree?.clean !== true ||
      input.workingTree?.unrelatedChanges !== false
    )
      throw new SelfDevelopmentError(
        "create_conflict_recovery_invalid",
        "Exact version and clean task-owned worktree attestation are required.",
        400,
      );
    const targetPath = safePath(input.targetPath),
      current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    const prior = current.metadata?.createConflictRecoveryHistory?.find(
      (item) =>
        item.fromStateVersion === input.expectedVersion &&
        item.targetPath === targetPath &&
        item.taskDiffHash === input.taskDiffHash,
    );
    if (prior)
      return { task: current, idempotent: true, recoveredPath: targetPath };
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before create-conflict recovery.",
      );
    const durableTaskDiff = taskDiffEvidence(
      current,
      targetPath,
      input.expectedVersion,
    );
    if (input.taskDiffHash.toLowerCase() !== durableTaskDiff.digest)
      throw new SelfDevelopmentError(
        "create_conflict_evidence_mismatch",
        "Caller task-diff evidence does not match the immutable durable evidence.",
      );
    const steps = await runtime.steps(current.id),
      approvals = await storage.listApprovals(ownerId, { limit: 100 }),
      implementation = current.metadata?.selfDevelopmentImplementationPlan,
      planned = implementation?.files?.find(
        (file) => file.path === targetPath && file.operation === "create",
      ),
      patch = steps.find(
        (step) =>
          step.stepType === "apply_patch" &&
          step.status === "completed" &&
          step.result?.files?.includes(targetPath),
      ),
      focused = steps.find(
        (step) =>
          step.stepType === "run_focused_tests" && step.status === "completed",
      ),
      failedFull = steps.find(
        (step) =>
          step.stepType === "run_full_tests" &&
          step.status === "failed" &&
          step.errorCode === "test_failed",
      ),
      delivery =
        steps.some((step) =>
          ["commit", "review_commit", "push", "deploy_preview"].includes(
            step.stepType,
          ),
        ) ||
        current.currentCommit !== current.startingCommit ||
        current.approvalState ||
        current.metadata?.lastDeploymentId ||
        current.metadata?.selfDevelopmentDeliveryAttestation ||
        approvals.some((approval) => approval.runId === current.id);
    if (
      current.status !== "failed" ||
      current.errorCode !== "test_failed" ||
      !planned ||
      !patch ||
      !focused ||
      !failedFull ||
      delivery
    )
      throw new SelfDevelopmentError(
        "create_conflict_recovery_precondition_failed",
        "Only the exact audited post-patch create-over-existing failure may be recovered.",
      );
    if (REPLAN_PROTECTED.test(targetPath) || !targetPath.startsWith("test/"))
      throw new SelfDevelopmentError(
        "create_conflict_recovery_scope_forbidden",
        "Recovery target is outside the bounded test scope.",
        403,
      );
    if (typeof resolvePathState !== "function")
      throw new SelfDevelopmentError(
        "create_conflict_recovery_unavailable",
        "Authoritative repository existence verification is unavailable.",
        503,
      );
    const pathState = await resolvePathState(targetPath, current.currentCommit);
    if (!pathState?.existsInCommit)
      throw new SelfDevelopmentError(
        "create_conflict_target_missing",
        "The create-conflict target does not exist in the bound commit.",
      );
    const candidates = [
        ...new Set([...(implementation.evidencePaths || []), targetPath]),
      ],
      base = current.metadata.steps.length,
      continuation = [];
    continuation.push(
      annotation(
        base + 1,
        "read_files",
        "repo_read_remote",
        {
          tool: "repo_read",
          arguments: { path: targetPath, startLine: 1, endLine: 1000 },
        },
        `Complete contents of ${targetPath}`,
        "Existing target is evidence-read before replanning",
        { retry: "safe_read" },
      ),
    );
    continuation.push(
      annotation(
        base + 2,
        "plan_implementation",
        "reasoning",
        {
          tool: "self_development_plan_implementation",
          arguments: {
            taskId: current.id,
            candidatePaths: candidates,
            currentCommit: current.currentCommit,
          },
        },
        "Nova-generated corrected implementation plan",
        "Planner receives authoritative existing-file evidence",
        { retry: "new_evidence_required" },
      ),
    );
    continuation.push(
      annotation(
        base + 3,
        "apply_patch",
        "repo_mutate_local",
        {
          tool: "repo_apply_patch",
          arguments: {
            branch: current.branch,
            currentCommit: "$CURRENT_COMMIT",
            files: "$IMPLEMENTATION_FILES",
          },
        },
        "Corrected bounded files changed",
        "Invalid create attempt is never replayed",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + 4,
        "run_focused_tests",
        "test_local",
        {
          tool: "test_run",
          arguments: { files: "$IMPLEMENTATION_TESTS", timeoutMs: 180000 },
        },
        "Focused test report",
        "Corrected focused tests pass",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + 5,
        "run_full_tests",
        "test_local",
        { tool: "test_run_full", arguments: { timeoutMs: 180000 } },
        "Full test report",
        "Complete suite passes",
        { retry: "repair_required" },
      ),
    );
    continuation.push(
      annotation(
        base + 6,
        "inspect_diff",
        "repo_read_remote",
        { tool: "repo_diff", arguments: { paths: "$IMPLEMENTATION_PATHS" } },
        "Complete bounded diff review",
        "Corrected diff is fully reviewed",
        { retry: "safe_read" },
      ),
    );
    continuation.push(
      annotation(
        base + 7,
        "commit",
        "repo_mutate_local",
        {
          tool: "git_commit",
          arguments: {
            paths: "$IMPLEMENTATION_PATHS",
            branch: current.branch,
            message: "Complete bounded Nova self-development task",
          },
        },
        "Exact local commit SHA",
        "One reviewed local commit created",
        { retry: "idempotent_commit" },
      ),
    );
    continuation.push(
      annotation(
        base + 8,
        "review_commit",
        "repo_read_remote",
        {
          tool: "repo_review_commit",
          arguments: {
            commitSha: "$CURRENT_COMMIT",
            paths: "$IMPLEMENTATION_PATHS",
          },
        },
        "Exact immutable commit review",
        "Commit matches the corrected reviewed change-set",
        { retry: "not_retryable" },
      ),
    );
    for (const step of plan({
      ...current.metadata.selfDevelopment,
      scope: {
        ...current.metadata.selfDevelopment.scope,
        patch: { files: [{ path: "placeholder", content: "placeholder" }] },
      },
    }).filter((step) =>
      [
        "push",
        "deploy_preview",
        "wait",
        "verify_preview",
        "summarize",
      ].includes(step.type),
    ))
      continuation.push({
        ...step,
        idempotencyIdentity: `self-development:${base + continuation.length + 1}:${hash([step.type, clean(step.input)])}`,
      });
    const now = clock().toISOString(),
      record = {
        recoveryClass: "post_patch_create_over_existing",
        fromStateVersion: current.stateVersion,
        targetPath,
        taskDiffHash: durableTaskDiff.digest,
        taskDiffEvidence: durableTaskDiff,
        priorPlanHash: implementation.planHash || null,
        priorPatchStepId: patch.stepId,
        priorFocusedStepId: focused.stepId,
        priorFailedStepId: failedFull.stepId,
        pathState: {
          exists: true,
          existsInCommit: true,
          discovered: (implementation.evidencePaths || []).includes(targetPath),
        },
        recoveredAt: now,
      };
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        currentStep: base,
        currentPhase: "create_conflict_evidence_read",
        nextRunAt: now,
        startedAt: now,
        completedAt: null,
        errorCode: null,
        retryCount: 0,
        blockedReason: null,
        maxSteps: Math.min(
          100,
          base +
            continuation.length +
            (current.metadata.maxRepairIterations || 2) * 6,
        ),
        metadata: {
          ...current.metadata,
          steps: [...current.metadata.steps, ...continuation],
          requiredCapability: "repo_read_remote",
          autoDispatch: true,
          authoritativePathStates: {
            ...(current.metadata.authoritativePathStates || {}),
            [targetPath]: {
              exists: true,
              existsInCommit: true,
              commitSha: current.currentCommit,
            },
          },
          createConflictRecoveryHistory: [
            ...(current.metadata.createConflictRecoveryHistory || []),
            record,
          ],
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during create-conflict recovery.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_create_conflict_recovered",
      status: "queued",
      summary:
        "Audited create-over-existing attempt superseded; existing target scheduled for evidence read.",
      metadata: {
        taskId: current.id,
        targetPath,
        taskDiffHash: durableTaskDiff.digest,
        taskDiffAlgorithm: durableTaskDiff.algorithm,
        fromStateVersion: current.stateVersion,
        priorFailedStepId: failedFull.stepId,
      },
    });
    return {
      task: updated,
      idempotent: false,
      recoveredPath: targetPath,
      pathState: { exists: true, existsInCommit: true },
    };
  }
  async function recoverCreateConflictBudget(taskId, input) {
    if (
      !input ||
      Object.keys(input).some((key) => key !== "expectedVersion") ||
      !Number.isInteger(input.expectedVersion)
    )
      throw new SelfDevelopmentError(
        "create_conflict_budget_recovery_invalid",
        "An exact state version is required.",
        400,
      );
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    const priorBudgetRecovery =
      current.metadata?.createConflictBudgetRecoveryHistory?.find(
        (entry) => entry.fromStateVersion === input.expectedVersion,
      );
    if (priorBudgetRecovery)
      return { task: current, idempotent: true, maxSteps: current.maxSteps };
    if (current.stateVersion !== input.expectedVersion)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed before recovery-budget repair.",
      );
    const recovery = current.metadata?.createConflictRecoveryHistory?.at(-1),
      steps = await runtime.steps(current.id),
      approvals = await storage.listApprovals(ownerId, { limit: 100 }),
      postRecoveryExecution = steps.some((step) => {
        const index = Number.parseInt(step.stepId, 10);
        return Number.isInteger(index) && index > current.currentStep;
      }),
      delivery =
        steps.some((step) =>
          ["commit", "review_commit", "push", "deploy_preview"].includes(
            step.stepType,
          ),
        ) ||
        current.currentCommit !== current.startingCommit ||
        current.approvalState ||
        current.metadata?.lastDeploymentId ||
        current.metadata?.selfDevelopmentDeliveryAttestation ||
        approvals.some((approval) => approval.runId === current.id);
    if (
      current.status !== "failed" ||
      current.errorCode !== "max_steps_reached" ||
      current.currentPhase !== "create_conflict_evidence_read" ||
      !recovery ||
      recovery.recoveryClass !== "post_patch_create_over_existing" ||
      postRecoveryExecution ||
      delivery ||
      current.leaseOwner ||
      current.leaseToken ||
      current.leaseExpiresAt
    )
      throw new SelfDevelopmentError(
        "create_conflict_budget_recovery_precondition_failed",
        "Only the exact unexecuted post-create-conflict budget failure may be recovered.",
      );
    const repairLimit = Math.max(
        1,
        Math.min(3, current.metadata?.maxRepairIterations || 2),
      ),
      planLength = current.metadata.steps.length,
      maxSteps = Math.min(100, planLength + repairLimit * 6);
    if (maxSteps <= current.currentStep)
      throw new SelfDevelopmentError(
        "create_conflict_budget_exhausted",
        "The bounded recovery plan cannot fit within the safe step limit.",
      );
    const now = clock().toISOString(),
      record = {
        recoveryClass: "post_create_conflict_max_steps_reached",
        fromStateVersion: current.stateVersion,
        currentStep: current.currentStep,
        priorMaxSteps: current.maxSteps,
        planLength,
        repairLimit,
        maxSteps,
        recoveredAt: now,
      },
      updated = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "queued",
          maxSteps,
          nextRunAt: now,
          completedAt: null,
          errorCode: null,
          blockedReason: null,
          retryCount: 0,
          metadata: {
            ...current.metadata,
            requiredCapability: "repo_read_remote",
            autoDispatch: true,
            createConflictBudgetRecoveryHistory: [
              ...(current.metadata.createConflictBudgetRecoveryHistory || []),
              record,
            ],
          },
        },
        current.stateVersion,
      );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during recovery-budget repair.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_create_conflict_budget_recovered",
      status: "queued",
      summary:
        "Persisted a bounded step budget for the pending create-conflict continuation.",
      metadata: record,
    });
    return { task: updated, idempotent: false, maxSteps };
  }
  async function recoverReview(taskId, input) {
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (
      current.status !== "waiting_for_approval" ||
      current.currentPhase !== "commit" ||
      current.approvalState?.approvalId !== input?.approvalId ||
      current.currentCommit !== input?.expectedCommit
    )
      throw new SelfDevelopmentError(
        "review_recovery_precondition_failed",
        "Exact waiting approval state does not match.",
      );
    const approval = await storage.getApproval(input.approvalId, ownerId),
      steps = await runtime.steps(current.id),
      incomplete = [...steps]
        .reverse()
        .find(
          (step) =>
            step.stepType === "inspect_diff" && step.status === "completed",
        );
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.tool !== "git_push" ||
      approval.arguments?.commitSha !== current.currentCommit ||
      incomplete?.result?.reviewedChangeSet?.reviewHash
    )
      throw new SelfDevelopmentError(
        "review_recovery_precondition_failed",
        "Only an incomplete reviewed change-set may be recovered.",
      );
    await storage.decideApproval(approval.id, ownerId, "rejected");
    const paths = current.metadata.selfDevelopment.scope.patch.files.map(
        (file) => file.path,
      ),
      continuation = [
        annotation(
          current.currentStep + 1,
          "review_commit",
          "repo_read_remote",
          {
            tool: "repo_review_commit",
            arguments: { commitSha: current.currentCommit, paths },
          },
          "Exact committed change-set review",
          "Commit contains only fully reviewed bounded text files",
          { retry: "not_retryable" },
        ),
        ...plan(current.metadata.selfDevelopment).filter((step) =>
          [
            "push",
            "deploy_preview",
            "wait",
            "verify_preview",
            "summarize",
          ].includes(step.type),
        ),
      ],
      updated = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "waiting_for_worker",
          approvalState: null,
          blockedReason: "Exact local commit review required.",
          metadata: {
            ...current.metadata,
            steps: [
              ...current.metadata.steps.slice(0, current.currentStep),
              ...continuation,
            ],
            requiredCapability: "repo_read_remote",
          },
        },
        current.stateVersion,
      );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during review recovery.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_review_recovery_started",
      status: "waiting",
      summary:
        "Incomplete pre-commit review invalidated; exact local commit review required.",
      metadata: {
        taskId: current.id,
        invalidatedApprovalId: approval.id,
        commitSha: current.currentCommit,
      },
    });
    return { task: updated, invalidatedApprovalId: approval.id };
  }
  async function supersedeCommit(taskId, input) {
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    if (
      current.status !== "waiting_for_approval" ||
      current.approvalState?.approvalId !== input?.approvalId ||
      current.currentCommit !== input?.supersededCommit ||
      !SHA.test(input?.baseCommit || "")
    )
      throw new SelfDevelopmentError(
        "commit_supersession_precondition_failed",
        "Exact waiting approval state does not match.",
      );
    const approval = await storage.getApproval(input.approvalId, ownerId);
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.tool !== "git_push" ||
      approval.arguments?.branch !== current.branch ||
      approval.arguments?.commitSha !== current.currentCommit
    )
      throw new SelfDevelopmentError(
        "commit_supersession_precondition_failed",
        "Exact pending push approval does not match.",
      );
    const request = current.metadata.selfDevelopment,
      generated = plan(request),
      types = new Set([
        "apply_patch",
        "inspect_diff",
        "commit",
        "push",
        "deploy_preview",
        "wait",
        "verify_preview",
        "summarize",
      ]),
      continuation = generated.filter((step) => types.has(step.type)),
      commitIndex = continuation.findIndex((step) => step.type === "commit");
    continuation.splice(
      commitIndex + 1,
      0,
      annotation(
        current.currentStep + commitIndex + 2,
        "review_commit",
        "repo_read_remote",
        {
          tool: "repo_review_commit",
          arguments: {
            commitSha: "$CURRENT_COMMIT",
            paths: request.scope.patch.files.map((file) => file.path),
          },
        },
        "Exact committed change-set review",
        "Commit contains only the reviewed bounded change-set",
        { retry: "not_retryable" },
      ),
    );
    await storage.decideApproval(approval.id, ownerId, "rejected");
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "waiting_for_worker",
        currentCommit: input.baseCommit,
        approvalState: null,
        blockedReason:
          "Reviewed acceptance change must be recreated on the current feature history.",
        metadata: {
          ...current.metadata,
          steps: [
            ...current.metadata.steps.slice(0, current.currentStep),
            ...continuation,
          ],
          requiredCapability: "repo_mutate_local",
          supersededCommit: {
            sha: current.currentCommit,
            reason: "branch_history_safety",
            pushed: false,
          },
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during commit supersession.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_commit_superseded",
      status: "waiting",
      summary:
        "Unpushed acceptance commit superseded for branch-history safety.",
      metadata: {
        taskId: current.id,
        supersededCommit: current.currentCommit,
        baseCommit: input.baseCommit,
        invalidatedApprovalId: approval.id,
      },
    });
    return { task: updated, invalidatedApprovalId: approval.id };
  }
  async function attestDelivery(taskId, input) {
    if (!verifyRemote || !verifyDeployment)
      throw new SelfDevelopmentError(
        "attestation_unavailable",
        "Delivery attestation is unavailable.",
        503,
      );
    const allowed = new Set([
      "approvalId",
      "commitSha",
      "branch",
      "deploymentId",
      "deploymentUrl",
      "preCommitReviewHash",
      "finalCommitReviewHash",
    ]);
    if (
      !input ||
      Object.keys(input).some((key) => !allowed.has(key)) ||
      input.branch !== approvedBranch ||
      !SHA.test(input.commitSha || "") ||
      !REVIEW_HASH.test(input.preCommitReviewHash || "") ||
      !REVIEW_HASH.test(input.finalCommitReviewHash || "")
    )
      throw new SelfDevelopmentError(
        "delivery_attestation_invalid",
        "Exact delivery attestation with both review bindings is required.",
        400,
      );
    const current = await runtime.get(taskId),
      prior = current?.metadata?.selfDevelopmentDeliveryAttestation;
    if (
      prior &&
      prior.approvalId === input.approvalId &&
      prior.commitSha === input.commitSha &&
      prior.deploymentId === input.deploymentId &&
      prior.preCommitReviewHash === input.preCommitReviewHash &&
      prior.finalCommitReviewHash === input.finalCommitReviewHash
    )
      return { task: current, approvalId: input.approvalId, idempotent: true };
    const approval = await storage.getApproval(input.approvalId, ownerId);
    if (
      !current ||
      current.taskType !== "self_development" ||
      current.status !== "waiting_for_approval" ||
      current.currentCommit !== input.commitSha ||
      current.branch !== input.branch ||
      current.approvalState?.approvalId !== input.approvalId
    )
      throw new SelfDevelopmentError(
        "delivery_attestation_precondition_failed",
        "Exact task approval state does not match.",
      );
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.runId !== current.id ||
      approval.tool !== "git_push" ||
      approval.arguments?.branch !== input.branch ||
      approval.arguments?.commitSha !== input.commitSha
    )
      throw new SelfDevelopmentError(
        "delivery_attestation_precondition_failed",
        "Exact pending approval does not match.",
      );
    const steps = await runtime.steps(current.id),
      commitIndex = steps.findLastIndex(
        (step) =>
          step.stepType === "commit" &&
          step.status === "completed" &&
          step.result?.commitSha === input.commitSha,
      ),
      preCommitReview = steps.findLast(
        (step, index) =>
          index < commitIndex &&
          step.stepType === "inspect_diff" &&
          step.status === "completed" &&
          step.result?.reviewedChangeSet?.reviewHash ===
            input.preCommitReviewHash,
      ),
      finalCommitReview = steps.findLast(
        (step, index) =>
          index > commitIndex &&
          step.stepType === "review_commit" &&
          step.status === "completed" &&
          step.result?.commitSha === input.commitSha &&
          step.result?.reviewedChangeSet?.reviewHash ===
            input.finalCommitReviewHash,
      );
    if (
      commitIndex < 0 ||
      steps[commitIndex]?.result?.reviewHash !== input.preCommitReviewHash ||
      !preCommitReview
    )
      throw new SelfDevelopmentError(
        "pre_commit_review_binding_mismatch",
        "Durable pre-commit review does not match.",
      );
    if (!finalCommitReview)
      throw new SelfDevelopmentError(
        "final_commit_review_binding_mismatch",
        "Durable immutable commit review does not match.",
      );
    if (
      current.metadata.steps[current.currentStep]?.type !== "push" ||
      current.metadata.steps[current.currentStep + 1]?.type !== "deploy_preview"
    )
      throw new SelfDevelopmentError(
        "delivery_attestation_precondition_failed",
        "Task is not at its exact delivery boundary.",
      );
    const remote = await verifyRemote({
      repository,
      branch: input.branch,
      requiredAncestors: [input.commitSha, DELIVERY_ATTESTATION_SHA],
    });
    if (
      !SHA.test(remote?.currentTip || "") ||
      remote?.ancestors?.[input.commitSha] !== true
    )
      throw new SelfDevelopmentError(
        "accepted_commit_ancestry_mismatch",
        "Accepted commit is not an exact ancestor of the live feature tip.",
      );
    if (remote?.ancestors?.[DELIVERY_ATTESTATION_SHA] !== true)
      throw new SelfDevelopmentError(
        "attestation_fix_ancestry_mismatch",
        "Delivery-attestation fix is not an exact ancestor of the live feature tip.",
      );
    const deployment = await verifyDeployment({
      deploymentId: input.deploymentId,
    });
    if (
      deployment?.target === "production" ||
      deployment?.id !== input.deploymentId ||
      deployment?.url !== input.deploymentUrl ||
      deployment?.sha !== input.commitSha ||
      deployment?.branch !== input.branch ||
      deployment?.status !== "READY"
    )
      throw new SelfDevelopmentError(
        "deployment_binding_mismatch",
        "Exact READY Preview does not match.",
      );
    await storage.decideApproval(approval.id, ownerId, "approved");
    const first = current.currentStep + 1,
      completed = [
        ...(current.checkpoint?.completedSteps || []),
        `${first}:push`,
        `${first + 1}:deploy_preview`,
      ],
      reviewBindings = {
        preCommitReviewHash: input.preCommitReviewHash,
        finalCommitReviewHash: input.finalCommitReviewHash,
      },
      result = {
        ok: true,
        attested: true,
        commitSha: input.commitSha,
        deploymentId: input.deploymentId,
        url: input.deploymentUrl,
        status: "READY",
        ...reviewBindings,
      };
    const attestation = {
      approvalId: input.approvalId,
      commitSha: input.commitSha,
      deploymentId: input.deploymentId,
      ...reviewBindings,
    };
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        currentStep: current.currentStep + 2,
        currentPhase: "deploy_preview",
        nextRunAt: clock().toISOString(),
        approvalState: null,
        blockedReason: null,
        checkpoint: {
          ...current.checkpoint,
          completedSteps: completed,
          latestResult: result,
        },
        metadata: {
          ...current.metadata,
          requiredCapability: null,
          selfDevelopmentDeliveryAttestation: attestation,
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during delivery attestation.",
      );
    for (const [offset, type] of [
      [0, "push"],
      [1, "deploy_preview"],
    ])
      await storage.recordAutonomyStep({
        taskId: current.id,
        stepId: `${first + offset}:${type}`,
        stepType: type,
        capability: "verified_delivery_attestation",
        operationFingerprint: hash([
          current.id,
          type,
          input.commitSha,
          input.deploymentId,
          ...Object.values(reviewBindings),
        ]),
        input: { attestation: true },
        status: "completed",
        result,
        completedAt: clock().toISOString(),
      });
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_delivery_attested",
      status: "completed",
      summary: "Verified the exact approved feature push and READY Preview.",
      metadata: {
        taskId: current.id,
        commitSha: input.commitSha,
        approvalId: input.approvalId,
        deploymentId: input.deploymentId,
        ...reviewBindings,
      },
    });
    return { task: updated, approvalId: approval.id, idempotent: false };
  }
  async function repair(taskId, input) {
    const current = await runtime.get(taskId);
    if (!current || current.taskType !== "self_development")
      throw new SelfDevelopmentError(
        "task_not_found",
        "Self-development task not found.",
        404,
      );
    const durableSteps = await runtime.steps(current.id),
      latestFocusedFailure = durableSteps
        .filter(
          (step) =>
            step.stepType === "run_focused_tests" &&
            step.status === "failed" &&
            step.errorCode === "test_failed",
        )
        .at(-1),
      focusedFailureOrdinal = stepOrdinal(latestFocusedFailure),
      deliveredAfterFocused = durableSteps.some(
        (step) =>
          stepOrdinal(step) > focusedFailureOrdinal &&
          ["commit", "review_commit", "push", "deploy_preview"].includes(
            step.stepType,
          ) &&
          step.status === "completed",
      ),
      legacyEmptyRepairCompletion =
        current.status === "completed" &&
        current.currentPhase === "inspect_failure" &&
        Boolean(latestFocusedFailure) &&
        !deliveredAfterFocused &&
        durableSteps.slice(-2).map((step) => step.stepType).join("|") ===
          "inspect_failure|summarize",
      priorEmptyRepairRecovery = (
        current.metadata?.continuationHistory || []
      ).some(
        (item) => item.recoveryClass === "focused_test_empty_repair_recovery",
      ),
      falseRepairBudgetConsumed =
        legacyEmptyRepairCompletion ||
        (current.status === "failed" &&
          current.errorCode === "repair_limit_reached" &&
          priorEmptyRepairRecovery),
      effectiveRepairIteration = falseRepairBudgetConsumed
        ? Math.max(0, current.repairIteration - 1)
        : current.repairIteration;
    if (
      !["failed", "retrying"].includes(current.status) &&
      !legacyEmptyRepairCompletion
    )
      throw new SelfDevelopmentError(
        "repair_state_invalid",
        "Task is not repairable.",
      );
    const evidence = boundedText(input?.evidence, "repair evidence", 4000),
      fingerprint = hash([current.currentStep, current.errorCode, evidence]);
    const history = current.metadata?.repairHistory || [],
      limit = current.metadata?.maxRepairIterations || 3;
    if (history.some((item) => item.fingerprint === fingerprint))
      throw new SelfDevelopmentError(
        "identical_repair_rejected",
        "Repeated repair requires new evidence.",
      );
    if (effectiveRepairIteration >= limit) {
      const stopped = await storage.updateAutonomyTask(
        current.id,
        ownerId,
        {
          status: "failed",
          errorCode: "repair_limit_reached",
          completedAt: clock().toISOString(),
        },
        current.stateVersion,
      );
      await storage.appendActivity({
        ownerId,
        projectId: current.projectId,
        runId: current.id,
        action: "self_development_repair_limit_reached",
        status: "failed",
        summary: "Self-development repair limit reached.",
        metadata: {
          taskId: current.id,
          repairIteration: current.repairIteration,
        },
      });
      return { task: stopped, repairLimitReached: true };
    }
    const repairRequest = structure({
        ...current.metadata.selfDevelopment,
        scope: {
          ...current.metadata.selfDevelopment.scope,
          patch: input.patch,
          focusedTests:
            input.focusedTests ||
            current.metadata.selfDevelopment.scope.focusedTests,
        },
      }),
      allowed =
        current.currentStep === 0
          ? [
              "inspect_repo",
              "search_code",
              "read_files",
              "plan_patch",
              "authorize_protected_change",
              "apply_patch",
              "run_focused_tests",
              "run_full_tests",
              "inspect_diff",
              "commit",
              "push",
              "deploy_preview",
              "wait",
              "verify_preview",
              "summarize",
            ]
          : [
              "authorize_protected_change",
              "apply_patch",
              "run_focused_tests",
              "run_full_tests",
              "inspect_diff",
              "commit",
              "push",
              "deploy_preview",
              "wait",
              "verify_preview",
              "summarize",
            ],
      activePlan = current.metadata?.selfDevelopmentImplementationPlan,
      focusedRepairSteps = latestFocusedFailure
        ? [
            { type: "plan_repair", input: { tool: "self_development_plan_implementation", arguments: { taskId: current.id, candidatePaths: (activePlan?.files || []).map((file) => file.path), currentCommit: "$CURRENT_COMMIT", failureEvidence: latestFocusedFailure.result?.diagnostics } }, idempotencyIdentity: `focused-test-repair-plan:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "apply_patch", input: { tool: "repo_apply_patch", arguments: { branch: "$TASK_BRANCH", currentCommit: "$CURRENT_COMMIT", files: "$IMPLEMENTATION_FILES", planProvenance: "$IMPLEMENTATION_PLAN_PROVENANCE" } }, idempotencyIdentity: `focused-test-repair-patch:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "run_focused_tests", input: { tool: "test_run", arguments: { files: "$IMPLEMENTATION_TESTS" } }, idempotencyIdentity: `focused-test-repair-focused:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "run_full_tests", input: { tool: "test_run_full", arguments: {} }, idempotencyIdentity: `focused-test-repair-full:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "inspect_diff", input: { tool: "repo_diff", arguments: { paths: "$IMPLEMENTATION_PATHS" } }, idempotencyIdentity: `focused-test-repair-diff:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "commit", input: { tool: "git_commit", arguments: { paths: "$IMPLEMENTATION_PATHS", branch: current.branch, message: "Complete bounded Nova self-development task" } }, idempotencyIdentity: `focused-test-repair-commit:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
            { type: "review_commit", input: { tool: "repo_review_commit", arguments: { commitSha: "$CURRENT_COMMIT", paths: "$IMPLEMENTATION_PATHS" } }, idempotencyIdentity: `focused-test-repair-review:${latestFocusedFailure.result?.diagnostics?.fingerprint}` },
          ]
        : null,
      repairSteps = focusedRepairSteps || plan(repairRequest).filter((step) =>
        allowed.includes(step.type),
      ),
      prefix = latestFocusedFailure
        ? current.metadata.steps
        : current.metadata.steps.slice(0, current.currentStep),
      inspection = annotation(
        prefix.length + 1,
        "inspect_failure",
        "reasoning",
        { failureCode: current.errorCode, evidenceHash: fingerprint },
        "Failure evidence classified",
        "Repair decision uses new evidence",
        { retry: "not_retryable" },
      ),
      steps = [...prefix, inspection, ...repairSteps],
      continuationStart = prefix.length,
      now = clock().toISOString(),
      activeContinuation = latestFocusedFailure
        ? createActiveContinuation({ task: current, startStep: continuationStart, plannedSteps: repairSteps.length + 1, repairLimit: Math.min(2, current.metadata?.selfDevelopment?.repairLimit ?? 2), recoveryClass: legacyEmptyRepairCompletion ? "focused_test_empty_repair_recovery" : "structured_focused_test_repair", runtimeStartedAt: now, runtimeMinutes: 15 })
        : current.metadata?.activeContinuation;
    const updated = await storage.updateAutonomyTask(
      current.id,
      ownerId,
      {
        status: "queued",
        currentStep: latestFocusedFailure ? continuationStart : current.currentStep,
        currentPhase: latestFocusedFailure ? "plan_repair" : current.currentPhase,
        nextRunAt: now,
        errorCode: null,
        completedAt: null,
        retryCount: 0,
        repairIteration: effectiveRepairIteration + 1,
        metadata: {
          ...current.metadata,
          steps,
          requiredCapability: "reasoning",
          repairHistory: [
            ...history,
            {
              fingerprint,
              failureCode: current.errorCode,
              createdAt: clock().toISOString(),
            },
          ],
          ...(latestFocusedFailure
            ? {
                activeContinuation,
                continuationHistory: [
                  ...(current.metadata?.continuationHistory || []),
                  activeContinuation,
                ],
                autoDispatch: true,
                ...(falseRepairBudgetConsumed
                  ? {
                      focusedTestRepairBudgetRecoveryHistory: [
                        ...(current.metadata
                          ?.focusedTestRepairBudgetRecoveryHistory || []),
                        {
                          recoveryClass:
                            "empty_focused_repair_budget_reclassification",
                          fromStateVersion: current.stateVersion,
                          previousRepairIteration: current.repairIteration,
                          effectiveRepairIteration,
                          recoveredAt: now,
                        },
                      ],
                    }
                  : {}),
              }
            : {}),
        },
      },
      current.stateVersion,
    );
    if (!updated)
      throw new SelfDevelopmentError(
        "version_conflict",
        "Task changed during repair planning.",
      );
    await storage.appendActivity({
      ownerId,
      projectId: current.projectId,
      runId: current.id,
      action: "self_development_repair_started",
      status: "queued",
      summary: "Bounded self-development repair planned from new evidence.",
      metadata: {
        taskId: current.id,
        repairIteration: updated.repairIteration,
        evidenceHash: fingerprint,
      },
    });
    return { task: updated, repairLimitReached: false };
  }
  function isEscalatedRepairExhaustion(current,failed,ordinal,limit){
    if(current.repairIteration<limit)return false;
    if(current.errorCode==="repair_limit_reached")return true;
    return current.errorCode==="test_failed"&&failed?.stepType==="run_focused_tests"&&failed.status==="failed"&&failed.errorCode==="test_failed"&&ordinal===current.currentStep+1;
  }
  async function requestEscalatedRepair(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("escalated_repair_request_invalid","An exact state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before escalated-repair approval was requested.");
    const steps=await runtime.steps(current.id),focusedFailures=steps.filter(step=>step.stepType==="run_focused_tests"&&step.status==="failed"&&step.errorCode==="test_failed"),failed=focusedFailures.at(-1),ordinal=stepOrdinal(failed),diagnostics=failed?.result?.diagnostics,counts=diagnostics?.counts||{},plan=current.metadata?.selfDevelopmentImplementationPlan,activePaths=new Set((plan?.files||[]).map(file=>safePath(file.path))),failedFiles=[...(diagnostics?.failedFiles||[])].map(safePath),priorProgress=focusedFailures.slice(0,-1).some(step=>Number(step.result?.diagnostics?.counts?.failed)>Number(counts.failed)),delivered=steps.some(step=>stepOrdinal(step)>ordinal&&["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"),limit=current.metadata?.maxRepairIterations||3,fingerprint=diagnostics?.fingerprint;
    if(current.status!=="failed"||!isEscalatedRepairExhaustion(current,failed,ordinal,limit)||!failed||ordinal!==current.currentStep+1||counts.failed!==1||!Number.isInteger(counts.tests)||counts.tests<2||counts.passed!==counts.tests-1||failedFiles.length!==1||!failedFiles.every(path=>activePaths.has(path))||!priorProgress||delivered||current.approvalState||current.leaseOwner||!fingerprint||current.branch!==approvedBranch||current.metadata?.selfDevelopment?.repository!==repository||!plan?.provenance||current.metadata?.activeImplementationPlanGeneration!==plan.provenance.generationId||plan.provenance.taskId!==current.id||plan.provenance.currentCommit!==current.currentCommit||current.metadata?.escalatedRepairHistory?.length)throw new SelfDevelopmentError("escalated_repair_precondition_failed","Only one narrowly bounded, progress-proven repair-limit exception may request approval.");
    const arguments_={taskId:current.id,expectedVersion:current.stateVersion,branch:current.branch,currentCommit:current.currentCommit,failedStepId:failed.stepId,failureFingerprint:fingerprint,planGenerationId:plan.provenance.generationId,maxAdditionalAttempts:1},existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool==="self_development_escalated_repair"&&item.arguments?.taskId===current.id&&item.arguments?.expectedVersion===current.stateVersion&&item.arguments?.failureFingerprint===fingerprint&&["pending","approved"].includes(item.status));if(existing)return{task:current,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:current.projectId,runId:null,tool:"self_development_escalated_repair",reason:"Owner approval is required for one exact, bounded Nova repair attempt after genuine repair-limit exhaustion.",riskLevel:"SENSITIVE",arguments:arguments_});
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_escalated_repair_approval_requested",status:"waiting",summary:"One exact additional Nova repair attempt requires owner approval.",metadata:{taskId:current.id,approvalId:approval.id,expectedVersion:current.stateVersion,failedStepId:failed.stepId,failureFingerprint:fingerprint,maxAdditionalAttempts:1}});return{task:current,approval,idempotent:false};
  }
  async function recoverEscalatedRepair(taskId,input){
    if(!input||Object.keys(input).some(key=>!["expectedVersion","approvalId"].includes(key))||!Number.isInteger(input.expectedVersion)||typeof input.approvalId!=="string")throw new SelfDevelopmentError("escalated_repair_recovery_invalid","Exact version and approval are required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);const prior=current.metadata?.escalatedRepairHistory?.find(item=>item.fromStateVersion===input.expectedVersion&&item.approvalId===input.approvalId);if(prior)return{task:current,recovery:prior,idempotent:true};if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before escalated repair recovery.");
    const approval=await storage.getApproval(input.approvalId,ownerId),steps=await runtime.steps(current.id),focusedFailures=steps.filter(step=>step.stepType==="run_focused_tests"&&step.status==="failed"&&step.errorCode==="test_failed"),failed=focusedFailures.at(-1),ordinal=stepOrdinal(failed),diagnostics=failed?.result?.diagnostics,counts=diagnostics?.counts||{},plan=current.metadata?.selfDevelopmentImplementationPlan,activePaths=new Set((plan?.files||[]).map(file=>safePath(file.path))),failedFiles=[...(diagnostics?.failedFiles||[])].map(safePath),priorProgress=focusedFailures.slice(0,-1).some(step=>Number(step.result?.diagnostics?.counts?.failed)>Number(counts.failed)),delivered=steps.some(step=>stepOrdinal(step)>ordinal&&["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"),args=approval?.arguments||{},limit=current.metadata?.maxRepairIterations||3;
    if(!approval||approval.status!=="approved"||approval.tool!=="self_development_escalated_repair"||args.taskId!==current.id||args.expectedVersion!==current.stateVersion||args.branch!==current.branch||args.currentCommit!==current.currentCommit||args.failedStepId!==failed?.stepId||args.failureFingerprint!==diagnostics?.fingerprint||args.planGenerationId!==plan?.provenance?.generationId||args.maxAdditionalAttempts!==1||current.status!=="failed"||!isEscalatedRepairExhaustion(current,failed,ordinal,limit)||current.branch!==approvedBranch||current.metadata?.selfDevelopment?.repository!==repository||ordinal!==current.currentStep+1||counts.failed!==1||counts.passed!==counts.tests-1||failedFiles.length!==1||!failedFiles.every(path=>activePaths.has(path))||!priorProgress||delivered||current.approvalState||current.leaseOwner||current.metadata?.escalatedRepairHistory?.length)throw new SelfDevelopmentError("escalated_repair_recovery_precondition_failed","The approved repair-limit exception no longer matches the exact bounded failure.");
    assertActiveImplementationPlan(current,plan.files);const base=current.metadata.steps.length,repairSteps=[{type:"plan_repair",input:{tool:"self_development_plan_implementation",arguments:{taskId:current.id,candidatePaths:[...activePaths],currentCommit:"$CURRENT_COMMIT",failureEvidence:diagnostics}},idempotencyIdentity:`escalated-repair-plan:${diagnostics.fingerprint}`},{type:"apply_patch",input:{tool:"repo_apply_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}},idempotencyIdentity:`escalated-repair-patch:${diagnostics.fingerprint}`},{type:"run_focused_tests",input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}},idempotencyIdentity:`escalated-repair-focused:${diagnostics.fingerprint}`},{type:"run_full_tests",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:`escalated-repair-full:${diagnostics.fingerprint}`},{type:"inspect_diff",input:{tool:"repo_diff",arguments:{paths:"$IMPLEMENTATION_PATHS"}},idempotencyIdentity:`escalated-repair-diff:${diagnostics.fingerprint}`},{type:"commit",input:{tool:"git_commit",arguments:{paths:"$IMPLEMENTATION_PATHS",branch:current.branch,message:"Complete bounded Nova self-development task"}},idempotencyIdentity:`escalated-repair-commit:${diagnostics.fingerprint}`},{type:"review_commit",input:{tool:"repo_review_commit",arguments:{commitSha:"$CURRENT_COMMIT",paths:"$IMPLEMENTATION_PATHS"}},idempotencyIdentity:`escalated-repair-review:${diagnostics.fingerprint}`}],now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:repairSteps.length,repairLimit:1,recoveryClass:"owner_approved_single_repair_extension",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"owner_approved_single_repair_extension",fromStateVersion:current.stateVersion,approvalId:approval.id,failedStepId:failed.stepId,failureFingerprint:diagnostics.fingerprint,planGenerationId:plan.provenance.generationId,previousRepairIteration:current.repairIteration,globalRepairLimit:limit,maxAdditionalAttempts:1,recoveredAt:now},metadata={...current.metadata,steps:[...current.metadata.steps,...repairSteps],requiredCapability:"reasoning",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],escalatedRepairHistory:[record]};const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",currentStep:base,currentPhase:"owner_approved_escalated_repair",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during escalated repair recovery.");await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_escalated_repair_recovered",status:"queued",summary:"Owner-approved single additional Nova repair attempt started.",metadata:{taskId:current.id,...record}});return{task:updated,recovery:record,idempotent:false};
  }
  async function recoverFullTestHandoffOverflow(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("full_test_handoff_recovery_invalid","An exact state version is required.",400);const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);const prior=current.metadata?.fullTestHandoffRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,recovery:prior,idempotent:true};if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before full-test handoff recovery.");
    const steps=await runtime.steps(current.id),failed=steps.filter(step=>step.stepType==="run_full_tests"&&step.status==="failed"&&step.errorCode==="handoff_failed").at(-1),failedOrdinal=stepOrdinal(failed),focused=steps.filter(step=>step.stepType==="run_focused_tests"&&step.status==="completed"&&stepOrdinal(step)<failedOrdinal).at(-1),delivered=steps.some(step=>stepOrdinal(step)>failedOrdinal&&["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"),plan=current.metadata?.selfDevelopmentImplementationPlan,next=current.metadata?.steps?.[current.currentStep];if(current.status!=="failed"||current.errorCode!=="handoff_failed"||!failed||failedOrdinal!==current.currentStep+1||!focused||delivered||current.approvalState||current.leaseOwner||next?.type!=="run_full_tests"||!plan?.provenance||current.metadata?.activeImplementationPlanGeneration!==plan.provenance.generationId||plan.provenance.taskId!==current.id||plan.provenance.currentCommit!==current.currentCommit)throw new SelfDevelopmentError("full_test_handoff_recovery_precondition_failed","Only the exact post-focused, pre-delivery full-test handoff failure may be recovered.");assertActiveImplementationPlan(current,plan.files);
    const remaining=current.metadata.steps.slice(current.currentStep),base=current.metadata.steps.length;if(!remaining.length||remaining.length>8||remaining[0].type!=="run_full_tests")throw new SelfDevelopmentError("full_test_handoff_recovery_budget_exceeded","The remaining full-test continuation is not safely bounded.");const recoverySteps=remaining.map((step,index)=>({...step,idempotencyIdentity:`${step.idempotencyIdentity||step.type}:bounded-result-recovery:${base+index+1}`})),now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:recoverySteps.length,repairLimit:0,recoveryClass:"full_test_result_envelope_recovery",runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass:"full_test_result_envelope_recovery",fromStateVersion:current.stateVersion,failedStepId:failed.stepId,focusedStepId:focused.stepId,maxResultBytes:20000,recoveredAt:now},metadata={...current.metadata,steps:[...current.metadata.steps,...recoverySteps],requiredCapability:"test_local",autoDispatch:true,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],fullTestHandoffRecoveryHistory:[...(current.metadata?.fullTestHandoffRecoveryHistory||[]),record]};const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentPhase:"full_test_handoff_recovery",nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during full-test handoff recovery.");await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_full_test_handoff_recovered",status:"waiting_for_worker",summary:"The bounded full-test completion envelope was reopened without another repair attempt.",metadata:{taskId:current.id,...record}});return{task:updated,recovery:record,idempotent:false};
  }
  async function recoverFullTestFailure(taskId,input){
    if(!input||Object.keys(input).some(key=>!["expectedVersion","workspace"].includes(key))||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("full_test_recovery_invalid","An exact state version and bounded workspace proof are required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.fullTestFailureRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,idempotent:true,recovery:prior};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before full-test recovery.");
    const workspace=input.workspace||{},root=String(workspace.root||"").replaceAll("\\","/").replace(/\/$/,""),top=String(workspace.gitTopLevel||"").replaceAll("\\","/").replace(/\/$/,""),changed=[...(workspace.changedPaths||[])].map(safePath).sort(),planned=(current.metadata?.selfDevelopmentImplementationPlan?.files||[]).map(file=>safePath(file.path)).sort(),steps=await runtime.steps(current.id),failed=steps.filter(step=>step.stepType==="run_full_tests"&&step.status==="failed").at(-1),focused=steps.some(step=>step.stepType==="run_focused_tests"&&step.status==="completed"),patched=steps.some(step=>step.stepType==="apply_patch"&&step.status==="completed"),delivered=steps.some(step=>["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed");
    if(current.status!=="failed"||current.errorCode!=="test_failed"||!failed||!focused||!patched||delivered||current.approvalState||current.leaseOwner||root!==top||!root||workspace.head!==currentCommit||changed.join("|")!==planned.join("|")||!/^[a-f0-9]{40}$/.test(workspace.taskDiffHash||""))throw new SelfDevelopmentError("full_test_recovery_precondition_failed","Only the exact task-owned post-full-test failure may be recovered.");
    const remote=await verifyRemote?.({repository,branch:current.branch,requiredAncestors:[current.currentCommit,currentCommit]});if(!remote||remote.currentTip!==currentCommit||remote.ancestors?.[current.currentCommit]!==true)throw new SelfDevelopmentError("full_test_recovery_ancestry_mismatch","The deployed commit is not a verified descendant of the task commit.");
    const failedOrdinal=Number.parseInt(failed.stepId,10),remaining=current.metadata.steps.slice(failedOrdinal),base=current.metadata.steps.length,recoverySteps=[{type:"run_full_tests",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:`full-test-diagnostic:${workspace.taskDiffHash}`},...remaining],now=clock().toISOString(),record={recoveryClass:"structured_full_test_evidence_reconstruction",fromStateVersion:current.stateVersion,previousCurrentCommit:current.currentCommit,currentCommit,failedStepId:failed.stepId,taskDiffHash:workspace.taskDiffHash,changedPaths:changed,recoveredAt:now};
    const metadata={...current.metadata,steps:[...current.metadata.steps,...recoverySteps],requiredCapability:"test_local",autoDispatch:true,activeContinuation:createActiveContinuation({task:current,startStep:base,plannedSteps:recoverySteps.length,repairLimit:Math.min(2,current.metadata?.selfDevelopment?.repairLimit??2),recoveryClass:record.recoveryClass,runtimeStartedAt:now,runtimeMinutes:15}),fullTestFailureRecoveryHistory:[...(current.metadata.fullTestFailureRecoveryHistory||[]),record]};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentCommit,maxSteps:Math.min(100,Math.max(current.maxSteps,base+recoverySteps.length+4)),nextRunAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during full-test recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_full_test_failure_recovered",status:"waiting_for_worker",summary:"Exact task-owned full-suite failure was requeued for structured diagnostic evidence.",metadata:record});return{task:updated,idempotent:false,recovery:record};
  }
  async function recoverTestRunnerInfrastructure(taskId,input){
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("test_runner_recovery_invalid","An exact state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.testRunnerInfrastructureRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,idempotent:true,recovery:prior};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before test-runner recovery.");
    const active=current.metadata?.activeContinuation,nextStep=current.metadata?.steps?.[current.currentStep],stuckReasoning=current.status==="waiting_for_worker"&&!current.errorCode&&current.currentPhase==="test_runner_infrastructure_recovery"&&active?.recoveryClass==="post_runner_repair_evidence_rebind"&&current.metadata?.requiredCapability==="reasoning"&&nextStep?.type==="plan_repair"&&!current.leaseOwner&&!current.leaseToken&&!current.approvalState;
    if(stuckReasoning){const now=clock().toISOString(),runtimeMinutes=15,runtimeWindow={runtimeStartedAt:now,runtimeMinutes,runtimeDeadline:new Date(new Date(now).getTime()+runtimeMinutes*60000).toISOString()},record={recoveryClass:"post_runner_reasoning_dispatch_rebind",fromStateVersion:current.stateVersion,continuationGenerationId:active.generationId,recoveredAt:now},metadata={...current.metadata,activeContinuation:{...active,...runtimeWindow},testRunnerInfrastructureRecoveryHistory:[...(current.metadata.testRunnerInfrastructureRecoveryHistory||[]),record]};const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",nextRunAt:now,startedAt:now,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during reasoning-dispatch recovery.");await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_reasoning_dispatch_recovered",status:"queued",summary:"The exact evidence-bound repair continuation was rebound to server reasoning dispatch.",metadata:{taskId:current.id,...record}});return{task:updated,idempotent:false,recovery:record};}
    const steps=await runtime.steps(current.id),failed=steps.filter(step=>step.stepType==="run_full_tests"&&step.status==="failed"&&step.errorCode==="test_failed").at(-1),latestFailed=steps.filter(step=>step.status==="failed").at(-1),evidence=failed?.result?.diagnostics,failedOrdinal=stepOrdinal(failed),latestFailedOrdinal=stepOrdinal(latestFailed),isNpmUnavailable=value=>value?.identity?.command==="npm:test"&&value?.durationMs===0&&value?.exitCode===1&&value?.stderrExcerpt==="spawn npm ENOENT"&&Array.isArray(value.failedFiles)&&value.failedFiles.length===0&&Array.isArray(value.failedTitles)&&value.failedTitles.length===0&&value?.counts&&Object.values(value.counts).every(item=>item===null),isGitUnavailable=value=>value?.identity?.command==="npm:test"&&value?.exitCode===1&&value?.errorMessage==="A validated Git executable is unavailable."&&value?.failedFiles?.includes("test/git-execution.test.js")&&value?.stdoutExcerpt?.includes("spawn git ENOENT"),isUnavailable=value=>isNpmUnavailable(value)||isGitUnavailable(value),history=current.metadata?.fullTestRepairHistory||[],matchingHistory=history.filter(item=>item.fingerprint===evidence?.fingerprint&&item.failedStepId===failed?.stepId),invalidHistory=history.filter(item=>item.fingerprint===evidence?.fingerprint&&steps.some(step=>step.stepId===item.failedStepId&&isUnavailable(step.result?.diagnostics))),plan=current.metadata?.selfDevelopmentImplementationPlan,latestFocused=steps.filter(step=>step.stepType==="run_focused_tests"&&step.status==="completed"&&stepOrdinal(step)<failedOrdinal).at(-1),focusedOrdinal=stepOrdinal(latestFocused),mutationAfterFocused=steps.some(step=>stepOrdinal(step)>focusedOrdinal&&stepOrdinal(step)<failedOrdinal&&((step.stepType==="apply_patch"&&step.status==="completed")||step.result?.mutationApplied===true||(["commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"))),focused=Boolean(latestFocused)&&!mutationAfterFocused,direct=current.errorCode==="repair_limit_reached"&&latestFailed===failed&&failedOrdinal===current.currentStep+1&&isNpmUnavailable(evidence),contaminated=current.errorCode==="implementation_scope_violation"&&latestFailed?.stepType==="plan_repair"&&latestFailedOrdinal===current.currentStep+1&&latestFailed?.result?.diagnostics?.validationIssues?.includes("focused_test_evidence_required")&&failedOrdinal<latestFailedOrdinal&&isGitUnavailable(evidence),infrastructureHistory=current.metadata?.testRunnerInfrastructureRecoveryHistory||[],legacyInfrastructureRecovery=infrastructureHistory.some(item=>item.recoveryClass==="test_runner_git_path_reclassification"&&item.fromStateVersion<current.stateVersion),recordedFixRecovery=infrastructureHistory.some(item=>item.recoveryClass==="post_runner_repair_evidence_rebind"&&item.infrastructureFixEvidence?.branch===CONTROL_PLANE_BRANCH&&item.infrastructureFixEvidence?.minimumFixSha===FULL_TEST_EVIDENCE_EXPANSION_FIX_SHA),planDiagnostics=latestFailed?.result?.diagnostics||{},validationIssues=Array.isArray(planDiagnostics.validationIssues)?planDiagnostics.validationIssues:[],historicalEvidenceGap=validationIssues.includes("focused_test_evidence_required"),extensionHistory=current.metadata?.escalatedRepairHistory||[],extension=extensionHistory.at(-1),extensionApproval=extension?.approvalId?await storage.getApproval(extension.approvalId,ownerId):null,extensionArgs=extensionApproval?.arguments||{},consumedExtension=extensionHistory.length===1&&extension?.recoveryClass==="owner_approved_single_repair_extension"&&extension?.maxAdditionalAttempts===1&&Number.isInteger(extension?.globalRepairLimit)&&extension?.previousRepairIteration===extension.globalRepairLimit&&current.repairIteration===extension.globalRepairLimit&&extensionApproval?.status==="approved"&&extensionApproval?.tool==="self_development_escalated_repair"&&extensionArgs.taskId===current.id&&extensionArgs.expectedVersion===extension.fromStateVersion&&extensionArgs.branch===current.branch&&extensionArgs.currentCommit===current.currentCommit&&extensionArgs.failedStepId===extension.failedStepId&&extensionArgs.failureFingerprint===extension.failureFingerprint&&extensionArgs.planGenerationId===extension.planGenerationId&&extensionArgs.maxAdditionalAttempts===1,currentRejectedEvidenceGap=validationIssues.includes("focused_test_evidence_rejected")&&planDiagnostics.rejectionCode==="focused_test_evidence_rejected"&&planDiagnostics.classification==="nonexistent_invalid"&&latestFailed?.result?.message==="Focused test is not eligible for bounded evidence expansion."&&typeof planDiagnostics.proposedPath==="string"&&Array.isArray(evidence?.failedFiles)&&evidence.failedFiles.map(safePath).includes(safePath(planDiagnostics.proposedPath))&&Number.isInteger(planDiagnostics.expansionRound)&&planDiagnostics.expansionRound>0&&Number.isInteger(planDiagnostics.plannerAttempt)&&planDiagnostics.plannerAttempt>0&&current.branch===approvedBranch&&current.metadata?.selfDevelopment?.repository===REPOSITORY&&consumedExtension,lineageEligible=currentRejectedEvidenceGap&&(infrastructureHistory.length===0||recordedFixRecovery),remoteLineage=lineageEligible&&SHA.test(runtimeVersion||"")&&typeof verifyRemote==="function"?await verifyRemote({repository,branch:CONTROL_PLANE_BRANCH,requiredAncestors:[FULL_TEST_EVIDENCE_EXPANSION_FIX_SHA,runtimeVersion]}):null,historicalInfrastructureRecovery=Boolean(remoteLineage)&&remoteLineage.currentTip===runtimeVersion&&remoteLineage.ancestors?.[FULL_TEST_EVIDENCE_EXPANSION_FIX_SHA]===true&&remoteLineage.ancestors?.[runtimeVersion]===true,infrastructureRecovery=legacyInfrastructureRecovery||historicalInfrastructureRecovery,evidenceGapIssue=historicalEvidenceGap||currentRejectedEvidenceGap,contradictoryMutation=steps.some(step=>stepOrdinal(step)>failedOrdinal&&stepOrdinal(step)<=latestFailedOrdinal&&((step.stepType==="apply_patch"&&step.status==="completed")||step.result?.mutationApplied===true||(["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"))),repairEvidenceGap=current.errorCode==="implementation_scope_violation"&&latestFailed?.stepType==="plan_repair"&&latestFailedOrdinal===current.currentStep+1&&evidenceGapIssue&&failedOrdinal<latestFailedOrdinal&&!isUnavailable(evidence)&&matchingHistory.length===1&&infrastructureRecovery&&!contradictoryMutation,delivered=steps.some(step=>["commit","review_commit","push","deploy_preview"].includes(step.stepType)&&step.status==="completed"&&stepOrdinal(step)>failedOrdinal);
    if(current.status!=="failed"||(!direct&&!contaminated&&!repairEvidenceGap)||!failed||(!repairEvidenceGap&&!invalidHistory.length)||!focused||delivered||current.approvalState||current.leaseOwner||!plan?.provenance||current.metadata?.activeImplementationPlanGeneration!==plan.provenance.generationId||plan.provenance.taskId!==current.id||plan.provenance.currentCommit!==current.currentCommit)throw new SelfDevelopmentError("test_runner_recovery_precondition_failed","Only an exact false repair-limit, contaminated repair plan, or its evidence-bound repair continuation may be recovered.");
    assertActiveImplementationPlan(current,plan.files);
    const invalidIds=new Set(invalidHistory.map(item=>item.failedStepId)),continuations=[...(current.metadata?.continuationHistory||[]),current.metadata?.activeContinuation].filter(Boolean),sourceContinuation=continuations.find(item=>item.startStep===failedOrdinal-1&&item.recoveryClass==="test_runner_unavailable_reclassification"),nextContinuationStart=sourceContinuation?Math.min(...continuations.map(item=>item.startStep).filter(start=>start>sourceContinuation.startStep)):Infinity,remainingEnd=contaminated&&Number.isFinite(nextContinuationStart)?nextContinuationStart:current.metadata.steps.length,remaining=repairEvidenceGap?current.metadata.steps.slice(latestFailedOrdinal-1):current.metadata.steps.slice(failedOrdinal,remainingEnd),base=current.metadata.steps.length,recoverySteps=repairEvidenceGap?remaining:[{type:"run_full_tests",input:{tool:"test_run_full",arguments:{}},idempotencyIdentity:`test-runner-infrastructure-recovery:${evidence.fingerprint}`},...remaining];
    if(recoverySteps.length>15)throw new SelfDevelopmentError("test_runner_recovery_budget_exceeded","The active test continuation exceeds its safe bound.");
    const now=clock().toISOString(),recoveryClass=repairEvidenceGap?"post_runner_repair_evidence_rebind":isGitUnavailable(evidence)?"test_runner_git_path_reclassification":"test_runner_unavailable_reclassification",activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:recoverySteps.length,repairLimit:Math.min(2,current.metadata?.selfDevelopment?.repairLimit??2),recoveryClass,runtimeStartedAt:now,runtimeMinutes:15}),record={recoveryClass,fromStateVersion:current.stateVersion,failedStepId:failed.stepId,terminalFailedStepId:latestFailed.stepId,fingerprint:evidence.fingerprint,retiredRepairHistoryStepIds:[...invalidIds],...(historicalInfrastructureRecovery?{infrastructureFixEvidence:{branch:CONTROL_PLANE_BRANCH,minimumFixSha:FULL_TEST_EVIDENCE_EXPANSION_FIX_SHA,runtimeVersion,verifiedRemoteTip:remoteLineage.currentTip}}:{}),recoveredAt:now},metadata={...current.metadata,steps:[...current.metadata.steps,...recoverySteps],requiredCapability:repairEvidenceGap?"reasoning":"test_local",autoDispatch:true,fullTestRepairHistory:history.filter(item=>!invalidIds.has(item.failedStepId)),activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],testRunnerInfrastructureRecoveryHistory:[...(current.metadata?.testRunnerInfrastructureRecoveryHistory||[]),record]};
    const recoveryStatus=repairEvidenceGap?"queued":"waiting_for_worker",updated=await storage.updateAutonomyTask(current.id,ownerId,{status:recoveryStatus,currentStep:base,currentPhase:"test_runner_infrastructure_recovery",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:null,retryCount:0,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during test-runner recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_test_runner_infrastructure_recovered",status:recoveryStatus,summary:repairEvidenceGap?"The exact evidence-classification interruption was revalidated and its bounded repair continuation reopened.":"A false repair-limit caused by unavailable local test execution was reclassified and the bounded full-test continuation reopened.",metadata:{taskId:current.id,...record}});return{task:updated,idempotent:false,recovery:record};
  }
  async function resumeFullTestContinuationRuntime(taskId,input){
    const allowed=new Set(["expectedVersion","runtimeVersion","workerId","workspace"]),workspaceKeys=new Set(["root","gitTopLevel","repository","branch","head","liveTip","clean","changedFiles"]);
    if(!input||Object.keys(input).some(key=>!allowed.has(key))||!Number.isInteger(input.expectedVersion))throw new SelfDevelopmentError("continuation_runtime_resume_invalid","An exact state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.continuationRuntimeResumeHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,idempotent:true,runtimeWindow:prior.runtimeWindow};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before continuation runtime repair.");
    const active=current.metadata?.activeContinuation,recoveryClass=active?.recoveryClass,structured=recoveryClass==="structured_full_test_evidence_reconstruction",localRead=recoveryClass==="task_owned_local_read_recovery",recovery=structured?current.metadata?.fullTestFailureRecoveryHistory?.at(-1):localRead?current.metadata?.implementationPlanRecoveryHistory?.at(-1):null,steps=await runtime.steps(current.id),executedAfterRecovery=steps.some(step=>Number.parseInt(step.stepId,10)>current.currentStep),deadlineMs=new Date(active?.runtimeDeadline).getTime(),expired=Number.isFinite(deadlineMs)&&deadlineMs<=clock().getTime(),alreadyRenewed=(current.metadata?.continuationRuntimeResumeHistory||[]).some(item=>item.continuationGenerationId===active?.generationId);
    if(current.status!=="waiting_for_worker"||current.errorCode||!recovery||!active||active.recoveryClass!==recovery.recoveryClass||!expired||alreadyRenewed||executedAfterRecovery||current.leaseOwner||current.leaseToken||current.approvalState)throw new SelfDevelopmentError("continuation_runtime_resume_precondition_failed","Only the exact expired unclaimed recovered continuation may receive one fresh runtime window.");
    let renewalBinding=null;
    if(localRead){
      const workspace=input.workspace||{},partial=current.metadata?.partialRepairPlanRecoveryHistory?.at(-1),planned=current.metadata?.steps?.[current.currentStep],apply=steps.filter(step=>step.stepType==="apply_patch"&&step.status==="completed").sort((a,b)=>stepOrdinal(a)-stepOrdinal(b)).at(-1),lineage=apply?.result?.taskOwnedDirtyLineage,lineageEntries=Array.isArray(lineage?.entries)?lineage.entries.map(item=>({path:safePath(item.path),contentHash:String(item.contentHash||"").toLowerCase()})).sort((a,b)=>a.path.localeCompare(b.path)):[],partialEntries=Array.isArray(partial?.entries)?partial.entries.map(item=>({path:safePath(item.path),contentHash:String(item.contentHash||"").toLowerCase()})).sort((a,b)=>a.path.localeCompare(b.path)):[],actual=Array.isArray(workspace.changedFiles)?workspace.changedFiles.map(item=>({path:safePath(item.path),hashAlgorithm:item.hashAlgorithm,hash:String(item.hash||"").toLowerCase(),contentHash:String(item.contentHash||"").toLowerCase()})).sort((a,b)=>a.path.localeCompare(b.path)):[],remaining=[];
      for(let index=current.currentStep;index<current.metadata.steps.length;index++){const step=current.metadata.steps[index];if(step?.type!=="read_files"||step?.input?.tool!=="repo_read_task_owned_local")break;remaining.push(safePath(step.input.arguments?.path));}
      const continuation=(current.metadata?.continuationHistory||[]).at(-1),remote=typeof verifyRemote==="function"?await verifyRemote({repository,branch:current.branch,requiredAncestors:[current.currentCommit]}):null,exactEntries=lineageEntries.length>0&&lineageEntries.length===partialEntries.length&&lineageEntries.every((item,index)=>item.path===partialEntries[index].path&&item.contentHash===partialEntries[index].contentHash&&REVIEW_HASH.test(item.contentHash)),exactWorkspace=workspace&&Object.keys(workspace).every(key=>workspaceKeys.has(key))&&workspace.root===workspace.gitTopLevel&&canonicalWorkspaceRoot(workspace.root)===canonicalWorkspaceRoot(partial?.workspaceRoot)&&workspace.repository===repository&&workspace.repository===current.metadata?.selfDevelopment?.repository&&workspace.branch===approvedBranch&&workspace.branch===current.branch&&workspace.head===current.currentCommit&&workspace.liveTip===current.currentCommit&&workspace.clean===false&&actual.length===partialEntries.length&&actual.every((item,index)=>item.path===partialEntries[index].path&&item.hashAlgorithm==="git_sha1"&&SHA.test(item.hash)&&item.contentHash===partialEntries[index].contentHash),exactGeneration=/^[a-f0-9]{64}$/.test(active.generationId||"")&&continuation?.generationId===active.generationId&&continuation.recoveryClass===active.recoveryClass&&continuation.runtimeStartedAt===active.runtimeStartedAt&&continuation.runtimeDeadline===active.runtimeDeadline,exactLineage=lineage?.version===1&&lineage.taskId===current.id&&lineage.repository===repository&&lineage.branch===current.branch&&lineage.currentCommit===current.currentCommit&&lineage.sourcePlanStepId===partial?.sourcePlanStepId&&(lineage.sourceApplyStepId??apply?.stepId)===apply?.stepId&&apply?.stepId===partial?.sourceApplyStepId&&apply?.operationFingerprint&&recovery.sourcePlanStepId===partial.sourcePlanStepId&&recovery.sourceApplyStepId===partial.sourceApplyStepId&&recovery.fingerprint===partial.fingerprint&&recovery.previousStateVersion===current.stateVersion-1&&recovery.recoveredAt===active.runtimeStartedAt&&SHA.test(recovery.runtimeVersion||"")&&Array.isArray(recovery.readPaths)&&remaining.length>0&&remaining.every(path=>recovery.readPaths.includes(path)&&partial.requiredPaths?.includes(path))&&recovery.readPaths.every(path=>partial.requiredPaths?.includes(path)),exactRuntime=SHA.test(input.runtimeVersion||"")&&input.runtimeVersion===runtimeVersion,exactBootstrap=input.workerId===undefined,exactRemote=remote?.currentTip===current.currentCommit&&remote?.ancestors?.[current.currentCommit]===true;
      if(current.currentPhase!=="read_files"||planned?.type!=="read_files"||planned?.input?.tool!=="repo_read_task_owned_local"||current.id!==partial?.taskId||!exactEntries||!exactWorkspace||!exactGeneration||!exactLineage||!exactRuntime||!exactBootstrap||!exactRemote)throw new SelfDevelopmentError("continuation_runtime_resume_precondition_failed","The task-owned local-read continuation no longer matches its exact workspace lineage.");
      const priorWorkerIds=[...new Set((await storage.listActivity(ownerId,{runId:current.id,limit:100})).map(item=>item?.metadata?.workerId).filter(item=>typeof item==="string"&&item.trim()).map(item=>item.trim()))].slice(0,20);
      renewalBinding={workerBindingState:"awaiting_worker_bind",workerId:null,rejectedPriorWorkerIds:priorWorkerIds,repository,branch:current.branch,currentCommit:current.currentCommit,workspaceRoot:canonicalWorkspaceRoot(workspace.root),sourcePlanStepId:partial.sourcePlanStepId,sourceApplyStepId:partial.sourceApplyStepId,sourceApplyFingerprint:apply.operationFingerprint,fingerprint:partial.fingerprint,runtimeVersion,remainingReadPaths:remaining,dirtyEvidenceHash:hash(actual)};
    }
    const now=clock().toISOString(),runtimeMinutes=15,runtimeWindow={runtimeStartedAt:now,runtimeMinutes,runtimeDeadline:new Date(new Date(now).getTime()+runtimeMinutes*60000).toISOString()},renewedContinuation={...active,version:2,...runtimeWindow},record={recoveryClass:"stale_task_runtime_to_active_continuation",sourceRecoveryClass:recoveryClass,fromStateVersion:current.stateVersion,continuationGenerationId:active.generationId,maxRenewals:1,authorizationConsumed:true,...(renewalBinding||{}),runtimeWindow,resumedAt:now},metadata={...current.metadata,activeContinuation:renewedContinuation,continuationHistory:[...(current.metadata.continuationHistory||[]),renewedContinuation],continuationRuntimeResumeHistory:[...(current.metadata.continuationRuntimeResumeHistory||[]),record],requiredCapability:localRead?"repo_read_remote":"test_local",autoDispatch:true};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",nextRunAt:now,blockedReason:null,errorCode:null,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during continuation runtime repair.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_continuation_runtime_resumed",status:"waiting_for_worker",summary:"A fresh bounded runtime window was attached to the exact recovered continuation.",metadata:{taskId:current.id,...record}});return{task:updated,idempotent:false,runtimeWindow};
  }
  async function recoverDivergedApprovedDeliveryIntegration(taskId,input){
    const expected=HISTORICAL_DIVERGED_APPROVED_DELIVERY;
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||input.expectedVersion!==expected.fromStateVersion)throw new SelfDevelopmentError("diverged_delivery_integration_recovery_invalid","The exact historical state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.divergedApprovedDeliveryIntegrationRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);if(prior)return{task:current,recovery:prior,idempotent:true};
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before integration recovery.");
    const steps=await runtime.steps(current.id),approval=await storage.getApproval(expected.approvalId,ownerId),failed=steps.find(step=>step.stepId===expected.failedStepId),review=steps.find(step=>step.stepId===`${expected.currentStep}:review_commit`),reviewed=review?.result?.reviewedChangeSet,state=current.approvalState,runtimeState=current.metadata?.approvedDeliveryRuntime,paths=[...(reviewed?.allowedPaths||[])].map(safePath).sort(),expectedPaths=[...expected.allowedPaths].sort(),completedPush=steps.some(step=>step.stepType==="push"&&step.status==="completed"),laterStep=steps.some(step=>(stepOrdinal(step)||0)>expected.currentStep+1),approvalArgs=approval?.arguments||{},repositoryHistory=HISTORICAL_DELIVERY_REPOSITORY_HISTORY_KEYS.flatMap(key=>current.metadata?.[key]||[]).filter(item=>item?.approvalId===expected.approvalId),repositoryBindingsExact=current.metadata?.selfDevelopment?.repository===expected.repository&&state?.repository===expected.repository&&runtimeState?.repository===expected.repository&&repositoryHistory.length>0&&repositoryHistory.every(item=>item.taskId===expected.taskId&&item.repository===expected.repository&&item.branch===expected.branch&&item.commitSha===expected.secondParentSha),approvalRepositoryCompatible=approvalArgs.repository===expected.repository||(approvalArgs.repository===undefined&&approval?.id===expected.approvalId&&approval?.runId===expected.taskId&&repositoryBindingsExact);
    if(current.id!==expected.taskId||current.status!=="failed"||current.errorCode!=="push_failed"||current.stateVersion!==expected.fromStateVersion||current.currentStep!==expected.currentStep||current.currentCommit!==expected.secondParentSha||current.branch!==expected.branch||!repositoryBindingsExact||current.leaseOwner||current.leaseToken||failed?.stepType!=="push"||failed?.status!=="failed"||failed?.errorCode!=="push_failed"||failed?.attempt!==2||failed?.result?.message!=="Public push failed."||laterStep||completedPush||state?.approvalId!==expected.approvalId||state?.approved!==true||state?.commitSha!==expected.secondParentSha||state?.branch!==expected.branch||approval?.status!=="approved"||approval?.tool!=="git_push"||!approvalRepositoryCompatible||approvalArgs.branch!==expected.branch||approvalArgs.commitSha!==expected.secondParentSha||runtimeState?.consumed===true||review?.status!=="completed"||review?.result?.commitSha!==expected.secondParentSha||reviewed?.commitSha!==expected.secondParentSha||reviewed?.reviewHash!==expected.reviewHash||paths.join("|")!==expectedPaths.join("|")||!Array.isArray(reviewed?.entries)||reviewed.entries.length!==expectedPaths.length||reviewed.entries.some(entry=>!expectedPaths.includes(safePath(entry.path))||entry.status!=="committed"||!SHA.test(entry.contentHash||"")))throw new SelfDevelopmentError("diverged_delivery_integration_recovery_precondition_failed","Only the exact unconsumed divergent approved delivery may enter integration review.");
    if(!verifyRemote)throw new SelfDevelopmentError("diverged_delivery_integration_verification_unavailable","Exact remote-tip verification is required.",503);
    const remote=await verifyRemote({repository:expected.repository,branch:expected.branch,requiredAncestors:[expected.minimumFirstParentSha]}),firstParentSha=remote?.currentTip;
    if(!SHA.test(firstParentSha||"")||remote?.ancestors?.[expected.minimumFirstParentSha]!==true||firstParentSha===expected.secondParentSha)throw new SelfDevelopmentError("diverged_delivery_integration_remote_changed","The feature branch tip is not a verified descendant of the approved integration-recovery infrastructure.");
    const base=current.metadata.steps.length;if(base!==expected.currentStep)throw new SelfDevelopmentError("diverged_delivery_integration_history_changed","The immutable task plan no longer ends at the reviewed boundary.");
    const continuation=[
      {type:"integrate_commit",input:{tool:"git_integrate_reviewed_commit",arguments:{branch:expected.branch,firstParentSha,secondParentSha:expected.secondParentSha,mergeBaseSha:expected.mergeBaseSha,message:"Integrate reviewed Nova composer change",paths:expected.allowedPaths,reviewedChangeSet:reviewed}},idempotencyIdentity:`integration:${firstParentSha}:${expected.secondParentSha}`},
      {type:"review_commit",input:{tool:"repo_review_commit",arguments:{commitSha:"$CURRENT_COMMIT",firstParentSha,secondParentSha:expected.secondParentSha,paths:expected.allowedPaths}},idempotencyIdentity:`integration-review:${firstParentSha}:${expected.secondParentSha}`},
      {type:"push",input:{tool:"git_push",arguments:{branch:expected.branch,commitSha:"$CURRENT_COMMIT"}},idempotencyIdentity:`integration-push:${firstParentSha}:${expected.secondParentSha}`},
    ],now=clock().toISOString(),activeContinuation=createActiveContinuation({task:current,startStep:base,plannedSteps:expected.maxContinuationSteps,repairLimit:0,recoveryClass:expected.recoveryClass,runtimeStartedAt:now,runtimeMinutes:expected.runtimeMinutes}),record={recoveryClass:expected.recoveryClass,fromStateVersion:current.stateVersion,toStateVersion:current.stateVersion+1,taskId:current.id,supersededApprovalId:expected.approvalId,supersededApprovalCommitSha:expected.secondParentSha,oldApprovalConsumed:false,firstParentSha,minimumFirstParentSha:expected.minimumFirstParentSha,secondParentSha:expected.secondParentSha,mergeBaseSha:expected.mergeBaseSha,reviewHash:expected.reviewHash,allowedPaths:expected.allowedPaths,maxContinuationSteps:expected.maxContinuationSteps,runtimeMinutes:expected.runtimeMinutes,recoveredAt:now},metadata={...current.metadata,steps:[...current.metadata.steps,...continuation],autoDispatch:true,requiredCapability:"repo_mutate_local",approvedDeliveryRuntime:null,activeContinuation,continuationHistory:[...(current.metadata?.continuationHistory||[]),activeContinuation],supersededDeliveryApproval:{approvalId:expected.approvalId,commitSha:expected.secondParentSha,reason:"branch_divergence_requires_integration_review",supersededAt:now},divergedApprovedDeliveryIntegrationRecoveryHistory:[...(current.metadata?.divergedApprovedDeliveryIntegrationRecoveryHistory||[]),record]};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"waiting_for_worker",currentStep:base,currentPhase:"integrate_commit",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:"Waiting for deterministic reviewed integration.",approvalState:null,metadata,leaseOwner:null,leaseToken:null,leaseExpiresAt:null},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during integration recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"self_development_diverged_delivery_integration_recovered",status:"waiting_for_worker",summary:"The divergent approved delivery was retired and a deterministic integration review continuation opened.",metadata:{taskId:current.id,...record}});return{task:updated,recovery:record,idempotent:false};
  }
  async function recoverApprovedContractDeliveryRuntime(taskId,input){
    const expected=HISTORICAL_V288_APPROVAL_CONTRACT_DELIVERY;
    if(!input||Object.keys(input).some(key=>key!=="expectedVersion")||input.expectedVersion!==expected.fromStateVersion)throw new SelfDevelopmentError("approval_contract_delivery_runtime_recovery_invalid","The exact historical state version is required.",400);
    const current=await runtime.get(taskId);if(!current||current.taskType!=="self_development")throw new SelfDevelopmentError("task_not_found","Self-development task not found.",404);
    const prior=current.metadata?.approvalContractDeliveryRuntimeRecoveryHistory?.find(item=>item.fromStateVersion===input.expectedVersion);
    if(prior){if(current.stateVersion===prior.toStateVersion)return{task:current,recovery:prior,idempotent:true};throw new SelfDevelopmentError("version_conflict","The exact approval-contract runtime recovery was already superseded.");}
    if(current.stateVersion!==input.expectedVersion)throw new SelfDevelopmentError("version_conflict","Task changed before approval-contract runtime recovery.");
    const steps=await runtime.steps(current.id),approval=await storage.getApproval(expected.approvalId,ownerId),state=current.approvalState,review=steps.find(step=>step.stepId==="310:review_commit"),integration=steps.find(step=>step.stepId==="309:integrate_commit"),push=steps.find(step=>step.stepId==="311:push"),planned=current.metadata?.steps?.[current.currentStep],reviewResult=review?.result||{},integrationResult=integration?.result||{};
    const exact=current.id===expected.taskId&&current.status==="queued"&&current.currentStep===expected.currentStep&&current.currentCommit===expected.commitSha&&current.branch===expected.branch&&current.metadata?.selfDevelopment?.repository===expected.repository&&!current.leaseOwner&&!current.leaseToken&&!current.metadata?.localHandoff&&!current.metadata?.approvedDeliveryRuntime&&state?.approvalId===expected.approvalId&&state?.approved===true&&state?.bindingSource==="approval_contract"&&state?.approvedStateVersion===287&&state?.deliveryStateVersion===288&&state?.repository===expected.repository&&state?.branch===expected.branch&&state?.commitSha===expected.commitSha&&state?.stepId==="311:push"&&approval?.id===expected.approvalId&&approval.status==="approved"&&approval.tool==="git_push"&&approval.runId===current.id&&approval.arguments?.repository===expected.repository&&approval.arguments?.branch===expected.branch&&approval.arguments?.commitSha===expected.commitSha&&approval.arguments?.approvedStateVersion===287&&planned?.type==="push"&&planned.input?.tool==="git_push"&&!push&&review?.status==="completed"&&reviewResult.commitSha===expected.commitSha&&reviewResult.reviewedChangeSet?.firstParentSha===expected.firstParentSha&&reviewResult.reviewedChangeSet?.secondParentSha===expected.secondParentSha&&integration?.status==="completed"&&integrationResult.commitSha===expected.commitSha&&integrationResult.firstParentSha===expected.firstParentSha&&integrationResult.secondParentSha===expected.secondParentSha&&!steps.some(step=>Number.parseInt(step.stepId,10)>expected.currentStep)&&!steps.some(step=>step.stepType==="push"&&step.status==="completed")&&!steps.some(step=>step.stepType==="deploy_preview"&&step.status==="completed");
    if(!exact)throw new SelfDevelopmentError("approval_contract_delivery_runtime_recovery_precondition_failed","Only the exact approved, unclaimed v288 integration delivery may receive a compatibility runtime.");
    if(!verifyRemote)throw new SelfDevelopmentError("approval_contract_delivery_runtime_verification_unavailable","Exact remote-tip verification is required.",503);
    const remote=await verifyRemote({repository:expected.repository,branch:expected.branch,requiredAncestors:[expected.firstParentSha]});
    if(remote?.currentTip!==expected.firstParentSha||remote?.ancestors?.[expected.firstParentSha]!==true)throw new SelfDevelopmentError("approval_contract_delivery_runtime_remote_changed","The target feature branch changed before delivery runtime recovery.");
    const now=clock().toISOString(),toStateVersion=current.stateVersion+1,deadline=new Date(new Date(now).getTime()+expected.runtimeMinutes*60000).toISOString(),record={recoveryClass:expected.recoveryClass,fromStateVersion:current.stateVersion,toStateVersion,taskId:current.id,approvalId:expected.approvalId,approvedStateVersion:state.approvedStateVersion,deliveryStateVersion:toStateVersion,repository:expected.repository,branch:expected.branch,commitSha:expected.commitSha,firstParentSha:expected.firstParentSha,secondParentSha:expected.secondParentSha,reviewStepId:"310:review_commit",deliveryStepId:"311:push",maxAdditionalDeliverySteps:expected.maxAdditionalDeliverySteps,runtimeMinutes:expected.runtimeMinutes,startedAt:now,deadline,consumed:false},approvalState={...state,deliveryStateVersion:toStateVersion},metadata={...current.metadata,approvedDeliveryRuntime:record,approvalContractDeliveryRuntimeRecoveryHistory:[...(current.metadata?.approvalContractDeliveryRuntimeRecoveryHistory||[]),record]};
    const updated=await storage.updateAutonomyTask(current.id,ownerId,{status:"queued",nextRunAt:now,errorCode:null,blockedReason:null,approvalState,metadata},current.stateVersion);if(!updated)throw new SelfDevelopmentError("version_conflict","Task changed during approval-contract runtime recovery.");
    await storage.appendActivity({ownerId,projectId:current.projectId,runId:current.id,action:"approval_contract_delivery_runtime_recovered",status:"queued",summary:"The exact approved integration delivery received one bounded runtime window.",metadata:{taskId:current.id,...record}});return{task:updated,recovery:record,idempotent:false};
  }
  const planningScopeOptions=(taskId,input,actor)=>({taskId,input,actor,runtime,storage,ownerId,repository,approvedBranch,runtimeVersion,verifyRemote,clock});
  const planningScopeCall=async operation=>{try{return await operation();}catch(error){if(error.code!=="planning_scope_recovery_precondition_failed")throw error;throw Object.assign(new SelfDevelopmentError(error.code,error.message,error.statusCode||409),{safeDiagnostics:error.safeDiagnostics});}};
  async function requestPlanningScopeRecovery(taskId,input,actor){
    const {task,approvalArguments}=await planningScopeCall(()=>describePlanningScopeRecovery(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===PLANNING_SCOPE_RECOVERY_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:PLANNING_SCOPE_RECOVERY_TOOL,reason:"Owner approval is required for one planning-only successor using exact current evidence. No product mutation or additional repair attempt is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_planning_scope_approval_requested",status:"waiting",summary:"Exact current-read planning continuation awaits a separate owner decision.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverPlanningScopeFailure=(taskId,input,actor)=>planningScopeCall(()=>recoverPlanningScope(planningScopeOptions(taskId,input,actor)));
  const executionScopeCall=async operation=>{try{return await operation();}catch(error){if(error.code!=="execution_scope_recovery_precondition_failed")throw error;throw Object.assign(new SelfDevelopmentError(error.code,error.message,error.statusCode||409),{safeDiagnostics:error.safeDiagnostics});}};
  async function requestExecutionScopeRecovery(taskId,input,actor){
    const {task,approvalArguments}=await executionScopeCall(()=>describeExecutionScopeRecovery(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===EXECUTION_SCOPE_RECOVERY_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:EXECUTION_SCOPE_RECOVERY_TOOL,reason:"Separate owner approval is required for one application of this exact validated plan and its exact focused tests. No new planning, retry, repair extension, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_execution_scope_approval_requested",status:"waiting",summary:"Exact validated-plan execution successor awaits an owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverValidatedExecutionScope=(taskId,input,actor)=>executionScopeCall(()=>recoverExecutionScope(planningScopeOptions(taskId,input,actor)));
  const fullTestScopeCall=async operation=>{try{return await operation();}catch(error){if(error.code!=="full_test_scope_recovery_precondition_failed")throw error;throw Object.assign(new SelfDevelopmentError(error.code,error.message,error.statusCode||409),{safeDiagnostics:error.safeDiagnostics});}};
  async function requestFullTestScopeRecovery(taskId,input,actor){
    const {task,approvalArguments}=await fullTestScopeCall(()=>describeFullTestScopeRecovery(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===FULL_TEST_SCOPE_RECOVERY_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:FULL_TEST_SCOPE_RECOVERY_TOOL,reason:"Separate owner approval is required for exactly one full project test-suite run on the verified post-focused workspace. No product mutation, replanning, repair attempt, extension, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_full_test_scope_approval_requested",status:"waiting",summary:"One full-test-only successor awaits an owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverFullTestScopeSuccessor=(taskId,input,actor)=>fullTestScopeCall(()=>recoverFullTestScope(planningScopeOptions(taskId,input,actor)));
  async function requestFailedFullTestRetry(taskId,input,actor){
    const {task,approvalArguments}=await fullTestScopeCall(()=>describeFailedFullTestRetry(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===FAILED_FULL_TEST_RETRY_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:FAILED_FULL_TEST_RETRY_TOOL,reason:"Separate owner approval is required for one full-suite retry after local dependency provisioning, bound to this exact failed result and unchanged workspace. No product mutation, replanning, focused rerun, repair attempt, extension, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_failed_full_test_retry_approval_requested",status:"waiting",summary:"One dependency-preflighted full-test retry awaits an owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverFailedFullTestRetrySuccessor=(taskId,input,actor)=>fullTestScopeCall(()=>recoverFailedFullTestRetry(planningScopeOptions(taskId,input,actor)));
  const reviewRemediationCall=async operation=>{try{return await operation();}catch(error){if(error.code!=="review_remediation_precondition_failed")throw error;throw Object.assign(new SelfDevelopmentError(error.code,error.message,error.statusCode||409),{safeDiagnostics:error.safeDiagnostics});}};
  async function requestReviewRemediationApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeReviewRemediation(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===REVIEW_REMEDIATION_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:REVIEW_REMEDIATION_TOOL,reason:"Separate owner approval is required for one review-remediation cycle bound to structured review findings and the exact eight-file workspace. Only Nova may plan and apply one bounded remediation, run focused/full tests, and return to a non-executing review boundary. No additional repair extension, retry, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_review_remediation_approval_requested",status:"waiting",summary:"One exact review-remediation successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverReviewRemediationSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverReviewRemediation(planningScopeOptions(taskId,input,actor)));
  async function requestRejectedReviewPlanContinuationApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeRejectedReviewPlanContinuation(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===REJECTED_REVIEW_PLAN_CONTINUATION_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:REJECTED_REVIEW_PLAN_CONTINUATION_TOOL,reason:"Separate owner approval is required for one rejected-review-plan continuation bound to the exact failed planning execution, consumed predecessor, unchanged eight-file workspace, and immutable review findings. Only Nova may produce one fresh plan, validate and apply it once, run its focused tests and one full suite, then return to independent review. No repair extension, counter reset, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_rejected_review_plan_continuation_approval_requested",status:"waiting",summary:"One exact rejected-review-plan successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverRejectedReviewPlanSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverRejectedReviewPlanContinuation(planningScopeOptions(taskId,input,actor)));
  async function requestSourceBoundReviewReplanApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeSourceBoundReviewReplan(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===SOURCE_BOUND_REVIEW_REPLAN_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:SOURCE_BOUND_REVIEW_REPLAN_TOOL,reason:"Separate owner approval is required for one source-bound review replan after the exact failed coverage validation, bound to the consumed predecessor, immutable review findings, and unchanged eight-file workspace. Only Nova may generate one fresh plan, validate and apply it once, run its selected focused tests and one full suite, then stop for fresh independent review. No repair extension, counter reset, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_source_bound_review_replan_approval_requested",status:"waiting",summary:"One exact source-bound review successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverSourceBoundReviewReplanSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverSourceBoundReviewReplan(planningScopeOptions(taskId,input,actor)));
  async function requestEvidenceBoundReviewReplanApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeEvidenceBoundReviewReplan(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===EVIDENCE_BOUND_REVIEW_REPLAN_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:EVIDENCE_BOUND_REVIEW_REPLAN_TOOL,reason:"Separate owner approval is required for one evidence-bound review replan after the exact rejected source-bound planning execution. Nova alone may reread the unchanged eight-file scope, plan once, validate, apply once, run focused tests and one full suite, then stop for independent review. No repair extension, retry, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_evidence_bound_review_replan_approval_requested",status:"waiting",summary:"One exact evidence-bound review successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverEvidenceBoundReviewReplanSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverEvidenceBoundReviewReplan(planningScopeOptions(taskId,input,actor)));
  async function requestImplementationContentReviewReplanApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeImplementationContentReviewReplan(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===IMPLEMENTATION_CONTENT_REVIEW_REPLAN_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:IMPLEMENTATION_CONTENT_REVIEW_REPLAN_TOOL,reason:"Separate owner approval is required for one implementation-content review replan after the exact five-file empty-content rejection. Nova alone may reread the unchanged eight-file scope, generate complete literal replacements once, validate, apply once, run focused tests and one full suite, then stop for fresh independent review. No repair extension, counter reset, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_implementation_content_review_replan_approval_requested",status:"waiting",summary:"One exact implementation-content review successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverImplementationContentReviewReplanSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverImplementationContentReviewReplan(planningScopeOptions(taskId,input,actor)));
  async function requestSourceLiteralReviewReplanApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeSourceLiteralReviewReplan(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===SOURCE_LITERAL_REVIEW_REPLAN_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:SOURCE_LITERAL_REVIEW_REPLAN_TOOL,reason:"Separate owner approval is required for one source-literal review replan after the exact proposed-source excerpt rejection. Nova alone may reread the unchanged eight-file scope, plan once with literal source-bound coverage evidence, validate, apply once, run focused tests and one full suite, then stop for fresh independent review. No repair extension, counter reset, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_source_literal_review_replan_approval_requested",status:"waiting",summary:"One exact source-literal review successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverSourceLiteralReviewReplanSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverSourceLiteralReviewReplan(planningScopeOptions(taskId,input,actor)));
  async function requestObservableLinkageReviewReplanApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeObservableLinkageReviewReplan(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===OBSERVABLE_LINKAGE_REVIEW_REPLAN_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:OBSERVABLE_LINKAGE_REVIEW_REPLAN_TOOL,reason:"Separate owner approval is required for one observable-linkage review replan after the exact source-bound behavioral reference rejection. Nova alone may reread the unchanged eight-file scope, plan once with a real code reference coherently exercised and asserted by the same named test, validate, apply once, run focused tests and one full suite, then stop for fresh independent review. No repair extension, counter reset, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_observable_linkage_review_replan_approval_requested",status:"waiting",summary:"One exact observable-linkage review successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverObservableLinkageReviewReplanSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverObservableLinkageReviewReplan(planningScopeOptions(taskId,input,actor)));
  async function requestSemanticEvidenceReviewReplanApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeSemanticEvidenceReviewReplan(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===SEMANTIC_EVIDENCE_REVIEW_REPLAN_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:SEMANTIC_EVIDENCE_REVIEW_REPLAN_TOOL,reason:"Separate owner approval is required for one semantic-evidence review replan after Nova referenced nonexistent test identities. Nova alone may reread the unchanged eight-file scope and plan once; an unchanged test source may use only an exact existing named test, while a new named test requires an authorized complete replacement of that test file. One validated apply, focused test run and full suite may follow before fresh independent review. No repair extension, counter reset, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_semantic_evidence_review_replan_approval_requested",status:"waiting",summary:"One exact semantic-evidence review successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverSemanticEvidenceReviewReplanSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverSemanticEvidenceReviewReplan(planningScopeOptions(taskId,input,actor)));
  async function requestFailedSemanticReadRecoveryApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeFailedSemanticReadRecovery(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===FAILED_SEMANTIC_READ_RECOVERY_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:FAILED_SEMANTIC_READ_RECOVERY_TOOL,reason:"Separate owner approval is required for one failed semantic-review read recovery after canonical Windows repository-root validation incorrectly rejected an in-repository path. Nova alone may reread the unchanged eight-file scope and plan once under the existing semantic-evidence contract; one validated apply, focused test run and full suite may follow before fresh independent review. No repair extension, counter reset, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_failed_semantic_read_recovery_approval_requested",status:"waiting",summary:"One exact failed-read review successor awaits an owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverFailedSemanticReadRecoverySuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverFailedSemanticReadRecovery(planningScopeOptions(taskId,input,actor)));
  async function requestTestIdentityInventoryReviewReplanApproval(taskId,input,actor){
    const {task,approvalArguments}=await reviewRemediationCall(()=>describeTestIdentityInventoryReviewReplan(planningScopeOptions(taskId,input,actor)));
    const existing=(await storage.listApprovals(ownerId,{limit:100})).find(item=>item.tool===TEST_IDENTITY_INVENTORY_REPLAN_TOOL&&item.runId===task.id&&["pending","approved"].includes(item.status)&&recoveryHash(item.arguments)===recoveryHash(approvalArguments));
    if(existing)return{taskId:task.id,stateVersion:task.stateVersion,approval:existing,idempotent:true};
    const approval=await storage.createApproval({id:randomUUID(),ownerId,projectId:task.projectId,runId:task.id,tool:TEST_IDENTITY_INVENTORY_REPLAN_TOOL,reason:"Separate owner approval is required for one test-identity-inventory review replan after Nova again referenced a nonexistent test identity. Nova alone may reread the unchanged eight-file scope and plan once with deterministic exact current test identities bound to path and source hash; a new identity still requires an authorized complete test-file replacement. One validated apply, focused test run and full suite may follow before fresh independent review. No repair extension, counter reset, scope expansion, commit, push or deployment is authorized.",riskLevel:"SENSITIVE",arguments:approvalArguments});
    await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:"self_development_test_identity_inventory_review_replan_approval_requested",status:"waiting",summary:"One exact test-identity-inventory review successor awaits a separate owner decision; the task remains unchanged.",metadata:{taskId:task.id,approvalId:approval.id,...approvalArguments}});
    return{taskId:task.id,stateVersion:task.stateVersion,approval,idempotent:false};
  }
  const recoverTestIdentityInventoryReviewReplanSuccessor=(taskId,input,actor)=>reviewRemediationCall(()=>recoverTestIdentityInventoryReviewReplan(planningScopeOptions(taskId,input,actor)));
  return Object.freeze({
    requestTestIdentityInventoryReviewReplanApproval,
    recoverTestIdentityInventoryReviewReplan:recoverTestIdentityInventoryReviewReplanSuccessor,
    requestFailedSemanticReadRecoveryApproval,
    recoverFailedSemanticReadRecovery:recoverFailedSemanticReadRecoverySuccessor,
    requestSemanticEvidenceReviewReplanApproval,
    recoverSemanticEvidenceReviewReplan:recoverSemanticEvidenceReviewReplanSuccessor,
    requestObservableLinkageReviewReplanApproval,
    recoverObservableLinkageReviewReplan:recoverObservableLinkageReviewReplanSuccessor,
    requestSourceLiteralReviewReplanApproval,
    recoverSourceLiteralReviewReplan:recoverSourceLiteralReviewReplanSuccessor,
    requestImplementationContentReviewReplanApproval,
    recoverImplementationContentReviewReplan:recoverImplementationContentReviewReplanSuccessor,
    requestEvidenceBoundReviewReplanApproval,
    recoverEvidenceBoundReviewReplan:recoverEvidenceBoundReviewReplanSuccessor,
    requestSourceBoundReviewReplanApproval,
    recoverSourceBoundReviewReplan:recoverSourceBoundReviewReplanSuccessor,
    requestRejectedReviewPlanContinuationApproval,
    recoverRejectedReviewPlanContinuation:recoverRejectedReviewPlanSuccessor,
    requestReviewRemediationApproval,
    recoverReviewRemediation:recoverReviewRemediationSuccessor,
    requestFailedFullTestRetry,
    recoverFailedFullTestRetry:recoverFailedFullTestRetrySuccessor,
    requestFullTestScopeRecovery,
    recoverFullTestScope:recoverFullTestScopeSuccessor,
    requestExecutionScopeRecovery,
    recoverValidatedExecutionScope,
    requestPlanningScopeRecovery,
    recoverPlanningScopeFailure,
    structure,
    plan,
    create,
    createTrustedIntake,
    get,
    repair,
    requestEscalatedRepair,
    recoverEscalatedRepair,
    recoverFullTestHandoffOverflow,
    recoverFullTestFailure,
    recoverTestRunnerInfrastructure,
    resumeFullTestContinuationRuntime,
    recoverDivergedApprovedDeliveryIntegration,
    recoverApprovedContractDeliveryRuntime,
    replanDiscoveryOnly,
    recoverStructuredScope,
    recoverImplementationPlan,
    recoverFailedTaskOwnedLocalRead,
    recoverImplementationSchema,
    recoverFocusedTestSchema,
    recoverStaleBasePatchConflict,
    recoverHandsCommitMismatch,
    recoverHandsWorkingTreeDirty,
    attestHandsWorkspace,
    recoverRepositoryContextFailure,
    recoverPlanLifecycle,
    recoverFocusedTestEvidence,
    recoverCreateConflict,
    recoverCreateConflictBudget,
    recoverReview,
    supersedeCommit,
    attestDelivery,
  });
}

export const SELF_DEVELOPMENT_DEFAULTS = Object.freeze({
  repository: REPOSITORY,
  branch: BRANCH,
  maxRepairIterations: 3,
  runtimeBudgetMinutes: 60,
});
