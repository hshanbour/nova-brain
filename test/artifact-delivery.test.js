import test from "node:test";
import assert from "node:assert/strict";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createAutoDispatchService} from "../src/autonomy/auto-dispatch.js";
import {createLocalWorkerHandoff} from "../src/autonomy/local-worker-handoff.js";
import {createArtifactDeliveryService,registerArtifactDeliveryTool} from "../src/autonomy/artifact-delivery.js";
import {createTerminalTaskReporter,renderTerminalTaskReport} from "../src/autonomy/terminal-task-reporter.js";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";

const OWNER="owner",REPOSITORY="hshanbour/nova-brain",BRANCH="codex/combined-nova-preview-d5b5-c5bd",SHA="a".repeat(40),SOURCE="coding_11111111111111111111111111111111",CONVERSATION="conversation-one";
const exec=promisify(execFile);

async function fixture(overrides={}){
  const now=()=>new Date("2026-09-26T12:00:00Z"),storage=createInMemoryStorage({clock:now});
  await storage.initialize({owner:{id:OWNER,fullName:"Owner"},projects:[{id:"nova-brain",name:"Nova Brain"}]});
  await storage.ensureConversation({id:CONVERSATION,ownerId:OWNER,title:"Ship artifact"});
  await storage.createAutonomyTask({id:SOURCE,ownerId:OWNER,projectId:"nova-brain",title:"Completed coding",objective:"Create artifact",taskType:"coding_delegation",branch:BRANCH,startingCommit:"b".repeat(40),currentCommit:SHA,metadata:{codingJob:{repository:{slug:REPOSITORY,branch:BRANCH}},terminalReporting:{version:1,conversationId:CONVERSATION,runId:"run-one"},steps:[{type:"delegate_coding"}]}});
  await storage.updateAutonomyTask(SOURCE,OWNER,{status:"completed",completedAt:now().toISOString(),currentCommit:SHA});
  await storage.recordAutonomyStep({taskId:SOURCE,stepId:"1:delegate_coding",stepType:"delegate_coding",capability:"codex_local",operationFingerprint:"coding",status:"completed",result:{status:"completed",summary:"Implemented and tested.",finalLocalSha:SHA,filesChanged:["src/example.js"],tests:[{name:"focused",status:"passed",summary:null}],pushOccurred:false,deploymentOccurred:false,executor:{localRef:`refs/nova/coding-jobs/${SOURCE}`}}});
  const tools=createToolRegistry(),runtime=createWorkerRuntime({storage,ownerId:OWNER,approvedBranch:BRANCH,approvedRepository:REPOSITORY,clock:now,capabilities:["vercel_preview","reasoning"],toolRegistry:tools});
  const adapters={verifyRemote:async()=>({currentTip:SHA,ancestors:{}}),findPreview:async()=>({id:"dpl_exact",url:"preview.example.test",status:"READY",target:null,sha:SHA,branch:BRANCH}),verifyDeployment:async()=>({id:"dpl_exact",url:"preview.example.test",status:"READY",target:null,sha:SHA,branch:BRANCH}),verifyHealth:async()=>({status:200,url:"https://preview.example.test/api/health",health:"online",storage:"ready"})};
  const delivery=createArtifactDeliveryService({runtime,storage,ownerId:OWNER,approvedRepository:REPOSITORY,approvedBranch:BRANCH,clock:now,...adapters,...overrides});registerArtifactDeliveryTool(tools,{service:delivery});
  return{storage,runtime,delivery,auto:createAutoDispatchService({storage,ownerId:OWNER,approvedBranch:BRANCH,approvedRepository:REPOSITORY,clock:now}),handoff:createLocalWorkerHandoff({storage,ownerId:OWNER,approvedBranch:BRANCH,clock:now}),now};
}

test("artifact delivery is exact-SHA approval gated and completes deterministically",async()=>{
  const f=await fixture(),created=await f.delivery.create(SOURCE,{conversationId:CONVERSATION,runId:"run-one"}),taskId=created.task.id;
  assert.match(taskId,/^shipping_[a-f0-9]{32}$/);assert.equal(created.task.status,"waiting_for_approval");assert.equal((await f.auto.next({workerId:"worker",branch:BRANCH})).dispatched,false);
  const approval=await f.storage.decideApproval(created.approval.id,OWNER,"approved");await f.runtime.resumeApproval(taskId,approval);
  const dispatch=await f.auto.next({workerId:"worker",branch:BRANCH});assert.equal(dispatch.dispatched,true,JSON.stringify({dispatch,task:await f.storage.getAutonomyTask(taskId,OWNER),approval:await f.storage.getApproval(created.approval.id,OWNER)}));assert.deepEqual([dispatch.task.mode,dispatch.task.stepType,dispatch.task.expectedCommit],["local_handoff","push",SHA]);
  const claimed=await f.handoff.claim({workerId:"worker",runtimeVersion:"runtime",repository:REPOSITORY,repositoryRoot:"C:/trusted",capabilities:["approved_delivery_git_push"],expectedBranch:BRANCH,expectedCommit:SHA,taskId,idempotencyKey:`${taskId}:push`});
  assert.equal(claimed.handoff.approvedDelivery.reviewedCommit,SHA);assert.equal(claimed.handoff.arguments.commitSha,SHA);
  await f.handoff.complete(claimed.handoff.handoffId,{taskId,workerId:"worker",idempotencyKey:`${taskId}:push`,result:{ok:true,commitSha:SHA,branch:BRANCH}});
  for(let index=0;index<4;index+=1){const next=await f.auto.next({workerId:"worker",branch:BRANCH});assert.equal(next.dispatched,true);await f.runtime.tickTask(taskId,{idempotencyKey:`server:${index}:${next.task.stateVersion}`});}
  const task=await f.storage.getAutonomyTask(taskId,OWNER),steps=await f.storage.listAutonomySteps(taskId);assert.equal(task.status,"completed");assert.equal(steps.filter(step=>step.stepType==="push").length,1);assert.equal(steps.filter(step=>step.stepType==="deploy_preview").length,1);assert.equal(steps.filter(step=>step.stepType==="verify_preview").length,2);
  const report=renderTerminalTaskReport(task,steps);assert.match(report,new RegExp(SHA));assert.match(report,/dpl_exact/);assert.match(report,/preview\.example\.test/);assert.match(report,/HTTP 200/);
  assert.equal((await f.delivery.create(SOURCE,{conversationId:CONVERSATION})).task.id,taskId);assert.equal((await f.auto.next({workerId:"worker",branch:BRANCH})).dispatched,false);
});

test("artifact delivery fails closed for wrong source bindings and remains exactly-once across reporter restart",async()=>{
  const f=await fixture();await assert.rejects(()=>f.delivery.create("coding_22222222222222222222222222222222"),error=>error.code==="artifact_delivery_source_invalid");
  const created=await f.delivery.create(SOURCE,{conversationId:CONVERSATION}),task=await f.storage.getAutonomyTask(created.task.id,OWNER);await f.storage.updateAutonomyTask(task.id,OWNER,{status:"completed",completedAt:f.now().toISOString(),resultSummary:"Verified shipping result."},task.stateVersion);
  const first=createTerminalTaskReporter({storage:f.storage,ownerId:OWNER}),second=createTerminalTaskReporter({storage:f.storage,ownerId:OWNER});await first.reconcile();await second.reconcile();
  const messages=(await f.storage.listMessages(CONVERSATION,OWNER,{limit:20})).filter(message=>message.role==="assistant"&&message.content.includes(`Task report — ${task.id}`));assert.equal(messages.length,1);
});

test("artifact delivery rejects main and a mutated approval contract",async()=>{
  const f=await fixture(),created=await f.delivery.create(SOURCE,{conversationId:CONVERSATION}),approval=await f.storage.decideApproval(created.approval.id,OWNER,"approved");
  await f.storage.updateAutonomyTask(created.task.id,OWNER,{approvalState:{...created.task.approvalState,arguments:{...created.task.approvalState.arguments,commitSha:"c".repeat(40)}}},created.task.stateVersion);
  await assert.rejects(()=>f.runtime.resumeApproval(created.task.id,approval),error=>error.code==="approval_invalidated");
  assert.throws(()=>createArtifactDeliveryService({runtime:f.runtime,storage:f.storage,ownerId:OWNER,approvedRepository:REPOSITORY,approvedBranch:"main",verifyRemote:async()=>({currentTip:SHA}),findPreview:async()=>null,verifyDeployment:async()=>({}),verifyHealth:async()=>({})}),error=>error.code==="production_target_forbidden");
});

test("post-push continuation fails closed when the remote branch tip is not the approved SHA",async()=>{
  const f=await fixture({verifyRemote:async()=>({currentTip:"f".repeat(40),ancestors:{}})}),created=await f.delivery.create(SOURCE,{conversationId:CONVERSATION}),approval=await f.storage.decideApproval(created.approval.id,OWNER,"approved");await f.runtime.resumeApproval(created.task.id,approval);
  const dispatch=await f.auto.next({workerId:"worker",branch:BRANCH}),claimed=await f.handoff.claim({workerId:"worker",runtimeVersion:"runtime",repository:REPOSITORY,repositoryRoot:"C:/trusted",capabilities:["approved_delivery_git_push"],expectedBranch:BRANCH,expectedCommit:SHA,taskId:created.task.id,idempotencyKey:"push"});assert.equal(dispatch.dispatched,true);await f.handoff.complete(claimed.handoff.handoffId,{taskId:created.task.id,workerId:"worker",idempotencyKey:"push",result:{ok:true,commitSha:SHA,branch:BRANCH}});
  await f.auto.next({workerId:"worker",branch:BRANCH});const result=await f.runtime.tickTask(created.task.id,{idempotencyKey:"verify-remote"});assert.equal(result.status,"failed");assert.equal((await f.storage.getAutonomyTask(created.task.id,OWNER)).errorCode,"artifact_delivery_remote_mismatch");
});

test("exhausted Preview discovery resumes the same task without repeating push or approval",async()=>{
  let discoverable=false,findCalls=0;
  const f=await fixture({findPreview:async()=>{findCalls+=1;if(!discoverable)throw Object.assign(new Error("Preview discovery failed."),{code:"deployment_discovery_failed",retryable:true,safeDiagnostics:{stage:"discovery",upstreamStatus:401,providerError:"unauthorized",providerErrorCode:"forbidden",projectBindingMatch:true,teamBindingMatch:true}});return{id:"dpl_existing",url:"existing.example.test",status:"READY",target:null,sha:SHA,branch:BRANCH};}}),created=await f.delivery.create(SOURCE,{conversationId:CONVERSATION}),approval=await f.storage.decideApproval(created.approval.id,OWNER,"approved");
  await f.runtime.resumeApproval(created.task.id,approval);await f.auto.next({workerId:"worker",branch:BRANCH});const claimed=await f.handoff.claim({workerId:"worker",runtimeVersion:"runtime",repository:REPOSITORY,repositoryRoot:"C:/trusted",capabilities:["approved_delivery_git_push"],expectedBranch:BRANCH,expectedCommit:SHA,taskId:created.task.id,idempotencyKey:"push-once"});await f.handoff.complete(claimed.handoff.handoffId,{taskId:created.task.id,workerId:"worker",idempotencyKey:"push-once",result:{ok:true,commitSha:SHA,branch:BRANCH}});
  let task=await f.storage.getAutonomyTask(created.task.id,OWNER);task=await f.storage.updateAutonomyTask(task.id,OWNER,{maxRetries:0},task.stateVersion);await f.auto.next({workerId:"worker",branch:BRANCH});const failed=await f.runtime.tickTask(task.id,{idempotencyKey:"discovery-fails"});assert.equal(failed.status,"failed");task=await f.storage.getAutonomyTask(task.id,OWNER);assert.equal(task.errorCode,"deployment_discovery_failed");assert.equal(task.currentStep,1);const failedStep=(await f.storage.listAutonomySteps(task.id)).find(step=>step.stepType==="deploy_preview");assert.deepEqual(failedStep.result.diagnostics,{stage:"discovery",upstreamStatus:401,providerError:"unauthorized",providerErrorCode:"forbidden",projectBindingMatch:true,teamBindingMatch:true});
  const reporter=createTerminalTaskReporter({storage:f.storage,ownerId:OWNER});await reporter.reconcile();discoverable=true;const resumed=await f.delivery.create(SOURCE,{conversationId:CONVERSATION});assert.equal(resumed.task.id,created.task.id);assert.equal(resumed.recovered,true);assert.equal(resumed.task.status,"queued");assert.equal(resumed.task.currentStep,1);assert.equal((await f.storage.listApprovals(OWNER)).filter(item=>item.runId===task.id).length,1);
  for(let index=0;index<4;index+=1){const next=await f.auto.next({workerId:"worker",branch:BRANCH});assert.equal(next.dispatched,true);await f.runtime.tickTask(task.id,{idempotencyKey:`resume:${index}`});}
  task=await f.storage.getAutonomyTask(task.id,OWNER);const steps=await f.storage.listAutonomySteps(task.id);assert.equal(task.status,"completed");assert.equal(steps.filter(step=>step.stepType==="push").length,1);assert.equal(steps.filter(step=>step.stepType==="deploy_preview"&&step.status==="completed").length,1);assert.equal(task.metadata.artifactDeliveryDiscoveryRecovery.deploymentId,"dpl_existing");assert.equal(findCalls,3);
  await reporter.reconcile();await createTerminalTaskReporter({storage:f.storage,ownerId:OWNER}).reconcile();const reports=(await f.storage.listMessages(CONVERSATION,OWNER,{limit:50})).filter(message=>message.role==="assistant"&&message.content.includes(`Task report — ${task.id}`));assert.equal(reports.filter(message=>message.content.includes("Status: completed")).length,1);
});

test("discovery recovery fails closed unless the exact existing Preview is proven",async()=>{
  const f=await fixture({findPreview:async()=>null}),created=await f.delivery.create(SOURCE,{conversationId:CONVERSATION}),approval=await f.storage.decideApproval(created.approval.id,OWNER,"approved");await f.runtime.resumeApproval(created.task.id,approval);await f.auto.next({workerId:"worker",branch:BRANCH});const claimed=await f.handoff.claim({workerId:"worker",runtimeVersion:"runtime",repository:REPOSITORY,repositoryRoot:"C:/trusted",capabilities:["approved_delivery_git_push"],expectedBranch:BRANCH,expectedCommit:SHA,taskId:created.task.id,idempotencyKey:"push"});await f.handoff.complete(claimed.handoff.handoffId,{taskId:created.task.id,workerId:"worker",idempotencyKey:"push",result:{ok:true,commitSha:SHA,branch:BRANCH}});let task=await f.storage.getAutonomyTask(created.task.id,OWNER);task=await f.storage.updateAutonomyTask(task.id,OWNER,{status:"failed",currentStep:1,currentPhase:"deploy_preview",retryCount:10,maxRetries:10,errorCode:"deployment_discovery_failed",completedAt:f.now().toISOString()},task.stateVersion);await f.storage.recordAutonomyStep({taskId:task.id,stepId:"2:deploy_preview",stepType:"deploy_preview",capability:"vercel_preview",operationFingerprint:"failed-discovery",status:"failed",errorCode:"deployment_discovery_failed",result:{message:"Preview discovery failed."}});await assert.rejects(()=>f.delivery.create(SOURCE,{conversationId:CONVERSATION}),error=>error.code==="artifact_delivery_recovery_preview_unproven");assert.equal((await f.storage.getAutonomyTask(task.id,OWNER)).status,"failed");
});

test("the bounded Git tool pushes only the exact approved SHA to a disposable remote",async()=>{
  const root=await mkdtemp(join(tmpdir(),"nova-shipping-cert-")),remote=`${root}-remote.git`;
  try{
    await exec("git",["init","--initial-branch",BRANCH,root]);await exec("git",["-C",root,"config","user.name","Nova Certification"]);await exec("git",["-C",root,"config","user.email","nova@example.test"]);await writeFile(join(root,"README.md"),"certified\n");await exec("git",["-C",root,"add","README.md"]);await exec("git",["-C",root,"commit","-m","certification"]);const {stdout}=await exec("git",["-C",root,"rev-parse","HEAD"]),sha=stdout.trim();await exec("git",["init","--bare",remote]);await exec("git",["-C",root,"remote","add","origin",remote]);
    const registry=createToolRegistry();registerHandsTools(registry,{root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:BRANCH}});const result=await registry.execute("git_push",{branch:BRANCH,commitSha:sha},{runId:"disposable-shipping-cert"});assert.equal(result.commitSha,sha);assert.equal((await exec("git",["--git-dir",remote,"rev-parse",`refs/heads/${BRANCH}`])).stdout.trim(),sha);await assert.rejects(()=>registry.execute("git_push",{branch:"main",commitSha:sha},{runId:"forbidden"}),error=>error.code==="branch_not_allowed");
  }finally{await rm(root,{recursive:true,force:true});await rm(remote,{recursive:true,force:true});}
});
