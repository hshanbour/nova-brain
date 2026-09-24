import { randomUUID } from "node:crypto";

const NANOS_PER_USD = 1_000_000_000;
const TOKENS_PER_MILLION = 1_000_000;
const LONG_CONTEXT_THRESHOLD = 272_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 128_000;

// One auditable price source for every model Nova may call. Values are USD per
// million text tokens at Standard processing, current as of 2026-09-24.
export const NOVA_OPENAI_PRICING = Object.freeze({
  "gpt-6-luna": Object.freeze({ input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 }),
  "gpt-6-sol": Object.freeze({ input: 2.00, cachedInput: 0.20, cacheWrite: 2.50, output: 10.00 }),
});

const tierMultiplier = (tier) => tier === "flex" ? 0.5 : 1;
const usdToNanos = (value) => Math.round(value * NANOS_PER_USD);
const nanosToUsd = (value) => Math.round((Number(value || 0) / NANOS_PER_USD) * 1e9) / 1e9;
const positiveInteger = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

export class ModelCostBudgetError extends Error {
  constructor(code, status) {
    if (code === "model_price_unconfigured") {
      super("Nova has no trusted configured price for this model. The model call was blocked before provider invocation.");
      this.name = "ModelCostBudgetError";
      this.code = code;
      this.status = status;
      return;
    }
    const task = status?.taskId ? ` Task ${status.taskId} has spent $${status.taskSpentUsd.toFixed(6)} of $${status.taskAuthorizedUsd.toFixed(2)}.` : "";
    const additional = status?.additionalRequiredUsd > 0 ? ` At least $${status.additionalRequiredUsd.toFixed(6)} of additional authorization is required for this reservation.` : "";
    super(`Nova's authorized model budget is insufficient for the next bounded call. $${status?.spentUsd?.toFixed?.(6) || "0.000000"} spent, $${status?.reservedUsd?.toFixed?.(6) || "0.000000"} reserved, $${status?.authorizedUsd?.toFixed?.(2) || "0.00"} authorized.${task}${additional}`);
    this.name = "ModelCostBudgetError";
    this.code = code;
    this.status = status;
  }
}

function priceFor(model, serviceTier) {
  const pricing = NOVA_OPENAI_PRICING[model];
  if (!pricing) return null;
  const multiplier = tierMultiplier(serviceTier);
  return {
    input: pricing.input * multiplier,
    cachedInput: pricing.cachedInput * multiplier,
    cacheWrite: pricing.cacheWrite * multiplier,
    output: pricing.output * multiplier,
  };
}

function costNanos({ inputTokens, cachedInputTokens = 0, cacheWriteTokens = 0, outputTokens, model, serviceTier }) {
  const pricing = priceFor(model, serviceTier);
  if (!pricing) return null;
  const input = positiveInteger(inputTokens);
  const cached = Math.min(input, positiveInteger(cachedInputTokens));
  const cacheWrite = Math.min(input - cached, positiveInteger(cacheWriteTokens));
  const output = positiveInteger(outputTokens);
  const longContext = input > LONG_CONTEXT_THRESHOLD;
  const inputMultiplier = longContext ? 2 : 1;
  const outputMultiplier = longContext ? 1.5 : 1;
  const usd = ((input - cached - cacheWrite) * pricing.input * inputMultiplier
    + cached * pricing.cachedInput * inputMultiplier
    + cacheWrite * pricing.cacheWrite * inputMultiplier
    + output * pricing.output * outputMultiplier) / TOKENS_PER_MILLION;
  return usdToNanos(usd);
}

export function estimateRequestTokens(requestBody) {
  // UTF-8 bytes are a conservative upper bound for the text-token count used
  // by Nova's JSON Responses requests without requiring a tokenizer package.
  return Buffer.byteLength(JSON.stringify(requestBody), "utf8");
}

export function estimateModelReservation({ requestBody, model, serviceTier, maxOutputTokens, priorContextTokens = 0 }) {
  const inputTokens = Math.max(estimateRequestTokens(requestBody), positiveInteger(priorContextTokens));
  const outputTokens = positiveInteger(maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS;
  // Reserve input at the cache-write rate and Standard pricing. That is the
  // most expensive supported input category and remains safe if Flex falls
  // back to Standard processing.
  const reservedNanoUsd = costNanos({ inputTokens, cacheWriteTokens: inputTokens, outputTokens, model, serviceTier: "default" });
  return reservedNanoUsd === null ? null : { inputTokens, outputTokens, reservedNanoUsd };
}

export function actualModelCost(usage, { model, serviceTier }) {
  return costNanos({
    inputTokens: usage?.inputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    outputTokens: usage?.outputTokens,
    model,
    serviceTier,
  });
}

function publicStatus(record, config, taskId = null) {
  const task = taskId ? record?.tasks?.[taskId] || {} : {};
  const authorizedNanoUsd = usdToNanos(config.globalBudgetUsd);
  const taskAuthorizedNanoUsd = usdToNanos(config.taskBudgetUsd);
  const spentNanoUsd = Number(record?.spentNanoUsd || 0);
  const reservedNanoUsd = Number(record?.reservedNanoUsd || 0);
  const taskSpentNanoUsd = Number(task.spentNanoUsd || 0);
  const taskReservedNanoUsd = Number(task.reservedNanoUsd || 0);
  return Object.freeze({
    budgetId: config.budgetId,
    authorizedUsd: nanosToUsd(authorizedNanoUsd),
    spentUsd: nanosToUsd(spentNanoUsd),
    reservedUsd: nanosToUsd(reservedNanoUsd),
    remainingUsd: nanosToUsd(Math.max(0, authorizedNanoUsd - spentNanoUsd - reservedNanoUsd)),
    ...(taskId ? {
      taskId,
      taskAuthorizedUsd: nanosToUsd(taskAuthorizedNanoUsd),
      taskSpentUsd: nanosToUsd(taskSpentNanoUsd),
      taskReservedUsd: nanosToUsd(taskReservedNanoUsd),
      taskRemainingUsd: nanosToUsd(Math.max(0, taskAuthorizedNanoUsd - taskSpentNanoUsd - taskReservedNanoUsd)),
    } : {}),
  });
}

export function createModelCostController({ storage, ownerId, config }) {
  if (!storage || !ownerId || !config) throw new Error("Model cost controller dependencies are required.");
  const globalCapNanoUsd = usdToNanos(config.globalBudgetUsd);
  const taskCapNanoUsd = usdToNanos(config.taskBudgetUsd);

  async function status(taskId = null) {
    const state = await storage.getModelCostBudget(ownerId, config.budgetId);
    return publicStatus(state, config, taskId);
  }

  return Object.freeze({
    async status(taskId = null) { return status(taskId); },
    async reserve({ model, stage, serviceTier, requestBody, maxOutputTokens, priorContextTokens = 0, taskId = null, runId = null }) {
      const estimate = estimateModelReservation({ requestBody, model, serviceTier, maxOutputTokens, priorContextTokens });
      if (!estimate) throw new ModelCostBudgetError("model_price_unconfigured", await status(taskId));
      const id = randomUUID();
      const reservation = await storage.reserveModelCost({
        id,
        ownerId,
        budgetId: config.budgetId,
        taskId,
        runId,
        stage,
        model,
        reservedNanoUsd: estimate.reservedNanoUsd,
        globalCapNanoUsd,
        taskCapNanoUsd,
        metadata: { serviceTier, inputTokenCeiling: estimate.inputTokens, outputTokenCeiling: estimate.outputTokens },
      });
      if (!reservation) {
        const current = await status(taskId);
        const globalDeficit = Math.max(0, estimate.reservedNanoUsd - Math.round(current.remainingUsd * NANOS_PER_USD));
        const taskDeficit = taskId ? Math.max(0, estimate.reservedNanoUsd - Math.round(current.taskRemainingUsd * NANOS_PER_USD)) : 0;
        throw new ModelCostBudgetError("cost_budget_exhausted", Object.freeze({
          ...current,
          requiredReservationUsd: nanosToUsd(estimate.reservedNanoUsd),
          additionalRequiredUsd: nanosToUsd(Math.max(globalDeficit, taskDeficit)),
        }));
      }
      return Object.freeze({ ...reservation, estimatedInputTokens: estimate.inputTokens, maxOutputTokens: estimate.outputTokens });
    },
    async reconcile(reservation, usage, { model, serviceTier }) {
      const actualNanoUsd = actualModelCost(usage, { model, serviceTier });
      if (actualNanoUsd === null) {
        await storage.settleModelCost(reservation.id, ownerId, { status: "uncertain", actualNanoUsd: reservation.reservedNanoUsd, usage: null });
        return { costStatus: "uncertain", estimatedCostUsd: nanosToUsd(reservation.reservedNanoUsd) };
      }
      await storage.settleModelCost(reservation.id, ownerId, { status: "settled", actualNanoUsd, usage });
      return { costStatus: "settled", estimatedCostUsd: nanosToUsd(actualNanoUsd) };
    },
    async release(reservation) {
      await storage.settleModelCost(reservation.id, ownerId, { status: "released", actualNanoUsd: 0, usage: null });
    },
    async markUncertain(reservation) {
      await storage.settleModelCost(reservation.id, ownerId, { status: "uncertain", actualNanoUsd: reservation.reservedNanoUsd, usage: null });
    },
  });
}
