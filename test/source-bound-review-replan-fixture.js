import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createSelfDevelopmentImplementationPlanner} from "../src/autonomy/self-development-implementation-planner.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createApi} from "../src/http/api.js";
import {createRejectedReviewPlanFixture,assertRejectedReviewHistoriesPreserved} from "./rejected-review-plan-fixture.js";
import {executionProofSignature,EXECUTION_TEST_PATHS} from "./execution-scope-fixture.js";
import {PLANNING_PATHS,PLANNING_TOKEN} from "./planning-scope-fixture.js";

export const SOURCE_BOUND_RUNTIME="2".repeat(40);
export const SOURCE_BOUND_WORKER="persistent-local-89abcdef-abcd-4abc-8bcd-ef0123456789";
export const SOURCE_BOUND_CLASS="owner_approved_source_bound_review_replan";
export const SOURCE_BOUND_HISTORY="sourceBoundReviewReplanHistory";
export const SOURCE_BOUND_BOUNDARY="sourceBoundReviewReplanBoundary";

export function assertSourceBoundHistoriesPreserved(before,after){
  assertRejectedReviewHistoriesPreserved(before,after);
  assert.deepEqual(after.metadata.rejectedReviewPlanContinuationHistory,before.metadata.rejectedReviewPlanContinuationHistory);
  assert.deepEqual(after.metadata.rejectedReviewPlanContinuationBoundary,before.metadata.rejectedReviewPlanContinuationBoundary);
}

// Build the source through actual prior planner/worker/Hands execution. The
// rejected proposal uses one voice mutation and four unchanged test files, so
// its five unique mappings cannot bind to their proposed test source. These
// isolated toy programs are infrastructure probes, never a Nova product plan.
export async function createSourceBoundReviewReplanSourceFixture(t,options={}){
  let sourceRejectedPlan;
  const base=await createRejectedReviewPlanFixture(t,{...options,output:value=>{
    sourceRejectedPlan={...value,files:value.files.filter(file=>file.path==="assets/voice-input.js"),acceptanceMapping:value.acceptanceMapping.map(item=>({...item,files:["assets/voice-input.js"]}))};
    return sourceRejectedPlan;
  }});
  await base.authorize();await base.recover();await base.runSteps(9);
  const sourceTask=await base.current(),sourceSteps=await base.steps(),rejected=sourceSteps.find(step=>step.stepId==="174:plan_repair"),reads=sourceSteps.filter(step=>Number.parseInt(step.stepId,10)>=166&&Number.parseInt(step.stepId,10)<=173);
  assert.equal(sourceTask.stateVersion,279);assert.equal(sourceTask.status,"blocked");assert.equal(sourceTask.currentPhase,"read_files");assert.equal(sourceTask.currentStep,173);assert.equal(sourceTask.repairIteration,3);assert.equal(sourceTask.errorCode,"review_remediation_precondition_failed");
  assert.equal(rejected.status,"failed");assert.equal(rejected.attempt,1);assert.equal(rejected.result.diagnostics.predicate,"source_bound_behavioral_coverage");assert.equal(rejected.result.diagnostics.mutationApplied,false);assert.equal(sourceTask.metadata.rejectedReviewPlanContinuationHistory[0].consumed,true);assert.equal(sourceTask.metadata.rejectedReviewPlanContinuationBoundary.executionAuthorized,false);assert.equal(reads.length,8);assert.ok(reads.every(step=>step.status==="completed"));
  assert.deepEqual(sourceRejectedPlan.files.map(file=>file.path),["assets/voice-input.js"]);assert.deepEqual(sourceRejectedPlan.focusedTests.map(item=>item.path),EXECUTION_TEST_PATHS);assert.equal(sourceRejectedPlan.reviewCoverage.length,5);assert.equal(new Set(sourceRejectedPlan.reviewCoverage.map(item=>item.constraintId)).size,5);assert.equal(base.executions.some(item=>item.name==="repo_apply_patch"),false);await base.verifySourceUnchanged();
  return{...base,v251SourceTask:base.sourceTask,v251SourceSteps:base.sourceSteps,sourceTask,sourceSteps,sourceRejectedPlan,sourceReads:reads,sourceRejectedStep:rejected};
}

export async function createSourceBoundReviewReplanFixture(t,{failingFocused=false,failingFull=false,output,subset=false,verboseFull=false}={}){
  const base=await createSourceBoundReviewReplanSourceFixture(t,{failingFocused,failingFull,subset,verboseFull});
  const {taskId,ownerId,root,repository,branch,head,storage,clock,hands,current,steps}=base,runtimeVersion=SOURCE_BOUND_RUNTIME;
  const workspaceProof=structuredClone(base.input.workspaceProof);workspaceProof.expectedVersion=279;workspaceProof.runtimeVersion=runtimeVersion;
  const input={expectedVersion:279,planHash:base.plan.planHash,runtimeVersion,workspaceProof,workspaceProofSignature:executionProofSignature(workspaceProof),review:structuredClone(base.review)},actor={actorType:"scoped_local_worker",workspaceProof},remoteOverrides={};
  const verifyRemote=async request=>({currentTip:remoteOverrides[request.branch]||(request.branch===branch?head:runtimeVersion),ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))});
  const options={...base.options,input,actor,currentCommit:runtimeVersion,runtimeVersion,verifyRemote},service=createSelfDevelopmentService(options),prompts=[],proposedPlans=[],executions=[],requests=[],hooks={claim:()=>{},execution:()=>{},complete:()=>{}};
  const mutationPaths=subset?PLANNING_PATHS.filter(path=>!["index.html","assets/console.css"].includes(path)):PLANNING_PATHS;
  const planner=createSelfDevelopmentImplementationPlanner({storage,ownerId,runtimeVersion,clock,modelProvider:{async generate(request){
    const prompt=JSON.parse(request.message.split("\n")[1]);prompts.push(structuredClone(prompt));
    const value={summary:"Synthetic model-owned candidate for source-bound review replan",files:mutationPaths.map(path=>({path,operation:"replace",content:base.candidate.after.get(path),reason:"Synthetic bounded lifecycle verification",intendedChanges:["Update the isolated fixture candidate"]})),focusedTests:EXECUTION_TEST_PATHS.map(path=>({path,kind:"existing"})),acceptanceMapping:(prompt.acceptanceCriteria||[]).map(criterion=>({criterion,files:mutationPaths})),reviewCoverage:base.candidate.coverage.map(({sourceHash,...mapping})=>mapping),riskLevel:"low"};
    const proposed=output?output(value,prompt):value;proposedPlans.push(structuredClone(proposed));return{type:"final",message:JSON.stringify(proposed)};
  }}});
  const planningTools=createToolRegistry();planningTools.register({name:"self_development_plan_implementation",execute:args=>planner.generate(args)});
  const taskWorker=createWorkerRuntime({storage,ownerId,toolRegistry:planningTools,clock});
  const client={async request(path,args){
    requests.push({path,args:structuredClone(args)});
    if(path==="/api/admin/worker/auto-dispatch/next")return base.dispatch.next(args);
    if(path==="/api/admin/worker/handoff/claim"){hooks.claim(args);return base.handoff.claim(args);}
    if(path===`/api/autonomy/worker/tasks/${taskId}/tick`)return taskWorker.tickTask(taskId,args);
    const match=path.match(/^\/api\/admin\/worker\/handoff\/([^/]+)\/(complete|fail)$/);
    if(match){hooks.complete(args,match[2]);return base.handoff[match[2]](decodeURIComponent(match[1]),args);}
    assert.fail(`No real endpoint or out-of-scope operation is available: ${path}`);
  }};
  const createWorker=(workerId=SOURCE_BOUND_WORKER)=>createPersistentLocalWorker({client,root,branch,repository,runtimeVersion,workerId,registry:{async execute(name,args,context){
    assert.ok(["repo_read_task_owned_local","repo_validate_patch","repo_apply_patch","test_run","test_run_full"].includes(name),`Source-bound replan may not invoke ${name}`);
    hooks.execution(name,args,context);const execution={name,args:structuredClone(args),context:structuredClone(context)};executions.push(execution);const result=await hands.execute(name,args,context);execution.result=structuredClone(result);return result;
  }}});
  const worker=createWorker(),tools={list(){return[];},async execute(){assert.fail("Owner approval must not execute the continuation");}};
  const api=createApi({agent:{tools},config:{allowedOrigins:[],maxBodyBytes:256*1024,localWorkerToken:PLANNING_TOKEN},storage,initialize:async()=>{},ownerId,selfDevelopment:service,workerRuntime:{get:current,async resumeApproval(){assert.fail("Owner decision must not resume the task");},async control(){assert.fail("Owner decision must not control the task");}},logger:{info(){},error(){}}});
  const post=async(path,body=input,token=PLANNING_TOKEN)=>{const req=Readable.from([JSON.stringify(body)]);req.method="POST";req.url=path;req.headers={"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})};let text="";const res={setHeader(){},end(value=""){text+=value;}};await api.handle(req,res);return{status:res.statusCode,body:JSON.parse(text)};};
  const path=suffix=>`/api/admin/self-development/tasks/${taskId}/${suffix}`;
  const authorize=async()=>{const before=await current(),requested=await service.requestSourceBoundReviewReplanApproval(taskId,input,actor);assert.equal(requested.approval.status,"pending");assert.deepEqual(await current(),before);await storage.decideApproval(requested.approval.id,ownerId,"approved");input.approvalId=requested.approval.id;return requested;};
  const recover=()=>service.recoverSourceBoundReviewReplan(taskId,input,actor),runSteps=async count=>{for(let index=0;index<count;index++)assert.equal((await worker.runOnce()).worked,true,`Expected source-bound review replan phase ${index+1}`);};
  return{...base,previousRejectedRecover:base.recover,previousRejectedWorker:base.worker,runtimeVersion,input,actor,options,service,planner,taskWorker,client,worker,createWorker,prompts,proposedPlans,executions,requests,hooks,remoteOverrides,authorize,recover,post,path,runSteps};
}
