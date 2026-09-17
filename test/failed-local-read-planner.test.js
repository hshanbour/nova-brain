import test from "node:test";
import assert from "node:assert/strict";
import {createSelfDevelopmentImplementationPlanner} from "../src/autonomy/self-development-implementation-planner.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {FAILED_LOCAL_READ_RECOVERY_CLASS,recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";

const TASK="fixture-recovered-local-read-planner",OWNER="fixture-owner",REPOSITORY="hshanbour/nova-brain";
const BRANCH="feat/nova-brain-mvp-foundation",HEAD="a".repeat(40),RUNTIME="b".repeat(40);
const GENERATION="c".repeat(64),PREDECESSOR="d".repeat(64),APPLY="e".repeat(64),FINGERPRINT="f".repeat(64);
const OLD_WORKER="persistent-local-11111111-2222-4333-8444-555555555555",WORKER="persistent-local-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PATHS=["assets/console.css","assets/console.js","assets/voice-input.js","index.html","test/composer-dictation.test.js","test/composer-voice-console.integration.test.js","test/console-static.test.js","test/voice-input.test.js"];
const providerBoundary=Object.assign(new Error("Isolated planner provider boundary; no product generation."),{code:"fixture_provider_boundary"});

// Entirely in-memory durable specimens. No filesystem, live storage, network,
// credentials, product tools, or product replacement output is available.
function fixture(){
  const contents=new Map(PATHS.map((path,index)=>[path,`/* current fixture read ${index}: ${path} */\n`]));
  const entries=PATHS.map(path=>({path,contentHash:canonicalContentHash(contents.get(path))})).sort((a,b)=>a.path.localeCompare(b.path));
  const active={version:2,recoveryClass:FAILED_LOCAL_READ_RECOVERY_CLASS,generationId:GENERATION,startStep:125,maxSteps:10,runtimeStartedAt:"2026-09-14T00:00:00.000Z",runtimeMinutes:15,runtimeDeadline:"2026-09-14T00:15:00.000Z"};
  const renewal={sourceRecoveryClass:"task_owned_local_read_recovery",fromStateVersion:170,continuationGenerationId:PREDECESSOR,maxRenewals:1,authorizationConsumed:true,workerBindingState:"bound",workerId:OLD_WORKER,runtimeVersion:"0".repeat(40),runtimeWindow:{runtimeStartedAt:"2026-09-13T22:53:16.797Z",runtimeMinutes:15,runtimeDeadline:"2026-09-13T23:08:16.797Z"}};
  const predecessor={recoveryClass:"task_owned_local_read_recovery",previousStateVersion:169,sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch",fingerprint:FINGERPRINT,readPaths:PATHS.slice(5),runtimeVersion:"1".repeat(40)};
  const extension=[{recoveryClass:"owner_approved_single_repair_extension",approvalId:"fixture-consumed-extension",maxAdditionalAttempts:1,globalRepairLimit:3,previousRepairIteration:3}];
  const partial={taskId:TASK,repository:REPOSITORY,branch:BRANCH,currentCommit:HEAD,workspaceRoot:"C:/fixture/task-workspace",sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch",sourceApplyFingerprint:APPLY,fingerprint:FINGERPRINT,entries,requiredPaths:PATHS,activeContinuation:{generationId:PREDECESSOR}};
  const failed={taskId:TASK,stepId:"122:read_files",stepType:"read_files",attempt:1,status:"failed",errorCode:"task_owned_local_read_unproven",operationFingerprint:"2".repeat(64),result:{message:"The task-owned local read binding is invalid."}};
  const record={recoveryClass:FAILED_LOCAL_READ_RECOVERY_CLASS,taskId:TASK,fromStateVersion:174,toStateVersion:175,maxRecoveries:1,failedStepId:failed.stepId,failedAttempt:1,failedExecutionFingerprint:failed.operationFingerprint,predecessorGenerationId:PREDECESSOR,predecessorRenewalHash:recoveryHash(renewal),predecessorRecoveryHash:recoveryHash(predecessor),repository:REPOSITORY,branch:BRANCH,currentCommit:HEAD,workspaceRoot:partial.workspaceRoot,runtimeVersion:RUNTIME,sourcePlanStepId:partial.sourcePlanStepId,sourceApplyStepId:partial.sourceApplyStepId,sourceApplyFingerprint:APPLY,fingerprint:FINGERPRINT,entries,requiredPaths:PATHS,readPaths:PATHS.slice(5),extensionHistoryHash:recoveryHash(extension),repairIteration:3,retryCount:1,maxRetries:1,workerBindingState:"bound",workerId:WORKER,rejectedPriorWorkerIds:[OLD_WORKER],activeContinuation:active};
  const task={id:TASK,ownerId:OWNER,taskType:"self_development",status:"queued",stateVersion:184,currentStep:128,currentPhase:"read_files",branch:BRANCH,startingCommit:HEAD,currentCommit:HEAD,repairIteration:3,retryCount:1,maxRetries:1,metadata:{selfDevelopment:{repository:REPOSITORY,userGoal:"Complete the existing composer mission",acceptanceCriteria:["Editable dictation"]},activeContinuation:active,continuationHistory:[active],failedLocalReadRecoveryHistory:[record],partialRepairPlanRecoveryHistory:[partial],implementationPlanRecoveryHistory:[predecessor],continuationRuntimeResumeHistory:[renewal],escalatedRepairHistory:extension,
    // Deliberately invalid as current evidence: these old plan values must never
    // override completed reads or make an incomplete read set appear complete.
    selfDevelopmentImplementationPlan:{files:PATHS.map(path=>({path,content:"STALE prior implementation-plan content"}))}}};
  const steps=[{taskId:TASK,stepId:"79:plan_repair",stepType:"plan_repair",status:"completed",result:{implementationPlan:{files:PATHS.slice(0,6).map(path=>({path,content:"STALE historical source-plan content"}))}}},{taskId:TASK,stepId:"80:apply_patch",stepType:"apply_patch",status:"completed",operationFingerprint:APPLY,result:{files:PATHS.slice(0,6),taskOwnedDirtyLineage:{version:1,taskId:TASK,repository:REPOSITORY,branch:BRANCH,currentCommit:HEAD,sourcePlanStepId:"79:plan_repair",entries}}},failed];
  for(const [index,path] of PATHS.entries())steps.push({taskId:TASK,stepId:`${index<5?107+index:126+index-5}:read_files`,stepType:"read_files",status:"completed",input:{tool:index<5?"repo_read":"repo_read_task_owned_local",arguments:{path,expectedContentHash:canonicalContentHash(contents.get(path)),binding:{version:1,taskId:TASK,repository:REPOSITORY,branch:BRANCH,currentCommit:HEAD,workspaceRoot:partial.workspaceRoot,sourcePlanStepId:partial.sourcePlanStepId,sourceApplyStepId:partial.sourceApplyStepId,sourceApplyFingerprint:APPLY,runtimeVersion:RUNTIME,continuationGenerationId:GENERATION}}},result:{path,content:contents.get(path),contentHash:canonicalContentHash(contents.get(path)),truncated:false,...(index>=5?{source:"task_owned_local_workspace"}:{})}});
  const prompts=[];
  const storage={async getAutonomyTask(id,ownerId){assert.equal(id,TASK);assert.equal(ownerId,OWNER);return structuredClone(task);},async listAutonomySteps(id){assert.equal(id,TASK);return structuredClone(steps);},async updateAutonomyTask(){assert.fail("Planner eligibility cannot mutate durable state.");},async appendActivity(){assert.fail("Planner eligibility cannot mutate activity.");}};
  const planner=createSelfDevelopmentImplementationPlanner({storage,ownerId:OWNER,modelProvider:{async generate(request){prompts.push(JSON.parse(request.message.split("\n")[1]));throw providerBoundary;}}});
  const input={taskId:TASK,candidatePaths:PATHS,currentCommit:HEAD,failureEvidence:{code:"repair_plan_incomplete",fingerprint:FINGERPRINT,sourcePlanStepId:partial.sourcePlanStepId,sourceApplyStepId:partial.sourceApplyStepId,requiredPaths:PATHS}};
  return{task,steps,record,partial,contents,prompts,planner,input,read:path=>steps.find(step=>step.stepType==="read_files"&&step.status==="completed"&&step.result.path===path),snapshot:()=>JSON.stringify({task,steps})};
}

test("recovered planner reaches Nova provider with all eight actual read contents, never historical plan synthesis",async()=>{
  const f=fixture(),before=f.snapshot();
  await assert.rejects(()=>f.planner.generate(f.input),error=>error===providerBoundary);
  assert.equal(f.prompts.length,1);
  assert.deepEqual(f.prompts[0].candidateFiles,PATHS.map(path=>({path,content:f.contents.get(path)})));
  assert.equal(JSON.stringify(f.prompts).includes("STALE"),false);
  assert.equal(f.snapshot(),before);
});

test("later normal evidence-expanded planning is not frozen to the historical eight-file recovery set",async()=>{
  const f=fixture(),extra="test/composer-extra.test.js";
  f.task.currentStep=130;
  f.input.candidatePaths=[...PATHS,extra];
  f.task.metadata.implementationEvidenceExpansionHistory=[{attempt:1,category:"full_test_failure_evidence",pathHashes:[recoveryHash(extra)]}];
  f.steps.push({taskId:TASK,stepId:"130:read_files",stepType:"read_files",status:"completed",input:{tool:"repo_read",arguments:{path:extra}},result:{path:extra,content:"/* bounded later evidence */\n",truncated:false}});
  const before=f.snapshot();
  await assert.rejects(()=>f.planner.generate(f.input),error=>error===providerBoundary);
  assert.equal(f.prompts.length,1);assert.ok(f.prompts[0].candidateFiles.some(file=>file.path===extra));
  assert.equal(f.snapshot(),before);
});

test("later normal repair planning can use a new completed apply without rewriting the recovery source lineage",async()=>{
  const f=fixture();f.task.currentStep=132;
  f.steps.push({taskId:TASK,stepId:"131:apply_patch",stepType:"apply_patch",status:"completed",operationFingerprint:"3".repeat(64),result:{files:[PATHS[0]]}});
  const before=f.snapshot();
  await assert.rejects(()=>f.planner.generate(f.input),error=>error===providerBoundary);
  assert.equal(f.prompts.length,1);assert.equal(f.record.sourceApplyStepId,"80:apply_patch");assert.equal(f.snapshot(),before);
});

for(const [name,alter] of [
  ["missing one of eight reads",f=>{f.steps.splice(f.steps.indexOf(f.read(PATHS[7])),1);}],
  ["only the original five reads",f=>{for(const path of PATHS.slice(5))f.steps.splice(f.steps.indexOf(f.read(path)),1);}],
  ["partial latest read",f=>{f.read(PATHS[7]).result.truncated=true;}],
  ["missing completeness flag",f=>{delete f.read(PATHS[7]).result.truncated;}],
  ["read content drift",f=>{f.read(PATHS[7]).result.content="changed current content";}],
  ["read hash drift",f=>{f.read(PATHS[7]).result.contentHash="0".repeat(64);} ],
  ["pre-apply carried read",f=>{f.read(PATHS[0]).stepId="78:read_files";}],
  ["pre-recovery remaining read",f=>{f.read(PATHS[7]).stepId="120:read_files";}],
  ["wrong recovered-read generation",f=>{f.read(PATHS[7]).input.arguments.binding.continuationGenerationId=PREDECESSOR;}],
  ["wrong recovered-read runtime",f=>{f.read(PATHS[7]).input.arguments.binding.runtimeVersion="0".repeat(40);} ],
  ["wrong recovered-read workspace",f=>{f.read(PATHS[7]).input.arguments.binding.workspaceRoot="C:/different/workspace";}],
  ["wrong recovered-read task",f=>{f.read(PATHS[7]).input.arguments.binding.taskId="another-task";}],
  ["wrong recovered-read tool",f=>{f.read(PATHS[7]).input.tool="repo_read";}],
  ["wrong recovered-read expected hash",f=>{f.read(PATHS[7]).input.arguments.expectedContentHash="0".repeat(64);} ],
  ["older valid read cannot mask truncated latest read",f=>{const latest=structuredClone(f.read(PATHS[7]));latest.stepId="129:read_files";latest.result.truncated=true;f.steps.push(latest);}],
  ["wrong required candidate subset",f=>{f.input.candidatePaths=PATHS.slice(0,7);} ],
  ["unrelated candidate added",f=>{f.input.candidatePaths=[...PATHS,"test/unrelated.test.js"];}],
  ["tampered active recovery class",f=>{f.task.metadata.activeContinuation={...f.task.metadata.activeContinuation,recoveryClass:"task_owned_local_read_recovery"};}],
  ["wrong preserved extension",f=>{f.task.metadata.escalatedRepairHistory[0].maxAdditionalAttempts=2;}],
  ["unbound successor worker",f=>{f.record.workerBindingState="awaiting_worker_bind";f.record.workerId=null;}],
])test(`recovered planner rejects ${name} before provider without mutation`,async()=>{
  const f=fixture();alter(f);const before=f.snapshot();
  await assert.rejects(()=>f.planner.generate(f.input),error=>["failed_local_read_recovery_precondition_failed","implementation_evidence_incomplete"].includes(error.code));
  assert.equal(f.prompts.length,0);assert.equal(f.snapshot(),before);
});
