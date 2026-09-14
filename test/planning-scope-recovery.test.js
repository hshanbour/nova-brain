import test from "node:test";
import assert from "node:assert/strict";
import {recoverFailedLocalRead} from "../src/autonomy/failed-local-read-recovery.js";
import {describePlanningScopeRecovery,recoverPlanningScope,validatePlanningScopeReadEvidence,validatePlanningScopeContext,PLANNING_SCOPE_RECOVERY_CLASS} from "../src/autonomy/planning-scope-recovery.js";
import {seedPlanningRecoveryFixture,PLANNING_PATHS,PLANNING_WORKER,PLANNING_OLD_WORKER,PLANNING_CLOCK} from "./planning-scope-fixture.js";

async function unchangedRejection(f,operation,predicate){
  const before=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId);
  await assert.rejects(operation,error=>error.code==="planning_scope_recovery_precondition_failed"&&(!predicate||error.safeDiagnostics?.predicate===predicate));
  assert.deepEqual(await f.runtime.get(f.taskId),before);
  assert.deepEqual(await f.runtime.steps(f.taskId),steps);
}
async function alterStep(f,stepId,alter){const step=(await f.runtime.steps(f.taskId)).find(item=>item.stepId===stepId);alter(step);await f.storage.updateAutonomyStep(f.taskId,stepId,step);}
async function alterTask(f,alter){const current=await f.runtime.get(f.taskId);alter(current);const next=await f.storage.updateAutonomyTask(f.taskId,f.ownerId,current,current.stateVersion);f.input.expectedVersion=next.stateVersion;f.input.workspaceProof.expectedVersion=next.stateVersion;return next;}

test("real v201-shaped rejected planning receives one separately approved planning-only successor with current eight reads",async()=>{
  const f=await seedPlanningRecoveryFixture(),before=await f.runtime.get(f.taskId),stepsBefore=await f.runtime.steps(f.taskId);
  const described=await f.describe();assert.equal(described.task.stateVersion,201);assert.equal(described.readProofs.length,8);
  assert.equal(described.approvalArguments.maxProductMutations,0);assert.equal(described.approvalArguments.maxAdditionalAttempts,0);
  assert.deepEqual(await f.runtime.get(f.taskId),before,"eligibility is read-only");
  await f.authorize();const result=await f.recover(),after=await f.runtime.get(f.taskId),record=result.recovery;
  assert.equal(after.stateVersion,202);assert.equal(after.status,"queued");assert.equal(after.currentPhase,"plan_repair");
  assert.equal(record.recoveryClass,PLANNING_SCOPE_RECOVERY_CLASS);assert.notEqual(record.activeContinuation.generationId,before.metadata.activeContinuation.generationId);
  assert.equal(record.activeContinuation.maxSteps,2);assert.equal(record.activeContinuation.runtimeMinutes,15);assert.equal(record.activeContinuation.runtimeDeadline,"2026-09-15T12:15:00.000Z");
  assert.equal(record.workerId,null);assert.equal(record.workerBindingState,"awaiting_worker_bind");assert.equal(record.authorizationConsumed,true);
  assert.deepEqual(after.metadata.steps.slice(after.currentStep).map(step=>[step.type,step.input.tool]),[["plan_repair","self_development_plan_implementation"],["validate_patch","repo_validate_patch"]]);
  for(const key of ["failedLocalReadRecoveryHistory","continuationRuntimeResumeHistory","implementationPlanRecoveryHistory","partialRepairPlanRecoveryHistory","escalatedRepairHistory"])assert.deepEqual(after.metadata[key],before.metadata[key]);
  for(const key of ["repairIteration","retryCount","maxRetries","branch","currentCommit","startingCommit"])assert.equal(after[key],before[key]);
  assert.deepEqual(await f.runtime.steps(f.taskId),stepsBefore,"no product tool or historical execution is invoked/replaced");
  const evidence=validatePlanningScopeReadEvidence(after,stepsBefore,PLANNING_CLOCK);
  assert.deepEqual(evidence.reads,f.contents,"current complete contents override no evidence and are not historical plan strings");
  assert.deepEqual(evidence.record.requiredPaths,PLANNING_PATHS);assert.equal(evidence.record.requiredPaths.length,8);
});

test("signed worker evidence without a separate exact owner approval cannot consume planning recovery",async()=>{
  const f=await seedPlanningRecoveryFixture();await unchangedRejection(f,()=>f.recover(),"exact_owner_approval");
});
for(const [name,alter] of [
  ["pending",approval=>{approval.status="pending";}],
  ["another owner",approval=>{approval.ownerId="another-owner";}],
  ["another task",approval=>{approval.runId="another-task";}],
  ["another tool",approval=>{approval.tool="self_development_escalated_repair";}],
  ["broader attempt",approval=>{approval.arguments.maxAdditionalAttempts=1;}],
  ["mutation authority",approval=>{approval.arguments.maxProductMutations=1;}],
  ["different proof",approval=>{approval.arguments.workspaceProofHash="0".repeat(64);}]
])test(`planning recovery rejects ${name} owner decision`,async()=>{
  const f=await seedPlanningRecoveryFixture();await f.authorize();const getApproval=f.options.storage.getApproval.bind(f.storage);
  f.options.storage={...f.storage,getApproval:async(id,owner)=>{const approval=await getApproval(id,owner);if(id===f.input.approvalId)alter(approval);return approval;}};
  await unchangedRejection(f,()=>recoverPlanningScope(f.options),"exact_owner_approval");
});

for(const [name,alter] of [
  ["wrong task",proof=>{proof.taskId="another-task";}],
  ["wrong version",proof=>{proof.expectedVersion=200;}],
  ["wrong repository",proof=>{proof.workspace.repository="another/repository";}],
  ["wrong branch",proof=>{proof.workspace.branch="another-branch";}],
  ["wrong root",proof=>{proof.workspace.root+="/other";}],
  ["wrong top-level",proof=>{proof.workspace.gitTopLevel+="/other";}],
  ["wrong product HEAD",proof=>{proof.workspace.head="2".repeat(40);} ],
  ["wrong live tip",proof=>{proof.workspace.liveTip="2".repeat(40);} ],
  ["wrong runtime",proof=>{proof.runtimeVersion="2".repeat(40);} ],
  ["canonical hash drift",proof=>{proof.workspace.changedFiles[0].contentHash="0".repeat(64);} ],
  ["byte-only hash drift",proof=>{proof.workspace.changedFiles[0].hash="0".repeat(40);} ],
  ["missing dirty file",proof=>{proof.workspace.changedFiles.pop();}],
  ["unrelated ninth dirty file",proof=>{proof.workspace.changedFiles.push({...proof.workspace.changedFiles[0],path:"test/console-client.test.js"});}],
  ["duplicate dirty entry",proof=>{proof.workspace.changedFiles[1]=proof.workspace.changedFiles[0];}],
])test(`planning recovery rejects ${name} without task or product mutation`,async()=>{
  const f=await seedPlanningRecoveryFixture();alter(f.input.workspaceProof);await unchangedRejection(f,()=>f.describe());
});

test("canonical Windows root case and separators do not fabricate a different workspace",async()=>{
  const f=await seedPlanningRecoveryFixture();f.input.workspaceProof.workspace.root="c:\\SYNTHETIC\\nova-product\\";f.input.workspaceProof.workspace.gitTopLevel="C:\\synthetic\\NOVA-PRODUCT";
  const result=await f.describe();assert.equal(result.approvalArguments.workspaceRoot,"c:/synthetic/nova-product");
});

for(const [name,stepId,alter] of [
  ["incomplete read","132:read_files",step=>{step.result.truncated=true;}],
  ["stale read bytes","132:read_files",step=>{step.result.content="/* obsolete historical plan */\n";}],
  ["read owned by another task","132:read_files",step=>{step.taskId="another-task";}],
  ["historical remote evidence","132:read_files",step=>{step.input.tool="repo_read";}],
  ["wrong local-read generation","132:read_files",step=>{step.input.arguments.binding.continuationGenerationId="0".repeat(64);} ],
  ["wrong local-read runtime","132:read_files",step=>{step.input.arguments.binding.runtimeVersion="0".repeat(40);} ],
  ["wrong local-read source plan","132:read_files",step=>{step.input.arguments.binding.sourcePlanStepId="26:plan_repair";}],
  ["wrong local-read source apply","132:read_files",step=>{step.input.arguments.binding.sourceApplyStepId="27:apply_patch";}],
  ["arbitrary scope violation","140:plan_repair",step=>{step.result.diagnostics.classification="protected";}],
  ["missing rejection issue","140:plan_repair",step=>{step.result.diagnostics.validationIssues=[];}],
  ["mixed failure classes","140:plan_repair",step=>{step.result.diagnostics.validationIssues.push("another_scope_problem");}],
  ["accepted plan","140:plan_repair",step=>{step.status="completed";}],
  ["second failed planning attempt","140:plan_repair",step=>{step.attempt=2;}],
  ["broader editable candidate set","140:plan_repair",step=>{step.input.arguments.candidatePaths.push("test/console-client.test.js");}],
  ["different repair lineage","140:plan_repair",step=>{step.input.arguments.failureEvidence.sourceApplyStepId="27:apply_patch";}],
  ["unproven product mutation","140:plan_repair",step=>{step.result.mutationApplied=true;}],
  ["missing complete dirty lineage","80:apply_patch",step=>{step.result.taskOwnedDirtyLineage.entries.pop();}],
  ["wrong latest apply repository","80:apply_patch",step=>{step.result.taskOwnedDirtyLineage.repository="another/repository";}]
])test(`planning recovery rejects ${name}`,async()=>{
  const f=await seedPlanningRecoveryFixture();await alterStep(f,stepId,alter);await unchangedRejection(f,()=>f.describe());
});

for(const [name,alter] of [
  ["ineligible terminal phase",task=>{task.currentPhase="apply_patch";}],
  ["active lease",task=>{task.leaseOwner="worker";}],
  ["pending handoff",task=>{task.metadata.localHandoff={id:"pending"};}],
  ["changed repair iteration",task=>{task.repairIteration=4;}],
  ["second repair extension",task=>{task.metadata.escalatedRepairHistory.push(task.metadata.escalatedRepairHistory[0]);}],
  ["missing prior renewal",task=>{task.metadata.continuationRuntimeResumeHistory=[];}],
  ["future predecessor window",task=>{task.metadata.activeContinuation.runtimeDeadline="2027-01-01T00:00:00.000Z";}],
  ["broader planned candidate set",task=>{task.metadata.steps[139].input.arguments.candidatePaths.push("test/console-client.test.js");}],
  ["prior planning recovery",task=>{task.metadata.planningScopeRecoveryHistory=[{maxRecoveries:1}];}]
])test(`planning recovery rejects ${name}`,async()=>{
  const f=await seedPlanningRecoveryFixture();await alterTask(f,alter);await unchangedRejection(f,()=>f.describe());
});

test("later durable task execution blocks v201 recovery before any write",async()=>{
  const f=await seedPlanningRecoveryFixture();await f.storage.recordAutonomyStep({taskId:f.taskId,stepId:"141:apply_patch",stepType:"apply_patch",status:"completed",attempt:1,operationFingerprint:"0".repeat(64),result:{files:PLANNING_PATHS}});
  await unchangedRejection(f,()=>f.describe(),"failed_planning_execution");
});
test("server independently verifies both product and runtime tips",async()=>{
  for(const branch of ["feat/nova-brain-mvp-foundation","stage13/control-plane-approved-delivery-runtime"]){const f=await seedPlanningRecoveryFixture();f.remoteOverrides[branch]="0".repeat(40);await unchangedRejection(f,()=>f.describe(),branch.startsWith("feat/")?"live_product_tip":"runtime_transition");}
});

test("neither the used local-read recovery nor the new planning continuation can be replayed",async()=>{
  const f=await seedPlanningRecoveryFixture();await assert.rejects(()=>recoverFailedLocalRead({...f.options,input:{...f.input,expectedVersion:174,workspaceProof:{...f.input.workspaceProof,expectedVersion:174}},actor:{...f.actor,workspaceProof:{...f.input.workspaceProof,expectedVersion:174}}}),error=>error.code==="failed_local_read_recovery_precondition_failed");
  await f.authorize();await f.recover();await unchangedRejection(f,()=>f.recover());
});

test("current read evidence survives PostgreSQL object key order without accepting changed bytes",async()=>{
  const f=await seedPlanningRecoveryFixture();await f.authorize();await f.recover();const task=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId);
  const reorder=value=>Array.isArray(value)?value.map(reorder):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
  assert.deepEqual(validatePlanningScopeReadEvidence(reorder(task),reorder(steps),PLANNING_CLOCK).reads,f.contents);
  steps.find(step=>step.stepId==="132:read_files").result.content+=" ";
  assert.throws(()=>validatePlanningScopeReadEvidence(task,steps,PLANNING_CLOCK),error=>error.safeDiagnostics.predicate==="immutable_source_step");
});

test("only one fresh bound worker can validate the read-backed planning generation",async()=>{
  const f=await seedPlanningRecoveryFixture();await f.authorize();await f.recover();let task=await f.runtime.get(f.taskId);const steps=await f.runtime.steps(f.taskId);
  const context={runtimeVersion:f.runtimeVersion,generationId:task.metadata.activeContinuation.generationId,repository:f.repository,branch:f.branch,root:f.root,workerId:PLANNING_WORKER,allowFirstBind:true};
  assert.equal(validatePlanningScopeContext(task,steps,context,PLANNING_CLOCK).firstBind,true);
  assert.throws(()=>validatePlanningScopeContext(task,steps,{...context,workerId:PLANNING_OLD_WORKER},PLANNING_CLOCK),error=>error.safeDiagnostics.predicate==="worker_succession");
  task.metadata.planningScopeRecoveryHistory[0].workerId=PLANNING_WORKER;task.metadata.planningScopeRecoveryHistory[0].workerBindingState="bound";
  assert.equal(validatePlanningScopeContext(task,steps,context,PLANNING_CLOCK).firstBind,false);
  assert.throws(()=>validatePlanningScopeContext(task,steps,{...context,workerId:"persistent-local-33333333-4444-4555-8666-777777777777"},PLANNING_CLOCK),error=>error.safeDiagnostics.predicate==="worker_succession");
});

test("expired, consumed or rewritten successor plans cannot reuse read authority",async()=>{
  const f=await seedPlanningRecoveryFixture();await f.authorize();await f.recover();const task=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId);
  assert.throws(()=>validatePlanningScopeReadEvidence(task,steps,()=>new Date("2026-09-15T12:15:00.000Z")),error=>error.safeDiagnostics.predicate==="successor_runtime_window");
  for(const alter of [value=>{value.metadata.planningScopeRecoveryHistory[0].consumed=true;},value=>{value.currentStep+=2;},value=>{value.metadata.steps[value.currentStep+1].input.tool="repo_apply_patch";},value=>{value.metadata.steps.push({type:"push"});}]){
    const changed=structuredClone(task);alter(changed);assert.throws(()=>validatePlanningScopeReadEvidence(changed,steps,PLANNING_CLOCK),error=>error.code==="planning_scope_recovery_precondition_failed");
  }
});
