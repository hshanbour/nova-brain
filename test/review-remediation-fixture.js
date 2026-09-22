import assert from "node:assert/strict";
import {readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {Readable} from "node:stream";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {createSelfDevelopmentService} from "../src/autonomy/self-development.js";
import {createSelfDevelopmentImplementationPlanner} from "../src/autonomy/self-development-implementation-planner.js";
import {createWorkerRuntime} from "../src/autonomy/worker-runtime.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";
import {createApi} from "../src/http/api.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {createFailedFullTestRetryFixture} from "./failed-full-test-retry-fixture.js";
import {executionProofSignature,EXECUTION_TEST_PATHS} from "./execution-scope-fixture.js";
import {PLANNING_PATHS,PLANNING_TOKEN} from "./planning-scope-fixture.js";

export const REVIEW_RUNTIME="f".repeat(40);
export const REVIEW_WORKER="persistent-local-6789abcd-89ab-489a-8abc-def012345678";
export const REVIEW_CLASS="owner_approved_review_remediation";
export const REVIEW_HISTORIES=["failedLocalReadRecoveryHistory","continuationRuntimeResumeHistory","implementationPlanRecoveryHistory","partialRepairPlanRecoveryHistory","escalatedRepairHistory","planningScopeRecoveryHistory","planningScopeBoundary","executionScopeRecoveryHistory","executionScopeBoundary","fullTestScopeRecoveryHistory","fullTestScopeBoundary","failedFullTestRetryHistory","failedFullTestRetryBoundary"];
export const REVIEW_CONSTRAINTS=[
  {id:"A",text:"Preserve existing console navigation, workspaces and conversation controls.",findingIds:["console-preservation"]},
  {id:"B",text:"Manual Send uses the supported agent endpoint and displays responses with conversation identity.",findingIds:["manual-send"]},
  {id:"C",text:"Stale microphone acquisition cannot alter or leak the active session resources.",findingIds:["stale-meter"]},
  {id:"D",text:"No-auto-send coverage observes a wired submission or request boundary.",findingIds:["regression-coverage"]},
  {id:"E",text:"Meaningful console regression coverage is preserved or replaced by equivalent behavior checks.",findingIds:["regression-coverage"]},
];
const npmCommand=args=>args.some(arg=>arg.endsWith("npm-cli.js"))&&args.includes("test");
const fullSuiteTestSource=`import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
test("synthetic full-suite-only acceptance",()=>{
  const source=readFileSync(new URL("../assets/voice-input.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/syntheticFullFailure = true/);
});
`;

export function assertReviewHistoriesPreserved(before,after){
  for(const key of ["repairIteration","retryCount","maxRetries","branch","startingCommit","currentCommit"])assert.equal(after[key],before[key],key);
  for(const key of REVIEW_HISTORIES)assert.deepEqual(after.metadata[key],before.metadata[key],key);
  const priorGenerations=before.metadata.implementationPlanGenerations||[],nextGenerations=after.metadata.implementationPlanGenerations||[];
  for(const prior of priorGenerations){const next=nextGenerations.find(item=>item.generationId===prior.generationId);assert.ok(next);const comparable={...next,authority:prior.authority};if(prior.authority==="active"&&next.authority==="superseded"){assert.equal(next.supersededBy,after.metadata.activeImplementationPlanGeneration);delete comparable.supersededBy;}assert.deepEqual(comparable,prior);assert.ok(next.authority===prior.authority||next.authority==="superseded");}
  const originalContinuations=before.metadata.continuationHistory||[];assert.deepEqual((after.metadata.continuationHistory||[]).slice(0,originalContinuations.length),originalContinuations);
}

function reviewEvidence(contents){
  const finding=(id,paths,defect,acceptanceImplication)=>({id,severity:"blocking",paths,defect,sourceEvidence:paths.map(path=>({path,contentHash:canonicalContentHash(contents.get(path)),lineStart:1,lineEnd:1})),acceptanceImplication});
  return {findings:[
    finding("console-preservation",["index.html"],"The candidate removed existing console navigation and workspaces.",REVIEW_CONSTRAINTS[0].text),
    finding("manual-send",["assets/console.js"],"Manual Send targets an unsupported route and does not retain response conversation identity.",REVIEW_CONSTRAINTS[1].text),
    finding("stale-meter",["assets/voice-input.js"],"A delayed acquisition can replace the active session resource handle before checking its session.",REVIEW_CONSTRAINTS[2].text),
    finding("regression-coverage",["test/console-static.test.js","test/composer-voice-console.integration.test.js"],"The regression suite was removed and the no-submission counter never observes submission.",`${REVIEW_CONSTRAINTS[3].text} ${REVIEW_CONSTRAINTS[4].text}`),
    {id:"language-preference",severity:"note",paths:["assets/voice-input.js"],defect:"The persisted language key changed without migration.",sourceEvidence:[{path:"assets/voice-input.js",contentHash:canonicalContentHash(contents.get("assets/voice-input.js")),lineStart:1,lineEnd:1}],acceptanceImplication:"Evaluate preservation of existing language selection within the approved scope."},
  ],acceptanceConstraints:structuredClone(REVIEW_CONSTRAINTS)};
}

// This is a toy generated candidate, not a microphone implementation or repair.
// Actual Node tests consume generated bytes so parser, Hands and lifecycle
// assertions cannot pass from invented tool results. Product acceptance remains
// an unresolved review obligation; these synthetic probes do not satisfy it.
function generatedCandidate(contents,{failingFocused=false,failingFull=false}={}){
  const after=new Map(contents);
  after.set("assets/console.js","export const syntheticReviewValues = Object.freeze({ A: 1, B: 2, C: 3, D: 4, E: 5 });\n");
  after.set("assets/voice-input.js",`export const syntheticFullFailure = ${failingFull};\n`);
  after.set("assets/console.css",".synthetic-review-fixture { color: blue; }\n");
  after.set("index.html","<!doctype html><main>Synthetic reviewed candidate</main>\n");
  const coverage=[],groups=new Map(EXECUTION_TEST_PATHS.map(path=>[path,[]]));
  for(const [index,constraint] of REVIEW_CONSTRAINTS.entries()){
    const path=EXECUTION_TEST_PATHS[index%EXECUTION_TEST_PATHS.length],testName=`synthetic review constraint ${constraint.id}`;
    const stimulus=`const observed = syntheticReviewValues.${constraint.id};`,assertion=`assert.equal(observed, ${failingFocused&&index===0?99:index+1});`;
    const sourceExcerpt=`test(${JSON.stringify(testName)}, () => { ${stimulus} ${assertion} });`;
    groups.get(path).push(sourceExcerpt);
    coverage.push({constraintId:constraint.id,findingIds:constraint.findingIds,testPath:path,testName,sourceExcerpt,stimulus,observable:"observed",assertion});
  }
  for(const [index,path] of EXECUTION_TEST_PATHS.entries()){
    const extra=index<2?`\ntest("synthetic retained regression ${index}",()=>assert.equal(Object.keys(syntheticReviewValues).length,5));`:"";
    after.set(path,`import test from "node:test";\nimport assert from "node:assert/strict";\nimport {syntheticReviewValues} from "../assets/console.js";\n${groups.get(path).join("\n")}${extra}\n`);
  }
  for(const item of coverage)item.sourceHash=canonicalContentHash(after.get(item.testPath));
  return {after,coverage};
}

export async function createReviewRemediationFixture(t,{failingFocused=false,failingFull=false,output,sourceFullCount=761,subset=false,verboseFull=false}={}){
  const fullSource=verboseFull?fullSuiteTestSource.replace('  const source=', '  console.log("synthetic diagnostic output ".repeat(1000));\n  const source='):fullSuiteTestSource;
  const base=await createFailedFullTestRetryFixture(t,{fullSuiteTestSource:fullSource});
  await base.authorize();await base.recover();
  // Only historical source-suite output is shaped to the authoritative v223
  // count. New remediation focused/full runs execute the isolated real suite.
  const historicalPasses=Array.from({length:sourceFullCount},(_,index)=>`ok ${index+1} - synthetic historical source-suite passing case ${index+1}`).join("\n");
  base.commandHooks.before=async(file,args)=>npmCommand(args)?{stdout:`TAP version 13\n${historicalPasses}\n1..${sourceFullCount}\n# tests ${sourceFullCount}\n# suites 0\n# pass ${sourceFullCount}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1234\n`,stderr:""}:undefined;
  await base.worker.runOnce();base.commandHooks.before=null;
  const sourceTask=await base.current(),sourceSteps=await base.steps();
  assert.equal(sourceTask.stateVersion,223);assert.equal(sourceTask.status,"blocked");assert.equal(sourceTask.currentStep,152);assert.equal(sourceTask.repairIteration,3);
  assert.equal(sourceTask.metadata.failedFullTestRetryBoundary.kind,"review_ready");assert.equal(sourceTask.metadata.failedFullTestRetryHistory[0].consumed,true);
  const sourceFull=sourceSteps.find(step=>step.stepId==="152:run_full_tests");assert.equal(sourceFull.result.output.length,20000);assert.equal(sourceFull.result.outputTruncated,true);assert.match(sourceFull.result.output,new RegExp(`# pass ${sourceFullCount}\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0\\n# duration_ms 1234$`));
  const {taskId,ownerId,root,repository,branch,head,storage,clock,hands,current,steps}=base;
  const runtimeVersion=REVIEW_RUNTIME,workspaceProof=structuredClone(base.input.workspaceProof);
  workspaceProof.expectedVersion=223;workspaceProof.runtimeVersion=runtimeVersion;
  const review=reviewEvidence(base.afterContents),input={expectedVersion:223,planHash:base.plan.planHash,runtimeVersion,workspaceProof,workspaceProofSignature:executionProofSignature(workspaceProof),review};
  const actor={actorType:"scoped_local_worker",workspaceProof},remoteOverrides={};
  const verifyRemote=async request=>({currentTip:remoteOverrides[request.branch]||(request.branch===branch?head:runtimeVersion),ancestors:Object.fromEntries(request.requiredAncestors.map(sha=>[sha,true]))});
  const options={...base.options,input,actor,currentCommit:runtimeVersion,runtimeVersion,verifyRemote},service=createSelfDevelopmentService(options);
  const prompts=[],executions=[],requests=[],hooks={claim:()=>{},execution:()=>{},complete:()=>{}},candidate=generatedCandidate(base.afterContents,{failingFocused,failingFull});
  const mutationPaths=subset?PLANNING_PATHS.filter(path=>!path.endsWith(".css")&&path!=="index.html"):PLANNING_PATHS;
  if(subset)for(const path of PLANNING_PATHS.filter(path=>!mutationPaths.includes(path)))candidate.after.set(path,base.afterContents.get(path));
  const planner=createSelfDevelopmentImplementationPlanner({storage,ownerId,runtimeVersion,clock,modelProvider:{async generate(request){
    if(request.responseFormat?.name==="nova_self_development_preservation_assessment")return{type:"final",message:JSON.stringify({status:"preserved",unrelatedRemovals:[],intentionalRemovals:[]})};
    const prompt=JSON.parse(request.message.split("\n")[1]);prompts.push(structuredClone(prompt));
    const proposed={summary:"Synthetic Nova-generated same-eight-file review candidate",files:mutationPaths.map(path=>({path,operation:"replace",content:candidate.after.get(path),reason:"Synthetic isolated review lifecycle probe",intendedChanges:["Update the synthetic candidate"]})),focusedTests:EXECUTION_TEST_PATHS.map(path=>({path,kind:"existing"})),acceptanceMapping:(prompt.acceptanceCriteria||[]).map(criterion=>({criterion,files:mutationPaths})),reviewCoverage:candidate.coverage.map(({sourceHash,...mapping})=>mapping),riskLevel:"low"};
    return {type:"final",message:JSON.stringify(output?output(proposed,prompt):proposed)};
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
  const createWorker=(workerId=REVIEW_WORKER)=>createPersistentLocalWorker({client,root,branch,repository,runtimeVersion,workerId,registry:{async execute(name,args,context){
    assert.ok(["repo_read_task_owned_local","repo_validate_patch","repo_apply_patch","test_run","test_run_full"].includes(name),`Review remediation may not invoke ${name}`);
    hooks.execution(name,args,context);const record={name,args:structuredClone(args),context:structuredClone(context)};executions.push(record);
    const result=await hands.execute(name,args,context);record.result=structuredClone(result);return result;
  }}});
  const worker=createWorker(),tools={list(){return[];},async execute(){assert.fail("Owner decision may not execute the product");}};
  const api=createApi({agent:{tools},config:{allowedOrigins:[],maxBodyBytes:256*1024,localWorkerToken:PLANNING_TOKEN},storage,initialize:async()=>{},ownerId,selfDevelopment:service,workerRuntime:{get:current,async resumeApproval(){assert.fail("Owner decision must not resume task");},async control(){assert.fail("Owner decision must not control task");}},logger:{info(){},error(){}}});
  const post=async(path,body=input,token=PLANNING_TOKEN)=>{const req=Readable.from([JSON.stringify(body)]);req.method="POST";req.url=path;req.headers={"content-type":"application/json",...(token?{authorization:`Bearer ${token}`}:{})};let text="";const res={setHeader(){},end(value=""){text+=value;}};await api.handle(req,res);return{status:res.statusCode,body:JSON.parse(text)};};
  const path=suffix=>`/api/admin/self-development/tasks/${taskId}/${suffix}`;
  const authorize=async()=>{const before=await current(),requested=await service.requestReviewRemediationApproval(taskId,input,actor);assert.equal(requested.approval.status,"pending");assert.deepEqual(await current(),before);await storage.decideApproval(requested.approval.id,ownerId,"approved");input.approvalId=requested.approval.id;return requested;};
  const recover=()=>service.recoverReviewRemediation(taskId,input,actor);
  const runSteps=async count=>{for(let index=0;index<count;index++)assert.equal((await worker.runOnce()).worked,true,`Expected remediation step ${index+1}`);};
  const verifySourceUnchanged=()=>base.verifyBytes(base.afterContents),verifyCandidate=()=>base.verifyBytes(candidate.after);
  const drift=async(path,content)=>writeFile(join(root,path),content);
  return {...base,previousRetryRecover:base.recover,previousRetryWorker:base.worker,sourceTask,sourceSteps,runtimeVersion,input,actor,review,options,service,planner,taskWorker,client,worker,createWorker,prompts,executions,requests,hooks,remoteOverrides,authorize,recover,post,path,runSteps,candidate,verifySourceUnchanged,verifyCandidate,drift,read:async path=>readFile(join(root,path),"utf8")};
}
