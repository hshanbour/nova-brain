import {createHash} from "node:crypto";

const TERMINAL=new Set(["completed","failed","blocked","cancelled","expired"]);
const MAX_REQUEST=12_000,MAX_RESEARCH_QUERY=500,MAX_RESULT_TEXT=100_000,MAX_PAGE_TEXT=20_000;
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
const clipWords=(value,max)=>{if(value.length<=max)return value;const clipped=value.slice(0,max+1),boundary=clipped.lastIndexOf(" ");return (boundary>=Math.floor(max*.6)?clipped.slice(0,boundary):clipped.slice(0,max)).replace(/[\s;,:-]+$/g,"");};
const signalWords=new Set(["UK","United Kingdom","Fresha"]),signalStopWords=new Set(["AI","Actually","Any","Barber","Cheapest","Choose","Clickable","Company","Current","Customer","FINAL","Find","For","Give","How","Important","Key","Main","Marketing","Missed-call","Online","PART","Payments","Pricing","Research","SMS","Staff","Tell","Then","Their","Use","Website","What","WhatsApp","Whether","Who"]);
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
function canonicalResult(value){
  const sources=(Array.isArray(value?.sources)?value.sources:[]).slice(0,8).map(source=>({sourceId:clean(source.sourceId,80),title:clean(source.title,200),url:clean(source.url,1200),domain:clean(source.domain,253),retrievedAt:clean(source.retrievedAt,80),contentHash:/^[a-f0-9]{64}$/.test(source.contentHash||"")?source.contentHash:null}));
  let remaining=MAX_RESULT_TEXT;
  const pages=(Array.isArray(value?.pages)?value.pages:[]).slice(0,8).map(page=>{const text=clean(page.text,Math.min(MAX_PAGE_TEXT,remaining));remaining-=text.length;return{status:clean(page.status,40),url:clean(page.url,1200),domain:clean(page.domain,253),title:clean(page.title,200),text,contentHash:/^[a-f0-9]{64}$/.test(page.contentHash||"")?page.contentHash:null,retrievedAt:clean(page.retrievedAt,80),limitation:clean(page.limitation,100)||null,rendered:page.rendered===true};});
  return{version:1,researchId:clean(value?.researchId,100),query:clean(value?.query,500),purpose:clean(value?.purpose,80),performedAt:clean(value?.performedAt,80),summary:clean(value?.summary,20_000),sources,pages,actions:Array.isArray(value?.actions)?value.actions.slice(0,12):[],limitations:Array.isArray(value?.limitations)?value.limitations.slice(0,12):[],usage:value?.usage||null,...(value?.durableTask?{durableTask:{id:clean(value.durableTask.id,100),status:clean(value.durableTask.status,40)}}:{})};
}
function trustedSources(result){
  const sources=[];
  for(const source of result?.sources||[]){let url;try{url=new URL(source.url);}catch{continue;}if(url.protocol!=="https:"||url.username||url.password)continue;const title=clean(source.title||url.hostname,200).replace(/[\[\]\r\n]/g," ");sources.push({title:title||url.hostname,url:url.href});}
  return sources.slice(0,8);
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
    const canonical={version:1,request,requestHash:digest(request),query:researchQuery(request),input:{query:researchQuery(request),purpose:/\b(?:competitor|alternative|market)\b/i.test(request)?"competitor_research":"general",allowedDomains:[...(webAuthority?.ownerDomains||[])],freshnessDays:30,maxSources:8,depth:"deep",readMode:"auto",urls:[]},webAuthority:{autonomousDeep:true,explicitDeep:true,explicitBrowser:false,explicitResearch:true,ownerDomains:[...(webAuthority?.ownerDomains||[])],ownerUrls:[],navigation:null,presentation:{version:1,requestedFields:[]}}};
    try{const prepared=await storage.prepareAutonomyTaskBundle({task:{id:taskId,ownerId,projectId,title:"Public Web research",objective:clean(request,500),taskType:"public_web_research",maxSteps:2,maxRetries:0,maxRuntimeMinutes:30,metadata:{requiredCapability:"remote_public_research",researchJob:canonical,researchState:{version:1,phase:"research_queued"},terminalReporting:{version:1,conversationId,runId},originatingRequest:{conversationId,runId,requestHash:canonical.requestHash}}},run:{id:taskId,ownerId,projectId,conversationId,goal:request,status:"queued"},step:{taskId,stepId:"1:public_web_research",stepType:"public_web_research",capability:"remote_public_research",operationFingerprint:digest(JSON.stringify(canonical)),status:"queued",input:{requestHash:canonical.requestHash,depth:"deep"}},activity:{ownerId,projectId,runId:taskId,action:"web_research_task_queued",tool:"web_research",status:"queued",summary:"Queued durable public Web research before provider contact.",metadata:{taskId,originatingRunId:runId,requestHash:canonical.requestHash}}});return{task:prepared.task,idempotent:false};}
    catch(error){if(!["23505","autonomy_task_preparation_conflict"].includes(error?.code))throw error;const raced=await storage.getAutonomyTask(taskId,ownerId),racedRun=await storage.getRun(taskId,ownerId);if(!raced||!racedRun)throw error;return{task:raced,idempotent:true};}
  }
  async function terminalFailure(task,attempt,stepId,error){
    const code=clean(error?.code,100)||"web_research_failed",reason=clean(error?.message,500)||"Durable Web research failed safely.";
    await storage.updateAutonomyStep(task.id,stepId,{status:"failed",errorCode:code,completedAt:clock().toISOString(),result:{status:"failed",code,reason}}).catch(()=>{});
    const live=await storage.getAutonomyTask(task.id,ownerId),failed=TERMINAL.has(live?.status)?live:await update(live,{status:"failed",currentPhase:"failed",completedAt:clock().toISOString(),errorCode:code,blockedReason:reason,leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...live.metadata,localHandoff:null,researchState:{...live.metadata.researchState,phase:"failed",errorCode:code}}});
    if(attempt)await executionTruth.finish(attemptInput(attempt),{status:"failed",reason:code}).catch(()=>{});await storage.updateRun(task.id,ownerId,{status:"failed",result:{errorCode:code},completedAt:clock().toISOString()}).catch(()=>{});await activity(failed,"web_research_failed","failed",reason,{errorCode:code});return{task:failed,result:null,idempotent:false,error};
  }
  async function executeTask(taskId,{coordinatorId="persistent-web-research",expectedVersion,signal}={}){
    let task=await storage.getAutonomyTask(taskId,ownerId);if(!task||task.taskType!=="public_web_research"||task.metadata?.requiredCapability!=="remote_public_research")throw Object.assign(new Error("Durable Web research is unavailable."),{code:"web_research_task_invalid"});
    if(!await storage.getRun(taskId,ownerId))throw Object.assign(new Error("Durable Web research is missing its task-owned run."),{code:"web_research_task_persistence_invalid"});if(TERMINAL.has(task.status))return{task,result:task.metadata?.researchResult||null,idempotent:true};if(expectedVersion!==undefined&&task.stateVersion!==expectedVersion)throw Object.assign(new Error("Durable Web research version changed."),{code:"web_research_task_fenced"});
    const state=task.metadata?.researchState||{},job=task.metadata?.researchJob;if(job?.version!==1)throw Object.assign(new Error("Durable Web research specification is invalid."),{code:"web_research_task_invalid"});
    if(state.providerBoundary?.status==="in_flight")return terminalFailure(task,null,state.phase==="synthesis_in_flight"?"2:research_synthesis":"1:public_web_research",Object.assign(new Error("A prior provider boundary is uncertain and will not be replayed."),{code:"web_provider_boundary_uncertain"}));
    if(state.phase==="waiting_for_browser"){
      const child=state.browserTaskId&&await storage.getAutonomyTask(state.browserTaskId,ownerId);if(!child||!TERMINAL.has(child.status)){task=await update(task,{status:"waiting",currentPhase:"waiting_for_browser",nextRunAt:new Date(clock().getTime()+5000).toISOString(),leaseOwner:null,leaseToken:null,leaseExpiresAt:null});return{task,result:null,idempotent:false};}
      const browser=child.metadata?.browserResult,result={...task.metadata.researchResult};if(browser?.status==="completed"){const source={sourceId:`source_${(result.sources||[]).length+1}`,title:clean(browser.title||browser.domain,200),url:browser.finalUrl,domain:browser.domain,retrievedAt:browser.retrievedAt,contentHash:browser.contentHash};result.sources=[...(result.sources||[]),source].slice(0,8);result.pages=[...(result.pages||[]),{status:"completed",url:browser.finalUrl,domain:browser.domain,title:browser.title,text:clean(browser.text,MAX_PAGE_TEXT),contentHash:browser.contentHash,retrievedAt:browser.retrievedAt,limitation:null,rendered:true}].slice(0,8);}task=await update(task,{status:"queued",currentPhase:"research_completed",nextRunAt:clock().toISOString(),metadata:{...task.metadata,researchResult:result,researchState:{version:1,phase:"research_completed",browserTaskId:child.id}}});return{task,result,idempotent:false};
    }
    const synthesis=state.phase==="research_completed";const stepId=synthesis?"2:research_synthesis":"1:public_web_research",stepType=synthesis?"research_synthesis":"public_web_research";
    if(synthesis&&!(await storage.listAutonomySteps(taskId)).some(step=>step.stepId===stepId))await storage.recordAutonomyStep({taskId,stepId,stepType,capability:"remote_public_research",operationFingerprint:digest(`${taskId}:synthesis:${job.requestHash}`),status:"queued",input:{requestHash:job.requestHash}});
    const claimed=await storage.claimAutonomyTask({ownerId,workerId:coordinatorId,capabilities:["remote_public_research"],leaseMs:300000,idempotencyKey:`research:${taskId}:${task.stateVersion}`,taskId,expectedVersion:task.stateVersion,claimMetadata:{researchExecution:{version:1,phase:stepType}}});if(!claimed)throw Object.assign(new Error("Durable Web research could not be claimed."),{code:"web_research_task_claim_failed"});
    task=claimed;const handoff={id:`research_handoff_${digest(`${taskId}:${task.stateVersion}:${stepId}`).slice(0,24)}`,stepId,stepType};task=await update(task,{status:"running",currentPhase:synthesis?"synthesizing":"researching",metadata:{...task.metadata,localHandoff:handoff,researchState:{...state,phase:synthesis?"synthesis_in_flight":"research_in_flight",providerBoundary:{phase:stepType,status:"in_flight",startedAt:clock().toISOString()}}}});const attempt=await executionTruth.start({task,handoff,workerId:coordinatorId});await storage.updateAutonomyStep(taskId,stepId,{status:"running",startedAt:clock().toISOString()});
    const executionController=new AbortController(),cancel=()=>executionController.abort(signal?.reason instanceof Error?signal.reason:new DOMException("Durable Web research cancelled.","AbortError"));let heartbeatFailure=null;signal?.addEventListener?.("abort",cancel,{once:true});const heartbeatTimer=setInterval(()=>{void (async()=>{const live=await storage.getAutonomyTask(taskId,ownerId);if(live?.status==="cancelled")return cancel();await executionTruth.heartbeat(attemptInput(attempt),{phase:synthesis?"synthesizing":"researching",executorStarted:true,progress:false});})().catch(error=>{heartbeatFailure=error;cancel();});},15000);heartbeatTimer.unref?.();
    try{
      await executionTruth.heartbeat(attemptInput(attempt),{phase:synthesis?"synthesizing":"researching",executorStarted:true,progress:true});if(signal?.aborted)cancel();executionController.signal.throwIfAborted();
      if(!synthesis){const result=canonicalResult(await webGateway.research(job.input,{runId:task.id,conversationId:task.metadata.terminalReporting.conversationId,projectId:task.projectId,durableResearchTaskId:task.id,signal:executionController.signal,webAuthority:job.webAuthority,webUsage:{calls:0}}));if(heartbeatFailure)throw heartbeatFailure;await storage.updateAutonomyStep(taskId,stepId,{status:"completed",completedAt:clock().toISOString(),result:{researchId:result.researchId,sourceCount:result.sources.length,usage:result.usage}});await executionTruth.finish(attemptInput(attempt),{status:"completed",reason:"research_phase_completed"});const childId=result.durableTask?.id,child=childId&&await storage.getAutonomyTask(childId,ownerId),waiting=child&&!TERMINAL.has(child.status);task=await update(await storage.getAutonomyTask(taskId,ownerId),{status:waiting?"waiting":"queued",currentPhase:waiting?"waiting_for_browser":"research_completed",currentStep:1,nextRunAt:waiting?new Date(clock().getTime()+5000).toISOString():clock().toISOString(),leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,researchResult:result,researchState:{version:1,phase:waiting?"waiting_for_browser":"research_completed",...(childId?{browserTaskId:childId}:{})}}});await activity(task,"web_research_checkpointed","completed",waiting?"Research checkpoint persisted; waiting for the bounded browser child.":"Research evidence checkpoint persisted.",{sourceCount:result.sources.length,browserTaskId:childId||null});return{task,result,idempotent:false};}
      const result=task.metadata.researchResult,generated=await modelProvider.generate({message:job.request,conversationHistory:[],context:{},tools:[],systemContext:`Produce the concise final answer requested by the owner using only this server-retained public evidence. Cite only URLs present in the evidence. Do not invent facts, prices, features, or URLs.\n\nEVIDENCE JSON:\n${evidenceContext(result)}`,signal:executionController.signal,stage:"chat",costContext:{taskId,runId:taskId}});if(heartbeatFailure)throw heartbeatFailure;if(generated?.type!=="final")throw Object.assign(new Error("Research synthesis returned an invalid result."),{code:"web_research_synthesis_invalid"});const finalAnswer=bindCitations(generated.message,result);await storage.updateAutonomyStep(taskId,stepId,{status:"completed",completedAt:clock().toISOString(),result:{status:"completed",sourceCount:result.sources.length,providerUsage:generated.providerUsage||null}});await executionTruth.finish(attemptInput(attempt),{status:"completed",reason:"research_completed"});task=await update(await storage.getAutonomyTask(taskId,ownerId),{status:"completed",currentPhase:"completed",currentStep:2,completedAt:clock().toISOString(),resultSummary:"Completed durable public Web research.",leaseOwner:null,leaseToken:null,leaseExpiresAt:null,metadata:{...task.metadata,localHandoff:null,researchFinalAnswer:finalAnswer,researchState:{version:1,phase:"completed"}}});await storage.updateRun(taskId,ownerId,{status:"completed",currentStep:2,result:{message:finalAnswer,durableTask:{id:taskId,status:"completed"},providerUsage:[generated.providerUsage].filter(Boolean)},completedAt:clock().toISOString()});await activity(task,"web_research_completed","completed","Completed durable public Web research.",{sourceCount:result.sources.length});return{task,result:{finalAnswer,sources:result.sources},idempotent:false};
    }catch(error){return terminalFailure(await storage.getAutonomyTask(taskId,ownerId),attempt,stepId,error);}
    finally{clearInterval(heartbeatTimer);signal?.removeEventListener?.("abort",cancel);}
  }
  return Object.freeze({prepare,executeTask});
}
