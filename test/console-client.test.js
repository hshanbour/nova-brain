import test from "node:test";
import assert from "node:assert/strict";
import { createNovaClient, durableTaskIdFromAcknowledgement, durableTaskRecordsFromMessages, NovaApiError } from "../assets/api-client.js";
import { ownerMemoryClient } from "../assets/memory-client.js";

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, async json() { return body; } });

test("durable acknowledgement parser restores only an exact safe task identity", () => {
  const id = "selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.equal(durableTaskIdFromAcknowledgement(`Durable self-development task ${id} is blocked. Track it in Activity; Nova's Persistent Local Worker can continue it independently.`), id);
  for (const unsafe of [
    `Task ${id} is blocked.`,
    `Durable self-development task ${id} is blocked. leaseToken=secret`,
    "Durable self-development task selfdev_invalid is running. Track it in Activity; Nova's Persistent Local Worker can continue it independently.",
    null,
  ]) assert.equal(durableTaskIdFromAcknowledgement(unsafe), null);
});

test("conversation reload reconstructs each durable task identity exactly once", () => {
  const id = "selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", acknowledgement = `Durable self-development task ${id} is blocked. Track it in Activity; Nova's Persistent Local Worker can continue it independently.`;
  const records = durableTaskRecordsFromMessages([
    { role: "assistant", content: acknowledgement, createdAt: "2026-09-24T12:00:00.000Z" },
    { role: "assistant", content: acknowledgement, createdAt: "2026-09-24T12:01:00.000Z" },
    { role: "user", content: acknowledgement },
    { role: "assistant", content: `${acknowledgement} leaseToken=hidden` },
  ], "conversation-1");
  assert.deepEqual(records, [{ taskId: id, conversationId: "conversation-1", startedAt: "2026-09-24T12:00:00.000Z", completedAt: null }]);
  assert.doesNotMatch(JSON.stringify(records), /leaseToken|fingerprint|step input/i);
});

test("console client continues and resets a Nova conversation", async () => {
  const requests = [];
  const client = createNovaClient({ fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return jsonResponse({ message: "Ready", conversationId: "conversation-1", provider: "mock", toolCalls: [], steps: 1 });
  } });
  await client.send("First"); await client.send("Second"); client.reset(); await client.send("New start");
  assert.deepEqual(requests, [{ message: "First" }, { message: "Second", conversationId: "conversation-1" }, { message: "New start" }]);
});

test("console client surfaces safe API errors", async () => {
  const client = createNovaClient({ fetchImpl: async () => jsonResponse({ error: "Request failed safely." }, { ok: false, status: 502 }) });
  await assert.rejects(() => client.send("Hello"), (error) => error instanceof NovaApiError && error.status === 502 && error.message === "Request failed safely.");
});

test("console client handles network and invalid response failures", async () => {
  const unavailable = createNovaClient({ fetchImpl: async () => { throw new Error("secret transport detail"); } });
  const incomplete = createNovaClient({ fetchImpl: async () => jsonResponse({ message: "Missing conversation" }) });
  await assert.rejects(() => unavailable.send("Hello"), /Nova could not be reached/);
  await assert.rejects(() => incomplete.send("Hello"), /incomplete response/);
});

test("console client forwards cancellation and preserves AbortError", async () => {
  const controller = new AbortController(); let receivedSignal;
  const client = createNovaClient({ fetchImpl: async (_url, options) => { receivedSignal = options.signal; const error = new Error("cancelled"); error.name = "AbortError"; throw error; } });
  await assert.rejects(() => client.send("Cancel this turn", { signal: controller.signal }), (error) => error.name === "AbortError");
  assert.equal(receivedSignal, controller.signal);
});

test("console clients use the existing task activity approval and cancellation contracts", async () => {
  const requests=[],originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options={})=>{requests.push({url,method:options.method||"GET",body:options.body});return jsonResponse({task:{id:"selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},activity:[],approvals:[]});};
  try{
    await ownerMemoryClient.task("selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await ownerMemoryClient.taskActivity("selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await ownerMemoryClient.cancelTask("selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    await ownerMemoryClient.approvals();
    await ownerMemoryClient.decideApproval("approval-1","approved");
  }finally{globalThis.fetch=originalFetch;}
  assert.deepEqual(requests,[
    {url:"/api/autonomy/tasks/selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",method:"GET",body:undefined},
    {url:"/api/activity?runId=selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&limit=100",method:"GET",body:undefined},
    {url:"/api/autonomy/tasks/selfdev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/cancel",method:"POST",body:undefined},
    {url:"/api/approvals",method:"GET",body:undefined},
    {url:"/api/approvals/approval-1/decision",method:"POST",body:JSON.stringify({decision:"approved"})},
  ]);
});
