import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createApi } from "../src/http/api.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";

function request({ method = "GET", url, body }) {
  const stream = Readable.from(body ? [body] : []);
  stream.method = method;
  stream.url = url;
  stream.headers = body ? { "content-type": "application/json" } : {};
  return stream;
}

function response() {
  let body = "";
  return {
    statusCode: 200,
    setHeader() {},
    end(value = "") { body += value; },
    get json() { return JSON.parse(body); },
  };
}

function api(storage, toolRegistry = { async execute() { throw new Error("unexpected execution"); } }) {
  return createApi({
    agent: { tools: { list() { return []; } }, async run() { throw new Error("unused"); } },
    config: { allowedOrigins: [], maxBodyBytes: 64 * 1024 },
    storage,
    initialize: async () => {},
    ownerId: "owner",
    toolRegistry,
    logger: { info() {}, error() {} },
  });
}

async function approvalFixture({ status = "pending", id = "approval-one", conversationId = "conversation-one", runId = "run-one", ownerId = "owner" } = {}) {
  const storage = createInMemoryStorage();
  await storage.initialize({ owner: { id: "owner" } });
  await storage.createRun({ id: runId, ownerId, conversationId, goal: "send", status: "waiting_for_approval" });
  await storage.updateRun(runId, ownerId, { result: { approvalId: id, assistantMessageId: `assistant-${id}` } });
  const approval = await storage.createApproval({ id, ownerId, runId, tool: "gmail_send", reason: "Send exact email", riskLevel: "SENSITIVE", arguments: { to: ["to@example.com"], cc: [], bcc: [], subject: "Exact", body: "Body", draftId: "draft", intentHash: "hash" } });
  if (status !== "pending") await storage.decideApproval(id, ownerId, status);
  return { storage, approval };
}

test("pending approval restoration is bounded to authenticated owner and exact conversation", async () => {
  const { storage } = await approvalFixture();
  await storage.createRun({ id: "run-two", ownerId: "owner", conversationId: "conversation-two", goal: "other", status: "waiting_for_approval" });
  await storage.createApproval({ id: "approval-two", ownerId: "owner", runId: "run-two", tool: "future_sensitive", riskLevel: "SENSITIVE", arguments: { target: "other" } });
  await storage.createRun({ id: "run-foreign", ownerId: "foreign", conversationId: "conversation-one", goal: "foreign", status: "waiting_for_approval" });
  await storage.createApproval({ id: "approval-foreign", ownerId: "foreign", runId: "run-foreign", tool: "gmail_send", riskLevel: "SENSITIVE", arguments: { body: "private" } });

  const res = response();
  await api(storage).handle(request({ url: "/api/approvals?status=pending&conversationId=conversation-one&limit=100" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json.approvals.map(({ id }) => id), ["approval-one"]);
  assert.equal(res.json.approvals[0].conversationId, "conversation-one");
  assert.equal(res.json.approvals[0].assistantMessageId, "assistant-approval-one");
});

test("formal approval executes once and reconciles every run reusing that approval", async () => {
  const { storage, approval } = await approvalFixture();
  await storage.createRun({ id: "run-follower", ownerId: "owner", conversationId: "conversation-one", goal: "retry", status: "waiting_for_approval" });
  await storage.updateRun("run-follower", "owner", { result: { approvalId: approval.id, assistantMessageId: "assistant-follower" } });
  let executions = 0;
  const app = api(storage, { async execute(name, args, context) {
    executions += 1;
    assert.equal(name, "gmail_send");
    assert.deepEqual(args, approval.arguments);
    assert.equal(context.approvalId, approval.id);
    assert.equal(context.runId, approval.runId);
    return { sent: true, idempotent: false };
  } });

  const approved = response();
  await app.handle(request({ method: "POST", url: `/api/approvals/${approval.id}/decision`, body: JSON.stringify({ decision: "approved" }) }), approved);
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json.approval.status, "approved");
  assert.equal(executions, 1);
  assert.equal((await storage.getRun("run-one", "owner")).status, "completed");
  const follower = await storage.getRun("run-follower", "owner");
  assert.equal(follower.status, "completed");
  assert.equal(follower.result.approvalDecision, "approved");

  const duplicate = response();
  await app.handle(request({ method: "POST", url: `/api/approvals/${approval.id}/decision`, body: JSON.stringify({ decision: "approved" }) }), duplicate);
  assert.equal(duplicate.statusCode, 404);
  assert.equal(executions, 1);
});

test("formal rejection executes nothing and safely cancels linked synchronous runs", async () => {
  const { storage, approval } = await approvalFixture({ id: "approval-reject", runId: "run-reject" });
  let executions = 0;
  const app = api(storage, { async execute() { executions += 1; } });
  const rejected = response();
  await app.handle(request({ method: "POST", url: `/api/approvals/${approval.id}/decision`, body: JSON.stringify({ decision: "rejected" }) }), rejected);
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.json.approval.status, "rejected");
  assert.equal(executions, 0);
  assert.equal((await storage.getRun("run-reject", "owner")).status, "cancelled");
});
