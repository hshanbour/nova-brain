import test from "node:test";
import assert from "node:assert/strict";
import { createNovaClient, NovaApiError } from "../assets/api-client.js";

const jsonResponse = (body, { ok = true, status = 200 } = {}) => ({ ok, status, async json() { return body; } });

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
