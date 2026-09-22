import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIModelProvider, OpenAIProviderError, toolDefinition } from "../src/providers/openai-model-provider.js";

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
  assert.equal(firstBody.tools[0].strict, false);
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
      return { ok: false, status: 401, async text() { return 'invalid sk-secret-key Authorization: Bearer abc.def'; } };
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
    (error) => error instanceof OpenAIProviderError &&
      error.message === "OpenAI request failed with status 401." &&
      error.upstreamStatus === 401 &&
      !error.safeDetail.includes("sk-secret-key") &&
      !error.safeDetail.includes("abc.def")
  );
});

test("OpenAI provider preserves bounded structured upstream diagnostics", async () => {
  const provider = createOpenAIModelProvider({
    apiKey: "secret-key",
    model: "gpt-test",
    async fetchImpl() {
      return { ok: false, status: 400, async text() { return JSON.stringify({ error: { message: "Invalid schema. Missing 'tests'. sk-secret-value", type: "invalid_request_error", param: "text.format.schema", code: "invalid_json_schema" } }); } };
    }
  });
  await assert.rejects(() => provider.generate({
    message: "structured", conversationHistory: [], context: {}, tools: [],
    responseFormat: { name: "bounded_plan", schema: { type:"object", properties:{ok:{type:"boolean"}}, required:["ok"], additionalProperties:false }, strict:true }
  }), error => {
    assert.deepEqual(error.safeDiagnostics, {
      stage:"openai_response", endpoint:"/v1/responses", requestMode:"responses_json_schema", model:"gpt-test", responseFormatName:"bounded_plan",
      upstreamStatus:400, upstreamErrorType:"invalid_request_error", upstreamErrorCode:"invalid_json_schema", upstreamErrorParam:"text.format.schema",
      upstreamErrorMessage:"Invalid schema. Missing 'tests'. [redacted]", rejectedSchemaField:"tests"
    });
    assert.doesNotMatch(JSON.stringify(error), /secret-value/);
    return true;
  });
});

test("OpenAI provider forwards the active synchronous AbortSignal", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const provider = createOpenAIModelProvider({
    apiKey: "test-secret",
    model: "test-model",
    async fetchImpl(_url, options) {
      receivedSignal = options.signal;
      return jsonResponse({ id: "resp", output: [{ type: "message", content: [{ type: "output_text", text: "Done" }] }] });
    },
  });
  await provider.generate({ message: "Hello", conversationHistory: [], context: {}, tools: [], signal: controller.signal });
  assert.equal(receivedSignal, controller.signal);
});

test("OpenAI provider sends a strict Responses JSON schema when requested",async()=>{let body;const schema={type:"object",properties:{ok:{type:"boolean"}},required:["ok"],additionalProperties:false},provider=createOpenAIModelProvider({apiKey:"test-secret",model:"test-model",async fetchImpl(_url,options){body=JSON.parse(options.body);return jsonResponse({id:"structured",output:[{type:"message",content:[{type:"output_text",text:'{"ok":true}'}]}]});}}),result=await provider.generate({message:"structured",conversationHistory:[],context:{},tools:[],responseFormat:{name:"bounded_plan",schema,strict:true}});assert.deepEqual(body.text.format,{type:"json_schema",name:"bounded_plan",schema,strict:true});assert.deepEqual(result,{type:"final",message:'{"ok":true}'});});

test("OpenAI provider applies stage cost controls and returns bounded usage telemetry",async()=>{let body;const provider=createOpenAIModelProvider({apiKey:"test-secret",model:"strong",serviceTier:"default",routes:{chat:{model:"cheap",reasoningEffort:"low",maxOutputTokens:2048}},async fetchImpl(_url,options){body=JSON.parse(options.body);return jsonResponse({id:"usage",service_tier:"default",usage:{input_tokens:1200,input_tokens_details:{cached_tokens:1024},output_tokens:80,output_tokens_details:{reasoning_tokens:20},total_tokens:1280},output:[{type:"message",content:[{type:"output_text",text:"Done"}]}]});}}),result=await provider.generate({message:"hello",conversationHistory:[],context:{},tools:[],stage:"chat"});assert.equal(body.model,"cheap");assert.equal(body.service_tier,"default");assert.deepEqual(body.reasoning,{effort:"low"});assert.equal(body.max_output_tokens,2048);assert.deepEqual(result.providerUsage,{model:"cheap",stage:"chat",serviceTier:"default",inputTokens:1200,cachedInputTokens:1024,outputTokens:80,reasoningTokens:20,totalTokens:1280});});

test("OpenAI provider rejects untrusted stages and premium tiers",async()=>{assert.throws(()=>createOpenAIModelProvider({apiKey:"key",model:"model",serviceTier:"priority"}),/default or flex/);const provider=createOpenAIModelProvider({apiKey:"key",model:"model",async fetchImpl(){throw new Error("must not call");}});await assert.rejects(()=>provider.generate({message:"hello",conversationHistory:[],context:{},tools:[],stage:"arbitrary"}),/Unsupported OpenAI execution stage/);});

test("strict Responses schemas fail locally before an invalid provider request",async()=>{let calls=0;const provider=createOpenAIModelProvider({apiKey:"test-secret",model:"test-model",async fetchImpl(){calls++;return jsonResponse({});}});await assert.rejects(()=>provider.generate({message:"structured",conversationHistory:[],context:{},tools:[],responseFormat:{name:"invalid",schema:{type:"object",properties:{requiredValue:{type:"string"},optionalValue:{type:"string"}},required:["requiredValue"],additionalProperties:false},strict:true}}),/require every property.*response_format\.invalid/);assert.equal(calls,0);});

test("tool definitions default to non-strict and support no, optional, and required arguments", () => {
  const definitions = [
    toolDefinition({ name: "no_args" }),
    toolDefinition({ name: "optional", inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } }),
    toolDefinition({ name: "required", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } })
  ];
  assert.deepEqual(definitions.map(({ strict }) => strict), [false, false, false]);
  assert.deepEqual(definitions[0].parameters, { type: "object", properties: {}, additionalProperties: false });
});

test("explicit strict schemas are validated before an OpenAI request", () => {
  assert.throws(() => toolDefinition({
    name: "invalid_optional_strict",
    strict: true,
    inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false }
  }), /require every property/);
  assert.equal(toolDefinition({
    name: "valid_strict",
    strict: true,
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
  }).strict, true);
});
