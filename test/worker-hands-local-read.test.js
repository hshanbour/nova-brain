import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
import {createAutoDispatchService} from "../src/autonomy/auto-dispatch.js";
import {createLocalWorkerHandoff} from "../src/autonomy/local-worker-handoff.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createSelfDevelopmentImplementationPlanner} from "../src/autonomy/self-development-implementation-planner.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";

const OWNER="fixture-owner",TASK="fixture-v174",REPOSITORY="hshanbour/nova-brain";
const BRANCH="feat/nova-brain-mvp-foundation",RUNTIME="a".repeat(40);
const GENERATION="b".repeat(64),OLD_GENERATION="c".repeat(64),FINGERPRINT="d".repeat(64),APPLY="e".repeat(64);
const WORKER="persistent-local-11111111-2222-4333-8444-555555555555";
const PATHS=["assets/console.css","assets/console.js","assets/voice-input.js","index.html","test/composer-dictation.test.js","test/composer-voice-console.integration.test.js","test/console-static.test.js","test/voice-input.test.js"];
const REMAINING=PATHS.slice(5),CLOCK=()=>new Date("2026-09-13T23:00:00.000Z");
const BEFORE="2026-09-13T21:00:00.000Z",START="2026-09-13T22:59:00.000Z",END="2026-09-13T23:14:00.000Z";
const run=promisify(execFile),boundary=Object.assign(new Error("Stop at the isolated planner/provider boundary."),{code:"fixture_plan_boundary"});

// Only synthetic bytes in a new temporary repository. No live API, credential,
// product workspace, provider generation, or product mutation tool is available.
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),"nova-context-v174-"));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes("nova-context-v174-"));await rm(root,{recursive:true,force:true});});
  const git=async(...args)=>(await run("git",args,{cwd:root})).stdout.trim();
  const contents=new Map(PATHS.map((path,index)=>[path,`/* synthetic task-owned file ${index}: ${path} */\n`]));
  for(const path of PATHS){await mkdir(dirname(join(root,path)),{recursive:true});if(path!==REMAINING[0])await writeFile(join(root,path),"/* synthetic base */\n");}
  await git("init","-b",BRANCH);await git("config","core.autocrlf","false");
  await git("config","user.name","Runtime Fixture");await git("config","user.email","fixture@example.invalid");
  await git("remote","add","origin",`https://github.com/${REPOSITORY}.git`);
  await git("add",".");await git("commit","-m","synthetic read fixture");const head=await git("rev-parse","HEAD");
  for(const [path,content] of contents)await writeFile(join(root,path),content);
  const initialStatus=await git("status","--porcelain=v1","--untracked-files=all");
  const entries=PATHS.map(path=>({path,contentHash:canonicalContentHash(contents.get(path))}));
  const storage=createInMemoryStorage({clock:CLOCK});await storage.initialize({owner:{id:OWNER,fullName:"Fixture"},projects:[{id:"nova-brain",name:"Fixture"}]});
  const original={version:2,generationId:GENERATION,recoveryClass:"task_owned_local_read_recovery",startStep:121,maxSteps:10,runtimeStartedAt:BEFORE,runtimeMinutes:15,runtimeDeadline:"2026-09-13T21:15:00.000Z"};
  const active={...original,runtimeStartedAt:START,runtimeDeadline:END};
  const planned=Array.from({length:121},()=>({type:"read_files",input:{tool:"repo_read_remote",arguments:{path:PATHS[0]}}}));
  planned.push(...REMAINING.map(path=>({type:"read_files",input:{tool:"repo_read_task_owned_local",arguments:{path}}})),{type:"plan_repair",input:{tool:"self_development_plan_implementation",arguments:{taskId:TASK,candidatePaths:PATHS,currentCommit:"$CURRENT_COMMIT",failureEvidence:{code:"repair_plan_incomplete",version:1,fingerprint:FINGERPRINT,requiredPaths:PATHS,mutationApplied:false,sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch"}}}});
  const extension=[{approvalId:"fixture-existing-owner-extension",consumed:true,repairIteration:3}];
  const metadata={steps:planned,autoDispatch:true,requiredCapability:"repo_read_remote",selfDevelopment:{repository:REPOSITORY,userGoal:"Complete the composer mission",acceptanceCriteria:["Editable dictation"],repairLimit:3},escalatedRepairHistory:extension,activeContinuation:active,continuationHistory:[original,active],
    partialRepairPlanRecoveryHistory:[{taskId:TASK,repository:REPOSITORY,branch:BRANCH,currentCommit:head,workspaceRoot:root,fingerprint:FINGERPRINT,sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch",sourceApplyFingerprint:APPLY,requiredPaths:PATHS,entries,activeContinuation:{generationId:OLD_GENERATION}}],
    implementationPlanRecoveryHistory:[{recoveryClass:"task_owned_local_read_recovery",previousStateVersion:169,failedStepId:"112:read_files",sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch",fingerprint:FINGERPRINT,runtimeVersion:"f".repeat(40),readPaths:REMAINING,recoveredAt:BEFORE,activeContinuation:original}],
    continuationRuntimeResumeHistory:[{recoveryClass:"stale_task_runtime_to_active_continuation",sourceRecoveryClass:"task_owned_local_read_recovery",fromStateVersion:170,continuationGenerationId:GENERATION,maxRenewals:1,authorizationConsumed:true,workerBindingState:"bound",workerId:WORKER,boundAt:START,repository:REPOSITORY,branch:BRANCH,currentCommit:head,workspaceRoot:root,sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch",sourceApplyFingerprint:APPLY,fingerprint:FINGERPRINT,runtimeVersion:RUNTIME,remainingReadPaths:REMAINING,runtimeWindow:{runtimeStartedAt:START,runtimeMinutes:15,runtimeDeadline:END},resumedAt:START}]};
  await storage.createAutonomyTask({id:TASK,ownerId:OWNER,projectId:"nova-brain",title:"v174 context fixture",objective:"read boundary",taskType:"self_development",branch:BRANCH,startingCommit:head,maxSteps:100,maxRuntimeMinutes:15,metadata});
  const record=(stepId,stepType,result,status="completed",errorCode=null)=>storage.recordAutonomyStep({taskId:TASK,stepId,stepType,capability:stepType==="apply_patch"?"repo_mutate_local":"repo_read_remote",operationFingerprint:stepType==="apply_patch"?APPLY:canonicalContentHash(stepId),status,errorCode,result});
  await record("79:plan_repair","plan_repair",{implementationPlan:{files:PATHS.slice(0,6).map(path=>({path,content:contents.get(path)}))}});
  await record("80:apply_patch","apply_patch",{ok:true,files:PATHS.slice(0,6),taskOwnedDirtyLineage:{version:1,taskId:TASK,repository:REPOSITORY,branch:BRANCH,currentCommit:head,sourcePlanStepId:"79:plan_repair",entries}});
  for(const [index,path] of PATHS.slice(0,5).entries())await record(`${107+index}:read_files`,"read_files",{path,content:contents.get(path),contentHash:canonicalContentHash(contents.get(path)),truncated:false});
  await record("112:read_files","read_files",{message:"Historical remote read failed."},"failed","repo_read_failed");
  await record("122:read_files","read_files",{message:"The task-owned local read binding is invalid."},"failed","task_owned_local_read_unproven");
  let task=await storage.getAutonomyTask(TASK,OWNER);while(task.stateVersion<174)task=await storage.updateAutonomyTask(TASK,OWNER,{status:"failed",currentStep:121,currentPhase:"read_files",repairIteration:3,errorCode:"task_owned_local_read_unproven"},task.stateVersion);
  const service=createLocalWorkerHandoff({storage,ownerId:OWNER,approvedBranch:BRANCH,clock:CLOCK});
  const dispatch=createAutoDispatchService({storage,ownerId:OWNER,clock:CLOCK});
  const registry=createToolRegistry();registerHandsTools(registry,{root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:BRANCH},storage,ownerId:OWNER});
  const contexts=[],requests=[],prompts=[];
  const planner=createSelfDevelopmentImplementationPlanner({storage,ownerId:OWNER,modelProvider:{async generate(request){prompts.push(JSON.parse(request.message.split("\n")[1]));throw boundary;}}});
  const planningTools=createToolRegistry();
  planningTools.register({name:"self_development_plan_implementation",execute:input=>planner.generate(input)});
  const runtime=createWorkerRuntime({storage,ownerId:OWNER,toolRegistry:planningTools,clock:CLOCK});
  const hooks={execution:()=>{},dispatch:()=>{},claim:()=>{}};
  const client={async request(path,input){
    requests.push({path,input:structuredClone(input)});
    if(path==="/api/admin/worker/auto-dispatch/next"){const result=await dispatch.next(input);hooks.dispatch(result);return result;}
    if(path==="/api/admin/worker/handoff/claim"){hooks.claim(input);return service.claim(input);}
    const match=path.match(/^\/api\/admin\/worker\/handoff\/([^/]+)\/(complete|fail)$/);
    if(match)return service[match[2]](decodeURIComponent(match[1]),input);
    if(path===`/api/autonomy/worker/tasks/${TASK}/tick`){const current=await storage.getAutonomyTask(TASK,OWNER);assert.equal(current.metadata.steps[current.currentStep].type,"plan_repair");return runtime.tickTask(TASK,input);}
    assert.fail(`Unexpected fixture request: ${path}`);
  }};
  const worker=createPersistentLocalWorker({client,root,branch:BRANCH,repository:REPOSITORY,workerId:WORKER,registry:{async execute(name,args,context){assert.equal(name,"repo_read_task_owned_local");hooks.execution(args,context);contexts.push(structuredClone({args,context}));return registry.execute(name,args,context);}}});
  const unchanged=async()=>{assert.equal(await git("rev-parse","HEAD"),head);assert.equal(await git("status","--porcelain=v1","--untracked-files=all"),initialStatus);for(const [path,content] of contents)assert.equal(await readFile(join(root,path),"utf8"),content);};
  // Fixture-only staging of the same failed step for an infrastructure retry.
  // This is NOT a production recovery/renewal API and grants no real authority.
  const ready=async()=>{const current=await storage.getAutonomyTask(TASK,OWNER);return storage.updateAutonomyTask(TASK,OWNER,{status:"waiting_for_worker",errorCode:null},current.stateVersion);};
  return{root,head,storage,worker,hooks,contexts,requests,prompts,planner,entries,contents,unchanged,ready,git,extension};
}

test("v174 real worker -> Hands -> three durable complete reads -> 8/8 -> planner boundary (no mutation)",async t=>{
  const f=await fixture(t),initial=await f.storage.getAutonomyTask(TASK,OWNER);
  assert.equal(initial.stateVersion,174);assert.equal(initial.status,"failed");assert.deepEqual(await f.worker.runOnce(),{worked:false});
  await f.ready();
  for(const [index,path] of REMAINING.entries()){
    assert.equal((await f.worker.runOnce()).worked,true);
    const step=(await f.storage.listAutonomySteps(TASK)).find(item=>item.stepId===`${122+index}:read_files`);
    assert.equal(step.status,"completed");assert.equal(step.result.path,path);assert.equal(step.result.content,f.contents.get(path));
    assert.equal(step.result.contentHash,canonicalContentHash(f.contents.get(path)));assert.equal(step.result.truncated,false);
    assert.equal(step.result.source,"task_owned_local_workspace");assert.equal(step.attempt,index===0?2:1);
    const {args,context}=f.contexts[index];assert.equal(context.continuationGenerationId,GENERATION);
    assert.equal(context.schemaDiagnosticContext.continuationGenerationId,GENERATION);assert.equal(args.binding.continuationGenerationId,GENERATION);
    assert.equal(context.runId,TASK);assert.equal(context.repositoryContext.expectedHead,f.head);assert.equal(context.repositoryContext.root,f.root);
    await f.unchanged();
  }
  const current=await f.storage.getAutonomyTask(TASK,OWNER);
  assert.equal(current.currentStep,124);assert.equal(current.metadata.steps[124].type,"plan_repair");
  assert.equal(current.status,"queued");assert.equal(current.repairIteration,3);assert.deepEqual(current.metadata.escalatedRepairHistory,f.extension);
  assert.deepEqual(current.metadata.continuationRuntimeResumeHistory,initial.metadata.continuationRuntimeResumeHistory);
  assert.equal(current.metadata.continuationRuntimeResumeHistory[0].workerId,WORKER);assert.equal(current.leaseOwner,null);assert.equal(current.metadata.localHandoff,null);
  const reads=(await f.storage.listAutonomySteps(TASK)).filter(step=>step.stepType==="read_files"&&step.status==="completed");
  assert.equal(reads.length,8);assert.deepEqual(reads.map(step=>step.result.path).sort(),[...PATHS].sort());
  await f.worker.runOnce();
  assert.equal(f.prompts.length,1);assert.deepEqual(f.prompts[0].candidateFiles,PATHS.map(path=>({path,content:f.contents.get(path)})));
  assert.equal(f.prompts[0].repairFailureEvidence.fingerprint,FINGERPRINT);
  assert.equal(f.requests.filter(item=>item.path.endsWith("/claim")).every(item=>item.input.workerId===WORKER),true);
  const afterReads=(await f.storage.listAutonomySteps(TASK)).filter(step=>Number.parseInt(step.stepId,10)>124);
  assert.equal(afterReads.length,1);assert.equal(afterReads[0].stepId,"125:plan_repair");assert.equal(afterReads[0].errorCode,boundary.code);
  await f.unchanged();
});

for(const [name,alter] of [
  ["missing generation",(_args,context)=>{delete context.continuationGenerationId;delete context.schemaDiagnosticContext.continuationGenerationId;}],
  ["nested diagnostic generation only",(_args,context)=>{delete context.continuationGenerationId;}],
  ["wrong generation",(_args,context)=>{context.continuationGenerationId="wrong";}],
  ["stale historical generation",(_args,context)=>{context.continuationGenerationId=OLD_GENERATION;}],
  ["wrong task",(_args,context)=>{context.runId="another-task";}],
  ["wrong workspace",(_args,context)=>{context.repositoryContext.root+="/other";}],
  ["wrong repository",args=>{args.binding.repository="another/repository";}],
  ["wrong branch",args=>{args.binding.branch="another-branch";}],
  ["wrong product HEAD",(_args,context)=>{context.repositoryContext.expectedHead="0".repeat(40);}],
  ["wrong content hash",args=>{args.expectedContentHash="0".repeat(64);}],
])test(`worker/Hands rejects ${name} without file mutation`,async t=>{
  const f=await fixture(t);await f.ready();f.hooks.execution=alter;
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code===(name==="wrong content hash"?"task_owned_local_read_drift":"task_owned_local_read_unproven"));
  assert.equal((await f.storage.getAutonomyTask(TASK,OWNER)).currentStep,121);assert.equal(f.prompts.length,0);await f.unchanged();
});

for(const workerId of ["persistent-local-stale","persistent-local-competing"])test(`handoff rejects ${workerId} before Hands`,async t=>{
  const f=await fixture(t);await f.ready();f.hooks.claim=input=>{input.workerId=workerId;};
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="task_owned_local_read_unproven");
  assert.equal(f.contexts.length,0);await f.unchanged();
});

for(const generation of [undefined,"wrong",OLD_GENERATION])test(`worker cannot replace missing/wrong dispatched generation (${generation}) with the valid handoff binding`,async t=>{
  const f=await fixture(t);await f.ready();f.hooks.dispatch=result=>{result.task.continuationGenerationId=generation;};
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="task_owned_local_read_unproven");
  assert.equal(f.contexts[0].args.binding.continuationGenerationId,GENERATION);
  assert.equal(f.contexts[0].context.continuationGenerationId,generation);await f.unchanged();
});

for(const [name,alter] of [
  ["candidate outside the proven set",task=>{task.metadata.steps[121].input.arguments.path="test/unrelated.test.js";}],
  ["source plan",task=>{task.metadata.partialRepairPlanRecoveryHistory[0].sourcePlanStepId="26:plan_repair";}],
  ["source apply",task=>{task.metadata.partialRepairPlanRecoveryHistory[0].sourceApplyStepId="27:apply_patch";}],
  ["recovery fingerprint",task=>{task.metadata.implementationPlanRecoveryHistory[0].fingerprint="wrong";}],
  ["dirty lineage hash",task=>{task.metadata.partialRepairPlanRecoveryHistory[0].entries[5].contentHash="0".repeat(64);}],
])test(`handoff rejects wrong ${name} before Hands`,async t=>{
  const f=await fixture(t),task=await f.ready();alter(task);await f.storage.updateAutonomyTask(TASK,OWNER,{metadata:task.metadata},task.stateVersion);
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="task_owned_local_read_unproven");
  assert.equal(f.contexts.length,0);await f.unchanged();
});

test("planner does not accept 5/8 complete reads as the eight-file evidence set",async t=>{
  const f=await fixture(t);await assert.rejects(()=>f.planner.generate({taskId:TASK,candidatePaths:PATHS,currentCommit:f.head}),error=>error.code==="implementation_evidence_incomplete");
  assert.equal(f.prompts.length,0);await f.unchanged();
});

test("runtime identity remains fail-closed at authoritative renewal issuance, independently of product HEAD",async t=>{
  const f=await fixture(t),task=await f.ready();
  // Separate in-memory pre-renewal specimen: runtime mismatch is checked by
  // this service, not synthesized from the product HEAD or diagnostic context.
  const original=task.metadata.continuationHistory[0];
  const metadata={...task.metadata,activeContinuation:original,continuationHistory:[original],continuationRuntimeResumeHistory:[]};
  metadata.implementationPlanRecoveryHistory[0].previousStateVersion=task.stateVersion;
  const sample=await f.storage.updateAutonomyTask(TASK,OWNER,{metadata},task.stateVersion);
  const steps=(await f.storage.listAutonomySteps(TASK)).filter(step=>Number.parseInt(step.stepId,10)<=121);
  const runtime={get:id=>f.storage.getAutonomyTask(id,OWNER),steps:async()=>steps};
  const service=createSelfDevelopmentService({runtime,storage:f.storage,ownerId:OWNER,currentCommit:RUNTIME,runtimeVersion:RUNTIME,clock:CLOCK,verifyRemote:async()=>({currentTip:f.head,ancestors:{[f.head]:true}})});
  const changedFiles=[];for(const entry of f.entries)changedFiles.push({...entry,hashAlgorithm:"git_sha1",hash:await f.git("hash-object",entry.path)});
  const input={expectedVersion:sample.stateVersion,runtimeVersion:RUNTIME,workspace:{root:f.root,gitTopLevel:f.root,repository:REPOSITORY,branch:BRANCH,head:f.head,liveTip:f.head,clean:false,changedFiles}};
  assert.notEqual(f.head,RUNTIME);
  for(const runtimeVersion of ["f".repeat(40),f.head,undefined]){
    await assert.rejects(()=>service.resumeFullTestContinuationRuntime(TASK,{...input,runtimeVersion}),error=>error.code==="continuation_runtime_resume_precondition_failed");
    assert.deepEqual(await f.storage.getAutonomyTask(TASK,OWNER),sample);await f.unchanged();
  }
  // Positive control prevents an unrelated invalid fixture from masking the runtime check.
  assert.equal((await service.resumeFullTestContinuationRuntime(TASK,input)).idempotent,false);await f.unchanged();
});
