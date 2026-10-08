const TYPES=new Set(["public_research","verified_memory","owner_claim","inference","estimate","unknown"]);
const clean=(value,max=20_000)=>String(value||"").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g," ").trim().slice(0,max);
const normalized=value=>clean(value,2_000).toLowerCase().normalize("NFKC").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/[^\p{L}\p{N}%$£€]+/gu," ").replace(/\s+/g," ").trim();
const explicitUncertainty=value=>/\b(?:unknown|unverified|not (?:known|available|verified|provided|present|found|established|supplied)|no (?:verified|authoritative|accepted|available)?\s*(?:data|evidence|information)|(?:cannot|can't) (?:verify|confirm|establish)|(?:does not|do not|is not|are not|was not|were not)\b.{0,80}\b(?:provided|present|available|contained|found|established|supplied|known|verified|in (?:the )?(?:accepted )?(?:project )?memory)|no (?:accepted )?(?:project )?memory (?:confirms?|contains?|provides?)|inference|estimate|estimated|likely|may|might|could)\b|(?:غير معروف|غير متاح|غير متحقق|غير موجود|لم يتم (?:توفير|تقديم|التحقق)|لا توجد (?:بيانات|معلومات)|استنتاج|تقدير|قد|ربما)/iu.test(value);
const important=value=>/(?:[$£€]\s*\d|\d(?:[\d,.]*\d)?\s*(?:%|percent|per cent|customers?|bookings?|appointments?|revenue|sales|GBP|USD|minutes?|hours?|days?))|\b(?:currently|today|now)\b.{0,80}\b(?:has|uses|runs|offers|charges|operates|integrates?|connected|deployed)|\b(?:customer count|booking figures?|revenue|sales|website status|booking system|integration status)\b/iu.test(value);
const splitImportant=answer=>answer.split(/\n+|(?<=[.!?؟])\s+/u).map(value=>clean(value.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/,""),1_000)).filter(value=>value&&important(value)&&!explicitUncertainty(value));
const lexicalTokens=value=>normalized(value).split(" ").filter(token=>token.length>1);
const relatedText=(left,right)=>{const a=normalized(left),b=normalized(right);if(!a||!b)return false;if(a.includes(b)||b.includes(a))return true;const leftTokens=lexicalTokens(left),rightTokens=lexicalTokens(right);if(Math.min(leftTokens.length,rightTokens.length)<3)return false;const leftSet=new Set(leftTokens),rightSet=new Set(rightTokens);let overlap=0;for(const token of leftSet)if(rightSet.has(token))overlap+=1;return overlap/Math.min(leftSet.size,rightSet.size)>=.8&&overlap/Math.max(leftSet.size,rightSet.size)>=.45;};
const answerSegments=answer=>[answer,...answer.split(/\n+|(?<=[.!?؟])\s+/u)].map(value=>clean(value,2_000)).filter(Boolean);

export const groundedAnswerSchema=Object.freeze({type:"object",additionalProperties:false,properties:{answer:{type:"string",maxLength:20_000},claims:{type:"array",maxItems:48,items:{type:"object",additionalProperties:false,properties:{text:{type:"string",maxLength:1_000},classification:{type:"string",enum:[...TYPES]},sourceIds:{type:"array",maxItems:12,items:{type:"string",pattern:"^source_[1-9][0-9]*$"}},memoryIds:{type:"array",maxItems:8,items:{type:"string",minLength:1,maxLength:160}}},required:["text","classification","sourceIds","memoryIds"]}}},required:["answer","claims"]});

const failure=(reason,message="The final research answer failed evidence-grounding validation.")=>Object.assign(new Error(message),{code:"web_research_grounding_invalid",safeDiagnostics:{stage:"final_claim_validation",reasonCode:reason}});

export function parseGroundedAnswer(generated,{result,taskContextSnapshot}={}){
  if(generated?.type!=="final")throw failure("non_final");
  let value;try{value=JSON.parse(generated.message);}catch{throw failure("invalid_json");}
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!["answer","claims"].includes(key)))throw failure("unexpected_field");
  const answer=clean(value.answer);if(!answer)throw failure("answer_missing");
  if(!Array.isArray(value.claims)||value.claims.length>48)throw failure("claims_invalid");
  const sourceIds=new Set((result?.sources||[]).map(item=>item.sourceId)),memories=new Map((taskContextSnapshot?.acceptedMemories||[]).map(item=>[item.id,item])),claims=[];
  for(const item of value.claims){
    if(!item||typeof item!=="object"||Array.isArray(item)||Object.keys(item).some(key=>!["text","classification","sourceIds","memoryIds"].includes(key))||!TYPES.has(item.classification)||!Array.isArray(item.sourceIds)||!Array.isArray(item.memoryIds))throw failure("claim_shape_invalid");
    const text=clean(item.text,1_000);let listedSources=[...new Set(item.sourceIds)],listedMemories=[...new Set(item.memoryIds)];
    if(!text||lexicalTokens(text).length<3||!answerSegments(answer).some(segment=>relatedText(segment,text)))throw failure("claim_not_in_answer");
    if(item.classification==="unknown"){if(!explicitUncertainty(text))throw failure("unknown_claim_invalid");listedSources=[];listedMemories=[];}
    if(listedSources.some(id=>!sourceIds.has(id)))throw failure("unknown_source_id");
    if(listedMemories.some(id=>!memories.has(id)))throw failure("unknown_memory_id");
    if(item.classification==="public_research"&&(!listedSources.length||listedMemories.length))throw failure("public_claim_unbound");
    if(["verified_memory","owner_claim"].includes(item.classification)&&(!listedMemories.length||listedSources.length))throw failure("memory_claim_unbound");
    if(item.classification==="verified_memory"&&listedMemories.some(id=>["hypothesis","unresolved_question"].includes(memories.get(id)?.evidenceType)))throw failure("unverified_memory_claim");
    if(item.classification==="owner_claim"&&listedMemories.some(id=>!["owner_claim","owner_preference","owner_decision"].includes(memories.get(id)?.evidenceType)))throw failure("owner_claim_misclassified");
    if(["inference","estimate"].includes(item.classification)&&!listedSources.length&&!listedMemories.length)throw failure("derived_claim_unbound");
    if(item.classification==="unknown"&&!explicitUncertainty(text))throw failure("unknown_claim_invalid");
    claims.push({text,classification:item.classification,sourceIds:listedSources,memoryIds:listedMemories});
  }
  for(const sentence of splitImportant(answer))if(!claims.some(claim=>relatedText(sentence,claim.text)))throw failure("important_claim_unmapped");
  return Object.freeze({answer,claims:Object.freeze(claims),providerUsage:generated.providerUsage||null,validatedAt:new Date().toISOString(),version:1});
}
