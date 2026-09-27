import test from "node:test";
import assert from "node:assert/strict";
import { createCodingDelegationService, codingDelegationFingerprint, isChatCodingDelegationRequest } from "../src/autonomy/coding-delegation.js";
import { codingSpecificationHash, createCodingExecutorService } from "../src/autonomy/coding-executor.js";
import { registerWorkerTools } from "../src/autonomy/worker-tools.js";
import { ApprovalRequiredError, createActionPolicy } from "../src/policy/action-policy.js";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { createWorkerRuntime } from "../src/autonomy/worker-runtime.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { createArtifactDeliveryService } from "../src/autonomy/artifact-delivery.js";
import { createTerminalTaskReporter } from "../src/autonomy/terminal-task-reporter.js";

const OWNER="owner",BASE="a".repeat(40),BINDING={projectId:"nova-brain",workspaceId:"nova-brain",repository:"hshanbour/nova-brain",branch:"feature"};

async function fixture(bindings=[BINDING]){
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER},projects:[{id:"nova-brain",name:"Nova Brain"}]});
  const runtime=createWorkerRuntime({storage,ownerId:OWNER,toolRegistry:createToolRegistry(),approvedBranch:"feature"});
  let remoteCalls=0;const service=createCodingDelegationService({runtime,storage,ownerId:OWNER,bindings,verifyRemote:async input=>{remoteCalls++;assert.equal(input.repository,"hshanbour/nova-brain");assert.equal(input.branch,"feature");return{currentTip:BASE};}});
  return{storage,runtime,service,remoteCalls:()=>remoteCalls};
}

const request={objective:"Improve keyboard accessibility in the Recent Conversations drawer.",acceptanceCriteria:["Keyboard navigation and focus management work.","Existing Console behavior remains intact."],constraints:["Do not push or deploy."],verification:["Run focused Console tests."]};

test("natural explicit Codex requests use a first-class delegation route while ordinary and self-development chat do not",()=>{
  assert.equal(isChatCodingDelegationRequest("Build this in the current project. Use Codex for the coding."),true);
  assert.equal(isChatCodingDelegationRequest("Nova, improve your own Console implementation."),false);
  assert.equal(isChatCodingDelegationRequest("How should I improve keyboard accessibility?"),false);
});

test("preparation selects only the trusted project, resolves a fresh baseline, and is deterministic",async()=>{
  const f=await fixture(),context={delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix the drawer"),conversationId:"conversation-1",runId:"run-1"};
  const first=await f.service.prepare(request,context),second=await f.service.prepare({...request,objective:"Model wording must not replace the existing prepared authority."},context);
  assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);assert.equal(first.task.id,second.task.id);
  assert.equal(first.task.taskType,"coding_orchestration");assert.equal("metadata" in first.task,false);
  const persisted=await f.storage.getAutonomyTask(first.task.id,OWNER),stored=persisted.metadata.codingDelegation.codingJob;
  assert.equal("codingJob" in first,false);assert.equal("codingJob" in second,false);
  assert.deepEqual(stored.repository,{slug:"hshanbour/nova-brain",branch:"feature",baseline:BASE});
  assert.deepEqual(stored.delivery,{boundary:"local_commit",allowPush:false,allowDeploy:false});
  assert.equal(stored.version,1);assert.equal(persisted.metadata.codingDelegation.codingJobHash,codingSpecificationHash(stored));
  assert.deepEqual(first.creationRequest,{parentTaskId:first.task.id,specificationHash:codingSpecificationHash(stored)});
  assert.deepEqual(second.creationRequest,first.creationRequest);
  assert.equal(stored.parentTaskId,first.task.id);assert.equal((await f.storage.listAutonomyTasks(OWNER)).length,1);
  assert.deepEqual(persisted.metadata.terminalReporting,{version:1,conversationId:"conversation-1",runId:"run-1"});
});

test("the compact immutable creation handle reaches approval and the server creates from its stored canonical specification",async()=>{
  const f=await fixture(),runId="chat-run",prepared=await f.service.prepare(request,{delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix the drawer"),conversationId:"conversation-1",runId});
  const codingExecutor=createCodingExecutorService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[BINDING]});
  const registry=createToolRegistry({policy:createActionPolicy({storage:f.storage,ownerId:OWNER,approvedBranch:"feature"})});
  registerWorkerTools(registry,{runtime:f.runtime,taskMigration:{migrate(){throw new Error("unused");}},codingExecutor,codingDelegation:f.service});
  const createTool=registry.list().find(tool=>tool.name==="coding_job_create");
  assert.deepEqual(Object.keys(createTool.inputSchema.properties).sort(),["parentTaskId","specificationHash"]);
  await assert.rejects(
    registry.execute("coding_job_create",{...prepared.creationRequest,objective:"must not be accepted"},{runId,projectId:BINDING.projectId}),
    error=>error.code==="schema_mismatch"&&error.safeDiagnostics?.fieldPath==="coding_job_create.objective"&&error.safeDiagnostics?.argumentKeys.includes("objective")&&!JSON.stringify(error.safeDiagnostics).includes("must not be accepted"),
  );
  await assert.rejects(
    registry.execute("coding_job_create",prepared.creationRequest,{runId,projectId:BINDING.projectId}),
    error=>error instanceof ApprovalRequiredError&&error.approval.tool==="coding_job_create"&&error.approval.runId===runId,
  );
  const approvals=await f.storage.listApprovals(OWNER);
  assert.equal(approvals.length,1);
  assert.equal(approvals[0].status,"pending");
  assert.deepEqual(approvals[0].arguments,prepared.creationRequest);
  await f.storage.decideApproval(approvals[0].id,OWNER,"approved");
  const created=await registry.execute("coding_job_create",prepared.creationRequest,{runId,projectId:BINDING.projectId,approvalId:approvals[0].id});
  assert.equal(created.task.metadata.codingJob.objective,request.objective);
  assert.equal(created.task.metadata.codingJob.approval.approvalId,approvals[0].id);
  assert.deepEqual(created.task.metadata.terminalReporting,{version:1,conversationId:"conversation-1",runId});
  assert.equal(created.task.metadata.steps[0].input.arguments.objective,request.objective);
  const duplicate=await registry.execute("coding_job_create",prepared.creationRequest,{runId,projectId:BINDING.projectId,approvalId:approvals[0].id});
  assert.equal(duplicate.duplicate,true);assert.equal((await f.storage.listAutonomyTasks(OWNER)).length,2);
});

test("already-approved historical full specifications retain a bounded dual-read replay path",async()=>{
  const f=await fixture(),prepared=await f.service.prepare(request,{delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix the drawer")});
  const codingExecutor=createCodingExecutorService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[BINDING]});
  const registry=createToolRegistry({policy:{async authorize(){}}});
  registerWorkerTools(registry,{runtime:f.runtime,taskMigration:{migrate(){throw new Error("unused");}},codingExecutor,codingDelegation:f.service});
  const historical=(await f.storage.getAutonomyTask(prepared.task.id,OWNER)).metadata.codingDelegation.codingJob;
  await assert.rejects(registry.execute("coding_job_create",historical,{}),error=>error.code==="schema_mismatch");
  const created=await registry.execute("coding_job_create",historical,{approvalId:"historical-approval"});
  assert.equal(created.task.metadata.codingJob.approval.approvalId,"historical-approval");
});

test("preparation fails closed for ambiguous or arbitrary project authority and never accepts Main",async()=>{
  const ambiguous=await fixture([BINDING,{projectId:"other",workspaceId:"other",repository:"safe/other",branch:"feature"}]),context={delegationRequestFingerprint:codingDelegationFingerprint("Use Codex to fix it")};
  await assert.rejects(ambiguous.service.prepare(request,context),error=>error.code==="coding_project_binding_ambiguous");
  const f=await fixture();await assert.rejects(f.service.prepare({...request,projectId:"attacker"},context),error=>error.code==="coding_repository_binding_rejected");
  await assert.rejects(f.service.prepare(request,{}),error=>error.code==="coding_delegation_unbound");
  assert.throws(()=>createCodingDelegationService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[{...BINDING,branch:"main"}],verifyRemote:async()=>({currentTip:BASE})}),error=>error.code==="coding_binding_invalid");
});

test("trusted artifact adoption is server-derived, conversation-bound, and hash-bound to current integration baseline",async()=>{
  const f=await fixture(),artifact={version:1,sourceTaskId:`coding_${"9".repeat(32)}`,sourceStateVersion:7,repository:BINDING.repository,sourceBranch:"feat/old",commitSha:"c".repeat(40),artifactRef:`refs/nova/coding-jobs/coding_${"9".repeat(32)}`,filesChanged:["assets/console.js","test/console-static.test.js"]};
  const first=await f.service.prepareTrustedArtifact({projectId:BINDING.projectId,trustedArtifact:artifact},{conversationId:"conversation-adopt",runId:"run-adopt"}),restarted=createCodingDelegationService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[BINDING],verifyRemote:async()=>({currentTip:BASE})}),second=await restarted.prepareTrustedArtifact({projectId:BINDING.projectId,trustedArtifact:artifact},{conversationId:"conversation-adopt",runId:"run-adopt"});
  assert.equal(first.duplicate,false);assert.equal(second.duplicate,true);const stored=await f.storage.getAutonomyTask(first.task.id,OWNER),job=stored.metadata.codingDelegation.codingJob;
  assert.deepEqual(job.trustedArtifact,artifact);assert.equal(job.repository.baseline,BASE);assert.equal(stored.metadata.trustedArtifactAdoption.sourceTaskId,artifact.sourceTaskId);assert.deepEqual(stored.metadata.terminalReporting,{version:1,conversationId:"conversation-adopt",runId:"run-adopt"});assert.equal(stored.metadata.codingDelegation.codingJobHash,codingSpecificationHash(job));
  assert.equal(stored.status,"waiting_for_approval");assert.equal(stored.currentPhase,"waiting_for_approval");assert.equal(stored.metadata.autoDispatch,false);assert.deepEqual(stored.approvalState.arguments,first.creationRequest);assert.equal(first.approval.id,second.approval.id);
  const approvals=await f.storage.listApprovals(OWNER),tasks=await f.storage.listAutonomyTasks(OWNER),activity=await f.storage.listActivity(OWNER,{runId:stored.id});
  assert.equal(approvals.length,1);assert.equal(approvals[0].status,"pending");assert.deepEqual(approvals[0].arguments,first.creationRequest);assert.equal(tasks.length,1);assert.equal(tasks.some(task=>task.taskType==="coding_job"),false);assert.equal(activity.filter(item=>item.action==="trusted_artifact_integration_approval_requested").length,1);
  const codingExecutor=createCodingExecutorService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[BINDING]}),registry=createToolRegistry({policy:createActionPolicy({storage:f.storage,ownerId:OWNER,approvedBranch:"feature"})});registerWorkerTools(registry,{runtime:f.runtime,taskMigration:{migrate(){throw new Error("unused");}},codingExecutor,codingDelegation:f.service});
  await f.storage.decideApproval(first.approval.id,OWNER,"approved");const created=await registry.execute("coding_job_create",first.creationRequest,{runId:stored.id,projectId:BINDING.projectId,approvalId:first.approval.id}),replayed=await registry.execute("coding_job_create",first.creationRequest,{runId:stored.id,projectId:BINDING.projectId,approvalId:first.approval.id});
  assert.equal(created.task.taskType,"coding_delegation");assert.equal(created.task.metadata.codingJob.trustedArtifact.commitSha,artifact.commitSha);assert.equal(replayed.duplicate,true);assert.equal((await f.storage.listAutonomyTasks(OWNER)).length,2);
});

test("trusted artifact adoption fails closed if its approval transition cannot be persisted",async()=>{
  const f=await fixture(),artifact={version:1,sourceTaskId:`coding_${"8".repeat(32)}`,sourceStateVersion:4,repository:BINDING.repository,sourceBranch:"feat/old",commitSha:"d".repeat(40),artifactRef:`refs/nova/coding-jobs/coding_${"8".repeat(32)}`,filesChanged:["assets/console.js"]},storage=Object.freeze({...f.storage,createApproval:async()=>{throw Object.assign(new Error("database unavailable"),{code:"storage_unavailable"});}}),service=createCodingDelegationService({runtime:f.runtime,storage,ownerId:OWNER,bindings:[BINDING],verifyRemote:async()=>({currentTip:BASE})});
  await assert.rejects(()=>service.prepareTrustedArtifact({projectId:BINDING.projectId,trustedArtifact:artifact},{conversationId:"conversation-fail",runId:"run-fail"}),error=>error.code==="storage_unavailable");
  const [parent]=await f.storage.listAutonomyTasks(OWNER);assert.equal(parent.status,"blocked");assert.equal(parent.currentPhase,"coding_creation_failed");assert.equal(parent.errorCode,"coding_creation_transition_failed");assert.equal(parent.leaseOwner,null);assert.equal((await f.storage.listApprovals(OWNER)).length,0);
});

test("conversation-bound terminal coding retry creates one fresh approval then one deterministic successor",async()=>{
  const f=await fixture(),conversationId="conversation-retry",artifact={version:1,sourceTaskId:`coding_${"7".repeat(32)}`,sourceStateVersion:7,repository:BINDING.repository,sourceBranch:"feat/old",commitSha:"c".repeat(40),artifactRef:`refs/nova/coding-jobs/coding_${"7".repeat(32)}`,filesChanged:["assets/console.js"]};
  await f.storage.ensureConversation({id:conversationId,ownerId:OWNER,title:"Drawer retry"});
  const prepared=await f.service.prepareTrustedArtifact({projectId:BINDING.projectId,trustedArtifact:artifact},{conversationId,runId:"run-adopt"}),executor=createCodingExecutorService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[BINDING]});
  await f.storage.decideApproval(prepared.approval.id,OWNER,"approved");
  const first=await executor.createFromHandle(prepared.creationRequest,{approvalId:prepared.approval.id});
  let parent=await f.storage.getAutonomyTask(prepared.task.id,OWNER);parent=await f.storage.updateAutonomyTask(parent.id,OWNER,{status:"completed",currentPhase:"delegated_coding",completedAt:"2026-09-27T10:00:00.000Z",metadata:{...parent.metadata,delegatedTaskId:first.task.id}},parent.stateVersion);
  let failed=await f.storage.getAutonomyTask(first.task.id,OWNER);failed=await f.storage.updateAutonomyTask(failed.id,OWNER,{status:"failed",currentPhase:"failed",errorCode:"coding_workspace_dirty",blockedReason:"The shared source checkout was dirty.",completedAt:"2026-09-27T10:01:00.000Z"},failed.stateVersion);const failedSnapshot=structuredClone(failed),taskCount=(await f.storage.listAutonomyTasks(OWNER)).length;
  const reporter=createTerminalTaskReporter({storage:f.storage,ownerId:OWNER});await reporter.reconcile();assert.equal((await f.storage.listMessages(conversationId,OWNER,{limit:10})).filter(item=>item.content.startsWith(`Task report — ${failed.id}\n`)).length,1);
  assert.equal(await executor.retryEligibility(failed.id,{conversationId}),true);assert.equal(await executor.retryEligibility(failed.id,{conversationId:"foreign-conversation"}),false);
  const requested=await executor.requestRetry(failed.id,{conversationId,runId:"run-retry"}),restarted=createCodingExecutorService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,bindings:[BINDING]}),replayed=await restarted.requestRetry(failed.id,{conversationId,runId:"run-retry-replay"});
  assert.equal(requested.task.status,"waiting_for_approval");assert.equal(requested.task.currentPhase,"retry_waiting_for_approval");assert.equal(requested.approval.status,"pending");assert.notEqual(requested.approval.id,prepared.approval.id);assert.equal(replayed.approval.id,requested.approval.id);assert.equal(replayed.idempotent,true);assert.equal((await f.storage.listAutonomyTasks(OWNER)).length,taskCount);assert.deepEqual(await f.storage.getAutonomyTask(failed.id,OWNER),failedSnapshot);
  await assert.rejects(()=>restarted.createFromHandle(prepared.creationRequest,{approvalId:prepared.approval.id}),error=>error.code==="coding_retry_approval_invalid");
  await f.storage.decideApproval(requested.approval.id,OWNER,"approved");const successor=await restarted.createFromHandle(requested.creationRequest,{approvalId:requested.approval.id}),duplicate=await restarted.createFromHandle(requested.creationRequest,{approvalId:requested.approval.id});
  assert.notEqual(successor.task.id,failed.id);assert.equal(duplicate.task.id,successor.task.id);assert.equal(duplicate.duplicate,true);assert.equal(successor.task.metadata.codingRetry.predecessorTaskId,failed.id);assert.equal(successor.task.metadata.codingRetry.predecessorStateVersion,failed.stateVersion);assert.equal(successor.task.metadata.codingJob.repository.baseline,BASE);assert.deepEqual(successor.task.metadata.terminalReporting,{version:1,conversationId,runId:"run-adopt"});assert.deepEqual(await f.storage.getAutonomyTask(failed.id,OWNER),failedSnapshot);
  parent=await f.storage.getAutonomyTask(parent.id,OWNER);await f.storage.updateAutonomyTask(parent.id,OWNER,{status:"completed",currentPhase:"delegated_coding",completedAt:"2026-09-27T10:02:00.000Z",approvalState:{...parent.approvalState,approved:true},metadata:{...parent.metadata,delegatedTaskId:successor.task.id}},parent.stateVersion);
  const localSha="d".repeat(40),result={status:"completed",summary:"Integrated the drawer artifact.",repository:BINDING.repository,baseline:BASE,finalLocalSha:localSha,filesChanged:["assets/console.js"],tests:[{command:"node --test test/console-static.test.js",status:"passed",summary:null}],limitations:[],pushOccurred:false,deploymentOccurred:false,approvalsRequiredNext:[],failure:null,executor:{localRef:`refs/nova/coding-jobs/${successor.task.id}`}};
  let completed=await f.storage.getAutonomyTask(successor.task.id,OWNER);await f.storage.recordAutonomyStep({taskId:completed.id,stepId:"1:delegate_coding",stepType:"delegate_coding",capability:"codex_local",operationFingerprint:"retry-completed",status:"completed",result});completed=await f.storage.updateAutonomyTask(completed.id,OWNER,{status:"completed",currentPhase:"completed",currentCommit:localSha,resultSummary:result.summary,completedAt:"2026-09-27T10:03:00.000Z"},completed.stateVersion);
  await reporter.reconcile();await reporter.reconcile();assert.equal((await f.storage.listMessages(conversationId,OWNER,{limit:10})).filter(item=>item.content.startsWith(`Task report — ${successor.task.id}\n`)).length,1);
  const delivery=createArtifactDeliveryService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,approvedRepository:BINDING.repository,approvedBranch:BINDING.branch,verifyRemote:async()=>({currentTip:localSha}),findPreview:async()=>null,verifyDeployment:async()=>null,verifyHealth:async()=>({status:200})}),validated=await delivery.validateSource(completed.id),shipping=await delivery.create(completed.id,{conversationId,runId:"run-ship"});
  assert.equal(validated.task.id,successor.task.id);assert.equal(validated.contract.artifactRef,`refs/nova/coding-jobs/${successor.task.id}`);assert.equal(validated.contract.commitSha,localSha);assert.equal(shipping.task.status,"waiting_for_approval");assert.equal(shipping.task.metadata.artifactDelivery.sourceTaskId,successor.task.id);assert.equal(await restarted.retryEligibility(successor.task.id,{conversationId}),false);
});
