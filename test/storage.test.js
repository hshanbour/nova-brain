import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { INITIAL_MEMORIES, INITIAL_OWNER_PROFILE, INITIAL_PROJECTS, OWNER_ID } from "../src/identity/initial-context.js";
import { retrieveAgentContext } from "../src/memory/context-retriever.js";

async function seededStorage() {
  const storage = createInMemoryStorage();
  await storage.initialize({ owner: INITIAL_OWNER_PROFILE, projects: INITIAL_PROJECTS, memories: INITIAL_MEMORIES });
  return storage;
}

test("initial seed persists the approved owner identity exactly once", async () => {
  const storage = await seededStorage();
  await storage.initialize({ owner: { ...INITIAL_OWNER_PROFILE, fullName: "Contradictory model output" }, projects: INITIAL_PROJECTS, memories: INITIAL_MEMORIES });
  const owner = await storage.getOwner(OWNER_ID);
  assert.equal(owner.fullName, "Mohammad Shanbour");
  assert.equal(owner.arabicName, "محمد شنبور");
  assert.equal(owner.facts.currentLocation, "Luton, United Kingdom");
  assert.equal(JSON.stringify(owner).includes("hshanbour"), false);
});

test("controlled owner profile updates preserve stable identity and timestamps", async () => {
  const storage = await seededStorage(); const before = await storage.getOwner(OWNER_ID);
  const updated = await storage.updateOwner(OWNER_ID, { preferredName: "Mohammad S.", facts: { ...before.facts, currentLocation: "Luton, UK" } });
  assert.equal(updated.id, OWNER_ID); assert.equal(updated.fullName, "Mohammad Shanbour"); assert.equal(updated.preferredName, "Mohammad S."); assert.equal(updated.createdAt, before.createdAt);
});

test("conversations persist ordered messages and bounded history", async () => {
  const storage = await seededStorage(); await storage.ensureConversation({ id: "conversation-a", ownerId: OWNER_ID });
  await storage.appendMessage({ conversationId: "conversation-a", ownerId: OWNER_ID, role: "user", content: "one" });
  await storage.appendMessage({ conversationId: "conversation-a", ownerId: OWNER_ID, role: "assistant", content: "two" });
  await storage.appendMessage({ conversationId: "conversation-a", ownerId: OWNER_ID, role: "user", content: "three" });
  const recent = await storage.listMessages("conversation-a", OWNER_ID, { limit: 2 });
  assert.deepEqual(recent.map(({ content }) => content), ["two", "three"]); assert.ok(recent[0].sequence < recent[1].sequence);
  assert.deepEqual((await storage.listMessages("conversation-a", OWNER_ID, { limit: 2, offset: 2 })).map(({ content }) => content), ["one"]);
  assert.equal((await storage.listConversations(OWNER_ID))[0].id, "conversation-a");
});

test("long-term memory CRUD preserves category privacy and project scope", async () => {
  const storage = await seededStorage();
  const memory = await storage.createMemory({ ownerId: OWNER_ID, category: "goal", content: "Test a harmless market idea", provenance: "owner-explicit", privacy: "private", sensitivity: "normal", scope: "project", projectId: "nova-brain", status: "active" });
  assert.equal(memory.category, "goal"); assert.equal(memory.privacy, "private"); assert.equal(memory.projectId, "nova-brain");
  const updated = await storage.updateMemory(memory.id, OWNER_ID, { content: "Test one harmless market idea" }); assert.equal(updated.content, "Test one harmless market idea");
  assert.equal((await storage.listMemories(OWNER_ID, { category: "goal" })).length, 1);
  assert.equal(await storage.deleteMemory(memory.id, OWNER_ID), true); assert.equal(await storage.getMemory(memory.id, OWNER_ID), null); assert.equal((await storage.listMemories(OWNER_ID, { category: "goal" })).length, 0);
});

test("retrieval is relevant, limited, project-aware, and excludes deleted memory", async () => {
  const storage = await seededStorage();
  const global = await storage.createMemory({ ownerId: OWNER_ID, category: "goal", content: "Grow a reusable software capability called quasar", provenance: "owner-explicit", privacy: "private", sensitivity: "normal", scope: "global", status: "active" });
  const unrelated = await storage.createMemory({ ownerId: OWNER_ID, category: "decision", content: "Choose a blue notebook", provenance: "owner-explicit", privacy: "private", sensitivity: "normal", scope: "global", status: "active" });
  const results = await storage.retrieveMemories(OWNER_ID, "How should Nova grow quasar software capability?", { limit: 2 });
  assert.ok(results.length <= 2); assert.ok(results.some(({ id }) => id === global.id)); assert.equal(results.some(({ id }) => id === unrelated.id), false);
  const projectResults = await storage.retrieveMemories(OWNER_ID, "barber business", { projectId: "sharp-cuts", limit: 2 });
  assert.ok(projectResults.some(({ projectId }) => projectId === "sharp-cuts"));
  await storage.deleteMemory(global.id, OWNER_ID); assert.equal((await storage.retrieveMemories(OWNER_ID, "grow software capability", { limit: 10 })).some(({ id }) => id === global.id), false);
});

test("general queries discover Sharp Cuts memory without an explicit project", async () => {
  const storage = await seededStorage();
  const results = await storage.retrieveMemories(OWNER_ID, "What do you know about Sharp Cuts?", { limit: 6 });
  assert.ok(results.some(({ id }) => id === "memory_sharp_cuts_context"));
});

test("general queries discover missed-call recovery memory without an explicit project", async () => {
  const storage = await seededStorage();
  const results = await storage.retrieveMemories(OWNER_ID, "Tell me about the missed call recovery business idea", { limit: 6 });
  assert.ok(results.some(({ id }) => id === "memory_missed_call_testbed"));
});

test("one bounded query can retrieve two relevant projects without injecting unrelated projects", async () => {
  const storage = await seededStorage();
  await storage.createMemory({ id: "memory_unrelated_project", ownerId: OWNER_ID, category: "project_context", content: "A ceramics inventory experiment in Bristol", provenance: "owner-explicit", privacy: "private", sensitivity: "business", scope: "project", projectId: "unrelated", status: "active" });
  const results = await storage.retrieveMemories(OWNER_ID, "What do you know about Sharp Cuts and the missed call recovery business idea?", { limit: 4 });
  assert.ok(results.length <= 4);
  assert.ok(results.some(({ id }) => id === "memory_sharp_cuts_context"));
  assert.ok(results.some(({ id }) => id === "memory_missed_call_testbed"));
  assert.equal(results.some(({ id }) => id === "memory_unrelated_project"), false);
});

test("an explicit project strongly boosts rather than gates matching memories", async () => {
  const storage = await seededStorage();
  const results = await storage.retrieveMemories(OWNER_ID, "business project", { projectId: "uk-missed-call-recovery", limit: 1 });
  assert.equal(results[0].id, "memory_missed_call_testbed");
});

test("Postgres candidate selection keeps all active owner memories eligible for ranking", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/storage/postgres-storage.js", import.meta.url), "utf8"));
  assert.match(source, /WHERE owner_id=\$1 AND status='active' ORDER BY updated_at DESC, id ASC LIMIT \$2/);
  assert.doesNotMatch(source, /project_id IS NULL OR project_id=/);
});

test("Postgres autonomy creation explicitly initializes required queue state",async()=>{const source=await import("node:fs/promises").then(({readFile})=>readFile(new URL("../src/storage/postgres-storage.js",import.meta.url),"utf8"));assert.match(source,/task_type,status,priority,current_phase,current_step,max_steps,max_retries,max_runtime_minutes/);assert.match(source,/\$6,'queued',\$7,'queued',0,\$8/);assert.match(source,/completedSteps:\s*\[\],\s*pendingStep:\s*null,\s*findings:\s*\[\]/);});

test("Postgres atomic Worker claim types its JSON idempotency key explicitly",async()=>{const source=await import("node:fs/promises").then(({readFile})=>readFile(new URL("../src/storage/postgres-storage.js",import.meta.url),"utf8"));assert.match(source,/jsonb_build_object\('claimKey',\$6::text\)/);assert.match(source,/FOR UPDATE SKIP LOCKED LIMIT 1/);});

test("Postgres Worker migration atomically uses a monotonic version and writes its audit",async()=>{const source=await import("node:fs/promises").then(({readFile})=>readFile(new URL("../src/storage/postgres-storage.js",import.meta.url),"utf8"));assert.match(source,/WITH updated AS/);assert.match(source,/state_version=\$5::bigint/);assert.match(source,/state_version=state_version\+1/);assert.doesNotMatch(source,/AND updated_at=\$5::timestamptz/);assert.match(source,/lease_token IS NULL OR lease_expires_at<=now\(\)/);assert.match(source,/autonomy_task_migrated/);assert.match(source,/SELECT \* FROM updated/);});

test("Worker task schema safely adds a default version to existing Postgres tasks",async()=>{const source=await import("node:fs/promises").then(({readFile})=>readFile(new URL("../src/storage/schema.js",import.meta.url),"utf8"));assert.match(source,/state_version bigint NOT NULL DEFAULT 1/);assert.match(source,/ALTER TABLE nova_autonomy_tasks ADD COLUMN IF NOT EXISTS state_version/);});

test("temporary conversation messages remain separate from long-term memory", async () => {
  const storage = await seededStorage(); const before = await storage.listMemories(OWNER_ID);
  await storage.ensureConversation({ id: "temporary", ownerId: OWNER_ID }); await storage.appendMessage({ conversationId: "temporary", ownerId: OWNER_ID, role: "user", content: "Do not automatically remember this chat" });
  assert.equal((await storage.listMemories(OWNER_ID)).length, before.length);
});

test("context retrieval minimises sensitive profile facts unless relevant", async () => {
  const storage = await seededStorage();
  const ordinary = await retrieveAgentContext({ storage, ownerId: OWNER_ID, message: "What is my name?", memoryLimit: 3 });
  assert.equal(ordinary.owner.fullName, "Mohammad Shanbour"); assert.equal("familyBackground" in ordinary.owner, false); assert.ok(ordinary.memories.length <= 3);
  const relevant = await retrieveAgentContext({ storage, ownerId: OWNER_ID, message: "What is my family background?", memoryLimit: 3 });
  assert.equal(relevant.owner.familyBackground, "Palestinian");
});
