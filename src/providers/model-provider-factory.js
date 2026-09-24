import { createMockModelProvider } from "./mock-model-provider.js";
import { createOpenAIModelProvider } from "./openai-model-provider.js";

export function createModelProvider(config, { costController } = {}) {
  if (config.modelProvider === "mock") return createMockModelProvider();

  if (config.modelProvider === "openai") {
    return createOpenAIModelProvider({
      apiKey: config.openAI.apiKey,
      model: config.openAI.model,
      routes: config.openAI.routes,
      serviceTier: config.openAI.serviceTier,
      costController,
    });
  }

  throw new Error(`Unsupported model provider: ${config.modelProvider}`);
}
