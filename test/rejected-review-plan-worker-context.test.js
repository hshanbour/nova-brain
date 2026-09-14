import test from "node:test";
import assert from "node:assert/strict";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {REJECTED_REVIEW_PLAN_CONTINUATION_CLASS,REVIEW_REMEDIATION_CLASS} from "../src/autonomy/review-remediation-scope.js";

const repository="hshanbour/nova-brain",branch="feat/nova-brain-mvp-foundation",root="C:/synthetic/rejected-review-plan",runtimeVersion="a".repeat(40),head="b".repeat(40),workerId="persistent-local-12345678-1234-4234-8234-123456789abc",generation="c".repeat(64);
const scope={recoveryClass:REJECTED_REVIEW_PLAN_CONTINUATION_CLASS,taskId:"synthetic-rejected-review",repository,branch,currentCommit:head,workspaceRoot:root,runtimeVersion,workerId,continuationGenerationId:generation,readStepIds:Array.from({length:8},(_,index)=>`${166+index}:read_files`),planStepId:"174:plan_repair",validateStepId:"175:validate_patch",applyStepId:"176:apply_patch",focusedStepId:"177:run_focused_tests",fullTestStepId:"178:run_full_tests"};

function fixture({alter=job=>job,stepType="read_files",tool="repo_read_task_owned_local",stepId=scope.readStepIds[0]}={}){
  const calls=[],task={id:scope.taskId,branch,expectedCommit:head,stateVersion:252,mode:"local_handoff",stepType,continuationGenerationId:generation,reviewRemediationScopeRequired:true,reviewRemediationRecoveryClass:REJECTED_REVIEW_PLAN_CONTINUATION_CLASS};
  const worker=createPersistentLocalWorker({repository,branch,root,runtimeVersion,workerId,client:{async request(path){if(path.endsWith("/next"))return{dispatched:true,task};if(path.endsWith("/claim"))return{claimed:true,handoff:alter({handoffId:"bounded-rejected-review",taskId:task.id,branch,expectedCommit:head,stepType,stepId,tool,arguments:{reviewRemediationScope:{recoveryClass:REVIEW_REMEDIATION_CLASS,workerId:"forged"}},reviewRemediationScope:structuredClone(scope)})};return{status:"queued"};}},registry:{async execute(name,input,context){calls.push({name,input,context});return{ok:true};}}});
  return{worker,calls};
}

for(const [stepType,tool,stepId] of [["read_files","repo_read_task_owned_local",scope.readStepIds[0]],["validate_patch","repo_validate_patch",scope.validateStepId],["apply_patch","repo_apply_patch",scope.applyStepId],["run_focused_tests","test_run",scope.focusedStepId],["run_full_tests","test_run_full",scope.fullTestStepId]])test(`rejected-review continuation carries exact ${stepType} class without reusing predecessor context`,async()=>{
  const f=fixture({stepType,tool,stepId});await f.worker.runOnce();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].context.reviewRemediationScope,scope);assert.notDeepEqual(f.calls[0].context.reviewRemediationScope,f.calls[0].input.reviewRemediationScope);assert.equal(f.calls[0].context.executionScope,undefined);assert.equal(f.calls[0].context.fullTestScope,undefined);
});

for(const [name,alter] of [
  ["missing new-class authority",job=>({...job,reviewRemediationScope:undefined})],
  ["missing class",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,recoveryClass:undefined}})],
  ["consumed predecessor class",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,recoveryClass:REVIEW_REMEDIATION_CLASS}})],
  ["unknown class",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,recoveryClass:"unbounded_remediation"}})],
  ["old execution scope",job=>({...job,executionScope:{taskId:scope.taskId}})],
  ["old full-test scope",job=>({...job,fullTestScope:{taskId:scope.taskId}})],
  ["prior generation",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,continuationGenerationId:"d".repeat(64)}})],
  ["prior worker",job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,workerId:"persistent-local-98765432-1234-4234-8234-123456789abc"}})],
])test(`rejected-review continuation rejects ${name} before Hands`,async()=>{
  const f=fixture({alter});await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="invalid_handoff");assert.equal(f.calls.length,0);
});
