import test from "node:test";
import assert from "node:assert/strict";
import {createMemoryLearningService} from "../src/memory/learning-service.js";
import {createTaskContextSnapshot} from "../src/memory/task-context-snapshot.js";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createExecutionTruthService} from "../src/autonomy/execution-truth.js";
import {createDurableWebResearchService} from "../src/web/durable-web-research.js";
import {buildEvidenceBundle,parseGroundedAnswer,applySemanticVerification,semanticVerificationContext} from "../src/web/evidence-grounding.js";

const OWNER="owner-evidence-v2";
const owner={id:OWNER,fullName:"Mohammad"};
const noCalculation={kind:"none",result:"",operands:[]};
const resultFor=({domain="gov.uk",url="https://www.gov.uk/example",text="UK businesses must keep accurate company records.",summary="Official guidance is retained.",publishedAt="2026-09-01"}={})=>({
  version:1,researchId:"research-v2",query:"evidence validation",purpose:"general",performedAt:"2026-10-08T12:00:00Z",summary,
  sources:[{sourceId:"source_1",title:"Official guidance",url,domain,retrievedAt:"2026-10-08T12:00:00Z",publishedAt,contentHash:"a".repeat(64)}],
  pages:[{status:"completed",url,domain,title:"Official guidance",text,contentHash:"a".repeat(64),retrievedAt:"2026-10-08T12:00:00Z",limitation:null}],actions:[{type:"search"}],limitations:[],usage:{searchCalls:1}
});
const claim=(text,{classification="public_research",materiality="material",sourceIds=["source_1"],evidenceIds=[],memoryIds=[],asOf="",jurisdiction="",calculation=noCalculation}={})=>({text,classification,materiality,sourceIds,evidenceIds,memoryIds,asOf,jurisdiction,calculation});
const generated=(answer,claims,providerUsage=null)=>({type:"final",message:JSON.stringify({version:2,answer,claims}),providerUsage});
const parse=(result,claims,answer=claims.map(item=>item.text).join(" "))=>parseGroundedAnswer(generated(answer,claims),{result,evidenceBundle:buildEvidenceBundle(result),taskContextSnapshot:{acceptedMemories:[]}});
const reason=(fn,expected)=>assert.throws(fn,error=>error.code==="web_research_grounding_invalid"&&error.safeDiagnostics.reasonCode===expected);

test("canonical chunks retain exact provenance and exclude an unretained dental-study summary claim",()=>{
  const result=resultFor({summary:"A dental study reported a 30% reduction in missed appointments. [Nature](https://www.nature.com/unretained-study)"}),bundle=buildEvidenceBundle(result),chunks=bundle.sources[0].chunks;
  assert.equal(bundle.version,2);assert.match(bundle.bundleHash,/^[a-f0-9]{64}$/);assert.equal(bundle.sources[0].authority,"official_uk_public");
  assert.ok(chunks.every(item=>item.sourceId==="source_1"&&/^evidence_[a-f0-9]{20}$/.test(item.evidenceId)&&/^[a-f0-9]{64}$/.test(item.contentHash)));
  assert.ok(chunks.some(item=>item.origin==="direct_source"));
  const dental=chunks.find(item=>/dental study/i.test(item.text));assert.equal(dental,undefined);
  reason(()=>parse(result,[claim("A dental study found a 30% reduction in missed appointments.",{evidenceIds:[chunks[0].evidenceId]})]),"claim_evidence_semantic_mismatch");
});

test("a citation-leading provider segment retains its immediately preceding support as secondary evidence",()=>{
  const url="https://www.gov.uk/bank-holidays?utm_source=openai",summary="**Yes.** The official GOV.UK bank holidays page has a section titled **“England and Wales”** and lists bank holidays for that region. ([gov.uk](https://www.gov.uk/bank-holidays?utm_source=openai)) **Recency:** The page was crawled recently, but its publication date was not verified.",result=resultFor({domain:"www.gov.uk",url,text:"",summary,publishedAt:null}),bundle=buildEvidenceBundle(result),chunks=bundle.sources[0].chunks;
  assert.equal(chunks.length,1);assert.equal(chunks[0].origin,"provider_summary");assert.equal(chunks[0].strength,"secondary_summary");assert.match(chunks[0].text,/section titled \*\*“England and Wales”\*\*/);assert.match(chunks[0].text,/\[gov\.uk\]\(https:\/\/www\.gov\.uk\/bank-holidays\?utm_source=openai\)/);assert.equal(chunks[0].contentHash.length,64);assert.equal(bundle.sources[0].contentHash,"a".repeat(64));
  const text="The official GOV.UK bank holidays page lists bank holidays for England and Wales.",grounded=parse(result,[claim(text,{evidenceIds:[chunks[0].evidenceId],jurisdiction:"UK"})],`${text} [GOV.UK](${url})`),verified=applySemanticVerification(grounded,{type:"final",message:JSON.stringify({assessments:[{claimId:"claim_1",verdict:"supported",evidenceIds:[chunks[0].evidenceId],reasonCode:"direct_support",requiredQualifier:""}]})});
  assert.equal(verified.verification.status,"passed");assert.equal(verified.claims[0].verification.status,"supported");
});

test("citation adjacency does not retain an unrelated preceding claim or upgrade summary evidence to direct text",()=>{
  const url="https://www.gov.uk/bank-holidays",summary=`A dental study reported a 30% reduction in missed appointments. The official GOV.UK page lists bank holidays for England and Wales. [GOV.UK](${url})`,result=resultFor({domain:"www.gov.uk",url,text:"",summary,publishedAt:null}),chunks=buildEvidenceBundle(result).sources[0].chunks;
  assert.equal(chunks.length,1);assert.equal(chunks[0].origin,"provider_summary");assert.equal(chunks[0].strength,"secondary_summary");assert.doesNotMatch(chunks[0].text,/dental study/i);
  reason(()=>parse(result,[claim("A dental study reported a 30% reduction in missed appointments.",{evidenceIds:[chunks[0].evidenceId]})]),"claim_evidence_semantic_mismatch");
});

test("citation-bound summary evidence cannot satisfy a regulatory primary-text requirement",()=>{
  const url="https://www.gov.uk/example",summary=`Businesses must obtain a licence before regulated trading. ([GOV.UK](${url}))`,result=resultFor({url,text:"",summary,publishedAt:null}),id=buildEvidenceBundle(result).sources[0].chunks[0].evidenceId;
  reason(()=>parse(result,[claim("Businesses must obtain a licence before regulated trading.",{evidenceIds:[id],jurisdiction:"UK"})]),"regulatory_primary_text_required");
});

test("an existing but unrelated source cannot validate a material business claim",()=>{
  const result=resultFor(),id=buildEvidenceBundle(result).sources[0].chunks[0].evidenceId;
  reason(()=>parse(result,[claim("Salon reminder messages reduce missed appointments.",{evidenceIds:[id]})]),"claim_evidence_semantic_mismatch");
});

test("quantities, currencies, units, calculations, dates, freshness, and jurisdiction fail closed",()=>{
  const result=resultFor({domain:"example.com",url:"https://example.com/pricing",text:"The plan costs $50 per month and includes 20 customer messages.",publishedAt:"2024-01-01"}),id=buildEvidenceBundle(result).sources[0].chunks[0].evidenceId;
  reason(()=>parse(result,[claim("The plan costs £50 per month.",{evidenceIds:[id]})]),"quantity_not_in_evidence");
  reason(()=>parse(result,[claim("The plan includes 20% customer messages.",{evidenceIds:[id]})]),"quantity_not_in_evidence");
  reason(()=>parse(result,[claim("The current plan costs $50 per month.",{evidenceIds:[id],asOf:"2026-10-08"})]),"current_claim_source_stale");
  reason(()=>parse(result,[claim("The plan saves $100 per month.",{classification:"estimate",evidenceIds:[id],calculation:{kind:"product",result:"100",operands:["$50","3"]}})]),"calculation_operand_unsupported");
  const current=resultFor({domain:"example.com",url:"https://example.com/pricing",text:"The plan costs $50 per month and includes 2 accounts.",publishedAt:"2026-09-01"}),currentId=buildEvidenceBundle(current).sources[0].chunks[0].evidenceId;
  reason(()=>parse(current,[claim("The plan estimate is $100 per month.",{classification:"estimate",evidenceIds:[currentId],calculation:{kind:"product",result:"90",operands:["$50","2"]}})]),"calculation_result_invalid");
  const legal=resultFor({domain:"example.com",url:"https://example.com/legal",text:"Businesses must obtain a licence before regulated trading.",publishedAt:"2026-09-01"}),legalId=buildEvidenceBundle(legal).sources[0].chunks[0].evidenceId;
  reason(()=>parse(legal,[claim("Businesses must obtain a licence before regulated trading.",{evidenceIds:[legalId],jurisdiction:"UK"})]),"regulatory_authority_invalid");
});

test("regulatory claims require direct official text and an explicit jurisdiction",()=>{
  const result=resultFor({text:"UK businesses must obtain a licence before regulated trading."}),id=buildEvidenceBundle(result).sources[0].chunks[0].evidenceId;
  reason(()=>parse(result,[claim("UK businesses must obtain a licence before regulated trading.",{evidenceIds:[id]})]),"regulatory_jurisdiction_missing");
  const grounded=parse(result,[claim("UK businesses must obtain a licence before regulated trading.",{evidenceIds:[id],jurisdiction:"UK"})]);assert.equal(grounded.claims.length,1);
});

test("independent semantic verification sees only cited chunks and rejects unsupported or conflicting claims",()=>{
  const result=resultFor({text:"Appointment reminders reduced missed appointments by 20% in the cited study."}),id=buildEvidenceBundle(result).sources[0].chunks[0].evidenceId,grounded=parse(result,[claim("Appointment reminders reduced missed appointments by 20% in the cited study.",{evidenceIds:[id]})]);
  const context=semanticVerificationContext(grounded);assert.equal(context.claims.length,1);assert.deepEqual(context.claims[0].evidence.map(item=>item.evidenceId),[id]);assert.doesNotMatch(JSON.stringify(context),/Official guidance is retained/);
  const unsupported=applySemanticVerification(grounded,{type:"final",message:JSON.stringify({assessments:[{claimId:"claim_1",verdict:"unsupported",evidenceIds:[id],reasonCode:"meaning_mismatch",requiredQualifier:"Remove it."}]})});
  assert.equal(unsupported.verification.status,"failed");
  const pass=applySemanticVerification(grounded,{type:"final",message:JSON.stringify({assessments:[{claimId:"claim_1",verdict:"supported",evidenceIds:[id],reasonCode:"direct_support",requiredQualifier:""}]})});assert.equal(pass.verification.status,"passed");
  const conflict=applySemanticVerification(grounded,{type:"final",message:JSON.stringify({assessments:[{claimId:"claim_1",verdict:"conflicting",evidenceIds:[id],reasonCode:"conflicting_evidence",requiredQualifier:"Report the conflict."}]})});assert.equal(conflict.verification.status,"failed");
});

test("durable synthesis permits exactly one correction pass and then succeeds or fails closed",async()=>{
  async function run({recover}){
    const storage=createInMemoryStorage();await storage.initialize({owner});const evidence=resultFor({domain:"example.com",url:"https://example.com/study",text:"Appointment reminders reduced missed appointments by 20% in the cited study.",publishedAt:"2026-09-01"}),evidenceId=buildEvidenceBundle(evidence).sources[0].chunks[0].evidenceId;let synthesisCalls=0,verifierCalls=0;
    const provider={async generate(input){
      if(input.responseFormat?.name==="nova_research_evidence_relevance"){const context=JSON.parse(input.message.slice(input.message.indexOf("\n")+1));return{type:"final",message:JSON.stringify({assessments:context.section.requirements.map(()=>({sourceIds:["source_1"]}))})};}
      if(input.responseFormat?.name==="nova_research_claim_verification_v2"){verifierCalls+=1;return{type:"final",message:JSON.stringify({assessments:[{claimId:"claim_1",verdict:recover&&verifierCalls===2?"supported":"unsupported",evidenceIds:[evidenceId],reasonCode:recover&&verifierCalls===2?"direct_support":"meaning_mismatch",requiredQualifier:recover&&verifierCalls===2?"":"Remove unsupported wording."}]})};}
      synthesisCalls+=1;const text="Appointment reminders reduced missed appointments by 20% in the cited study.";return generated(text,[claim(text,{evidenceIds:[evidenceId]})]);
    }};
    const service=createDurableWebResearchService({storage,ownerId:OWNER,webGateway:{async research(){return structuredClone(evidence);}},modelProvider:provider,executionTruth:createExecutionTruthService({storage,ownerId:OWNER})});let task=(await service.prepare({request:"Research reminder evidence thoroughly and provide a sourced business report.",conversationId:`correction-${recover}`,runId:"origin",webAuthority:{ownerDomains:[]}})).task;task=(await service.executeTask(task.id,{coordinatorId:"worker",expectedVersion:task.stateVersion})).task;const final=await service.executeTask(task.id,{coordinatorId:"worker",expectedVersion:task.stateVersion});return{final,synthesisCalls,verifierCalls};
  }
  const recovered=await run({recover:true});assert.equal(recovered.final.task.status,"completed");assert.deepEqual([recovered.synthesisCalls,recovered.verifierCalls],[2,2]);assert.equal(recovered.final.result.claimManifest.verification.status,"passed");
  const closed=await run({recover:false});assert.equal(closed.final.task.status,"failed");assert.equal(closed.final.task.errorCode,"web_research_grounding_invalid");assert.deepEqual([closed.synthesisCalls,closed.verifierCalls],[2,2]);assert.equal(closed.final.task.metadata.researchState.validationFailure.reasonCode,"semantic_support_failed");
});

test("the single correction pass also repairs a deterministic Claim Manifest validation failure",async()=>{
  const storage=createInMemoryStorage();await storage.initialize({owner});const evidence=resultFor({domain:"example.com",url:"https://example.com/study",text:"Appointment reminders reduced missed appointments by 20% in the cited study.",publishedAt:"2026-09-01"}),evidenceId=buildEvidenceBundle(evidence).sources[0].chunks[0].evidenceId;let synthesisCalls=0,verifierCalls=0;
  const provider={async generate(input){
    if(input.responseFormat?.name==="nova_research_evidence_relevance"){const context=JSON.parse(input.message.slice(input.message.indexOf("\n")+1));return{type:"final",message:JSON.stringify({assessments:context.section.requirements.map(()=>({sourceIds:["source_1"]}))})};}
    if(input.responseFormat?.name==="nova_research_claim_verification_v2"){verifierCalls+=1;return{type:"final",message:JSON.stringify({assessments:[{claimId:"claim_1",verdict:"supported",evidenceIds:[evidenceId],reasonCode:"direct_support",requiredQualifier:""}]})};}
    synthesisCalls+=1;const answer="Appointment reminders reduced missed appointments by 20% in the cited study.",text=synthesisCalls===1?"A different unsupported claim appears only in the manifest.":answer;return generated(answer,[claim(text,{evidenceIds:[evidenceId]})]);
  }};
  const service=createDurableWebResearchService({storage,ownerId:OWNER,webGateway:{async research(){return structuredClone(evidence);}},modelProvider:provider,executionTruth:createExecutionTruthService({storage,ownerId:OWNER})});let task=(await service.prepare({request:"Research reminder evidence thoroughly and provide a sourced business report.",conversationId:"deterministic-correction",runId:"origin",webAuthority:{ownerDomains:[]}})).task;task=(await service.executeTask(task.id,{coordinatorId:"worker",expectedVersion:task.stateVersion})).task;const final=await service.executeTask(task.id,{coordinatorId:"worker",expectedVersion:task.stateVersion});
  assert.equal(final.task.status,"completed");assert.deepEqual([synthesisCalls,verifierCalls],[2,1]);assert.equal(final.result.claimManifest.verification.status,"passed");
});

test("owner review cannot promote an unverified V2 research outcome, while passed provenance survives into future task context",async()=>{
  const storage=createInMemoryStorage();await storage.initialize({owner,projects:[{id:"project-a",name:"Project A"}]});const learning=createMemoryLearningService({storage,ownerId:OWNER});
  const queued=await storage.createAutonomyTask({id:`web_${"a".repeat(32)}`,ownerId:OWNER,projectId:"project-a",title:"Research",objective:"Research",taskType:"public_web_research",metadata:{researchFinalAnswer:"Unsupported conclusion.",researchClaimManifest:{version:2,evidenceBundleHash:"b".repeat(64),verification:{status:"failed"},claims:[]}}}),task={...queued,status:"completed"};
  const pending=await learning.observeTaskOutcome(task,"Unsupported conclusion.");assert.equal(pending.candidate.evidence.version,3);assert.equal(pending.candidate.evidence.verificationStatus,"failed");
  await assert.rejects(()=>learning.reviewCandidate(pending.candidate.id,{decision:"accepted"}),error=>error.code==="memory_candidate_evidence_unverified");
  const passedQueued=await storage.createAutonomyTask({id:`web_${"c".repeat(32)}`,ownerId:OWNER,projectId:"project-a",title:"Verified research",objective:"Research",taskType:"public_web_research",metadata:{researchFinalAnswer:"Verified conclusion.",researchClaimManifest:{version:2,evidenceBundleHash:"d".repeat(64),verification:{status:"passed"},claims:[{claimId:"claim_1",classification:"public_research",materiality:"material",sourceIds:["source_1"],evidenceIds:["evidence_aaaaaaaaaaaaaaaaaaaa"],memoryIds:[],verification:{status:"supported"}}]}}}),passedTask={...passedQueued,status:"completed"};
  const verified=await learning.observeTaskOutcome(passedTask,"Verified conclusion."),accepted=await learning.reviewCandidate(verified.candidate.id,{decision:"accepted"});assert.equal(accepted.memory.evidence.verificationStatus,"passed");
  const snapshot=createTaskContextSnapshot({retrieved:{projects:await storage.listProjects(OWNER),memories:await storage.listMemories(OWNER,{projectId:"project-a"}),recentWork:[]},projectId:"project-a",request:"Use the verified conclusion in later research"});assert.equal(snapshot.priorLessons[0].memoryId,accepted.memory.id);assert.equal(snapshot.acceptedMemories.find(item=>item.id===accepted.memory.id).evidence.evidenceBundleHash,"d".repeat(64));
});
