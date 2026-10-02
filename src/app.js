import { createAgent } from "./agent/agent.js";
import { readConfig } from "./config/env.js";
import { createApi } from "./http/api.js";
import { createModelProvider } from "./providers/model-provider-factory.js";
import { createModelCostController } from "./providers/model-cost-budget.js";
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
import { createSelfDevelopmentService, isDurableSelfDevelopmentRequest, parseExistingTaskControlRequest, SelfDevelopmentError, validateExistingTaskControlRequest } from "./autonomy/self-development.js";
import { createSelfDevelopmentIntake } from "./autonomy/self-development-intake.js";
import { createSelfDevelopmentExpiryRecovery } from "./autonomy/self-development-expiry-recovery.js";
import { registerSelfDevelopmentTools } from "./autonomy/self-development-tools.js";
import { createSelfDevelopmentImplementationPlanner } from "./autonomy/self-development-implementation-planner.js";
import { createAutoDispatchService } from "./autonomy/auto-dispatch.js";
import { createDeveloperSessionSmoke } from "./autonomy/developer-session-smoke.js";
import { createDeveloperWorkspaceHandoff } from "./autonomy/developer-workspace-handoff.js";
import { configuredCodingBindings, createCodingExecutorService } from "./autonomy/coding-executor.js";
import { codingDelegationFingerprint, createCodingDelegationService, isChatCodingDelegationRequest } from "./autonomy/coding-delegation.js";
import {createTerminalTaskReporter,isConversationTaskResultQuestion} from "./autonomy/terminal-task-reporter.js";
import {createArtifactDeliveryService,registerArtifactDeliveryTool} from "./autonomy/artifact-delivery.js";
import {createTrustedArtifactContinuity,isExplicitTrustedArtifactRequest,isTrustedArtifactContinuationCandidate} from "./autonomy/trusted-artifact-continuity.js";
import {resolveExplicitCodingRetryRequest} from "./autonomy/explicit-coding-retry.js";
import {isConversationWorkflowTurn,isSelfDevelopmentWorkflowCandidate} from "./autonomy/conversation-workflow-intent.js";
import {createExecutionTruthService} from "./autonomy/execution-truth.js";
import {createVercelPreviewClient} from "./deployment/vercel-preview-client.js";
import {createOpenAIWebSearchAdapter,createPublicPageReader,createWebGateway,registerWebResearchTool} from "./web/web-gateway.js";
import {createCloudflareBrowserRunAdapter} from "./web/cloudflare-browser-run.js";
import {createBrowserProviderBudget} from "./web/browser-provider-budget.js";
import {createDurableBrowserTaskService} from "./web/durable-browser-task.js";
import {createDurableWebResearchService} from "./web/durable-web-research.js";
import { createGmailService } from "./email/gmail-service.js";
import { registerGmailTools } from "./email/gmail-tools.js";
import { createPhoneSessionAuth } from "./phone/session-auth.js";
import { createPhoneService } from "./phone/phone-service.js";
import { registerPhoneTools } from "./phone/phone-tools.js";
import { createTwilioOutboundClient } from "./phone/twilio-client.js";

export const createRemoteEvidenceComparator=({fetchImpl=globalThis.fetch}={})=>async({repository,paths,oldCommit,newCommit})=>{
  const headers={Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"},blobs={};
  for(const path of paths){
    const encoded=path.split("/").map(encodeURIComponent).join("/"),load=async ref=>{const response=await fetchImpl(`https://api.github.com/repos/${repository}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,{headers});if(response.status===404)return{exists:false,sha:null};if(!response.ok)throw Object.assign(new Error("Remote evidence verification failed."),{code:"remote_evidence_verification_failed",status:response.status});const value=await response.json();if(typeof value.sha!=="string")throw Object.assign(new Error("Remote evidence verification failed."),{code:"remote_evidence_verification_failed",status:response.status});return{exists:true,sha:value.sha};},[oldState,newState]=await Promise.all([load(oldCommit),load(newCommit)]),equivalent=oldState.exists===newState.exists&&(!oldState.exists||oldState.sha===newState.sha);
    blobs[path]={oldSha:oldState.sha,newSha:newState.sha,oldExists:oldState.exists,newExists:newState.exists,equivalent};
  }
  return blobs;
};

export function createApp({
  environment = process.env,
  storage: storageOverride,
  logger = console,
  voiceFetchImpl,
  webFetchImpl,
  webResolveHost,
  browserConnectOverCDP,
  gmailFetchImpl,
  phoneFetchImpl,
  phoneDialProvider,
} = {}) {
  const config = readConfig(environment);
  const storage = storageOverride || createStorage(config);
  const modelCostController = config.modelProvider === "openai"
    ? createModelCostController({ storage, ownerId: OWNER_ID, config: config.openAI.budget })
    : null;
  const modelProvider = createModelProvider(config, { costController: modelCostController });
  const developerSessionSmoke = storage.saveDeveloperSession && storage.getDeveloperSession
    ? createDeveloperSessionSmoke({ environment, storage, ownerId: OWNER_ID })
    : null;
  const developerWorkspaceHandoff = storage.saveDeveloperSession && storage.getDeveloperSession
    ? createDeveloperWorkspaceHandoff({ environment, storage, ownerId: OWNER_ID })
    : null;
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
  const executionTruth=createExecutionTruthService({storage,ownerId:OWNER_ID});
  registerDeveloperTools(toolRegistry, {
    environment,
    storage,
    ownerId: OWNER_ID,
    logger,
  });
  registerSystemTools(toolRegistry, { storage, ownerId: OWNER_ID });
  const gmailService = createGmailService({
    config,
    storage,
    ownerId: OWNER_ID,
    fetchImpl: gmailFetchImpl || globalThis.fetch,
    logger,
  });
  registerGmailTools(toolRegistry, { service: gmailService });
  let agent;
  const phoneSessionAuth = config.phone.configured ? createPhoneSessionAuth({ key: config.phone.sessionSigningKeyBytes }) : null;
  const phoneProvider = phoneDialProvider || createTwilioOutboundClient({
    accountSid: config.phone.accountSid,
    authToken: config.phone.authToken,
    fromNumber: config.phone.fromNumber,
    bridgeWebSocketUrl: config.phone.bridgeWebSocketUrl,
    publicBaseUrl: config.phone.publicBaseUrl,
    fetchImpl: phoneFetchImpl || globalThis.fetch,
  });
  const phoneService = createPhoneService({ config, storage, ownerId: OWNER_ID, dialProvider: phoneProvider, sessionAuth: phoneSessionAuth, novaTurn: (input) => agent.run(input), fetchImpl: phoneFetchImpl || globalThis.fetch });
  registerPhoneTools(toolRegistry, { service: phoneService });
  let browserTaskService=null,durableResearchTaskService=null;
  if(config.modelProvider === "openai"){
    const webRoute=config.openAI.routes.web;
    const webSearch=createOpenAIWebSearchAdapter({apiKey:config.openAI.apiKey,model:webRoute.model,serviceTier:config.openAI.serviceTier,costController:modelCostController,fetchImpl:webFetchImpl||globalThis.fetch,maxOutputTokens:webRoute.maxOutputTokens||4096});
    const pageReader=createPublicPageReader({fetchImpl:webFetchImpl||globalThis.fetch,...(webResolveHost?{resolveHost:webResolveHost}:{})});
    browserTaskService=config.browserRun.configured?createDurableBrowserTaskService({storage,ownerId:OWNER_ID,model:webRoute.model,modelCostController,executionTruth,providerBudget:createBrowserProviderBudget({storage,ownerId:OWNER_ID,...config.browserRun}),browserAdapter:createCloudflareBrowserRunAdapter({accountId:config.browserRun.accountId,apiToken:config.browserRun.apiToken,fetchImpl:webFetchImpl||globalThis.fetch,...(webResolveHost?{resolveHost:webResolveHost}:{}),...(browserConnectOverCDP?{connectOverCDP:browserConnectOverCDP}:{})})}):null;
    const webGateway=createWebGateway({searchAdapter:webSearch,pageReader,browserTaskService,storage,ownerId:OWNER_ID});
    registerWebResearchTool(toolRegistry,{gateway:webGateway});
    durableResearchTaskService=createDurableWebResearchService({storage,ownerId:OWNER_ID,webGateway,modelProvider,executionTruth});
  }
  const workerRuntime = createWorkerRuntime({
    storage,
    ownerId: OWNER_ID,
    toolRegistry,
    approvedBranch: config.developmentBranch,
    executionTruth,
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
    executionTruth,
  });
  const terminalReporter=createTerminalTaskReporter({storage,ownerId:OWNER_ID});
  const autoDispatch=createAutoDispatchService({storage,ownerId:OWNER_ID,approvedBranch:config.developmentBranch,terminalReporter,executionTruth});
  const codingExecutor=typeof storage?.getAutonomyTask==="function"?createCodingExecutorService({
    runtime:workerRuntime,
    storage,
    ownerId:OWNER_ID,
    bindings:configuredCodingBindings(environment,{
      projectId:"nova-brain",
      workspaceId:"nova-brain",
      repository:environment.NOVA_BRAIN_GITHUB_REPOSITORY||"hshanbour/nova-brain",
      branch:config.developmentBranch,
    }),
    executionTruth,
  }):null;
  const codingBindings=configuredCodingBindings(environment,{projectId:"nova-brain",workspaceId:"nova-brain",repository:environment.NOVA_BRAIN_GITHUB_REPOSITORY||"hshanbour/nova-brain",branch:config.developmentBranch});
  const {findPreview,verifyDeployment}=createVercelPreviewClient({environment});
  const verifyPreviewHealth=async ({deploymentId,commitSha,branch})=>{const deployment=await verifyDeployment({deploymentId});if(deployment.target==="production"||deployment.sha!==commitSha||deployment.branch!==branch)throw Object.assign(new Error("Preview source mismatch."),{code:"artifact_delivery_source_mismatch"});const response=await fetch(`https://${deployment.url}/api/health`,{headers:{...(environment.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":environment.VERCEL_AUTOMATION_BYPASS_SECRET}:{})}}),value=await response.json().catch(()=>({}));if(response.status!==200||value.status!=="online"||value.storage?.provider!=="postgres"||value.storage?.durable!==true||value.storage?.status!=="ready")throw Object.assign(new Error("Preview health is not ready."),{code:"preview_unavailable",retryable:true});return{status:200,url:`https://${deployment.url}/api/health`,health:"online",storage:"ready"};};
  const verifyRemote=async ({repository,branch,requiredAncestors,signal}) => {
      const headers={Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28",...(environment.NOVA_BRAIN_GITHUB_TOKEN?{Authorization:`Bearer ${environment.NOVA_BRAIN_GITHUB_TOKEN}`}:{})};
      const response=await fetch(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(branch)}`,{headers,signal});
      if(!response.ok)throw new Error("Remote branch verification failed.");
      const currentTip=(await response.json()).sha,ancestors={};
      for(const required of requiredAncestors){const compared=await fetch(`https://api.github.com/repos/${repository}/compare/${required}...${currentTip}`,{headers,signal});if(!compared.ok)throw new Error("Remote ancestry verification failed.");const value=await compared.json();ancestors[required]=["ahead","identical"].includes(value.status)&&value.merge_base_commit?.sha===required;}
      return{currentTip,ancestors};
    };
  const compareRemoteEvidence=createRemoteEvidenceComparator();
  const githubWriteAttestation = createGithubWriteAttestation({
    storage,
    ownerId: OWNER_ID,
    verifyRemote,
    verifyDeployment,
  });
  const postAttestationRecovery=createPostAttestationRecovery({storage,ownerId:OWNER_ID,verifyDeployment});
  toolRegistry.register({name:"deployment_status_existing",description:"Verify READY status and source for the exact existing acceptance Preview.",category:"deployment",capability:"read",riskLevel:"READ_ONLY",available:Boolean(environment.NOVA_BRAIN_VERCEL_TOKEN),configurationStatus:environment.NOVA_BRAIN_VERCEL_TOKEN?"ready":"configuration_required",async execute(input){const deployment=await verifyDeployment(input);if(deployment.target==="production"||deployment.branch!==config.developmentBranch||deployment.sha!==input.commitSha)throw Object.assign(new Error("Preview source mismatch."),{code:"source_mismatch"});if(deployment.status!=="READY")throw Object.assign(new Error("Preview deployment is not READY."),{code:"deployment_not_ready"});return{ok:true,deploymentId:input.deploymentId,status:deployment.status,url:`https://${deployment.url}`,commitSha:input.commitSha};}});
  toolRegistry.register({name:"preview_verify_existing",description:"Verify the exact existing acceptance Preview route.",category:"deployment",capability:"read",riskLevel:"READ_ONLY",available:Boolean(environment.NOVA_BRAIN_VERCEL_TOKEN),configurationStatus:environment.NOVA_BRAIN_VERCEL_TOKEN?"ready":"configuration_required",async execute(input){const deployment=await verifyDeployment(input);if(deployment.target==="production"||deployment.branch!==config.developmentBranch||deployment.sha!==input.commitSha)throw Object.assign(new Error("Preview source mismatch."),{code:"source_mismatch"});const response=await fetch(`https://${deployment.url}${input.path}`,{headers:{...(environment.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":environment.VERCEL_AUTOMATION_BYPASS_SECRET}:{})}});if(response.status!==input.expectedStatus)throw Object.assign(new Error("Preview route returned an unexpected status."),{code:"preview_unreachable"});return{ok:true,deploymentId:input.deploymentId,url:`https://${deployment.url}${input.path}`,status:response.status,commitSha:input.commitSha};}});
  toolRegistry.register({name:"preview_storage_verify_existing",description:"Verify durable Postgres readiness through the exact existing acceptance Preview health route.",category:"deployment",capability:"read",riskLevel:"READ_ONLY",available:Boolean(environment.NOVA_BRAIN_VERCEL_TOKEN),configurationStatus:environment.NOVA_BRAIN_VERCEL_TOKEN?"ready":"configuration_required",async execute(input){const deployment=await verifyDeployment(input);if(deployment.target==="production"||deployment.branch!==config.developmentBranch||deployment.sha!==input.commitSha)throw Object.assign(new Error("Preview source mismatch."),{code:"source_mismatch"});const response=await fetch(`https://${deployment.url}/api/health`,{headers:{...(environment.VERCEL_AUTOMATION_BYPASS_SECRET?{"x-vercel-protection-bypass":environment.VERCEL_AUTOMATION_BYPASS_SECRET}:{})}}),value=await response.json().catch(()=>({}));if(response.status!==200||value.storage?.provider!=="postgres"||value.storage?.durable!==true||value.storage?.status!=="ready")throw Object.assign(new Error("Preview durable storage is not ready."),{code:"storage_not_ready"});return{ok:true,deploymentId:input.deploymentId,status:200,storage:{provider:"postgres",durable:true,status:"ready"},commitSha:input.commitSha};}});
  const codingDelegation=codingExecutor?createCodingDelegationService({runtime:workerRuntime,storage,ownerId:OWNER_ID,bindings:codingBindings,verifyRemote}):null;
  registerWorkerTools(toolRegistry, { runtime: workerRuntime, taskMigration, codingExecutor, codingDelegation });
  const implementationPlanner=createSelfDevelopmentImplementationPlanner({modelProvider,storage,ownerId:OWNER_ID,runtimeVersion:environment.VERCEL_GIT_COMMIT_SHA,resolvePathState:async(path,commitSha)=>toolRegistry.execute("repo_path_state",{path,commitSha})});
  toolRegistry.register({name:"self_development_plan_implementation",description:"Generate one evidence-bound structured implementation or repair plan for the exact durable Self-Development task.",category:"autonomy",capability:"reasoning",riskLevel:"READ_ONLY",available:true,configurationStatus:"ready",inputSchema:{type:"object",properties:{taskId:{type:"string"},candidatePaths:{type:"array"},authorizedCreatePaths:{type:"array"},currentCommit:{type:"string"},failureEvidence:{type:"object"}},required:["taskId","candidatePaths","currentCommit"],additionalProperties:false},execute:input=>implementationPlanner.generate(input)});
  const structuredIntake=createSelfDevelopmentIntake({modelProvider});
  const selfDevelopment=createSelfDevelopmentService({runtime:workerRuntime,storage,ownerId:OWNER_ID,approvedBranch:config.developmentBranch,currentCommit:environment.VERCEL_GIT_COMMIT_SHA,runtimeVersion:environment.VERCEL_GIT_COMMIT_SHA,verifyRemote,compareRemoteEvidence,verifyDeployment,structuredIntake,resolvePathState:async(path,commitSha)=>toolRegistry.execute("repo_path_state",{path,commitSha})});
  const artifactDelivery=createArtifactDeliveryService({runtime:workerRuntime,storage,ownerId:OWNER_ID,approvedRepository:environment.NOVA_BRAIN_GITHUB_REPOSITORY||"hshanbour/nova-brain",approvedBranch:config.developmentBranch,verifyRemote,findPreview,verifyDeployment,verifyHealth:verifyPreviewHealth});
  const artifactContinuity=codingDelegation?createTrustedArtifactContinuity({storage,ownerId:OWNER_ID,approvedRepository:environment.NOVA_BRAIN_GITHUB_REPOSITORY||"hshanbour/nova-brain",approvedBranch:config.developmentBranch,verifyRemote,codingDelegation,artifactDelivery}):null;
  registerArtifactDeliveryTool(toolRegistry,{service:artifactDelivery});
  const selfDevelopmentExpiryRecovery=createSelfDevelopmentExpiryRecovery({storage,ownerId:OWNER_ID,verifyDeployment});
  registerSelfDevelopmentTools(toolRegistry,{service:selfDevelopment});
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
  agent = createAgent({
    storage,
    ownerId: OWNER_ID,
    modelProvider,
    toolRegistry,
    maxSteps: config.maxAgentSteps,
    deadlineMs: config.syncAgentDeadlineMs,
    maxToolCallsPerStep: config.maxToolCallsPerStep,
    historyLimit: config.conversationHistoryLimit,
    memoryLimit: config.memoryRetrievalLimit,
    verifySpeakerAssertion: speakerAssertions.verify,
    validateSpeakerProfile: speakerIdentity.isActiveProfile,
    validateAnonymousSpeaker: speakerIdentity.isActiveAnonymous,
    routeExistingTaskRequest: async ({message,conversationId}) => {
      if(isConversationTaskResultQuestion(message)){
        const report=await terminalReporter.latestForConversation(conversationId);
        if(report)return{route:"conversation_task_report",action:"report",...report};
      }
      const request=parseExistingTaskControlRequest(message);
      if(!request)return null;
      return validateExistingTaskControlRequest(request,await workerRuntime.get(request.taskId));
    },
    durableResearchTaskService,
    routeDurableRequest: async ({message, context, runId, conversationId, signal}) => {
      if(context?.voice===true)return null;
      const implementationSignal=isDurableSelfDevelopmentRequest(message),codingSignal=isChatCodingDelegationRequest(message),workflowTurn=isConversationWorkflowTurn(message,{implementationSignal,codingSignal});
      let explicitRetry;
      try{explicitRetry=await resolveExplicitCodingRetryRequest({message,conversationId,runId,loadTask:id=>workerRuntime.get(id),codingExecutor});}
      catch(error){if(error instanceof SelfDevelopmentError)throw error;throw new SelfDevelopmentError(error?.code||"explicit_coding_retry_invalid","Nova could not safely resolve the explicit coding retry target.",error?.statusCode||409,error?.safeDiagnostics);}
      if(explicitRetry)return explicitRetry;
      if(!workflowTurn)return null;
      const bound=(await storage.listConversationBoundTasks(OWNER_ID,conversationId,{limit:20})).filter(isSelfDevelopmentWorkflowCandidate),historical=artifactContinuity?(await artifactContinuity.candidates({limit:8})).filter(isSelfDevelopmentWorkflowCandidate):[],boundIds=new Set(bound.map(task=>task.id)),boundCandidates=await Promise.all(bound
        .filter(task=>!(task.taskType==="coding_orchestration"&&task.metadata?.delegatedTaskId))
        .slice(0,8)
        .map(async task=>({
          id:task.id,
          taskType:task.taskType,
          status:task.status,
          stateVersion:task.stateVersion,
          title:task.title||null,
          objective:task.objective||null,
          currentPhase:task.currentPhase||null,
          errorCode:task.errorCode||null,
          currentCommit:task.currentCommit||null,
          approvalPending:task.status==="waiting_for_approval"&&task.approvalState?.approved!==true,
          parentTaskId:task.parentTaskId||task.metadata?.parentTaskId||null,
          delegatedTaskId:task.metadata?.delegatedTaskId||null,
          allowedTransitions:[
            "existing_workflow_question",
            "task_status",
            ...(isTrustedArtifactContinuationCandidate(task)?["existing_workflow_continue"]:[]),
            ...(codingExecutor&&await codingExecutor.retryEligibility(task.id,{conversationId})?["coding_retry_request"]:[]),
            ...(task.status==="waiting_for_approval"?["approval_decision"]:[]),
            ...(task.taskType==="coding_delegation"&&task.status==="completed"?["shipping_request"]:[]),
          ],
        }))),historicalCandidates=historical.filter(task=>!boundIds.has(task.id)),explicitTaskId=String(message||"").match(/\bcoding_[a-f0-9]{32}\b/)?.[0]||null,preferred=explicitTaskId?[...boundCandidates,...historicalCandidates].filter(task=>task.id===explicitTaskId):[],workflowCandidates=[...new Map([...preferred,...boundCandidates.slice(0,6),...historicalCandidates].map(task=>[task.id,task])).values()].slice(0,8);
      if(!workflowCandidates.length&&!implementationSignal&&!codingSignal)return null;
      const executeTransition=async(operation,diagnostics)=>{try{return await operation();}catch(error){error.safeDiagnostics={...error?.safeDiagnostics,...diagnostics,boundary:"transition_execution",reason:typeof error?.code==="string"?error.code.slice(0,120):"transition_failed"};throw error;}},explicitArtifact=explicitTaskId&&historicalCandidates.find(task=>task.id===explicitTaskId);
      if(explicitArtifact&&isExplicitTrustedArtifactRequest(message,explicitTaskId)){const routingDiagnostics={version:1,candidateIds:workflowCandidates.map(item=>item.id),candidateTransitions:workflowCandidates.map(item=>({candidateId:item.id,transitions:[...item.allowedTransitions]})),semanticIntent:"exact_task_action",semanticCandidateId:explicitTaskId,serverDerivedTransition:"artifact_adoption",ignoredFieldNames:[]};return{...(await executeTransition(()=>artifactContinuity.adopt(explicitTaskId,{conversationId,runId,signal}),routingDiagnostics)),providerUsage:null,turnRoute:"artifact_adoption",routingDiagnostics};}
      const routed=await selfDevelopment.resolveTrustedTurn(message,{workflowCandidates,signal,costContext:{runId},originConversationId:conversationId,originRunId:runId});
      if(routed?.shippingRequest===true){const workflow=routed.workflow;if(!workflow||workflow.taskType!=="coding_delegation"||workflow.status!=="completed")throw Object.assign(new Error("Shipping requires one completed conversation-bound coding artifact."),{code:"artifact_delivery_source_invalid",safeDiagnostics:{...routed.routingDiagnostics,boundary:"transition_validation",reason:"artifact_delivery_source_invalid"}});const created=await executeTransition(()=>artifactDelivery.create(workflow.id,{conversationId,runId}),routed.routingDiagnostics);return{...created,providerUsage:routed.providerUsage,turnRoute:routed.turnRoute,routingDiagnostics:routed.routingDiagnostics||null};}
      if(routed?.artifactAdoption===true){const adopted=await executeTransition(()=>artifactContinuity.adopt(routed.workflow.id,{conversationId,runId,signal}),routed.routingDiagnostics);return{...adopted,providerUsage:routed.providerUsage,turnRoute:routed.turnRoute,routingDiagnostics:routed.routingDiagnostics||null};}
      if(routed?.codingRetryRequest===true){const retried=await executeTransition(()=>codingExecutor.requestRetry(routed.workflow.id,{conversationId,runId}),routed.routingDiagnostics);return{...retried,workflow:routed.workflow,providerUsage:routed.providerUsage,turnRoute:routed.turnRoute,routingDiagnostics:routed.routingDiagnostics||null};}
      if(routed?.workflow?.action==="existing_workflow_continue"){const continued=await executeTransition(()=>artifactContinuity.continueWorkflow(routed.workflow.id,{conversationId,runId,signal}),routed.routingDiagnostics);return{...continued,workflow:routed.workflow,providerUsage:routed.providerUsage,turnRoute:routed.turnRoute,routingDiagnostics:routed.routingDiagnostics||null};}
      return routed?.codingDelegation?{...routed,requestFingerprint:codingDelegationFingerprint(message)}:routed;
    },
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
    autoDispatch,
    githubWriteAttestation,
    postAttestationRecovery,
    selfDevelopment,
    selfDevelopmentExpiryRecovery,
    voiceBenchmark,
    voiceService,
    speakerIdentity,
    speakerExtractor,
    speakerEngines,
    speakerAssertions,
    familiarityConsent,
    developerSessionSmoke,
    developerWorkspaceHandoff,
    modelCostController,
    codingExecutor,
    executionTruth,
    browserTaskService,
    durableResearchTaskService,
    gmailService,
    phoneService,
    logger,
  });
  return Object.freeze({ ...api, initialize, workerRuntime, phoneService });
}
