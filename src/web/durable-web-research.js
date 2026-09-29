import {createHash} from "node:crypto";

const TERMINAL=new Set(["completed","failed","blocked","cancelled","expired"]);
const MAX_REQUEST=12_000,MAX_RESEARCH_QUERY=500,MAX_RESULT_TEXT=100_000,MAX_PAGE_TEXT=20_000,MAX_RETAINED_SOURCES=12,MAX_RESEARCH_SECTIONS=4;
const digest=value=>createHash("sha256").update(String(value)).digest("hex");
const clean=(value,max=500)=>String(value||"").replace(/Bearer\s+\S+/gi,"Bearer [REDACTED]").replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,"[REDACTED]").replace(/\b(?:token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi,"$1=[REDACTED]").replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const taskIdFor=({ownerId,conversationId,request})=>`web_${digest(JSON.stringify([ownerId,conversationId,digest(request)])).slice(0,32)}`;
const attemptInput=attempt=>({id:attempt.id,taskId:attempt.taskId,handoffId:attempt.handoffId,workerId:attempt.workerId,generation:attempt.generation,fenceToken:attempt.fenceToken});

export function shouldUseDurableWebResearch(message,authority={}){
  if(authority.explicitBrowser||!authority.explicitResearch)return false;
  const value=String(message||""),lines=value.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const structured=lines.filter(line=>/^(?:part\s+\d+|\d+[.)]|[-*])\s*/i.test(line)).length;
  const dimensions=[/\bcompare\b/i,/\bpricing\b/i,/\bcompetitors?\b/i,/\bmarket\s+(?:gaps?|patterns?|analysis)\b/i,/\bfor each\b/i,/\b(?:5|five)\s+(?:alternatives?|providers?|systems?)\b/i].filter(pattern=>pattern.test(value)).length;
  return authority.explicitDeep===true||structured>=3||(value.length>=450&&dimensions>=3);
}

const sectionHeading=value=>/^(?:part\s+\d+\b|final output\b)/i.test(value);
const boilerplate=value=>/^(?:i want to test your|use whatever web capabilities|do not wait for me to tell you|complete all (?:three|\d+) parts|keep it practical|i want the research itself)/i.test(value);
const clipWords=(value,max)=>{if(value.length<=max)return value;const clipped=value.slice(0,max+1),boundary=clipped.lastIndexOf(" ");return (boundary>=Math.floor(max*.6)?clipped.slice(0,boundary):clipped.slice(0,max)).replace(/[\s;,:-]+$/g,"").replace(/\b(?:where|and|or|the|a|an)$/i,"").trim();};
const signalWords=new Set(["UK","United Kingdom","Fresha"]),signalStopWords=new Set(["AI","Actually","Any","Barber","Cheapest","Choose","Clearly","Clickable","Company","Current","Customer","FINAL","Find","For","Give","How","Important","Key","Main","Marketing","Missed-call","Online","PART","Payments","Pricing","Research","SMS","Staff","Tell","Then","Their","Use","Website","What","WhatsApp","Whether","Who"]);
const sectionSignals=clauses=>{
  const text=clauses.join(" "),signals=[];
  for(const match of text.matchAll(/https?:\/\/[^\s)]+/gi))if(!signals.includes(match[0]))signals.push(match[0]);
  for(const word of signalWords)if(new RegExp(`\\b${word.replace(" ","\\s+")}\\b`,"i").test(text)&&!signals.includes(word))signals.push(word);
  const count=text.match(/\b\d+\s+(?:strong\s+)?(?:booking systems?|competitors?|alternatives?|services?)\b/i);if(count)signals.push(count[0]);
  if(/\bpricing\b/i.test(text)&&/\bcommission\b/i.test(text))signals.push("pricing and commission");
  else if(/\bofficial website\b/i.test(text)&&/\bpricing(?:\/plans)? page\b/i.test(text))signals.push("official pricing page");
  if(/\bcheapest paid plan\b/i.test(text))signals.push("cheapest paid plan");
  if(/\bextra fees\b/i.test(text))signals.push("extra fees");
  if(/\b(?:AI|SMS|WhatsApp)\b/.test(text))signals.push("AI/SMS/WhatsApp");
  if(/\bnot publicly available\b/i.test(text))signals.push("not publicly available");
  if(/\bclickable evidence\b/i.test(text))signals.push("clickable evidence");
  for(const match of text.matchAll(/\b[A-Z][A-Za-z0-9.-]{2,}\b/g))if(!signalStopWords.has(match[0])&&!signals.includes(match[0]))signals.push(match[0]);
  return [...new Set(signals)].slice(0,4);
};
const clauseScore=value=>{
  let score=0;
  if(/https?:\/\/|\b[a-z0-9-]+\.(?:com|co\.uk|org|net|io|ai|dev)\b/i.test(value))score+=120;
  if(/\b(?:UK|United Kingdom)\b/i.test(value))score+=60;
  if(/\b(?:find|research|navigate|inspect|compare|pricing|plans?|competitors?|alternatives?|barbers?|salons?|missed[- ]calls?|recovery)\b/i.test(value))score+=45;
  if(/\b(?:official|current|real websites?|do not invent|not publicly available|limitations?|commission|payments?|reminders?|staff|marketing)\b/i.test(value))score+=25;
  if(/\b(?:Fresha|WhatsApp|SMS|AI)\b/.test(value))score+=20;
  return score;
};

export function researchQuery(request){
  const full=clean(request,MAX_REQUEST);
  if(!full)return"Public market research with current sources";
  if(full.length<=MAX_RESEARCH_QUERY)return full;
  const rawLines=String(request||"").split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
  const sections=[];let current={heading:null,clauses:[]};
  const push=()=>{if(current.heading||current.clauses.length)sections.push(current);current={heading:null,clauses:[]};};
  for(const raw of rawLines){
    const line=clean(raw,300);if(!line)continue;
    if(sectionHeading(line)){push();current.heading=line;continue;}
    for(const part of raw.split(/(?<=[.!?])\s+/)){
      const clause=clean(part.replace(/^(?:\d+[.)]|[-*])\s*/i,""),240);
      if(clause.length>3&&!boilerplate(clause)&&!current.clauses.includes(clause))current.clauses.push(clause);
    }
  }
  push();
  const headed=sections.filter(section=>section.heading);
  if(headed.length){
    const ranked=headed.map(section=>({...section,ranked:section.clauses.map((value,index)=>({value,index,score:clauseScore(value)})).sort((a,b)=>b.score-a.score||a.index-b.index)}));
    const separator=" | ",available=MAX_RESEARCH_QUERY-separator.length*(ranked.length-1),share=Math.floor(available/ranked.length);
    const segments=ranked.map(section=>{const signals=sectionSignals(section.clauses),context=signals.length?signals.join(", "):null,primary=section.ranked[0]?.value;return clipWords(`${section.heading}${context||primary?`: ${[context,primary].filter(Boolean).join("; ")}`:""}`,share);});
    let query=segments.join(separator);
    for(let round=1;;round+=1){
      let added=false;
      for(let index=0;index<ranked.length;index+=1){
        const clause=ranked[index].ranked[round]?.value;if(!clause)continue;
        const candidate=`${query}; ${clause}`;
        if(candidate.length<=MAX_RESEARCH_QUERY){query=candidate;added=true;}
      }
      if(!added)break;
    }
    return query;
  }
  const clauses=sections.flatMap(section=>section.clauses).map((value,index)=>({value,index,score:clauseScore(value)})).sort((a,b)=>b.score-a.score||a.index-b.index);
  const selected=[];for(const item of clauses){const candidate=[...selected,item.value].join("; ");if(candidate.length<=MAX_RESEARCH_QUERY)selected.push(item.value);}
  return selected.join("; ")||clipWords(full,MAX_RESEARCH_QUERY);
}
export function researchSections(request){
  const lines=String(request||"").split(/\r?\n/).map(value=>value.trim()).filter(Boolean),sections=[];let current=null;
  const push=()=>{if(current?.heading&&current.lines.length)sections.push(current);current=null;};
  for(const raw of lines){
    const line=clean(raw,300);if(!line)continue;
    if(/^part\s+\d+\b/i.test(line)){push();current={heading:line,lines:[]};continue;}
    if(/^final output\b/i.test(line)){push();break;}
    if(current&&!boilerplate(line))current.lines.push(line);
  }
  push();
  const bounded=sections.slice(0,MAX_RESEARCH_SECTIONS).map((section,index)=>{
    const text=`${section.heading}\n${section.lines.join("\n")}`,count=text.match(/\b(\d+)\s+(?:(?:strong|real)\s+)?(?:booking systems?|competitors?|alternatives?|services?)\b/i),pricing=/\b(?:official website|pricing(?:\/plans)? page|cheapest paid plan)\b/i.test(text),requiredSources=Math.min(5,Math.max(1,count?Number(count[1]):pricing?1:1));
    const requirement=`Return at least ${requiredSources} distinct, verifiable HTTPS source${requiredSources===1?"":"s"}${pricing?" including the official pricing page":""}.`,base=researchQuery(text),detail=base.toLowerCase().startsWith(section.heading.toLowerCase())?base.slice(section.heading.length).replace(/^\s*[:.-]?\s*/,""):base,query=clipWords(`${section.heading}. ${requirement} ${detail}`,MAX_RESEARCH_QUERY);
    return Object.freeze({id:`section_${index+1}`,heading:clean(section.heading,120),query,requiredSources,input:Object.freeze({query,purpose:pricing?"pricing":/\b(?:competitor|alternative|market|booking systems?)\b/i.test(text)?"competitor_research":"general",freshnessDays:30,maxSources:Math.max(1,requiredSources),depth:"deep",readMode:pricing?"required":"auto",urls:[]})});
  });
  if(bounded.length)return bounded;
  const query=researchQuery(request);return[Object.freeze({id:"section_1",heading:"Research request",query,requiredSources:1,input:Object.freeze({query,purpose:/\b(?:competitor|alternative|market)\b/i.test(request)?"competitor_research":"general",freshnessDays:30,maxSources:8,depth:"deep",readMode:"auto",urls:[]})})];
}
function canonicalResult(value){
  const sources=(Array.isArray(value?.sources)?value.sources:[]).slice(0,8).map(source=>({sourceId:clean(source.sourceId,80),title:clean(source.title,200),url:clean(source.url,1200),domain:clean(source.domain,253),retrievedAt:clean(source.retrievedAt,80),contentHash:/^[a-f0-9]{64}$/.test(source.contentHash||"")?source.contentHash:null}));
  let remaining=MAX_RESULT_TEXT;
  const pages=(Array.isArray(value?.pages)?value.pages:[]).slice(0,8).map(page=>{const text=clean(page.text,Math.min(MAX_PAGE_TEXT,remaining));remaining-=text.length;return{status:clean(page.status,40),url:clean(page.url,1200),domain:clean(page.domain,253),title:clean(page.title,200),text,contentHash:/^[a-f0-9]{64}$/.test(page.contentHash||"")?page.contentHash:null,retrievedAt:clean(page.retrievedAt,80),limitation:clean(page.limitation,100)||null,rendered:page.rendered===true};});
  return{version:1,researchId:clean(value?.researchId,100),query:clean(value?.query,500),purpose:clean(value?.purpose,80),performedAt:clean(value?.performedAt,80),summary:clean(value?.summary,20_000),sources,pages,actions:Array.isArray(value?.actions)?value.actions.slice(0,12):[],limitations:Array.isArray(value?.limitations)?value.limitations.slice(0,12):[],usage:value?.usage||null,...(value?.durableTask?{durableTask:{id:clean(value.durableTask.id,100),status:clean(value.durableTask.status,40)}}:{})};
}
function mergeResearchResults(entries){
  const sourceByUrl=new Map(),pageByUrl=new Map(),actions=[],limitations=[],summaries=[],usages=[];
  for(const entry of entries||[]){const result=entry?.result;if(!result)continue;if(result.summary)summaries.push(`${entry.heading}: ${result.summary}`);for(const source of result.sources||[])if(!sourceByUrl.has(source.url)&&sourceByUrl.size<MAX_RETAINED_SOURCES)sourceByUrl.set(source.url,source);for(const page of result.pages||[])if(!pageByUrl.has(page.url)&&pageByUrl.size<MAX_RESEARCH_SECTIONS*8)pageByUrl.set(page.url,page);actions.push(...(result.actions||[]));limitations.push(...(result.limitations||[]));if(result.usage)usages.push(result.usage);}
  const sources=[...sourceByUrl.values()].map((source,index)=>({...source,sourceId:`source_${index+1}`}));return{version:1,researchId:`web_${digest(entries?.map(entry=>entry?.result?.researchId||entry?.id).join(":")) .slice(0,32)}`,query:(entries||[]).map(entry=>entry.query).join(" | ").slice(0,MAX_RESEARCH_QUERY),purpose:"competitor_research",performedAt:(entries||[]).map(entry=>entry?.result?.performedAt).filter(Boolean).at(-1)||null,summary:summaries.join("\n\n").slice(0,20_000),sources,pages:[...pageByUrl.values()],actions:actions.slice(0,MAX_RESEARCH_SECTIONS*12),limitations:limitations.slice(0,MAX_RESEARCH_SECTIONS*12),usage:{sections:usages}};
}
function withBrowserEvidence(result,browser){
  if(browser?.status!=="completed")return result;const source={sourceId:`source_${(result.sources||[]).length+1}`,title:clean(browser.title||browser.domain,200),url:browser.finalUrl,domain:browser.domain,retrievedAt:browser.retrievedAt,contentHash:browser.contentHash},sources=[...(result.sources||[])];if(!sources.some(item=>item.url===source.url))sources.push(source);const pages=[...(result.pages||[])];if(!pages.some(item=>item.url===browser.finalUrl))pages.push({status:"completed",url:browser.finalUrl,domain:browser.domain,title:browser.title,text:clean(browser.text,MAX_PAGE_TEXT),contentHash:browser.contentHash,retrievedAt:browser.retrievedAt,limitation:null,rendered:true});return{...result,sources:sources.slice(0,8),pages:pages.slice(0,8)};
}
function trustedSources(result){
  const sources=[];
  for(const source of result?.sources||[]){let url;try{url=new URL(source.url);}catch{continue;}if(url.protocol!=="https:"||url.username||url.password)continue;const title=clean(source.title||url.hostname,200).replace(/[\[\]\r\n]/g," ");sources.push({title:title||url.hostname,url:url.href});}
  return sources.slice(0,MAX_RETAINED_SOURCES);
}
function bindCitations(message,result){
  const sources=trustedSources(result),allowed=new Set(sources.map(source=>source.url));
  const safe=String(message||"").replace(/\[([^\]\r\n]{1,300})\]\((https:\/\/[^)\s]+)\)/g,(match,label,url)=>{try{return allowed.has(new URL(url).href)?match:label;}catch{return label;}}).trim();
  return `${safe}\n\nSources:\n${sources.map(source=>`- [${source.title}](${source.url})`).join("\n")}`.trim().slice(0,20_000);
}
function evidenceContext(result){
  return JSON.stringify({summary:result.summary,sources:trustedSources(result),pages:(result.pages||[]).map(page=>({url:page.url,title:page.title,text:page.text,limitation:page.limitation})),limitations:result.limitations}).slice(0,120_000);
}

export function createDurableWebResearchService({storage,ownerId,webGateway,modelProvider,executionTruth,clock=()=>new Date()}={}){
  if(!storage||!ownerId||!webGateway||!modelProvider||!executionTruth)throw new Error("Durable Web research dependencies are required.");
  const update=async(task,patch)=>{const updated=await storage.updateAutonomyTask(task.id,ownerId,patch,task.stateVersion);if(!updated)throw Object.assign(new Error("Durable Web research was fenced."),{code:"web_research_task_fenced"});return updated;};
  const activity=(task,action,status,summary,metadata={})=>storage.appendActivity({ownerId,projectId:task.projectId,runId:task.id,action,tool:"web_research",status,summary,metadata:{taskId:task.id,...metadata}});
  async function prepare({request,conversationId,runId,projectId=null,webAuthority}={}){
    request=String(request||"").trim().slice(0,MAX_REQUEST);if(!request||!conversationId||!runId)throw Object.assign(new Error("Durable Web research origin binding is invalid."),{code:"web_research_task_invalid"});
    const taskId=taskIdFor({ownerId,conversationId,request}),existing=await storage.getAutonomyTask(taskId,ownerId);
    if(existing){if(!await storage.getRun(taskId,ownerId))throw Object.assign(new Error("Durable Web research is missing its task-owned run."),{code:"web_research_task_persistence_invalid"});return{task:existing,idempotent:true};}
    const sections=researchSections(request).map(section=>({...section,input:{...section.input,allowedDomains:[...(webAuthority?.ownerDomains||[])]}})),canonical={version:2,request,requestHash:digest(request),query:researchQuery(request),sections,webAuthority:{autonomousDeep:true,explicitDeep:true,explicitBrowser:false,explicitResearch:true,ownerDomains:[...(webAuthority?.ownerDomains||[])],ownerUrls:[],navigation:null,presentation:{version:1,requestedFields:[]}}};
    try{const prepared=await storage.prepareAutonomyTaskBundle({task:{id:taskId,ownerId,projectId,title:"Public Web research",objective:clean(request,500),taskType:"public_web_research",maxSteps:sections.length+1,maxRetries:0,maxRuntimeMinutes:30,metadata:{requiredCapability:"remote_public_research",researchJob:canonical,researchState:{version:2,phase:"research_queued",sectionIndex:0},researchSectionResults:[],terminalReporting:{version:1,conversationId,runId},originatingRequest:{conversationId,runId,requestHash:canonical.requestHash}}},run:{id:taskId,ownerId,projectId,conversationId,goal:request,status:"queued"},step:{taskId,stepId:"1:public_web_research",stepType:"public_web_research",capability:"remote_public_research",operationFingerprint:digest(JSON.stringify(sections[0])),status:"queued",input:{requestHash:canonical.requestHash,depth:"deep",sectionId:sections[0].id}},activity:{ownerId,projectId,runId:taskId,action:"web_research_task_queued",tool:"web_research",status:"queued",summary:"Queued durable public Web research before provider contact.",metadata:{taskId,originatingRunId:runId,requestHash:canonical.requestHash,sectionCount:sections.length}}});return{task:prepared.task,idempotent:false};}
    catch(error){if(!["23505","autonomy_task_preparation_conflict"].includes(error?.code))throw error;const raced=await storage.getAutonomyTask(taskId,ownerId),racedRun=await storage.getRun(taskId,ownerId);if(!raced||!racedRun)throw error;return{task:raced,idempotent:true};}
  }
  async function terminalFailure(task,attempt,stepId,error){
    const code=clean(error?.code,100)||"web_research_failed",reason=clean(error?.message,500)||"Durable Web research failed safely.";
    await storage.updateAutonomyStep(task.id,stepId,{status:"failed",errorCode:code,completedAt:clock().toISOString(),result:{status:"failed",code,reason}}).catch(()=>{});
    const live=await storage.getAutonomyTask(task.id,ownerId),failed=TERMINAL.has(live?.status)?live:await update(live,{status:"failed",currentPhase:"failed",completedAt:clock().toISOString(),errorCode:code,blockedReason:reason,leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...live.metadata,localHandoff:null,researchState:{...live.metadata.researchState,phase:"failed",errorCode:code}}});
    if(attempt)await executionTruth.finish(attemptInput(attempt),{status:"failed",reason:code}).catch(()=>{});await storage.updateRun(task.id,ownerId,{status:"failed",result:{errorCode:code},completedAt:clock().toISOString()}).catch(()=>{});await activity(failed,"web_research_failed","failed",reason,{errorCode:code});return{task:failed,result:null,idempotent:false,error};
  }
  async function checkpointSection(task,job,sections,sectionIndex,result,{browserTaskId=null}={}){
    const section=sections[sectionIndex],entries=[...(task.metadata?.researchSectionResults||[])],sourceCount=result.sources?.length||0,entry={id:section.id,heading:section.heading,query:section.query,requiredSources:section.requiredSources,sourceCount,complete:sourceCount>=section.requiredSources,result};entries[sectionIndex]=entry;
    const nextIndex=sectionIndex+1,finished=nextIndex>=sections.length,merged=mergeResearchResults(entries),browserTaskIds=[...(task.metadata?.researchState?.browserTaskIds||[])];if(browserTaskId&&!browserTaskIds.includes(browserTaskId))browserTaskIds.push(browserTaskId);
    const updated=await update(await storage.getAutonomyTask(task.id,ownerId),{status:"queued",currentPhase:finished?"research_completed":"research_section_completed",currentStep:nextIndex,nextRunAt:clock().toISOString(),leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,researchResult:merged,researchSectionResults:entries,researchState:{version:job.version===2?2:1,phase:finished?"research_completed":"research_queued",sectionIndex:nextIndex,browserTaskIds}}});
    await activity(updated,"web_research_section_checkpointed","completed",`${section.heading} evidence checkpoint persisted.`,{sectionId:section.id,sectionIndex,sourceCount,requiredSources:section.requiredSources,complete:entry.complete,browserTaskId});return updated;
  }
  async function executeTask(taskId,{coordinatorId="persistent-web-research",expectedVersion,signal}={}){
    let task=await storage.getAutonomyTask(taskId,ownerId);if(!task||task.taskType!=="public_web_research"||task.metadata?.requiredCapability!=="remote_public_research")throw Object.assign(new Error("Durable Web research is unavailable."),{code:"web_research_task_invalid"});
    if(!await storage.getRun(taskId,ownerId))throw Object.assign(new Error("Durable Web research is missing its task-owned run."),{code:"web_research_task_persistence_invalid"});if(TERMINAL.has(task.status))return{task,result:task.metadata?.researchResult||null,idempotent:true};if(expectedVersion!==undefined&&task.stateVersion!==expectedVersion)throw Object.assign(new Error("Durable Web research version changed."),{code:"web_research_task_fenced"});
    const state=task.metadata?.researchState||{},job=task.metadata?.researchJob;if(![1,2].includes(job?.version))throw Object.assign(new Error("Durable Web research specification is invalid."),{code:"web_research_task_invalid"});
    const sections=job.version===2&&Array.isArray(job.sections)&&job.sections.length?job.sections:[{id:"section_1",heading:"Research request",query:job.query,requiredSources:1,input:job.input}],sectionIndex=Number.isInteger(state.sectionIndex)?state.sectionIndex:0,synthesis=state.phase==="research_completed",stepId=synthesis?`${sections.length+1}:research_synthesis`:`${sectionIndex+1}:public_web_research`,stepType=synthesis?"research_synthesis":"public_web_research";
    if(state.providerBoundary?.status==="in_flight")return terminalFailure(task,null,stepId,Object.assign(new Error("A prior provider boundary is uncertain and will not be replayed."),{code:"web_provider_boundary_uncertain"}));
    if(state.phase==="waiting_for_browser"){
      const child=state.browserTaskId&&await storage.getAutonomyTask(state.browserTaskId,ownerId);if(!child||!TERMINAL.has(child.status)){task=await update(task,{status:"waiting",currentPhase:"waiting_for_browser",nextRunAt:new Date(clock().getTime()+5000).toISOString(),leaseOwner:null,leaseToken:null,leaseExpiresAt:null});return{task,result:null,idempotent:false};}
      const result=withBrowserEvidence(state.pendingSectionResult,child.metadata?.browserResult);task=await checkpointSection(task,job,sections,sectionIndex,result,{browserTaskId:child.id});return{task,result,idempotent:false};
    }
    const steps=await storage.listAutonomySteps(taskId);if(!steps.some(step=>step.stepId===stepId)){const section=sections[sectionIndex];await storage.recordAutonomyStep({taskId,stepId,stepType,capability:"remote_public_research",operationFingerprint:digest(synthesis?`${taskId}:synthesis:${job.requestHash}`:JSON.stringify(section)),status:"queued",input:{requestHash:job.requestHash,...(!synthesis?{sectionId:section.id,requiredSources:section.requiredSources}:{})}});}
    const claimed=await storage.claimAutonomyTask({ownerId,workerId:coordinatorId,capabilities:["remote_public_research"],leaseMs:300000,idempotencyKey:`research:${taskId}:${task.stateVersion}`,taskId,expectedVersion:task.stateVersion,claimMetadata:{researchExecution:{version:job.version,phase:stepType,...(!synthesis?{sectionId:sections[sectionIndex].id}:{})}}});if(!claimed)throw Object.assign(new Error("Durable Web research could not be claimed."),{code:"web_research_task_claim_failed"});
    task=claimed;const handoff={id:`research_handoff_${digest(`${taskId}:${task.stateVersion}:${stepId}`).slice(0,24)}`,stepId,stepType};task=await update(task,{status:"running",currentPhase:synthesis?"synthesizing":`researching_section_${sectionIndex+1}`,metadata:{...task.metadata,localHandoff:handoff,researchState:{...state,phase:synthesis?"synthesis_in_flight":"research_in_flight",sectionIndex,providerBoundary:{phase:stepType,status:"in_flight",startedAt:clock().toISOString(),...(!synthesis?{sectionId:sections[sectionIndex].id}:{})}}}});const attempt=await executionTruth.start({task,handoff,workerId:coordinatorId});await storage.updateAutonomyStep(taskId,stepId,{status:"running",startedAt:clock().toISOString()});
    const executionController=new AbortController(),cancel=()=>executionController.abort(signal?.reason instanceof Error?signal.reason:new DOMException("Durable Web research cancelled.","AbortError"));let heartbeatFailure=null;signal?.addEventListener?.("abort",cancel,{once:true});const heartbeatTimer=setInterval(()=>{void (async()=>{const live=await storage.getAutonomyTask(taskId,ownerId);if(live?.status==="cancelled")return cancel();await executionTruth.heartbeat(attemptInput(attempt),{phase:synthesis?"synthesizing":"researching",executorStarted:true,progress:false});})().catch(error=>{heartbeatFailure=error;cancel();});},15000);heartbeatTimer.unref?.();
    try{
      await executionTruth.heartbeat(attemptInput(attempt),{phase:synthesis?"synthesizing":"researching",executorStarted:true,progress:true});if(signal?.aborted)cancel();executionController.signal.throwIfAborted();
      if(!synthesis){const section=sections[sectionIndex],result=canonicalResult(await webGateway.research(section.input,{runId:task.id,conversationId:task.metadata.terminalReporting.conversationId,projectId:task.projectId,durableResearchTaskId:task.id,signal:executionController.signal,webAuthority:job.webAuthority,webUsage:{calls:0},taskId:task.id}));if(heartbeatFailure)throw heartbeatFailure;await storage.updateAutonomyStep(taskId,stepId,{status:"completed",completedAt:clock().toISOString(),result:{researchId:result.researchId,sectionId:section.id,sourceCount:result.sources.length,requiredSources:section.requiredSources,usage:result.usage}});await executionTruth.finish(attemptInput(attempt),{status:"completed",reason:"research_section_completed"});const childId=result.durableTask?.id,child=childId&&await storage.getAutonomyTask(childId,ownerId),waiting=child&&!TERMINAL.has(child.status);if(waiting){task=await update(await storage.getAutonomyTask(taskId,ownerId),{status:"waiting",currentPhase:"waiting_for_browser",currentStep:sectionIndex+1,nextRunAt:new Date(clock().getTime()+5000).toISOString(),leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,researchState:{version:job.version,phase:"waiting_for_browser",sectionIndex,browserTaskId:childId,browserTaskIds:[...(state.browserTaskIds||[]),childId],pendingSectionResult:result}}});await activity(task,"web_research_checkpointed","completed","Section evidence checkpoint persisted; waiting for the bounded browser child.",{sectionId:section.id,sourceCount:result.sources.length,browserTaskId:childId});return{task,result,idempotent:false};}task=await checkpointSection(task,job,sections,sectionIndex,result);return{task,result,idempotent:false};}
      const result=task.metadata.researchResult,coverage=(task.metadata.researchSectionResults||[]).map(entry=>({id:entry.id,heading:entry.heading,sourceCount:entry.sourceCount,requiredSources:entry.requiredSources,complete:entry.complete})),generated=await modelProvider.generate({message:job.request,conversationHistory:[],context:{},tools:[],systemContext:`Produce the concise final answer requested by the owner using only this server-retained public evidence. Cite only URLs present in the evidence. Do not invent facts, prices, features, or URLs. Cover every research section whose completeness record is true. If a section is incomplete, name that exact unsupported section and its evidence shortfall truthfully.\n\nSECTION COMPLETENESS JSON:\n${JSON.stringify(coverage)}\n\nEVIDENCE JSON:\n${evidenceContext(result)}`,signal:executionController.signal,stage:"chat",costContext:{taskId,runId:taskId}});if(heartbeatFailure)throw heartbeatFailure;if(generated?.type!=="final")throw Object.assign(new Error("Research synthesis returned an invalid result."),{code:"web_research_synthesis_invalid"});const finalAnswer=bindCitations(generated.message,result);await storage.updateAutonomyStep(taskId,stepId,{status:"completed",completedAt:clock().toISOString(),result:{status:"completed",sourceCount:result.sources.length,coverage,providerUsage:generated.providerUsage||null}});await executionTruth.finish(attemptInput(attempt),{status:"completed",reason:"research_completed"});task=await update(await storage.getAutonomyTask(taskId,ownerId),{status:"completed",currentPhase:"completed",currentStep:sections.length+1,completedAt:clock().toISOString(),resultSummary:"Completed durable public Web research.",leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,researchFinalAnswer:finalAnswer,researchState:{version:job.version,phase:"completed",sectionIndex:sections.length,coverage}}});await storage.updateRun(taskId,ownerId,{status:"completed",currentStep:sections.length+1,result:{message:finalAnswer,durableTask:{id:taskId,status:"completed"},coverage,providerUsage:[generated.providerUsage].filter(Boolean)},completedAt:clock().toISOString()});await activity(task,"web_research_completed","completed","Completed durable public Web research.",{sourceCount:result.sources.length,coverage});return{task,result:{finalAnswer,sources:result.sources,coverage},idempotent:false};
    }catch(error){return terminalFailure(await storage.getAutonomyTask(taskId,ownerId),attempt,stepId,error);}
    finally{clearInterval(heartbeatTimer);signal?.removeEventListener?.("abort",cancel);}
  }
  return Object.freeze({prepare,executeTask});
}
