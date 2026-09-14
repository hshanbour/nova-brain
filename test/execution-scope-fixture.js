import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createHash,createHmac} from "node:crypto";
import {Readable} from "node:stream";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createSelfDevelopmentImplementationPlanner} from "../src/autonomy/self-development-implementation-planner.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createAutoDispatchService} from "../src/autonomy/auto-dispatch.js";
import {createLocalWorkerHandoff} from "../src/autonomy/local-worker-handoff.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createApi} from "../src/http/api.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {seedPlanningRecoveryFixture,PLANNING_PATHS,PLANNING_TOKEN} from "./planning-scope-fixture.js";

export const EXECUTION_TEST_PATHS=PLANNING_PATHS.slice(4);
export const EXECUTION_TEST_RUNTIME="c".repeat(40);
export const EXECUTION_TEST_WORKER="persistent-local-345678ab-5678-4789-8abc-def012345678";
const PLANNING_TEST_WORKER="persistent-local-abcdef12-3456-4789-8abc-def012345678",run=promisify(execFile);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const blobHash=content=>createHash("sha1").update(`blob ${Buffer.byteLength(content,"utf8")}\0`).update(content).digest("hex");
export const executionProofSignature=proof=>createHmac("sha256",PLANNING_TOKEN).update(JSON.stringify(stable(proof))).digest("hex");

// Real worker/Hands pipelines operate ONLY on this synthetic temporary repo and
// an in-memory task. No live credentials, endpoint or Nova workspace is used.
export async function createExecutionScopeFixture(t,{failingFocusedTest=false,restoreFirstTrackedToBaseline=false,byteIdenticalReplacements=false,sevenFocusedTests=false,fullSuite=false,failingFullSuite=false,dependencyFixture=false,fullSuiteTestSource}={}){
  const root=await mkdtemp(join(tmpdir(),"nova-execution-scope-e2e-"));
  t.after(async()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.includes("nova-execution-scope-e2e-"));await rm(root,{recursive:true,force:true});});
  const git=async(...args)=>(await run("git",args,{cwd:root,windowsHide:true})).stdout.trim();
  const source=(path,index,after=false)=>path.endsWith(".css")?`.fixture-${index} { color: ${after?"blue":"green"}; }\n`:path.endsWith(".html")?`<!doctype html><main>${after?"After":"Before"} synthetic acceptance</main>\n`:path.startsWith("test/")?`import test from "node:test";\nimport assert from "node:assert/strict";\ntest("synthetic ${after?"applied":"current"} focused ${index}",()=>assert.equal(${after&&failingFocusedTest&&path===EXECUTION_TEST_PATHS[0]?"1, 2":"1, 1"}));\n`:`export const ${after?"applied":"current"}Synthetic${index} = ${index};\n`;
  const beforeContents=new Map(PLANNING_PATHS.map((path,index)=>[path,source(path,index)])),afterContents=new Map(PLANNING_PATHS.map((path,index)=>[path,source(path,index,true)])),baseline="/* synthetic committed baseline */\n",firstTrackedBaseline=".fixture-committed { color: red; }\n";
  if(sevenFocusedTests)for(const [index,path] of EXECUTION_TEST_PATHS.slice(0,3).entries())for(const contents of [beforeContents,afterContents])contents.set(path,contents.get(path)+`test("synthetic second focused ${index}",()=>assert.equal(2,2));\n`);
  if(byteIdenticalReplacements)for(const [path,content] of beforeContents)afterContents.set(path,content);
  if(restoreFirstTrackedToBaseline)afterContents.set(PLANNING_PATHS[0],firstTrackedBaseline);
  await writeFile(join(root,"package.json"),JSON.stringify({name:"synthetic-execution-fixture",private:true,type:"module",...(fullSuite?{scripts:{test:"node --test"}}:{}),...(dependencyFixture?{dependencies:{"@neondatabase/serverless":"^1.1.0"}}:{})}));
  if(dependencyFixture){await writeFile(join(root,".gitignore"),"node_modules/\n");await writeFile(join(root,"package-lock.json"),JSON.stringify({name:"synthetic-execution-fixture",lockfileVersion:3,packages:{"":{dependencies:{"@neondatabase/serverless":"^1.1.0"}},"node_modules/@neondatabase/serverless":{version:"1.1.0"}}}));}
  for(const path of PLANNING_PATHS){await mkdir(dirname(join(root,path)),{recursive:true});if(path!==PLANNING_PATHS[5])await writeFile(join(root,path),path===PLANNING_PATHS[0]?firstTrackedBaseline:baseline);}
  if(fullSuite)await writeFile(join(root,"test/full-suite-only.test.js"),fullSuiteTestSource??`import test from "node:test";\nimport assert from "node:assert/strict";\ntest("synthetic full-suite-only acceptance",()=>assert.equal(${failingFullSuite?"1,2":"1,1"}));\n`);
  await git("init","-b","feat/nova-brain-mvp-foundation");await git("config","core.autocrlf","false");await git("config","user.name","Synthetic Execution Verification");await git("config","user.email","fixture@example.invalid");await git("remote","add","origin","https://github.com/hshanbour/nova-brain.git");await git("add",".");await git("commit","-m","synthetic execution successor fixture");
  const head=await git("rev-parse","HEAD");for(const [path,content] of beforeContents)await writeFile(join(root,path),content);
  const status=await git("status","--porcelain=v1","--untracked-files=all"),time=Math.max(Date.now(),Date.parse("2026-09-14T18:00:00.000Z")),clock=()=>new Date(time);
  const seed=await seedPlanningRecoveryFixture({root,head,contents:beforeContents,clock}),{storage,ownerId,taskId,repository,branch}=seed;
  const current=()=>storage.getAutonomyTask(taskId,ownerId),steps=()=>storage.listAutonomySteps(taskId),requests=[],executions=[],prompts=[];
  const hands=createToolRegistry(),commands=[],commandHooks={before:null};
  const commandRunner=async(file,args,options)=>{
    commands.push({file,args:[...args]});
    if(args.includes("ls-remote")){
      assert.deepEqual(args.slice(args.indexOf("ls-remote")),["ls-remote","--heads","origin",`refs/heads/${branch}`]);
      return{stdout:`${head}\trefs/heads/${branch}\n`,stderr:""};
    }
    assert.equal(args.some(arg=>["push","fetch","pull","clone"].includes(arg)),false,"No synthetic test may use a live Git operation");
    if(commandHooks.before){const intercepted=await commandHooks.before(file,args,options);if(intercepted!==undefined)return intercepted;}
    const childEnvironment={...process.env,...options.env};delete childEnvironment.NODE_TEST_CONTEXT;
    return run(file,args,{...options,env:childEnvironment,windowsHide:true});
  };
  registerHandsTools(hands,{root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:branch},storage,ownerId,commandRunner});
  const planner=createSelfDevelopmentImplementationPlanner({storage,ownerId,runtimeVersion:seed.runtimeVersion,clock,modelProvider:{async generate(request){
    const prompt=JSON.parse(request.message.split("\n")[1]);prompts.push(prompt);
    return{type:"final",message:JSON.stringify({summary:"Synthetic Nova-owned eight-file plan",files:PLANNING_PATHS.map(path=>({path,operation:"replace",content:afterContents.get(path),reason:"Synthetic scoped acceptance",intendedChanges:["Replace synthetic fixture marker"]})),focusedTests:EXECUTION_TEST_PATHS.map(path=>({path,kind:"existing"})),acceptanceMapping:[{criterion:prompt.acceptanceCriteria[0],files:PLANNING_PATHS}],riskLevel:"low"})};
  }}});
  const registry=createToolRegistry();registry.register({name:"self_development_plan_implementation",execute:args=>planner.generate(args)});
  const taskWorker=createWorkerRuntime({storage,ownerId,toolRegistry:registry,clock}),handoff=createLocalWorkerHandoff({storage,ownerId,approvedBranch:branch,clock}),dispatch=createAutoDispatchService({storage,ownerId,clock});
  const hooks={claim:()=>{},execution:()=>{},complete:()=>{}};
  const client={async request(path,args){
    requests.push({path,args:structuredClone(args)});
    if(path==="/api/admin/worker/auto-dispatch/next")return dispatch.next(args);
    if(path==="/api/admin/worker/handoff/claim"){hooks.claim(args);return handoff.claim(args);}
    if(path===`/api/autonomy/worker/tasks/${taskId}/tick`)return taskWorker.tickTask(taskId,args);
    const match=path.match(/^\/api\/admin\/worker\/handoff\/([^/]+)\/(complete|fail)$/);
    if(match){hooks.complete(args,match[2]);return handoff[match[2]](decodeURIComponent(match[1]),args);}
    assert.fail(`Unexpected or live endpoint is unavailable: ${path}`);
  }};
  let mode="planning";
  const createWorker=(workerId,runtimeVersion)=>createPersistentLocalWorker({client,root,branch,repository,runtimeVersion,workerId,registry:{async execute(name,args,context){
    assert.ok((mode==="planning"&&name==="repo_validate_patch")||(mode==="execution"&&["repo_apply_patch","test_run"].includes(name)),`No unexpected tool is allowed in synthetic fixture: ${name}`);
    hooks.execution(name,args,context);const execution={name,args:structuredClone(args),context:structuredClone(context)};executions.push(execution);
    const result=await hands.execute(name,args,context);execution.result=structuredClone(result);return result;
  }}});
  const planningService=createSelfDevelopmentService({...seed.options,currentCommit:seed.runtimeVersion});
  const requested=await planningService.requestPlanningScopeRecovery(taskId,seed.input,seed.actor);await storage.decideApproval(requested.approval.id,ownerId,"approved");
  await planningService.recoverPlanningScopeFailure(taskId,{...seed.input,approvalId:requested.approval.id},seed.actor);
  const planningWorker=createWorker(PLANNING_TEST_WORKER,seed.runtimeVersion);assert.equal((await planningWorker.runOnce()).worked,true);assert.equal((await planningWorker.runOnce()).worked,true);
  const planningBoundary=await current();assert.equal(planningBoundary.stateVersion,208);assert.equal(planningBoundary.status,"blocked");assert.equal(planningBoundary.currentPhase,"validate_patch");assert.equal(planningBoundary.currentStep,148);
  const plan=planningBoundary.metadata.selfDevelopmentImplementationPlan;assert.deepEqual(plan.files.map(file=>file.path),PLANNING_PATHS);assert.deepEqual(plan.focusedTests.map(file=>file.path),EXECUTION_TEST_PATHS);assert.equal(plan.provenance.planningOnly,true);
  const verifyBytes=async contents=>{assert.equal(await git("rev-parse","HEAD"),head);const expectedStatus=restoreFirstTrackedToBaseline&&contents.get(PLANNING_PATHS[0])===firstTrackedBaseline?status.split(/\r?\n/).filter(line=>!line.endsWith(` ${PLANNING_PATHS[0]}`)).join("\n").trim():status;assert.equal(await git("status","--porcelain=v1","--untracked-files=all"),expectedStatus);for(const [path,content] of contents)assert.equal(await readFile(join(root,path),"utf8"),content);};
  await verifyBytes(beforeContents);mode="execution";
  const runtimeVersion=EXECUTION_TEST_RUNTIME,workspaceProof={taskId,expectedVersion:208,runtimeVersion,workspace:{root,gitTopLevel:root,repository,branch,head,liveTip:head,clean:false,changedFiles:PLANNING_PATHS.map(path=>({path,contentHash:canonicalContentHash(beforeContents.get(path)),hashAlgorithm:"git_sha1",hash:blobHash(beforeContents.get(path))}))}};
  const input={expectedVersion:208,runtimeVersion,planHash:plan.planHash,workspaceProof,workspaceProofSignature:executionProofSignature(workspaceProof)},actor={actorType:"scoped_local_worker",workspaceProof};
  const remoteOverrides={},verifyRemote=async request=>({currentTip:remoteOverrides[request.branch]||(request.branch===branch?head:runtimeVersion),ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))});
  const options={...seed.options,input,actor,runtimeVersion,currentCommit:runtimeVersion,verifyRemote},service=createSelfDevelopmentService(options);
  const authorize=async()=>{const before=await current(),requested=await service.requestExecutionScopeRecovery(taskId,input,actor);assert.equal(requested.approval.status,"pending");assert.deepEqual(await current(),before);await storage.decideApproval(requested.approval.id,ownerId,"approved");input.approvalId=requested.approval.id;return requested;};
  const recover=()=>service.recoverValidatedExecutionScope(taskId,input,actor),worker=createWorker(EXECUTION_TEST_WORKER,runtimeVersion);
  const tools={list(){return[];},async execute(){assert.fail("Approval API may not automatically invoke execution");}};
  const api=createApi({agent:{tools},config:{allowedOrigins:[],maxBodyBytes:128*1024,localWorkerToken:PLANNING_TOKEN},storage,initialize:async()=>{},ownerId,selfDevelopment:service,workerRuntime:{get:current,async resumeApproval(){assert.fail("Owner decision must not resume task");},async control(){assert.fail("Owner decision must not control task");}},logger:{info(){},error(){}}});
  const post=async(path,body=input,token=PLANNING_TOKEN)=>{const req=Readable.from([JSON.stringify(body)]);req.method="POST";req.url=path;req.headers={"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})};let text="";const res={setHeader(){},end(value=""){text+=value;}};await api.handle(req,res);return{status:res.statusCode,body:JSON.parse(text)};};
  const path=suffix=>`/api/admin/self-development/tasks/${taskId}/${suffix}`;
  const claimExecution=async(workerId=EXECUTION_TEST_WORKER)=>{
    const task=(await dispatch.next({workerId,branch})).task;assert.ok(task,"An exact successor action must be dispatchable");
    const claimInput={workerId,runtimeVersion,repository,repositoryRoot:root,continuationGenerationId:task.continuationGenerationId,capabilities:["repo_mutate_local","test_local","repo_read_remote"],expectedBranch:branch,expectedCommit:head,taskId,idempotencyKey:`${taskId}:${task.stateVersion}:${task.stepType}`};
    const claim=await handoff.claim(claimInput),job=claim.handoff;
    const context={runId:taskId,stepId:job.stepId,workerId,runtimeVersion,projectId:"nova-brain",continuationGenerationId:task.continuationGenerationId,executionScope:job.executionScope,repositoryContext:{version:1,repository,root,branch,expectedHead:head,source:"persistent_worker_handoff"}};
    return{claim,claimInput,job,context,complete:result=>handoff.complete(job.handoffId,{taskId,workerId,idempotencyKey:claimInput.idempotencyKey,result})};
  };
  return{...seed,root,head,current,steps,storage,clock,options,service,runtimeVersion,input,actor,plan,planningBoundary,planningWorker,planningService,requests,executions,prompts,commands,hooks,worker,createWorker,handoff,dispatch,hands,taskWorker,authorize,recover,beforeContents,afterContents,verifyBytes,post,path,remoteOverrides,claimExecution,git,client,commandRunner,commandHooks};
}
