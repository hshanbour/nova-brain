import test from "node:test";
import assert from "node:assert/strict";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {SOURCE_BOUND_REVIEW_REPLAN_CLASS,REJECTED_REVIEW_PLAN_CONTINUATION_CLASS,REVIEW_REMEDIATION_CLASS} from "../src/autonomy/review-remediation-scope.js";

const repository="hshanbour/nova-brain",branch="feat/nova-brain-mvp-foundation",root="C:/synthetic/source-bound-review",runtimeVersion="a".repeat(40),head="b".repeat(40),workerId="persistent-local-12345678-1234-4234-8234-123456789abc",generation="c".repeat(64);
const scope={recoveryClass:SOURCE_BOUND_REVIEW_REPLAN_CLASS,taskId:"synthetic-source-bound-review",repository,branch,currentCommit:head,workspaceRoot:root,runtimeVersion,workerId,continuationGenerationId:generation,readStepIds:Array.from({length:8},(_,index)=>`${179+index}:read_files`),planStepId:"187:plan_repair",validateStepId:"188:validate_patch",applyStepId:"189:apply_patch",focusedStepId:"190:run_focused_tests",fullTestStepId:"191:run_full_tests"};

function fixture({alter=job=>job,stepType="read_files",tool="repo_read_task_owned_local",stepId=scope.readStepIds[0]}={}){
  const calls=[],task={id:scope.taskId,branch,expectedCommit:head,stateVersion:280,mode:"local_handoff",stepType,continuationGenerationId:generation,reviewRemediationScopeRequired:true,reviewRemediationRecoveryClass:SOURCE_BOUND_REVIEW_REPLAN_CLASS};
  const worker=createPersistentLocalWorker({repository,branch,root,runtimeVersion,workerId,client:{async request(path){if(path.endsWith("/next"))return{dispatched:true,task};if(path.endsWith("/claim"))return{claimed:true,handoff:alter({handoffId:"bounded-source-review",taskId:task.id,branch,expectedCommit:head,stepType,stepId,tool,arguments:{reviewRemediationScope:{recoveryClass:REJECTED_REVIEW_PLAN_CONTINUATION_CLASS,workerId:"untrusted-argument"}},reviewRemediationScope:structuredClone(scope)})};return{status:"queued"};}},registry:{async execute(name,input,context){calls.push({name,input,context});return{ok:true};}}});
  return{worker,calls};
}

for(const [stepType,tool,stepId] of [["read_files","repo_read_task_owned_local",scope.readStepIds[0]],["validate_patch","repo_validate_patch",scope.validateStepId],["apply_patch","repo_apply_patch",scope.applyStepId],["run_focused_tests","test_run",scope.focusedStepId],["run_full_tests","test_run_full",scope.fullTestStepId]])test(`source-bound replan transports exact ${stepType} authority independently of predecessor scopes`,async()=>{
  const f=fixture({stepType,tool,stepId});await f.worker.runOnce();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].context.reviewRemediationScope,scope);assert.notDeepEqual(f.calls[0].context.reviewRemediationScope,f.calls[0].input.reviewRemediationScope);assert.equal(f.calls[0].context.executionScope,undefined);assert.equal(f.calls[0].context.fullTestScope,undefined);
});

for(const [name,alter] of [
  ["missing scope",job=>({...job,reviewRemediationScope:undefined})],
  ["missing class",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,recoveryClass:undefined}})],
  ["consumed v251 predecessor",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,recoveryClass:REJECTED_REVIEW_PLAN_CONTINUATION_CLASS}})],
  ["consumed v223 predecessor",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,recoveryClass:REVIEW_REMEDIATION_CLASS}})],
  ["unknown class",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,recoveryClass:"unrestricted_replan"}})],
  ["old execution scope",job=>({...job,executionScope:{taskId:scope.taskId}})],
  ["old full-test scope",job=>({...job,fullTestScope:{taskId:scope.taskId}})],
  ["push authority",job=>({...job,approvedDelivery:{approved:true}})],
  ["wrong task",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,taskId:"another-task"}})],
  ["wrong repository",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,repository:"other/repository"}})],
  ["wrong branch",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,branch:"main"}})],
  ["wrong workspace",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,workspaceRoot:root+"/different"}})],
  ["wrong product HEAD",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,currentCommit:runtimeVersion}})],
  ["wrong runtime",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,runtimeVersion:head}})],
  ["prior generation",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,continuationGenerationId:"d".repeat(64)}})],
  ["prior worker",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,workerId:"persistent-local-98765432-1234-4234-8234-123456789abc"}})],
  ["prior phase",job=>({...job,stepId:"166:read_files"})],
])test(`source-bound replan rejects ${name} before Hands`,async()=>{
  const f=fixture({alter});await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="invalid_handoff");assert.equal(f.calls.length,0);
});
