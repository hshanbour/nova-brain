import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash,createHmac} from "node:crypto";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
import {createAutoDispatchService} from "../src/autonomy/auto-dispatch.js";
import {createLocalWorkerHandoff,verifyLocalWorkerWorkspaceProof} from "../src/autonomy/local-worker-handoff.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createSelfDevelopmentImplementationPlanner} from "../src/autonomy/self-development-implementation-planner.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";

const OWNER="fixture-owner",TASK="fixture-modern-failed-local-read",REPOSITORY="hshanbour/nova-brain";
const BRANCH="feat/nova-brain-mvp-foundation",CONTROL_BRANCH="stage13/control-plane-approved-delivery-runtime";
const RUNTIME="a".repeat(40),OLD_RUNTIME="f".repeat(40),GENERATION="b".repeat(64),OLD_GENERATION="c".repeat(64),APPLY="e".repeat(64);
const OLD_WORKER="persistent-local-11111111-2222-4333-8444-555555555555",NEW_WORKER="persistent-local-22222222-3333-4444-8555-666666666666";
const PATHS=["assets/console.css","assets/console.js","assets/voice-input.js","index.html","test/composer-dictation.test.js","test/composer-voice-console.integration.test.js","test/console-static.test.js","test/voice-input.test.js"];
const REMAINING=PATHS.slice(5),CLOCK=()=>new Date("2026-09-14T13:00:00.000Z");
const RECOVERED="2026-09-13T21:00:00.000Z",RENEWED="2026-09-13T22:53:16.797Z",EXPIRED="2026-09-13T23:08:16.797Z";
const TOKEN="synthetic-local-worker-secret",run=promisify(execFile);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const gitBlobHash=content=>createHash("sha1").update(`blob ${Buffer.byteLength(content,"utf8")}\0`).update(content).digest("hex");
const boundary=Object.assign(new Error("Stop before generation at the actual Nova provider boundary."),{code:"fixture_provider_boundary"});

// Every byte and authority below belongs to an isolated synthetic temporary
// repository/in-memory database. No live credentials, API, task, worker process,
// product workspace or product mutation capability participates in this test.
async function fixture(t,{staleRemoteReads=false}={}){
  const root=await mkdtemp(join(tmpdir(),"nova-failed-local-read-"));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes("nova-failed-local-read-"));await rm(root,{recursive:true,force:true});});
  const git=async(...args)=>(await run("git",args,{cwd:root})).stdout.trim();
  const contents=new Map(PATHS.map((path,index)=>[path,`/* current synthetic task-owned bytes ${index}: ${path} */\n`]));
  for(const path of PATHS){await mkdir(dirname(join(root,path)),{recursive:true});if(path!==REMAINING[0])await writeFile(join(root,path),"/* synthetic base */\n");}
  await git("init","-b",BRANCH);await git("config","core.autocrlf","false");
  await git("config","user.name","Runtime Fixture");await git("config","user.email","fixture@example.invalid");
  await git("remote","add","origin",`https://github.com/${REPOSITORY}.git`);
  await git("add",".");await git("commit","-m","synthetic recovery fixture");const head=await git("rev-parse","HEAD");
  for(const [path,content] of contents)await writeFile(join(root,path),content);
  const initialStatus=await git("status","--porcelain=v1","--untracked-files=all");
  const entries=PATHS.map(path=>({path,contentHash:canonicalContentHash(contents.get(path)),hashAlgorithm:"git_sha1",hash:gitBlobHash(contents.get(path))}));
  const fingerprint=hash([TASK,145,"79:plan_repair","80:apply_patch",entries]);
  const storage=createInMemoryStorage({clock:CLOCK});await storage.initialize({owner:{id:OWNER,fullName:"Fixture"},projects:[{id:"nova-brain",name:"Fixture"}]});
  const original={version:2,generationId:GENERATION,recoveryClass:"task_owned_local_read_recovery",startStep:121,maxSteps:10,repairLimit:0,runtimeStartedAt:RECOVERED,runtimeMinutes:15,runtimeDeadline:"2026-09-13T21:15:00.000Z"};
  const active={...original,runtimeStartedAt:RENEWED,runtimeDeadline:EXPIRED};
  const partialContinuation={...original,generationId:OLD_GENERATION,startStep:92,recoveryClass:"task_owned_partial_repair_replan",runtimeStartedAt:"2026-09-13T20:00:00.000Z",runtimeDeadline:"2026-09-13T20:15:00.000Z"};
  const failureEvidence={code:"repair_plan_incomplete",version:1,fingerprint,requiredPaths:PATHS,mutationApplied:false,sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch"};
  const planned=Array.from({length:121},()=>({type:"read_files",input:{tool:"repo_read",arguments:{path:PATHS[0]}}}));
  planned.push(...REMAINING.map(path=>({type:"read_files",input:{tool:"repo_read_task_owned_local",arguments:{path}}})),
    {type:"plan_repair",input:{tool:"self_development_plan_implementation",arguments:{taskId:TASK,candidatePaths:PATHS,currentCommit:"$CURRENT_COMMIT",failureEvidence}}},
    {type:"apply_patch",input:{tool:"repo_apply_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}}},
    {type:"run_focused_tests",input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}}},
    {type:"run_full_tests",input:{tool:"test_run_full",arguments:{}}},
    {type:"inspect_diff",input:{tool:"repo_diff",arguments:{paths:"$IMPLEMENTATION_PATHS"}}},
    {type:"commit",input:{tool:"git_commit",arguments:{branch:BRANCH,paths:"$IMPLEMENTATION_PATHS",message:"Fixture bounded repair"}}},
    {type:"review_commit",input:{tool:"repo_review_commit",arguments:{commitSha:"$CURRENT_COMMIT",paths:"$IMPLEMENTATION_PATHS"}}});
  const extension={recoveryClass:"owner_approved_single_repair_extension",fromStateVersion:105,approvalId:"fixture-existing-owner-extension",failedStepId:"58:run_focused_tests",failureFingerprint:"1".repeat(64),planGenerationId:"2".repeat(64),previousRepairIteration:3,globalRepairLimit:3,maxAdditionalAttempts:1,recoveredAt:"2026-09-12T12:00:00.000Z"};
  const metadata={steps:planned,autoDispatch:true,requiredCapability:"repo_read_remote",selfDevelopment:{repository:REPOSITORY,userGoal:"Complete the composer mission",acceptanceCriteria:["Editable dictation"],repairLimit:3},escalatedRepairHistory:[extension],activeContinuation:active,continuationHistory:[partialContinuation,original,active],
    // This intentionally stale plan must NOT replace authoritative fresh read
    // contents when plan_repair calls Nova's normal implementation planner.
    selfDevelopmentImplementationPlan:{files:PATHS.map(path=>({path,operation:"replace",content:"/* STALE implementation-plan snapshot: not current file contents */\n"})),focusedTests:PATHS.filter(path=>path.startsWith("test/")).map(path=>({path,kind:"existing"}))},
    partialRepairPlanRecoveryHistory:[{taskId:TASK,previousStateVersion:145,repository:REPOSITORY,branch:BRANCH,currentCommit:head,workspaceRoot:root,fingerprint,sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch",requiredPaths:PATHS,entries,activeContinuation:partialContinuation}],
    implementationPlanRecoveryHistory:[{recoveryClass:"task_owned_local_read_recovery",previousStateVersion:169,failedStepId:"112:read_files",sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch",fingerprint,runtimeVersion:OLD_RUNTIME,readPaths:REMAINING,recoveredAt:RECOVERED}],
    continuationRuntimeResumeHistory:[{recoveryClass:"stale_task_runtime_to_active_continuation",sourceRecoveryClass:"task_owned_local_read_recovery",fromStateVersion:170,continuationGenerationId:GENERATION,maxRenewals:1,authorizationConsumed:true,workerBindingState:"bound",workerId:OLD_WORKER,boundAt:RENEWED,repository:REPOSITORY,branch:BRANCH,currentCommit:head,workspaceRoot:root,sourcePlanStepId:"79:plan_repair",sourceApplyStepId:"80:apply_patch",sourceApplyFingerprint:APPLY,fingerprint,runtimeVersion:OLD_RUNTIME,remainingReadPaths:REMAINING,runtimeWindow:{runtimeStartedAt:RENEWED,runtimeMinutes:15,runtimeDeadline:EXPIRED},resumedAt:RENEWED}]};
  await storage.createAutonomyTask({id:TASK,ownerId:OWNER,projectId:"nova-brain",title:"Actual v174-shaped failed local read",objective:"Reach normal planner without mutation",taskType:"self_development",branch:BRANCH,startingCommit:head,maxSteps:100,maxRuntimeMinutes:15,maxRetries:1,metadata});
  const record=(stepId,stepType,result,status="completed",errorCode=null,input)=>storage.recordAutonomyStep({taskId:TASK,stepId,stepType,capability:stepType==="apply_patch"?"repo_mutate_local":"repo_read_remote",operationFingerprint:stepType==="apply_patch"?APPLY:canonicalContentHash(stepId),status,errorCode,result,input,attempt:1});
  if(staleRemoteReads)for(const [index,path] of REMAINING.entries())await record(`${10+index}:read_files`,"read_files",{path,content:"/* obsolete discovery snapshot */\n",truncated:false},"completed",null,{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}});
  await record("67:plan_repair","plan_repair",{implementationPlan:{files:PATHS.map(path=>({path,content:contents.get(path)}))}});
  await record("79:plan_repair","plan_repair",{implementationPlan:{files:PATHS.slice(0,6).map(path=>({path,content:contents.get(path)}))}});
  await record("80:apply_patch","apply_patch",{ok:true,files:PATHS.slice(0,6),taskOwnedDirtyLineage:{version:1,taskId:TASK,repository:REPOSITORY,branch:BRANCH,currentCommit:head,sourcePlanStepId:"79:plan_repair",entries}});
  for(const [index,path] of PATHS.slice(0,5).entries())await record(`${107+index}:read_files`,"read_files",staleRemoteReads?{path,content:"/* synthetic base */\n",truncated:false}:{path,content:contents.get(path),contentHash:canonicalContentHash(contents.get(path)),truncated:false},"completed",null,{tool:"repo_read",arguments:{path,startLine:1,endLine:1000}});
  await record("112:read_files","read_files",{message:"Repository request failed with status 404."},"failed","remote_repository_failed");
  await record("122:read_files","read_files",{code:"task_owned_local_read_unproven",message:"The task-owned local read binding is invalid."},"failed","task_owned_local_read_unproven",planned[121].input);
  await storage.createApproval({id:extension.approvalId,ownerId:OWNER,runId:TASK,tool:"self_development_escalated_repair",arguments:{taskId:TASK,expectedVersion:extension.fromStateVersion,branch:BRANCH,currentCommit:head,failedStepId:extension.failedStepId,failureFingerprint:extension.failureFingerprint,planGenerationId:extension.planGenerationId,maxAdditionalAttempts:1}});
  await storage.decideApproval(extension.approvalId,OWNER,"approved");
  let task=await storage.getAutonomyTask(TASK,OWNER);while(task.stateVersion<174)task=await storage.updateAutonomyTask(TASK,OWNER,{status:"failed",currentStep:121,currentPhase:"read_files",repairIteration:3,retryCount:1,maxRetries:1,errorCode:"task_owned_local_read_unproven",completedAt:RENEWED},task.stateVersion);
  const remoteRequests=[],overrides={};
  const runtimeReader={get:id=>storage.getAutonomyTask(id,OWNER),steps:id=>storage.listAutonomySteps(id)};
  const service=createSelfDevelopmentService({runtime:runtimeReader,storage,ownerId:OWNER,currentCommit:RUNTIME,runtimeVersion:RUNTIME,approvedBranch:BRANCH,clock:CLOCK,verifyRemote:async request=>{remoteRequests.push(request);const tip=request.branch===CONTROL_BRANCH?RUNTIME:head;return{currentTip:overrides[request.branch]||tip,ancestors:Object.fromEntries((request.requiredAncestors||[]).map(sha=>[sha,true]))};}});
  const changedFiles=[];for(const entry of entries)changedFiles.push({...entry,hashAlgorithm:"git_sha1",hash:await git("hash-object",entry.path)});
  const proof={taskId:TASK,expectedVersion:174,runtimeVersion:RUNTIME,workspace:{root,gitTopLevel:root,repository:REPOSITORY,branch:BRANCH,head,liveTip:head,clean:false,changedFiles}};
  const input={expectedVersion:174,runtimeVersion:RUNTIME,workspaceProof:proof,workspaceProofSignature:createHmac("sha256",TOKEN).update(JSON.stringify(stable(proof))).digest("hex")};
  const actor=()=>verifyLocalWorkerWorkspaceProof(input.workspaceProof,input.workspaceProofSignature,TOKEN);
  const recover=(args=input,who=actor(),taskId=TASK)=>service.recoverFailedTaskOwnedLocalRead(taskId,args,who);
  const handoff=createLocalWorkerHandoff({storage,ownerId:OWNER,approvedBranch:BRANCH,clock:CLOCK});
  const dispatch=createAutoDispatchService({storage,ownerId:OWNER,clock:CLOCK});
  const registry=createToolRegistry();registerHandsTools(registry,{root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:BRANCH},storage,ownerId:OWNER});
  const contexts=[],requests=[],prompts=[];
  const planner=createSelfDevelopmentImplementationPlanner({storage,ownerId:OWNER,modelProvider:{async generate(request){prompts.push(JSON.parse(request.message.split("\n")[1]));throw boundary;}}});
  const planningTools=createToolRegistry();planningTools.register({name:"self_development_plan_implementation",execute:value=>planner.generate(value)});
  const workerRuntime=createWorkerRuntime({storage,ownerId:OWNER,toolRegistry:planningTools,clock:CLOCK});
  const hooks={execution:()=>{},dispatch:()=>{},claim:()=>{}};
  const client={async request(path,args){requests.push({path,input:structuredClone(args)});if(path==="/api/admin/worker/auto-dispatch/next"){const result=await dispatch.next(args);hooks.dispatch(result);return result;}if(path==="/api/admin/worker/handoff/claim"){hooks.claim(args);return handoff.claim(args);}const match=path.match(/^\/api\/admin\/worker\/handoff\/([^/]+)\/(complete|fail)$/);if(match)return handoff[match[2]](decodeURIComponent(match[1]),args);if(path===`/api/autonomy/worker/tasks/${TASK}/tick`){const current=await storage.getAutonomyTask(TASK,OWNER);assert.equal(current.metadata.steps[current.currentStep].type,"plan_repair");return workerRuntime.tickTask(TASK,args);}assert.fail(`Unexpected fixture request: ${path}`);}};
  const createWorker=(workerId=NEW_WORKER)=>createPersistentLocalWorker({client,root,branch:BRANCH,repository:REPOSITORY,runtimeVersion:RUNTIME,workerId,registry:{async execute(name,args,context){assert.equal(name,"repo_read_task_owned_local");hooks.execution(args,context);contexts.push(structuredClone({args,context}));return registry.execute(name,args,context);}}});
  const unchanged=async()=>{assert.equal(await git("rev-parse","HEAD"),head);assert.equal(await git("status","--porcelain=v1","--untracked-files=all"),initialStatus);for(const [path,content] of contents)assert.equal(await readFile(join(root,path),"utf8"),content);};
  return{root,head,storage,service,handoff,dispatch,recover,input,actor,createWorker,hooks,contexts,requests,prompts,planner,entries,contents,unchanged,extension,remoteRequests,overrides};
}

test("v174 recovery with five valid prior reads reaches three local reads, 8/8 evidence and the normal Nova provider without mutating product",async t=>{
  const f=await fixture(t),initial=await f.storage.getAutonomyTask(TASK,OWNER),historicalStep=(await f.storage.listAutonomySteps(TASK)).find(step=>step.stepId==="122:read_files");
  assert.equal(initial.stateVersion,174);assert.equal(initial.status,"failed");assert.equal(initial.retryCount,initial.maxRetries);assert.equal(initial.repairIteration,3);
  assert.notEqual(f.head,RUNTIME,"product and control-plane identities remain independently bound");
  assert.ok(new Date(initial.metadata.activeContinuation.runtimeDeadline)<CLOCK());
  assert.deepEqual(await f.createWorker().runOnce(),{worked:false});
  const result=await f.recover(),recovered=await f.storage.getAutonomyTask(TASK,OWNER);
  assert.equal(result.idempotent,false);assert.equal(recovered.stateVersion,175);assert.equal(recovered.status,"waiting_for_worker");
  assert.equal(recovered.metadata.activeContinuation.recoveryClass,"failed_task_owned_local_read_recovery");
  assert.notEqual(recovered.metadata.activeContinuation.generationId,GENERATION);
  assert.equal(recovered.metadata.failedLocalReadRecoveryHistory.length,1);
  assert.deepEqual(recovered.metadata.continuationRuntimeResumeHistory,initial.metadata.continuationRuntimeResumeHistory);
  assert.deepEqual(recovered.metadata.escalatedRepairHistory,initial.metadata.escalatedRepairHistory);
  assert.equal(recovered.retryCount,1);assert.equal(recovered.repairIteration,3);
  assert.ok(new Date(recovered.metadata.activeContinuation.runtimeDeadline)>CLOCK());
  assert.ok(f.remoteRequests.some(request=>request.branch===CONTROL_BRANCH));assert.ok(f.remoteRequests.some(request=>request.branch===BRANCH));
  const firstOrdinal=recovered.currentStep+1,worker=f.createWorker();
  assert.ok(firstOrdinal>122,"recovery appends a distinct path without overwriting failed historical execution");
  for(const [index,path] of REMAINING.entries()){
    assert.equal((await worker.runOnce()).worked,true);
    const step=(await f.storage.listAutonomySteps(TASK)).find(item=>item.stepId===`${firstOrdinal+index}:read_files`);
    assert.equal(step.status,"completed");assert.equal(step.attempt,1);assert.equal(step.result.path,path);assert.equal(step.result.content,f.contents.get(path));
    assert.equal(step.result.contentHash,canonicalContentHash(f.contents.get(path)));assert.equal(step.result.truncated,false);assert.equal(step.result.source,"task_owned_local_workspace");
    assert.equal(f.contexts[index].context.continuationGenerationId,recovered.metadata.activeContinuation.generationId);
    await f.unchanged();
  }
  const current=await f.storage.getAutonomyTask(TASK,OWNER),reads=(await f.storage.listAutonomySteps(TASK)).filter(step=>step.stepType==="read_files"&&step.status==="completed");
  assert.equal(reads.length,8);assert.deepEqual(reads.map(step=>step.result.path).sort(),[...PATHS].sort());
  assert.equal(current.metadata.steps[current.currentStep].type,"plan_repair");assert.equal(current.status,"queued");
  assert.equal(current.repairIteration,3);assert.deepEqual(current.metadata.escalatedRepairHistory,initial.metadata.escalatedRepairHistory);
  assert.deepEqual(current.metadata.continuationRuntimeResumeHistory,initial.metadata.continuationRuntimeResumeHistory);
  assert.deepEqual((await f.storage.listAutonomySteps(TASK)).find(step=>step.stepId==="122:read_files"),historicalStep);
  await worker.runOnce();
  assert.equal(f.prompts.length,1,"normal planning path reaches the model provider");
  assert.deepEqual(f.prompts[0].candidateFiles,PATHS.map(path=>({path,content:f.contents.get(path)})),"current complete read bytes, not stale implementation-plan metadata, reach Nova");
  const planning=(await f.storage.listAutonomySteps(TASK)).find(step=>step.stepId===`${firstOrdinal+3}:plan_repair`);
  assert.equal(planning.errorCode,boundary.code);assert.equal((await f.storage.listAutonomySteps(TASK)).filter(step=>Number.parseInt(step.stepId,10)>firstOrdinal+3).length,0);
  assert.equal(f.requests.filter(request=>request.path.endsWith("/claim")).every(request=>request.input.workerId===NEW_WORKER),true);
  await f.unchanged();
});

test("actual v174 stale remote snapshots require all eight fresh local reads before the normal Nova provider",async t=>{
  const f=await fixture(t,{staleRemoteReads:true}),initial=await f.storage.getAutonomyTask(TASK,OWNER),initialSteps=await f.storage.listAutonomySteps(TASK);
  const priorReads=initialSteps.filter(step=>step.stepType==="read_files"&&step.status==="completed"&&Number.parseInt(step.stepId,10)>80);
  assert.equal(initialSteps.filter(step=>step.stepType==="read_files"&&Number.parseInt(step.stepId,10)<80).length,3,"obsolete discovery reads remain historical, not carried evidence");
  assert.equal(initial.stateVersion,174);assert.equal(priorReads.length,5);
  for(const step of priorReads){assert.equal(step.input.tool,"repo_read");assert.equal(step.result.truncated,false);assert.equal(Object.hasOwn(step.result,"contentHash"),false);assert.notEqual(canonicalContentHash(step.result.content),f.entries.find(entry=>entry.path===step.result.path).contentHash);}
  const result=await f.recover(),recovered=await f.storage.getAutonomyTask(TASK,OWNER),record=recovered.metadata.failedLocalReadRecoveryHistory[0];
  assert.equal(result.idempotent,false);assert.equal(recovered.stateVersion,175);
  assert.deepEqual(record.originalRemainingReadPaths,REMAINING);assert.deepEqual(record.refreshedReadPaths,PATHS.slice(0,5));
  assert.deepEqual(record.readPaths,[...REMAINING,...PATHS.slice(0,5)]);
  assert.equal(recovered.metadata.activeContinuation.maxSteps,15);
  assert.equal(recovered.retryCount,initial.retryCount);assert.equal(recovered.repairIteration,initial.repairIteration);
  assert.deepEqual(recovered.metadata.continuationRuntimeResumeHistory,initial.metadata.continuationRuntimeResumeHistory);
  assert.deepEqual(recovered.metadata.escalatedRepairHistory,initial.metadata.escalatedRepairHistory);
  const firstOrdinal=recovered.currentStep+1,worker=f.createWorker();
  for(const [index,path] of record.readPaths.entries()){
    assert.equal((await worker.runOnce()).worked,true);
    const step=(await f.storage.listAutonomySteps(TASK)).find(item=>item.stepId===`${firstOrdinal+index}:read_files`);
    assert.equal(step.status,"completed");assert.equal(step.attempt,1);assert.equal(step.result.path,path);assert.equal(step.result.content,f.contents.get(path));
    assert.equal(step.result.contentHash,canonicalContentHash(f.contents.get(path)));assert.equal(step.result.source,"task_owned_local_workspace");assert.equal(step.result.truncated,false);
    assert.equal(f.prompts.length,0,"no provider call before every current candidate has fresh exact bytes");await f.unchanged();
  }
  const allSteps=await f.storage.listAutonomySteps(TASK),current=await f.storage.getAutonomyTask(TASK,OWNER);
  const fresh=allSteps.filter(step=>step.stepType==="read_files"&&step.status==="completed"&&Number.parseInt(step.stepId,10)>=firstOrdinal);
  assert.equal(fresh.length,8);assert.deepEqual(fresh.map(step=>step.result.path).sort(),[...PATHS].sort());
  for(const step of initialSteps)assert.deepEqual(allSteps.find(item=>item.stepId===step.stepId),step,"every historical execution remains immutable");
  assert.equal(current.metadata.steps[current.currentStep].type,"plan_repair");
  await worker.runOnce();
  assert.equal(f.prompts.length,1);assert.deepEqual(f.prompts[0].candidateFiles,PATHS.map(path=>({path,content:f.contents.get(path)})));
  const planning=(await f.storage.listAutonomySteps(TASK)).find(step=>step.stepId===`${firstOrdinal+8}:plan_repair`);assert.equal(planning.errorCode,boundary.code);
  assert.equal((await f.storage.listAutonomySteps(TASK)).filter(step=>Number.parseInt(step.stepId,10)>firstOrdinal+8).length,0);
  assert.deepEqual(current.metadata.continuationRuntimeResumeHistory,initial.metadata.continuationRuntimeResumeHistory);assert.deepEqual(current.metadata.escalatedRepairHistory,initial.metadata.escalatedRepairHistory);
  await f.unchanged();
});

const mutateTask=async(f,alter)=>{const task=await f.storage.getAutonomyTask(TASK,OWNER);alter(task);await f.storage.updateAutonomyTask(TASK,OWNER,task,task.stateVersion);};
const assertRejected=async(f,operation)=>{const before=await f.storage.getAutonomyTask(TASK,OWNER),steps=await f.storage.listAutonomySteps(TASK);await assert.rejects(operation,error=>/failed_local_read|version_conflict|task_not_found|workspace_attestation/.test(error.code||""));assert.deepEqual(await f.storage.getAutonomyTask(TASK,OWNER),before);assert.deepEqual(await f.storage.listAutonomySteps(TASK),steps);await f.unchanged();};

for(const [name,alter] of [
  ["stale authoritative local-read bytes",step=>{step.input.tool="repo_read_task_owned_local";}],
  ["unknown remote-read tool",step=>{step.input.tool="repo_read_unknown";}],
  ["partial remote read",step=>{step.result.truncated=true;}],
])test(`remote-snapshot refresh does not accept ${name}`,async t=>{
  const f=await fixture(t,{staleRemoteReads:true}),step=(await f.storage.listAutonomySteps(TASK)).find(item=>item.stepId==="107:read_files");alter(step);await f.storage.updateAutonomyStep(TASK,step.stepId,step);await assertRejected(f,()=>f.recover());
});

test("seven fresh local reads cannot authorize the planner when the eighth is still a stale remote snapshot",async t=>{
  const f=await fixture(t,{staleRemoteReads:true});await f.recover();const worker=f.createWorker();for(let index=0;index<7;index++)assert.equal((await worker.runOnce()).worked,true);
  const task=await f.storage.getAutonomyTask(TASK,OWNER),plan=task.metadata.steps.find((step,index)=>index>task.currentStep&&step.type==="plan_repair");
  await assert.rejects(()=>f.planner.generate({...plan.input.arguments,currentCommit:f.head}),error=>/failed_local_read|implementation_evidence_incomplete/.test(error.code||""));assert.equal(f.prompts.length,0);await f.unchanged();
});

for(const [name,alter] of [
  ["wrong task",proof=>{proof.taskId="another-task";}],
  ["wrong version",proof=>{proof.expectedVersion=173;}],
  ["wrong repository",proof=>{proof.workspace.repository="another/repository";}],
  ["wrong branch",proof=>{proof.workspace.branch="another-branch";}],
  ["wrong workspace",proof=>{proof.workspace.root+="/other";proof.workspace.gitTopLevel=proof.workspace.root;}],
  ["wrong product HEAD",proof=>{proof.workspace.head="0".repeat(40);} ],
  ["wrong live product tip",proof=>{proof.workspace.liveTip="0".repeat(40);} ],
  ["wrong runtime",proof=>{proof.runtimeVersion=OLD_RUNTIME;}],
  ["dirty hash drift",proof=>{proof.workspace.changedFiles[0].contentHash="0".repeat(64);} ],
  ["raw byte hash drift with unchanged canonical content hash",proof=>{proof.workspace.changedFiles[0].hash="0".repeat(40);} ],
  ["missing dirty file",proof=>{proof.workspace.changedFiles.pop();}],
  ["unrelated dirty file",proof=>{proof.workspace.changedFiles.push({path:"test/unrelated.test.js",contentHash:"0".repeat(64),hashAlgorithm:"git_sha1",hash:"0".repeat(40)});} ],
])test(`failed local-read recovery rejects ${name} without task or product mutation`,async t=>{
  const f=await fixture(t),args=structuredClone(f.input);alter(args.workspaceProof);await assertRejected(f,()=>f.recover(args,{actorType:"scoped_local_worker",workspaceProof:args.workspaceProof}));
});

for(const [name,alter] of [
  ["arbitrary error",step=>{step.errorCode="network_error";step.result.code="network_error";}],
  ["wrong tool",step=>{step.input.tool="repo_read";}],
  ["wrong failed step type",step=>{step.stepType="apply_patch";}],
  ["running execution",step=>{step.status="running";}],
  ["unproven mutation",step=>{step.result.mutationApplied=true;}],
])test(`failed local-read recovery rejects ${name} execution`,async t=>{
  const f=await fixture(t),step=(await f.storage.listAutonomySteps(TASK)).find(item=>item.stepId==="122:read_files");alter(step);await f.storage.updateAutonomyStep(TASK,step.stepId,step);await assertRejected(f,()=>f.recover());
});

test("wrong planned local-read tool remains fail-closed",async t=>{const f=await fixture(t);await mutateTask(f,task=>{task.metadata.steps[121].input.tool="repo_read";});f.input.expectedVersion=175;f.input.workspaceProof.expectedVersion=175;await assertRejected(f,()=>f.recover(f.input,{actorType:"scoped_local_worker",workspaceProof:f.input.workspaceProof}));});

for(const [name,alter] of [
  ["another task's apply lineage",step=>{step.result.taskOwnedDirtyLineage.taskId="another-task";}],
  ["wrong source plan",step=>{step.result.taskOwnedDirtyLineage.sourcePlanStepId="67:plan_repair";}],
  ["wrong source apply",step=>{step.result.taskOwnedDirtyLineage.sourceApplyStepId="42:apply_patch";}],
  ["wrong apply fingerprint",step=>{step.operationFingerprint="0".repeat(64);} ],
  ["drifted complete dirty lineage",step=>{step.result.taskOwnedDirtyLineage.entries[7].contentHash="0".repeat(64);} ],
  ["incomplete six-file lineage",step=>{step.result.taskOwnedDirtyLineage.entries.splice(6);} ],
])test(`failed local-read recovery rejects ${name}`,async t=>{
  const f=await fixture(t),step=(await f.storage.listAutonomySteps(TASK)).find(item=>item.stepId==="80:apply_patch");alter(step);await f.storage.updateAutonomyStep(TASK,step.stepId,step);await assertRejected(f,()=>f.recover());
});

for(const [name,alter] of [
  ["wrong continuation generation",task=>{task.metadata.activeContinuation.generationId="0".repeat(64);} ],
  ["wrong source recovery class",task=>{task.metadata.implementationPlanRecoveryHistory[0].recoveryClass="unrelated_recovery";}],
  ["unconsumed renewal",task=>{task.metadata.continuationRuntimeResumeHistory[0].authorizationConsumed=false;}],
  ["missing prior worker binding",task=>{task.metadata.continuationRuntimeResumeHistory[0].workerId=null;}],
  ["modified remaining read set",task=>{task.metadata.continuationRuntimeResumeHistory[0].remainingReadPaths=PATHS.slice(4);}],
  ["missing consumed repair extension",task=>{task.metadata.escalatedRepairHistory=[];}],
  ["second repair extension",task=>{task.metadata.escalatedRepairHistory.push({...task.metadata.escalatedRepairHistory[0],approvalId:"second"});}],
  ["changed repair iteration",task=>{task.repairIteration=4;}],
])test(`failed local-read recovery rejects ${name} without granting authority`,async t=>{
  const f=await fixture(t);await mutateTask(f,alter);const current=await f.storage.getAutonomyTask(TASK,OWNER);f.input.expectedVersion=current.stateVersion;f.input.workspaceProof.expectedVersion=current.stateVersion;
  await assertRejected(f,()=>f.recover(f.input,{actorType:"scoped_local_worker",workspaceProof:f.input.workspaceProof}));
});

test("an unrelated later durable execution prevents failed-state recovery",async t=>{
  const f=await fixture(t);await f.storage.recordAutonomyStep({taskId:TASK,stepId:"123:read_files",stepType:"read_files",status:"completed",operationFingerprint:"9".repeat(64),result:{path:REMAINING[1],content:f.contents.get(REMAINING[1]),truncated:false}});await assertRejected(f,()=>f.recover());
});

test("wrong authoritative live product branch tip fails closed",async t=>{const f=await fixture(t);f.overrides[BRANCH]="0".repeat(40);await assertRejected(f,()=>f.recover());});
test("wrong authoritative runtime branch tip fails closed",async t=>{const f=await fixture(t);f.overrides[CONTROL_BRANCH]=OLD_RUNTIME;await assertRejected(f,()=>f.recover());});
test("unverified worker proof cannot authorize recovery",async t=>{const f=await fixture(t);await assertRejected(f,()=>f.recover(f.input,{actorType:"owner"}));});

test("exact recovery replay does not renew the window or create a second execution path",async t=>{
  const f=await fixture(t);await f.recover();const first=await f.storage.getAutonomyTask(TASK,OWNER);
  const repeated=await f.recover();assert.equal(repeated.idempotent,true);assert.deepEqual(await f.storage.getAutonomyTask(TASK,OWNER),first);
  await f.createWorker().runOnce();const progressed=await f.storage.getAutonomyTask(TASK,OWNER);
  await assert.rejects(()=>f.recover(),error=>/failed_local_read|version_conflict/.test(error.code||""));assert.deepEqual(await f.storage.getAutonomyTask(TASK,OWNER),progressed);
  assert.equal(progressed.metadata.failedLocalReadRecoveryHistory.length,1);assert.equal(progressed.metadata.continuationRuntimeResumeHistory.length,1);await f.unchanged();
});

for(const [name,alter] of [
  ["historical worker",input=>{input.workerId=OLD_WORKER;}],
  ["unrecognized worker identity",input=>{input.workerId="arbitrary-worker";}],
  ["stale generation",input=>{input.continuationGenerationId=GENERATION;}],
  ["wrong runtime",input=>{input.runtimeVersion=OLD_RUNTIME;}],
  ["wrong workspace",input=>{input.repositoryRoot+="/wrong";}],
  ["wrong repository",input=>{input.repository="another/repository";}],
])test(`recovered worker rejects ${name} before Hands and does not bind it`,async t=>{
  const f=await fixture(t);await f.recover();const before=await f.storage.getAutonomyTask(TASK,OWNER);f.hooks.claim=alter;
  await assert.rejects(()=>f.createWorker().runOnce(),error=>/task_owned_local_read|failed_local_read/.test(error.code||""));assert.equal(f.contexts.length,0);
  assert.deepEqual(await f.storage.getAutonomyTask(TASK,OWNER),before);await f.unchanged();
});

test("one fresh worker binds atomically and a competing worker cannot replace it",async t=>{
  const f=await fixture(t);await f.recover();await f.createWorker().runOnce();const bound=await f.storage.getAutonomyTask(TASK,OWNER);
  assert.equal(bound.metadata.failedLocalReadRecoveryHistory[0].workerId,NEW_WORKER);
  assert.equal(bound.metadata.failedLocalReadRecoveryHistory[0].workerBindingState,"bound");
  await assert.rejects(()=>f.createWorker("persistent-local-33333333-4444-4555-8666-777777777777").runOnce(),error=>/task_owned_local_read|failed_local_read/.test(error.code||""));
  assert.deepEqual(await f.storage.getAutonomyTask(TASK,OWNER),bound);assert.equal(f.contexts.length,1);await f.unchanged();
});

test("simultaneous fresh workers cannot both bind or execute the recovered first read",async t=>{
  const f=await fixture(t);await f.recover();const competitor="persistent-local-33333333-4444-4555-8666-777777777777";
  const results=await Promise.all([f.createWorker().runOnce(),f.createWorker(competitor).runOnce()]);
  assert.equal(results.filter(result=>result.worked===true).length,1);assert.equal(f.contexts.length,1);
  const current=await f.storage.getAutonomyTask(TASK,OWNER),binding=current.metadata.failedLocalReadRecoveryHistory[0];
  assert.equal(binding.workerBindingState,"bound");assert.ok([NEW_WORKER,competitor].includes(binding.workerId));
  assert.equal(current.metadata.continuationRuntimeResumeHistory[0].workerId,OLD_WORKER);await f.unchanged();
});
