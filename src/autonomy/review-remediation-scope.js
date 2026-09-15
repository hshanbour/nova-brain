import {createHash} from "node:crypto";
import {createActiveContinuation,canonicalContentHash,bindImplementationPlan,planLifecycleMetadata} from "./self-development-plan-lifecycle.js";
import {recoveryHash,recoveryRoot} from "./failed-local-read-recovery.js";
import {FAILED_FULL_TEST_RETRY_CLASS,FAILED_FULL_TEST_RETRY_TOOL,validateFullTestScopeEvidence} from "./full-test-scope-recovery.js";
import {validateReviewCoverageBindings} from "./review-coverage-diagnostics.js";

export const REVIEW_REMEDIATION_CLASS="owner_approved_review_remediation";
export const REVIEW_REMEDIATION_TOOL="self_development_review_remediation";
export const REJECTED_REVIEW_PLAN_CONTINUATION_CLASS="owner_approved_rejected_review_plan_continuation";
export const REJECTED_REVIEW_PLAN_CONTINUATION_TOOL="self_development_rejected_review_plan_continuation";
export const SOURCE_BOUND_REVIEW_REPLAN_CLASS="owner_approved_source_bound_review_replan";
export const SOURCE_BOUND_REVIEW_REPLAN_TOOL="self_development_source_bound_review_replan";
export const EVIDENCE_BOUND_REVIEW_REPLAN_CLASS="owner_approved_evidence_bound_review_replan";
export const EVIDENCE_BOUND_REVIEW_REPLAN_TOOL="self_development_evidence_bound_review_replan";
export const IMPLEMENTATION_CONTENT_REVIEW_REPLAN_CLASS="owner_approved_implementation_content_review_replan";
export const IMPLEMENTATION_CONTENT_REVIEW_REPLAN_TOOL="self_development_implementation_content_review_replan";
export const SOURCE_LITERAL_REVIEW_REPLAN_CLASS="owner_approved_source_literal_review_replan";
export const SOURCE_LITERAL_REVIEW_REPLAN_TOOL="self_development_source_literal_review_replan";
export const OBSERVABLE_LINKAGE_REVIEW_REPLAN_CLASS="owner_approved_observable_linkage_review_replan";
export const OBSERVABLE_LINKAGE_REVIEW_REPLAN_TOOL="self_development_observable_linkage_review_replan";
export const SEMANTIC_EVIDENCE_REVIEW_REPLAN_CLASS="owner_approved_semantic_evidence_review_replan";
export const SEMANTIC_EVIDENCE_REVIEW_REPLAN_TOOL="self_development_semantic_evidence_review_replan";
export const REVIEW_REMEDIATION_RUNTIME_MINUTES=15;
export const REVIEW_REMEDIATION_MAX_STEPS=13;
const DESCRIPTOR=Object.freeze({historyKey:"reviewRemediationHistory",boundaryKey:"reviewRemediationBoundary",recoveryClass:REVIEW_REMEDIATION_CLASS,tool:REVIEW_REMEDIATION_TOOL});
const REJECTED_DESCRIPTOR=Object.freeze({historyKey:"rejectedReviewPlanContinuationHistory",boundaryKey:"rejectedReviewPlanContinuationBoundary",recoveryClass:REJECTED_REVIEW_PLAN_CONTINUATION_CLASS,tool:REJECTED_REVIEW_PLAN_CONTINUATION_TOOL,dependencyPreflight:true});
const SOURCE_BOUND_DESCRIPTOR=Object.freeze({historyKey:"sourceBoundReviewReplanHistory",boundaryKey:"sourceBoundReviewReplanBoundary",recoveryClass:SOURCE_BOUND_REVIEW_REPLAN_CLASS,tool:SOURCE_BOUND_REVIEW_REPLAN_TOOL,dependencyPreflight:true});
const EVIDENCE_BOUND_DESCRIPTOR=Object.freeze({historyKey:"evidenceBoundReviewReplanHistory",boundaryKey:"evidenceBoundReviewReplanBoundary",recoveryClass:EVIDENCE_BOUND_REVIEW_REPLAN_CLASS,tool:EVIDENCE_BOUND_REVIEW_REPLAN_TOOL,dependencyPreflight:true});
const IMPLEMENTATION_CONTENT_DESCRIPTOR=Object.freeze({historyKey:"implementationContentReviewReplanHistory",boundaryKey:"implementationContentReviewReplanBoundary",recoveryClass:IMPLEMENTATION_CONTENT_REVIEW_REPLAN_CLASS,tool:IMPLEMENTATION_CONTENT_REVIEW_REPLAN_TOOL,dependencyPreflight:true,implementationContentReplan:true});
const SOURCE_LITERAL_DESCRIPTOR=Object.freeze({historyKey:"sourceLiteralReviewReplanHistory",boundaryKey:"sourceLiteralReviewReplanBoundary",recoveryClass:SOURCE_LITERAL_REVIEW_REPLAN_CLASS,tool:SOURCE_LITERAL_REVIEW_REPLAN_TOOL,dependencyPreflight:true,implementationContentReplan:true,sourceLiteralReplan:true});
const OBSERVABLE_LINKAGE_DESCRIPTOR=Object.freeze({historyKey:"observableLinkageReviewReplanHistory",boundaryKey:"observableLinkageReviewReplanBoundary",recoveryClass:OBSERVABLE_LINKAGE_REVIEW_REPLAN_CLASS,tool:OBSERVABLE_LINKAGE_REVIEW_REPLAN_TOOL,dependencyPreflight:true,implementationContentReplan:true,sourceLiteralReplan:true,observableLinkageReplan:true});
const SEMANTIC_EVIDENCE_DESCRIPTOR=Object.freeze({historyKey:"semanticEvidenceReviewReplanHistory",boundaryKey:"semanticEvidenceReviewReplanBoundary",recoveryClass:SEMANTIC_EVIDENCE_REVIEW_REPLAN_CLASS,tool:SEMANTIC_EVIDENCE_REVIEW_REPLAN_TOOL,dependencyPreflight:true,implementationContentReplan:true,sourceLiteralReplan:true,observableLinkageReplan:true,semanticEvidenceReplan:true});
const REMEDIATION_DESCRIPTORS=Object.freeze([SEMANTIC_EVIDENCE_DESCRIPTOR,OBSERVABLE_LINKAGE_DESCRIPTOR,SOURCE_LITERAL_DESCRIPTOR,IMPLEMENTATION_CONTENT_DESCRIPTOR,EVIDENCE_BOUND_DESCRIPTOR,SOURCE_BOUND_DESCRIPTOR,REJECTED_DESCRIPTOR,DESCRIPTOR]);
const predecessorDescriptor=descriptor=>descriptor===SEMANTIC_EVIDENCE_DESCRIPTOR?OBSERVABLE_LINKAGE_DESCRIPTOR:descriptor===OBSERVABLE_LINKAGE_DESCRIPTOR?SOURCE_LITERAL_DESCRIPTOR:descriptor===SOURCE_LITERAL_DESCRIPTOR?IMPLEMENTATION_CONTENT_DESCRIPTOR:descriptor===IMPLEMENTATION_CONTENT_DESCRIPTOR?EVIDENCE_BOUND_DESCRIPTOR:descriptor===EVIDENCE_BOUND_DESCRIPTOR?SOURCE_BOUND_DESCRIPTOR:descriptor===SOURCE_BOUND_DESCRIPTOR?REJECTED_DESCRIPTOR:DESCRIPTOR;
export const reviewRemediationDescriptorForClass=recoveryClass=>REMEDIATION_DESCRIPTORS.find(descriptor=>descriptor.recoveryClass===recoveryClass)||null;
export const reviewRemediationDescriptor=task=>REMEDIATION_DESCRIPTORS.find(descriptor=>task?.metadata?.[descriptor.historyKey]!==undefined||task?.metadata?.activeContinuation?.recoveryClass===descriptor.recoveryClass)||null;
const SHA=/^[a-f0-9]{40}$/,HASH=/^[a-f0-9]{64}$/,ID=/^[a-z0-9][a-z0-9_-]{0,79}$/i,WORKER=/^persistent-local-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const same=(a,b)=>recoveryHash(a)===recoveryHash(b),ordinal=step=>Number.parseInt(step?.stepId,10);
const blobHash=content=>createHash("sha1").update(`blob ${Buffer.byteLength(content,"utf8")}\0`).update(content).digest("hex");
const entry=(path,content)=>({path,hashAlgorithm:"git_sha1",hash:blobHash(content),rawHash:blobHash(content),contentHash:canonicalContentHash(content)});
const ordered=entries=>[...entries].sort((a,b)=>a.path.localeCompare(b.path));
const proofEntries=entries=>ordered(entries).map(({path,hashAlgorithm,hash,contentHash})=>({path,hashAlgorithm,hash,contentHash}));
const text=(value,max=1000)=>typeof value==="string"&&value.trim().length>0&&value.length<=max;
const keys=(value,allowed)=>value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).every(key=>allowed.includes(key));
const namedTestPattern=name=>new RegExp("\\b(?:test|it)\\s*\\(\\s*(['\"`])"+name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"\\1");
function requireProof(value,predicate,authorization=false){if(!value)throw Object.assign(new Error(`Review remediation rejected: ${predicate}.`),{code:authorization?"review_remediation_scope_authorization_required":"review_remediation_precondition_failed",statusCode:409,safeDiagnostics:{predicate,mutationApplied:false,...(authorization?{authorizationRequired:true}:{})}});}
function immutableHistories(task,descriptor=reviewRemediationDescriptor(task)||DESCRIPTOR){const fixed=["selfDevelopment","maxRepairIterations"],historical=Object.keys(task.metadata||{}).filter(key=>/(?:History|Boundary)$/.test(key)&&!["continuationHistory",descriptor.historyKey,descriptor.boundaryKey].includes(key));return Object.fromEntries([...new Set([...fixed,...historical])].sort().map(key=>[key,recoveryHash(task.metadata[key])]));}
function validateEntries(entries,paths){return Array.isArray(paths)&&paths.length===8&&new Set(paths).size===8&&paths.every(path=>text(path,240)&&!path.startsWith("/")&&!path.includes("\\")&&!path.split("/").includes(".."))&&Array.isArray(entries)&&entries.length===8&&new Set(entries.map(item=>item?.path)).size===8&&entries.every(item=>item&&paths.includes(item.path)&&item.hashAlgorithm==="git_sha1"&&SHA.test(item.hash||"")&&item.rawHash===item.hash&&HASH.test(item.contentHash||""));}

export function validateStructuredReview(review,entries){
  requireProof(keys(review,["findings","acceptanceConstraints"])&&Array.isArray(review.findings)&&review.findings.length>=4&&review.findings.length<=5&&review.findings.filter(item=>item?.severity==="blocking").length===4&&review.findings.filter(item=>item?.severity==="note").length<=1&&new Set(review.findings.map(item=>item?.id)).size===review.findings.length,"structured_review_findings");
  const byPath=new Map(entries.map(item=>[item.path,item]));
  for(const finding of review.findings){
    requireProof(keys(finding,["id","severity","paths","defect","sourceEvidence","acceptanceImplication"])&&ID.test(finding.id||"")&&["blocking","note"].includes(finding.severity)&&text(finding.defect)&&text(finding.acceptanceImplication)&&Array.isArray(finding.paths)&&finding.paths.length>0&&finding.paths.length<=8&&new Set(finding.paths).size===finding.paths.length&&finding.paths.every(path=>byPath.has(path))&&Array.isArray(finding.sourceEvidence)&&finding.sourceEvidence.length===finding.paths.length&&new Set(finding.sourceEvidence.map(item=>item?.path)).size===finding.paths.length,"bounded_review_finding");
    requireProof(finding.sourceEvidence.every(source=>keys(source,["path","contentHash","lineStart","lineEnd"])&&finding.paths.includes(source.path)&&source.contentHash===byPath.get(source.path)?.contentHash&&Number.isInteger(source.lineStart)&&source.lineStart>0&&Number.isInteger(source.lineEnd)&&source.lineEnd>=source.lineStart&&source.lineEnd-source.lineStart<=1000),"current_review_source_evidence");
  }
  const constraints=review.acceptanceConstraints,blocking=review.findings.filter(item=>item.severity==="blocking").map(item=>item.id);
  requireProof(Array.isArray(constraints)&&constraints.length===5&&new Set(constraints.map(item=>item?.id)).size===constraints.length&&constraints.every(item=>keys(item,["id","text","findingIds"])&&ID.test(item.id||"")&&text(item.text)&&Array.isArray(item.findingIds)&&item.findingIds.length>0&&new Set(item.findingIds).size===item.findingIds.length&&item.findingIds.every(id=>blocking.includes(id)))&&blocking.every(id=>constraints.some(item=>item.findingIds.includes(id))),"review_acceptance_constraints");
  return review;
}

function remediationSteps(record){
  const binding={version:1,taskId:record.taskId,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,runtimeVersion:record.runtimeVersion,sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:record.sourceApplyStepId,sourceApplyFingerprint:record.sourceApplyFingerprint,continuationGenerationId:record.activeContinuation.generationId};
  return[...record.requiredPaths.map(path=>({type:"read_files",capability:"repo_read_remote",input:{tool:"repo_read_task_owned_local",arguments:{path,expectedContentHash:record.beforeEntries.find(item=>item.path===path).contentHash,binding}},idempotencyIdentity:`review-remediation:${record.taskId}:${record.fromStateVersion}:read:${path}`})),
    {type:"plan_repair",capability:"reasoning",input:{tool:"self_development_plan_implementation",arguments:{taskId:record.taskId,currentCommit:"$CURRENT_COMMIT",candidatePaths:record.requiredPaths,failureEvidence:{code:record.semanticEvidenceReplan?"review_coverage_semantic_identity_invalid":record.observableLinkageReplan?"review_coverage_observable_linkage_invalid":record.sourceLiteralReplan?"review_coverage_source_literal_invalid":record.implementationContentReplan?"implementation_content_invalid":"review_remediation_required",reviewHash:record.reviewHash,review:record.review,mutationApplied:false,...(record.implementationContentReplan?{requiredImplementationContentContract:{operation:"replace",contentType:"string",completeReplacement:true,minLength:1,maxLength:250000,instructionsOrPlaceholdersForbidden:true}}:{}),...(record.sourceLiteralReplan?{requiredReviewCoverageContract:{sourceExcerpt:"exact non-placeholder literal substring of the proposed replacement source for testPath",testName:"same named test declaration contained in sourceExcerpt",stimulus:"literal stimulus code contained in sourceExcerpt and preceding assertion",assertion:"literal behavioral assertion contained in sourceExcerpt",...(record.observableLinkageReplan?{observableCodeReference:"real code reference present in the exact proposed replacement source and exercised by the same source-bound behavioral test",coherentBehavioralTest:"testName, sourceExcerpt, observableCodeReference, stimulus, and assertion must describe the same test behavior"}:{}),staleOrPlaceholderEvidenceForbidden:true}}:{}),...(record.semanticEvidenceReplan?{requiredSemanticTestIdentityContract:{existingTest:"testName must exist in the exact hash-bound current source when testPath is unchanged",newTest:"when testName does not exist in the current source, testPath must be an authorized replacement containing the exact named behavioral test",hypotheticalOrPlaceholderTestsForbidden:true,coverageMustExistInCurrentOrProposedSource:true}}:{})}}}},
    {type:"validate_patch",capability:"repo_read_remote",input:{tool:"repo_validate_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}}},
    {type:"apply_patch",capability:"repo_mutate_local",input:{tool:"repo_apply_patch",arguments:{branch:"$TASK_BRANCH",currentCommit:"$CURRENT_COMMIT",files:"$IMPLEMENTATION_FILES",planProvenance:"$IMPLEMENTATION_PLAN_PROVENANCE"}}},
    {type:"run_focused_tests",capability:"test_local",input:{tool:"test_run",arguments:{files:"$IMPLEMENTATION_TESTS"}}},
    {type:"run_full_tests",capability:"test_local",input:{tool:"test_run_full",arguments:{}}}];
}

function completeTerminalSummary(result){
  requireProof(result?.ok===true&&result.exitCode===0&&typeof result.output==="string"&&typeof result.outputTruncated==="boolean","complete_successful_remediation_tests");
  const output=result.output.replace(/\x1b\[[0-9;]*m/g,"").trim();
  // Hands retains the last 20,000 characters, not the first. Losing an earlier
  // transcript is safe only if the complete terminal Node summary survives.
  // Never infer success from an earlier summary or from a fragment of counters.
  const summary=output.match(/(?:^|\n)([#ℹ]) tests (\d+)\r?\n\1 suites \d+\r?\n\1 pass (\d+)\r?\n\1 fail (\d+)\r?\n\1 cancelled (\d+)\r?\n\1 skipped (\d+)\r?\n\1 todo (\d+)\r?\n\1 duration_ms \d+(?:\.\d+)?$/);
  requireProof(summary,"complete_terminal_test_summary");
  const[tests,passed,failed,cancelled,skipped,todo]=summary.slice(2).map(Number);
  requireProof([tests,passed,failed,cancelled,skipped,todo].every(Number.isSafeInteger)&&tests>0&&passed===tests&&failed===0&&cancelled===0&&skipped===0&&todo===0,"complete_successful_remediation_tests");
  return{tests,passed,failed,skipped};
}

function passingReviewBoundary(task,steps){
  const history=task.metadata?.failedFullTestRetryHistory,predecessor=history?.[0],active=task.metadata?.activeContinuation,boundary=task.metadata?.failedFullTestRetryBoundary;
  requireProof(history?.length===1&&predecessor?.recoveryClass===FAILED_FULL_TEST_RETRY_CLASS&&active?.recoveryClass===FAILED_FULL_TEST_RETRY_CLASS&&predecessor.consumed===true&&predecessor.authorizationConsumed===true&&predecessor.result==="full_tests_completed"&&predecessor.workerBindingState==="bound"&&WORKER.test(predecessor.workerId||"")&&same(predecessor.activeContinuation,active)&&task.currentStep===active.startStep+1&&Date.parse(predecessor.completedAt)>=Date.parse(active.runtimeStartedAt)&&Date.parse(predecessor.completedAt)<=Date.parse(active.runtimeDeadline),"consumed_passing_full_test_predecessor");
  const full=steps.find(step=>step.stepId===predecessor.fullTestStepId);
  requireProof(full?.taskId===task.id&&full.status==="completed"&&full.stepType==="run_full_tests"&&full.attempt===1&&full.result?.ok===true&&full.result.exitCode===0&&predecessor.resultHash===recoveryHash(full.result)&&same(predecessor.claimedStepIds,[full.stepId])&&!steps.some(step=>ordinal(step)>ordinal(full))&&steps.length===predecessor.predecessorStepProofs.length+1,"completed_full_test_execution");
  const projected=structuredClone(task);projected.status="running";projected.currentStep=active.startStep;projected.metadata.failedFullTestRetryHistory[0].consumed=false;
  try{validateFullTestScopeEvidence(projected,steps,()=>new Date(active.runtimeStartedAt));}catch(error){requireProof(false,`source_full_test_evidence:${error.safeDiagnostics?.predicate||error.code}`);}
  const fullCounts=completeTerminalSummary(full.result);
  requireProof(same(boundary,predecessor.boundary)&&same(boundary,{kind:"review_ready",executionAuthorized:false,mutationApplied:false,planHash:predecessor.planHash,planGenerationId:predecessor.planGenerationId,stepId:full.stepId,errorCode:null}),"source_review_ready_boundary");
  const sourceApply=steps.find(step=>step.stepId===predecessor.sourceApplyStepId),sourceFocused=steps.find(step=>step.stepId===predecessor.sourceFocusedStepId),sourcePlan=task.metadata.selfDevelopmentImplementationPlan;
  requireProof(sourceApply?.status==="completed"&&sourceFocused?.status==="completed"&&HASH.test(sourceApply.operationFingerprint||"")&&validateEntries(predecessor.entries,predecessor.requiredPaths),"source_complete_dirty_lineage");
  return{predecessor,sourceApply,sourceFocused,sourceFull:full,sourcePlan,fullCounts,entries:structuredClone(predecessor.entries),requiredPaths:structuredClone(predecessor.requiredPaths)};
}

export async function describeReviewRemediation(options){
  const{taskId=options.task?.id,input,actor,storage,ownerId,repository,approvedBranch,runtimeVersion,verifyRemote}=options,task=options.task||await options.runtime.get(taskId),steps=options.steps||await options.runtime.steps(taskId);
  requireProof(keys(input,["expectedVersion","planHash","runtimeVersion","workspaceProof","workspaceProofSignature","review","approvalId"])&&Number.isInteger(input.expectedVersion)&&HASH.test(input.planHash||"")&&SHA.test(runtimeVersion||"")&&input.runtimeVersion===runtimeVersion,"request_identity");
  const proof=input.workspaceProof;
  requireProof(keys(proof,["taskId","expectedVersion","runtimeVersion","workspace"])&&actor?.actorType==="scoped_local_worker"&&same(actor.workspaceProof,proof)&&proof.taskId===taskId&&proof.expectedVersion===input.expectedVersion&&proof.runtimeVersion===runtimeVersion,"authenticated_workspace_proof");
  requireProof(task?.id===taskId&&task.taskType==="self_development"&&task.stateVersion===input.expectedVersion&&task.status==="blocked"&&task.currentPhase==="run_full_tests"&&!task.errorCode&&!task.leaseOwner&&!task.leaseToken&&!task.metadata?.localHandoff&&!task.approvalState,"blocked_review_ready_task");
  requireProof(!task.metadata.reviewRemediationHistory?.length&&task.branch===approvedBranch&&task.metadata.selfDevelopment?.repository===repository&&SHA.test(task.currentCommit||"")&&task.currentCommit===task.startingCommit,"single_use_product_identity");
  const state=passingReviewBoundary(task,steps),{predecessor,sourcePlan,entries,requiredPaths,sourceApply,sourceFocused,sourceFull}=state;
  requireProof(input.planHash===sourcePlan.planHash,"source_plan_hash");
  const oldApproval=await storage.getApproval(predecessor.approvalId,ownerId);
  requireProof(oldApproval?.ownerId===ownerId&&oldApproval.projectId===task.projectId&&oldApproval.runId===task.id&&oldApproval.status==="approved"&&oldApproval.tool===FAILED_FULL_TEST_RETRY_TOOL&&same(oldApproval.arguments,predecessor.approvalArguments),"consumed_source_approval");
  const workspace=proof.workspace;
  requireProof(keys(workspace,["root","gitTopLevel","repository","branch","head","liveTip","clean","changedFiles"])&&recoveryRoot(workspace.root)===predecessor.workspaceRoot&&recoveryRoot(workspace.gitTopLevel)===predecessor.workspaceRoot&&workspace.repository===repository&&workspace.branch===task.branch&&workspace.head===task.currentCommit&&workspace.liveTip===task.currentCommit&&workspace.clean===false&&Array.isArray(workspace.changedFiles)&&workspace.changedFiles.length===8&&new Set(workspace.changedFiles.map(item=>item?.path)).size===8&&same(proofEntries(workspace.changedFiles),proofEntries(entries)),"current_eight_file_workspace");
  const review=validateStructuredReview(input.review,entries),reviewHash=recoveryHash({taskId,sourceVersion:task.stateVersion,planHash:sourcePlan.planHash,entries,review});
  requireProof(typeof verifyRemote==="function","remote_verifier");
  const product=await verifyRemote({repository,branch:task.branch,requiredAncestors:[task.currentCommit]}),control=await verifyRemote({repository,branch:"stage13/control-plane-approved-delivery-runtime",requiredAncestors:[predecessor.runtimeVersion,runtimeVersion]});
  requireProof(product?.currentTip===task.currentCommit&&product.ancestors?.[task.currentCommit]===true,"live_product_tip");requireProof(control?.currentTip===runtimeVersion&&control.ancestors?.[runtimeVersion]===true&&control.ancestors?.[predecessor.runtimeVersion]===true,"runtime_transition");
  const approvalArguments={taskId,projectId:task.projectId,expectedVersion:task.stateVersion,repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:predecessor.workspaceRoot,runtimeVersion,sourcePlanHash:sourcePlan.planHash,sourcePlanGenerationId:sourcePlan.provenance.generationId,sourcePlanSnapshotHash:recoveryHash(sourcePlan),sourcePlanGenerationsHash:recoveryHash(task.metadata.implementationPlanGenerations),sourceApplyStepId:sourceApply.stepId,sourceApplyHash:recoveryHash(sourceApply),sourceFocusedStepId:sourceFocused.stepId,sourceFocusedHash:recoveryHash(sourceFocused),sourceFullStepId:sourceFull.stepId,sourceFullHash:recoveryHash(sourceFull),sourceFullCounts:state.fullCounts,sourceFocusedCounts:predecessor.focusedCounts,predecessorGenerationId:predecessor.activeContinuation.generationId,predecessorAuthorityHash:recoveryHash(predecessor),workspaceProofHash:recoveryHash(proof),beforeEvidenceHash:recoveryHash(entries),mutationScopeHash:recoveryHash(requiredPaths),reviewHash,review,repairIteration:task.repairIteration,consumedHistoriesHash:recoveryHash(immutableHistories(task)),maxRecoveries:1,maxReviewRemediations:1,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxFullTestRuns:1,maxAdditionalAttempts:0,runtimeMinutes:15,maxSteps:13};
  return{task,steps,...state,review,reviewHash,proof,approvalArguments};
}

export async function recoverReviewRemediation(options){
  return recoverBoundRemediation(options,await describeReviewRemediation(options),DESCRIPTOR);
}

// Validate a rejected generation as immutable history, never revive its authority.
// Its original read/runtime bindings are checked at the recorded execution time.
function rejectedReviewSource(task,steps,sourceDescriptor=DESCRIPTOR,{privateEvidence,attestedSourceProof}={}){
  const history=task.metadata?.[sourceDescriptor.historyKey],predecessor=history?.[0],boundary=task.metadata?.[sourceDescriptor.boundaryKey];
  const contentRejection=sourceDescriptor===EVIDENCE_BOUND_DESCRIPTOR,rejectionPredicate=sourceDescriptor===DESCRIPTOR?"complete_behavioral_coverage":contentRejection?"implementation_plan_invalid":sourceDescriptor===SOURCE_LITERAL_DESCRIPTOR?"observable_behavioral_test_linkage":"source_bound_behavioral_coverage",terminalError=contentRejection?"implementation_plan_invalid":"review_remediation_precondition_failed";
  requireProof(history?.length===1&&predecessor?.recoveryClass===sourceDescriptor.recoveryClass&&predecessor.authorizationConsumed===true&&predecessor.consumed===true&&predecessor.result==="failed"&&predecessor.planningClaimed===true&&!predecessor.planHash&&!predecessor.planGenerationId&&!predecessor.afterEntries,"consumed_rejected_review_predecessor");
  requireProof(predecessor.workerBindingState==="bound"&&WORKER.test(predecessor.workerId||"")&&Array.isArray(predecessor.rejectedPriorWorkerIds)&&!predecessor.rejectedPriorWorkerIds.includes(predecessor.workerId)&&same(predecessor.claimedStepIds,predecessor.readStepIds),"rejected_source_worker_and_read_reservations");
  const failed=steps.find(step=>step.stepId===predecessor.planStepId),diagnostics=failed?.result?.diagnostics,evidence=diagnostics?.rejectedPlanEvidence;
  requireProof(task.status==="blocked"&&task.currentPhase==="read_files"&&task.currentStep===predecessor.activeContinuation.startStep+8&&task.errorCode===terminalError&&task.repairIteration===3&&task.repairIteration===predecessor.repairIteration&&!task.leaseOwner&&!task.leaseToken&&!task.metadata.localHandoff&&!task.approvalState,"rejected_review_plan_boundary");
  requireProof(failed?.taskId===task.id&&failed.stepType==="plan_repair"&&failed.status==="failed"&&failed.attempt===1&&HASH.test(failed.operationFingerprint||"")&&failed.errorCode===task.errorCode&&(contentRejection?diagnostics?.validationCode===rejectionPredicate&&diagnostics.mutationApplied!==true:diagnostics?.predicate===rejectionPredicate&&diagnostics.mutationApplied===false)&&same(failed.input,task.metadata.steps[predecessor.activeContinuation.startStep+8]?.input)&&!steps.some(step=>ordinal(step)>ordinal(failed)),"exact_rejected_plan_execution");
  // Reproduce the original worker's operation identity from its retained input;
  // this legacy digest deliberately uses that producer's JSON representation.
  const operationFingerprint=createHash("sha256").update(JSON.stringify([task.id,task.currentStep,failed.stepType,failed.input,task.currentCommit])).digest("hex");
  requireProof(failed.operationFingerprint===operationFingerprint,"rejected_plan_operation_fingerprint");
  if(!contentRejection)requireProof(evidence?.version===1&&evidence.taskId===task.id&&evidence.taskStateVersion===task.stateVersion-1&&evidence.currentCommit===task.currentCommit&&evidence.continuationGenerationId===predecessor.activeContinuation.generationId&&evidence.plannerAttempt===1&&evidence.mutationApplied===false&&HASH.test(evidence.planFingerprint||"")&&HASH.test(evidence.evidenceFingerprint||"")&&same(evidence.candidatePaths,predecessor.requiredPaths),"rejected_plan_durable_evidence");
  if(sourceDescriptor===SOURCE_BOUND_DESCRIPTOR)validateEvidenceBoundSourceRejection(diagnostics,evidence,predecessor);
  if(contentRejection)validateImplementationContentRejection({task,failed,diagnostics,predecessor,privateEvidence,attestedSourceProof});
  if(sourceDescriptor===IMPLEMENTATION_CONTENT_DESCRIPTOR)validateSourceLiteralRejection({task,failed,diagnostics,evidence,predecessor,privateEvidence,attestedSourceProof});
  if(sourceDescriptor===SOURCE_LITERAL_DESCRIPTOR)validateObservableLinkageRejection({task,failed,diagnostics,evidence,predecessor,privateEvidence,attestedSourceProof});
  const semanticRejection=sourceDescriptor===OBSERVABLE_LINKAGE_DESCRIPTOR?validateSemanticEvidenceRejection({task,failed,diagnostics,evidence,predecessor,privateEvidence,attestedSourceProof}):null;
  const expectedBoundary={kind:"product_repair_decision",executionAuthorized:false,reviewHash:predecessor.reviewHash,planHash:null,planGenerationId:null,stepId:failed.stepId,errorCode:task.errorCode,findingsResolved:false};
  requireProof(same(boundary,expectedBoundary)&&same(predecessor.boundary,boundary)&&same(task.metadata.activeContinuation,predecessor.activeContinuation),"rejected_plan_decision_boundary");
  const executionTime=Date.parse(failed.startedAt),completed=Date.parse(failed.completedAt),stopped=Date.parse(predecessor.completedAt);
  requireProof(Number.isFinite(executionTime)&&completed>=executionTime&&stopped>=executionTime&&executionTime>=Date.parse(predecessor.activeContinuation.runtimeStartedAt)&&completed<=Date.parse(predecessor.activeContinuation.runtimeDeadline)&&stopped<=Date.parse(predecessor.activeContinuation.runtimeDeadline),"historical_rejection_runtime");
  const projected=structuredClone(task);projected.status="running";projected.metadata[sourceDescriptor.historyKey][0].consumed=false;
  const historicalSteps=steps.filter(step=>step!==failed);
  let source;
  try{source=validateReviewRemediationReadEvidence(projected,historicalSteps,()=>new Date(executionTime));}catch(error){requireProof(false,`rejected_source_proof:${error.safeDiagnostics?.predicate||error.code}`);}
  if(semanticRejection){
    const exactSource=source.reads.get(semanticRejection.testPath);
    requireProof(typeof exactSource==="string"&&canonicalContentHash(exactSource)===semanticRejection.sourceHash&&!namedTestPattern(semanticRejection.testName).test(exactSource),"semantic_test_identity_absent_from_bound_source");
  }
  const readEvidenceHash=recoveryHash(predecessor.readStepIds.map(id=>steps.find(step=>step.stepId===id)));
  if(!contentRejection)requireProof(evidence.evidenceFingerprint===recoveryHash(predecessor.requiredPaths.map(path=>({path,contentHash:canonicalContentHash(source.reads.get(path)),readStepId:source.readStepIds.get(path)}))),"rejected_plan_read_fingerprint");
  const privateBound=contentRejection||sourceDescriptor===IMPLEMENTATION_CONTENT_DESCRIPTOR||sourceDescriptor===SOURCE_LITERAL_DESCRIPTOR||sourceDescriptor===OBSERVABLE_LINKAGE_DESCRIPTOR,privateEnvelope=privateEvidence?.envelope,sourceProof={version:1,sourceVersion:task.stateVersion,failedStepId:failed.stepId,failedStepHash:recoveryHash(failed),rejectedPlanFingerprint:privateBound?(privateEnvelope?.planFingerprint||attestedSourceProof?.rejectedPlanFingerprint):evidence.planFingerprint,predecessorGenerationId:predecessor.activeContinuation.generationId,predecessorHash:recoveryHash(predecessor),boundaryHash:recoveryHash(boundary),readEvidenceHash,...(privateBound?{privateEvidenceId:failed.result.rejectedReviewEvidence.id,privateEvidenceHash:privateEnvelope?recoveryHash(privateEnvelope):attestedSourceProof?.privateEvidenceHash}: {})};
  requireProof(!privateBound||HASH.test(sourceProof.rejectedPlanFingerprint||"")&&HASH.test(sourceProof.privateEvidenceHash||""),"private_rejected_plan_source_proof");
  return{predecessor,failed,reads:source.reads,sourceProof};
}

function validateImplementationContentRejection({task,failed,diagnostics,predecessor,privateEvidence,attestedSourceProof}){
  const reference=failed.result?.rejectedReviewEvidence,envelope=privateEvidence?.envelope,proof=attestedSourceProof;
  requireProof(reference?.persisted===true&&typeof reference.id==="string"&&(!privateEvidence||privateEvidence.id===reference.id&&privateEvidence.ownerId===task.ownerId&&privateEvidence.taskId===task.id)&&(!proof||proof.privateEvidenceId===reference.id),"private_implementation_content_evidence_reference");
  const paths=envelope?.proposedMutationPaths,tests=envelope?.selectedFocusedTestPaths,issues=diagnostics?.validationIssues;
  requireProof(diagnostics?.validationCode==="implementation_plan_invalid"&&Array.isArray(issues)&&issues.length===5&&issues.every((issue,index)=>issue===`file_${index}_content_invalid`)&&diagnostics.mutationApplied!==true,"exact_implementation_content_rejection");
  if(envelope)requireProof(envelope.version===1&&envelope.diagnosticOnly===true&&envelope.executionAuthorized===false&&envelope.mutationApplied===false&&envelope.taskId===task.id&&envelope.stateVersion===task.stateVersion-1&&envelope.executionId===failed.stepId&&envelope.attempt===1&&envelope.continuationGenerationId===predecessor.activeContinuation.generationId&&envelope.rejectionPredicate==="implementation_plan_invalid"&&HASH.test(envelope.planFingerprint||"")&&Array.isArray(paths)&&paths.length===5&&new Set(paths).size===5&&paths.every(path=>predecessor.requiredPaths.includes(path))&&Array.isArray(tests)&&tests.length===2&&tests.every(path=>predecessor.requiredPaths.includes(path))&&envelope.omittedMutationCount===0&&envelope.omittedFocusedTestCount===0,"private_implementation_content_evidence");
  else requireProof(HASH.test(proof?.privateEvidenceHash||"")&&HASH.test(proof?.rejectedPlanFingerprint||""),"attested_private_implementation_content_evidence");
}

function validateSourceLiteralRejection({task,failed,diagnostics,evidence,predecessor,privateEvidence,attestedSourceProof}){
  const reference=failed.result?.rejectedReviewEvidence,envelope=privateEvidence?.envelope,proof=attestedSourceProof;
  requireProof(reference?.persisted===true&&typeof reference.id==="string"&&(!privateEvidence||privateEvidence.id===reference.id&&privateEvidence.ownerId===task.ownerId&&privateEvidence.taskId===task.id)&&(!proof||proof.privateEvidenceId===reference.id),"private_source_literal_evidence_reference");
  const coverage=diagnostics?.coverageDiagnostics,first=coverage?.constraints?.[0],constraint=predecessor.review?.acceptanceConstraints?.[0],predicate="source_bound_behavioral_coverage",subclause="source_contains_excerpt";
  const passed=["coverage_record_allowed_fields","finding_ids_match","selected_focused_test","test_name_bounded","source_excerpt_bounded","source_hash_format","source_hash_matches"];
  requireProof(diagnostics?.predicate===predicate&&diagnostics.mutationApplied===false&&same(coverage?.firstFailure,{predicate,constraintId:constraint?.id,subclause})&&first?.evaluated===true&&first.firstFailedSubclause===subclause&&same(first.clauses,[...passed.map(name=>({predicate,subclause:name,passed:true})),{predicate,subclause,passed:false}])&&HASH.test(first.expectedSourceHash||"")&&first.expectedSourceHash===first.suppliedSourceHash&&first.suppliedSourceHashPresent===true&&predecessor.requiredPaths.includes(first.testPath)&&evidence?.requestedFocusedTests?.some(item=>item.path===first.testPath&&item.kind==="existing")&&coverage.constraints.slice(1).every(item=>item.evaluated===false&&item.firstFailedSubclause===null&&same(item.clauses,[])),"exact_source_literal_rejection");
  if(envelope){
    const item=envelope.coverage?.find(entry=>entry.constraintId===constraint.id);
    requireProof(envelope.version===1&&envelope.diagnosticOnly===true&&envelope.executionAuthorized===false&&envelope.mutationApplied===false&&envelope.taskId===task.id&&envelope.stateVersion===task.stateVersion-1&&envelope.executionId===failed.stepId&&envelope.attempt===1&&envelope.continuationGenerationId===predecessor.activeContinuation.generationId&&envelope.rejectionPredicate===predicate&&envelope.planFingerprint===evidence.planFingerprint&&Array.isArray(envelope.proposedMutationPaths)&&envelope.proposedMutationPaths.length>0&&envelope.proposedMutationPaths.length<=8&&envelope.proposedMutationPaths.every(path=>predecessor.requiredPaths.includes(path))&&Array.isArray(envelope.selectedFocusedTestPaths)&&envelope.selectedFocusedTestPaths.includes(first.testPath)&&item?.testPath===first.testPath&&item.sourceOrigin==="proposed_replacement"&&item.expectedSourceHash===first.expectedSourceHash&&item.suppliedSourceHash===first.suppliedSourceHash&&text(item.testName,300)&&text(item.sourceExcerpt,12000)&&item.firstFailedSubclause===subclause,"private_source_literal_evidence");
  }else requireProof(HASH.test(proof?.privateEvidenceHash||"")&&HASH.test(proof?.rejectedPlanFingerprint||""),"attested_private_source_literal_evidence");
}

function validateObservableLinkageRejection({task,failed,diagnostics,evidence,predecessor,privateEvidence,attestedSourceProof}){
  const reference=failed.result?.rejectedReviewEvidence,envelope=privateEvidence?.envelope,proof=attestedSourceProof;
  requireProof(reference?.persisted===true&&typeof reference.id==="string"&&(!privateEvidence||privateEvidence.id===reference.id&&privateEvidence.ownerId===task.ownerId&&privateEvidence.taskId===task.id)&&(!proof||proof.privateEvidenceId===reference.id),"private_observable_linkage_evidence_reference");
  const coverage=diagnostics?.coverageDiagnostics,first=coverage?.constraints?.[0],constraint=predecessor.review?.acceptanceConstraints?.[0],predicate="observable_behavioral_test_linkage",subclause="observable_code_reference";
  const sourcePassed=["coverage_record_allowed_fields","finding_ids_match","selected_focused_test","test_name_bounded","source_excerpt_bounded","source_hash_format","source_hash_matches","source_contains_excerpt","excerpt_contains_test_name","stimulus_bounded","observable_bounded","assertion_bounded","excerpt_contains_assertion","assertion_is_assertion"];
  const expectedClauses=[...sourcePassed.map(name=>({predicate:"source_bound_behavioral_coverage",subclause:name,passed:true})),{predicate,subclause:"named_test_declaration",passed:true},{predicate,subclause,passed:false}];
  requireProof(diagnostics?.predicate===predicate&&diagnostics.mutationApplied===false&&same(coverage?.firstFailure,{predicate,constraintId:constraint?.id,subclause})&&first?.evaluated===true&&first.firstFailedSubclause===subclause&&same(first.clauses,expectedClauses)&&HASH.test(first.expectedSourceHash||"")&&first.expectedSourceHash===first.suppliedSourceHash&&first.suppliedSourceHashPresent===true&&predecessor.requiredPaths.includes(first.testPath)&&evidence?.requestedFocusedTests?.some(item=>item.path===first.testPath&&item.kind==="existing")&&coverage.constraints.slice(1).every(item=>item.evaluated===false&&item.firstFailedSubclause===null&&same(item.clauses,[])),"exact_observable_linkage_rejection");
  if(envelope){
    const item=envelope.coverage?.find(entry=>entry.constraintId===constraint.id);
    requireProof(envelope.version===1&&envelope.diagnosticOnly===true&&envelope.executionAuthorized===false&&envelope.mutationApplied===false&&envelope.taskId===task.id&&envelope.stateVersion===task.stateVersion-1&&envelope.executionId===failed.stepId&&envelope.attempt===1&&envelope.continuationGenerationId===predecessor.activeContinuation.generationId&&envelope.rejectionPredicate===predicate&&envelope.planFingerprint===evidence.planFingerprint&&Array.isArray(envelope.proposedMutationPaths)&&envelope.proposedMutationPaths.length>0&&envelope.proposedMutationPaths.length<=8&&envelope.proposedMutationPaths.every(path=>predecessor.requiredPaths.includes(path))&&Array.isArray(envelope.selectedFocusedTestPaths)&&envelope.selectedFocusedTestPaths.includes(first.testPath)&&item?.testPath===first.testPath&&item.sourceOrigin==="proposed_replacement"&&item.expectedSourceHash===first.expectedSourceHash&&item.suppliedSourceHash===first.suppliedSourceHash&&text(item.testName,300)&&text(item.sourceExcerpt,12000)&&text(item.observable,500)&&item.firstFailedSubclause===subclause,"private_observable_linkage_evidence");
  }else requireProof(HASH.test(proof?.privateEvidenceHash||"")&&HASH.test(proof?.rejectedPlanFingerprint||""),"attested_private_observable_linkage_evidence");
}

function validateSemanticEvidenceRejection({task,failed,diagnostics,evidence,predecessor,privateEvidence,attestedSourceProof}){
  const reference=failed.result?.rejectedReviewEvidence,envelope=privateEvidence?.envelope,proof=attestedSourceProof;
  requireProof(reference?.persisted===true&&typeof reference.id==="string"&&(!privateEvidence||privateEvidence.id===reference.id&&privateEvidence.ownerId===task.ownerId&&privateEvidence.taskId===task.id)&&(!proof||proof.privateEvidenceId===reference.id),"private_semantic_evidence_reference");
  const coverage=diagnostics?.coverageDiagnostics,first=coverage?.constraints?.[0],constraint=predecessor.review?.acceptanceConstraints?.[0],predicate="source_bound_behavioral_coverage",subclause="source_contains_excerpt";
  const passed=["coverage_record_allowed_fields","finding_ids_match","selected_focused_test","test_name_bounded","source_excerpt_bounded","source_hash_format","source_hash_matches"];
  requireProof(diagnostics?.predicate===predicate&&diagnostics.mutationApplied===false&&same(coverage?.firstFailure,{predicate,constraintId:constraint?.id,subclause})&&first?.evaluated===true&&first.firstFailedSubclause===subclause&&same(first.clauses,[...passed.map(name=>({predicate,subclause:name,passed:true})),{predicate,subclause,passed:false}])&&HASH.test(first.expectedSourceHash||"")&&first.expectedSourceHash===first.suppliedSourceHash&&first.suppliedSourceHashPresent===true&&predecessor.requiredPaths.includes(first.testPath)&&evidence?.requestedFocusedTests?.some(item=>item.path===first.testPath&&item.kind==="existing")&&coverage.constraints.slice(1).every(item=>item.evaluated===false&&item.firstFailedSubclause===null&&same(item.clauses,[])),"exact_semantic_evidence_rejection");
  if(envelope){
    const item=envelope.coverage?.find(entry=>entry.constraintId===constraint.id);
    requireProof(envelope.version===1&&envelope.diagnosticOnly===true&&envelope.executionAuthorized===false&&envelope.mutationApplied===false&&envelope.taskId===task.id&&envelope.stateVersion===task.stateVersion-1&&envelope.executionId===failed.stepId&&envelope.attempt===1&&envelope.continuationGenerationId===predecessor.activeContinuation.generationId&&envelope.rejectionPredicate===predicate&&envelope.planFingerprint===evidence.planFingerprint&&Array.isArray(envelope.proposedMutationPaths)&&envelope.proposedMutationPaths.length>0&&envelope.proposedMutationPaths.length<=8&&envelope.proposedMutationPaths.every(path=>predecessor.requiredPaths.includes(path))&&Array.isArray(envelope.selectedFocusedTestPaths)&&envelope.selectedFocusedTestPaths.includes(first.testPath)&&item?.testPath===first.testPath&&item.sourceOrigin==="fresh_read"&&item.expectedSourceHash===first.expectedSourceHash&&item.suppliedSourceHash===first.suppliedSourceHash&&text(item.testName,300)&&text(item.sourceExcerpt,12000)&&item.firstFailedSubclause===subclause,"private_semantic_evidence");
    return{testPath:item.testPath,testName:item.testName,sourceHash:item.expectedSourceHash};
  }
  requireProof(HASH.test(proof?.privateEvidenceHash||"")&&HASH.test(proof?.rejectedPlanFingerprint||""),"attested_private_semantic_evidence");
  return null;
}

// The current source has clause-level durable diagnostics. Bind this new
// authority to that exact pre-mutation named-test rejection; never accept a
// generic coverage failure or reconstruct the unavailable original payload.
function validateEvidenceBoundSourceRejection(diagnostics,evidence,predecessor){
  const coverage=diagnostics.coverageDiagnostics,constraints=predecessor.review?.acceptanceConstraints,first=coverage?.constraints?.[0],constraint=constraints?.[0],predicate="source_bound_behavioral_coverage",subclause="excerpt_contains_test_name";
  const passed=["coverage_record_allowed_fields","finding_ids_match","selected_focused_test","test_name_bounded","source_excerpt_bounded","source_hash_format","source_hash_matches","source_contains_excerpt"];
  const expectedClauses=[...passed.map(name=>({predicate,subclause:name,passed:true})),{predicate,subclause,passed:false}];
  requireProof(coverage?.version===1&&coverage.planFingerprint===evidence.planFingerprint&&coverage.continuationGenerationId===predecessor.activeContinuation.generationId&&coverage.stateVersion===evidence.taskStateVersion&&same(coverage.firstFailure,{predicate,constraintId:constraint?.id,subclause})&&Array.isArray(coverage.constraints)&&coverage.constraints.length===5&&same(coverage.constraints.map(item=>item?.constraintId),constraints?.map(item=>item.id))&&first.evaluated===true&&first.firstFailedSubclause===subclause&&same(first.clauses,expectedClauses)&&same(first.findingIds,constraint.findingIds)&&same(first.suppliedFindingIds,constraint.findingIds)&&HASH.test(first.expectedSourceHash||"")&&first.expectedSourceHash===first.suppliedSourceHash&&first.suppliedSourceHashPresent===true&&predecessor.requiredPaths.includes(first.testPath)&&evidence.requestedFocusedTests?.some(item=>item.path===first.testPath&&item.kind==="existing")&&coverage.constraints.slice(1).every(item=>item.evaluated===false&&item.firstFailedSubclause===null&&same(item.clauses,[])),"exact_evidence_bound_named_test_rejection");
}

export async function describeRejectedReviewPlanContinuation(options){
  return describeRejectedRemediation(options,REJECTED_DESCRIPTOR,DESCRIPTOR);
}

// A distinct authority for a consumed rejected-plan continuation. This does
// not accept arbitrary planner failures or revive either predecessor approval.
export async function describeSourceBoundReviewReplan(options){
  return describeRejectedRemediation(options,SOURCE_BOUND_DESCRIPTOR,REJECTED_DESCRIPTOR);
}

export async function describeEvidenceBoundReviewReplan(options){
  return describeRejectedRemediation(options,EVIDENCE_BOUND_DESCRIPTOR,SOURCE_BOUND_DESCRIPTOR);
}

export async function describeImplementationContentReviewReplan(options){
  return describeRejectedRemediation(options,IMPLEMENTATION_CONTENT_DESCRIPTOR,EVIDENCE_BOUND_DESCRIPTOR);
}

export async function describeSourceLiteralReviewReplan(options){
  return describeRejectedRemediation(options,SOURCE_LITERAL_DESCRIPTOR,IMPLEMENTATION_CONTENT_DESCRIPTOR);
}

export async function describeObservableLinkageReviewReplan(options){
  return describeRejectedRemediation(options,OBSERVABLE_LINKAGE_DESCRIPTOR,SOURCE_LITERAL_DESCRIPTOR);
}

export async function describeSemanticEvidenceReviewReplan(options){
  return describeRejectedRemediation(options,SEMANTIC_EVIDENCE_DESCRIPTOR,OBSERVABLE_LINKAGE_DESCRIPTOR);
}

async function describeRejectedRemediation(options,descriptor,sourceDescriptor){
  const{taskId=options.task?.id,input,actor,storage,ownerId,repository,approvedBranch,runtimeVersion,verifyRemote}=options,task=options.task||await options.runtime.get(taskId),steps=options.steps||await options.runtime.steps(taskId);
  requireProof(keys(input,["expectedVersion","planHash","runtimeVersion","workspaceProof","workspaceProofSignature","review","approvalId"])&&Number.isInteger(input.expectedVersion)&&HASH.test(input.planHash||"")&&SHA.test(runtimeVersion||"")&&input.runtimeVersion===runtimeVersion,"request_identity");
  const proof=input.workspaceProof;
  requireProof(keys(proof,["taskId","expectedVersion","runtimeVersion","workspace"])&&actor?.actorType==="scoped_local_worker"&&same(actor.workspaceProof,proof)&&proof.taskId===taskId&&proof.expectedVersion===input.expectedVersion&&proof.runtimeVersion===runtimeVersion,"authenticated_workspace_proof");
  requireProof(task?.id===taskId&&task.taskType==="self_development"&&task.stateVersion===input.expectedVersion&&!task.metadata?.[descriptor.historyKey]?.length&&task.branch===approvedBranch&&task.metadata?.selfDevelopment?.repository===repository&&SHA.test(task.currentCommit||"")&&task.currentCommit===task.startingCommit,"single_use_rejected_plan_identity");
  let privateEvidence;
  if(sourceDescriptor===EVIDENCE_BOUND_DESCRIPTOR||sourceDescriptor===IMPLEMENTATION_CONTENT_DESCRIPTOR||sourceDescriptor===SOURCE_LITERAL_DESCRIPTOR||sourceDescriptor===OBSERVABLE_LINKAGE_DESCRIPTOR){
    const predecessor=task.metadata?.[sourceDescriptor.historyKey]?.[0],failed=steps.find(step=>step.stepId===predecessor?.planStepId),reference=failed?.result?.rejectedReviewEvidence;
    privateEvidence=reference?.persisted===true?await storage.getRejectedReviewEvidence(reference.id,ownerId,task.id):null;
    requireProof(privateEvidence,"private_implementation_content_evidence_available");
  }
  const{predecessor,failed,sourceProof}=rejectedReviewSource(task,steps,sourceDescriptor,{privateEvidence});
  const oldApproval=await storage.getApproval(predecessor.approvalId,ownerId);
  requireProof(oldApproval?.ownerId===ownerId&&oldApproval.projectId===task.projectId&&oldApproval.runId===task.id&&oldApproval.status==="approved"&&oldApproval.tool===sourceDescriptor.tool&&same(oldApproval.arguments,predecessor.approvalArguments),"consumed_review_approval");
  const entries=structuredClone(predecessor.beforeEntries),requiredPaths=structuredClone(predecessor.requiredPaths),review=structuredClone(predecessor.review),reviewHash=predecessor.reviewHash,sourcePlan=task.metadata.selfDevelopmentImplementationPlan;
  requireProof(input.planHash===predecessor.sourcePlanHash&&same(input.review,review)&&same(sourcePlan,predecessor.sourcePlanSnapshot),"immutable_rejected_review_binding");
  const workspace=proof.workspace;
  requireProof(keys(workspace,["root","gitTopLevel","repository","branch","head","liveTip","clean","changedFiles"])&&recoveryRoot(workspace.root)===predecessor.workspaceRoot&&recoveryRoot(workspace.gitTopLevel)===predecessor.workspaceRoot&&workspace.repository===repository&&workspace.branch===task.branch&&workspace.head===task.currentCommit&&workspace.liveTip===task.currentCommit&&workspace.clean===false&&Array.isArray(workspace.changedFiles)&&workspace.changedFiles.length===8&&new Set(workspace.changedFiles.map(item=>item?.path)).size===8&&same(proofEntries(workspace.changedFiles),proofEntries(entries)),"current_eight_file_workspace");
  requireProof(typeof verifyRemote==="function","remote_verifier");
  const product=await verifyRemote({repository,branch:task.branch,requiredAncestors:[task.currentCommit]}),control=await verifyRemote({repository,branch:"stage13/control-plane-approved-delivery-runtime",requiredAncestors:[predecessor.runtimeVersion,runtimeVersion]});
  requireProof(product?.currentTip===task.currentCommit&&product.ancestors?.[task.currentCommit]===true,"live_product_tip");requireProof(control?.currentTip===runtimeVersion&&control.ancestors?.[runtimeVersion]===true&&control.ancestors?.[predecessor.runtimeVersion]===true,"runtime_transition");
  const sourceApply=steps.find(step=>step.stepId===predecessor.sourceApplyStepId),sourceFocused=steps.find(step=>step.stepId===predecessor.sourceFocusedStepId),sourceFull=steps.find(step=>step.stepId===predecessor.sourceFullStepId);
  const approvalArguments={taskId,projectId:task.projectId,expectedVersion:task.stateVersion,repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:predecessor.workspaceRoot,runtimeVersion,sourcePlanHash:sourcePlan.planHash,sourcePlanGenerationId:sourcePlan.provenance.generationId,sourcePlanSnapshotHash:recoveryHash(sourcePlan),sourcePlanGenerationsHash:recoveryHash(task.metadata.implementationPlanGenerations),sourceApplyStepId:sourceApply.stepId,sourceApplyHash:recoveryHash(sourceApply),sourceFocusedStepId:sourceFocused.stepId,sourceFocusedHash:recoveryHash(sourceFocused),sourceFullStepId:sourceFull.stepId,sourceFullHash:recoveryHash(sourceFull),sourceFullCounts:predecessor.sourceFullCounts,sourceFocusedCounts:predecessor.sourceFocusedCounts,predecessorGenerationId:predecessor.activeContinuation.generationId,predecessorAuthorityHash:recoveryHash(predecessor),workspaceProofHash:recoveryHash(proof),beforeEvidenceHash:recoveryHash(entries),mutationScopeHash:recoveryHash(requiredPaths),reviewHash,review,reviewSourceVersion:predecessor.reviewSourceVersion??predecessor.fromStateVersion,rejectedPlanSource:sourceProof,repairIteration:task.repairIteration,consumedHistoriesHash:recoveryHash(immutableHistories(task,descriptor)),maxRecoveries:1,maxReviewRemediations:1,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxFullTestRuns:1,maxAdditionalAttempts:0,runtimeMinutes:15,maxSteps:13};
  return{task,steps,predecessor,failed,sourceProof,sourceApply,sourceFocused,sourceFull,sourcePlan,entries,requiredPaths,review,reviewHash,proof,fullCounts:predecessor.sourceFullCounts,approvalArguments};
}

export async function recoverRejectedReviewPlanContinuation(options){
  return recoverBoundRemediation(options,await describeRejectedReviewPlanContinuation(options),REJECTED_DESCRIPTOR);
}

export async function recoverSourceBoundReviewReplan(options){
  return recoverBoundRemediation(options,await describeSourceBoundReviewReplan(options),SOURCE_BOUND_DESCRIPTOR);
}

export async function recoverEvidenceBoundReviewReplan(options){
  return recoverBoundRemediation(options,await describeEvidenceBoundReviewReplan(options),EVIDENCE_BOUND_DESCRIPTOR);
}

export async function recoverImplementationContentReviewReplan(options){
  return recoverBoundRemediation(options,await describeImplementationContentReviewReplan(options),IMPLEMENTATION_CONTENT_DESCRIPTOR);
}

export async function recoverSourceLiteralReviewReplan(options){
  return recoverBoundRemediation(options,await describeSourceLiteralReviewReplan(options),SOURCE_LITERAL_DESCRIPTOR);
}

export async function recoverObservableLinkageReviewReplan(options){
  return recoverBoundRemediation(options,await describeObservableLinkageReviewReplan(options),OBSERVABLE_LINKAGE_DESCRIPTOR);
}

export async function recoverSemanticEvidenceReviewReplan(options){
  return recoverBoundRemediation(options,await describeSemanticEvidenceReviewReplan(options),SEMANTIC_EVIDENCE_DESCRIPTOR);
}

async function recoverBoundRemediation(options,state,descriptor){
  const{task,steps,predecessor,sourceApply,sourceFocused,sourceFull,sourcePlan,entries,requiredPaths,review,reviewHash,approvalArguments}=state,{input,storage,ownerId,clock=()=>new Date()}=options;
  const approval=input.approvalId?await storage.getApproval(input.approvalId,ownerId):null;
  requireProof(approval?.id===input.approvalId&&approval.ownerId===ownerId&&approval.projectId===task.projectId&&approval.runId===task.id&&approval.status==="approved"&&approval.tool===descriptor.tool&&same(approval.arguments,approvalArguments),"exact_owner_approval");
  const base=task.metadata.steps.length,now=clock().toISOString(),activeContinuation=createActiveContinuation({task,startStep:base,plannedSteps:13,repairLimit:0,recoveryClass:descriptor.recoveryClass,runtimeStartedAt:now,runtimeMinutes:15});
  const implementationContentReplan=[IMPLEMENTATION_CONTENT_DESCRIPTOR,SOURCE_LITERAL_DESCRIPTOR,OBSERVABLE_LINKAGE_DESCRIPTOR,SEMANTIC_EVIDENCE_DESCRIPTOR].includes(descriptor),sourceLiteralReplan=[SOURCE_LITERAL_DESCRIPTOR,OBSERVABLE_LINKAGE_DESCRIPTOR,SEMANTIC_EVIDENCE_DESCRIPTOR].includes(descriptor),observableLinkageReplan=[OBSERVABLE_LINKAGE_DESCRIPTOR,SEMANTIC_EVIDENCE_DESCRIPTOR].includes(descriptor),semanticEvidenceReplan=descriptor===SEMANTIC_EVIDENCE_DESCRIPTOR,nextSteps=remediationSteps({taskId:task.id,fromStateVersion:task.stateVersion,repository:approvalArguments.repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:approvalArguments.workspaceRoot,runtimeVersion:options.runtimeVersion,sourcePlanStepId:predecessor.sourcePlanStepId,sourceApplyStepId:sourceApply.stepId,sourceApplyFingerprint:sourceApply.operationFingerprint,activeContinuation,requiredPaths,beforeEntries:entries,reviewHash,review,implementationContentReplan,sourceLiteralReplan,observableLinkageReplan,semanticEvidenceReplan});
  const record={recoveryClass:descriptor.recoveryClass,taskId:task.id,fromStateVersion:task.stateVersion,toStateVersion:task.stateVersion+1,approvalId:approval.id,approvalArguments,authorizationConsumed:true,consumed:false,maxRecoveries:1,maxReviewRemediations:1,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxFullTestRuns:1,maxAdditionalAttempts:0,implementationContentReplan,sourceLiteralReplan,observableLinkageReplan,semanticEvidenceReplan,repository:approvalArguments.repository,branch:task.branch,currentCommit:task.currentCommit,workspaceRoot:approvalArguments.workspaceRoot,runtimeVersion:options.runtimeVersion,requiredPaths,beforeEntries:entries,afterEntries:null,review,reviewHash,unresolvedFindingIds:review.findings.filter(item=>item.severity==="blocking").map(item=>item.id),sourcePlanHash:sourcePlan.planHash,sourcePlanSnapshot:structuredClone(sourcePlan),sourcePlanStepId:predecessor.sourcePlanStepId,sourceApplyStepId:sourceApply.stepId,sourceApplyFingerprint:sourceApply.operationFingerprint,sourceFocusedStepId:sourceFocused.stepId,sourceFullStepId:sourceFull.stepId,sourceFocusedCounts:approvalArguments.sourceFocusedCounts,sourceFullCounts:state.fullCounts,sourcePlanGenerations:structuredClone(task.metadata.implementationPlanGenerations),sourceActivePlanGeneration:task.metadata.activeImplementationPlanGeneration,predecessorStepProofs:steps.map(step=>({stepId:step.stepId,stepHash:recoveryHash(step)})),immutableHistoryHashes:immutableHistories(task,descriptor),historicalPlannedStepsHash:recoveryHash(task.metadata.steps),historicalContinuationsHash:recoveryHash(task.metadata.continuationHistory),historicalContinuationsCount:task.metadata.continuationHistory.length,successorStepsHash:recoveryHash(nextSteps),readStepIds:requiredPaths.map((path,index)=>`${base+index+1}:read_files`),planStepId:`${base+9}:plan_repair`,validateStepId:`${base+10}:validate_patch`,applyStepId:`${base+11}:apply_patch`,focusedStepId:`${base+12}:run_focused_tests`,fullTestStepId:`${base+13}:run_full_tests`,planHash:null,planGenerationId:null,filesHash:null,fullPlanHash:null,focusedTests:null,coverageHash:null,planningClaimed:false,claimedStepIds:[],repairIteration:task.repairIteration,retryCount:task.retryCount,maxRetries:task.maxRetries,maxRepairIterations:task.metadata.maxRepairIterations,workerBindingState:"awaiting_worker_bind",workerId:null,rejectedPriorWorkerIds:[...new Set([predecessor.workerId,...predecessor.rejectedPriorWorkerIds])],activeContinuation,recoveredAt:now,...(state.sourceProof?{rejectedPlanSource:state.sourceProof,reviewSourceVersion:approvalArguments.reviewSourceVersion}: {})};
  const updated=await storage.updateAutonomyTask(task.id,ownerId,{status:"queued",currentStep:base,currentPhase:"read_files",nextRunAt:now,startedAt:now,completedAt:null,errorCode:null,blockedReason:null,checkpoint:{...task.checkpoint,pendingStep:null},metadata:{...task.metadata,steps:[...task.metadata.steps,...nextSteps],activeContinuation,continuationHistory:[...task.metadata.continuationHistory,activeContinuation],[descriptor.historyKey]:[record],requiredCapability:"repo_read_remote",autoDispatch:true}},task.stateVersion);
  requireProof(updated,"recovery_compare_and_swap");await storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action:descriptor===SEMANTIC_EVIDENCE_DESCRIPTOR?"self_development_semantic_evidence_review_replan_recovered":descriptor===OBSERVABLE_LINKAGE_DESCRIPTOR?"self_development_observable_linkage_review_replan_recovered":descriptor===SOURCE_LITERAL_DESCRIPTOR?"self_development_source_literal_review_replan_recovered":descriptor===IMPLEMENTATION_CONTENT_DESCRIPTOR?"self_development_implementation_content_review_replan_recovered":descriptor===EVIDENCE_BOUND_DESCRIPTOR?"self_development_evidence_bound_review_replan_recovered":descriptor===SOURCE_BOUND_DESCRIPTOR?"self_development_source_bound_review_replan_recovered":descriptor===REJECTED_DESCRIPTOR?"self_development_rejected_review_plan_continuation_recovered":"self_development_review_remediation_recovered",status:"queued",summary:"One owner-approved review remediation; original findings require fresh review after testing. No delivery or additional repair extension.",metadata:record});
  return{task:updated,recovery:record,idempotent:false};
}

function baseEvidence(task,steps,clock){
  const descriptor=reviewRemediationDescriptor(task)||DESCRIPTOR,history=task.metadata?.[descriptor.historyKey],record=history?.[0],active=task.metadata?.activeContinuation;
  requireProof(history?.length===1&&record?.recoveryClass===descriptor.recoveryClass&&record.authorizationConsumed===true&&record.consumed===false&&record.taskId===task.id&&record.repository===task.metadata.selfDevelopment?.repository&&record.branch===task.branch&&record.currentCommit===task.currentCommit&&task.currentCommit===task.startingCommit&&same(record.activeContinuation,active)&&same(active,task.metadata.continuationHistory?.at(-1))&&active.recoveryClass===descriptor.recoveryClass&&active.maxSteps===13&&active.runtimeMinutes===15&&task.currentStep>=active.startStep&&task.currentStep<active.startStep+13&&["queued","waiting_for_worker","running","planning"].includes(task.status),"active_remediation_generation");
  requireProof(Date.parse(active.runtimeDeadline)>clock().getTime(),"remediation_runtime_window");
  requireProof(task.repairIteration===record.repairIteration&&task.retryCount===record.retryCount&&task.maxRetries===record.maxRetries&&task.metadata.maxRepairIterations===record.maxRepairIterations&&same(immutableHistories(task),record.immutableHistoryHashes)&&task.metadata.continuationHistory.length===record.historicalContinuationsCount+1&&recoveryHash(task.metadata.continuationHistory.slice(0,-1))===record.historicalContinuationsHash,"preserved_consumed_authority");
  requireProof(validateEntries(record.beforeEntries,record.requiredPaths)&&record.reviewHash===record.approvalArguments.reviewHash&&same(record.review,record.approvalArguments.review)&&record.reviewHash===recoveryHash({taskId:task.id,sourceVersion:record.reviewSourceVersion??record.fromStateVersion,planHash:record.sourcePlanHash,entries:record.beforeEntries,review:record.review})&&record.approvalArguments.beforeEvidenceHash===recoveryHash(record.beforeEntries)&&record.approvalArguments.mutationScopeHash===recoveryHash(record.requiredPaths),"approved_review_and_workspace");
  validateStructuredReview(record.review,record.beforeEntries);
  requireProof(same(record.unresolvedFindingIds,record.review.findings.filter(item=>item.severity==="blocking").map(item=>item.id)),"findings_require_fresh_review");
  const expectedBinding={taskId:task.id,projectId:task.projectId,expectedVersion:record.fromStateVersion,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,runtimeVersion:record.runtimeVersion,sourcePlanHash:record.sourcePlanHash,sourcePlanSnapshotHash:recoveryHash(record.sourcePlanSnapshot),repairIteration:record.repairIteration,consumedHistoriesHash:recoveryHash(record.immutableHistoryHashes),maxRecoveries:1,maxReviewRemediations:1,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxFullTestRuns:1,maxAdditionalAttempts:0,runtimeMinutes:15,maxSteps:13};
  requireProof(Object.entries(expectedBinding).every(([key,value])=>same(record.approvalArguments[key],value))&&["maxRecoveries","maxReviewRemediations","maxProductMutations","maxApplyAttempts","maxFocusedTestRuns","maxFullTestRuns"].every(key=>record[key]===1)&&record.maxAdditionalAttempts===0,"bounded_owner_authority");
  const sourceDescriptor=predecessorDescriptor(descriptor);
  const predecessor=descriptor!==DESCRIPTOR?task.metadata[sourceDescriptor.historyKey]?.[0]:task.metadata.failedFullTestRetryHistory?.[0],sourceApply=steps.find(step=>step.stepId===record.sourceApplyStepId),sourceFocused=steps.find(step=>step.stepId===record.sourceFocusedStepId),sourceFull=steps.find(step=>step.stepId===record.sourceFullStepId),sourceBinding={sourcePlanGenerationId:record.sourcePlanSnapshot?.provenance?.generationId,sourcePlanGenerationsHash:recoveryHash(record.sourcePlanGenerations),sourceApplyStepId:record.sourceApplyStepId,sourceApplyHash:recoveryHash(sourceApply),sourceFocusedStepId:record.sourceFocusedStepId,sourceFocusedHash:recoveryHash(sourceFocused),sourceFullStepId:record.sourceFullStepId,sourceFullHash:recoveryHash(sourceFull),sourceFocusedCounts:record.sourceFocusedCounts,sourceFullCounts:record.sourceFullCounts,predecessorGenerationId:predecessor?.activeContinuation?.generationId,predecessorAuthorityHash:recoveryHash(predecessor)};
  requireProof(Object.entries(sourceBinding).every(([key,value])=>same(record.approvalArguments[key],value))&&record.sourcePlanStepId===predecessor?.sourcePlanStepId&&record.sourceApplyFingerprint===sourceApply?.operationFingerprint&&record.sourceActivePlanGeneration===record.sourcePlanSnapshot?.provenance?.generationId,"immutable_source_review_binding");
  if(descriptor!==DESCRIPTOR){
    requireProof(same(record.rejectedPlanSource,record.approvalArguments.rejectedPlanSource)&&record.reviewSourceVersion===(predecessor.reviewSourceVersion??predecessor.fromStateVersion)&&record.reviewSourceVersion===record.approvalArguments.reviewSourceVersion&&record.rejectedPlanSource?.sourceVersion===record.fromStateVersion,"approved_rejected_source_binding");
    const projected=structuredClone(task);
    projected.status="blocked";projected.stateVersion=record.fromStateVersion;projected.currentStep=predecessor.activeContinuation.startStep+8;projected.currentPhase="read_files";projected.errorCode=sourceDescriptor===EVIDENCE_BOUND_DESCRIPTOR?"implementation_plan_invalid":"review_remediation_precondition_failed";
    projected.leaseOwner=null;projected.leaseToken=null;projected.approvalState=null;
    delete projected.metadata[descriptor.historyKey];delete projected.metadata[descriptor.boundaryKey];
    projected.metadata.localHandoff=null;projected.metadata.activeContinuation=predecessor.activeContinuation;
    projected.metadata.continuationHistory=projected.metadata.continuationHistory.slice(0,record.historicalContinuationsCount);
    projected.metadata.steps=projected.metadata.steps.slice(0,active.startStep);
    projected.metadata.selfDevelopmentImplementationPlan=record.sourcePlanSnapshot;
    projected.metadata.implementationPlanGenerations=record.sourcePlanGenerations;
    projected.metadata.activeImplementationPlanGeneration=record.sourceActivePlanGeneration;
    const historical=rejectedReviewSource(projected,steps.filter(step=>ordinal(step)<=active.startStep),sourceDescriptor,{attestedSourceProof:record.rejectedPlanSource});
    requireProof(same(historical.sourceProof,record.rejectedPlanSource),"immutable_rejected_source_proof");
  }
  requireProof(Array.isArray(record.predecessorStepProofs)&&new Set(record.predecessorStepProofs.map(item=>item.stepId)).size===record.predecessorStepProofs.length&&steps.filter(step=>ordinal(step)<=active.startStep).length===record.predecessorStepProofs.length&&record.predecessorStepProofs.every(proof=>{const matches=steps.filter(step=>step.stepId===proof.stepId);return matches.length===1&&recoveryHash(matches[0])===proof.stepHash;}),"immutable_predecessor_steps");
  requireProof(task.metadata.steps.length===active.startStep+13&&recoveryHash(task.metadata.steps.slice(0,active.startStep))===record.historicalPlannedStepsHash&&recoveryHash(task.metadata.steps.slice(active.startStep))===record.successorStepsHash&&same(task.metadata.steps.slice(active.startStep),remediationSteps(record)),"bounded_remediation_steps");
  const phaseIds=[...record.readStepIds,record.planStepId,record.validateStepId,record.applyStepId,record.focusedStepId,record.fullTestStepId],phaseTypes=[...Array(8).fill("read_files"),"plan_repair","validate_patch","apply_patch","run_focused_tests","run_full_tests"],executions=steps.filter(step=>ordinal(step)>active.startStep);
  requireProof(phaseIds.length===13&&phaseIds.every((id,index)=>id===`${active.startStep+index+1}:${phaseTypes[index]}`)&&executions.length<=13&&new Set(executions.map(step=>step.stepId)).size===executions.length&&executions.every(step=>step.taskId===task.id&&phaseIds.includes(step.stepId)&&step.stepType===phaseTypes[phaseIds.indexOf(step.stepId)]&&step.attempt===1&&["running","completed"].includes(step.status))&&executions.every(step=>phaseIds.slice(0,phaseIds.indexOf(step.stepId)).every(id=>executions.some(prior=>prior.stepId===id&&prior.status==="completed"))),"one_ordered_remediation_execution");
  const localIds=phaseIds.filter(id=>id!==record.planStepId),claimed=record.claimedStepIds;
  requireProof(Array.isArray(claimed)&&claimed.length<=12&&same(claimed,localIds.slice(0,claimed.length))&&executions.every(step=>step.stepId===record.planStepId?record.planningClaimed===true:claimed.includes(step.stepId)),"single_use_phase_reservations");
  requireProof(phaseIds.slice(0,task.currentStep-active.startStep).every(id=>executions.some(step=>step.stepId===id&&step.status==="completed")),"completed_current_phase_prefix");
  return{record,history,active,executions,descriptor};
}

function completedReads(task,steps,record,requireAll){
  const reads=new Map(),readStepIds=new Map(),baselines=new Map();
  for(const[index,id]of record.readStepIds.entries()){
    const step=steps.find(item=>item.stepId===id);if(step?.status!=="completed")continue;
    const path=record.requiredPaths[index],content=step.result?.content,before=record.beforeEntries.find(item=>item.path===path);
    const binding={version:1,taskId:task.id,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,runtimeVersion:record.runtimeVersion,sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:record.sourceApplyStepId,sourceApplyFingerprint:record.sourceApplyFingerprint,continuationGenerationId:record.activeContinuation.generationId};
    requireProof(step.taskId===task.id&&step.stepType==="read_files"&&same(step.input,{tool:"repo_read_task_owned_local",arguments:{path,expectedContentHash:before.contentHash,binding}})&&step.result?.ok===true&&step.result.path===path&&step.result.truncated===false&&step.result.source==="task_owned_local_workspace"&&typeof content==="string"&&canonicalContentHash(content)===before.contentHash&&blobHash(content)===before.hash&&step.result.contentHash===before.contentHash&&same(step.result.reviewRemediationEvidence,{generationId:record.activeContinuation.generationId,reviewHash:record.reviewHash,planHash:null,entries:record.beforeEntries}),"fresh_complete_file_read");
    reads.set(path,content);readStepIds.set(path,id);
    requireProof(step.result.baselineCommit===task.currentCommit&&(step.result.baselineContent===null&&step.result.baselineContentHash===null||typeof step.result.baselineContent==="string"&&step.result.baselineContentHash===canonicalContentHash(step.result.baselineContent)),"baseline_product_commit");
    if(typeof step.result.baselineContent==="string")baselines.set(path,step.result.baselineContent);
  }
  if(requireAll)requireProof(reads.size===8&&record.requiredPaths.every(path=>reads.has(path)),"eight_fresh_reads_required");
  return{reads,readStepIds,baselines};
}

export function validateReviewRemediationPlanCoverage(plan,options){
  return validateReviewCoverageBindings(plan,options);
}

function planBinding(task,plan,record,reads,readStepIds){
  const coverage=validateReviewRemediationPlanCoverage(plan,{review:record.review,requiredPaths:record.requiredPaths,reads,context:{taskId:task.id,stateVersion:task.stateVersion,continuationGenerationId:record.activeContinuation.generationId,planGenerationId:plan.provenance?.generationId,planFingerprint:recoveryHash(plan),semanticEvidenceReplan:record.semanticEvidenceReplan===true}});
  requireProof(plan.files.every(file=>file.expectedContent===reads.get(file.path)),"exact_current_mutation_preconditions");
  const expectedHash=recoveryHash({files:plan.files.map(({expectedContent,...file})=>file),focusedTests:plan.focusedTests,acceptanceMapping:plan.acceptanceMapping,riskLevel:plan.riskLevel,reviewCoverage:plan.reviewCoverage});
  requireProof(HASH.test(plan.planHash||"")&&plan.planHash===expectedHash&&plan.provenance?.taskId===task.id&&plan.provenance.currentCommit===task.currentCommit&&plan.provenance.reviewRemediation===true&&plan.provenance.reviewHash===record.reviewHash&&plan.provenance.continuationGenerationId===record.activeContinuation.generationId,"remediation_plan_generation");
  const rebound=bindImplementationPlan({task,plan,evidence:record.requiredPaths.map(path=>({path,content:reads.get(path)})),readStepIds:record.requiredPaths.map(path=>readStepIds.get(path)),plannerAttempt:plan.provenance.plannerAttempt});
  requireProof(Object.entries(rebound).every(([key,value])=>same(plan.provenance[key],value)),"fresh_read_plan_provenance");
  const contents=new Map(reads);for(const file of plan.files)contents.set(file.path,file.content);
  return{planHash:plan.planHash,planGenerationId:plan.provenance.generationId,filesHash:recoveryHash(plan.files),fullPlanHash:recoveryHash(plan),afterEntries:record.requiredPaths.map(path=>entry(path,contents.get(path))),...coverage};
}

export function validateReviewRemediationTestResult(record,plan,result,{focused=false}={}){
  const output=String(result?.output||"").replace(/\x1b\[[0-9;]*m/g,""),counts=completeTerminalSummary(result);
  if(focused){
    requireProof(result.outputTruncated===false,"complete_focused_test_transcript");
    const observed=new Set(output.split(/\r?\n/).flatMap(line=>{
      const tap=line.match(/^\s*ok\s+\d+\s+-\s+(.+?)\s*$/);if(tap&&!/\s+#\s*(?:SKIP|TODO)\b/i.test(tap[1]))return[tap[1]];
      const spec=line.match(/^\s*[✔✓]\s+(.+?)\s+\([\d.]+(?:ms|s)\)\s*$/);return spec?[spec[1]]:[];
    }));
    requireProof(Array.isArray(plan?.reviewCoverage)&&plan.reviewCoverage.length===5&&plan.reviewCoverage.every(item=>observed.has(item.testName)),"behavioral_coverage_tests_executed");
  }
  return counts;
}

export function validateReviewRemediationEvidence(task,steps,clock=()=>new Date()){
  const state=baseEvidence(task,steps,clock),{record,executions}=state,planStep=executions.find(step=>step.stepId===record.planStepId),reads=completedReads(task,steps,record,Boolean(planStep));
  if(planStep?.status==="completed"){
    const plan=planStep.result?.implementationPlan,binding=planBinding(task,plan,record,reads.reads,reads.readStepIds);
    requireProof(planStep.result?.ok===true&&same(plan,task.metadata.selfDevelopmentImplementationPlan)&&Object.entries(binding).every(([key,value])=>same(record[key],value)),"accepted_plan_binding");
    const sourceTask={...task,metadata:{...task.metadata,implementationPlanGenerations:record.sourcePlanGenerations}},expected=planLifecycleMetadata(sourceTask,plan);
    requireProof(same(task.metadata.implementationPlanGenerations,expected.implementationPlanGenerations)&&task.metadata.activeImplementationPlanGeneration===plan.provenance.generationId,"single_active_plan_supersession");
  }else requireProof(same(task.metadata.selfDevelopmentImplementationPlan,record.sourcePlanSnapshot)&&same(task.metadata.implementationPlanGenerations,record.sourcePlanGenerations)&&task.metadata.activeImplementationPlanGeneration===record.sourceActivePlanGeneration&&!record.planHash,"unchanged_source_plan_before_planning");
  const validated=executions.find(step=>step.stepId===record.validateStepId),applied=executions.find(step=>step.stepId===record.applyStepId),focused=executions.find(step=>step.stepId===record.focusedStepId),full=executions.find(step=>step.stepId===record.fullTestStepId);
  for(const resultStep of[validated,applied,focused,full].filter(step=>step?.status==="completed"))requireProof(same(resultStep.result?.reviewRemediationEvidence,{generationId:record.activeContinuation.generationId,reviewHash:record.reviewHash,planHash:record.planHash,entries:resultStep===validated?record.beforeEntries:record.afterEntries}),"completed_phase_workspace_evidence");
  if(validated?.status==="completed")requireProof(validated.result?.ok===true&&validated.result.preMutationValidated===true&&validated.result.mutationApplied===false&&validated.result.currentCommit===task.currentCommit&&validated.result.planGenerationId===record.planGenerationId&&same(validated.result.files,task.metadata.selfDevelopmentImplementationPlan.files.map(file=>file.path)),"completed_remediation_validation");
  if(applied?.status==="completed"){
    const lineage=applied.result?.taskOwnedDirtyLineage;
    requireProof(applied.result?.ok===true&&same(applied.result.files,task.metadata.selfDevelopmentImplementationPlan.files.map(file=>file.path))&&lineage?.version===1&&lineage.taskId===task.id&&lineage.repository===record.repository&&lineage.branch===task.branch&&lineage.currentCommit===task.currentCommit&&lineage.sourceApplyStepId===record.applyStepId&&lineage.sourcePlanStepId===record.planStepId&&same(ordered(lineage.entries||[]).map(({path,contentHash})=>({path,contentHash})),ordered(record.afterEntries).map(({path,contentHash})=>({path,contentHash}))),"complete_remediation_apply_lineage");
  }
  for(const resultStep of[focused,full].filter(step=>step?.status==="completed"))validateReviewRemediationTestResult(record,planStep.result.implementationPlan,resultStep.result,{focused:resultStep===focused});
  return{...state,...reads,plan:planStep?.result?.implementationPlan,planStep,validated,applied,focused,full};
}
export function validateReviewRemediationReadEvidence(task,steps,clock=()=>new Date()){const state=validateReviewRemediationEvidence(task,steps,clock);return{...state,...completedReads(task,steps,state.record,true)};}
export function acceptedReviewRemediationPlanBinding(task,plan,steps,clock=()=>new Date()){const state=baseEvidence(task,steps,clock),reads=completedReads(task,steps,state.record,true);requireProof(task.currentStep===state.record.activeContinuation.startStep+8&&state.record.planningClaimed===true,"single_planning_slot");return planBinding(task,plan,state.record,reads.reads,reads.readStepIds);}
export const bindReviewRemediationPlan=acceptedReviewRemediationPlanBinding;
export function validateReviewRemediationContext(task,steps,context,clock=()=>new Date()){
  const state=validateReviewRemediationEvidence(task,steps,clock),{record}=state,firstBind=context.allowFirstBind===true&&record.workerBindingState==="awaiting_worker_bind"&&record.workerId===null&&task.currentStep===record.activeContinuation.startStep;
  requireProof(context.runtimeVersion===record.runtimeVersion&&context.generationId===record.activeContinuation.generationId&&context.repository===record.repository&&context.branch===record.branch&&recoveryRoot(context.root)===record.workspaceRoot,"worker_context");
  requireProof(WORKER.test(context.workerId||"")&&!record.rejectedPriorWorkerIds.includes(context.workerId)&&(firstBind||record.workerBindingState==="bound"&&record.workerId===context.workerId),"worker_succession");return{...state,firstBind};
}
export function reviewRemediationScopePayload(record){return{version:1,recoveryClass:record.recoveryClass,taskId:record.taskId,approvalId:record.approvalId,repository:record.repository,branch:record.branch,currentCommit:record.currentCommit,workspaceRoot:record.workspaceRoot,runtimeVersion:record.runtimeVersion,workerId:record.workerId,continuationGenerationId:record.activeContinuation.generationId,runtimeDeadline:record.activeContinuation.runtimeDeadline,runtimeMinutes:15,requiredPaths:structuredClone(record.requiredPaths),beforeEntries:structuredClone(record.beforeEntries),afterEntries:structuredClone(record.afterEntries),reviewHash:record.reviewHash,sourcePlanHash:record.sourcePlanHash,sourcePlanStepId:record.sourcePlanStepId,sourceApplyStepId:record.sourceApplyStepId,sourceApplyFingerprint:record.sourceApplyFingerprint,readStepIds:record.readStepIds,planStepId:record.planStepId,validateStepId:record.validateStepId,applyStepId:record.applyStepId,focusedStepId:record.focusedStepId,fullTestStepId:record.fullTestStepId,planHash:record.planHash,planGenerationId:record.planGenerationId,filesHash:record.filesHash,fullPlanHash:record.fullPlanHash,focusedTests:record.focusedTests,coverageHash:record.coverageHash,maxProductMutations:1,maxApplyAttempts:1,maxFocusedTestRuns:1,maxFullTestRuns:1,maxAdditionalAttempts:0};}
