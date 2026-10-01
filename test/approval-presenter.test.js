import test from "node:test";
import assert from "node:assert/strict";
import { approvalViewModel, createApprovalPresenter } from "../assets/approval-presenter.js";

const gmailApproval = (overrides = {}) => ({
  id: "approval-gmail",
  tool: "gmail_send",
  reason: "Send this exact email.",
  status: "pending",
  arguments: {
    draftId: "draft-private",
    intentHash: "hash-private",
    to: ["to@example.com"],
    cc: ["cc@example.com"],
    bcc: [],
    subject: "Exact subject",
    body: "Exact body",
    accessToken: "never-render",
  },
  ...overrides,
});

test("Gmail approval presentation exposes only the exact immutable owner-facing email", () => {
  const model = approvalViewModel(gmailApproval(), { gmailAccountEmail: "nova@example.com" });
  assert.equal(model.title, "Approve email send");
  assert.deepEqual(model.fields, [
    ["From", "nova@example.com"],
    ["To", "to@example.com"],
    ["CC", "cc@example.com"],
    ["BCC", "None"],
    ["Subject", "Exact subject"],
    ["Body", "Exact body"],
  ]);
  assert.doesNotMatch(JSON.stringify(model), /draft-private|hash-private|never-render|accessToken/i);
});

test("generic synchronous approval presentation redacts credential-shaped arguments", () => {
  const model = approvalViewModel({
    id: "approval-generic",
    tool: "future_external_action",
    status: "pending",
    arguments: { target: "customer", nested: { apiKey: "secret", note: "safe" } },
  });
  assert.equal(model.kind, "generic");
  assert.match(model.fields[0][1], /customer/);
  assert.match(model.fields[0][1], /\[REDACTED\]/);
  assert.doesNotMatch(model.fields[0][1], /"secret"/);
});

test("presenter is idempotent by approval id and suppresses duplicate decisions", async () => {
  const rendered = new Map();
  const decisions = [];
  let release;
  const decisionGate = new Promise((resolve) => { release = resolve; });
  const presenter = createApprovalPresenter({
    render(model, context) { rendered.set(model.id, { model, context }); },
    async decide(id, decision) { decisions.push({ id, decision }); await decisionGate; return { approval: gmailApproval({ status: decision }) }; },
    async getGmailAccount() { return "nova@example.com"; },
  });
  await presenter.upsert(gmailApproval(), { conversationId: "conversation-1" });
  await presenter.upsert(gmailApproval(), { conversationId: "conversation-1" });
  assert.equal(rendered.size, 1);

  const first = presenter.decide("approval-gmail", "approved");
  const duplicate = await presenter.decide("approval-gmail", "approved");
  assert.equal(duplicate, null);
  assert.equal(decisions.length, 1);
  release();
  await first;
  assert.equal(rendered.get("approval-gmail").model.status, "approved");
  assert.equal(rendered.get("approval-gmail").model.pending, false);
});

test("presenter reconciles an ambiguous decision failure to authoritative server state", async () => {
  const rendered = [];
  const presenter = createApprovalPresenter({
    render(model) { rendered.push(model); },
    async decide() { throw new Error("network response lost"); },
    async reconcile() { return gmailApproval({ status: "rejected" }); },
    async getGmailAccount() { return "nova@example.com"; },
  });
  await presenter.upsert(gmailApproval());
  await assert.rejects(() => presenter.decide("approval-gmail", "rejected"), /network response lost/);
  assert.equal(rendered.at(-1).status, "rejected");
  assert.equal(rendered.at(-1).pending, false);
});
