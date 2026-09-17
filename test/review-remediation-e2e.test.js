import test from "node:test";
import assert from "node:assert/strict";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {createReviewRemediationFixture,REVIEW_CLASS,REVIEW_CONSTRAINTS,assertReviewHistoriesPreserved} from "./review-remediation-fixture.js";
import {PLANNING_PATHS} from "./planning-scope-fixture.js";

const newSteps=async f=>(await f.steps()).filter(step=>Number.parseInt(step.stepId,10)>152);
const boundary=task=>task.metadata.reviewRemediationBoundary;
const record=task=>task.metadata.reviewRemediationHistory.at(-1);
async function originalStepsPreserved(f){const current=await f.steps();for(const original of f.sourceSteps)assert.deepEqual(current.find(step=>step.stepId===original.stepId),original);}
const unpushed=f=>assert.equal(f.commands.some(command=>command.args.some(arg=>["push","fetch","pull","clone"].includes(arg))),false);

test("complete v223 review remediation consumes owner approval, eight fresh reads, Nova plan, preflight, one apply and actual focused/full tests to a fresh review boundary",async t=>{
  const f=await createReviewRemediationFixture(t),before=await f.current();
  assert.equal(before.stateVersion,223);assert.equal(before.currentStep,152);assert.equal(before.repairIteration,3);assert.match(f.sourceSteps.find(step=>step.stepId==="152:run_full_tests").result.output,/# pass 761/);
  assert.equal(before.metadata.failedFullTestRetryHistory[0].consumed,true);assert.equal(before.metadata.escalatedRepairHistory.length,1);
  const requested=await f.authorize();assert.equal(requested.approval.arguments.maxSteps,13);assert.equal(requested.approval.arguments.runtimeMinutes,15);
  const recovered=await f.recover();assert.equal(recovered.task.stateVersion,224);assert.equal(recovered.task.metadata.activeContinuation.recoveryClass,REVIEW_CLASS);assertReviewHistoriesPreserved(before,recovered.task);await f.verifySourceUnchanged();
  await f.runSteps(8);assert.deepEqual(f.executions.map(item=>item.name),Array(8).fill("repo_read_task_owned_local"));assert.deepEqual(f.executions.map(item=>item.args.path),PLANNING_PATHS);assert.equal(f.prompts.length,0);await f.verifySourceUnchanged();
  await f.runSteps(1);assert.equal(f.prompts.length,1);assert.deepEqual(f.prompts[0].candidateFiles.map(item=>({path:item.path,content:item.content})),PLANNING_PATHS.map(path=>({path,content:f.afterContents.get(path)})));
  assert.deepEqual(f.prompts[0].structuredReview,f.review);assert.equal(f.prompts[0].reviewRemediation,true);assert.equal(f.prompts[0].scopeExpansionAllowed,false);
  const baselines=new Map(f.prompts[0].committedBaselineFiles.map(item=>[item.path,item.content]));assert.equal(baselines.size,7);
  for(const path of PLANNING_PATHS.filter(path=>path!=="test/composer-voice-console.integration.test.js"))assert.equal(baselines.get(path)?.trim(),await f.git("show",`HEAD:${path}`));
  assert.equal(baselines.has("test/composer-voice-console.integration.test.js"),false);
  const promptText=JSON.stringify(f.prompts[0]);for(const finding of f.review.findings)assert.ok(promptText.includes(finding.defect));for(const item of REVIEW_CONSTRAINTS)assert.ok(promptText.includes(item.text));
  assert.deepEqual(f.prompts[0].availableEvidenceExpansionTests,[]);
  const planned=await f.current(),plan=planned.metadata.selfDevelopmentImplementationPlan;assert.deepEqual(plan.evidencePaths,PLANNING_PATHS);assert.equal(plan.reviewCoverage.length,5);assert.notEqual(plan.planHash,f.plan.planHash);for(const file of plan.files)assert.equal(file.expectedContent,f.afterContents.get(file.path));
  for(const coverage of plan.reviewCoverage)assert.equal(coverage.sourceHash,canonicalContentHash(plan.files.find(file=>file.path===coverage.testPath)?.content||f.afterContents.get(coverage.testPath)));
  await f.verifySourceUnchanged();await f.runSteps(1);assert.equal(f.executions.at(-1).name,"repo_validate_patch");assert.equal(f.executions.at(-1).result.preMutationValidated,true);assert.equal(f.executions.at(-1).result.mutationApplied,false);await f.verifySourceUnchanged();
  await f.runSteps(1);assert.equal(f.executions.at(-1).name,"repo_apply_patch");assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,1);await f.verifyCandidate();
  await f.runSteps(1);assert.equal(f.executions.at(-1).name,"test_run");assert.match(f.executions.at(-1).result.output,/pass 7/);
  await f.runSteps(1);assert.equal(f.executions.at(-1).name,"test_run_full");assert.match(f.executions.at(-1).result.output,/tests 8/);assert.match(f.executions.at(-1).result.output,/pass 8/);
  const final=await f.current();assert.equal(final.status,"blocked");assert.equal(boundary(final).kind,"review_ready");assert.equal(boundary(final).executionAuthorized,false);assert.equal(record(final).consumed,true);assert.ok(final.stateVersion>223);assertReviewHistoriesPreserved(before,final);await originalStepsPreserved(f);
  assert.equal(boundary(final).findingsResolved,false);assert.deepEqual(record(final).unresolvedFindingIds,f.review.findings.filter(item=>item.severity==="blocking").map(item=>item.id));
  assert.deepEqual((await newSteps(f)).map(step=>step.stepType),[...Array(8).fill("read_files"),"plan_repair","validate_patch","apply_patch","run_focused_tests","run_full_tests"]);
  assert.equal((await newSteps(f)).every(step=>step.status==="completed"),true);await f.verifyCandidate();unpushed(f);
  assert.deepEqual(await f.worker.runOnce(),{worked:false});await assert.rejects(()=>f.recover());await assert.rejects(()=>f.previousRetryRecover());await assert.rejects(()=>f.taskWorker.control(f.taskId,"resume"));assert.deepEqual(await f.current(),final);
  const applied=f.executions.find(item=>item.name==="repo_apply_patch"),full=f.executions.find(item=>item.name==="test_run_full");
  await assert.rejects(()=>f.hands.execute(applied.name,applied.args,applied.context));await assert.rejects(()=>f.hands.execute(full.name,full.args,full.context));assert.deepEqual(await f.current(),final);await f.verifyCandidate();
});

test("a valid six-file Nova remediation subset keeps complete eight-file lineage through apply and passing review boundary",async t=>{
  const f=await createReviewRemediationFixture(t,{subset:true}),before=await f.current();await f.authorize();await f.recover();await f.runSteps(13);
  const final=await f.current(),apply=f.executions.find(item=>item.name==="repo_apply_patch"),plan=final.metadata.selfDevelopmentImplementationPlan;
  assert.equal(plan.files.length,6);assert.equal(apply.args.files.length,6);assert.equal(apply.result.taskOwnedDirtyLineage.entries.length,8);assert.deepEqual(apply.result.taskOwnedDirtyLineage.entries.map(item=>item.path).sort(),[...PLANNING_PATHS].sort());
  assert.equal(await f.read("index.html"),f.afterContents.get("index.html"));assert.equal(await f.read("assets/console.css"),f.afterContents.get("assets/console.css"));
  assert.equal(boundary(final).kind,"review_ready");assert.equal(record(final).consumed,true);assert.equal(record(final).afterEntries.length,8);assertReviewHistoriesPreserved(before,final);await originalStepsPreserved(f);await f.verifyCandidate();unpushed(f);
});

test("actual verbose full-suite success retains its complete terminal summary across the 20000-character output boundary",async t=>{
  const f=await createReviewRemediationFixture(t,{verboseFull:true}),before=await f.current();await f.authorize();await f.recover();await f.runSteps(13);
  const full=f.executions.find(item=>item.name==="test_run_full"),focused=f.executions.find(item=>item.name==="test_run"),final=await f.current();assert.equal(full.result.ok,true);assert.equal(full.result.outputTruncated,true);assert.equal(full.result.output.length,20000);assert.match(full.result.output,/tests 8/);assert.match(full.result.output,/pass 8/);assert.match(full.result.output,/fail 0/);assert.equal(focused.result.outputTruncated,false);
  assert.equal(final.status,"blocked");assert.equal(boundary(final).kind,"review_ready");assert.equal(record(final).consumed,true);assert.equal(boundary(final).findingsResolved,false);assertReviewHistoriesPreserved(before,final);await originalStepsPreserved(f);await f.verifyCandidate();unpushed(f);
});

for(const [name,options,completed] of [["focused",{failingFocused:true},11],["full",{failingFull:true},12]])test(`${name}-test failure stops at a Nova-owned review remediation decision with no repair extension or hidden retry`,async t=>{
  const f=await createReviewRemediationFixture(t,options),before=await f.current();await f.authorize();await f.recover();await f.runSteps(completed);
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="test_failed");const final=await f.current(),failed=(await newSteps(f)).at(-1);
  assert.equal(final.status,"blocked");assert.equal(boundary(final).kind,"product_repair_decision");assert.equal(boundary(final).executionAuthorized,false);assert.equal(record(final).consumed,true);assert.equal(failed.status,"failed");assert.equal(failed.errorCode,"test_failed");assert.ok(failed.result.diagnostics.counts.failed>0);
  assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,1);assert.equal(f.executions.filter(item=>item.name==="test_run_full").length,name==="focused"?0:1);assertReviewHistoriesPreserved(before,final);await originalStepsPreserved(f);await f.verifyCandidate();unpushed(f);
  assert.deepEqual(await f.worker.runOnce(),{worked:false});await assert.rejects(()=>f.recover());assert.deepEqual(await f.current(),final);
});

test("Nova's proposed ninth path is rejected at the planning authorization boundary before validation or mutation",async t=>{
  const f=await createReviewRemediationFixture(t,{output:value=>({...value,files:[...value.files.slice(0,7),{...value.files[7],path:"test/ninth.test.js",operation:"create"}]})}),before=await f.current();await f.authorize();await f.recover();await f.runSteps(9);
  const final=await f.current(),planning=(await newSteps(f)).at(-1);assert.equal(planning.stepType,"plan_repair");assert.equal(planning.status,"failed");assert.equal(final.status,"blocked");assert.equal(boundary(final).executionAuthorized,false);assert.match(boundary(final).kind,/authorization/);assert.equal(f.executions.length,8);assertReviewHistoriesPreserved(before,final);await f.verifySourceUnchanged();assert.deepEqual(await f.worker.runOnce(),{worked:false});
});

test("stale review approval cannot proceed after byte drift in any of the eight reviewed files",async t=>{
  const f=await createReviewRemediationFixture(t);await f.authorize();await f.recover();const original=await f.read("assets/console.css"),drift=original.replaceAll("\n","\r\n");assert.equal(canonicalContentHash(original),canonicalContentHash(drift));await f.drift("assets/console.css",drift);
  await assert.rejects(()=>f.worker.runOnce());assert.equal(f.executions.filter(item=>item.name==="repo_apply_patch").length,0);assert.equal(await f.read("assets/console.css"),drift);assert.equal(f.prompts.length,0);const final=await f.current();assert.notEqual(final.status,"queued");assertReviewHistoriesPreserved(f.sourceTask,final);
});

test("approved review evidence cannot be replaced with changed factual findings",async t=>{
  const f=await createReviewRemediationFixture(t);await f.authorize();const before=await f.current(),input=structuredClone(f.input);input.review.findings[0].defect="Different finding not approved by the owner";
  await assert.rejects(()=>f.service.recoverReviewRemediation(f.taskId,input,{...f.actor,workspaceProof:input.workspaceProof}));assert.deepEqual(await f.current(),before);await f.verifySourceUnchanged();
});

test("Hands rejects an injected ninth-file mutation after a valid Nova plan and preflight",async t=>{
  const f=await createReviewRemediationFixture(t);await f.authorize();await f.recover();await f.runSteps(10);
  f.hooks.execution=(name,args)=>{if(name==="repo_apply_patch")args.files.push({path:"test/ninth.test.js",operation:"create",content:"export const forbiddenNinthFile = true;\n"});};
  await assert.rejects(()=>f.worker.runOnce());const final=await f.current();assert.equal(final.status,"blocked");assert.equal(boundary(final).executionAuthorized,false);assertReviewHistoriesPreserved(f.sourceTask,final);await f.verifySourceUnchanged();await assert.rejects(()=>f.read("test/ninth.test.js"),error=>error.code==="ENOENT");assert.deepEqual(await f.worker.runOnce(),{worked:false});
});

test("green focused counts cannot hide an approved named review test that was never registered",async t=>{
  const f=await createReviewRemediationFixture(t,{output:value=>{const mapping=value.reviewCoverage[0],file=value.files.find(item=>item.path===mapping.testPath);file.content=file.content.replace(mapping.sourceExcerpt,`if (false) { ${mapping.sourceExcerpt} }`);return value;}});
  await f.authorize();await f.recover();await f.runSteps(11);await assert.rejects(()=>f.worker.runOnce());
  const final=await f.current(),focused=f.executions.find(item=>item.name==="test_run");assert.equal(focused.result.ok,true);assert.match(focused.result.output,/pass 6/);assert.match(focused.result.output,/fail 0/);assert.equal(final.status,"blocked");assert.equal(record(final).consumed,true);assert.equal(f.executions.some(item=>item.name==="test_run_full"),false);assertReviewHistoriesPreserved(f.sourceTask,final);assert.deepEqual(await f.worker.runOnce(),{worked:false});
});

test("tampered zero-test full-suite success cannot produce a fresh review-ready boundary",async t=>{
  const f=await createReviewRemediationFixture(t);await f.authorize();await f.recover();await f.runSteps(12);
  f.hooks.complete=(args,action)=>{if(action==="complete")args.result={...args.result,output:"TAP version 13\n1..0\n# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",outputTruncated:false};};
  await assert.rejects(()=>f.worker.runOnce());const final=await f.current(),full=f.executions.find(item=>item.name==="test_run_full");assert.equal(full.result.ok,true);assert.match(full.result.output,/pass 8/);assert.equal(final.status,"blocked");assert.notEqual(boundary(final).kind,"review_ready");assert.equal(boundary(final).executionAuthorized,false);assert.equal(record(final).consumed,true);assertReviewHistoriesPreserved(f.sourceTask,final);await f.verifyCandidate();assert.deepEqual(await f.worker.runOnce(),{worked:false});
});

for(const [name,alter] of [
  ["missing acceptance coverage",value=>{value.reviewCoverage.pop();}],
  ["caller-supplied test-source hash",value=>{value.reviewCoverage[0].sourceHash="0".repeat(64);}],
  ["unobservable test assertion",value=>{value.reviewCoverage[0].assertion="assert.equal(unwiredCounter, 0)";}],
])test(`review plan rejects ${name} before a product apply`,async t=>{
  const f=await createReviewRemediationFixture(t,{output:value=>{alter(value);return value;}});await f.authorize();await f.recover();await f.runSteps(9);const final=await f.current();assert.equal((await newSteps(f)).at(-1).status,"failed");assert.equal(f.executions.length,8);assert.notEqual(final.status,"queued");assertReviewHistoriesPreserved(f.sourceTask,final);await f.verifySourceUnchanged();
});
