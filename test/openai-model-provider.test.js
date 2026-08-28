import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIModelProvider } from "../src/providers/openai-model-provider.js";

function jsonResponse(payload) {
  return { ok: true, status: 200, async json() { return payload; } };
}

test("OpenAI provider translates Responses API tool calls and results", async () => {
  const requests = [];
  const responses = [
    {
      id: "resp_1",
      output: [
        { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"id":7}' }
      ]
    },
    {
      id: "resp_2",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Found it." }] }
      ]
    }
  ];
  const provider = createOpenAIModelProvider({
    apiKey: "test-secret",
    model: "test-model",
    async fetchImpl(url, options) {
      requests.push({ url, options });
      return jsonResponse(responses.shift());
    }
  });
  const common = {
    message: "Find seven",
    conversationHistory: [],
    context: {},
    tools: [
      {
        name: "lookup",
        description: "Looks up an ID",
        inputSchema: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
          additionalProperties: false
        }
      }
    ]
  };

  const first = await provider.generate(common);
  const second = await provider.generate({
    ...common,
    continuationToken: first.continuationToken,
    toolResults: [{ id: "call_1", output: { ok: true, result: { name: "Seven" } } }]
  });

  assert.deepEqual(first, {
    type: "tool_calls",
    toolCalls: [{ id: "call_1", name: "lookup", arguments: { id: 7 } }],
    continuationToken: "resp_1"
  });
  assert.deepEqual(second, { type: "final", message: "Found it." });
  const firstBody = JSON.parse(requests[0].options.body);
  const secondBody = JSON.parse(requests[1].options.body);
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-secret");
  assert.equal(firstBody.tools[0].name, "lookup");
  assert.equal(firstBody.tools[0].strict, true);
  assert.equal(secondBody.previous_response_id, "resp_1");
  assert.deepEqual(secondBody.input, [
    {
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ ok: true, result: { name: "Seven" } })
    }
  ]);
});

test("OpenAI provider failures do not expose response bodies or API keys", async () => {
  const provider = createOpenAIModelProvider({
    apiKey: "secret-key",
    model: "test-model",
    async fetchImpl() {
      return { ok: false, status: 401 };
    }
  });

  await assert.rejects(
    () =>
      provider.generate({
        message: "Hello",
        conversationHistory: [],
        context: {},
        tools: []
      }),
    (error) => error.message === "OpenAI request failed with status 401."
  );
});
