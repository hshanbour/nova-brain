import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAgent } from "../src/agent/agent.js";
import { createMemoryLearningService, classifyTypedMemoryCandidate } from "../src/memory/learning-service.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createTerminalTaskReporter } from "../src/autonomy/terminal-task-reporter.js";
import { createMockModelProvider } from "../src/providers/mock-model-provider.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createApi } from "../src/http/api.js";
import { Readable } from "node:stream";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION } from "../src/storage/schema.js";

const OWNER = "owner";

async function fixture() {
  let tick = 0;
  const storage = createInMemoryStorage({ clock: () => new Date(Date.UTC(2026, 9, 8, 12, 0, tick++)) });
  await storage.initialize({ owner: { id: OWNER, fullName: "Mohammad" }, projects: [{ id: "sharp-cuts", name: "Sharp Cuts" }] });
  await storage.ensureConversation({ id: "conversation-learning", ownerId: OWNER });
  return { storage, learning: createMemoryLearningService({ storage, ownerId: OWNER }) };
}

test("schema twenty-two preserves memory candidates and bounded evidence", () => {
  assert.ok(SCHEMA_VERSION >= 22);
  assert.ok(SCHEMA_STATEMENTS.some((statement) => statement.includes("nova_memories_evidence_size")));
  const sql = SCHEMA_STATEMENTS.find((statement) => statement.includes("CREATE TABLE IF NOT EXISTS nova_memory_candidates"));
  assert.match(sql, /UNIQUE\(owner_id,fingerprint\)/);
  assert.match(sql, /octet_length\(content\) BETWEEN 1 AND 8192/);
  assert.match(sql, /pending.*accepted.*rejected.*superseded/);
});

test("typed owner evidence creates one pending candidate and never promotes automatically", async () => {
  const { storage, learning } = await fixture();
  const input = { message: "I prefer Nova to summarize business research in concise bullet points.", conversationId: "conversation-learning", userMessageId: "user-1", assistantMessageId: "assistant-1", runId: "run-1" };
  const first = await learning.observeConversationTurn(input);
  const duplicate = await learning.observeConversationTurn({ ...input, userMessageId: "user-2", assistantMessageId: "assistant-2", runId: "run-2" });
  assert.equal(first.created, true);
  assert.equal(first.candidate.candidateType, "preference");
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.candidate.id, first.candidate.id);
  assert.equal((await storage.listMemoryCandidates(OWNER, { status: "pending" })).length, 1);
  assert.equal((await storage.listMemories(OWNER)).length, 0);
  assert.deepEqual(first.candidate.evidence, { version: 1, userMessageId: "user-1", assistantMessageId: "assistant-1", runId: "run-1", conversationId: "conversation-learning", extraction: "deterministic_v1", authoritative: false });
});

test("explicit memory commands, secrets, and ordinary chat do not become candidates", async () => {
  const { storage, learning } = await fixture();
  for (const [index, message] of [
    "Remember that I prefer the weekly report on Friday.",
    "My API key = secret-value-123456789",
    "How is the business doing today?"
  ].entries()) assert.equal(await learning.observeConversationTurn({ message, conversationId: "conversation-learning", userMessageId: `excluded-${index}` }), null);
  assert.equal((await storage.listMemoryCandidates(OWNER, {})).length, 0);
});

test("owner review accepts, rejects, and supersedes through existing memory", async () => {
  const { storage, learning } = await fixture();
  const oldMemory = await storage.createMemory({ id: "old-preference", ownerId: OWNER, category: "preference", content: "Mohammad prefers long reports.", provenance: "owner-explicit", privacy: "private", sensitivity: "normal", scope: "global", status: "active" });
  const correction = await learning.observeConversationTurn({ message: "Correction: I prefer concise reports now.", conversationId: "conversation-learning", userMessageId: "correction-user" });
  const accepted = await learning.reviewCandidate(correction.candidate.id, { decision: "accepted", supersedesMemoryId: oldMemory.id, reason: "Owner reviewed the correction." });
  assert.equal(accepted.candidate.status, "accepted");
  assert.equal(accepted.memory.status, "active");
  assert.equal((await storage.retrieveMemories(OWNER, "concise reports", { limit: 5 }))[0].id, accepted.memory.id);
  assert.equal((await storage.listMemories(OWNER)).find((memory) => memory.id === oldMemory.id).status, "superseded");
  const replay = await learning.reviewCandidate(correction.candidate.id, { decision: "accepted", supersedesMemoryId: oldMemory.id });
  assert.equal(replay.idempotent, true);

  const unresolved = await learning.observeConversationTurn({ message: "We need to verify whether Saturday promotions improve retention.", conversationId: "conversation-learning", userMessageId: "question-user" });
  const rejected = await learning.reviewCandidate(unresolved.candidate.id, { decision: "rejected", reason: "Not reusable." });
  assert.equal(rejected.candidate.status, "rejected");
  assert.equal(rejected.memory, null);
  const actions = (await storage.listActivity(OWNER, { limit: 20 })).map((item) => item.action);
  assert.ok(actions.includes("memory_candidate_accepted"));
  assert.ok(actions.includes("memory_candidate_rejected"));
});

test("a correction cannot be accepted without an explicit active supersession target", async () => {
  const { learning } = await fixture();
  const correction = await learning.observeConversationTurn({ message: "Correction: I prefer concise reports now.", conversationId: "conversation-learning", userMessageId: "correction-no-target" });
  await assert.rejects(() => learning.reviewCandidate(correction.candidate.id, { decision: "accepted" }), (error) => error.code === "memory_correction_target_required");
});

test("candidate review remains owner isolated", async () => {
  const { storage, learning } = await fixture();
  const pending = await learning.observeConversationTurn({ message: "My business is a private owner-only fact.", conversationId: "conversation-learning", userMessageId: "private-user" });
  assert.equal(await storage.getMemoryCandidate(pending.candidate.id, "other-owner"), null);
  assert.equal(await storage.decideMemoryCandidate(pending.candidate.id, "other-owner", { decision: "accepted" }), null);
  assert.equal((await storage.listMemoryCandidates("other-owner", {})).length, 0);
});

test("canonical completed and failed task outcomes become pending evidence exactly once", async () => {
  const { storage, learning } = await fixture();
  const reporter = createTerminalTaskReporter({ storage, ownerId: OWNER, learningService: learning });
  let completed = await storage.createAutonomyTask({ id: `web_${"a".repeat(32)}`, ownerId: OWNER, projectId: "sharp-cuts", title: "Retention research", objective: "Research retention", taskType: "public_web_research", metadata: { terminalReporting: { version: 1, conversationId: "conversation-learning" }, researchFinalAnswer: "Evidence indicates appointment reminders can reduce missed appointments. [Source](https://example.com/evidence)" } });
  completed = await storage.updateAutonomyTask(completed.id, OWNER, { status: "completed", currentPhase: "completed", resultSummary: "Research completed." }, completed.stateVersion);
  let failed = await storage.createAutonomyTask({ id: `web_${"b".repeat(32)}`, ownerId: OWNER, projectId: "sharp-cuts", title: "Failed research", objective: "Research pricing", taskType: "public_web_research", metadata: { terminalReporting: { version: 1, conversationId: "conversation-learning" } } });
  failed = await storage.updateAutonomyTask(failed.id, OWNER, { status: "failed", currentPhase: "failed", errorCode: "source_unavailable", blockedReason: "The authoritative source was unavailable." }, failed.stateVersion);
  await reporter.reconcile();
  await reporter.reconcile();
  const candidates = await storage.listMemoryCandidates(OWNER, { status: "pending" });
  assert.equal(candidates.length, 2);
  assert.deepEqual(new Set(candidates.map((item) => item.candidateType)), new Set(["completed_task_outcome", "failed_task_lesson"]));
  assert.match(candidates.find((item) => item.sourceTaskId === completed.id).content, /\[Source\]\(https:\/\/example\.com\/evidence\)/);
  assert.equal((await storage.listMemories(OWNER)).length, 0);
});

test("the existing agent pipeline captures typed candidates after persisting exact message identity", async () => {
  const { storage, learning } = await fixture();
  const agent = createAgent({ storage, ownerId: OWNER, learningService: learning, modelProvider: createMockModelProvider(), toolRegistry: createToolRegistry() });
  const result = await agent.run({ message: "I prefer Nova to keep business answers practical.", conversationId: "conversation-learning", requestId: "request-learning" });
  const [candidate] = await storage.listMemoryCandidates(OWNER, { status: "pending" });
  assert.equal(candidate.sourceMessageId, result.userMessageId);
  assert.equal(candidate.evidence.assistantMessageId, result.id);
  assert.deepEqual((await storage.listMessages("conversation-learning", OWNER)).map((message) => message.id), [result.userMessageId, result.id]);
});

test("classification supports bounded English and Arabic evidence types", () => {
  assert.equal(classifyTypedMemoryCandidate("قررت أن مشروع شارب كتس هو الأولوية الحالية.").candidateType, "project_decision");
  assert.equal(classifyTypedMemoryCandidate("فرضية: مواعيد التذكير ممكن تحسن الحضور.").candidateType, "hypothesis");
  assert.equal(classifyTypedMemoryCandidate("We need to verify whether this is still current.").candidateType, "unresolved_question");
});

test("Console exposes the minimal candidate review UI and API client", async () => {
  const [html, consoleSource, clientSource] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../assets/console.js", import.meta.url), "utf8"),
    readFile(new URL("../assets/memory-client.js", import.meta.url), "utf8")
  ]);
  assert.match(html, /Learning candidates/);
  assert.match(consoleSource, /Accept/);
  assert.match(consoleSource, /Reject/);
  assert.match(clientSource, /\/api\/memory-candidates/);
});

test("candidate review HTTP routes list and decide without exposing another owner", async () => {
  const { storage, learning } = await fixture();
  const pending = await learning.observeConversationTurn({ message: "I prefer Nova to keep reports concise.", conversationId: "conversation-learning", userMessageId: "api-user" });
  const api = createApi({
    agent: { tools: { list() { return []; } }, async run() { throw new Error("unused"); } },
    config: { allowedOrigins: [], maxBodyBytes: 64 * 1024 }, storage, initialize: async () => {}, ownerId: OWNER,
    learningService: learning, logger: { info() {}, error() {} }
  });
  const invoke = async ({ method, url, body }) => {
    const request = Readable.from(body ? [JSON.stringify(body)] : []); request.method = method; request.url = url; request.headers = body ? { "content-type": "application/json" } : {};
    let content = ""; const response = { setHeader() {}, end(value = "") { content += value; } };
    await api.handle(request, response); return { status: response.statusCode, body: JSON.parse(content) };
  };
  const listed = await invoke({ method: "GET", url: "/api/memory-candidates?status=pending" });
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.candidates.map((item) => item.id), [pending.candidate.id]);
  const decided = await invoke({ method: "POST", url: `/api/memory-candidates/${pending.candidate.id}/decision`, body: { decision: "accepted" } });
  assert.equal(decided.status, 200); assert.equal(decided.body.candidate.status, "accepted"); assert.ok(decided.body.memory.id);
  const invalid = await invoke({ method: "POST", url: `/api/memory-candidates/${pending.candidate.id}/decision`, body: { decision: "rejected", supersedesMemoryId: "not-allowed" } });
  assert.equal(invalid.status, 400);
});
