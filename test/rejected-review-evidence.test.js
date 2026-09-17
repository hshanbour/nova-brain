import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRejectedReviewEvidence,attachRejectedReviewEvidence,getRejectedReviewEvidence,takeRejectedReviewEvidence,
  isRejectedReviewEvidenceEnvelope,validateRejectedReviewEvidenceEnvelope,
  REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT,REJECTED_REVIEW_EVIDENCE_LIMITS,
} from "../src/autonomy/rejected-review-evidence.js";
import {validateReviewCoverageBindings} from "../src/autonomy/review-coverage-diagnostics.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {recoveryHash} from "../src/autonomy/failed-local-read-recovery.js";

function fixture(){
  const requiredPaths=["assets/app.js","assets/state.js","assets/view.css","index.html","test/a.test.js","test/b.test.js","test/c.test.js","test/d.test.js"];
  const source="test('behavior', () => { const result = exercise(); assert.equal(result, true); });";
  const reads=new Map(requiredPaths.map(path=>[path,path.startsWith("test/")?source:"export const fixture = true;"]));
  const findings=Array.from({length:4},(_,index)=>({id:`F${index+1}`,paths:[requiredPaths[index]],severity:"blocking"}));
  const review={findings,acceptanceConstraints:Array.from({length:5},(_,index)=>({id:`C${index+1}`,findingIds:[findings[index%4].id],text:`Approved requirement ${index+1}`}))};
  const reviewCoverage=review.acceptanceConstraints.map((constraint,index)=>({constraintId:constraint.id,findingIds:constraint.findingIds,testPath:requiredPaths[4+index%4],testName:"behavior",sourceExcerpt:source,stimulus:"const result = exercise();",observable:"result",assertion:"assert.equal(result, true);"}));
  reviewCoverage[0].testName="different behavior";
  const plan={files:[{path:requiredPaths[0],operation:"replace",content:"export const fixture = false;"}],focusedTests:requiredPaths.slice(4).map(path=>({path,kind:"existing"})),reviewCoverage};
  const task={id:"synthetic-private-evidence",stateVersion:307,metadata:{activeContinuation:{generationId:"a".repeat(64)}}};
  const context={stateVersion:task.stateVersion,continuationGenerationId:task.metadata.activeContinuation.generationId,planGenerationId:"c".repeat(64),planFingerprint:recoveryHash(plan)};
  let error;
  try{validateReviewCoverageBindings({...plan,reviewCoverage:reviewCoverage.map(item=>({...item,sourceHash:canonicalContentHash(reads.get(item.testPath))}))},{review,requiredPaths,reads,context});}catch(caught){error=caught;}
  assert.equal(error?.safeDiagnostics?.coverageDiagnostics?.firstFailure?.subclause,"excerpt_contains_test_name");
  return{task,executionId:"187:plan_repair",attempt:1,plan,review,requiredPaths,reads,diagnostics:error.safeDiagnostics,error,source};
}

const entry=options=>buildRejectedReviewEvidence(options)?.coverage[0];
const textFields=["testName","sourceExcerpt","stimulus","observable","assertion"];

test("private rejection envelope retains only the bounded artifact fields and actual failed clauses",()=>{
  const f=fixture(),before=structuredClone({task:f.task,plan:f.plan,review:f.review,diagnostics:f.diagnostics});
  const envelope=buildRejectedReviewEvidence(f),first=envelope.coverage[0];
  assert.equal(isRejectedReviewEvidenceEnvelope(envelope),true);
  assert.deepEqual({task:f.task,plan:f.plan,review:f.review,diagnostics:f.diagnostics},before);
  assert.equal(envelope.version,1);assert.equal(envelope.diagnosticOnly,true);assert.equal(envelope.executionAuthorized,false);assert.equal(envelope.mutationApplied,false);
  assert.equal(envelope.taskId,f.task.id);assert.equal(envelope.stateVersion,307);assert.equal(envelope.executionId,"187:plan_repair");assert.equal(envelope.attempt,1);
  assert.equal(envelope.continuationGenerationId,"a".repeat(64));assert.equal(envelope.planGenerationId,"c".repeat(64));assert.equal(envelope.planFingerprint,recoveryHash(f.plan));
  assert.deepEqual(envelope.proposedMutationPaths,[f.requiredPaths[0]]);assert.deepEqual(envelope.selectedFocusedTestPaths,f.requiredPaths.slice(4));
  assert.equal(envelope.rejectionPredicate,"source_bound_behavioral_coverage");assert.equal(envelope.coverage.length,5);
  assert.equal(first.constraintId,"C1");assert.deepEqual(first.findingIds,["F1"]);assert.deepEqual(first.sourcePaths,[f.requiredPaths[0]]);
  for(const field of textFields)assert.equal(first[field],f.plan.reviewCoverage[0][field],field);
  assert.equal(first.firstFailedSubclause,"excerpt_contains_test_name");assert.equal(first.evaluated,true);
  assert.deepEqual(first.clauses.at(-1),{predicate:"source_bound_behavioral_coverage",subclause:"excerpt_contains_test_name",passed:false});
  assert.ok(envelope.coverage.slice(1).every(item=>item.evaluated===false&&item.clauses.length===0&&item.firstFailedSubclause===null));
});

test("private rejection envelope retains bounded semantic identity diagnostics needed by the next successor",()=>{
  const f=fixture();f.plan.reviewCoverage[0].testName="missing exact test";
  const plan={...f.plan,reviewCoverage:f.plan.reviewCoverage.map(item=>({...item,sourceHash:canonicalContentHash(f.reads.get(item.testPath))}))};
  try{validateReviewCoverageBindings(plan,{review:f.review,requiredPaths:f.requiredPaths,reads:f.reads,context:{stateVersion:f.task.stateVersion,continuationGenerationId:f.task.metadata.activeContinuation.generationId,planFingerprint:recoveryHash(plan),semanticEvidenceReplan:true}});}catch(error){f.diagnostics=error.safeDiagnostics;}
  const envelope=buildRejectedReviewEvidence(f),first=envelope.coverage[0];
  assert.equal(envelope.rejectionPredicate,"semantic_test_identity_binding");assert.equal(first.firstFailedSubclause,"test_identity_exists_in_exact_source");assert.deepEqual(first.clauses,[{predicate:"semantic_test_identity_binding",subclause:"test_name_not_placeholder",passed:true},{predicate:"semantic_test_identity_binding",subclause:"test_identity_exists_in_exact_source",passed:false}]);
});

test("source hashes distinguish fresh bytes, proposed replacement bytes, and supplied versus derived bindings",()=>{
  const f=fixture();let first=entry(f);
  assert.equal(first.sourceOrigin,"fresh_read");assert.equal(first.expectedSourceHash,canonicalContentHash(f.source));
  assert.equal(first.suppliedSourceHash,canonicalContentHash(f.source));assert.equal(first.suppliedSourceHashOrigin,"runtime_derived");
  const replacement="test('changed', () => {\r\n const changed = true;\r\n});";
  f.plan.files.push({path:f.plan.reviewCoverage[0].testPath,operation:"replace",content:replacement});
  f.plan.reviewCoverage[0].sourceHash="b".repeat(64);first=entry(f);
  assert.equal(first.sourceOrigin,"proposed_replacement");assert.equal(first.expectedSourceHash,canonicalContentHash(replacement));
  assert.equal(first.suppliedSourceHash,"b".repeat(64));assert.equal(first.suppliedSourceHashOrigin,"model_supplied");
  delete f.plan.reviewCoverage[0].sourceHash;f.plan.files.pop();f.reads.clear();first=entry(f);
  assert.equal(first.sourceOrigin,"validator_evidence");assert.equal(first.expectedSourceHash,canonicalContentHash(f.source));
});

test("schema rejections receive a stable parsed-plan fingerprint without retaining unknown model data",()=>{
  const f=fixture(),marker="PRIVATE_PROVIDER_REASONING_AND_RAW_PAYLOAD_MUST_NOT_APPEAR";
  f.diagnostics={validationCode:"implementation_plan_invalid",rawResponse:marker};
  Object.assign(f.plan,{summary:marker,reason:marker,rationale:marker,reasoning:marker,rawResponse:marker,response_id:marker,approvalId:marker,commands:[marker],executionAuthorized:true});
  Object.assign(f.plan.files[0],{reason:marker,content:marker});
  Object.assign(f.plan.reviewCoverage[0],{reasoning:marker,rawResponse:marker,tool:marker,mutationApplied:true});
  const envelope=buildRejectedReviewEvidence(f),serialized=JSON.stringify(envelope);
  assert.equal(envelope.planFingerprint,recoveryHash(f.plan));assert.equal(envelope.rejectionPredicate,"implementation_plan_invalid");
  assert.equal(serialized.includes(marker),false);assert.equal(envelope.executionAuthorized,false);assert.equal(envelope.mutationApplied,false);
  for(const field of ["summary","reason","rationale","reasoning","rawResponse","response_id","approvalId","commands","tool"])assert.equal(Object.hasOwn(envelope,field),false,field);
  const reordered=Object.fromEntries(Object.entries(f.plan).reverse());assert.equal(buildRejectedReviewEvidence({...f,plan:reordered}).planFingerprint,envelope.planFingerprint);
});

test("WeakMap error capture is private, immutable to later inputs, and never enumerable",()=>{
  const f=fixture(),error=new Error("unchanged rejection");error.safeDiagnostics={predicate:"source_bound_behavioral_coverage"};
  const ownKeys=Reflect.ownKeys(error),publicBefore=JSON.stringify(error),fields=structuredClone(f.plan.reviewCoverage[0]);
  assert.equal(attachRejectedReviewEvidence(error,f),error);
  assert.deepEqual(Reflect.ownKeys(error),ownKeys);assert.equal(JSON.stringify(error),publicBefore);
  f.plan.reviewCoverage[0].sourceExcerpt="later mutation";
  attachRejectedReviewEvidence(error,{...f,executionId:"188:plan_repair"});
  const first=getRejectedReviewEvidence(error);assert.equal(first.coverage[0].sourceExcerpt,fields.sourceExcerpt);assert.equal(first.executionId,"187:plan_repair");
  assert.equal(validateRejectedReviewEvidenceEnvelope(first),true);
  first.coverage[0].sourceExcerpt="caller mutation";
  assert.equal(isRejectedReviewEvidenceEnvelope(first),false);assert.equal(getRejectedReviewEvidence(error).coverage[0].sourceExcerpt,fields.sourceExcerpt);
  const taken=takeRejectedReviewEvidence(error);assert.equal(isRejectedReviewEvidenceEnvelope(taken),true);assert.equal(getRejectedReviewEvidence(error),null);assert.equal(takeRejectedReviewEvidence(error),null);
});

test("storage branding rejects caller-made, JSON-parsed, cloned, and modified envelopes",()=>{
  const envelope=buildRejectedReviewEvidence(fixture());
  for(const value of [null,{},false,JSON.parse(JSON.stringify(envelope)),structuredClone(envelope)])assert.equal(isRejectedReviewEvidenceEnvelope(value),false);
  envelope.executionAuthorized=true;assert.equal(isRejectedReviewEvidenceEnvelope(envelope),false);
  const another=buildRejectedReviewEvidence(fixture());another.coverage[0].authority={approved:true};assert.equal(isRejectedReviewEvidenceEnvelope(another),false);
});

test("each artifact field has a UTF-8 byte cap and is omitted whole instead of silently truncated",()=>{
  for(const field of textFields){
    const f=fixture(),limit=REJECTED_REVIEW_EVIDENCE_LIMITS[field];
    f.plan.reviewCoverage[0][field]="x".repeat(limit);assert.equal(entry(f)[field].length,limit,field);
    f.plan.reviewCoverage[0][field]="x".repeat(limit+1);let first=entry(f);
    assert.equal(first[field],null);assert.ok(first.omittedFields.some(item=>item.field===field&&item.reason==="field_limit"));
    f.plan.reviewCoverage[0][field]="ع".repeat(Math.floor(limit/2)+1);first=entry(f);assert.equal(first[field],null);
  }
});

test("total envelope cap includes JSON escaping and conservative PostgreSQL separator overhead",()=>{
  const f=fixture();f.diagnostics.coverageDiagnostics.firstFailure.constraintId="C4";
  for(const mapping of f.plan.reviewCoverage)for(const field of textFields)mapping[field]="\\".repeat(REJECTED_REVIEW_EVIDENCE_LIMITS[field]);
  const envelope=buildRejectedReviewEvidence(f),pretty=JSON.stringify(envelope,null,1),compact=JSON.stringify(envelope);
  assert.equal(isRejectedReviewEvidenceEnvelope(envelope),true);
  assert.ok(Buffer.byteLength(pretty,"utf8")<=REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT);assert.ok(Buffer.byteLength(compact,"utf8")<=REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT);
  assert.ok(envelope.coverage.some(item=>item.omittedFields.some(field=>field.reason==="envelope_limit")));
  assert.equal(envelope.coverage[3].sourceExcerpt,f.plan.reviewCoverage[3].sourceExcerpt,"Retain the actual first-failing constraint longest");
});

const secretCases=[
  ["JS password",'const password = "example-password-private";',"example-password-private"],
  ["single-quoted JSON key",'{\'apiKey\':\'example-key-private\'}',"example-key-private"],
  ["nested JSON secret",'{"outer":{"secret":"example-nested-private"}}',"example-nested-private"],
  ["nested example string",'const example = "password=example-inner-private";',"example-inner-private"],
  ["environment token","APP_ACCESS_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
  ["query credential","https://example.invalid/path?token=example-query-private&ok=1","example-query-private"],
  ["session","sessionId = 'example-session-private'","example-session-private"],
  ["cookie header","Cookie: sid=example-cookie-private; extra=example-second-private","example-cookie-private","example-second-private"],
  ["Bearer","Authorization: Bearer example-bearer-private","example-bearer-private"],
  ["provider token","const value = 'sk-proj-exampleProviderPrivate123';","sk-proj-exampleProviderPrivate123"],
  ["GitHub token","ghp_exampleGithubPrivate123","ghp_exampleGithubPrivate123"],
  ["JWT","eyJexampleHeader.examplePayload.exampleSignature","eyJexampleHeader.examplePayload.exampleSignature"],
  ["credential URL","postgres://example-user:example-url-private@example.invalid/db","example-url-private","example-user"],
  ["private key","-----BEGIN RSA PRIVATE KEY-----\nexample-private-key\n-----END RSA PRIVATE KEY-----","example-private-key"],
  ["unterminated private key","-----BEGIN PRIVATE KEY-----\nexample-incomplete-private","example-incomplete-private"],
];
for(const[label,value,...secrets]of secretCases)test(`literal artifact secret filtering removes ${label} without exposing original values`,()=>{
  const f=fixture();for(const field of textFields)f.plan.reviewCoverage[0][field]=value;
  const envelope=buildRejectedReviewEvidence(f),serialized=JSON.stringify(envelope),first=envelope.coverage[0];
  for(const secret of secrets)assert.equal(serialized.includes(secret),false,secret);
  for(const field of textFields)assert.ok(first.redactedFields.includes(field),field);
  assert.ok(first.sourceExcerpt.includes("[REDACTED"));
});

test("redaction marker expansion is still subject to the exact field limit",()=>{
  const f=fixture();f.plan.reviewCoverage[0].testName=" ".repeat(294)+"key=1";
  const first=entry(f);assert.equal(first.testName,null);assert.ok(first.redactedFields.includes("testName"));
  assert.ok(first.omittedFields.some(item=>item.field==="testName"&&item.reason==="redaction_limit"));
});

test("binary, control, bidi, and invalid-Unicode content is unavailable, while ordinary Unicode source survives",()=>{
  for(const value of [Buffer.from("binary"),new Uint8Array([1,2]),{},123,"x\0y","x\u001by","x\u0085y","x\u202ey","x\ud800y"]){
    const f=fixture();f.plan.reviewCoverage[0].sourceExcerpt=value;const first=entry(f);
    assert.equal(first.sourceExcerpt,null);assert.ok(first.omittedFields.some(item=>item.field==="sourceExcerpt"&&["unprintable","invalid_type"].includes(item.reason)));
  }
  const f=fixture(),source="test('العربية English 🧪', () => {\r\n\tassert.equal('نص', 'نص');\n});";
  f.plan.reviewCoverage[0].sourceExcerpt=source;assert.equal(entry(f).sourceExcerpt,source);
});

test("only approved paths, IDs and fixed diagnostic clauses can enter the envelope",()=>{
  const f=fixture(),marker="UNTRUSTED_PRIVATE_PATH_OR_DIAGNOSTIC";
  f.plan.files[0].path=`test/${marker}.test.js`;f.plan.focusedTests[0].path=`test/${marker}.test.js`;
  Object.assign(f.plan.reviewCoverage[0],{testPath:`test/${marker}.test.js`,findingIds:[marker],sourceHash:marker});
  f.diagnostics.coverageDiagnostics.constraints[0].clauses.push({predicate:marker,subclause:marker,passed:false,reasoning:marker},{predicate:"source_bound_behavioral_coverage",subclause:"source_hash_matches",passed:true,reasoning:marker});
  const envelope=buildRejectedReviewEvidence(f),first=envelope.coverage[0];
  assert.equal(JSON.stringify(envelope).includes(marker),false);assert.equal(first.testPath,null);assert.deepEqual(first.findingIds,["F1"]);
  assert.deepEqual(first.clauses.at(-1),{predicate:"source_bound_behavioral_coverage",subclause:"source_hash_matches",passed:true});
  assert.ok(first.omittedFields.some(item=>item.field==="testPath"&&item.reason==="out_of_scope"));
});

test("coverage, mutation, focused and clause arrays have fixed caps without expanding scope",()=>{
  const f=fixture();f.plan.files=Array.from({length:100},(_,index)=>({path:f.requiredPaths[index%8],content:"irrelevant"}));
  f.plan.focusedTests=Array.from({length:100},(_,index)=>({path:f.requiredPaths[4+index%4]}));
  f.plan.reviewCoverage.push(...Array.from({length:100},()=>({...f.plan.reviewCoverage[0]})));
  f.diagnostics.coverageDiagnostics.constraints[0].clauses=Array.from({length:100},()=>({predicate:"source_bound_behavioral_coverage",subclause:"source_hash_matches",passed:false}));
  const envelope=buildRejectedReviewEvidence(f);
  assert.equal(envelope.coverage.length,5);assert.equal(envelope.omittedCoverageCount,100);assert.equal(envelope.omittedMutationCount,92);assert.equal(envelope.omittedFocusedTestCount,96);
  assert.equal(envelope.proposedMutationPaths.length,8);assert.equal(envelope.selectedFocusedTestPaths.length,4);assert.equal(envelope.coverage[0].clauses.length,32);
});

test("invalid capture context and hostile field access cannot replace or hide the original rejection",()=>{
  const alterations=[f=>f.task.id="bad/task",f=>f.task.stateVersion=0,f=>f.task.stateVersion=1.1,f=>f.attempt=2,f=>f.executionId="187:apply_patch",f=>f.task.metadata.activeContinuation.generationId="invalid",f=>f.requiredPaths.pop(),f=>f.requiredPaths[0]=f.requiredPaths[1],f=>f.requiredPaths[0]="../escape.js",f=>f.review.acceptanceConstraints.pop(),f=>f.review.acceptanceConstraints[0].id=f.review.acceptanceConstraints[1].id,f=>f.plan=null,f=>f.plan=new Proxy({},{get(){throw new Error("untrusted getter");}})];
  for(const alter of alterations){const f=fixture();alter(f);const error=new Error("original rejection");assert.equal(buildRejectedReviewEvidence(f),null);assert.equal(attachRejectedReviewEvidence(error,f),error);assert.equal(getRejectedReviewEvidence(error),null);}
  for(const value of [undefined,null,0,"error"]){assert.equal(attachRejectedReviewEvidence(value,fixture()),value);assert.equal(getRejectedReviewEvidence(value),null);assert.equal(takeRejectedReviewEvidence(value),null);}
});
