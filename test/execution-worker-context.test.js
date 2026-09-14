import test from "node:test";
import assert from "node:assert/strict";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";

const repository="hshanbour/nova-brain",branch="feat/nova-brain-mvp-foundation",root="C:/synthetic/execution",runtimeVersion="a".repeat(40),head="b".repeat(40),workerId="persistent-local-12345678-1234-4234-8234-123456789abc",generation="c".repeat(64);
const scope={taskId:"synthetic-execution-task",repository,branch,currentCommit:head,workspaceRoot:root,runtimeVersion,workerId,continuationGenerationId:generation,applyStepId:"149:apply_patch",testStepId:"150:run_focused_tests"};

function fixture({alter=value=>value,stepType="apply_patch",args={files:[]}}={}){
  const requests=[],executions=[],task={id:scope.taskId,branch,expectedCommit:head,stateVersion:209,mode:"local_handoff",stepType,continuationGenerationId:generation,executionScopeRequired:true};
  const client={async request(path,input){requests.push({path,input});if(path.endsWith("/next"))return{dispatched:true,task};if(path.endsWith("/claim"))return{claimed:true,handoff:{handoffId:"synthetic-handoff",taskId:task.id,branch,expectedCommit:head,stepType,stepId:stepType==="apply_patch"?scope.applyStepId:scope.testStepId,tool:stepType==="apply_patch"?"repo_apply_patch":"test_run",arguments:args,executionScope:alter(structuredClone(scope))}};return{status:"blocked"};}};
  const worker=createPersistentLocalWorker({client,repository,branch,root,runtimeVersion,workerId,registry:{async execute(tool,input,context){executions.push({tool,input,context});return{ok:true};}}});
  return{worker,requests,executions};
}

test("persistent worker carries exact server execution authority separately from arbitrary tool arguments",async()=>{
  const f=fixture({args:{files:[],executionScope:{runtimeVersion:"forged"}}});
  await f.worker.runOnce();
  assert.equal(f.executions.length,1);
  assert.deepEqual(f.executions[0].context.executionScope,scope);
  assert.equal(f.executions[0].context.runtimeVersion,runtimeVersion);
  assert.equal(f.executions[0].context.continuationGenerationId,generation);
  assert.equal(f.executions[0].context.stepId,scope.applyStepId);
  assert.notDeepEqual(f.executions[0].context.executionScope,f.executions[0].input.executionScope);
});

test("persistent worker carries exact focused-test successor identity",async()=>{
  const f=fixture({stepType:"run_focused_tests"});await f.worker.runOnce();
  assert.equal(f.executions[0].tool,"test_run");
  assert.equal(f.executions[0].context.stepId,scope.testStepId);
  assert.deepEqual(f.executions[0].context.executionScope,scope);
});

test("persistent worker rejects a stripped required execution scope before focused tests",async()=>{
  const f=fixture({stepType:"run_focused_tests",alter:()=>undefined});
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="invalid_handoff");
  assert.equal(f.executions.length,0);
});

for(const [field,value] of Object.entries({taskId:"another-task",repository:"another/repo",branch:"main",currentCommit:"d".repeat(40),workspaceRoot:"C:/other",runtimeVersion:"e".repeat(40),workerId:"persistent-local-87654321-1234-4234-8234-123456789abc",continuationGenerationId:"f".repeat(64),applyStepId:"150:apply_patch"}))test(`persistent worker rejects changed execution ${field} before tool execution`,async()=>{
  const f=fixture({alter:input=>({...input,[field]:value})});
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="invalid_handoff");
  assert.equal(f.executions.length,0);
  assert.equal(f.requests.some(item=>item.path.endsWith("/complete")),false);
});
