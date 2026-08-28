import { randomUUID } from "node:crypto";

export class AgentStepLimitError extends Error {}
export class AgentToolCallLimitError extends Error {}

function validateModelOutput(output) {
  if (output?.type === "final" && typeof output.message === "string" && output.message) {
    return;
  }

  if (
    output?.type === "tool_calls" &&
    Array.isArray(output.toolCalls) &&
    output.toolCalls.every(
      (call) =>
        typeof call?.id === "string" &&
        call.id &&
        typeof call.name === "string" &&
        call.name &&
        call.arguments &&
        typeof call.arguments === "object" &&
        !Array.isArray(call.arguments)
    )
  ) {
    return;
  }

  throw new Error("Model provider returned an invalid output.");
}

function safeToolError(error, name) {
  if (error?.message === `Unknown tool: ${name}`) return error.message;
  return `Tool execution failed: ${name}`;
}

export function createAgent({
  memoryStore,
  modelProvider,
  toolRegistry,
  maxSteps = 5,
  maxToolCallsPerStep = 4
}) {
  if (!memoryStore || !modelProvider || !toolRegistry) {
    throw new Error("Agent requires memoryStore, modelProvider, and toolRegistry.");
  }

  return Object.freeze({
    async run({ message, conversationId = randomUUID(), context = {} }) {
      const conversationHistory = await memoryStore.list(conversationId);
      const toolExecutions = [];
      let continuationToken;
      let toolResults = [];

      for (let step = 1; step <= maxSteps; step += 1) {
        const generated = await modelProvider.generate({
          message,
          context,
          conversationHistory,
          tools: toolRegistry.list(),
          toolResults,
          continuationToken
        });
        validateModelOutput(generated);

        if (generated.type === "final") {
          const response = {
            id: randomUUID(),
            conversationId,
            message: generated.message,
            provider: modelProvider.name,
            toolCalls: toolExecutions,
            steps: step
          };

          await memoryStore.append(conversationId, { role: "user", content: message });
          await memoryStore.append(conversationId, {
            role: "assistant",
            content: response.message
          });

          return response;
        }

        if (generated.toolCalls.length > maxToolCallsPerStep) {
          throw new AgentToolCallLimitError(
            `Model requested more than ${maxToolCallsPerStep} tools in one step.`
          );
        }

        if (step === maxSteps) {
          throw new AgentStepLimitError(
            `Agent exceeded the maximum of ${maxSteps} model steps.`
          );
        }

        continuationToken = generated.continuationToken;
        toolResults = [];

        for (const call of generated.toolCalls) {
          const execution = {
            id: call.id,
            name: call.name,
            arguments: call.arguments
          };

          try {
            const result = await toolRegistry.execute(call.name, call.arguments, context);
            execution.status = "completed";
            execution.result = result;
            toolResults.push({ id: call.id, output: { ok: true, result } });
          } catch (error) {
            execution.status = "failed";
            execution.error = safeToolError(error, call.name);
            toolResults.push({
              id: call.id,
              output: { ok: false, error: execution.error }
            });
          }

          toolExecutions.push(execution);
        }
      }

      throw new AgentStepLimitError(`Agent exceeded the maximum of ${maxSteps} model steps.`);
    },
    tools: toolRegistry
  });
}
