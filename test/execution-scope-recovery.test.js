import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {seedPlanningRecoveryFixture,PLANNING_CLOCK,PLANNING_TOKEN,PLANNING_WORKER} from "./planning-scope-fixture.js";
import {bindImplementationPlan,planLifecycleMetadata} from "../src/autonomy/self-development-plan-lifecycle.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";
import {EXECUTION_SCOPE_RECOVERY_CLASS,EXECUTION_SCOPE_RECOVERY_TOOL,describeExecutionScopeRecovery,recoverExecutionScope,validateExecutionScopeContext,validateExecutionScopeEvidence,executionScopePayload} from "../src/autonomy/execution-scope-recovery.js";

const RUNTIME="d".repeat(40),WORKER="persistent-local-abcdef12-3456-4789-8abc-def012345678";
const CLOCK=()=>new Date("2026-09-16T12:00:00.000Z");
// In-memory production-shaped boundary. No file, credential, network or worker
// operation is available to this unit fixture, including approval/recovery calls.
async function fixture(){
  const f=await seedPlanningRecoveryFixture();await f.authorize();await f.recover();
  let task=await f.runtime.get(f.taskId),record=task.metadata.planningScopeRecoveryHistory[0],base=record.activeContinuation.startStep;
  const files=[...f.contents].map(([path,expectedContent],index)=>({path,operation:"replace",expectedContent,content:`/* complete synthetic replacement ${index} */\n`,reason:"Synthetic acceptance",intendedChanges:["Replace synthetic content"]}));
  const focusedTests=files.filter(file=>file.path.startsWith("test/")).map(({path})=>({path,kind:"existing"})),acceptanceMapping=[{criterion:"Synthetic editable dictation",files:files.map(file=>file.path)}];
  const plan={files,focusedTests,acceptanceMapping,riskLevel:"low",summary:"Synthetic validated replacement",evidencePaths:files.map(file=>file.path),planHash:recoveryHash({files:files.map(({expectedContent,...file})=>file),focusedTests,acceptanceMapping,riskLevel:"low"})};
  plan.provenance={...bindImplementationPlan({task,plan,evidence:[...f.contents].map(([path,content])=>({path,content})),readStepIds:record.readProofs.map(item=>item.stepId)}),planningOnly:true};
  const sourcePlanStepId=`${base+1}:plan_repair`,validatedStepId=`${base+2}:validate_patch`,boundary={kind:"focused_test_scheduling_ready",tool:"test_run",arguments:{files:focusedTests.map(item=>item.path)},executionAuthorized:false,mutationApplied:false,planGenerationId:plan.provenance.generationId,validatedStepId};
  await f.storage.recordAutonomyStep({taskId:f.taskId,stepId:sourcePlanStepId,stepType:"plan_repair",status:"completed",attempt:1,operationFingerprint:"6".repeat(64),result:{ok:true,implementationPlan:plan}});
  await f.storage.recordAutonomyStep({taskId:f.taskId,stepId:validatedStepId,stepType:"validate_patch",status:"completed",attempt:1,operationFingerprint:"7".repeat(64),input:{tool:"repo_validate_patch",arguments:{files}},result:{ok:true,preMutationValidated:true,mutationApplied:false,currentCommit:f.head,planGenerationId:plan.provenance.generationId,files:files.map(file=>file.path)}});
  const metadata={...planLifecycleMetadata(task,plan),planningScopeRecoveryHistory:[{...record,workerId:PLANNING_WORKER,workerBindingState:"bound",consumed:true,completedAt:"2026-09-15T12:02:00.000Z",boundary}],planningScopeBoundary:boundary};
  task=await f.storage.updateAutonomyTask(f.taskId,f.ownerId,{metadata,status:"blocked",currentPhase:"validate_patch",currentStep:base+2,nextRunAt:null},task.stateVersion);
  while(task.stateVersion<208)task=await f.storage.updateAutonomyTask(f.taskId,f.ownerId,{},task.stateVersion);
  const workspaceProof=structuredClone(f.input.workspaceProof);workspaceProof.runtimeVersion=RUNTIME;workspaceProof.expectedVersion=task.stateVersion;
  const input={expectedVersion:task.stateVersion,runtimeVersion:RUNTIME,planHash:plan.planHash,workspaceProof,workspaceProofSignature:createHmac("sha256",PLANNING_TOKEN).update(recoveryHash(workspaceProof)).digest("hex")};
  const options={...f.options,input,actor:{actorType:"scoped_local_worker",workspaceProof},runtimeVersion:RUNTIME,clock:CLOCK,verifyRemote:async request=>({currentTip:f.remoteOverrides[request.branch]||(request.branch===f.branch?f.head:RUNTIME),ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))})};
  const describe=()=>describeExecutionScopeRecovery(options),recover=()=>recoverExecutionScope(options);
  const authorize=async()=>{const {approvalArguments}=await describe();await f.storage.createApproval({id:"synthetic-exact-execution-approval",ownerId:f.ownerId,projectId:task.projectId,runId:f.taskId,tool:EXECUTION_SCOPE_RECOVERY_TOOL,arguments:approvalArguments});await f.storage.decideApproval("synthetic-exact-execution-approval",f.ownerId,"approved");input.approvalId="synthetic-exact-execution-approval";return approvalArguments;};
  return{...f,options,input,plan,describe,recover,authorize,clock:CLOCK,runtimeVersion:RUNTIME,sourcePlanStepId,validatedStepId};
}
async function unchangedRejection(f,operation,predicate){const before=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId);await assert.rejects(operation,error=>error.code==="execution_scope_recovery_precondition_failed"&&(!predicate||error.safeDiagnostics?.predicate===predicate));assert.deepEqual(await f.runtime.get(f.taskId),before);assert.deepEqual(await f.runtime.steps(f.taskId),steps);}
async function mutateTask(f,alter){const task=await f.runtime.get(f.taskId);alter(task);const next=await f.storage.updateAutonomyTask(f.taskId,f.ownerId,task,task.stateVersion);f.input.expectedVersion=next.stateVersion;f.input.workspaceProof.expectedVersion=next.stateVersion;return next;}
async function mutateStep(f,id,alter){const step=(await f.runtime.steps(f.taskId)).find(item=>item.stepId===id);alter(step);await f.storage.updateAutonomyStep(f.taskId,id,step);}
function context(f,task){return{runtimeVersion:f.runtimeVersion,generationId:task.metadata.activeContinuation.generationId,repository:f.repository,branch:f.branch,root:f.root,workerId:WORKER,allowFirstBind:true};}

test("v208 validated planning boundary permits exactly one separately owner-approved execution successor without reopening the expired predecessor",async()=>{
  const f=await fixture(),before=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId),described=await f.describe();
  assert.equal(before.stateVersion,208);assert.equal(before.currentStep,148);assert.equal(before.status,"blocked");
  assert.ok(Date.parse(before.metadata.activeContinuation.runtimeDeadline)<CLOCK().getTime());
  assert.notEqual(f.head,f.runtimeVersion);assert.notEqual(before.metadata.planningScopeRecoveryHistory[0].runtimeVersion,f.runtimeVersion);
  assert.equal(described.requiredPaths.length,8);assert.equal(described.focusedTests.length,4);assert.deepEqual(await f.runtime.get(f.taskId),before);
  await f.authorize();const {recovery:record,task:after}=await f.recover();
  assert.equal(after.stateVersion,209);assert.equal(after.currentStep,148);assert.equal(after.currentPhase,"apply_patch");assert.equal(after.status,"queued");
  assert.equal(record.recoveryClass,EXECUTION_SCOPE_RECOVERY_CLASS);assert.equal(record.activeContinuation.maxSteps,2);assert.equal(record.activeContinuation.runtimeMinutes,15);assert.equal(record.activeContinuation.runtimeDeadline,"2026-09-16T12:15:00.000Z");
  assert.equal(record.maxProductMutations,1);assert.equal(record.maxApplyAttempts,1);assert.equal(record.maxFocusedTestRuns,1);assert.equal(record.maxAdditionalAttempts,0);assert.equal(record.authorizationConsumed,true);assert.equal(record.workerId,null);
  assert.deepEqual(after.metadata.steps.slice(148).map(step=>[step.type,step.input.tool]),[["apply_patch","repo_apply_patch"],["run_focused_tests","test_run"]]);
  for(const key of ["failedLocalReadRecoveryHistory","continuationRuntimeResumeHistory","implementationPlanRecoveryHistory","partialRepairPlanRecoveryHistory","escalatedRepairHistory","planningScopeRecoveryHistory","planningScopeBoundary","selfDevelopmentImplementationPlan","implementationPlanGenerations"])assert.deepEqual(after.metadata[key],before.metadata[key]);
  for(const key of ["repairIteration","retryCount","maxRetries","currentCommit","startingCommit","branch"])assert.equal(after[key],before[key]);
  assert.deepEqual(await f.runtime.steps(f.taskId),steps);assert.equal(after.metadata.selfDevelopmentImplementationPlan.provenance.planningOnly,true);
  assert.equal(validateExecutionScopeContext(after,steps,context(f,after),CLOCK).firstBind,true);
  assert.equal(executionScopePayload(record).beforeEntries.length,8);
  await unchangedRejection(f,()=>f.recover());
});

test("signed workspace proof and prior planning/repair approvals cannot substitute for new exact owner execution approval",async()=>{const f=await fixture();await unchangedRejection(f,()=>f.recover(),"exact_owner_approval");});
for(const [name,alter] of [
  ["pending",a=>{a.status="pending";}],["wrong owner",a=>{a.ownerId="another";}],["wrong project",a=>{a.projectId="another";}],["wrong task",a=>{a.runId="another";}],["planning-only approval",a=>{a.tool="self_development_planning_scope_recovery";}],
  ["different plan",a=>{a.arguments.planHash="0".repeat(64);}],["expanded test scope",a=>{a.arguments.focusedTests.push("test/unrelated.test.js");}],["two applications",a=>{a.arguments.maxApplyAttempts=2;}],["extra repair attempt",a=>{a.arguments.maxAdditionalAttempts=1;}],["longer window",a=>{a.arguments.runtimeMinutes=30;}]
])test(`execution approval rejects ${name}`,async()=>{const f=await fixture();await f.authorize();const get=f.options.storage.getApproval;f.options.storage={...f.storage,getApproval:async(id,owner)=>{const result=await get(id,owner);if(id===f.input.approvalId)alter(result);return result;}};await unchangedRejection(f,()=>f.recover(),"exact_owner_approval");});

for(const [name,alter] of [
  ["wrong task",p=>{p.taskId="another";}],["wrong version",p=>{p.expectedVersion=207;}],["wrong repository",p=>{p.workspace.repository="wrong/repo";}],["wrong branch",p=>{p.workspace.branch="main";}],["wrong workspace",p=>{p.workspace.root+="/other";}],["wrong top-level",p=>{p.workspace.gitTopLevel+="/other";}],["wrong HEAD",p=>{p.workspace.head="f".repeat(40);}],["wrong live tip",p=>{p.workspace.liveTip="f".repeat(40);}],["runtime confused with product HEAD",p=>{p.workspace.head=RUNTIME;}],["wrong active runtime",p=>{p.runtimeVersion="f".repeat(40);}],["canonical content drift",p=>{p.workspace.changedFiles[0].contentHash="0".repeat(64);}],["CRLF/raw byte drift",p=>{p.workspace.changedFiles[0].hash="0".repeat(40);}],["missing path",p=>{p.workspace.changedFiles.pop();}],["ninth dirty file",p=>{p.workspace.changedFiles.push({...p.workspace.changedFiles[0],path:"test/unrelated.test.js"});}],["duplicate path",p=>{p.workspace.changedFiles[1]=p.workspace.changedFiles[0];}]
])test(`execution eligibility rejects ${name} without mutation`,async()=>{const f=await fixture();alter(f.input.workspaceProof);await unchangedRejection(f,()=>f.describe());});

for(const [name,alter] of [
  ["task no longer blocked",task=>{task.status="queued";}],["lease",task=>{task.leaseOwner="other";}],["handoff",task=>{task.metadata.localHandoff={id:"other"};}],["repair counter drift",task=>{task.repairIteration++;}],["reused repair extension",task=>{task.metadata.escalatedRepairHistory.push(task.metadata.escalatedRepairHistory[0]);}],["consumed history altered",task=>{task.metadata.continuationRuntimeResumeHistory=[];}],["unconsumed predecessor",task=>{task.metadata.planningScopeRecoveryHistory[0].consumed=false;}],["boundary already executable",task=>{task.metadata.planningScopeBoundary.executionAuthorized=true;}],["prior execution successor",task=>{task.metadata.executionScopeRecoveryHistory=[{consumed:true}];}],["rewrite replacement bytes",task=>{task.metadata.selfDevelopmentImplementationPlan.files[0].content+=" ";}]
])test(`execution eligibility rejects ${name}`,async()=>{const f=await fixture();await mutateTask(f,alter);await unchangedRejection(f,()=>f.describe());});

test("exact caller-selected plan hash is required",async()=>{const f=await fixture();f.input.planHash="0".repeat(64);await unchangedRejection(f,()=>f.describe(),"owner_requested_plan_hash");});
test("canonical Windows workspace spelling does not create broader authority",async()=>{const f=await fixture();f.input.workspaceProof.workspace.root="c:\\SYNTHETIC\\nova-product\\";f.input.workspaceProof.workspace.gitTopLevel="C:\\synthetic\\NOVA-PRODUCT";assert.equal((await f.describe()).approvalArguments.workspaceRoot,"c:/synthetic/nova-product");});
test("both independently resolved branch tips fail closed",async()=>{for(const branch of ["feat/nova-brain-mvp-foundation","stage13/control-plane-approved-delivery-runtime"]){const f=await fixture();f.remoteOverrides[branch]="0".repeat(40);await unchangedRejection(f,()=>f.describe(),branch.startsWith("feat/")?"live_product_tip":"runtime_transition");}});
test("a later durable execution or altered current read invalidates the boundary",async()=>{
  const f=await fixture();await f.storage.recordAutonomyStep({taskId:f.taskId,stepId:"149:apply_patch",stepType:"apply_patch",status:"completed",attempt:1});await unchangedRejection(f,()=>f.describe());
  const g=await fixture();await mutateStep(g,"132:read_files",step=>{step.result.content+=" ";});await unchangedRejection(g,()=>g.describe());
});
test("historical validation without exact no-mutation successful result cannot authorize execution",async()=>{for(const alter of [step=>{step.result.mutationApplied=true;},step=>{step.result.preMutationValidated=false;},step=>{step.result.files.pop();},step=>{step.result.planGenerationId="0".repeat(64);},step=>{step.input.arguments.files[0].content+=" ";}]){const f=await fixture();await mutateStep(f,f.validatedStepId,alter);await unchangedRejection(f,()=>f.describe());}});

test("first claim binds one new worker and cannot be reused by prior or competing processes",async()=>{
  const f=await fixture();await f.authorize();await f.recover();const task=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId),ctx=context(f,task);
  assert.equal(validateExecutionScopeContext(task,steps,ctx,CLOCK).firstBind,true);
  assert.throws(()=>validateExecutionScopeContext(task,steps,{...ctx,workerId:PLANNING_WORKER},CLOCK));
  task.metadata.executionScopeRecoveryHistory[0].workerBindingState="bound";task.metadata.executionScopeRecoveryHistory[0].workerId=WORKER;
  assert.equal(validateExecutionScopeContext(task,steps,ctx,CLOCK).firstBind,false);
  for(const value of [{workerId:PLANNING_WORKER},{runtimeVersion:"f".repeat(40)},{root:"C:/another"},{generationId:"0".repeat(64)},{repository:"other/repo"},{branch:"main"}])assert.throws(()=>validateExecutionScopeContext(task,steps,{...ctx,...value},CLOCK));
  assert.throws(()=>validateExecutionScopeContext(task,steps,ctx,()=>new Date("2026-09-16T12:15:00Z")),error=>error.safeDiagnostics.predicate==="execution_runtime_window");
});
test("eligibility never schedules a second application, unproven tests, full suite or further repair",async()=>{
  const f=await fixture();await f.authorize();await f.recover();const task=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId),record=task.metadata.executionScopeRecoveryHistory[0];
  for(const addition of [{stepId:record.applyStepId,stepType:"apply_patch",attempt:2,status:"running"},{stepId:record.testStepId,stepType:"run_focused_tests",attempt:1,status:"running"},{stepId:"151:run_full_tests",stepType:"run_full_tests",attempt:1,status:"running"}])assert.throws(()=>validateExecutionScopeEvidence(task,[...steps,{taskId:f.taskId,...addition}],CLOCK));
  const advanced=structuredClone(task);advanced.currentStep++;assert.throws(()=>validateExecutionScopeEvidence(advanced,steps,CLOCK));
  const apply={taskId:f.taskId,stepId:record.applyStepId,stepType:"apply_patch",attempt:1,status:"completed",result:{ok:true,files:f.plan.files.map(file=>file.path),taskOwnedDirtyLineage:{version:1,taskId:f.taskId,repository:f.repository,branch:f.branch,currentCommit:f.head,sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:record.applyStepId,entries:record.afterEntries.map(({path,contentHash})=>({path,contentHash}))}}};
  apply.result.executionScopeEvidence={generationId:record.activeContinuation.generationId,planHash:record.planHash,entries:record.afterEntries};
  assert.equal(validateExecutionScopeEvidence(advanced,[...steps,apply],CLOCK).apply.status,"completed");
  apply.result.taskOwnedDirtyLineage.entries[0].contentHash="0".repeat(64);assert.throws(()=>validateExecutionScopeEvidence(advanced,[...steps,apply],CLOCK),error=>error.safeDiagnostics.predicate==="complete_applied_lineage");
});
