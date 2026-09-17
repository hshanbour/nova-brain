import test from "node:test";
import assert from "node:assert/strict";
import {createReviewRemediationFixture} from "./review-remediation-fixture.js";
import {describeReviewRemediation,validateReviewRemediationEvidence,validateReviewRemediationPlanCoverage,validateReviewRemediationTestResult,reviewRemediationDescriptor,REVIEW_REMEDIATION_CLASS} from "../src/autonomy/review-remediation-scope.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";

test("real-shaped v223 review evidence yields one bounded thirteen-step approval without changing source state",async t=>{
  const f=await createReviewRemediationFixture(t),before=await f.current(),steps=await f.steps(),described=await describeReviewRemediation(f.options);
  assert.equal(described.sourceFull.result.outputTruncated,true);assert.equal(described.sourceFull.result.output.length,20000);
  assert.equal(before.stateVersion,223);assert.equal(before.currentStep,152);assert.equal(described.review.findings.filter(item=>item.severity==="blocking").length,4);assert.equal(described.review.acceptanceConstraints.length,5);assert.deepEqual(described.fullCounts,{tests:761,passed:761,failed:0,skipped:0});assert.equal(described.requiredPaths.length,8);assert.equal(described.approvalArguments.maxSteps,13);assert.equal(described.approvalArguments.runtimeMinutes,15);assert.equal(described.approvalArguments.maxAdditionalAttempts,0);assert.equal(described.approvalArguments.maxReviewRemediations,1);assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),steps);await f.verifySourceUnchanged();
});

test("source task identity, terminal evidence, consumed lineage and review findings all remain fail closed",async t=>{
  const f=await createReviewRemediationFixture(t),before=await f.current(),originalSteps=await f.steps();
  const cases=[
    ["wrong task",task=>task.id="another-task"],
    ["wrong version",task=>task.stateVersion--],
    ["wrong status",task=>task.status="queued"],
    ["wrong phase",task=>task.currentPhase="plan_repair"],
    ["wrong current step",task=>task.currentStep--],
    ["wrong branch",task=>task.branch="other-branch"],
    ["wrong repository",task=>task.metadata.selfDevelopment.repository="other/repo"],
    ["wrong HEAD",task=>task.currentCommit="0".repeat(40)],
    ["active lease",task=>task.leaseToken="lease"],
    ["pending approval",task=>task.approvalState={approved:false}],
    ["unconsumed predecessor",task=>task.metadata.failedFullTestRetryHistory[0].consumed=false],
    ["wrong source result",task=>task.metadata.failedFullTestRetryHistory[0].result="test_failed"],
    ["wrong boundary",task=>task.metadata.failedFullTestRetryBoundary.kind="product_repair_decision"],
    ["changed repair counter",task=>task.repairIteration++],
    ["changed retry counter",task=>task.retryCount++],
    ["changed consumed extension",task=>task.metadata.escalatedRepairHistory[0].maxAdditionalAttempts=2],
    ["existing remediation",task=>task.metadata.reviewRemediationHistory=[{}]],
  ];
  for(const[label,alter]of cases){const task=structuredClone(before);alter(task);await assert.rejects(()=>describeReviewRemediation({...f.options,task,steps:originalSteps}),undefined,label);assert.deepEqual(await f.current(),before);}
  for(const[label,alter]of[
    ["later durable step",steps=>steps.push({...steps.at(-1),stepId:"153:apply_patch"})],
    ["wrong apply lineage",steps=>steps.find(step=>step.stepId==="149:apply_patch").result.taskOwnedDirtyLineage.sourceApplyStepId="27:apply_patch"],
    ["source full output changed",steps=>steps.find(step=>step.stepId==="152:run_full_tests").result.output="# tests 761\n# pass 760\n# fail 1\n# skipped 0\n"],
    ["focused evidence changed",steps=>steps.find(step=>step.stepId==="150:run_focused_tests").result.exitCode=1],
  ]){const steps=structuredClone(originalSteps);alter(steps);await assert.rejects(()=>describeReviewRemediation({...f.options,task:before,steps}),undefined,label);}
  for(const alter of[review=>review.findings.pop()&&review.findings.pop(),review=>review.findings[0].sourceEvidence[0].contentHash="0".repeat(64),review=>review.findings[0].paths=["test/ninth.test.js"],review=>review.acceptanceConstraints.pop(),review=>review.acceptanceConstraints[0].findingIds=["unknown-finding"],review=>review.findings[0].sourceEvidence[0].lineStart=-1]){
    const input=structuredClone(f.input);alter(input.review);await assert.rejects(()=>describeReviewRemediation({...f.options,input}));
  }
  assert.deepEqual(await f.current(),before);assert.deepEqual(await f.steps(),originalSteps);await f.verifySourceUnchanged();
});

test("created remediation preserves all bounds and rejects scope, history, request or runtime drift and replay",async t=>{
  const f=await createReviewRemediationFixture(t);await f.authorize();await f.recover();const before=await f.current(),steps=await f.steps();
  const valid=validateReviewRemediationEvidence(before,steps,f.clock);assert.equal(valid.record.requiredPaths.length,8);assert.equal(valid.record.planHash,null);assert.equal(valid.record.activeContinuation.maxSteps,13);assert.equal(valid.record.activeContinuation.runtimeMinutes,15);assert.equal(reviewRemediationDescriptor(before).recoveryClass,REVIEW_REMEDIATION_CLASS);
  const mutations=[
    task=>task.metadata.reviewRemediationHistory[0].consumed=true,
    task=>task.metadata.reviewRemediationHistory[0].maxApplyAttempts=2,
    task=>task.metadata.reviewRemediationHistory[0].maxAdditionalAttempts=1,
    task=>task.metadata.reviewRemediationHistory[0].sourceApplyStepId="27:apply_patch",
    task=>task.metadata.reviewRemediationHistory[0].sourcePlanGenerations[0].planHash="0".repeat(64),
    task=>task.metadata.reviewRemediationHistory[0].beforeEntries[0].hash="0".repeat(40),
    task=>task.metadata.reviewRemediationHistory[0].review.findings[0].defect="Changed owner findings",
    task=>task.metadata.reviewRemediationHistory[0].unresolvedFindingIds=[],
    task=>task.metadata.selfDevelopment.userGoal="A different mission",
    task=>task.metadata.maxRepairIterations=4,
    task=>task.repairIteration=0,
    task=>task.metadata.steps.push({type:"push",input:{tool:"git_push",arguments:{}}}),
    task=>task.metadata.continuationHistory[0].runtimeMinutes=999,
    task=>task.metadata.reviewRemediationHistory[0].claimedStepIds=[task.metadata.reviewRemediationHistory[0].applyStepId],
    task=>{const record=task.metadata.reviewRemediationHistory[0];task.metadata.steps[record.activeContinuation.startStep].input.tool="repo_apply_patch";record.successorStepsHash=recoveryHash(task.metadata.steps.slice(record.activeContinuation.startStep));},
    task=>{const record=task.metadata.reviewRemediationHistory[0];task.metadata.steps.at(-1).input.arguments={namePattern:"skip failures"};record.successorStepsHash=recoveryHash(task.metadata.steps.slice(record.activeContinuation.startStep));},
  ];
  for(const alter of mutations){const task=structuredClone(before);alter(task);assert.throws(()=>validateReviewRemediationEvidence(task,steps,f.clock));assert.ok(reviewRemediationDescriptor(task));}
  assert.throws(()=>validateReviewRemediationEvidence(before,steps,()=>new Date(f.clock().getTime()+15*60000)));
  await assert.rejects(()=>f.recover());assert.deepEqual(await f.current(),before);await f.verifySourceUnchanged();
});

test("coverage binds every acceptance constraint to actual named test source, wired observation and assertion",async t=>{
  const f=await createReviewRemediationFixture(t),before=await f.current(),reads=new Map(f.afterContents),plan={files:[...f.candidate.after].map(([path,content])=>({path,content,operation:"replace"})),focusedTests:f.plan.focusedTests,reviewCoverage:structuredClone(f.candidate.coverage)},options={review:f.review,requiredPaths:[...reads.keys()],reads};
  assert.equal(validateReviewRemediationPlanCoverage(plan,options).focusedTests.length,4);
  for(const[label,alter]of[
    ["missing constraint",plan=>plan.reviewCoverage.pop()],
    ["wrong source hash",plan=>plan.reviewCoverage[0].sourceHash="0".repeat(64)],
    ["arbitrary description stimulus",plan=>plan.reviewCoverage[0].stimulus="Observe the product"],
    ["unwired observation",plan=>plan.reviewCoverage[0].observable="neverObserved"],
    ["absent named test",plan=>plan.reviewCoverage[0].testName="Not in source"],
    ["non-observing assertion",plan=>plan.reviewCoverage[0].assertion="assert.equal(0,0);"],
    ["ninth test",plan=>plan.focusedTests.push({path:"test/ninth.test.js",kind:"existing"})],
    ["ninth mutation",plan=>plan.files.push({path:"test/ninth.test.js",operation:"replace",content:"export const x=1;"})],
    ["create instead of bounded replacement",plan=>plan.files[0].operation="create"],
  ]){const altered=structuredClone(plan);alter(altered);assert.throws(()=>validateReviewRemediationPlanCoverage(altered,options),undefined,label);}
  assert.deepEqual(await f.current(),before);await f.verifySourceUnchanged();
});

test("focused result proves that each coverage test actually executed, not only that some tests passed",()=>{
  const record={workspaceRoot:"/synthetic"},names=["behavior A","behavior B","behavior C","behavior D","behavior E"],plan={reviewCoverage:names.map(testName=>({testName}))},summary="# tests 5\n# suites 0\n# pass 5\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1234.5\n",result={ok:true,exitCode:0,outputTruncated:false,output:names.map((name,index)=>`ok ${index+1} - ${name}`).join("\n")+"\n"+summary};
  assert.equal(validateReviewRemediationTestResult(record,plan,result,{focused:true}).passed,5);
  assert.equal(validateReviewRemediationTestResult(record,plan,{...result,output:names.map(name=>`✔ ${name} (0.015ms)`).join("\n")+"\n"+summary},{focused:true}).passed,5);
  assert.throws(()=>validateReviewRemediationTestResult(record,plan,{...result,outputTruncated:true},{focused:true}));
  for(const output of[summary,names.map(name=>`# ${name}`).join("\n")+"\n"+summary,result.output.replace("ok 1 - behavior A","ok 1 - unrelated"),result.output.replace("ok 1 - behavior A","ok 1 - behavior A # SKIP"),result.output.replace("# cancelled 0","# cancelled 1"),result.output.replace("# todo 0","# todo 1")])assert.throws(()=>validateReviewRemediationTestResult(record,plan,{...result,output},{focused:true}));
});

test("full test success accepts a bounded transcript only with its complete passing terminal summary",()=>{
  const record={workspaceRoot:"/synthetic"},summary="ℹ tests 761\nℹ suites 0\nℹ pass 761\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 34293.7944",result={ok:true,exitCode:0,outputTruncated:true,output:("earlier bounded transcript\n".repeat(1200)+summary).slice(-20000)};
  assert.deepEqual(validateReviewRemediationTestResult(record,null,result),{tests:761,passed:761,failed:0,skipped:0});
  assert.equal(validateReviewRemediationTestResult(record,null,{...result,output:result.output.replaceAll("ℹ","#")}).passed,761);
  for(const altered of[
    {...result,exitCode:1},
    {...result,outputTruncated:undefined},
    {...result,output:summary.slice(summary.indexOf("ℹ pass"))},
    {...result,output:summary.replace("ℹ cancelled 0\n","")},
    {...result,output:summary.replace("ℹ todo 0\n","")},
    {...result,output:summary.replace("ℹ suites 0\n","")},
    {...result,output:summary.replace("\nℹ duration_ms 34293.7944","")},
    {...result,output:summary.replace("ℹ fail 0","ℹ fail 1")},
    {...result,output:summary.replace("ℹ cancelled 0","ℹ cancelled 1")},
    {...result,output:summary.replace("ℹ skipped 0","ℹ skipped 1")},
    {...result,output:summary.replace("ℹ todo 0","ℹ todo 1")},
    {...result,output:summary.replace("ℹ pass 761","ℹ pass 760")},
    {...result,output:summary+"\ntrailing incomplete runner output"},
    {...result,output:summary+"\nℹ tests 762\nℹ pass 761"},
  ])assert.throws(()=>validateReviewRemediationTestResult(record,null,altered));
});
