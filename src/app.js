import { createAgent } from "./agent/agent.js";
import { readConfig } from "./config/env.js";
import { createApi } from "./http/api.js";
import { createModelProvider } from "./providers/model-provider-factory.js";
import { createToolRegistry } from "./tools/tool-registry.js";
import { createStorage } from "./storage/storage-factory.js";
import { INITIAL_MEMORIES, INITIAL_OWNER_PROFILE, INITIAL_PROJECTS, OWNER_ID } from "./identity/initial-context.js";

export function createApp({ environment = process.env, storage: storageOverride } = {}) {
  const config = readConfig(environment);
  const storage = storageOverride || createStorage(config);
  const initialize = () => storage.initialize({ owner: INITIAL_OWNER_PROFILE, projects: INITIAL_PROJECTS, memories: INITIAL_MEMORIES });
  const toolRegistry = createToolRegistry();
  const modelProvider = createModelProvider(config);
  const agent = createAgent({
    storage,
    ownerId: OWNER_ID,
    modelProvider,
    toolRegistry,
    maxSteps: config.maxAgentSteps,
    maxToolCallsPerStep: config.maxToolCallsPerStep,
    historyLimit: config.conversationHistoryLimit,
    memoryLimit: config.memoryRetrievalLimit
  });

  return createApi({ agent, config, storage, initialize, ownerId: OWNER_ID });
}
