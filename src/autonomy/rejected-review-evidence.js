import {createHash} from "node:crypto";
import {canonicalContentHash} from "./self-development-plan-lifecycle.js";
import {recoveryHash} from "./failed-local-read-recovery.js";

export const REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT=96*1024;
export const REJECTED_REVIEW_EVIDENCE_LIMITS=Object.freeze({
  coverage:5,paths:8,focusedTests:4,clauses:32,
  testName:300,sourceExcerpt:12000,stimulus:1000,observable:500,assertion:2000,
});

const attachments=new WeakMap(),brands=new WeakMap();
const HASH=/^[a-f0-9]{64}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FIELD_NAMES=["testName","sourceExcerpt","stimulus","observable","assertion"];
const PREDICATES=new Set(["ninth_file_or_operation_forbidden","focused_scope_authorization","complete_behavioral_coverage","source_bound_behavioral_coverage","observable_behavioral_test_linkage","implementation_plan_invalid"]);
const SUBCLAUSES=new Set([
  "mutation_array","mutation_count","unique_mutation_paths","replacement_sources_in_scope",
  "focused_array","focused_count","unique_focused_paths","fresh_existing_focused_scope",
  "coverage_array","coverage_count","unique_constraint_ids","coverage_record_allowed_fields",
  "finding_ids_match","selected_focused_test","test_name_bounded","source_excerpt_bounded",
  "source_hash_format","source_hash_matches","source_contains_excerpt","excerpt_contains_test_name",
  "stimulus_bounded","observable_bounded","assertion_bounded","excerpt_contains_assertion","assertion_is_assertion",
  "named_test_declaration","observable_code_reference","excerpt_contains_stimulus","stimulus_precedes_assertion",
  "assertion_observes_reference","distinct_stimulus_assertion","not_token_only_source_check","not_unwired_constant_observation",
]);
const digest=value=>typeof value==="string"&&HASH.test(value)?value:null;
const predicate=value=>PREDICATES.has(value)?value:null;
const subclause=value=>SUBCLAUSES.has(value)?value:null;
const list=(value,limit)=>Array.isArray(value)?value.slice(0,limit):[];
const unique=items=>[...new Set(items)];
// PostgreSQL jsonb::text inserts separators; use a larger, indented projection
// so a near-cap private envelope also fits the durable database size check.
const bytes=value=>Buffer.byteLength(JSON.stringify(value,null,1),"utf8");
const integrity=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const brand=value=>{brands.set(value,integrity(value));return value;};
const clone=value=>brand(structuredClone(value));
const object=value=>value!==null&&(typeof value==="object"||typeof value==="function");
const path=value=>typeof value==="string"&&value.length<=240&&/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)&&!value.includes("..")?value:null;

// This filters literal artifact strings, never provider reasoning items. It is
// deliberately independent of key-name redaction in public worker diagnostics.
// No rendered form is produced here: consumers must render text, not HTML/JS.
function artifactText(value,limit){
  if(typeof value!=="string")return{text:null,omission:value==null?"missing":"invalid_type"};
  if(Buffer.byteLength(value,"utf8")>limit)return{text:null,omission:"field_limit"};
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b\u202a-\u202e\u2066-\u2069\ufeff]/u.test(value)||[...value].some(character=>{const point=character.codePointAt(0);return point>=0xd800&&point<=0xdfff;}))return{text:null,omission:"unprintable"};
  let redacted=false;
  const replace=(expression,replacement)=>{value=value.replace(expression,(...args)=>{redacted=true;return typeof replacement==="function"?replacement(...args):replacement;});};
  replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,"[REDACTED_PRIVATE_KEY]");
  replace(/\bBearer[ \t]+[A-Za-z0-9._~+/=-]+/gi,"Bearer [REDACTED]");
  replace(/\b(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gi,"[REDACTED_TOKEN]");
  replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,"[REDACTED_TOKEN]");
  replace(/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s"'`<>:/@]+:[^\s"'`<>@]+@/gi,(_match,scheme)=>`${scheme}[REDACTED]@`);
  replace(/\b(?:set-cookie|cookie)[ \t]*:[ \t]*[^\r\n]+/gi,"Cookie: [REDACTED]");
  // Quoted JS/JSON literals, environment assignments, and query parameters.
  // Match only sensitive names: consuming an unrelated outer assignment could
  // otherwise skip a nested JSON credential or an embedded example string.
  const assignments=/(["']?)([\w$.-]*(?:token|secret|password|passwd|key|credential|authorization|cookie|session)[\w$.-]*)\1(\s*(?::|=(?!=|>))\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s,;)&}]+)/gi;
  value=value.replace(assignments,(_match,quote,name,separator)=>{
    redacted=true;return`${quote}${name}${quote}${separator}"[REDACTED]"`;
  });
  // Replacement markers may be longer than a short input credential.
  if(Buffer.byteLength(value,"utf8")>limit)return{text:null,omission:"redaction_limit",redacted};
  return{text:value,redacted};
}

function validContext(task,executionId,attempt,requiredPaths){
  return task&&ID.test(task.id||"")&&Number.isSafeInteger(task.stateVersion)&&task.stateVersion>0&&
    typeof executionId==="string"&&/^\d{1,9}:plan_repair$/.test(executionId)&&attempt===1&&
    digest(task.metadata?.activeContinuation?.generationId)&&Array.isArray(requiredPaths)&&requiredPaths.length===8&&
    requiredPaths.every(item=>path(item)===item)&&new Set(requiredPaths).size===8;
}

/** Returns private diagnostic data, never a plan, approval, or executable tool. */
export function buildRejectedReviewEvidence({task,executionId,attempt=1,plan,review,requiredPaths,diagnostics={},reads,planFingerprint}={}){
  try{
    if(!validContext(task,executionId,attempt,requiredPaths)||!plan||typeof plan!=="object"||!Array.isArray(review?.acceptanceConstraints)||review.acceptanceConstraints.length!==5)return null;
    const trustedPaths=new Set(requiredPaths),trustedFindings=new Map(list(review.findings,5).filter(finding=>ID.test(finding?.id||"")).map(finding=>[finding.id,finding]));
    const constraints=review.acceptanceConstraints;
    if(constraints.some(constraint=>!ID.test(constraint?.id||"")||constraint.id.length>80)||new Set(constraints.map(constraint=>constraint.id)).size!==5)return null;
    const paths=value=>unique(list(value,8).filter(item=>trustedPaths.has(item)));
    const proposed=list(plan.files,8),focused=list(plan.focusedTests,4),mappings=list(plan.reviewCoverage,5);
    const coverageDiagnostics=diagnostics?.coverageDiagnostics||{},diagnosticRecords=list(coverageDiagnostics.constraints,5);
    const envelope={
      version:1,diagnosticOnly:true,executionAuthorized:false,mutationApplied:false,
      taskId:task.id,stateVersion:task.stateVersion,executionId,attempt,
      continuationGenerationId:task.metadata.activeContinuation.generationId,
      planGenerationId:digest(coverageDiagnostics.planGenerationId),
      planFingerprint:digest(planFingerprint)||digest(diagnostics?.rejectedPlanEvidence?.planFingerprint)||digest(coverageDiagnostics.planFingerprint)||recoveryHash(plan),
      outputShapeHash:digest(diagnostics?.outputShapeHash),
      rejectionPredicate:predicate(diagnostics?.predicate)||predicate(coverageDiagnostics.firstFailure?.predicate)||(diagnostics?.validationCode==="implementation_plan_invalid"?"implementation_plan_invalid":null),
      proposedMutationPaths:paths(proposed.map(file=>file?.path)),
      selectedFocusedTestPaths:paths(focused.map(item=>item?.path)),
      omittedMutationCount:Math.max(0,(Array.isArray(plan.files)?plan.files.length:0)-8),
      omittedFocusedTestCount:Math.max(0,(Array.isArray(plan.focusedTests)?plan.focusedTests.length:0)-4),
      omittedCoverageCount:Math.max(0,(Array.isArray(plan.reviewCoverage)?plan.reviewCoverage.length:0)-5),
      coverage:[],
    };
    for(const constraint of constraints){
      const mapping=mappings.find(item=>item?.constraintId===constraint.id)||{},diagnostic=diagnosticRecords.find(item=>item?.constraintId===constraint.id)||{};
      const findingIds=unique(list(constraint.findingIds,5).filter(id=>trustedFindings.has(id)));
      const testPath=trustedPaths.has(mapping.testPath)&&/^test\/.+\.test\.js$/.test(mapping.testPath)?mapping.testPath:null;
      const generated=proposed.find(file=>file?.path===testPath),current=reads instanceof Map?reads.get(testPath):undefined;
      const source=typeof generated?.content==="string"?generated.content:current;
      const expectedSourceHash=typeof source==="string"&&Buffer.byteLength(source,"utf8")<=250000?canonicalContentHash(source):digest(diagnostic.expectedSourceHash);
      const entry={
        constraintId:constraint.id,findingIds,
        sourcePaths:paths(findingIds.flatMap(id=>list(trustedFindings.get(id)?.paths,8))),
        testPath,sourceOrigin:typeof generated?.content==="string"?"proposed_replacement":typeof current==="string"?"fresh_read":"validator_evidence",
        testName:null,sourceExcerpt:null,stimulus:null,observable:null,assertion:null,
        expectedSourceHash,suppliedSourceHash:digest(mapping.sourceHash)||digest(diagnostic.suppliedSourceHash),
        suppliedSourceHashOrigin:mapping.sourceHash!==undefined?"model_supplied":digest(diagnostic.suppliedSourceHash)?"runtime_derived":"absent",
        evaluated:diagnostic.evaluated===true,
        clauses:list(diagnostic.clauses,32).filter(clause=>predicate(clause?.predicate)&&subclause(clause?.subclause)&&typeof clause.passed==="boolean").map(clause=>({predicate:clause.predicate,subclause:clause.subclause,passed:clause.passed})),
        firstFailedSubclause:subclause(diagnostic.firstFailedSubclause),
        redactedFields:[],omittedFields:[],
      };
      if(mapping.testPath!==undefined&&testPath===null)entry.omittedFields.push({field:"testPath",reason:"out_of_scope"});
      for(const field of FIELD_NAMES){
        const result=artifactText(mapping[field],REJECTED_REVIEW_EVIDENCE_LIMITS[field]);entry[field]=result.text;
        if(result.redacted)entry.redactedFields.push(field);
        if(result.omission)entry.omittedFields.push({field,reason:result.omission});
      }
      envelope.coverage.push(entry);
    }
    // Keep the first failing constraint's evidence longest. An omitted field
    // is explicitly unavailable, not a truncated string masquerading as exact.
    if(bytes(envelope)>REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT){
      const firstFailure=coverageDiagnostics.firstFailure?.constraintId;
      const trimOrder=[...envelope.coverage].reverse().filter(entry=>entry.constraintId!==firstFailure);
      trimOrder.push(...envelope.coverage.filter(entry=>entry.constraintId===firstFailure));
      for(const entry of trimOrder){
        for(const field of ["sourceExcerpt","assertion","stimulus","testName","observable"]){
          if(bytes(envelope)<=REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT)break;
          if(entry[field]!==null){entry[field]=null;entry.omittedFields.push({field,reason:"envelope_limit"});}
        }
      }
    }
    return bytes(envelope)<=REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT?brand(envelope):null;
  }catch{
    // Evidence capture must never replace or obscure the original rejection.
    return null;
  }
}

/** Storage validates this before cloning. Parsed/caller-made JSON is unbranded. */
export function isRejectedReviewEvidenceEnvelope(value){
  try{return object(value)&&brands.has(value)&&bytes(value)<=REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT&&brands.get(value)===integrity(value);}catch{return false;}
}
export const validateRejectedReviewEvidenceEnvelope=isRejectedReviewEvidenceEnvelope;

export function attachRejectedReviewEvidence(error,options){
  if(!object(error))return error;
  // One failure has one capture. Later catch/rethrow layers cannot silently
  // rebind the private snapshot to different task, attempt, or model fields.
  if(attachments.has(error))return error;
  const evidence=buildRejectedReviewEvidence(options);
  if(evidence)attachments.set(error,evidence);
  return error;
}
export function getRejectedReviewEvidence(error){
  const evidence=object(error)?attachments.get(error):null;
  return evidence?clone(evidence):null;
}
export function takeRejectedReviewEvidence(error){
  const evidence=getRejectedReviewEvidence(error);
  if(object(error))attachments.delete(error);
  return evidence;
}
