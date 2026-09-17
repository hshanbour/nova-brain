import test from "node:test";
import assert from "node:assert/strict";
import {Readable} from "node:stream";
import {createHmac} from "node:crypto";
import {createApi} from "../src/http/api.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {seedPlanningRecoveryFixture,PLANNING_TOKEN} from "./planning-scope-fixture.js";

function request(url,input,token=PLANNING_TOKEN){const stream=Readable.from([JSON.stringify(input)]);stream.method="POST";stream.url=url;stream.headers={"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})};return stream;}
function response(){let body="";return{setHeader(){},end(value=""){body+=value;},get body(){return body;}};}
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const sign=proof=>createHmac("sha256",PLANNING_TOKEN).update(JSON.stringify(stable(proof))).digest("hex");
async function fixture(){
  const f=await seedPlanningRecoveryFixture(),calls=[];
  const service=createSelfDevelopmentService({...f.options,currentCommit:f.runtimeVersion});
  const guardedService={requestPlanningScopeRecovery:async(...args)=>{calls.push("request");return service.requestPlanningScopeRecovery(...args);},recoverPlanningScopeFailure:async(...args)=>{calls.push("recover");return service.recoverPlanningScopeFailure(...args);}};
  const app=createApi({agent:{tools:{list(){return[];},async execute(){assert.fail("An approval decision must not invoke a product/recovery tool");}}},config:{allowedOrigins:[],maxBodyBytes:128*1024,localWorkerToken:PLANNING_TOKEN},storage:f.storage,initialize:async()=>{},ownerId:f.ownerId,selfDevelopment:guardedService,workerRuntime:{get:id=>f.runtime.get(id),async resumeApproval(){assert.fail("Approval decision cannot resume the task");},async control(){assert.fail("Approval decision cannot control the task");}},logger:{info(){},error(){}}});
  const post=async(route,input=f.input,token=PLANNING_TOKEN)=>{const out=response();await app.handle(request(route,input,token),out);return{status:out.statusCode,body:JSON.parse(out.body)};};
  const path=suffix=>`/api/admin/self-development/tasks/${f.taskId}/${suffix}`;
  return{...f,app,service,calls,post,path};
}

for(const route of ["request-planning-scope-recovery","recover-planning-scope"]){
  for(const [name,token] of [["missing",null],["invalid","invalid-synthetic-worker-token"]])test(`${route} rejects ${name} bearer before service or durable mutation`,async()=>{
    const f=await fixture(),task=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId),approvals=await f.storage.listApprovals(f.ownerId,{limit:100});
    const out=await f.post(f.path(route),f.input,token);assert.equal(out.status,401);assert.equal(f.calls.length,0);
    assert.deepEqual(await f.runtime.get(f.taskId),task);assert.deepEqual(await f.runtime.steps(f.taskId),steps);assert.deepEqual(await f.storage.listApprovals(f.ownerId,{limit:100}),approvals);
  });
  for(const [name,alter] of [["missing signature",input=>{delete input.workspaceProofSignature;}],["invalid signature",input=>{input.workspaceProofSignature="0".repeat(64);}],["missing workspace proof",input=>{delete input.workspaceProof;}],["unsigned byte drift",input=>{input.workspaceProof.workspace.changedFiles[0].hash="0".repeat(40);}]])test(`${route} rejects ${name} despite valid bearer`,async()=>{
    const f=await fixture(),task=await f.runtime.get(f.taskId),input=structuredClone(f.input);alter(input);
    const out=await f.post(f.path(route),input);assert.equal(out.status,403);assert.equal(out.body.code,"workspace_attestation_unauthorized");assert.equal(f.calls.length,0);assert.deepEqual(await f.runtime.get(f.taskId),task);
  });
}

test("authenticated approval request records only one exact pending owner decision and leaves v201/history unchanged",async()=>{
  const f=await fixture(),task=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId),before=await f.storage.listApprovals(f.ownerId,{limit:100});
  const first=await f.post(f.path("request-planning-scope-recovery"));assert.equal(first.status,200);assert.equal(first.body.idempotent,false);assert.equal(first.body.stateVersion,201);
  const approval=first.body.approval;assert.equal(approval.status,"pending");assert.equal(approval.tool,"self_development_planning_scope_recovery");assert.equal(approval.runId,f.taskId);
  assert.equal(approval.arguments.maxSteps,2);assert.equal(approval.arguments.runtimeMinutes,15);assert.equal(approval.arguments.maxProductMutations,0);assert.equal(approval.arguments.maxAdditionalAttempts,0);
  const duplicate=await f.post(f.path("request-planning-scope-recovery"));assert.equal(duplicate.status,200);assert.equal(duplicate.body.idempotent,true);assert.equal(duplicate.body.approval.id,approval.id);
  assert.equal((await f.storage.listApprovals(f.ownerId,{limit:100})).length,before.length+1);assert.deepEqual(await f.runtime.get(f.taskId),task);assert.deepEqual(await f.runtime.steps(f.taskId),steps);
});

test("normal owner approval decision records authorization only without resume or tool execution",async()=>{
  const f=await fixture(),pending=await f.post(f.path("request-planning-scope-recovery")),task=await f.runtime.get(f.taskId),steps=await f.runtime.steps(f.taskId),id=pending.body.approval.id;
  const out=await f.post(`/api/approvals/${id}/decision`,{decision:"approved"});assert.equal(out.status,200);assert.equal(out.body.approval.status,"approved");assert.deepEqual(out.body.execution,{authorized:true,approvalId:id});
  assert.equal((await f.storage.getApproval(id,f.ownerId)).status,"approved");assert.deepEqual(await f.runtime.get(f.taskId),task);assert.deepEqual(await f.runtime.steps(f.taskId),steps);assert.deepEqual(f.calls,["request"]);
  const duplicate=await f.post(f.path("request-planning-scope-recovery"));assert.equal(duplicate.body.idempotent,true);assert.equal(duplicate.body.approval.id,id);
});

test("pending approval cannot recover and returns the exact structured precondition without mutating v201",async()=>{
  const f=await fixture(),pending=await f.post(f.path("request-planning-scope-recovery")),task=await f.runtime.get(f.taskId);
  const out=await f.post(f.path("recover-planning-scope"),{...f.input,approvalId:pending.body.approval.id});assert.equal(out.status,409);assert.equal(out.body.code,"planning_scope_recovery_precondition_failed");assert.equal(out.body.diagnostics.predicate,"exact_owner_approval");assert.equal(out.body.diagnostics.mutationApplied,false);assert.deepEqual(await f.runtime.get(f.taskId),task);
});

test("a valid signature cannot authorize wrong task/workspace binding in an approval request",async()=>{
  const f=await fixture(),task=await f.runtime.get(f.taskId),input=structuredClone(f.input);input.workspaceProof.workspace.root+="/wrong";input.workspaceProof.workspace.gitTopLevel+="/wrong";input.workspaceProofSignature=sign(input.workspaceProof);
  const out=await f.post(f.path("request-planning-scope-recovery"),input);assert.equal(out.status,409);assert.equal(out.body.code,"planning_scope_recovery_precondition_failed");assert.equal(out.body.diagnostics.predicate,"current_workspace");assert.deepEqual(await f.runtime.get(f.taskId),task);
});
