import { createAgent } from "./agent/agent.js";
import { readConfig } from "./config/env.js";
import { createApi } from "./http/api.js";
import { createModelProvider } from "./providers/model-provider-factory.js";
import { createToolRegistry } from "./tools/tool-registry.js";
import { registerDeveloperTools, registerSystemTools } from "./tools/developer-tools.js";
import { createActionPolicy } from "./policy/action-policy.js";
import { createStorage } from "./storage/storage-factory.js";
import { INITIAL_MEMORIES, INITIAL_OWNER_PROFILE, INITIAL_PROJECTS, OWNER_ID } from "./identity/initial-context.js";
import { createBenchmarkProviders } from "./benchmark/providers.js";
import { createVoiceBenchmark } from "./benchmark/service.js";
import { createVoiceService } from "./voice/voice-service.js";
import { createSpeakerIdentity } from "./voice/speaker-identity.js";
import { createSpeakerExtractor } from "./voice/speaker-extractor.js";
import { createSpeakerAssertions } from "./voice/speaker-assertion.js";
import { createFamiliarityConsent } from "./voice/familiarity-consent.js";
import { createEcapaSpeakerEngine } from "./voice/ecapa-speaker-engine.js";
import { createSpeakerEngineCoordinator } from "./voice/speaker-engine.js";

export function createApp({ environment = process.env, storage: storageOverride, logger = console, voiceFetchImpl } = {}) {
  const config = readConfig(environment);
  const storage = storageOverride || createStorage(config);
  const initialize = () => storage.initialize({ owner: INITIAL_OWNER_PROFILE, projects: INITIAL_PROJECTS, memories: INITIAL_MEMORIES });
  const policy = createActionPolicy({ storage, ownerId: OWNER_ID, approvedBranch: config.developmentBranch });
  const toolRegistry = createToolRegistry({ policy });
  registerDeveloperTools(toolRegistry, { environment });
  registerSystemTools(toolRegistry, { storage, ownerId: OWNER_ID });
  const modelProvider = createModelProvider(config);
  const speakerAssertions = createSpeakerAssertions({ key: config.speakerRecognition.assertionKey });
  const familiarityConsent = createFamiliarityConsent({ key: config.speakerRecognition.assertionKey });
  const speakerIdentity = createSpeakerIdentity({ storage, ownerId: OWNER_ID, threshold: config.speakerRecognition.threshold, ambiguityMargin: config.speakerRecognition.ambiguityMargin, familiarityThreshold: config.speakerRecognition.familiarityThreshold, familiarityAmbiguityMargin: config.speakerRecognition.familiarityAmbiguityMargin, embeddingKey: config.speakerRecognition.embeddingKey, requireEncryption: Boolean(config.speakerRecognition.endpoint) });
  const agent = createAgent({
    storage,
    ownerId: OWNER_ID,
    modelProvider,
    toolRegistry,
    maxSteps: config.maxAgentSteps,
    maxToolCallsPerStep: config.maxToolCallsPerStep,
    historyLimit: config.conversationHistoryLimit,
    memoryLimit: config.memoryRetrievalLimit,
    verifySpeakerAssertion: speakerAssertions.verify,
    validateSpeakerProfile: speakerIdentity.isActiveProfile,
    validateAnonymousSpeaker: speakerIdentity.isActiveAnonymous,
    logger
  });
  const benchmarkProviders = createBenchmarkProviders({ config: config.voiceBenchmark });
  const voiceBenchmark = createVoiceBenchmark({ config, storage, ownerId: OWNER_ID, providers: benchmarkProviders });
  const voiceService = createVoiceService({ config, ...(voiceFetchImpl ? { fetchImpl: voiceFetchImpl } : {}) });
  const speakerExtractor = createSpeakerExtractor({ config, ...(voiceFetchImpl ? { fetchImpl: voiceFetchImpl } : {}) });
  const speakerEngines = createSpeakerEngineCoordinator({ authoritativeEngine: createEcapaSpeakerEngine({ extractor: speakerExtractor, identity: speakerIdentity }), shadowEngines: [], logger });

  return createApi({ agent, config, storage, initialize, ownerId: OWNER_ID, toolRegistry, voiceBenchmark, voiceService, speakerIdentity, speakerExtractor, speakerEngines, speakerAssertions, familiarityConsent, logger });
}
