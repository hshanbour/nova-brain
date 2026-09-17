import {recoveryHash} from "./failed-local-read-recovery.js";
import {canonicalContentHash} from "./self-development-plan-lifecycle.js";

const HASH=/^[a-f0-9]{64}$/;
const same=(left,right)=>recoveryHash(left)===recoveryHash(right);
const text=(value,max=1000)=>typeof value==="string"&&value.trim().length>0&&value.length<=max;
const keys=(value,allowed)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const coverageKeys=["constraintId","findingIds","testPath","testName","sourceExcerpt","sourceHash","stimulus","observable","assertion"];
const digest=value=>HASH.test(value||"")?value:null;
const namedTestPattern=name=>new RegExp("\\b(?:test|it)\\s*\\(\\s*(['\"`])"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\1");
const placeholderTestName=name=>/\b(?:todo|placeholder|hypothetical|future\s+test|test\s+name)\b/i.test(name);

// Only authority-owned identifiers and paths may be emitted verbatim. Unknown
// model references, excerpts, assertions, reasons and test names never are.
function boundedDiagnostics(plan,{review,requiredPaths,reads,context}){
  const trustedPaths=new Set(requiredPaths.slice(0,8));
  const pathList=items=>[...new Set((Array.isArray(items)?items:[]).filter(path=>trustedPaths.has(path)))].slice(0,8);
  const proposedMutationPaths=pathList((Array.isArray(plan?.files)?plan.files:[]).map(file=>file?.path));
  const proposedFocusedTestPaths=pathList((Array.isArray(plan?.focusedTests)?plan.focusedTests:[]).map(item=>item?.path));
  const findings=(review.findings||[]).slice(0,5),trustedFindingIds=new Set(findings.map(item=>item.id));
  const contents=new Map(reads);for(const file of (Array.isArray(plan?.files)?plan.files:[]).slice(0,8))if(trustedPaths.has(file?.path)&&typeof file.content==="string")contents.set(file.path,file.content);
  const coverage=Array.isArray(plan?.reviewCoverage)?plan.reviewCoverage:[];
  const constraints=review.acceptanceConstraints.slice(0,5).map(constraint=>{
    const item=coverage.find(mapping=>mapping?.constraintId===constraint.id),testPath=trustedPaths.has(item?.testPath)?item.testPath:null,source=testPath===null?null:contents.get(testPath);
    return{
      constraintId:constraint.id,
      findingIds:constraint.findingIds.filter(id=>trustedFindingIds.has(id)).slice(0,5),
      suppliedFindingIds:(Array.isArray(item?.findingIds)?item.findingIds:[]).filter(id=>trustedFindingIds.has(id)).slice(0,5),
      untrustedFindingIdFingerprints:(Array.isArray(item?.findingIds)?item.findingIds:[]).filter(id=>!trustedFindingIds.has(id)).slice(0,5).map(recoveryHash),
      sourcePaths:pathList(findings.filter(finding=>constraint.findingIds.includes(finding.id)).flatMap(finding=>finding.paths||[])),
      proposedMutationPaths,proposedFocusedTestPaths,
      testPath,untrustedTestPathFingerprint:typeof item?.testPath==="string"&&testPath===null?recoveryHash(item.testPath):null,
      expectedSourceHash:typeof source==="string"?canonicalContentHash(source):null,
      suppliedSourceHash:digest(item?.sourceHash),suppliedSourceHashPresent:item?.sourceHash!==undefined,
      evaluated:false,clauses:[],firstFailedSubclause:null,
    };
  });
  return{
    version:1,planFingerprint:digest(context.planFingerprint)||recoveryHash(plan),
    continuationGenerationId:digest(context.continuationGenerationId)||digest(plan?.provenance?.continuationGenerationId),
    planGenerationId:digest(context.planGenerationId)||digest(plan?.provenance?.generationId),
    stateVersion:Number.isInteger(context.stateVersion)?context.stateVersion:null,
    proposedMutationPaths,proposedFocusedTestPaths,
    untrustedMutationPathCount:(Array.isArray(plan?.files)?plan.files:[]).filter(file=>!trustedPaths.has(file?.path)).length,
    untrustedFocusedTestPathCount:(Array.isArray(plan?.focusedTests)?plan.focusedTests:[]).filter(item=>!trustedPaths.has(item?.path)).length,
    unknownConstraintCount:coverage.filter(item=>!review.acceptanceConstraints.some(constraint=>constraint.id===item?.constraintId)).length,
    constraints,stages:[],firstFailure:null,
  };
}

/** Same fail-closed coverage contract; diagnostics expose facts, not model text. */
export function validateReviewCoverageBindings(plan,{review,requiredPaths,reads,context={}}){
  const diagnostics=boundedDiagnostics(plan,{review,requiredPaths,reads,context});
  const check=(predicate,clauses,record=null,authorization=false)=>{
    if(record)record.evaluated=true;
    for(const[name,evaluate]of clauses){
      const passed=Boolean(evaluate());
      (record?record.clauses:diagnostics.stages).push({predicate,subclause:name,passed});
      if(!passed){
        if(record)record.firstFailedSubclause=name;
        diagnostics.firstFailure={predicate,constraintId:record?.constraintId??null,subclause:name};
        throw Object.assign(new Error(`Review remediation rejected: ${predicate}.`),{
          code:authorization?"review_remediation_scope_authorization_required":"review_remediation_precondition_failed",statusCode:409,
          safeDiagnostics:{predicate,mutationApplied:false,...(authorization?{authorizationRequired:true}:{}),coverageDiagnostics:diagnostics},
        });
      }
    }
  };
  check("ninth_file_or_operation_forbidden",[
    ["mutation_array",()=>Array.isArray(plan?.files)],
    ["mutation_count",()=>plan.files.length>0&&plan.files.length<=8],
    ["unique_mutation_paths",()=>new Set(plan.files.map(file=>file?.path)).size===plan.files.length],
    ["replacement_sources_in_scope",()=>plan.files.every(file=>file&&requiredPaths.includes(file.path)&&file.operation==="replace"&&typeof file.content==="string")],
  ],null,true);
  const focusedTests=plan.focusedTests?.map(item=>item?.path);
  check("focused_scope_authorization",[
    ["focused_array",()=>Array.isArray(focusedTests)],
    ["focused_count",()=>focusedTests.length>0&&focusedTests.length<=4],
    ["unique_focused_paths",()=>new Set(focusedTests).size===focusedTests.length],
    ["fresh_existing_focused_scope",()=>plan.focusedTests.every(item=>item.kind==="existing"&&requiredPaths.includes(item.path)&&/^test\/.+\.test\.js$/.test(item.path)&&reads.has(item.path))],
  ],null,true);
  const coverage=plan.reviewCoverage,contents=new Map(reads);for(const file of plan.files)contents.set(file.path,file.content);
  check("complete_behavioral_coverage",[
    ["coverage_array",()=>Array.isArray(coverage)],
    ["coverage_count",()=>coverage.length===review.acceptanceConstraints.length],
    ["unique_constraint_ids",()=>new Set(coverage.map(item=>item?.constraintId)).size===coverage.length],
  ]);
  for(const[index,constraint]of review.acceptanceConstraints.entries()){
    const item=coverage.find(mapping=>mapping?.constraintId===constraint.id),source=item&&contents.get(item.testPath),record=diagnostics.constraints[index];
    const exactName=text(item?.testName,300)?namedTestPattern(item.testName):null,currentSource=item&&reads.get(item.testPath),replacement=plan.files.find(file=>file?.path===item?.testPath),currentHasName=typeof currentSource==="string"&&exactName?.test(currentSource),replacementHasName=typeof replacement?.content==="string"&&exactName?.test(replacement.content);
    if(context.semanticEvidenceReplan===true)check("semantic_test_identity_binding",[
      ["test_name_not_placeholder",()=>text(item?.testName,300)&&!placeholderTestName(item.testName)],
      ["test_identity_exists_in_exact_source",()=>typeof source==="string"&&exactName?.test(source)],
      ["unchanged_source_identity_is_current",()=>Boolean(replacement)||currentHasName],
      ["new_identity_requires_test_replacement",()=>currentHasName||Boolean(replacement&&replacementHasName)],
    ],record);
    check("source_bound_behavioral_coverage",[
      ["coverage_record_allowed_fields",()=>keys(item,coverageKeys)],
      ["finding_ids_match",()=>same(item.findingIds,constraint.findingIds)],
      ["selected_focused_test",()=>focusedTests.includes(item.testPath)],
      ["test_name_bounded",()=>text(item.testName,300)],
      ["source_excerpt_bounded",()=>text(item.sourceExcerpt,12000)],
      ["source_hash_format",()=>HASH.test(item.sourceHash||"")],
      ["source_hash_matches",()=>item.sourceHash===canonicalContentHash(source)],
      ["source_contains_excerpt",()=>source.includes(item.sourceExcerpt)],
      ["excerpt_contains_test_name",()=>item.sourceExcerpt.includes(item.testName)],
      ["stimulus_bounded",()=>text(item.stimulus,1500)],
      ["observable_bounded",()=>text(item.observable,500)],
      ["assertion_bounded",()=>text(item.assertion,2000)],
      ["excerpt_contains_assertion",()=>item.sourceExcerpt.includes(item.assertion)],
      ["assertion_is_assertion",()=>/\b(?:assert\s*[.(]|expect\s*\()/.test(item.assertion)],
    ],record);
    const namedTest=namedTestPattern(item.testName),observable=/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]\r\n]+\])*$/;
    check("observable_behavioral_test_linkage",[
      ["named_test_declaration",()=>namedTest.test(item.sourceExcerpt)],
      ["observable_code_reference",()=>observable.test(item.observable)],
      ["excerpt_contains_stimulus",()=>item.sourceExcerpt.includes(item.stimulus)],
      ["stimulus_precedes_assertion",()=>item.sourceExcerpt.indexOf(item.stimulus)<item.sourceExcerpt.indexOf(item.assertion)],
      ["assertion_observes_reference",()=>item.assertion.includes(item.observable)],
      ["distinct_stimulus_assertion",()=>item.stimulus!==item.assertion],
      ["not_token_only_source_check",()=>!/\bassert\.(?:match|doesNotMatch)\s*\(\s*(?:source|sourceText|code|content)\b/.test(item.assertion)],
      ["not_unwired_constant_observation",()=>!new RegExp("\\b(?:const|let|var)\\s+"+item.observable.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\s*=\\s*(?:0|false|null)\\s*;?$").test(item.stimulus.trim())],
    ],record);
  }
  return{coverageHash:recoveryHash(coverage),focusedTests};
}
