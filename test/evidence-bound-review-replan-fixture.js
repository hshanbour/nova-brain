import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createSelfDevelopmentImplementationPlanner} from "../src/autonomy/self-development-implementation-planner.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createApi} from "../src/http/api.js";
import {createSourceBoundReviewReplanFixture,assertSourceBoundHistoriesPreserved} from "./source-bound-review-replan-fixture.js";
import {executionProofSignature,EXECUTION_TEST_PATHS} from "./execution-scope-fixture.js";
import {PLANNING_PATHS,PLANNING_TOKEN} from "./planning-scope-fixture.js";

export const EVIDENCE_BOUND_RUNTIME="3".repeat(40);
export const EVIDENCE_BOUND_WORKER="persistent-local-9abcdef0-bcde-4bcd-8cde-f0123456789a";
export const EVIDENCE_BOUND_CLASS="owner_approved_evidence_bound_review_replan";
export const EVIDENCE_BOUND_HISTORY="evidenceBoundReviewReplanHistory";
export const EVIDENCE_BOUND_BOUNDARY="evidenceBoundReviewReplanBoundary";
export const EVIDENCE_BOUND_ADMIN_TOKEN="synthetic-private-evidence-owner-token";

export function assertEvidenceBoundHistoriesPreserved(before,after){
  assertSourceBoundHistoriesPreserved(before,after);
  assert.deepEqual(after.metadata.sourceBoundReviewReplanHistory,before.metadata.sourceBoundReviewReplanHistory);
  assert.deepEqual(after.metadata.sourceBoundReviewReplanBoundary,before.metadata.sourceBoundReviewReplanBoundary);
}

// Produce the real-shaped v307 source through prior normal planner/worker/Hands
// execution. Only isolated synthetic programs are supplied by the model stub.
export async function createEvidenceBoundReviewReplanSourceFixture(t,options={}){
  let sourceRejectedPlan;
  const selectedPaths=["assets/voice-input.js","test/composer-dictation.test.js"];
  const base=await createSourceBoundReviewReplanFixture(t,{...options,output:value=>{
    sourceRejectedPlan={...value,files:value.files.filter(file=>selectedPaths.includes(file.path)),focusedTests:[{path:"test/composer-dictation.test.js",kind:"existing"}],acceptanceMapping:value.acceptanceMapping.map(item=>({...item,files:selectedPaths})),reviewCoverage:value.reviewCoverage.map((item,index)=>index===0?{...item,testName:"named test absent from selected excerpt"}:item)};
    return sourceRejectedPlan;
  }});
  await base.authorize();await base.recover();await base.runSteps(9);
  const sourceTask=await base.current(),sourceSteps=await base.steps(),rejected=sourceSteps.find(step=>step.stepId==="187:plan_repair"),reads=sourceSteps.filter(step=>Number.parseInt(step.stepId,10)>=179&&Number.parseInt(step.stepId,10)<=186);
  assert.equal(sourceTask.stateVersion,307);assert.equal(sourceTask.status,"blocked");assert.equal(sourceTask.currentPhase,"read_files");assert.equal(sourceTask.currentStep,186);assert.equal(sourceTask.repairIteration,3);assert.equal(sourceTask.errorCode,"review_remediation_precondition_failed");
  assert.equal(rejected.status,"failed");assert.equal(rejected.attempt,1);assert.equal(rejected.result.diagnostics.predicate,"source_bound_behavioral_coverage");assert.equal(rejected.result.diagnostics.mutationApplied,false);assert.deepEqual(rejected.result.diagnostics.coverageDiagnostics.firstFailure,{predicate:"source_bound_behavioral_coverage",constraintId:base.review.acceptanceConstraints[0].id,subclause:"excerpt_contains_test_name"});
  assert.equal(sourceTask.metadata.sourceBoundReviewReplanHistory[0].consumed,true);assert.equal(sourceTask.metadata.sourceBoundReviewReplanBoundary.executionAuthorized,false);assert.equal(reads.length,8);assert.ok(reads.every(step=>step.status==="completed"));
  assert.deepEqual(sourceRejectedPlan.files.map(file=>file.path),selectedPaths);assert.equal(sourceRejectedPlan.focusedTests.length,1);assert.equal(sourceRejectedPlan.reviewCoverage.length,5);assert.equal(new Set(sourceRejectedPlan.reviewCoverage.map(item=>item.constraintId)).size,5);assert.equal(base.executions.some(item=>item.name==="repo_apply_patch"),false);await base.verifySourceUnchanged();
  return{...base,v279SourceTask:base.sourceTask,v279SourceSteps:base.sourceSteps,sourceTask,sourceSteps,sourceRejectedPlan,sourceReads:reads,sourceRejectedStep:rejected};
}

export async function createEvidenceBoundReviewReplanFixture(t,{failingFocused=false,failingFull=false,output,subset=false,verboseFull=false,workerAdminToken=EVIDENCE_BOUND_ADMIN_TOKEN}={}){
  const base=await createEvidenceBoundReviewReplanSourceFixture(t,{failingFocused,failingFull,subset,verboseFull});
  const {taskId,ownerId,root,repository,branch,head,storage,clock,hands,current,steps}=base,runtimeVersion=EVIDENCE_BOUND_RUNTIME;
  const workspaceProof=structuredClone(base.input.workspaceProof);workspaceProof.expectedVersion=307;workspaceProof.runtimeVersion=runtimeVersion;
  const input={expectedVersion:307,planHash:base.plan.planHash,runtimeVersion,workspaceProof,workspaceProofSignature:executionProofSignature(workspaceProof),review:structuredClone(base.review)},actor={actorType:"scoped_local_worker",workspaceProof},remoteOverrides={};
  const verifyRemote=async request=>({currentTip:remoteOverrides[request.branch]||(request.branch===branch?head:runtimeVersion),ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))});
  const options={...base.options,input,actor,currentCommit:runtimeVersion,runtimeVersion,verifyRemote},service=createSelfDevelopmentService(options),prompts=[],proposedPlans=[],executions=[],requests=[],hooks={claim:()=>{},execution:()=>{},complete:()=>{}};
  const mutationPaths=subset?PLANNING_PATHS.filter(path=>!["index.html","assets/console.css"].includes(path)):PLANNING_PATHS;
  const planner=createSelfDevelopmentImplementationPlanner({storage,ownerId,runtimeVersion,clock,modelProvider:{async generate(request){
    const prompt=JSON.parse(request.message.split("\n")[1]);prompts.push(structuredClone(prompt));
    const value={summary:"Synthetic model-owned candidate for evidence-bound review replan",files:mutationPaths.map(path=>({path,operation:"replace",content:base.candidate.after.get(path),reason:"Synthetic bounded lifecycle verification",intendedChanges:["Update the isolated fixture candidate"]})),focusedTests:EXECUTION_TEST_PATHS.map(path=>({path,kind:"existing"})),acceptanceMapping:(prompt.acceptanceCriteria||[]).map(criterion=>({criterion,files:mutationPaths})),reviewCoverage:base.candidate.coverage.map(({sourceHash,...mapping})=>mapping),riskLevel:"low"};
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
  const createWorker=(workerId=EVIDENCE_BOUND_WORKER)=>createPersistentLocalWorker({client,root,branch,repository,runtimeVersion,workerId,registry:{async execute(name,args,context){
    assert.ok(["repo_read_task_owned_local","repo_validate_patch","repo_apply_patch","test_run","test_run_full"].includes(name),`Evidence-bound replan may not invoke ${name}`);
    hooks.execution(name,args,context);const execution={name,args:structuredClone(args),context:structuredClone(context)};executions.push(execution);const result=await hands.execute(name,args,context);execution.result=structuredClone(result);return result;
  }}});
  const worker=createWorker(),tools={list(){return[];},async execute(){assert.fail("Owner approval must not execute the continuation");}};
  const api=createApi({agent:{tools},config:{allowedOrigins:[],maxBodyBytes:256*1024,localWorkerToken:PLANNING_TOKEN,workerAdminToken},storage,initialize:async()=>{},ownerId,selfDevelopment:service,workerRuntime:{get:current,async resumeApproval(){assert.fail("Owner decision must not resume the task");},async control(){assert.fail("Owner decision must not control the task");}},logger:{info(){},error(){}}});
  const post=async(path,body=input,token=PLANNING_TOKEN)=>{const req=Readable.from([JSON.stringify(body)]);req.method="POST";req.url=path;req.headers={"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})};let text="";const res={setHeader(){},end(value=""){text+=value;}};await api.handle(req,res);return{status:res.statusCode,body:JSON.parse(text)};};
  const get=async(path,token=EVIDENCE_BOUND_ADMIN_TOKEN)=>{const req=Readable.from([]);req.method="GET";req.url=path;req.headers=token?{authorization:`Bearer ${token}`}:{ };let text="";const headers={};const res={setHeader(name,value){headers[name.toLowerCase()]=value;},end(value=""){text+=value;}};await api.handle(req,res);return{status:res.statusCode,body:JSON.parse(text),headers,rawText:text};};
  const path=suffix=>`/api/admin/self-development/tasks/${taskId}/${suffix}`;
  const authorize=async()=>{const before=await current(),requested=await service.requestEvidenceBoundReviewReplanApproval(taskId,input,actor);assert.equal(requested.approval.status,"pending");assert.deepEqual(await current(),before);await storage.decideApproval(requested.approval.id,ownerId,"approved");input.approvalId=requested.approval.id;return requested;};
  const recover=()=>service.recoverEvidenceBoundReviewReplan(taskId,input,actor),runSteps=async count=>{for(let index=0;index<count;index++)assert.equal((await worker.runOnce()).worked,true,`Expected evidence-bound review replan phase ${index+1}`);};
  return{...base,previousSourceBoundRecover:base.recover,previousSourceBoundWorker:base.worker,runtimeVersion,input,actor,options,service,planner,taskWorker,client,worker,createWorker,prompts,proposedPlans,executions,requests,hooks,remoteOverrides,authorize,recover,post,get,path,runSteps};
}
