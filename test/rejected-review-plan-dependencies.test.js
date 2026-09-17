import test from "node:test";
import assert from "node:assert/strict";
import {readFile,writeFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {createRejectedReviewPlanFixture,assertRejectedReviewHistoriesPreserved,REJECTED_REVIEW_HISTORY,REJECTED_REVIEW_BOUNDARY} from "./rejected-review-plan-fixture.js";

for(const mode of ["missing installed package","version differs from lock","unresolvable installed entry"])test(`rejected-plan full tests stop before npm when ${mode}`,async t=>{
  const f=await createRejectedReviewPlanFixture(t),before=await f.current();
  await f.authorize();await f.recover();await f.runSteps(12);
  const packagePath=join(f.root,"node_modules","@neondatabase","serverless","package.json"),manifest=await readFile(join(f.root,"package.json")),lock=await readFile(join(f.root,"package-lock.json"));
  if(mode==="missing installed package")await rm(packagePath);
  else{const installed=JSON.parse(await readFile(packagePath,"utf8"));await writeFile(packagePath,JSON.stringify({...installed,...(mode==="version differs from lock"?{version:"0.0.0"}:{exports:"./not-present.js",main:"./not-present.js"})}));}
  const priorCommandCount=f.commands.length;
  await assert.rejects(()=>f.worker.runOnce(),error=>error.code==="dependency_provisioning_required");
  const final=await f.current(),record=final.metadata[REJECTED_REVIEW_HISTORY].at(-1),step=(await f.steps()).find(item=>item.stepId===record.fullTestStepId);
  assert.equal(final.status,"blocked");assert.equal(final.metadata[REJECTED_REVIEW_BOUNDARY].kind,"product_repair_decision");assert.equal(final.metadata[REJECTED_REVIEW_BOUNDARY].executionAuthorized,false);assert.equal(record.consumed,true);
  assert.equal(step.status,"failed");assert.equal(step.errorCode,"dependency_provisioning_required");assert.equal(step.result.diagnostics.npmInvoked,false);assert.equal(step.result.diagnostics.resolved,false);assert.equal(step.result.diagnostics.consumesOnFailure,true);assert.equal(step.result.diagnostics.mutationApplied,false);assert.equal(step.result.diagnostics.workspaceRoot.replaceAll("\\","/").toLowerCase(),f.root.replaceAll("\\","/").toLowerCase());
  assert.equal(f.commands.slice(priorCommandCount).some(command=>command.args.some(arg=>arg==="test")),false);
  assert.deepEqual(await readFile(join(f.root,"package.json")),manifest);assert.deepEqual(await readFile(join(f.root,"package-lock.json")),lock);await f.verifyCandidate();assertRejectedReviewHistoriesPreserved(before,final);
  assert.deepEqual(await f.worker.runOnce(),{worked:false});await assert.rejects(()=>f.recover());assert.deepEqual(await f.current(),final);
});
