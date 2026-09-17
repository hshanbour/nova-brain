import test from "node:test";
import assert from "node:assert/strict";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";

const repository="hshanbour/nova-brain",branch="feat/nova-brain-mvp-foundation",root="C:/synthetic/full-test",runtimeVersion="a".repeat(40),head="b".repeat(40),workerId="persistent-local-12345678-1234-4234-8234-123456789abc",generation="c".repeat(64);
const scope={taskId:"synthetic-full-test",repository,branch,currentCommit:head,workspaceRoot:root,runtimeVersion,workerId,continuationGenerationId:generation,fullTestStepId:"151:run_full_tests"};
function fixture(alter=value=>value){
  const calls=[],task={id:scope.taskId,branch,expectedCommit:head,stateVersion:216,mode:"local_handoff",stepType:"run_full_tests",continuationGenerationId:generation,fullTestScopeRequired:true};
  const worker=createPersistentLocalWorker({repository,branch,root,runtimeVersion,workerId,client:{async request(path){if(path.endsWith("/next"))return{dispatched:true,task};if(path.endsWith("/claim"))return{claimed:true,handoff:alter({handoffId:"bounded-full",taskId:task.id,branch,expectedCommit:head,stepType:"run_full_tests",stepId:scope.fullTestStepId,tool:"test_run_full",arguments:{},fullTestScope:structuredClone(scope)})};return{status:"blocked"};}},registry:{async execute(tool,input,context){calls.push({tool,input,context});return{ok:true};}}});
  return{worker,calls};
}
test("persistent full-test worker carries only the exact full-test context",async()=>{
  const f=fixture();await f.worker.runOnce();assert.equal(f.calls.length,1);assert.equal(f.calls[0].tool,"test_run_full");assert.deepEqual(f.calls[0].input,{});assert.deepEqual(f.calls[0].context.fullTestScope,scope);assert.equal(f.calls[0].context.executionScope,undefined);
});
for(const [name,alter] of [
  ["stripped authority",job=>({...job,fullTestScope:undefined})],
  ["old execution authority",job=>({...job,executionScope:{taskId:scope.taskId}})],
  ["apply tool",job=>({...job,tool:"repo_apply_patch",stepType:"apply_patch"})],
  ...Object.entries({taskId:"wrong",repository:"wrong/repo",branch:"main",currentCommit:"d".repeat(40),workspaceRoot:"C:/other",runtimeVersion:"e".repeat(40),workerId:"another",continuationGenerationId:"f".repeat(64),fullTestStepId:"152:run_full_tests"}).map(([key,value])=>[key,job=>({...job,fullTestScope:{...job.fullTestScope,[key]:value}})])
])test(`persistent full-test worker rejects ${name} before a tool invocation`,async()=>{const f=fixture(alter);await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="invalid_handoff");assert.equal(f.calls.length,0);});
