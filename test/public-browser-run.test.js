import test from "node:test";
import assert from "node:assert/strict";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createModelCostController} from "../src/providers/model-cost-budget.js";
import {createExecutionTruthService} from "../src/autonomy/execution-truth.js";
import {createTerminalTaskReporter} from "../src/autonomy/terminal-task-reporter.js";
import {createBrowserProviderBudget} from "../src/web/browser-provider-budget.js";
import {BROWSER_RUN_LIMITS,BrowserRunError,createCloudflareBrowserRunAdapter,validateBrowserDestination,VISUAL_BROWSER_FALLBACK_CONTRACT} from "../src/web/cloudflare-browser-run.js";
import {createDurableBrowserTaskService} from "../src/web/durable-browser-task.js";

const OWNER="owner-browser",CONVERSATION="conversation-browser",RUN="run-browser",publicDns=async()=>[{address:"8.8.8.8",family:4}];

function fakePlaywright(){
  const state={contextOptions:null,route:null,listeners:new Map(),closed:0,browserClosed:0,url:"https://example.com/app"};
  const page={on(name,fn){state.listeners.set(name,fn);},async goto(url){state.url=url;},url(){return state.url;},async evaluate(){return state.url.endsWith("/start")?{title:"Browser Run",text:"Get started with Browser Run.",links:[{text:"Get started",href:"https://example.com/browser-rendering/get-started/"},{text:"External",href:"https://other.example/x"}],forms:1}:{title:"Get started - Browser Run",text:"Prerequisites Cloudflare account Node.js installed.",links:[],forms:0};}};
  const context={async route(_pattern,fn){state.route=fn;},async newPage(){return page;},async close(){state.closed+=1;}};
  const browser={async newContext(options){state.contextOptions=options;return context;},async close(){state.browserClosed+=1;}};
  return{state,connect:async()=>browser};
}

test("Cloudflare REST/CDP adapter creates one guarded fresh session and deletes it",async()=>{
  const fake=fakePlaywright(),requests=[];
  const adapter=createCloudflareBrowserRunAdapter({accountId:"account",apiToken:"secret-token",resolveHost:publicDns,connectOverCDP:fake.connect,fetchImpl:async(url,init={})=>{requests.push({url,init});if(init.method==="DELETE")return new Response("{}",{status:200});return new Response(JSON.stringify({sessionId:"session",webSocketDebuggerUrl:"wss://api.cloudflare.test/session"}),{status:200,headers:{"content-type":"application/json"}});}});
  const result=await adapter.run({startUrl:"https://example.com/app",allowedDomains:["example.com"],ttlMs:180000});
  const create=JSON.parse(requests[0].init.body);assert.deepEqual(create,{guardrails:{allowedDomains:["example.com"]}});assert.match(requests[0].url,/keep_alive=180000&recording=false&targets=true/);assert.equal(requests.at(-1).init.method,"DELETE");
  assert.deepEqual(fake.state.contextOptions,{acceptDownloads:false,serviceWorkers:"block",permissions:[]});assert.equal(result.status,"completed");assert.equal(result.isolation.profileImported,false);assert.equal(result.contentHash.length,64);assert.equal(VISUAL_BROWSER_FALLBACK_CONTRACT.active,false);
  let routed;await fake.state.route({request:()=>({method:()=>"POST",url:()=>"https://example.com/write"}),abort:reason=>{routed=reason;},continue:()=>{routed="continued";}});assert.equal(routed,"blockedbyclient");
  await fake.state.route({request:()=>({method:()=>"GET",url:()=>"https://other.example/read"}),abort:reason=>{routed=reason;},continue:()=>{routed="continued";}});assert.equal(routed,"blockedbyclient");
  await fake.state.route({request:()=>({method:()=>"GET",url:()=>"https://example.com/read"}),abort:reason=>{routed=reason;},continue:()=>{routed="continued";}});assert.equal(routed,"continued");
  await fake.state.route({request:()=>({method:()=>"GET",url:()=>"file:///private"}),abort:reason=>{routed=reason;},continue:()=>{routed="continued";}});assert.equal(routed,"blockedbyclient");
  let downloadCancelled=false,files=[];await fake.state.listeners.get("download")({cancel:async()=>{downloadCancelled=true;}});await fake.state.listeners.get("filechooser")({setFiles:async value=>{files=value;}});assert.equal(downloadCancelled,true);assert.deepEqual(files,[]);
});

test("Cloudflare adapter follows one exact visible same-domain link and returns destination evidence",async()=>{
  const fake=fakePlaywright(),requests=[],adapter=createCloudflareBrowserRunAdapter({accountId:"account",apiToken:"secret-token",resolveHost:publicDns,connectOverCDP:fake.connect,fetchImpl:async(url,init={})=>{requests.push({url,init});return init.method==="DELETE"?new Response("{}",{status:200}):new Response(JSON.stringify({sessionId:"session",webSocketDebuggerUrl:"wss://api.cloudflare.test/session"}),{status:200});}});
  const result=await adapter.run({startUrl:"https://example.com/start",allowedDomains:["example.com"],navigation:{type:"follow_link_text",label:"Get started"}});
  assert.equal(result.finalUrl,"https://example.com/browser-rendering/get-started/");assert.equal(result.title,"Get started - Browser Run");assert.match(result.text,/Prerequisites Cloudflare account/);assert.equal(result.observations.length,2);assert.equal(result.usage.actions,4);assert.equal(requests.at(-1).init.method,"DELETE");assert.equal(fake.state.closed,1);assert.equal(fake.state.browserClosed,1);
});

test("duplicate visible labels are accepted only when every match resolves to the same destination",async()=>{
  const fake=fakePlaywright(),originalConnect=fake.connect;fake.connect=async(...args)=>{const browser=await originalConnect(...args),originalContext=browser.newContext.bind(browser);browser.newContext=async options=>{const context=await originalContext(options),originalPage=context.newPage.bind(context);context.newPage=async()=>{const page=await originalPage(),originalEvaluate=page.evaluate.bind(page);page.evaluate=async()=>fake.state.url.endsWith("/start")?{title:"Browser Run",text:"Get started.",links:[{text:"Get started",href:"/browser-rendering/get-started/"},{text:"Get started",href:"https://example.com/browser-rendering/get-started/"}],forms:0}:originalEvaluate();return page;};return context;};return browser;};
  const adapter=createCloudflareBrowserRunAdapter({accountId:"account",apiToken:"secret",resolveHost:publicDns,connectOverCDP:fake.connect,fetchImpl:async(_url,init={})=>init.method==="DELETE"?new Response("{}",{status:200}):new Response(JSON.stringify({sessionId:"session",webSocketDebuggerUrl:"wss://api.cloudflare.test/session"}),{status:200})});
  const result=await adapter.run({startUrl:"https://example.com/start",allowedDomains:["example.com"],navigation:{type:"follow_link_text",label:"Get started"}});assert.equal(result.finalUrl,"https://example.com/browser-rendering/get-started/");
});

test("exact-link navigation fails closed for cross-domain, missing, and ambiguous links",async()=>{
  const make=links=>{const fake=fakePlaywright();fake.connect=async()=>({async newContext(options){fake.state.contextOptions=options;return{async route(_pattern,fn){fake.state.route=fn;},async newPage(){return{on(name,fn){fake.state.listeners.set(name,fn);},async goto(url){fake.state.url=url;},url(){return fake.state.url;},async evaluate(){return{title:"Start",text:"Public start page",links,forms:0};}};},async close(){fake.state.closed+=1;}};},async close(){fake.state.browserClosed+=1;}});return fake;};
  const adapterFor=fake=>createCloudflareBrowserRunAdapter({accountId:"account",apiToken:"secret",resolveHost:publicDns,connectOverCDP:fake.connect,fetchImpl:async(_url,init={})=>init.method==="DELETE"?new Response("{}",{status:200}):new Response(JSON.stringify({sessionId:"session",webSocketDebuggerUrl:"wss://api.cloudflare.test/session"}),{status:200})});
  await assert.rejects(()=>adapterFor(make([{text:"Get started",href:"https://other.example/x"}])).run({startUrl:"https://example.com/start",allowedDomains:["example.com"],navigation:{type:"follow_link_text",label:"Get started"}}),error=>error.code==="browser_domain_forbidden");
  await assert.rejects(()=>adapterFor(make([])).run({startUrl:"https://example.com/start",allowedDomains:["example.com"],navigation:{type:"follow_link_text",label:"Get started"}}),error=>error.code==="browser_link_not_found");
  await assert.rejects(()=>adapterFor(make([{text:"Get started",href:"https://example.com/a"},{text:"Get started",href:"https://example.com/b"}])).run({startUrl:"https://example.com/start",allowedDomains:["example.com"],navigation:{type:"follow_link_text",label:"Get started"}}),error=>error.code==="browser_link_ambiguous");
});

test("browser destination policy rejects private, credential-bearing, local and unrelated authority",async()=>{
  for(const url of ["http://example.com/x","https://user:pass@example.com/x","file:///secret","https://other.example/x","https://example.com/x?access_token=secret"]){await assert.rejects(()=>validateBrowserDestination(url,{allowedDomains:["example.com"],resolveHost:publicDns}),BrowserRunError);}
  await assert.rejects(()=>validateBrowserDestination("https://example.com/x",{allowedDomains:["example.com"],resolveHost:async()=>[{address:"127.0.0.1",family:4}]}),error=>error.code==="browser_network_forbidden");
});

async function fixture({browserAdapter,browserBudgetUsd=0.5,modelBudgetUsd=8.15}={}){
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER,fullName:"Owner",provenance:"test"}});await storage.ensureConversation({id:CONVERSATION,ownerId:OWNER,title:"browser"});
  const modelCostController=createModelCostController({storage,ownerId:OWNER,config:{budgetId:"openai-existing-8.15",globalBudgetUsd:modelBudgetUsd,taskBudgetUsd:modelBudgetUsd}}),providerBudget=createBrowserProviderBudget({storage,ownerId:OWNER,globalBudgetUsd:browserBudgetUsd}),executionTruth=createExecutionTruthService({storage,ownerId:OWNER});
  return{storage,modelCostController,providerBudget,executionTruth,service:createDurableBrowserTaskService({storage,ownerId:OWNER,browserAdapter,providerBudget,modelCostController,executionTruth,clock:()=>new Date("2026-09-29T12:00:01.000Z")})};
}

const completedResult=()=>({status:"completed",finalUrl:"https://example.com/app",domain:"example.com",title:"Rendered",text:"Verified rendered fact",contentHash:"d".repeat(64),retrievedAt:"2026-09-29T12:00:01.000Z",observations:[{sequence:1,type:"rendered_content",domain:"example.com",contentHash:"d".repeat(64)}],usage:{provider:"cloudflare",durationMs:1000,actions:2,pages:1,screenshots:0},limits:{ttlMs:180000,maxActions:20,maxPages:8,maxScreenshots:3},isolation:{freshSession:true,freshContext:true,recording:false,profileImported:false}});
const executeInput={startUrl:"https://example.com/app",allowedDomains:["example.com"],reason:"rendered_content_missing",conversationId:CONVERSATION,runId:RUN,projectId:null};

test("durable browser task fences execution, reports observed phases, settles separate budget, and is idempotent",async()=>{
  let calls=0;const f=await fixture({browserAdapter:{async run({onProgress}){calls+=1;await onProgress({phase:"starting_browser",summary:"Starting isolated browser."});await onProgress({phase:"opening_public_page",summary:"Opening example.com.",metadata:{domain:"example.com"}});await onProgress({phase:"inspecting_rendered_content",summary:"Inspecting rendered content.",metadata:{domain:"example.com"}});return completedResult();}}});
  const first=await f.service.execute(executeInput),again=await f.service.execute(executeInput);assert.equal(calls,1);assert.equal(first.task.status,"completed");assert.equal(again.idempotent,true);assert.match(first.task.id,/^web_[a-f0-9]{32}$/);
  assert.equal(first.task.metadata.browserJob.version,2);assert.equal(first.task.metadata.browserJob.navigation,null);
  const attempt=await f.storage.getLatestExecutionAttempt(first.task.id,OWNER),steps=await f.storage.listAutonomySteps(first.task.id),activity=await f.storage.listActivity(OWNER,{runId:first.task.id,limit:20});assert.equal(attempt.status,"completed");assert.equal(attempt.generation,1);assert.equal(attempt.executorStarted,true);assert.equal(steps[0].status,"completed");assert.ok(activity.some(item=>item.action==="browser_inspecting_rendered_content"));assert.equal((await f.providerBudget.status()).spentUsd,0.000025);assert.equal((await f.providerBudget.status()).reservedUsd,0);assert.equal((await f.modelCostController.status()).spentUsd,0);assert.deepEqual(first.result.evidence,[{text:"Verified rendered fact",source:{url:"https://example.com/app",domain:"example.com",title:"Rendered",retrievedAt:"2026-09-29T12:00:01.000Z",contentHash:"d".repeat(64)}}]);
  assert.doesNotMatch(JSON.stringify({task:first.task,steps,activity}),/(?:secret|password|authorization|bearer)/i);
  const reporter=createTerminalTaskReporter({storage:f.storage,ownerId:OWNER});assert.deepEqual(await reporter.reconcile(),{enqueued:1,delivered:1});assert.deepEqual(await reporter.reconcile(),{enqueued:0,delivered:0});
});

test("browser provider/model reservations fail closed and terminal before session creation",async()=>{
  let calls=0;const unavailable={async run(){calls+=1;return completedResult();}},provider=await fixture({browserAdapter:unavailable,browserBudgetUsd:0}),providerResult=await provider.service.execute(executeInput);assert.equal(providerResult.task.status,"blocked");assert.equal(providerResult.result.code,"browser_provider_budget_exhausted");assert.equal(calls,0);
  const model=await fixture({browserAdapter:unavailable,modelBudgetUsd:0}),modelResult=await model.service.execute({...executeInput,runId:"run-model"});assert.equal(modelResult.task.status,"blocked");assert.equal(modelResult.result.code,"cost_budget_exhausted");assert.equal(calls,0);assert.equal((await model.providerBudget.status()).reservedUsd,0);
});

test("one provider crash retry is bounded and authentication blocks terminally without duplicate result",async()=>{
  let calls=0;const retry=await fixture({browserAdapter:{async run(){calls+=1;if(calls===1)throw new BrowserRunError("browser_session_failed","crash");return completedResult();}}}),done=await retry.service.execute({...executeInput,runId:"run-retry"});assert.equal(done.task.status,"completed");assert.equal(calls,2);
  const blocked=await fixture({browserAdapter:{async run(){throw new BrowserRunError("authentication_required","Authentication required.",{stage:"rendered_inspection",domain:"example.com"});}}}),result=await blocked.service.execute({...executeInput,runId:"run-blocked"});assert.equal(result.task.status,"blocked");assert.equal(result.result.code,"authentication_required");assert.equal((await blocked.storage.getLatestExecutionAttempt(result.task.id,OWNER)).status,"blocked");
});

test("authentication, CAPTCHA, paywall and robots boundaries remain terminal and never retry",async()=>{
  for(const code of ["authentication_required","captcha_required","paywall_detected","robots_disallowed"]){let calls=0;const f=await fixture({browserAdapter:{async run(){calls+=1;throw new BrowserRunError(code,"Stopped safely.",{stage:"policy"});}}}),result=await f.service.execute({...executeInput,runId:`run-${code}`});assert.equal(result.task.status,"blocked",code);assert.equal(result.result.code,code);assert.equal(calls,1,code);}
});

test("persisted rendered evidence is bounded and redacts secret-looking page content",async()=>{
  const f=await fixture({browserAdapter:{async run(){return{...completedResult(),text:`Public fact sk-${"x".repeat(24)} token=never-store ${"z".repeat(110000)}`};}}}),result=await f.service.execute({...executeInput,runId:"run-redaction"}),serialized=JSON.stringify(result.result);assert.doesNotMatch(serialized,/sk-x{10}|never-store/);assert.match(serialized,/\[REDACTED\]/);assert.ok(result.result.text.length<=100000);assert.ok(result.result.evidence[0].text.length<=2000);
});

test("cancellation is terminal and no browser result/session can be duplicated",async()=>{
  const controller=new AbortController();controller.abort();let calls=0;const f=await fixture({browserAdapter:{async run(){calls+=1;return completedResult();}}});await assert.rejects(()=>f.service.execute({...executeInput,runId:"run-cancel",signal:controller.signal}),error=>error.name==="AbortError");const [task]=await f.storage.listAutonomyTasks(OWNER);assert.equal(task.status,"cancelled");assert.equal(calls,0);assert.equal((await f.service.execute({...executeInput,runId:"run-cancel"})).idempotent,true);
});

test("durable cancellation during remote execution wins over a late provider result",async()=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),resume=new Promise(resolve=>{release=resolve;}),f=await fixture({browserAdapter:{async run({onProgress}){entered();await resume;await onProgress({phase:"inspecting_rendered_content",summary:"Inspecting."});return completedResult();}}}),running=f.service.execute({...executeInput,runId:"run-mid-cancel"});await started;let [task]=await f.storage.listAutonomyTasks(OWNER);task=await f.storage.updateAutonomyTask(task.id,OWNER,{status:"cancelled",currentPhase:"cancelled",completedAt:"2026-09-29T12:00:02.000Z"},task.stateVersion);release();await assert.rejects(()=>running,error=>error.name==="AbortError");const final=await f.storage.getAutonomyTask(task.id,OWNER),[step]=await f.storage.listAutonomySteps(task.id);assert.equal(final.status,"cancelled");assert.equal(final.metadata.browserResult,undefined);assert.equal(step.result.status,"cancelled");
});

test("the provider-wide browser lock permits only one active browser task",async()=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),blocked=new Promise(resolve=>{release=resolve;}),f=await fixture({browserAdapter:{async run(){entered();await blocked;return completedResult();}}});
  const first=f.service.execute({...executeInput,runId:"run-concurrent-one"});await started;
  const second=await f.service.execute({...executeInput,runId:"run-concurrent-two"});assert.equal(second.task.status,"retrying");assert.equal(second.task.currentPhase,"waiting_for_browser_capacity");
  release();assert.equal((await first).task.status,"completed");
});

test("browser worker loss follows execution truth: pre-start requeues, post-start fails closed",async()=>{
  let now=new Date("2026-09-29T12:00:00.000Z");const storage=createInMemoryStorage({clock:()=>now});await storage.initialize({owner:{id:OWNER,fullName:"Owner"}});const truth=createExecutionTruthService({storage,ownerId:OWNER,clock:()=>now,leaseMs:30000});
  const create=async suffix=>{const id=`web_${suffix.repeat(32)}`;let task=await storage.createAutonomyTask({id,ownerId:OWNER,projectId:null,title:"Browser",objective:"Read public page",taskType:"public_web_browser",maxRuntimeMinutes:5,metadata:{requiredCapability:"remote_public_browser"}});await storage.recordAutonomyStep({taskId:id,stepId:"1:public_browser_read",stepType:"public_browser_read",capability:"remote_public_browser",operationFingerprint:suffix,status:"running"});task=await storage.claimAutonomyTask({ownerId:OWNER,workerId:"worker-old",capabilities:["remote_public_browser"],leaseMs:30000,idempotencyKey:`claim-${suffix}`,taskId:id,expectedVersion:task.stateVersion});const handoff={id:`handoff-${suffix}`,stepId:"1:public_browser_read",stepType:"public_browser_read"};task=await storage.updateAutonomyTask(id,OWNER,{metadata:{...task.metadata,localHandoff:handoff}},task.stateVersion);const attempt=await truth.start({task,handoff,workerId:"worker-old"});return{id,attempt};};
  const before=await create("a");now=new Date(now.getTime()+31000);await truth.reconcile({workerId:"worker-new"});assert.equal((await storage.getAutonomyTask(before.id,OWNER)).status,"waiting_for_worker");
  const after=await create("b");await truth.heartbeat(attemptInputForTest(after.attempt),{phase:"opening_public_page",executorStarted:true,progress:true});now=new Date(now.getTime()+31000);await truth.reconcile({workerId:"worker-new"});const failed=await storage.getAutonomyTask(after.id,OWNER);assert.equal(failed.status,"failed");assert.equal(failed.errorCode,"execution_owner_lost_after_start");
});

function attemptInputForTest(attempt){return{id:attempt.id,taskId:attempt.taskId,handoffId:attempt.handoffId,workerId:attempt.workerId,generation:attempt.generation,fenceToken:attempt.fenceToken};}

test("hard action cap closes the provider session",async()=>{
  const fake=fakePlaywright(),requests=[];const adapter=createCloudflareBrowserRunAdapter({accountId:"account",apiToken:"very-secret-token",resolveHost:publicDns,connectOverCDP:fake.connect,fetchImpl:async(url,init={})=>{requests.push({url,init});return init.method==="DELETE"?new Response("{}",{status:200}):new Response(JSON.stringify({sessionId:"session",webSocketDebuggerUrl:"wss://api.cloudflare.test/session"}),{status:200});}});
  await assert.rejects(()=>adapter.run({startUrl:"https://example.com/app",allowedDomains:["example.com"],maxActions:1}),error=>error.code==="browser_limit_reached");assert.equal(requests.at(-1).init.method,"DELETE");assert.equal(BROWSER_RUN_LIMITS.maxPages,8);
});

test("session TTL and page caps are hard-clamped before remote work",async()=>{
  const fake=fakePlaywright(),requests=[],adapter=createCloudflareBrowserRunAdapter({accountId:"account",apiToken:"secret",resolveHost:publicDns,connectOverCDP:fake.connect,fetchImpl:async(url,init={})=>{requests.push({url,init});return init.method==="DELETE"?new Response("{}",{status:200}):new Response(JSON.stringify({sessionId:"session",webSocketDebuggerUrl:"wss://api.cloudflare.test/session"}),{status:200});}});
  await adapter.run({startUrl:"https://example.com/app",allowedDomains:["example.com"],ttlMs:999999});assert.match(requests[0].url,/keep_alive=300000/);
  await assert.rejects(()=>adapter.run({startUrl:"https://example.com/app",allowedDomains:["example.com"],maxPages:0}),error=>error.code==="browser_limit_reached");assert.equal(requests.at(-1).init.method,"DELETE");
});
