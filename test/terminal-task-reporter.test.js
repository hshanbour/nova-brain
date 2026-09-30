import test from "node:test";
import assert from "node:assert/strict";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createTerminalTaskReporter,isConversationTaskResultQuestion,renderTerminalTaskReport} from "../src/autonomy/terminal-task-reporter.js";
import {SCHEMA_STATEMENTS,SCHEMA_VERSION} from "../src/storage/schema.js";

const OWNER="owner",CONVERSATION="conversation-a",OTHER="conversation-b";
test("schema eleven adds a durable unique terminal report outbox",()=>{assert.ok(SCHEMA_VERSION>=11);const sql=SCHEMA_STATEMENTS.find(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_task_report_outbox"));assert.match(sql,/PRIMARY KEY/);assert.match(sql,/UNIQUE\(task_id,terminal_state_version\)/);assert.match(sql,/message_id text UNIQUE/);});
async function fixture(){
  let tick=0;const storage=createInMemoryStorage({clock:()=>new Date(Date.UTC(2026,8,26,0,0,tick++))});
  await storage.initialize({owner:{id:OWNER,fullName:"Owner"},projects:[{id:"nova-brain",name:"Nova"}]});
  await storage.ensureConversation({id:CONVERSATION,ownerId:OWNER});await storage.ensureConversation({id:OTHER,ownerId:OWNER});
  return{storage,reporter:createTerminalTaskReporter({storage,ownerId:OWNER})};
}
async function terminal(f,{id,status="completed",type="self_development",conversationId=CONVERSATION,result,phase="review"}){
  let task=await f.storage.createAutonomyTask({id,ownerId:OWNER,projectId:"nova-brain",title:"Task",objective:"Do work",taskType:type,metadata:{terminalReporting:{version:1,conversationId,runId:"run-1"}}});
  if(result)await f.storage.recordAutonomyStep({taskId:id,stepId:"1:delegate_coding",stepType:"delegate_coding",capability:"codex_local",operationFingerprint:`fp-${id}`,status:"completed",result});
  task=await f.storage.updateAutonomyTask(id,OWNER,{status,currentPhase:phase,completedAt:new Date().toISOString(),...(status==="completed"?{resultSummary:"Finished safely."}:{errorCode:`${status}_reason`,blockedReason:`The task ${status} safely.`})},task.stateVersion);
  return task;
}

test("completed coding result is delivered exactly once to its originating conversation and survives replay",async()=>{
  const f=await fixture(),task=await terminal(f,{id:"coding_"+"a".repeat(32),type:"coding_delegation",result:{summary:"Improved accessibility.",filesChanged:["assets/console.js"],tests:[{name:"focused",status:"passed",summary:"3 passed"}],finalLocalSha:"b".repeat(40),executor:{localRef:"refs/nova/coding-jobs/job"},limitations:["Browser acceptance remains."],pushOccurred:false,deploymentOccurred:false,approvalsRequiredNext:[]}});
  assert.deepEqual(await f.reporter.reconcile(),{enqueued:1,delivered:1});
  assert.deepEqual(await f.reporter.reconcile(),{enqueued:0,delivered:0});
  const messages=await f.storage.listMessages(CONVERSATION,OWNER,{limit:20});assert.equal(messages.length,1);assert.match(messages[0].content,/Improved accessibility/);assert.match(messages[0].content,/assets\/console\.js/);assert.match(messages[0].content,new RegExp("b{40}"));assert.match(messages[0].content,/Push: not performed/);
  assert.equal((await f.storage.listMessages(OTHER,OWNER,{limit:20})).length,0);
  assert.equal((await f.reporter.latestForConversation(CONVERSATION)).task.id,task.id);
});

for(const status of ["failed","blocked","cancelled"])test(`${status} task emits one bounded safe terminal report`,async()=>{
  const f=await fixture();await terminal(f,{id:`selfdev_${status.padEnd(32,"a").slice(0,32)}`,status,phase:"run_focused_tests"});
  await f.reporter.reconcile();await f.reporter.reconcile();const [message]=await f.storage.listMessages(CONVERSATION,OWNER,{limit:10});
  assert.match(message.content,new RegExp(`Status: ${status}`));assert.match(message.content,/Reached: run_focused_tests/);assert.match(message.content,/Changes recorded: no/);assert.equal((await f.storage.listMessages(CONVERSATION,OWNER,{limit:10})).length,1);
});

test("an undelivered durable outbox record is recovered exactly once after reporter restart",async()=>{
  const f=await fixture(),task=await terminal(f,{id:"selfdev_"+"d".repeat(32)});await f.reporter.enqueue(task);
  const restarted=createTerminalTaskReporter({storage:f.storage,ownerId:OWNER});assert.deepEqual(await restarted.reconcile(),{enqueued:0,delivered:1});assert.deepEqual(await restarted.reconcile(),{enqueued:0,delivered:0});
  assert.equal((await f.storage.listMessages(CONVERSATION,OWNER,{limit:10})).length,1);
});

test("a completed orchestration container with a delegated child does not duplicate the child report",async()=>{
  const f=await fixture();let parent=await f.storage.createAutonomyTask({id:"orchestration_"+"e".repeat(32),ownerId:OWNER,title:"Parent",objective:"Delegate",taskType:"coding_orchestration",metadata:{terminalReporting:{version:1,conversationId:CONVERSATION},delegatedTaskId:"coding_"+"f".repeat(32)}});parent=await f.storage.updateAutonomyTask(parent.id,OWNER,{status:"completed"},parent.stateVersion);await terminal(f,{id:"coding_"+"f".repeat(32),type:"coding_delegation",result:{summary:"Child completed."}});await f.reporter.reconcile();assert.equal((await f.storage.listMessages(CONVERSATION,OWNER,{limit:10})).length,1);
});
test("conversation follow-up resolves the newest active bound task without falling back to an older result",async()=>{
  const f=await fixture();await terminal(f,{id:"selfdev_"+"1".repeat(32)});const active=await f.storage.createAutonomyTask({id:"selfdev_"+"2".repeat(32),ownerId:OWNER,title:"Active",objective:"Work",taskType:"self_development",metadata:{terminalReporting:{version:1,conversationId:CONVERSATION}}});await f.storage.updateAutonomyTask(active.id,OWNER,{status:"running",currentPhase:"planning"},active.stateVersion);
  const result=await f.reporter.latestForConversation(CONVERSATION);assert.equal(result.task.id,active.id);assert.match(result.message,/Status: running/);assert.match(result.message,/No terminal result is available yet/);
});
test("conversation workflow lookup cannot leak a task into another conversation",async()=>{
  const f=await fixture(),task=await terminal(f,{id:"selfdev_"+"9".repeat(32)}),own=await f.storage.listConversationBoundTasks(OWNER,CONVERSATION,{limit:20}),other=await f.storage.listConversationBoundTasks(OWNER,OTHER,{limit:20});
  assert.deepEqual(own.map(item=>item.id),[task.id]);assert.deepEqual(other,[]);assert.equal(await f.reporter.latestForConversation(OTHER),null);
});

test("read-only result questions route generally while mutation requests do not",()=>{
  for(const message of ["What changed?","Show me the tests.","What commit did it make?","What happened with that task?","Show me the completed result."])assert.equal(isConversationTaskResultQuestion(message),true,message);
  for(const message of ["Implement the requested change","Retry that task","Cancel that task","How are you?","What happened to Sharp Cuts today?"])assert.equal(isConversationTaskResultQuestion(message),false,message);
});
test("terminal report bounds and redacts safe failure text",()=>{
  const message=renderTerminalTaskReport({id:"selfdev_"+"f".repeat(32),status:"failed",stateVersion:2,currentPhase:"planning",errorCode:"safe_failure",blockedReason:`token=super-secret ${"x".repeat(900)}`,metadata:{}},[]);
  assert.doesNotMatch(message,/super-secret/);assert.match(message,/token=\[REDACTED\]/);assert.ok(message.length<3000);
});

test("completed durable research preserves bounded Markdown structure while redacting secrets",()=>{
  const content="# Market report\r\n\r\n## Pricing\r\n\r\n| Product | Price |\r\n| --- | --- |\r\n| Nova | **£10** |\r\n\r\n- [Evidence](https://example.com/pricing)\r\n- token=private-value";
  const message=renderTerminalTaskReport({id:`web_${"9".repeat(32)}`,taskType:"public_web_research",status:"completed",metadata:{researchFinalAnswer:content}},[]);
  assert.match(message,/# Market report\n\n## Pricing\n\n\| Product \| Price \|/);assert.match(message,/\*\*£10\*\*/);assert.match(message,/\[Evidence\]\(https:\/\/example\.com\/pricing\)/);assert.match(message,/token=\[REDACTED\]/);assert.doesNotMatch(message,/private-value|\r/);
});

test("completed browser task answers requested fields directly with exact retained clickable evidence",()=>{
  const url="https://developers.cloudflare.com/browser-run/get-started/",hash="a".repeat(64),task={id:"web_"+"a".repeat(32),taskType:"public_web_browser",status:"completed",metadata:{browserJob:{version:2,allowedDomains:["developers.cloudflare.com"]},browserPresentation:{version:1,requestedFields:["destination_title","first_prerequisite"]},browserResult:{status:"completed",finalUrl:url,domain:"developers.cloudflare.com",title:"Get started · Cloudflare Browser Run docs",text:"Prerequisites To use Browser Run, you need: Sign up for a Cloudflare account. Install Node.js.",contentHash:hash,evidence:[{text:"Prerequisites To use Browser Run, you need: Sign up for a Cloudflare account. Install Node.js.",source:{url,domain:"developers.cloudflare.com",title:"Get started · Cloudflare Browser Run docs",contentHash:hash}}]}}};
  const message=renderTerminalTaskReport(task,[]);
  assert.equal(message,`Title: Get started · Cloudflare Browser Run docs\nFirst prerequisite: Sign up for a Cloudflare account.\n\nEvidence: [Get started · Cloudflare Browser Run docs](${url})`);
  assert.doesNotMatch(message,/Task report|Push:|Deployment:/);
  assert.equal(task.metadata.browserResult.contentHash,hash);
});

test("browser field extraction uses complete retained text while clickable evidence stays bounded",()=>{
  const url="https://developers.cloudflare.com/browser-run/get-started/",hash="e".repeat(64),prefix=`Public documentation ${"ordinary content ".repeat(180)}`,text=`${prefix} Prerequisites Sign up for a Cloudflare account. Install Node.js.`,evidenceText=text.slice(0,2000),task={id:"web_"+"e".repeat(32),taskType:"public_web_browser",status:"completed",metadata:{browserJob:{version:2,allowedDomains:["developers.cloudflare.com"]},browserPresentation:{version:1,requestedFields:["destination_title","first_prerequisite"]},browserResult:{status:"completed",finalUrl:url,domain:"developers.cloudflare.com",title:"Get started · Cloudflare Browser Run docs",text,contentHash:hash,evidence:[{text:evidenceText,source:{url,domain:"developers.cloudflare.com",title:"Get started · Cloudflare Browser Run docs",contentHash:hash}}]}}};
  const message=renderTerminalTaskReport(task,[]);
  assert.equal(evidenceText.length,2000);assert.ok(text.indexOf("Prerequisites")>2000);
  assert.equal(message,`Title: Get started · Cloudflare Browser Run docs\nFirst prerequisite: Sign up for a Cloudflare account.\n\nEvidence: [Get started · Cloudflare Browser Run docs](${url})`);
  assert.doesNotMatch(message,/ordinary content/);assert.ok(message.length<2000);
});

test("completed browser answer is delivered exactly once while the full durable result remains available",async()=>{
  const f=await fixture(),url="https://docs.example/get-started/",hash="d".repeat(64);let task=await f.storage.createAutonomyTask({id:"web_"+"d".repeat(32),ownerId:OWNER,projectId:null,title:"Public browser research",objective:"Read a public page",taskType:"public_web_browser",metadata:{terminalReporting:{version:1,conversationId:CONVERSATION,runId:"chat-run"},browserJob:{version:2,allowedDomains:["docs.example"]},browserPresentation:{version:1,requestedFields:["destination_title","first_prerequisite"]},browserResult:{status:"completed",finalUrl:url,domain:"docs.example",title:"Get started",text:"Prerequisites Create an account. Install the client.",contentHash:hash,evidence:[{text:"Prerequisites Create an account. Install the client.",source:{url,domain:"docs.example",title:"Official docs",contentHash:hash}}],usage:{providerCost:{actualCostUsd:0.001}},observations:[{type:"rendered_content",contentHash:hash}]}}});task=await f.storage.updateAutonomyTask(task.id,OWNER,{status:"completed",currentPhase:"completed",completedAt:new Date().toISOString(),resultSummary:"Completed bounded public browser research."},task.stateVersion);
  assert.deepEqual(await f.reporter.reconcile(),{enqueued:1,delivered:1});assert.deepEqual(await f.reporter.reconcile(),{enqueued:0,delivered:0});const messages=await f.storage.listMessages(CONVERSATION,OWNER,{limit:10}),stored=await f.storage.getAutonomyTask(task.id,OWNER);assert.equal(messages.length,1);assert.match(messages[0].content,/Title: Get started/);assert.match(messages[0].content,/First prerequisite: Create an account\./);assert.equal(stored.metadata.browserResult.usage.providerCost.actualCostUsd,0.001);assert.equal(stored.metadata.browserResult.observations[0].contentHash,hash);
});

test("completed browser task never makes an unbound or invented source clickable",()=>{
  const hash="b".repeat(64),task={id:"web_"+"b".repeat(32),taskType:"public_web_browser",status:"completed",metadata:{browserJob:{version:2,allowedDomains:["docs.example"]},browserPresentation:{version:1,requestedFields:["destination_title"]},browserResult:{status:"completed",finalUrl:"https://docs.example/result",domain:"docs.example",title:"Verified title",text:"Safe text",contentHash:hash,evidence:[{text:"Safe text",source:{url:"https://invented.example/result",domain:"invented.example",title:"Invented",contentHash:hash}}]}}};
  const message=renderTerminalTaskReport(task,[]);
  assert.equal(message,"Title: Verified title");assert.doesNotMatch(message,/https:\/\/|\]\(/);
});

test("blocked and failed browser tasks retain truthful terminal reporting",()=>{
  for(const status of["blocked","failed"]){const message=renderTerminalTaskReport({id:`web_${status.padEnd(32,"c").slice(0,32)}`,taskType:"public_web_browser",status,currentPhase:status,errorCode:`browser_${status}`,blockedReason:`Browser ${status} safely.`,metadata:{browserResult:{status,code:`browser_${status}`,reason:`Browser ${status} safely.`}}},[]);assert.match(message,new RegExp(`Status: ${status}`));assert.match(message,new RegExp(`browser_${status}`));assert.match(message,/Push: not performed/);}
});
