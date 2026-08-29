import { randomUUID } from "node:crypto";
import { buildSystemContext, retrieveAgentContext } from "../memory/context-retriever.js";
import { ApprovalRequiredError } from "../policy/action-policy.js";

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
  storage,
  ownerId,
  modelProvider,
  toolRegistry,
  maxSteps = 5,
  maxToolCallsPerStep = 4,
  historyLimit = 24,
  memoryLimit = 6
}) {
  if (!storage || !ownerId || !modelProvider || !toolRegistry) {
    throw new Error("Agent requires storage, ownerId, modelProvider, and toolRegistry.");
  }

  return Object.freeze({
    async run({ message, conversationId = randomUUID(), context = {} }) {
      const conversation = await storage.ensureConversation({ id: conversationId, ownerId, title: message.slice(0, 120) });
      if (!conversation) throw new Error("Conversation is unavailable.");
      const run = await storage.createRun({ ownerId, projectId: context.projectId || null, conversationId, goal: message, status: "planning" });
      await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "run_created", status: "completed", summary: "Execution run created." });
      const conversationHistory = await storage.listMessages(conversationId, ownerId, { limit: historyLimit });
      const retrieved = await retrieveAgentContext({ storage, ownerId, message, projectId: context.projectId, memoryLimit });
      const systemContext = buildSystemContext(retrieved);
      await storage.appendMessage({ conversationId, ownerId, role: "user", content: message });
      const toolExecutions = [];
      let continuationToken;
      let toolResults = [];

      try { for (let step = 1; step <= maxSteps; step += 1) {
        await storage.updateRun(run.id, ownerId, { status: "running", currentStep: step });
        const generated = await modelProvider.generate({
          message,
          context,
          systemContext,
          conversationHistory,
          tools: toolRegistry.list({ executableOnly: true }),
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
            ,runId: run.id,
            runStatus: "completed"
          };

          await storage.appendMessage({ conversationId, ownerId, role: "assistant", content: response.message });
          await storage.updateRun(run.id, ownerId, { status: "completed", currentStep: step, result: { message: response.message }, completedAt: new Date().toISOString() });
          await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "run_completed", status: "completed", summary: "Nova completed the execution run." });

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
          await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "tool_started", tool: call.name, status: "running", summary: `Started ${call.name}.` });

          try {
            const result = await toolRegistry.execute(call.name, call.arguments, { ...context, runId: run.id });
            execution.status = "completed";
            execution.result = result;
            toolResults.push({ id: call.id, output: { ok: true, result } });
            await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "tool_completed", tool: call.name, status: "completed", summary: `${call.name} completed.` });
          } catch (error) {
            if (error instanceof ApprovalRequiredError) {
              const approvalMessage = `Owner approval is required before Nova can run ${call.name}.`;
              execution.status = "waiting_for_approval"; execution.approvalId = error.approval.id; toolExecutions.push(execution);
              await storage.updateRun(run.id, ownerId, { status: "waiting_for_approval", currentStep: step });
              await storage.appendMessage({ conversationId, ownerId, role: "assistant", content: approvalMessage });
              return { id: randomUUID(), conversationId, message: approvalMessage, provider: modelProvider.name, toolCalls: toolExecutions, steps: step, runId: run.id, runStatus: "waiting_for_approval", approval: error.approval };
            }
            execution.status = "failed";
            execution.error = safeToolError(error, call.name);
            toolResults.push({
              id: call.id,
              output: { ok: false, error: execution.error }
            });
            await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "tool_failed", tool: call.name, status: "failed", summary: execution.error });
          }

          toolExecutions.push(execution);
        }
      }

      throw new AgentStepLimitError(`Agent exceeded the maximum of ${maxSteps} model steps.`);
      } catch (error) {
        await storage.updateRun(run.id, ownerId, { status: "failed", error: error instanceof AgentStepLimitError || error instanceof AgentToolCallLimitError ? error.message : "Execution failed safely.", completedAt: new Date().toISOString() });
        await storage.appendActivity({ ownerId, projectId: context.projectId || null, runId: run.id, action: "run_failed", status: "failed", summary: error instanceof AgentStepLimitError || error instanceof AgentToolCallLimitError ? error.message : "Execution failed safely." });
        throw error;
      }
    },
    tools: toolRegistry
  });
}
