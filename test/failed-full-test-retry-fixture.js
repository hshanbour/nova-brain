import assert from "node:assert/strict";
import {mkdir,writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {Readable} from "node:stream";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createApi} from "../src/http/api.js";
import {createFullTestScopeFixture} from "./full-test-scope-fixture.js";
import {executionProofSignature} from "./execution-scope-fixture.js";
import {PLANNING_TOKEN} from "./planning-scope-fixture.js";

export const RETRY_RUNTIME="e".repeat(40),RETRY_WORKER="persistent-local-56789abc-789a-4789-8abc-def012345678";
export const FAILED_FULL_TEST_PATHS=["test/api.test.js","test/voice-benchmark.test.js","test/voice-v2-service.test.js"];
const historicalMissingDependencyOutput=["TAP version 13",...FAILED_FULL_TEST_PATHS.flatMap((path,index)=>[
  `✖ missing dependency fixture ${index+1} (${path}:1:1)`,
  "Error: Cannot find package '@neondatabase/serverless' imported from synthetic isolated workspace",
  "code: ERR_MODULE_NOT_FOUND",
]),"ℹ tests 681","ℹ pass 678","ℹ fail 3","ℹ skipped 0"].join("\n");
const isNpm=args=>args.some(arg=>arg.endsWith("npm-cli.js"))&&args.includes("test");

// Historical process output is injected ONLY at the isolated command-runner
// boundary; actual Hands parsing and worker completion durably create v219.
// The retry executes the real fixture npm suite and real cwd-local resolution of
// an inert synthetic dependency package, without network or product access.
export async function createFailedFullTestRetryFixture(t,{failingRetry=false,dependencyAvailable=true,fullSuiteTestSource}={}){
  const base=await createFullTestScopeFixture(t,{failingFullSuite:failingRetry,dependencyFixture:true,fullSuiteTestSource});
  const {taskId,ownerId,root,repository,branch,head,storage,current,steps}=base;
  let historicalRuns=0;
  base.commandHooks.before=async(file,args)=>{
    if(isNpm(args)){historicalRuns++;throw Object.assign(new Error("Synthetic historical npm dependency failure"),{code:1,stdout:historicalMissingDependencyOutput,stderr:"ERR_MODULE_NOT_FOUND: Cannot find package '@neondatabase/serverless'",signal:null});}
  };
  await base.authorize();await base.recover();await assert.rejects(()=>base.worker.runOnce(),error=>error.code==="test_failed");base.commandHooks.before=null;
  const sourceTask=await current(),sourceSteps=await steps(),sourceFailed=sourceSteps.find(step=>step.stepId==="151:run_full_tests");
  assert.equal(historicalRuns,1);assert.equal(sourceTask.stateVersion,219);assert.equal(sourceTask.status,"blocked");assert.equal(sourceTask.currentStep,151);assert.equal(sourceTask.currentPhase,"run_full_tests");assert.equal(sourceTask.repairIteration,3);assert.equal(sourceTask.metadata.fullTestScopeBoundary.kind,"product_repair_decision");assert.equal(sourceTask.metadata.fullTestScopeRecoveryHistory[0].consumed,true);
  assert.equal(sourceFailed.status,"failed");assert.equal(sourceFailed.errorCode,"test_failed");assert.deepEqual(sourceFailed.result.diagnostics.counts,{tests:681,passed:678,failed:3,skipped:0});assert.deepEqual(sourceFailed.result.diagnostics.failedFiles,FAILED_FULL_TEST_PATHS);
  const manifests=new Map(await Promise.all(["package.json","package-lock.json"].map(async path=>[path,await readFile(join(root,path),"utf8")])));
  if(dependencyAvailable){const packageRoot=join(root,"node_modules/@neondatabase/serverless");await mkdir(packageRoot,{recursive:true});await writeFile(join(packageRoot,"package.json"),JSON.stringify({name:"@neondatabase/serverless",version:"1.1.0",type:"module",exports:"./index.js"}));await writeFile(join(packageRoot,"index.js"),"export const syntheticDependencyReady = true;\n");}
  const verifyUnchanged=async()=>{await base.verifyBytes(base.afterContents);for(const[path,contents]of manifests)assert.equal(await readFile(join(root,path),"utf8"),contents);};await verifyUnchanged();
  const runtimeVersion=RETRY_RUNTIME,workspaceProof=structuredClone(base.input.workspaceProof);workspaceProof.expectedVersion=219;workspaceProof.runtimeVersion=runtimeVersion;
  const input={expectedVersion:219,planHash:base.plan.planHash,runtimeVersion,workspaceProof,workspaceProofSignature:executionProofSignature(workspaceProof)},actor={actorType:"scoped_local_worker",workspaceProof},remoteOverrides={};
  const verifyRemote=async request=>({currentTip:remoteOverrides[request.branch]||(request.branch===branch?head:runtimeVersion),ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))});
  const options={...base.options,input,actor,currentCommit:runtimeVersion,runtimeVersion,verifyRemote},service=createSelfDevelopmentService(options);
  const authorize=async()=>{const before=await current(),requested=await service.requestFailedFullTestRetry(taskId,input,actor);assert.equal(requested.approval.status,"pending");assert.deepEqual(await current(),before);await storage.decideApproval(requested.approval.id,ownerId,"approved");input.approvalId=requested.approval.id;return requested;};
  const recover=()=>service.recoverFailedFullTestRetry(taskId,input,actor),retryExecutions=[];
  const createWorker=(workerId=RETRY_WORKER)=>createPersistentLocalWorker({client:base.client,root,branch,repository,runtimeVersion,workerId,registry:{async execute(name,args,context){
    assert.equal(name,"test_run_full","Retry authority permits only a single unfiltered full-suite tool");const execution={name,args:structuredClone(args),context:structuredClone(context)};retryExecutions.push(execution);const result=await base.hands.execute(name,args,context);execution.result=structuredClone(result);return result;
  }}});
  const worker=createWorker(),tools={list(){return[];},async execute(){assert.fail("An owner decision may not execute tests");}};
  const api=createApi({agent:{tools},config:{allowedOrigins:[],maxBodyBytes:128*1024,localWorkerToken:PLANNING_TOKEN},storage,initialize:async()=>{},ownerId,selfDevelopment:service,workerRuntime:{get:current,async resumeApproval(){assert.fail("Owner decision may not resume task");},async control(){assert.fail("Owner decision may not control task");}},logger:{info(){},error(){}}});
  const post=async(path,body=input,token=PLANNING_TOKEN)=>{const req=Readable.from([JSON.stringify(body)]);req.method="POST";req.url=path;req.headers={"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})};let text="";const res={setHeader(){},end(value=""){text+=value;}};await api.handle(req,res);return{status:res.statusCode,body:JSON.parse(text)};};
  const path=suffix=>`/api/admin/self-development/tasks/${taskId}/${suffix}`;
  const claimRetry=async(workerId=RETRY_WORKER)=>{
    const task=(await base.dispatch.next({workerId,branch})).task;assert.ok(task,"An exact retry full-test action must be dispatchable");
    const claimInput={workerId,runtimeVersion,repository,repositoryRoot:root,continuationGenerationId:task.continuationGenerationId,capabilities:["test_local"],expectedBranch:branch,expectedCommit:head,taskId,idempotencyKey:`${taskId}:${task.stateVersion}:${task.stepType}`};
    const claim=await base.handoff.claim(claimInput),job=claim.handoff,context={runId:taskId,stepId:job.stepId,workerId,runtimeVersion,projectId:"nova-brain",continuationGenerationId:task.continuationGenerationId,fullTestScope:job.fullTestScope,repositoryContext:{version:1,repository,root,branch,expectedHead:head,source:"persistent_worker_handoff"}};
    return{claim,claimInput,job,context,complete:result=>base.handoff.complete(job.handoffId,{taskId,workerId,idempotencyKey:claimInput.idempotencyKey,result})};
  };
  return{...base,previousFullTestRecover:base.recover,previousFullTestWorker:base.worker,sourceTask,sourceSteps,sourceFailed,manifests,verifyUnchanged,dependencyAvailable,runtimeVersion,input,actor,options,service,authorize,recover,worker,createWorker,retryExecutions,remoteOverrides,post,path,claimRetry};
}
