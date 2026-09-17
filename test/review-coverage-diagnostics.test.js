import test from "node:test";
import assert from "node:assert/strict";
import {validateReviewCoverageBindings} from "../src/autonomy/review-coverage-diagnostics.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";
import {REVIEW_REMEDIATION_INPUT_DISTINCTIONS} from "../src/autonomy/self-development-implementation-planner.js";

function fixture(){
  const paths=["assets/app.js","assets/state.js","assets/view.css","index.html","test/a.test.js","test/b.test.js","test/c.test.js","test/d.test.js"],tests=paths.slice(4);
  const source="test('behavior', () => { const result = exercise(); assert.equal(result, true); });";
  const reads=new Map(paths.map(path=>[path,tests.includes(path)?source:"export const fixture = true;"]));
  const findings=Array.from({length:4},(_,index)=>({id:`F${index+1}`,paths:[paths[index]],severity:"blocking"}));
  const review={findings,acceptanceConstraints:Array.from({length:5},(_,index)=>({id:`C${index+1}`,findingIds:[findings[index%4].id],text:`Approved requirement ${index+1}`}))};
  const coverage=review.acceptanceConstraints.map((constraint,index)=>({constraintId:constraint.id,findingIds:constraint.findingIds,testPath:tests[index%4],testName:"behavior",sourceExcerpt:source,sourceHash:canonicalContentHash(source),stimulus:"const result = exercise();",observable:"result",assertion:"assert.equal(result, true);"}));
  const plan={files:[{path:paths[0],operation:"replace",content:"export const fixture = false;"}],focusedTests:tests.map(path=>({path,kind:"existing"})),reviewCoverage:coverage};
  const context={stateVersion:279,continuationGenerationId:"a".repeat(64),planFingerprint:"b".repeat(64)};
  return{plan,options:{review,requiredPaths:paths,reads,context},source};
}

function replaceTestSource(f,source){
  const path=f.plan.reviewCoverage[0].testPath;
  f.options.reads.set(path,source);
  for(const item of f.plan.reviewCoverage.filter(item=>item.testPath===path)){item.sourceExcerpt=source;item.sourceHash=canonicalContentHash(source);}
}

function rejected(f){
  const before=structuredClone({plan:f.plan,options:f.options});
  let failure;
  try{validateReviewCoverageBindings(f.plan,f.options);}catch(error){failure=error;}
  assert.ok(failure,"Expected the unchanged fail-closed validator to reject");
  assert.deepEqual({plan:f.plan,options:f.options},before,"Eligibility must not modify inputs or workspace evidence");
  assert.equal(failure.statusCode,409);assert.equal(failure.safeDiagnostics.mutationApplied,false);
  return failure;
}

test("valid coverage retains the exact legacy result and all caller evidence unchanged",()=>{
  const f=fixture(),before=structuredClone(f);
  assert.deepEqual(validateReviewCoverageBindings(f.plan,f.options),{coverageHash:recoveryHash(f.plan.reviewCoverage),focusedTests:f.plan.focusedTests.map(item=>item.path)});
  assert.deepEqual(f,before);
});

test("semantic evidence accepts exact existing tests and exact proposed replacement tests",()=>{
  const existing=fixture();existing.options.context.semanticEvidenceReplan=true;
  assert.doesNotThrow(()=>validateReviewCoverageBindings(existing.plan,existing.options));

  const replacement=fixture(),path=replacement.plan.reviewCoverage[0].testPath,name="new bounded regression",source=`test('${name}', () => { const result = exercise(); assert.equal(result, true); });`;
  replacement.options.context.semanticEvidenceReplan=true;
  replacement.plan.files.push({path,operation:"replace",content:source});
  for(const item of replacement.plan.reviewCoverage.filter(entry=>entry.testPath===path))Object.assign(item,{testName:name,sourceExcerpt:source,sourceHash:canonicalContentHash(source)});
  assert.doesNotThrow(()=>validateReviewCoverageBindings(replacement.plan,replacement.options));
});

test("semantic evidence rejects nonexistent unchanged and placeholder test identities",()=>{
  const nonexistent=fixture();nonexistent.options.context.semanticEvidenceReplan=true;nonexistent.plan.reviewCoverage[0].testName="missing exact test";
  let diagnostics=rejected(nonexistent).safeDiagnostics.coverageDiagnostics;
  assert.deepEqual(diagnostics.firstFailure,{predicate:"semantic_test_identity_binding",constraintId:"C1",subclause:"test_identity_exists_in_exact_source"});

  const placeholder=fixture(),path=placeholder.plan.reviewCoverage[0].testPath,name="hypothetical future test",source=`test('${name}', () => { const result = exercise(); assert.equal(result, true); });`;
  placeholder.options.context.semanticEvidenceReplan=true;placeholder.plan.files.push({path,operation:"replace",content:source});
  for(const item of placeholder.plan.reviewCoverage.filter(entry=>entry.testPath===path))Object.assign(item,{testName:name,sourceExcerpt:source,sourceHash:canonicalContentHash(source)});
  diagnostics=rejected(placeholder).safeDiagnostics.coverageDiagnostics;
  assert.deepEqual(diagnostics.firstFailure,{predicate:"semantic_test_identity_binding",constraintId:"C1",subclause:"test_name_not_placeholder"});
});

const cases=[
  ["missing mutation","ninth_file_or_operation_forbidden","mutation_array",f=>delete f.plan.files],
  ["empty mutation","ninth_file_or_operation_forbidden","mutation_count",f=>f.plan.files=[]],
  ["ninth mutation","ninth_file_or_operation_forbidden","replacement_sources_in_scope",f=>f.plan.files[0].path="test/ninth.test.js"],
  ["duplicate mutation","ninth_file_or_operation_forbidden","unique_mutation_paths",f=>f.plan.files.push({...f.plan.files[0]})],
  ["create operation","ninth_file_or_operation_forbidden","replacement_sources_in_scope",f=>f.plan.files[0].operation="create"],
  ["missing tests","focused_scope_authorization","focused_array",f=>delete f.plan.focusedTests],
  ["empty tests","focused_scope_authorization","focused_count",f=>f.plan.focusedTests=[]],
  ["duplicate focused path","focused_scope_authorization","unique_focused_paths",f=>f.plan.focusedTests[1]={...f.plan.focusedTests[0]}],
  ["ninth focused path","focused_scope_authorization","fresh_existing_focused_scope",f=>f.plan.focusedTests[0].path="test/ninth.test.js"],
  ["missing coverage","complete_behavioral_coverage","coverage_array",f=>delete f.plan.reviewCoverage],
  ["missing constraint","complete_behavioral_coverage","coverage_count",f=>f.plan.reviewCoverage.pop()],
  ["duplicate constraint","complete_behavioral_coverage","unique_constraint_ids",f=>f.plan.reviewCoverage[1].constraintId="C1"],
  ["unknown constraint","source_bound_behavioral_coverage","coverage_record_allowed_fields",f=>f.plan.reviewCoverage[0].constraintId="unknown"],
  ["unknown coverage field","source_bound_behavioral_coverage","coverage_record_allowed_fields",f=>f.plan.reviewCoverage[0].reasoning="must never persist"],
  ["wrong finding","source_bound_behavioral_coverage","finding_ids_match",f=>f.plan.reviewCoverage[0].findingIds=["F2"]],
  ["unselected test","source_bound_behavioral_coverage","selected_focused_test",f=>f.plan.reviewCoverage[0].testPath="assets/app.js"],
  ["invalid test name","source_bound_behavioral_coverage","test_name_bounded",f=>f.plan.reviewCoverage[0].testName=""],
  ["invalid excerpt","source_bound_behavioral_coverage","source_excerpt_bounded",f=>f.plan.reviewCoverage[0].sourceExcerpt=""],
  ["invalid hash","source_bound_behavioral_coverage","source_hash_format",f=>f.plan.reviewCoverage[0].sourceHash="not-a-hash"],
  ["wrong hash","source_bound_behavioral_coverage","source_hash_matches",f=>f.plan.reviewCoverage[0].sourceHash="0".repeat(64)],
  ["excerpt not in source","source_bound_behavioral_coverage","source_contains_excerpt",f=>f.plan.reviewCoverage[0].sourceExcerpt="a different body"],
  ["test name not in excerpt","source_bound_behavioral_coverage","excerpt_contains_test_name",f=>f.plan.reviewCoverage[0].testName="different behavior"],
  ["invalid stimulus","source_bound_behavioral_coverage","stimulus_bounded",f=>f.plan.reviewCoverage[0].stimulus=""],
  ["invalid observable","source_bound_behavioral_coverage","observable_bounded",f=>f.plan.reviewCoverage[0].observable="x".repeat(501)],
  ["invalid assertion","source_bound_behavioral_coverage","assertion_bounded",f=>f.plan.reviewCoverage[0].assertion=""],
  ["assertion not in excerpt","source_bound_behavioral_coverage","excerpt_contains_assertion",f=>f.plan.reviewCoverage[0].assertion="assert.equal(result, false);"],
  ["non-assertion","source_bound_behavioral_coverage","assertion_is_assertion",f=>{replaceTestSource(f,f.source.replace("assert.equal","check.equal"));f.plan.reviewCoverage[0].assertion="check.equal(result, true);";}],
  ["not a test declaration","observable_behavioral_test_linkage","named_test_declaration",f=>replaceTestSource(f,f.source.replace("test('behavior'","custom('behavior'"))],
  ["not a code reference","observable_behavioral_test_linkage","observable_code_reference",f=>f.plan.reviewCoverage[0].observable="result()"],
  ["stimulus not in excerpt","observable_behavioral_test_linkage","excerpt_contains_stimulus",f=>f.plan.reviewCoverage[0].stimulus="perform different action"],
  ["stimulus after assertion","observable_behavioral_test_linkage","stimulus_precedes_assertion",f=>{replaceTestSource(f,f.source.replace(" });"," later(); });"));f.plan.reviewCoverage[0].stimulus="later();";}],
  ["unobserved reference","observable_behavioral_test_linkage","assertion_observes_reference",f=>f.plan.reviewCoverage[0].observable="other"],
  ["token-only assertion","observable_behavioral_test_linkage","not_token_only_source_check",f=>{replaceTestSource(f,"test('behavior', () => { const source = render(); assert.match(source, /token/); });");Object.assign(f.plan.reviewCoverage[0],{stimulus:"const source = render();",observable:"source",assertion:"assert.match(source, /token/);"});}],
  ["unwired constant","observable_behavioral_test_linkage","not_unwired_constant_observation",f=>{replaceTestSource(f,f.source.replace("const result = exercise();","let result = 0;"));f.plan.reviewCoverage[0].stimulus="let result = 0;";}],
];
for(const[label,predicate,subclause,alter]of cases)test(`bounded diagnostics identify ${label} without changing its rejection predicate`,()=>{
  const f=fixture();alter(f);const error=rejected(f),diagnostics=error.safeDiagnostics.coverageDiagnostics;
  assert.equal(error.safeDiagnostics.predicate,predicate);assert.equal(error.message,`Review remediation rejected: ${predicate}.`);
  assert.equal(error.code,["ninth_file_or_operation_forbidden","focused_scope_authorization"].includes(predicate)?"review_remediation_scope_authorization_required":"review_remediation_precondition_failed");
  assert.equal(diagnostics.firstFailure.subclause,subclause);assert.equal(diagnostics.firstFailure.predicate,predicate);
  assert.equal(diagnostics.constraints.length,5);assert.equal(diagnostics.planFingerprint,f.options.context.planFingerprint);assert.equal(diagnostics.continuationGenerationId,f.options.context.continuationGenerationId);assert.equal(diagnostics.stateVersion,279);
  assert.ok(JSON.stringify(diagnostics).length<24000);
});

test("evaluated clauses preserve first-failure order and later approved constraints are explicitly unevaluated",()=>{
  const f=fixture();f.plan.reviewCoverage[3].sourceHash="0".repeat(64);f.plan.reviewCoverage[3].sourceExcerpt="also wrong";
  const d=rejected(f).safeDiagnostics.coverageDiagnostics;
  assert.deepEqual(d.firstFailure,{predicate:"source_bound_behavioral_coverage",constraintId:"C4",subclause:"source_hash_matches"});
  assert.ok(d.constraints.slice(0,3).every(item=>item.evaluated&&item.clauses.every(clause=>clause.passed)));
  assert.equal(d.constraints[3].clauses.at(-1).subclause,"source_hash_matches");assert.equal(d.constraints[3].clauses.at(-1).passed,false);
  assert.equal(d.constraints[3].expectedSourceHash,canonicalContentHash(f.source));assert.equal(d.constraints[3].suppliedSourceHash,"0".repeat(64));
  assert.deepEqual(d.constraints[3].sourcePaths,["index.html"]);assert.deepEqual(d.constraints[3].findingIds,["F4"]);
  assert.equal(d.constraints[4].evaluated,false);assert.deepEqual(d.constraints[4].clauses,[]);assert.equal(d.constraints[4].firstFailedSubclause,null);
});

test("unknown model identifiers, paths, secrets, reasoning and source fragments never enter diagnostics",()=>{
  const marker="DO_NOT_STORE_PRIVATE_MODEL_TEXT_12345",f=fixture();
  f.plan.files[0].reason=marker;f.plan.files[0].content+=marker;f.plan.reviewCoverage[0].reasoning=marker;f.plan.reviewCoverage[0].testName=marker;f.plan.reviewCoverage[0].sourceExcerpt=marker;f.plan.reviewCoverage[0].assertion=marker;f.plan.reviewCoverage[0].stimulus=marker;f.plan.reviewCoverage[0].observable=marker;f.plan.reviewCoverage[0].sourceHash=marker;f.plan.reviewCoverage[0].testPath=`test/${marker}.test.js`;
  const d=rejected(f).safeDiagnostics.coverageDiagnostics,serialized=JSON.stringify(d),item=d.constraints[0];
  assert.equal(serialized.includes(marker),false);assert.equal(serialized.includes(f.source),false);assert.equal(item.testPath,null);assert.equal(item.untrustedTestPathFingerprint,recoveryHash(f.plan.reviewCoverage[0].testPath));assert.equal(item.suppliedSourceHash,null);assert.equal(item.suppliedSourceHashPresent,true);
  assert.deepEqual(d.proposedMutationPaths,["assets/app.js"]);assert.deepEqual(item.sourcePaths,["assets/app.js"]);
  const outside=fixture();outside.plan.files[0].path=`test/${marker}.test.js`;outside.plan.focusedTests[0].path=`test/${marker}.test.js`;const rejectedScope=rejected(outside).safeDiagnostics.coverageDiagnostics;
  assert.equal(JSON.stringify(rejectedScope).includes(marker),false);assert.equal(rejectedScope.untrustedMutationPathCount,1);assert.equal(rejectedScope.untrustedFocusedTestPathCount,1);
  const wrongFinding=fixture();wrongFinding.plan.reviewCoverage[0].findingIds=["F2",marker];const finding=rejected(wrongFinding).safeDiagnostics.coverageDiagnostics.constraints[0];
  assert.deepEqual(finding.findingIds,["F1"]);assert.deepEqual(finding.suppliedFindingIds,["F2"]);assert.deepEqual(finding.untrustedFindingIdFingerprints,[recoveryHash(marker)]);assert.equal(JSON.stringify(finding).includes(marker),false);
});

test("planner input distinguishes all six concepts without filling product mappings",()=>{
  const d=REVIEW_REMEDIATION_INPUT_DISTINCTIONS;
  for(const key of["reviewConstraint","sourceFinding","mutationPath","focusedTestPath","acceptanceMapping","reviewCoverage"])assert.equal(typeof d[key].meaning,"string");
  assert.match(d.acceptanceMapping.meaning,/generated patch files only/);assert.match(d.reviewCoverage.meaning,/exactly one/i);assert.match(d.nonMutatedUnresolvedSource,/unless the current evidence proves/);
  assert.doesNotMatch(JSON.stringify(d),/assets\/|test\/|selfdev_|911c1|279/);
  assert.ok(Object.values(d).every(item=>typeof item==="string"||!Object.hasOwn(item,"files")));
});
