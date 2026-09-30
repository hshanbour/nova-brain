const TRUSTED_WORKFLOW_ID = /\b(?:selfdev|coding|orchestration|shipping)_[a-f0-9]{32}\b/i;
const EXACT_TRUSTED_WORKFLOW_ID = /^(?:selfdev|coding|orchestration|shipping)_[a-f0-9]{32}$/i;
const WORKFLOW_NOUN = /\b(?:task|workflow|artifact|implementation|coding\s+(?:job|task)|approval|deployment|preview|shipping)\b|(?:المهمة|مهمة|سير\s*العمل|التنفيذ|البرمجة|الموافقة|النشر)/iu;
const WORKFLOW_ACTION = /\b(?:continue|resume|retry|recover|approve|reject|ship|deploy|adopt|integrate|cancel|pause|stop|status|progress|blocked|failed|completed|result|commit|files?|tests?)\b|(?:كمّل|كمل|تابع|استأنف|أعد\s*المحاولة|وافق|ارفض|انشر|ادمج|أوقف|الغ|الحالة|التقدم|عالقة|فشلت|اكتملت|النتيجة)/iu;
const BARE_WORKFLOW_COMMAND = /^(?:(?:please\s+)?(?:continue|resume|retry|recover|approve|reject|ship|deploy|cancel|pause|stop)(?:\s+(?:it|that|this|the\s+(?:task|workflow|artifact)))?|i\s+(?:approve|reject)\s+(?:it|that|this)|(?:(?:what(?:'s|\s+is)\s+the\s+)?status|why\s+is\s+it\s+(?:blocked|failed)))[.!?\s]*$|^(?:(?:كمّل|كمل|تابع|استأنف|أعد\s*المحاولة|وافق|ارفض|انشر|ادمج|أوقف|الغ)(?:\s+(?:المهمة|مهمة|هالمهمة|هذا|ذلك))?|شو\s+الحالة)[.!؟?\s]*$/iu;

export function isConversationWorkflowTurn(message, { implementationSignal = false, codingSignal = false } = {}) {
  const value = String(message || "").trim();
  if (!value) return false;
  if (implementationSignal || codingSignal || TRUSTED_WORKFLOW_ID.test(value)) return true;
  return BARE_WORKFLOW_COMMAND.test(value) || (WORKFLOW_ACTION.test(value) && WORKFLOW_NOUN.test(value));
}

export function isSelfDevelopmentWorkflowCandidate(task) {
  return Boolean(task && EXACT_TRUSTED_WORKFLOW_ID.test(String(task.id || "")));
}
