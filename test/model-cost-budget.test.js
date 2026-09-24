import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import {
  ModelCostBudgetError,
  actualModelCost,
  createModelCostController,
  estimateModelReservation,
} from "../src/providers/model-cost-budget.js";
import { createOpenAIModelProvider } from "../src/providers/openai-model-provider.js";

const ownerId = "owner-a";
const config = (overrides = {}) => ({ budgetId: "authorization-1", globalBudgetUsd: 2, taskBudgetUsd: 1, ...overrides });
async function fixture(overrides) {
  const storage = createInMemoryStorage();
  await storage.initialize({ owner: { id: ownerId, fullName: "Owner", provenance: "test" } });
  return { storage, controller: createModelCostController({ storage, ownerId, config: config(overrides) }) };
}
const request = { model: "gpt-6-luna", input: [{ role: "user", content: "hello" }], max_output_tokens: 256 };

test("sufficient budget reserves before a call and reconciles actual provider usage", async () => {
  const { controller } = await fixture();
  const reservation = await controller.reserve({ model: "gpt-6-luna", stage: "chat", serviceTier: "default", requestBody: request, maxOutputTokens: 256, runId: "run-1" });
  let status = await controller.status();
  assert.ok(status.reservedUsd > 0);
  const accounting = await controller.reconcile(reservation, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 }, { model: "gpt-6-luna", serviceTier: "default" });
  assert.equal(accounting.costStatus, "settled");
  status = await controller.status();
  assert.equal(status.reservedUsd, 0);
  assert.equal(status.spentUsd, actualModelCost({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 }, { model: "gpt-6-luna", serviceTier: "default" }) / 1e9);
});

test("insufficient and zero budgets reject before provider invocation", async () => {
  const { controller } = await fixture({ globalBudgetUsd: 0, taskBudgetUsd: 0 });
  let calls = 0;
  const provider = createOpenAIModelProvider({ apiKey: "secret", model: "gpt-6-luna", costController: controller, async fetchImpl() { calls += 1; throw new Error("must not call"); } });
  await assert.rejects(() => provider.generate({ message: "hello", conversationHistory: [], context: {}, tools: [], stage: "chat" }), (error) => error instanceof ModelCostBudgetError && error.code === "cost_budget_exhausted" && error.status.additionalRequiredUsd > 0);
  assert.equal(calls, 0);
});

test("unknown model pricing fails closed before provider invocation", async () => {
  const { controller } = await fixture();
  let calls = 0;
  const provider = createOpenAIModelProvider({ apiKey: "secret", model: "unknown-model", costController: controller, async fetchImpl() { calls += 1; } });
  await assert.rejects(() => provider.generate({ message: "hello", conversationHistory: [], context: {}, tools: [] }), (error) => error instanceof ModelCostBudgetError && error.code === "model_price_unconfigured");
  assert.equal(calls, 0);
});

test("definitive rejections release reservations while error usage and uncertain failures are charged conservatively", async () => {
  const first = await fixture();
  const rejected = createOpenAIModelProvider({ apiKey: "secret", model: "gpt-6-luna", costController: first.controller, async fetchImpl() { return new Response('{"error":{"code":"bad_request"}}', { status: 400 }); } });
  await assert.rejects(() => rejected.generate({ message: "hello", conversationHistory: [], context: {}, tools: [] }));
  assert.deepEqual(await first.controller.status(), { budgetId: "authorization-1", authorizedUsd: 2, spentUsd: 0, reservedUsd: 0, remainingUsd: 2 });

  const metered = await fixture();
  const meteredError = createOpenAIModelProvider({ apiKey: "secret", model: "gpt-6-luna", costController: metered.controller, async fetchImpl() { return new Response(JSON.stringify({ error: { code: "provider_error" }, usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } }), { status: 500 }); } });
  await assert.rejects(() => meteredError.generate({ message: "hello", conversationHistory: [], context: {}, tools: [] }));
  assert.equal((await metered.controller.status()).spentUsd, actualModelCost({ inputTokens: 100, outputTokens: 5 }, { model: "gpt-6-luna", serviceTier: "default" }) / 1e9);

  const second = await fixture();
  const timedOut = createOpenAIModelProvider({ apiKey: "secret", model: "gpt-6-luna", costController: second.controller, async fetchImpl() { throw new DOMException("timeout", "AbortError"); } });
  await assert.rejects(() => timedOut.generate({ message: "hello", conversationHistory: [], context: {}, tools: [] }));
  const uncertain = await second.controller.status();
  assert.equal(uncertain.reservedUsd, 0);
  assert.ok(uncertain.spentUsd > 0);
});

test("concurrent reservations cannot overspend the same global envelope", async () => {
  const estimate = estimateModelReservation({ requestBody: request, model: "gpt-6-sol", serviceTier: "default", maxOutputTokens: 128_000 });
  const cap = estimate.reservedNanoUsd / 1e9;
  const { controller } = await fixture({ globalBudgetUsd: cap, taskBudgetUsd: cap });
  const results = await Promise.allSettled([1, 2].map((index) => controller.reserve({ model: "gpt-6-sol", stage: "planner", serviceTier: "default", requestBody: request, maxOutputTokens: 128_000, taskId: `selfdev_${String(index).repeat(32)}` })));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(results.filter((item) => item.status === "rejected" && item.reason.code === "cost_budget_exhausted").length, 1);
});

test("task ceilings are independent while every task still consumes the global envelope", async () => {
  const { controller } = await fixture({ globalBudgetUsd: 5, taskBudgetUsd: 0.1 });
  const taskId = `selfdev_${"a".repeat(32)}`;
  await assert.rejects(() => controller.reserve({ model: "gpt-6-sol", stage: "planner", serviceTier: "default", requestBody: request, maxOutputTokens: 128_000, taskId }), (error) => error.code === "cost_budget_exhausted" && error.status.taskId === taskId);
  const chat = await controller.reserve({ model: "gpt-6-luna", stage: "chat", serviceTier: "default", requestBody: request, maxOutputTokens: 256 });
  await controller.release(chat);
  assert.equal((await controller.status()).spentUsd, 0);
});

test("durable accounting survives controller restart and only trusted configuration can increase authority", async () => {
  const { storage, controller } = await fixture({ globalBudgetUsd: 0.001, taskBudgetUsd: 0.001 });
  const reservation = await controller.reserve({ model: "gpt-6-luna", stage: "chat", serviceTier: "default", requestBody: request, maxOutputTokens: 256 });
  await controller.reconcile(reservation, { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, { model: "gpt-6-luna", serviceTier: "default" });
  const restarted = createModelCostController({ storage, ownerId, config: config({ globalBudgetUsd: 0.001, taskBudgetUsd: 0.001 }) });
  assert.equal((await restarted.status()).spentUsd, (await controller.status()).spentUsd);
  const inFlight = await restarted.reserve({ model: "gpt-6-luna", stage: "chat", serviceTier: "default", requestBody: request, maxOutputTokens: 256 });
  const restartedWithReservation = createModelCostController({ storage, ownerId, config: config({ globalBudgetUsd: 0.001, taskBudgetUsd: 0.001 }) });
  assert.equal((await restartedWithReservation.status()).reservedUsd, inFlight.reservedNanoUsd / 1e9);
  await restartedWithReservation.release(inFlight);
  const increased = createModelCostController({ storage, ownerId, config: config({ globalBudgetUsd: 1, taskBudgetUsd: 0.5 }) });
  assert.ok((await increased.status()).remainingUsd > (await restarted.status()).remainingUsd);
});

test("completed provider calls expose bounded cost telemetry and release unused reservation", async () => {
  const { controller } = await fixture();
  const provider = createOpenAIModelProvider({ apiKey: "secret", model: "gpt-6-luna", costController: controller, async fetchImpl() { return new Response(JSON.stringify({ id: "response-1", service_tier: "default", usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 50 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 110 }, output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200, headers: { "content-type": "application/json" } }); } });
  const result = await provider.generate({ message: "hello", conversationHistory: [], context: {}, tools: [], stage: "chat", costContext: { runId: "run-1" } });
  assert.equal(result.providerUsage.costStatus, "settled");
  assert.ok(result.providerUsage.estimatedCostUsd > 0);
  const status = await controller.status();
  assert.equal(status.reservedUsd, 0);
  assert.equal(status.spentUsd, result.providerUsage.estimatedCostUsd);
});

test("Chat and planner calls share the global ledger while only task-bound work consumes its task ceiling", async () => {
  const { controller } = await fixture();
  let responseNumber = 0;
  const fetchImpl = async () => new Response(JSON.stringify({ id: `response-${++responseNumber}`, service_tier: "default", usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200 });
  const provider = createOpenAIModelProvider({ apiKey: "secret", model: "gpt-6-luna", routes: { planner: { model: "gpt-6-sol", maxOutputTokens: 256 } }, costController: controller, fetchImpl });
  await provider.generate({ message: "chat", conversationHistory: [], context: {}, tools: [], stage: "chat", costContext: { runId: "run-1", globalBudgetUsd: 999 } });
  const taskId = `selfdev_${"b".repeat(32)}`;
  await provider.generate({ message: "plan", conversationHistory: [], context: {}, tools: [], stage: "planner", costContext: { taskId } });
  const global = await controller.status();
  const task = await controller.status(taskId);
  assert.ok(global.spentUsd > task.taskSpentUsd);
  assert.ok(task.taskSpentUsd > 0);
  assert.equal(global.authorizedUsd, 2);
});

test("uncertain billed attempts consume authority so a retry cannot silently overspend", async () => {
  const estimate = estimateModelReservation({ requestBody: request, model: "gpt-6-luna", serviceTier: "default", maxOutputTokens: 256 });
  const { controller } = await fixture({ globalBudgetUsd: estimate.reservedNanoUsd / 1e9, taskBudgetUsd: estimate.reservedNanoUsd / 1e9 });
  const provider = createOpenAIModelProvider({ apiKey: "secret", model: "gpt-6-luna", routes: { chat: { model: "gpt-6-luna", maxOutputTokens: 256 } }, costController: controller, async fetchImpl() { throw new DOMException("timeout", "AbortError"); } });
  await assert.rejects(() => provider.generate({ message: "hello", conversationHistory: [], context: {}, tools: [], stage: "chat" }));
  await assert.rejects(() => provider.generate({ message: "hello", conversationHistory: [], context: {}, tools: [], stage: "chat" }), (error) => error.code === "cost_budget_exhausted");
});
