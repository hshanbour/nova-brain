import { randomUUID } from "node:crypto";

export const RISK_LEVELS = Object.freeze({ READ_ONLY: "READ_ONLY", LOW_RISK_WRITE: "LOW_RISK_WRITE", SENSITIVE: "SENSITIVE", HIGH_IMPACT: "HIGH_IMPACT" });
export class ApprovalRequiredError extends Error { constructor(approval) { super(`Owner approval required for ${approval.tool}.`); this.approval = approval; } }

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const sameArguments = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
function redact(value) { if (Array.isArray(value)) return value.map(redact); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,item])=>[/token|secret|password|authorization|api.?key/i.test(key)?key:key, /token|secret|password|authorization|api.?key/i.test(key)?"[REDACTED]":redact(item)])); return value; }

export function createActionPolicy({ storage, ownerId, approvedBranch }) {
  return Object.freeze({
    async authorize(tool, input, context = {}) {
      if (tool.riskLevel === RISK_LEVELS.READ_ONLY) return { authorized: true };
      if (tool.branchBound && input.branch !== approvedBranch) { const error=new Error("Branch is not approved for development writes.");error.code="branch_not_allowed";throw error; }
      if (tool.riskLevel === RISK_LEVELS.LOW_RISK_WRITE && tool.autonomous && (!tool.branchBound || input.branch === approvedBranch)) return { authorized: true };
      if (context.approvalId) {
        const approval = await storage.getApproval(context.approvalId, ownerId);
        if (approval?.status === "approved" && approval.tool === tool.name && sameArguments(approval.arguments, redact(input)) && (!approval.runId || approval.runId === context.runId)) return { authorized: true, approval };
        throw new Error("Approval does not authorize this action.");
      }
      const approval = await storage.createApproval({ id: randomUUID(), ownerId, projectId: context.projectId || null, runId: context.runId || null, tool: tool.name, reason: tool.approvalReason || `Nova requested ${tool.name}.`, riskLevel: tool.riskLevel, arguments: redact(input) });
      await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: context.runId || null, action: "approval_requested", tool: tool.name, status: "pending", summary: approval.reason });
      throw new ApprovalRequiredError(approval);
    }
  });
}
