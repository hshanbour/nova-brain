import test from "node:test";
import assert from "node:assert/strict";
import { createActionPolicy, ApprovalRequiredError, RISK_LEVELS } from "../src/policy/action-policy.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";

const OWNER = "owner";
const tool = Object.freeze({ name: "gmail_send", riskLevel: RISK_LEVELS.SENSITIVE, approvalReason: "Send this exact email." });
const exactEmail = Object.freeze({
  draftId: "draft-1",
  intentHash: "intent-1",
  to: ["customer@example.com"],
  cc: [],
  bcc: [],
  subject: "Subject",
  body: "Body",
});

async function approvalFrom(policy, input, context) {
  try {
    await policy.authorize(tool, input, context);
  } catch (error) {
    assert.ok(error instanceof ApprovalRequiredError);
    return error.approval;
  }
  assert.fail("Sensitive action unexpectedly bypassed approval.");
}

async function fixture() {
  const storage = createInMemoryStorage();
  await storage.initialize({ owner: { id: OWNER } });
  return { storage, policy: createActionPolicy({ storage, ownerId: OWNER, approvedBranch: "feature" }) };
}

test("equivalent sensitive requests in one conversation converge on one pending approval", async () => {
  const { storage, policy } = await fixture();
  const firstRun = await storage.createRun({ id: "run-1", ownerId: OWNER, conversationId: "conversation-1", goal: "send", status: "running" });
  const secondRun = await storage.createRun({ id: "run-2", ownerId: OWNER, conversationId: "conversation-1", goal: "send again", status: "running" });
  const first = await approvalFrom(policy, exactEmail, { runId: firstRun.id, conversationId: "conversation-1" });
  const second = await approvalFrom(policy, exactEmail, { runId: secondRun.id, conversationId: "conversation-1" });
  assert.equal(second.id, first.id);
  assert.equal((await storage.listApprovals(OWNER, { status: "pending", conversationId: "conversation-1" })).length, 1);
  const activity = await storage.listActivity(OWNER);
  assert.equal(activity.filter((event) => event.action === "approval_requested").length, 1);
  assert.equal(activity.filter((event) => event.action === "approval_reused").length, 1);
});

test("pending approval equivalence is exact, owner isolated, and conversation isolated", async () => {
  const { storage, policy } = await fixture();
  for (const [id, conversationId] of [["run-a", "conversation-a"], ["run-b", "conversation-b"], ["run-c", "conversation-a"]]) {
    await storage.createRun({ id, ownerId: OWNER, conversationId, goal: "send", status: "running" });
  }
  const first = await approvalFrom(policy, exactEmail, { runId: "run-a", conversationId: "conversation-a" });
  const otherConversation = await approvalFrom(policy, exactEmail, { runId: "run-b", conversationId: "conversation-b" });
  const changedBody = await approvalFrom(policy, { ...exactEmail, body: "Changed" }, { runId: "run-c", conversationId: "conversation-a" });
  assert.notEqual(otherConversation.id, first.id);
  assert.notEqual(changedBody.id, first.id);
  assert.deepEqual((await storage.listApprovals(OWNER, { conversationId: "conversation-a" })).map(({ id }) => id).sort(), [first.id, changedBody.id].sort());
  assert.deepEqual(await storage.listApprovals("foreign-owner", { conversationId: "conversation-a" }), []);
});

test("a terminal decision permits a fresh later intent but never authorizes a follower run", async () => {
  const { storage, policy } = await fixture();
  await storage.createRun({ id: "run-original", ownerId: OWNER, conversationId: "conversation", goal: "send", status: "running" });
  await storage.createRun({ id: "run-follower", ownerId: OWNER, conversationId: "conversation", goal: "send", status: "running" });
  const pending = await approvalFrom(policy, exactEmail, { runId: "run-original", conversationId: "conversation" });
  const reused = await approvalFrom(policy, exactEmail, { runId: "run-follower", conversationId: "conversation" });
  assert.equal(reused.id, pending.id);
  await storage.decideApproval(pending.id, OWNER, "approved");
  await assert.rejects(
    () => policy.authorize(tool, exactEmail, { approvalId: pending.id, runId: "run-follower", conversationId: "conversation" }),
    /does not authorize/i,
  );
  await policy.authorize(tool, exactEmail, { approvalId: pending.id, runId: "run-original", conversationId: "conversation" });
  const fresh = await approvalFrom(policy, exactEmail, { runId: "run-follower", conversationId: "conversation" });
  assert.notEqual(fresh.id, pending.id);
});
