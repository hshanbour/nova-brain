import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {Readable} from "node:stream";
import {createHash} from "node:crypto";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
import {createAutoDispatchService} from "../src/autonomy/auto-dispatch.js";
import {createLocalWorkerHandoff} from "../src/autonomy/local-worker-handoff.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createSelfDevelopmentImplementationPlanner} from "../src/autonomy/self-development-implementation-planner.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createApi} from "../src/http/api.js";
import {PLANNING_SCOPE_RECOVERY_CLASS,validatePlanningScopeReadEvidence} from "../src/autonomy/planning-scope-recovery.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {seedPlanningRecoveryFixture,PLANNING_TOKEN} from "./planning-scope-fixture.js";

const run=promisify(execFile);
const PATHS=["assets/console.css","assets/console.js","assets/voice-input.js","index.html","test/composer-dictation.test.js","test/composer-voice-console.integration.test.js","test/console-static.test.js","test/voice-input.test.js"];
const BRANCH="feat/nova-brain-mvp-foundation",REPOSITORY="hshanbour/nova-brain";
const WORKER="persistent-local-abcdef12-3456-4789-8abc-def012345678";

// All eight files below are synthetic temp-repository bytes. No live Nova task,
// credentials, network endpoint, product workspace or actual test execution is
// reachable. Real planner, dispatch, worker, handoff and Hands implementations
// are exercised; product writes are forbidden at the tool execution boundary.
async function fixture(t,{output}={}){
  const root=await mkdtemp(join(tmpdir(),"nova-planning-scope-e2e-"));
  t.after(async()=>{
    assert.equal(dirname(resolve(root)),resolve(tmpdir()));
    assert.ok(root.includes("nova-planning-scope-e2e-"));
    await rm(root,{recursive:true,force:true});
  });
  const git=async(...args)=>(await run("git",args,{cwd:root,windowsHide:true})).stdout.trim();
  const contents=new Map(PATHS.map((path,index)=>[path,path.endsWith(".css")?`.fixture-${index} { color: green; }\n`:path.endsWith(".html")?"<!doctype html><main>Current synthetic fixture</main>\n":`export const currentFixture${index} = ${index};\n`]));
  for(const path of PATHS){await mkdir(dirname(join(root,path)),{recursive:true});if(path!==PATHS[5])await writeFile(join(root,path),"/* synthetic committed base */\n");}
  await git("init","-b",BRANCH);await git("config","core.autocrlf","false");
  await git("config","user.name","Synthetic Runtime Verification");await git("config","user.email","fixture@example.invalid");
  await git("remote","add","origin",`https://github.com/${REPOSITORY}.git`);
  await git("add",".");await git("commit","-m","synthetic planning continuation baseline");
  const head=await git("rev-parse","HEAD");
  for(const [path,content] of contents)await writeFile(join(root,path),content);
  const initialStatus=await git("status","--porcelain=v1","--untracked-files=all");
  const fixtureTime=Math.max(Date.now(),Date.parse("2026-09-14T17:00:00.000Z"));
  const clock=()=>new Date(fixtureTime);
  const seed=await seedPlanningRecoveryFixture({root,head,contents,clock});
  const {storage}=seed;
  const ownerId=seed.options.ownerId,taskId=seed.options.taskId,runtimeVersion=seed.options.runtimeVersion;
  const service=createSelfDevelopmentService({...seed.options,currentCommit:runtimeVersion});
  const authorize=async()=>{
    assert.equal(typeof service.requestPlanningScopeRecovery,"function","The real service must expose the owner-approval request route");
    const before=await storage.getAutonomyTask(taskId,ownerId);
    const requested=await service.requestPlanningScopeRecovery(taskId,seed.input,seed.actor);
    assert.equal(requested.approval.status,"pending");
    assert.deepEqual(await storage.getAutonomyTask(taskId,ownerId),before,"Requesting authorization does not mutate the task");
    await storage.decideApproval(requested.approval.id,ownerId,"approved");
    seed.input.approvalId=requested.approval.id;
    return requested.approval.arguments;
  };
  const recover=()=>service.recoverPlanningScopeFailure(taskId,seed.input,seed.actor);
  const prompts=[],executions=[],requests=[];
  const hooks={claim:()=>{},execution:()=>{}};
  const planner=createSelfDevelopmentImplementationPlanner({storage,ownerId,runtimeVersion,clock,modelProvider:{async generate(request){
    const prompt=JSON.parse(request.message.split("\n")[1]);prompts.push(prompt);
    const value=output?output(prompt):{
      summary:"Synthetic same-scope replacement for pre-mutation verification only",
      files:[{path:PATHS[2],operation:"replace",content:"export const syntheticPreflightReplacement = true;\n",reason:"Synthetic acceptance probe",intendedChanges:["Replace the synthetic marker"]}],
      focusedTests:[{path:PATHS[5],kind:"existing"}],
      acceptanceMapping:[{criterion:prompt.acceptanceCriteria[0],files:[PATHS[2]]}],riskLevel:"low",
    };
    return{type:"final",message:JSON.stringify(value)};
  }}});
  const planningTools=createToolRegistry();
  planningTools.register({name:"self_development_plan_implementation",execute:value=>planner.generate(value)});
  const taskWorker=createWorkerRuntime({storage,ownerId,toolRegistry:planningTools,clock});
  const handoff=createLocalWorkerHandoff({storage,ownerId,approvedBranch:BRANCH,clock});
  const dispatch=createAutoDispatchService({storage,ownerId,clock});
  const hands=createToolRegistry();registerHandsTools(hands,{root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:BRANCH},storage,ownerId});
  const client={async request(path,args){
    requests.push({path,args:structuredClone(args)});
    if(path==="/api/admin/worker/auto-dispatch/next")return dispatch.next(args);
    if(path==="/api/admin/worker/handoff/claim"){hooks.claim(args);return handoff.claim(args);}
    if(path===`/api/autonomy/worker/tasks/${taskId}/tick`)return taskWorker.tickTask(taskId,args);
    const match=path.match(/^\/api\/admin\/worker\/handoff\/([^/]+)\/(complete|fail)$/);
    if(match)return handoff[match[2]](decodeURIComponent(match[1]),args);
    assert.fail(`No live endpoint or unrelated operation is allowed: ${path}`);
  }};
  const worker=createPersistentLocalWorker({client,root,branch:BRANCH,repository:REPOSITORY,runtimeVersion,workerId:WORKER,registry:{async execute(name,args,context){
    assert.equal(name,"repo_validate_patch","Only non-mutating Hands preflight may execute in the successor");
    hooks.execution(args,context);executions.push(structuredClone({name,args,context}));
    return hands.execute(name,args,context);
  }}});
  const current=()=>storage.getAutonomyTask(taskId,ownerId);
  const unchanged=async()=>{
    assert.equal(await git("rev-parse","HEAD"),head);
    assert.equal(await git("status","--porcelain=v1","--untracked-files=all"),initialStatus);
    for(const [path,content] of contents)assert.equal(await readFile(join(root,path),"utf8"),content);
  };
  return{...seed,service,authorize,recover,root,head,contents,clock,ownerId,taskId,runtimeVersion,prompts,executions,requests,hooks,planner,taskWorker,handoff,dispatch,hands,worker,current,unchanged};
}

test("real v201-shaped planning continuation reaches actual Hands preflight and a stopped focused-test scheduling boundary without product mutation",async t=>{
  const f=await fixture(t),before=await f.current(),originalSteps=await f.storage.listAutonomySteps(f.taskId);
  assert.equal(before.stateVersion,201);assert.equal(before.status,"failed");
  assert.equal(before.currentStep,139);assert.equal(before.currentPhase,"read_files");
  assert.equal(originalSteps.find(step=>step.stepId==="140:plan_repair").result.diagnostics.classification,"unrelated");
  await f.authorize();const result=await f.recover(),recovered=await f.current();
  assert.equal(recovered.stateVersion,202);
  assert.equal(recovered.metadata.activeContinuation.recoveryClass,PLANNING_SCOPE_RECOVERY_CLASS);
  assert.equal(recovered.metadata.activeContinuation.maxSteps,2);
  assert.equal(recovered.metadata.activeContinuation.runtimeMinutes,15);
  assert.equal(recovered.metadata.planningScopeRecoveryHistory.length,1);
  assert.equal(result.recovery.maxProductMutations,0);assert.equal(result.recovery.maxAdditionalAttempts,0);
  assert.deepEqual(recovered.metadata.failedLocalReadRecoveryHistory,before.metadata.failedLocalReadRecoveryHistory);
  assert.deepEqual(recovered.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);
  assert.equal(recovered.repairIteration,before.repairIteration);assert.equal(recovered.retryCount,before.retryCount);
  const proof=validatePlanningScopeReadEvidence(recovered,await f.storage.listAutonomySteps(f.taskId));
  assert.equal(proof.reads.size,8);assert.deepEqual([...proof.reads],PATHS.map(path=>[path,f.contents.get(path)]));
  await f.unchanged();

  assert.equal((await f.worker.runOnce()).worked,true);
  const planned=await f.current(),plan=planned.metadata.selfDevelopmentImplementationPlan;
  assert.equal(f.prompts.length,1);
  assert.deepEqual(f.prompts[0].candidateFiles,PATHS.map(path=>({path,content:f.contents.get(path)})));
  assert.equal(f.prompts[0].availableEvidenceExpansionTests.includes("test/console-client.test.js"),false);
  assert.equal(JSON.stringify(f.prompts).includes("STALE"),false);
  assert.deepEqual(plan.evidencePaths,PATHS);
  assert.deepEqual(plan.files.map(file=>file.path),[PATHS[2]]);
  assert.equal(plan.files[0].expectedContent,f.contents.get(PATHS[2]));
  assert.equal(planned.metadata.steps[planned.currentStep].type,"validate_patch");
  await f.unchanged();

  assert.equal((await f.worker.runOnce()).worked,true);
  const boundary=await f.current(),steps=await f.storage.listAutonomySteps(f.taskId);
  assert.equal(f.executions.length,1);assert.equal(f.executions[0].name,"repo_validate_patch");
  const validation=steps.find(step=>step.stepType==="validate_patch");
  assert.equal(validation.status,"completed");assert.equal(validation.result.preMutationValidated,true);
  assert.equal(validation.result.mutationApplied,false);
  assert.equal(boundary.status,"blocked");
  assert.equal(boundary.currentPhase,"validate_patch");
  assert.equal(boundary.metadata.planningScopeBoundary.kind,"focused_test_scheduling_ready");
  assert.equal(boundary.metadata.planningScopeBoundary.tool,"test_run");
  assert.deepEqual(boundary.metadata.planningScopeBoundary.arguments.files,[PATHS[5]]);
  assert.equal(boundary.metadata.planningScopeBoundary.executionAuthorized,false);
  assert.equal(boundary.metadata.planningScopeBoundary.mutationApplied,false);
  assert.equal(boundary.metadata.planningScopeRecoveryHistory[0].consumed,true);
  assert.equal(steps.filter(step=>Number.parseInt(step.stepId,10)>140&&["apply_patch","run_focused_tests","run_full_tests"].includes(step.stepType)).length,0);
  assert.deepEqual(await f.worker.runOnce(),{worked:false});
  assert.equal(boundary.repairIteration,before.repairIteration);assert.equal(boundary.retryCount,before.retryCount);
  assert.deepEqual(boundary.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);
  assert.deepEqual(boundary.metadata.failedLocalReadRecoveryHistory,before.metadata.failedLocalReadRecoveryHistory);
  for(const original of originalSteps)assert.deepEqual(steps.find(step=>step.stepId===original.stepId),original);
  await f.unchanged();
});

test("a manually proposed unrelated focused test still rejects the successor before any local tool or ninth editable path",async t=>{
  const f=await fixture(t,{output:prompt=>({
    summary:"Synthetic rejected evidence proposal",
    files:[{path:PATHS[2],operation:"replace",content:"export const syntheticRejectedPlan = true;\n",reason:"Synthetic probe",intendedChanges:["Replace synthetic marker"]}],
    focusedTests:[{path:"test/console-client.test.js",kind:"existing"}],
    acceptanceMapping:[{criterion:prompt.acceptanceCriteria[0],files:[PATHS[2]]}],riskLevel:"low",
  })});
  await f.authorize();await f.recover();const before=await f.current();
  assert.equal((await f.worker.runOnce()).worked,true);
  const rejected=await f.current(),step=(await f.storage.listAutonomySteps(f.taskId)).find(item=>Number.parseInt(item.stepId,10)>140&&item.stepType==="plan_repair");
  assert.equal(step.status,"failed");assert.equal(step.errorCode,"implementation_scope_violation");
  assert.deepEqual(step.result.diagnostics.validationIssues,["planning_scope_expansion_forbidden"]);
  assert.equal(step.result.diagnostics.mutationApplied,false);
  assert.deepEqual(step.result.diagnostics.rejectedPlanEvidence.requestedFocusedTests.map(item=>item.path),["test/console-client.test.js"]);
  assert.equal(f.executions.length,0);
  assert.equal(rejected.metadata.planningScopeRecoveryHistory.length,1);
  assert.deepEqual(rejected.metadata.planningScopeRecoveryHistory[0].requiredPaths,PATHS);
  assert.deepEqual(rejected.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);
  assert.equal(rejected.repairIteration,before.repairIteration);
  assert.equal(f.prompts[0].availableEvidenceExpansionTests.includes("test/console-client.test.js"),false);
  await f.unchanged();
});

for(const [name,alter] of [
  ["wrong runtime",args=>{args.runtimeVersion="0".repeat(40);}],
  ["wrong continuation generation",args=>{args.continuationGenerationId="0".repeat(64);}],
  ["wrong product workspace",args=>{args.repositoryRoot+="/different";}],
  ["wrong repository",args=>{args.repository="another/repository";}],
  ["non-worker identity",args=>{args.workerId="another-worker";}],
])test(`planning preflight handoff rejects ${name} before Hands or worker binding`,async t=>{
  const f=await fixture(t);await f.authorize();await f.recover();await f.worker.runOnce();
  const before=await f.current(),stepsBefore=await f.storage.listAutonomySteps(f.taskId);
  f.hooks.claim=alter;
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="planning_scope_recovery_precondition_failed");
  assert.equal(f.executions.length,0);
  assert.deepEqual(await f.current(),before);
  assert.deepEqual(await f.storage.listAutonomySteps(f.taskId),stepsBefore);
  await f.unchanged();
});

test("the planning generation cannot invoke normal apply_patch even if a caller drops planning-only payload markers",async t=>{
  const f=await fixture(t);await f.authorize();await f.recover();await f.worker.runOnce();await f.worker.runOnce();
  const execution=f.executions[0],before=await f.current();
  const withMarker=structuredClone(execution.args);
  await assert.rejects(()=>f.hands.execute("repo_apply_patch",withMarker,execution.context),error=>error.code==="planning_scope_mutation_forbidden");
  const withoutMarker=structuredClone(withMarker);delete withoutMarker.planProvenance.planningOnly;delete withoutMarker.planProvenance.planningScope;
  const withoutContext={runId:f.taskId,stepId:"forged:apply_patch"};
  await assert.rejects(()=>f.hands.execute("repo_apply_patch",withoutMarker,withoutContext),error=>error.code==="planning_scope_mutation_forbidden");
  assert.deepEqual(await f.current(),before);
  await f.unchanged();
});

test("Hands preflight rejects exact-content hash drift and a ninth target without mutating current files",async t=>{
  const f=await fixture(t);await f.authorize();await f.recover();await f.worker.runOnce();await f.worker.runOnce();
  const {args,context}=f.executions[0];
  const hashDrift=structuredClone(args);hashDrift.planProvenance.taskOwnedDirtyLineage.entries[0].contentHash="0".repeat(64);
  await assert.rejects(()=>f.hands.execute("repo_validate_patch",hashDrift,context),error=>["working_tree_dirty","planning_scope_precondition_failed"].includes(error.code));
  await f.unchanged();
  const expanded=structuredClone(args);
  expanded.files.push({path:"test/console-client.test.js",operation:"create",content:"export const unrelated = true;\n"});
  await assert.rejects(()=>f.hands.execute("repo_validate_patch",expanded,context),error=>["working_tree_dirty","implementation_plan_stale","planning_scope_precondition_failed"].includes(error.code));
  await f.unchanged();
});

test("preflight verifies raw bytes of all eight files, including CRLF-only drift in a non-target file",async t=>{
  const f=await fixture(t);await f.authorize();await f.recover();await f.worker.runOnce();await f.worker.runOnce();
  const {args,context}=f.executions[0],path=PATHS[0],original=f.contents.get(path),drift=original.replaceAll("\n","\r\n");
  assert.equal(args.files.some(file=>file.path===path),false,"Drift is outside the proposed mutation subset");
  assert.equal(canonicalContentHash(original),canonicalContentHash(drift));
  assert.notEqual(createHash("sha1").update(original).digest("hex"),createHash("sha1").update(drift).digest("hex"));
  // Deliberate synthetic external drift, not a Hands/product repair action.
  // The runtime must leave these drifted bytes untouched when rejecting them.
  await writeFile(join(f.root,path),drift);f.contents.set(path,drift);
  await assert.rejects(()=>f.hands.execute("repo_validate_patch",args,context),error=>error.code==="planning_scope_precondition_failed"&&error.safeDiagnostics?.mutationApplied===false);
  await f.unchanged();
});

test("HTTP planning continuation consumes exact approved authority once and rejects replay",async()=>{
  const f=await seedPlanningRecoveryFixture();
  const service=createSelfDevelopmentService({...f.options,currentCommit:f.runtimeVersion});
  const api=createApi({
    agent:{tools:{list(){return[];}},async run(){assert.fail("No model call is authorized by recovery API testing");}},
    config:{allowedOrigins:[],maxBodyBytes:64*1024,localWorkerToken:PLANNING_TOKEN},
    storage:f.storage,initialize:async()=>{},ownerId:f.ownerId,selfDevelopment:service,logger:{info(){},error(){}},
  });
  const request=async(suffix,input=f.input,authorization=`Bearer ${PLANNING_TOKEN}`)=>{
    const req=Readable.from([JSON.stringify(input)]);req.method="POST";req.url=`/api/admin/self-development/tasks/${f.taskId}/${suffix}`;
    req.headers={"content-type":"application/json",...(authorization?{authorization}:{})};
    let body="";const res={setHeader(){},end(value=""){body+=value;}};
    await api.handle(req,res);return{status:res.statusCode,body:JSON.parse(body)};
  };
  const requested=await request("request-planning-scope-recovery");
  assert.equal(requested.status,200);assert.equal(requested.body.approval.status,"pending");
  const input={...f.input,approvalId:requested.body.approval.id};
  await f.storage.decideApproval(input.approvalId,f.ownerId,"approved");
  const recovered=await request("recover-planning-scope",input);
  assert.equal(recovered.status,200);assert.equal(recovered.body.task.stateVersion,202);
  assert.equal(recovered.body.recovery.maxProductMutations,0);
  assert.equal(recovered.body.recovery.maxAdditionalAttempts,0);
  const consumed=await f.runtime.get(f.taskId),replayed=await request("recover-planning-scope",input);
  assert.equal(replayed.status,409);assert.deepEqual(await f.runtime.get(f.taskId),consumed);
});
