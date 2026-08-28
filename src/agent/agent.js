import { randomUUID } from "node:crypto";

export function createAgent({ memoryStore, modelProvider, toolRegistry }) {
  if (!memoryStore || !modelProvider || !toolRegistry) {
    throw new Error("Agent requires memoryStore, modelProvider, and toolRegistry.");
  }

  return Object.freeze({
    async run({ message, conversationId = randomUUID(), context = {} }) {
      const conversationHistory = await memoryStore.list(conversationId);
      const generated = await modelProvider.generate({
        message,
        context,
        conversationHistory
      });

      const response = {
        id: randomUUID(),
        conversationId,
        message: generated.message,
        provider: generated.provider,
        toolCalls: []
      };

      await memoryStore.append(conversationId, { role: "user", content: message });
      await memoryStore.append(conversationId, {
        role: "assistant",
        content: response.message
      });

      return response;
    },
    tools: toolRegistry
  });
}
