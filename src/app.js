import { createAgent } from "./agent/agent.js";
import { readConfig } from "./config/env.js";
import { createApi } from "./http/api.js";
import { createInMemoryMemoryStore } from "./memory/in-memory-store.js";
import { createModelProvider } from "./providers/model-provider-factory.js";
import { createToolRegistry } from "./tools/tool-registry.js";

export function createApp({ environment = process.env } = {}) {
  const config = readConfig(environment);
  const memoryStore = createInMemoryMemoryStore();
  const toolRegistry = createToolRegistry();
  const modelProvider = createModelProvider(config);
  const agent = createAgent({
    memoryStore,
    modelProvider,
    toolRegistry,
    maxSteps: config.maxAgentSteps,
    maxToolCallsPerStep: config.maxToolCallsPerStep
  });

  return createApi({ agent, config });
}
