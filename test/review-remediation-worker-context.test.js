import test from "node:test";
import assert from "node:assert/strict";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";

const repository="hshanbour/nova-brain",branch="feat/nova-brain-mvp-foundation",root="C:/synthetic/review-remediation",runtimeVersion="a".repeat(40),head="b".repeat(40),workerId="persistent-local-12345678-1234-4234-8234-123456789abc",generation="c".repeat(64);
const scope={taskId:"synthetic-review",repository,branch,currentCommit:head,workspaceRoot:root,runtimeVersion,workerId,continuationGenerationId:generation,readStepIds:Array.from({length:8},(_,index)=>`${153+index}:read_files`),planStepId:"161:plan_repair",validateStepId:"162:validate_patch",applyStepId:"163:apply_patch",focusedStepId:"164:run_focused_tests",fullTestStepId:"165:run_full_tests"};
function fixture({alter=job=>job,stepType="read_files",tool="repo_read_task_owned_local",stepId=scope.readStepIds[0]}={}){
  const calls=[],task={id:scope.taskId,branch,expectedCommit:head,stateVersion:224,mode:"local_handoff",stepType,continuationGenerationId:generation,reviewRemediationScopeRequired:true};
  const worker=createPersistentLocalWorker({repository,branch,root,runtimeVersion,workerId,client:{async request(path){if(path.endsWith("/next"))return{dispatched:true,task};if(path.endsWith("/claim"))return{claimed:true,handoff:alter({handoffId:"bounded-review",taskId:task.id,branch,expectedCommit:head,stepType,stepId,tool,arguments:{reviewRemediationScope:{workerId:"forged"}},reviewRemediationScope:structuredClone(scope)})};return{status:"queued"};}},registry:{async execute(name,input,context){calls.push({name,input,context});return{ok:true};}}});
  return{worker,calls};
}

for(const [stepType,tool,stepId] of [["read_files","repo_read_task_owned_local",scope.readStepIds[0]],["validate_patch","repo_validate_patch",scope.validateStepId],["apply_patch","repo_apply_patch",scope.applyStepId],["run_focused_tests","test_run",scope.focusedStepId],["run_full_tests","test_run_full",scope.fullTestStepId]])test(`review remediation carries exact ${stepType} authority independently of tool arguments`,async()=>{
  const f=fixture({stepType,tool,stepId});await f.worker.runOnce();assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].context.reviewRemediationScope,scope);assert.notDeepEqual(f.calls[0].context.reviewRemediationScope,f.calls[0].input.reviewRemediationScope);assert.equal(f.calls[0].context.executionScope,undefined);assert.equal(f.calls[0].context.fullTestScope,undefined);
});

for(const [name,alter] of [
  ["missing authority",job=>({...job,reviewRemediationScope:undefined})],
  ["old execution authority",job=>({...job,executionScope:{taskId:scope.taskId}})],
  ["old full-test authority",job=>({...job,fullTestScope:{taskId:scope.taskId}})],
  ...Object.entries({taskId:"wrong",repository:"wrong/repo",branch:"main",currentCommit:"d".repeat(40),workspaceRoot:"C:/other",runtimeVersion:"e".repeat(40),workerId:"another",continuationGenerationId:"f".repeat(64)}).map(([key,value])=>[key,job=>({...job,reviewRemediationScope:{...job.reviewRemediationScope,[key]:value}})]),
  ["wrong phase",job=>({...job,stepId:scope.applyStepId})],
  ["delivery",job=>({...job,stepType:"push",tool:"git_push"})],
])test(`review remediation rejects ${name} before invoking Hands`,async()=>{
  const f=fixture({alter});await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="invalid_handoff");assert.equal(f.calls.length,0);
});
