const CODING_TASK_ID = /^coding_[a-f0-9]{32}$/;
const EXPLICIT_RETRY_TARGET = /(?:^|[\r\n])\s*retry\s+(?:exactly\s+)?(?:this\s+)?(?:failed\s+)?coding\s+task\s*:\s*(coding_[a-z0-9_]+)\b/gi;

const boundedTask = (task) => Object.freeze({
  id: task.id,
  taskType: task.taskType,
  status: task.status,
  stateVersion: task.stateVersion,
  title: task.title || null,
  objective: task.objective || null,
  currentPhase: task.currentPhase || null,
  errorCode: task.errorCode || null,
  currentCommit: task.currentCommit || null,
  approvalPending: task.status === "waiting_for_approval" && task.approvalState?.approved !== true,
  parentTaskId: task.parentTaskId || task.metadata?.parentTaskId || null,
  delegatedTaskId: task.metadata?.delegatedTaskId || null,
  allowedTransitions: ["coding_retry_request"],
  action: "coding_retry_request",
});

const routingError = (code, message, reason, taskId = null) => Object.assign(new Error(message), {
  code,
  statusCode: 409,
  safeDiagnostics: {
    version: 1,
    boundary: "explicit_retry_binding",
    reason,
    semanticIntent: "workflow_action",
    semanticCandidateId: taskId,
    serverDerivedTransition: null,
    ignoredFieldNames: [],
  },
});

export function explicitCodingRetryTarget(message) {
  const matches = [...String(message || "").matchAll(EXPLICIT_RETRY_TARGET)].map((match) => match[1]);
  const unique = [...new Set(matches)];
  if (!unique.length) return null;
  if (unique.length !== 1) throw routingError("explicit_coding_retry_ambiguous", "The explicit coding retry target is ambiguous.", "multiple_explicit_retry_targets");
  if (!CODING_TASK_ID.test(unique[0])) throw routingError("explicit_coding_retry_invalid", "The explicit coding retry target is invalid.", "invalid_explicit_retry_target", unique[0]);
  return unique[0];
}

export async function resolveExplicitCodingRetryRequest({ message, conversationId, runId, loadTask, codingExecutor } = {}) {
  const taskId = explicitCodingRetryTarget(message);
  if (!taskId) return null;
  if (!CODING_TASK_ID.test(taskId) || typeof loadTask !== "function" || !codingExecutor?.retryEligibility || !codingExecutor?.requestRetry) {
    throw routingError("explicit_coding_retry_invalid", "The explicit coding retry target is invalid.", "invalid_explicit_retry_context", taskId);
  }
  const task = await loadTask(taskId);
  const eligible = task?.taskType === "coding_delegation" && await codingExecutor.retryEligibility(taskId, { conversationId });
  if (!eligible) throw routingError("explicit_coding_retry_unavailable", "The explicitly selected coding task is not eligible for a fresh approved retry.", "retry_target_unavailable", taskId);
  const workflow = boundedTask(task);
  const routingDiagnostics = {
    version: 1,
    candidateIds: [taskId],
    candidateTransitions: [{ candidateId: taskId, transitions: ["coding_retry_request"] }],
    semanticIntent: "workflow_action",
    semanticCandidateId: taskId,
    serverDerivedTransition: "coding_retry_request",
    ignoredFieldNames: [],
  };
  try {
    const retried = await codingExecutor.requestRetry(taskId, { conversationId, runId });
    return { ...retried, workflow, providerUsage: null, turnRoute: "coding_retry_request", routingDiagnostics };
  } catch (error) {
    error.safeDiagnostics = { ...error?.safeDiagnostics, ...routingDiagnostics, boundary: "transition_execution", reason: typeof error?.code === "string" ? error.code.slice(0, 120) : "transition_failed" };
    throw error;
  }
}
