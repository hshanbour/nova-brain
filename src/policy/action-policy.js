import { createHash, randomUUID } from "node:crypto";

export const RISK_LEVELS = Object.freeze({ READ_ONLY: "READ_ONLY", LOW_RISK_WRITE: "LOW_RISK_WRITE", SENSITIVE: "SENSITIVE", HIGH_IMPACT: "HIGH_IMPACT" });
export class ApprovalRequiredError extends Error { constructor(approval) { super(`Owner approval required for ${approval.tool}.`); this.approval = approval; } }

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const sameArguments = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
function redact(value) { if (Array.isArray(value)) return value.map(redact); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item])=>[/token|secret|password|authorization|api.?key/i.test(key)?key:key, /token|secret|password|authorization|api.?key/i.test(key)?"[REDACTED]":redact(item)])); return value; }
function pendingApprovalId({ ownerId, conversationId, tool, arguments: approvalArguments, generation }) {
  const digest = createHash("sha256").update(JSON.stringify(stable({ ownerId, conversationId, tool, arguments: approvalArguments, generation }))).digest("hex");
  return `approval_${digest.slice(0, 32)}`;
}

export function createActionPolicy({ storage, ownerId, approvedBranch }) {
  return Object.freeze({
    async authorize(tool, input, context = {}) {
      if (tool.riskLevel === RISK_LEVELS.READ_ONLY) return { authorized: true };
      if (tool.branchBound && input.branch !== approvedBranch) { const error=new Error("Branch is not approved for development writes.");error.code="branch_not_allowed";throw error; }
      if (tool.riskLevel === RISK_LEVELS.LOW_RISK_WRITE && tool.autonomous && (!tool.branchBound || input.branch === approvedBranch)) return { authorized: true };
      if (typeof tool.authorizeStandingPolicy === "function") {
        const standingPolicy = await tool.authorizeStandingPolicy(input, context);
        if (standingPolicy?.authorized === true) return { authorized: true, standingPolicy };
      }
      if (context.approvalId) {
        const approval = await storage.getApproval(context.approvalId, ownerId);
        if (approval?.status === "approved" && approval.tool === tool.name && sameArguments(approval.arguments, redact(input)) && (!approval.runId || approval.runId === context.runId)) return { authorized: true, approval };
        throw new Error("Approval does not authorize this action.");
      }
      const approvalArguments = redact(input);
      let approval;
      let reused = false;
      const deduplicatesPending = tool.riskLevel === RISK_LEVELS.SENSITIVE && context.runId && context.conversationId && typeof storage.getApprovalIntentState === "function";
      if (deduplicatesPending) {
        const intent = await storage.getApprovalIntentState(ownerId, { conversationId: context.conversationId, tool: tool.name, arguments: approvalArguments });
        approval = intent.pending;
        reused = Boolean(approval);
        if (!approval) {
          const id = pendingApprovalId({ ownerId, conversationId: context.conversationId, tool: tool.name, arguments: approvalArguments, generation: intent.equivalentCount });
          try {
            approval = await storage.createApproval({ id, ownerId, projectId: context.projectId || null, runId: context.runId, tool: tool.name, reason: tool.approvalReason || `Nova requested ${tool.name}.`, riskLevel: tool.riskLevel, arguments: approvalArguments });
          } catch (error) {
            if (error?.code !== "23505") throw error;
            const raced = await storage.getApproval(id, ownerId);
            const racedRun = raced?.runId ? await storage.getRun(raced.runId, ownerId) : null;
            if (!raced || raced.status !== "pending" || raced.tool !== tool.name || racedRun?.conversationId !== context.conversationId || !sameArguments(raced.arguments, approvalArguments)) throw error;
            approval = raced;
            reused = true;
          }
        }
      } else {
        approval = await storage.createApproval({ id: randomUUID(), ownerId, projectId: context.projectId || null, runId: context.runId || null, tool: tool.name, reason: tool.approvalReason || `Nova requested ${tool.name}.`, riskLevel: tool.riskLevel, arguments: approvalArguments });
      }
      await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: reused ? "approval_reused" : "approval_requested", tool: tool.name, status: "pending", summary: approval.reason, metadata: reused ? { approvalId: approval.id } : {} });
      throw new ApprovalRequiredError(approval);
    }
  });
}
