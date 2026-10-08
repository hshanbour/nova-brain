import {createHash} from "node:crypto";

const TYPES=new Set(["public_research","verified_memory","owner_claim","inference","estimate","unknown"]);
const MATERIALITY=new Set(["ordinary","material","critical"]);
const VERDICTS=new Set(["supported","partially_supported","unsupported","conflicting","insufficient_evidence"]);
const CALCULATION_KINDS=new Set(["none","sum","difference","product","ratio","range","assumption"]);
const STOP=new Set(["a","an","and","are","as","at","be","been","by","for","from","has","have","in","is","it","of","on","or","that","the","their","this","to","was","were","with","about","according","current","currently"]);
const clean=(value,max=20_000)=>String(value||"").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g," ").trim().slice(0,max);
const normalized=value=>clean(value,8_000).toLowerCase().normalize("NFKC").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/[^\p{L}\p{N}%$£€.+-]+/gu," ").replace(/\s+/g," ").trim();
const hash=value=>createHash("sha256").update(String(value)).digest("hex");
const explicitUncertainty=value=>/\b(?:unknown|unverified|not (?:known|available|verified|provided|present|found|established|supplied)|no (?:verified|authoritative|accepted|available)?\s*(?:data|evidence|information)|(?:cannot|can't) (?:verify|confirm|establish)|(?:does not|do not|is not|are not|was not|were not)\b.{0,80}\b(?:provided|present|available|contained|found|established|supplied|known|verified|in (?:the )?(?:accepted )?(?:project )?memory)|no (?:accepted )?(?:project )?memory (?:confirms?|contains?|provides?)|inference|estimate|estimated|likely|may|might|could)\b|(?:غير معروف|غير متاح|غير متحقق|غير موجود|لم يتم (?:توفير|تقديم|التحقق)|لا توجد (?:بيانات|معلومات)|استنتاج|تقدير|قد|ربما)/iu.test(value);
const important=value=>/(?:[$£€]\s*\d|\d(?:[\d,.]*\d)?\s*(?:%|percent|per cent|customers?|bookings?|appointments?|revenue|sales|GBP|USD|EUR|minutes?|hours?|days?|months?|years?))|\b(?:currently|today|now|latest)\b.{0,100}\b(?:has|uses|runs|offers|charges|operates|integrates?|connected|deployed|costs?|requires?)|\b(?:customer count|booking figures?|revenue|sales|website status|booking system|integration status|licen[cs]e|required by law|regulation)\b/iu.test(value);
const regulatory=value=>/\b(?:licen[cs]e|permit|regulation|regulated|required by law|legal requirement|must register|statutory|legislation)\b/iu.test(value);
const currentClaim=value=>/\b(?:current(?:ly)?|today|now|latest|as of)\b/iu.test(value);
const splitImportant=answer=>answer.split(/\n+|(?<=[.!?؟])\s+/u).map(value=>clean(value.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/,""),1_000)).filter(value=>value&&important(value)&&!explicitUncertainty(value));
const lexicalTokens=value=>normalized(value).split(" ").filter(token=>token.length>1);
const contentTokens=value=>lexicalTokens(value).filter(token=>!STOP.has(token)&&!/^\d/.test(token));
const relatedText=(left,right)=>{const a=normalized(left),b=normalized(right);if(!a||!b)return false;if(a.includes(b)||b.includes(a))return true;const leftTokens=lexicalTokens(left),rightTokens=lexicalTokens(right);if(Math.min(leftTokens.length,rightTokens.length)<3)return false;const leftSet=new Set(leftTokens),rightSet=new Set(rightTokens);let overlap=0;for(const token of leftSet)if(rightSet.has(token))overlap+=1;return overlap/Math.min(leftSet.size,rightSet.size)>=.8&&overlap/Math.max(leftSet.size,rightSet.size)>=.45;};
const answerSegments=answer=>[answer,...answer.split(/\n+|(?<=[.!?؟])\s+/u)].map(value=>clean(value,2_000)).filter(Boolean);
const quantityTokens=value=>[...normalized(value).matchAll(/(?:[$£€]\s*)?\d[\d,.]*(?:\s*(?:%|percent|per cent|gbp|usd|eur|pounds?|customers?|bookings?|appointments?|revenue|sales|minutes?|hours?|days?|months?|years?))?/giu)].map(match=>match[0].replace(/\s+/g," ").trim());
const sourceAuthority=domain=>/^(?:www\.)?(?:gov\.uk|legislation\.gov\.uk)$/i.test(domain||"")||/\.gov\.uk$/i.test(domain||"")?"official_uk_public":"public_web";
const sourceJurisdiction=domain=>sourceAuthority(domain)==="official_uk_public"?"UK":null;
const validDate=value=>/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(String(value||""))?String(value):null;
const splitChunks=value=>{const parts=String(value||"").split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/).map(item=>clean(item,3_000)).filter(Boolean),out=[];for(const part of parts){if(part.length<=3_000)out.push(part);else for(let index=0;index<part.length;index+=2_800)out.push(part.slice(index,index+3_000));}return out.slice(0,24);};

export function buildEvidenceBundle(result){
  const pages=new Map((result?.pages||[]).map(page=>[page.url,page])),sources=[];
  for(const source of result?.sources||[]){
    const page=pages.get(source.url),retained=[];
    for(const [index,text] of splitChunks(page?.text||"").entries())retained.push({evidenceId:`evidence_${hash(`${source.sourceId}:page:${index}:${text}`).slice(0,20)}`,sourceId:source.sourceId,origin:"direct_source",strength:"direct",text,contentHash:hash(text)});
    const summarySegments=String(result?.summary||"").split(/\n+|(?<=[.!?])\s+/u);
    for(const [index,segment] of summarySegments.entries()){
      const urls=[...segment.matchAll(/\[[^\]]+\]\((https:\/\/[^)\s]+)\)/g)].map(match=>{try{return new URL(match[1]).href;}catch{return null;}}).filter(Boolean);
      let canonical;try{canonical=new URL(source.url).href;}catch{canonical=null;}
      if(canonical&&urls.includes(canonical)){const text=clean(segment,3_000);if(text&&!retained.some(item=>normalized(item.text)===normalized(text)))retained.push({evidenceId:`evidence_${hash(`${source.sourceId}:summary:${index}:${text}`).slice(0,20)}`,sourceId:source.sourceId,origin:"provider_summary",strength:"secondary_summary",text,contentHash:hash(text)});}
    }
    sources.push({sourceId:source.sourceId,title:clean(source.title,200),url:source.url,domain:source.domain,retrievedAt:validDate(source.retrievedAt),publishedAt:validDate(source.publishedAt),updatedAt:validDate(source.updatedAt),authority:sourceAuthority(source.domain),jurisdiction:source.jurisdiction||sourceJurisdiction(source.domain),contentHash:source.contentHash||page?.contentHash||null,chunks:retained.slice(0,24)});
  }
  const bundle={version:2,createdAt:validDate(result?.performedAt)||sources.map(source=>source.retrievedAt).filter(Boolean).sort().at(-1)||null,sources};
  return Object.freeze({...bundle,bundleHash:hash(JSON.stringify(bundle))});
}

const calculationSchema={type:"object",additionalProperties:false,properties:{kind:{type:"string",enum:[...CALCULATION_KINDS]},result:{type:"string",maxLength:120},operands:{type:"array",maxItems:12,items:{type:"string",maxLength:240}}},required:["kind","result","operands"]};
export const groundedAnswerSchema=Object.freeze({type:"object",additionalProperties:false,properties:{version:{type:"number",enum:[2]},answer:{type:"string",maxLength:20_000},claims:{type:"array",maxItems:48,items:{type:"object",additionalProperties:false,properties:{text:{type:"string",maxLength:1_000},classification:{type:"string",enum:[...TYPES]},materiality:{type:"string",enum:[...MATERIALITY]},sourceIds:{type:"array",maxItems:12,items:{type:"string",pattern:"^source_[1-9][0-9]*$"}},evidenceIds:{type:"array",maxItems:24,items:{type:"string",pattern:"^evidence_[a-f0-9]{20}$"}},memoryIds:{type:"array",maxItems:8,items:{type:"string",minLength:1,maxLength:160}},asOf:{type:"string",maxLength:80},jurisdiction:{type:"string",maxLength:80},calculation:calculationSchema},required:["text","classification","materiality","sourceIds","evidenceIds","memoryIds","asOf","jurisdiction","calculation"]}}},required:["version","answer","claims"]});

const failure=(reason,message="The final research answer failed evidence-grounding validation.")=>Object.assign(new Error(message),{code:"web_research_grounding_invalid",safeDiagnostics:{stage:"final_claim_validation",reasonCode:reason}});
const numeric=value=>{const match=String(value||"").replace(/,/g,"").match(/-?\d+(?:\.\d+)?/);return match?Number(match[0]):null;};
const calculate=calculation=>{const values=calculation.operands.map(numeric);if(values.some(value=>!Number.isFinite(value)))return null;switch(calculation.kind){case"sum":return values.reduce((a,b)=>a+b,0);case"difference":return values.length===2?values[0]-values[1]:null;case"product":return values.reduce((a,b)=>a*b,1);case"ratio":return values.length===2&&values[1]!==0?values[0]/values[1]:null;case"range":return values.length===2?values:null;default:return null;}};
const lexicallySupported=(claim,evidence)=>{const wanted=new Set(contentTokens(claim)),available=new Set(contentTokens(evidence));if(wanted.size<2)return true;let overlap=0;for(const token of wanted)if(available.has(token))overlap+=1;return overlap>=2&&overlap/wanted.size>=.25;};

export function parseGroundedAnswer(generated,{result,taskContextSnapshot,evidenceBundle=buildEvidenceBundle(result)}={}){
  if(generated?.type!=="final")throw failure("non_final");
  let value;try{value=JSON.parse(generated.message);}catch{throw failure("invalid_json");}
  if(!value||value.version!==2||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["version","answer","claims"].includes(key)))throw failure("unexpected_field");
  const answer=clean(value.answer);if(!answer)throw failure("answer_missing");
  if(!Array.isArray(value.claims)||value.claims.length>48)throw failure("claims_invalid");
  const sources=new Map((evidenceBundle?.sources||[]).map(item=>[item.sourceId,item])),evidence=new Map((evidenceBundle?.sources||[]).flatMap(source=>source.chunks.map(chunk=>[chunk.evidenceId,{...chunk,source}]))),memories=new Map((taskContextSnapshot?.acceptedMemories||[]).map(item=>[item.id,item])),claims=[];
  for(const item of value.claims){
    if(!item||typeof item!=="object"||Array.isArray(item)||Object.keys(item).some(key=>!["text","classification","materiality","sourceIds","evidenceIds","memoryIds","asOf","jurisdiction","calculation"].includes(key))||!TYPES.has(item.classification)||!MATERIALITY.has(item.materiality)||!Array.isArray(item.sourceIds)||!Array.isArray(item.evidenceIds)||!Array.isArray(item.memoryIds)||!item.calculation||!CALCULATION_KINDS.has(item.calculation.kind)||!Array.isArray(item.calculation.operands))throw failure("claim_shape_invalid");
    const text=clean(item.text,1_000),asOf=clean(item.asOf,80),jurisdiction=clean(item.jurisdiction,80),calculation={kind:item.calculation.kind,result:clean(item.calculation.result,120),operands:item.calculation.operands.map(value=>clean(value,240))};let listedSources=[...new Set(item.sourceIds)],listedEvidence=[...new Set(item.evidenceIds)],listedMemories=[...new Set(item.memoryIds)];
    if(!text||lexicalTokens(text).length<3||!answerSegments(answer).some(segment=>relatedText(segment,text)))throw failure("claim_not_in_answer");
    if(item.classification!=="unknown"&&important(text)&&item.materiality==="ordinary")throw failure("material_claim_misclassified");
    if(item.classification==="unknown"){if(!explicitUncertainty(text))throw failure("unknown_claim_invalid");listedSources=[];listedEvidence=[];listedMemories=[];calculation.kind="none";calculation.result="";calculation.operands=[];}
    if(listedSources.some(id=>!sources.has(id)))throw failure("unknown_source_id");
    if(listedEvidence.some(id=>!evidence.has(id)))throw failure("unknown_evidence_id");
    if(listedEvidence.some(id=>!listedSources.includes(evidence.get(id).sourceId)))throw failure("evidence_source_mismatch");
    if(listedMemories.some(id=>!memories.has(id)))throw failure("unknown_memory_id");
    if(item.classification==="public_research"&&(!listedSources.length||!listedEvidence.length||listedMemories.length))throw failure("public_claim_unbound");
    if(["verified_memory","owner_claim"].includes(item.classification)&&(!listedMemories.length||listedSources.length||listedEvidence.length))throw failure("memory_claim_unbound");
    if(item.classification==="verified_memory"&&listedMemories.some(id=>["hypothesis","unresolved_question"].includes(memories.get(id)?.evidenceType)))throw failure("unverified_memory_claim");
    if(item.classification==="owner_claim"&&listedMemories.some(id=>!["owner_claim","owner_preference","owner_decision"].includes(memories.get(id)?.evidenceType)))throw failure("owner_claim_misclassified");
    if(["inference","estimate"].includes(item.classification)&&!listedEvidence.length&&!listedMemories.length)throw failure("derived_claim_unbound");
    const supportText=[...listedEvidence.map(id=>evidence.get(id).text),...listedMemories.map(id=>memories.get(id)?.content||"")].join(" "),quantities=quantityTokens(text);
    if(listedEvidence.length&&item.materiality!=="ordinary"&&!lexicallySupported(text,supportText))throw failure("claim_evidence_semantic_mismatch");
    if(quantities.length&&item.classification==="public_research"&&quantities.some(token=>!normalized(supportText).includes(normalized(token))))throw failure("quantity_not_in_evidence");
    if(quantities.length&&item.classification==="estimate"){
      if(calculation.kind==="none")throw failure("estimate_calculation_required");
      const operandText=calculation.operands.join(" ");if(quantityTokens(operandText).some(token=>!normalized(supportText).includes(normalized(token))))throw failure("calculation_operand_unsupported");
      if(!["assumption","range"].includes(calculation.kind)){const computed=calculate(calculation),declared=numeric(calculation.result);if(!Number.isFinite(computed)||!Number.isFinite(declared)||Math.abs(computed-declared)>Math.max(.01,Math.abs(declared)*.001))throw failure("calculation_result_invalid");}
    }
    if(regulatory(text)&&item.materiality!=="ordinary"){
      if(!jurisdiction)throw failure("regulatory_jurisdiction_missing");
      if(!listedSources.length||listedSources.some(id=>sources.get(id).authority!=="official_uk_public"))throw failure("regulatory_authority_invalid");
      if(listedEvidence.some(id=>evidence.get(id).origin!=="direct_source"))throw failure("regulatory_primary_text_required");
    }
    if(jurisdiction&&listedSources.some(id=>sources.get(id).jurisdiction&&normalized(sources.get(id).jurisdiction)!==normalized(jurisdiction)))throw failure("claim_jurisdiction_mismatch");
    if(currentClaim(text)&&item.classification!=="unknown"){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(asOf))throw failure("current_claim_date_missing");
      const dated=listedSources.map(id=>sources.get(id)).filter(Boolean);if(dated.some(source=>{const value=source.updatedAt||source.publishedAt;if(!value)return false;return Date.parse(asOf)-Date.parse(value)>395*86400000;}))throw failure("current_claim_source_stale");
    }
    claims.push({claimId:`claim_${claims.length+1}`,text,classification:item.classification,materiality:item.materiality,sourceIds:listedSources,evidenceIds:listedEvidence,memoryIds:listedMemories,asOf,jurisdiction,calculation,quantities,verification:{status:item.materiality==="ordinary"||!["public_research","inference","estimate"].includes(item.classification)?"not_required":"pending"}});
  }
  for(const sentence of splitImportant(answer))if(!claims.some(claim=>relatedText(sentence,claim.text)))throw failure("important_claim_unmapped");
  return Object.freeze({answer,claims:Object.freeze(claims),evidenceBundle,providerUsage:generated.providerUsage||null,validatedAt:new Date().toISOString(),version:2});
}

export const semanticVerificationSchema=count=>Object.freeze({type:"object",additionalProperties:false,properties:{assessments:{type:"array",minItems:count,maxItems:count,items:{type:"object",additionalProperties:false,properties:{claimId:{type:"string",pattern:"^claim_[1-9][0-9]*$"},verdict:{type:"string",enum:[...VERDICTS]},evidenceIds:{type:"array",maxItems:24,items:{type:"string",pattern:"^evidence_[a-f0-9]{20}$"}},reasonCode:{type:"string",enum:["direct_support","scope_mismatch","meaning_mismatch","quantity_mismatch","date_mismatch","jurisdiction_mismatch","conflicting_evidence","insufficient_evidence"]},requiredQualifier:{type:"string",maxLength:500}},required:["claimId","verdict","evidenceIds","reasonCode","requiredQualifier"]}}},required:["assessments"]});

export function semanticVerificationContext(grounded){
  const pending=grounded.claims.filter(claim=>claim.verification.status==="pending"),evidence=new Map(grounded.evidenceBundle.sources.flatMap(source=>source.chunks.map(chunk=>[chunk.evidenceId,{...chunk,sourceId:source.sourceId,title:source.title,url:source.url,authority:source.authority,jurisdiction:source.jurisdiction,retrievedAt:source.retrievedAt,publishedAt:source.publishedAt,updatedAt:source.updatedAt}])));
  return{version:2,claims:pending.map(claim=>({claimId:claim.claimId,text:claim.text,classification:claim.classification,materiality:claim.materiality,asOf:claim.asOf,jurisdiction:claim.jurisdiction,evidence:claim.evidenceIds.map(id=>evidence.get(id)).filter(Boolean)}))};
}

export function applySemanticVerification(grounded,generated){
  const context=semanticVerificationContext(grounded),expected=new Map(context.claims.map(item=>[item.claimId,item])),knownEvidence=new Set(grounded.evidenceBundle.sources.flatMap(source=>source.chunks.map(chunk=>chunk.evidenceId)));
  if(!context.claims.length)return{...grounded,verification:{version:1,status:"not_required",assessments:[]},claims:grounded.claims.map(claim=>({...claim,verification:{status:"not_required"}}))};
  if(generated?.type!=="final")throw failure("semantic_verifier_non_final");let value;try{value=JSON.parse(generated.message);}catch{throw failure("semantic_verifier_invalid_json");}
  if(!value||!Array.isArray(value.assessments)||value.assessments.length!==expected.size)throw failure("semantic_verifier_count_mismatch");
  const seen=new Set(),assessments=[];for(const item of value.assessments){if(!item||!expected.has(item.claimId)||seen.has(item.claimId)||!VERDICTS.has(item.verdict)||!Array.isArray(item.evidenceIds)||item.evidenceIds.some(id=>!knownEvidence.has(id)||!expected.get(item.claimId).evidence.some(evidence=>evidence.evidenceId===id)))throw failure("semantic_verifier_invalid_assessment");seen.add(item.claimId);assessments.push({claimId:item.claimId,verdict:item.verdict,evidenceIds:[...new Set(item.evidenceIds)],reasonCode:clean(item.reasonCode,80),requiredQualifier:clean(item.requiredQualifier,500)});}
  const byId=new Map(assessments.map(item=>[item.claimId,item])),claims=grounded.claims.map(claim=>({...claim,verification:byId.has(claim.claimId)?{status:byId.get(claim.claimId).verdict,reasonCode:byId.get(claim.claimId).reasonCode,evidenceIds:byId.get(claim.claimId).evidenceIds,requiredQualifier:byId.get(claim.claimId).requiredQualifier}:{status:"not_required"}})),failed=claims.filter(claim=>claim.verification.status!=="not_required"&&claim.verification.status!=="supported"&&!(claim.verification.status==="conflicting"&&/\b(?:conflict|disagree|differ|vary)\b/i.test(claim.text)));
  return{...grounded,claims,verification:{version:1,status:failed.length?"failed":"passed",assessments,failedClaimIds:failed.map(claim=>claim.claimId),providerUsage:generated.providerUsage||null}};
}

export const evidenceGroundingFailure=failure;
