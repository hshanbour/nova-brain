import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {createHash} from "node:crypto";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createApi} from "../src/http/api.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {createExecutionScopeFixture,executionProofSignature,EXECUTION_TEST_PATHS} from "./execution-scope-fixture.js";
import {PLANNING_PATHS,PLANNING_TOKEN} from "./planning-scope-fixture.js";

export const FULL_TEST_RUNTIME="d".repeat(40),FULL_TEST_WORKER="persistent-local-456789ab-6789-4789-8abc-def012345678";
const blobHash=content=>createHash("sha1").update(`blob ${Buffer.byteLength(content,"utf8")}\0`).update(content).digest("hex");

// The v215 fixture is produced by real planning, non-mutating validation, an
// approved byte-identical apply, and seven real focused tests. All state and
// processes belong to an isolated temporary repository/in-memory database.
export async function createFullTestScopeFixture(t,{failingFullSuite=false,dependencyFixture=false}={}){
  const base=await createExecutionScopeFixture(t,{byteIdenticalReplacements:true,sevenFocusedTests:true,fullSuite:true,failingFullSuite,dependencyFixture});
  const {taskId,ownerId,repository,branch,root,head,storage,clock,current,steps}=base;
  await base.authorize();await base.recover();await base.worker.runOnce();await base.worker.runOnce();
  const executionBoundary=await current(),priorSteps=await steps(),focused=priorSteps.find(step=>step.stepId==="150:run_focused_tests"),apply=priorSteps.find(step=>step.stepId==="149:apply_patch");
  assert.equal(executionBoundary.stateVersion,215);assert.equal(executionBoundary.status,"blocked");assert.equal(executionBoundary.currentStep,150);assert.equal(executionBoundary.currentPhase,"run_focused_tests");
  assert.equal(executionBoundary.metadata.executionScopeBoundary.kind,"focused_tests_completed");assert.equal(apply.status,"completed");assert.equal(apply.result.files.length,8);assert.deepEqual(base.beforeContents,base.afterContents,"Byte-identical replacements remain a valid durable application");
  assert.equal(focused.status,"completed");assert.equal(focused.result.exitCode,0);assert.match(focused.result.output,/tests 7/);assert.match(focused.result.output,/pass 7/);assert.match(focused.result.output,/fail 0/);
  assert.deepEqual(base.plan.focusedTests.map(test=>test.path),EXECUTION_TEST_PATHS);await base.verifyBytes(base.afterContents);
  const runtimeVersion=FULL_TEST_RUNTIME,workspaceProof={taskId,expectedVersion:215,runtimeVersion,workspace:{root,gitTopLevel:root,repository,branch,head,liveTip:head,clean:false,changedFiles:PLANNING_PATHS.map(path=>({path,hashAlgorithm:"git_sha1",hash:blobHash(base.afterContents.get(path)),contentHash:canonicalContentHash(base.afterContents.get(path))}))}};
  const input={expectedVersion:215,planHash:base.plan.planHash,runtimeVersion,workspaceProof,workspaceProofSignature:executionProofSignature(workspaceProof)},actor={actorType:"scoped_local_worker",workspaceProof},remoteOverrides={};
  const verifyRemote=async request=>({currentTip:remoteOverrides[request.branch]||(request.branch===branch?head:runtimeVersion),ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))});
  const options={...base.options,input,actor,currentCommit:runtimeVersion,runtimeVersion,verifyRemote},service=createSelfDevelopmentService(options);
  const authorize=async()=>{const before=await current(),requested=await service.requestFullTestScopeRecovery(taskId,input,actor);assert.equal(requested.approval.status,"pending");assert.deepEqual(await current(),before);await storage.decideApproval(requested.approval.id,ownerId,"approved");input.approvalId=requested.approval.id;return requested;};
  const recover=()=>service.recoverFullTestScope(taskId,input,actor),fullExecutions=[];
  const createWorker=(workerId=FULL_TEST_WORKER)=>createPersistentLocalWorker({client:base.client,root,branch,repository,runtimeVersion,workerId,registry:{async execute(name,args,context){
    assert.equal(name,"test_run_full","A full-suite successor may not apply, replan, filter or run another tool");
    const execution={name,args:structuredClone(args),context:structuredClone(context)};fullExecutions.push(execution);const result=await base.hands.execute(name,args,context);execution.result=structuredClone(result);return result;
  }}});
  const worker=createWorker(),tools={list(){return[];},async execute(){assert.fail("Owner decision cannot implicitly execute full tests");}};
  const api=createApi({agent:{tools},config:{allowedOrigins:[],maxBodyBytes:128*1024,localWorkerToken:PLANNING_TOKEN},storage,initialize:async()=>{},ownerId,selfDevelopment:service,workerRuntime:{get:current,async resumeApproval(){assert.fail("Owner decision must not resume task");},async control(){assert.fail("Owner decision must not control task");}},logger:{info(){},error(){}}});
  const post=async(path,body=input,token=PLANNING_TOKEN)=>{const req=Readable.from([JSON.stringify(body)]);req.method="POST";req.url=path;req.headers={"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})};let text="";const res={setHeader(){},end(value=""){text+=value;}};await api.handle(req,res);return{status:res.statusCode,body:JSON.parse(text)};};
  const path=suffix=>`/api/admin/self-development/tasks/${taskId}/${suffix}`;
  const claimFullTest=async(workerId=FULL_TEST_WORKER)=>{
    const task=(await base.dispatch.next({workerId,branch})).task;assert.ok(task,"An exact full-suite action must be dispatchable");
    const claimInput={workerId,runtimeVersion,repository,repositoryRoot:root,continuationGenerationId:task.continuationGenerationId,capabilities:["test_local"],expectedBranch:branch,expectedCommit:head,taskId,idempotencyKey:`${taskId}:${task.stateVersion}:${task.stepType}`};
    const claim=await base.handoff.claim(claimInput),job=claim.handoff,context={runId:taskId,stepId:job.stepId,workerId,runtimeVersion,projectId:"nova-brain",continuationGenerationId:task.continuationGenerationId,fullTestScope:job.fullTestScope,repositoryContext:{version:1,repository,root,branch,expectedHead:head,source:"persistent_worker_handoff"}};
    return{claim,claimInput,job,context,complete:result=>base.handoff.complete(job.handoffId,{taskId,workerId,idempotencyKey:claimInput.idempotencyKey,result})};
  };
  return{...base,previousExecutionRecover:base.recover,previousWorker:base.worker,executionBoundary,priorSteps,focused,apply,runtimeVersion,input,actor,options,service,authorize,recover,worker,createWorker,fullExecutions,remoteOverrides,post,path,claimFullTest};
}
