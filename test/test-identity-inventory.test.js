import test from "node:test";
import assert from "node:assert/strict";
import {deriveCurrentTestIdentityInventory,REVIEW_TEST_IDENTITY_PATHS} from "../src/autonomy/test-identity-inventory.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";

function sources(){
  return new Map(REVIEW_TEST_IDENTITY_PATHS.map((path,index)=>[path,`import test from 'node:test';\ntest('real behavior ${index+1}', () => { assert.equal(${index+1}, ${index+1}); });\n`]));
}

test("current test identity inventory binds exact real names to path and source hash",()=>{
  const reads=sources(),inventory=deriveCurrentTestIdentityInventory(reads);
  assert.deepEqual(inventory,REVIEW_TEST_IDENTITY_PATHS.map((path,index)=>({testPath:path,testName:`real behavior ${index+1}`,sourceHash:canonicalContentHash(reads.get(path))})).sort((a,b)=>a.testPath.localeCompare(b.testPath)));
  assert.equal(inventory.some(item=>item.testName==="fabricated future behavior"),false);
});

test("current test identity inventory fails closed for missing, dynamic, escaped, duplicate, or ambiguous identities",()=>{
  for(const mutate of[
    reads=>reads.delete(REVIEW_TEST_IDENTITY_PATHS[0]),
    reads=>reads.set(REVIEW_TEST_IDENTITY_PATHS[0],"test(dynamicName, () => {});"),
    reads=>reads.set(REVIEW_TEST_IDENTITY_PATHS[0],"test('escaped\\nname', () => {});"),
    reads=>reads.set(REVIEW_TEST_IDENTITY_PATHS[0],"test('duplicate',()=>{}); test('duplicate',()=>{});"),
    reads=>reads.set(REVIEW_TEST_IDENTITY_PATHS[0],"export const helper = true;"),
  ]){
    const reads=sources();mutate(reads);
    assert.throws(()=>deriveCurrentTestIdentityInventory(reads),error=>error.code==="test_identity_inventory_invalid"&&error.safeDiagnostics?.mutationApplied===false);
  }
});

test("current test identity inventory hashes change with exact source bytes so stale bindings cannot be reused",()=>{
  const reads=sources(),before=deriveCurrentTestIdentityInventory(reads),path=REVIEW_TEST_IDENTITY_PATHS[0];
  reads.set(path,`${reads.get(path)}\ntest('new current behavior', () => { assert.equal(true, true); });\n`);
  const after=deriveCurrentTestIdentityInventory(reads),oldHash=before.find(item=>item.testPath===path).sourceHash,current=after.filter(item=>item.testPath===path);
  assert.ok(current.every(item=>item.sourceHash===canonicalContentHash(reads.get(path))));assert.ok(current.every(item=>item.sourceHash!==oldHash));assert.equal(current.some(item=>item.testName==="new current behavior"),true);
});

test("inventory ignores property and regex lookalikes and rejects concatenated dynamic names",()=>{
  const reads=sources(),path=REVIEW_TEST_IDENTITY_PATHS[0];
  reads.set(path,"pattern.test('not a node test'); assert.match(source, /test('also not a test')/); test('real identity', () => {});");
  assert.deepEqual(deriveCurrentTestIdentityInventory(reads).filter(item=>item.testPath===path).map(item=>item.testName),["real identity"]);
  reads.set(path,"test('dynamic ' + suffix, () => {});");
  assert.throws(()=>deriveCurrentTestIdentityInventory(reads),error=>error.code==="test_identity_inventory_invalid");
});
