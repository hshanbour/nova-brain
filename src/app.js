import { createAgent } from "./agent/agent.js";
import { readConfig } from "./config/env.js";
import { createApi } from "./http/api.js";
import { createModelProvider } from "./providers/model-provider-factory.js";
import { createToolRegistry } from "./tools/tool-registry.js";
import {
  registerDeveloperTools,
  registerSystemTools,
} from "./tools/developer-tools.js";
import { createActionPolicy } from "./policy/action-policy.js";
import { createStorage } from "./storage/storage-factory.js";
import {
  INITIAL_MEMORIES,
  INITIAL_OWNER_PROFILE,
  INITIAL_PROJECTS,
  OWNER_ID,
} from "./identity/initial-context.js";
import { createBenchmarkProviders } from "./benchmark/providers.js";
import { createVoiceBenchmark } from "./benchmark/service.js";
import { createVoiceService } from "./voice/voice-service.js";
import { createSpeakerIdentity } from "./voice/speaker-identity.js";
import { createSpeakerExtractor } from "./voice/speaker-extractor.js";
import { createSpeakerAssertions } from "./voice/speaker-assertion.js";
import { createFamiliarityConsent } from "./voice/familiarity-consent.js";
import { createEcapaSpeakerEngine } from "./voice/ecapa-speaker-engine.js";
import { createSpeakerEngineCoordinator } from "./voice/speaker-engine.js";
import { createWorkerRuntime } from "./autonomy/worker-runtime.js";
import { registerWorkerTools } from "./autonomy/worker-tools.js";
import { createTaskMigrationService } from "./autonomy/task-migration.js";
import { createLocalWorkerHandoff } from "./autonomy/local-worker-handoff.js";
import { createGithubWriteAttestation } from "./autonomy/github-write-attestation.js";
import { createPostAttestationRecovery } from "./autonomy/post-attestation-recovery.js";
import { createSelfDevelopmentService } from "./autonomy/self-development.js";
import { registerSelfDevelopmentTools } from "./autonomy/self-development-tools.js";

export function createApp({
  environment = process.env,
  storage: storageOverride,
  logger = console,
  voiceFetchImpl,
} = {}) {
  const config = readConfig(environment);
  const storage = storageOverride || createStorage(config);
  const initialize = () =>
    storage.initialize({
      owner: INITIAL_OWNER_PROFILE,
      projects: INITIAL_PROJECTS,
      memories: INITIAL_MEMORIES,
    });
  const policy = createActionPolicy({
    storage,
    ownerId: OWNER_ID,
    approvedBranch: config.developmentBranch,
  });
  const toolRegistry = createToolRegistry({ policy });
  registerDeveloperTools(toolRegistry, {
    environment,
    storage,
    ownerId: OWNER_ID,
    logger,
  });
  registerSystemTools(toolRegistry, { storage, ownerId: OWNER_ID });
  const workerRuntime = createWorkerRuntime({
    storage,
    ownerId: OWNER_ID,
    toolRegistry,
    approvedBranch: config.developmentBranch,
    capabilities: environment.VERCEL
      ? ["repo_read_remote", "reasoning", "scheduler", "vercel_preview"]
      : [
          "repo_read_remote",
          "repo_mutate_local",
          "test_local",
          "github_write",
          "vercel_preview",
          "reasoning",
          "scheduler",
        ],
  });
  const taskMigration = createTaskMigrationService({
    storage,
    ownerId: OWNER_ID,
    approvedBranch: config.developmentBranch,
  });
  const localWorkerHandoff = createLocalWorkerHandoff({
    storage,
    ownerId: OWNER_ID,
    approvedBranch: config.developmentBranch,
    deploymentEnvironment: environment.VERCEL_ENV || "local",
  });
  const verifyDeployment = async ({deploymentId}) => {
    const response=await fetch(`https://api.vercel.com/v13/deployments/${encodeURIComponent(deploymentId)}`,{headers:{Authorization:`Bearer ${environment.NOVA_BRAIN_VERCEL_TOKEN||""}`}});
    if(!response.ok)throw new Error("Preview verification failed.");
    const value=await response.json();return{id:value.id||value.uid,url:value.url,status:value.readyState||value.state,target:value.target,sha:value.gitSource?.sha||value.meta?.githubCommitSha,branch:value.gitSource?.ref||value.meta?.githubCommitRef};
  };
  const githubWriteAttestation = createGithubWriteAttestation({
    storage,
    ownerId: OWNER_ID,
    verifyRemote: async ({repository,branch,requiredAncestors}) => {
      const headers={Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
      const response=await fetch(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`,{headers});
      if(!response.ok)throw new Error("Remote branch verification failed.");
      const currentTip=(await response.json()).sha,ancestors={};
      for(const required of requiredAncestors){const compared=await fetch(`https://api.github.com/repos/${repository}/compare/${required}...${currentTip}`,{headers});if(!compared.ok)throw new Error("Remote ancestry verification failed.");const value=await compared.json();ancestors[required]=["ahead","identical"].includes(value.status)&&value.merge_base_commit?.sha===required;}
      return{currentTip,ancestors};
    },
    verifyDeployment,
  });
  const postAttestationRecovery=createPostAttestationRecovery({storage,ownerId:OWNER_ID,verifyDeployment});
  toolRegistry.register({name:"deployment_status_existing",description:"Verify READY status and source for the exact existing acceptance Preview.",category:"deployment",capability:"read",riskLevel:"READ_ONLY",available:Boolean(environment.NOVA_BRAIN_VERCEL_TOKEN),configurationStatus:environment.NOVA_BRAIN_VERCEL_TOKEN?"ready":"configuration_required",async execute(input){const deployment=await verifyDeployment(input);if(deployment.target==="production"||deployment.branch!==config.developmentBranch||deployment.sha!==input.commitSha)throw Object.assign(new Error("Preview source mismatch."),{code:"source_mismatch"});if(deployment.status!=="READY")throw Object.assign(new Error("Preview deployment is not READY."),{code:"deployment_not_ready"});return{ok:true,deploymentId:input.deploymentId,status:deployment.status,url:`https://${deployment.url}`,commitSha:input.commitSha};}});
  toolRegistry.register({name:"preview_verify_existing",description:"Verify the exact existing acceptance Preview route.",category:"deployment",capability:"read",riskLevel:"READ_ONLY",available:Boolean(environment.NOVA_BRAIN_VERCEL_TOKEN),configurationStatus:environment.NOVA_BRAIN_VERCEL_TOKEN?"ready":"configuration_required",async execute(input){const deployment=await verifyDeployment(input);if(deployment.target==="production"||deployment.branch!==config.developmentBranch||deployment.sha!==input.commitSha)throw Object.assign(new Error("Preview source mismatch."),{code:"source_mismatch"});const response=await fetch(`https://${deployment.url}${input.path}`,{headers:{...(environment.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":environment.VERCEL_AUTOMATION_BYPASS_SECRET}:{})}});if(response.status!==input.expectedStatus)throw Object.assign(new Error("Preview route returned an unexpected status."),{code:"preview_unreachable"});return{ok:true,deploymentId:input.deploymentId,url:`https://${deployment.url}${input.path}`,status:response.status,commitSha:input.commitSha};}});
  registerWorkerTools(toolRegistry, { runtime: workerRuntime, taskMigration });
  const selfDevelopment=createSelfDevelopmentService({runtime:workerRuntime,storage,ownerId:OWNER_ID,approvedBranch:config.developmentBranch});
  registerSelfDevelopmentTools(toolRegistry,{service:selfDevelopment});
  const modelProvider = createModelProvider(config);
  const speakerAssertions = createSpeakerAssertions({
    key: config.speakerRecognition.assertionKey,
  });
  const familiarityConsent = createFamiliarityConsent({
    key: config.speakerRecognition.assertionKey,
  });
  const speakerIdentity = createSpeakerIdentity({
    storage,
    ownerId: OWNER_ID,
    threshold: config.speakerRecognition.threshold,
    ambiguityMargin: config.speakerRecognition.ambiguityMargin,
    familiarityThreshold: config.speakerRecognition.familiarityThreshold,
    familiarityAmbiguityMargin:
      config.speakerRecognition.familiarityAmbiguityMargin,
    embeddingKey: config.speakerRecognition.embeddingKey,
    requireEncryption: Boolean(config.speakerRecognition.endpoint),
  });
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
    logger,
  });
  const benchmarkProviders = createBenchmarkProviders({
    config: config.voiceBenchmark,
  });
  const voiceBenchmark = createVoiceBenchmark({
    config,
    storage,
    ownerId: OWNER_ID,
    providers: benchmarkProviders,
  });
  const voiceService = createVoiceService({
    config,
    ...(voiceFetchImpl ? { fetchImpl: voiceFetchImpl } : {}),
  });
  const speakerExtractor = createSpeakerExtractor({
    config,
    ...(voiceFetchImpl ? { fetchImpl: voiceFetchImpl } : {}),
  });
  const speakerEngines = createSpeakerEngineCoordinator({
    authoritativeEngine: createEcapaSpeakerEngine({
      extractor: speakerExtractor,
      identity: speakerIdentity,
    }),
    shadowEngines: [],
    logger,
  });

  const api = createApi({
    agent,
    config,
    storage,
    initialize,
    ownerId: OWNER_ID,
    toolRegistry,
    workerRuntime,
    taskMigration,
    localWorkerHandoff,
    githubWriteAttestation,
    postAttestationRecovery,
    selfDevelopment,
    voiceBenchmark,
    voiceService,
    speakerIdentity,
    speakerExtractor,
    speakerEngines,
    speakerAssertions,
    familiarityConsent,
    logger,
  });
  return Object.freeze({ ...api, initialize, workerRuntime });
}
