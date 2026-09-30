import test from "node:test";
import assert from "node:assert/strict";
import {minimalTransformContext,retrieveConversationTransformSource} from "../src/agent/conversation-transform-source.js";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";

const OWNER="owner",CONVERSATION="report-conversation";

async function fixture(){
  const storage=createInMemoryStorage();
  await storage.initialize({owner:{id:OWNER,fullName:"Owner"}});
  await storage.ensureConversation({id:CONVERSATION,ownerId:OWNER,title:"Report"});
  return storage;
}

test("terminal report retrieval crosses the ordinary 24-message window and preserves the exact long source",async()=>{
  const storage=await fixture(),content=`# Long report\n\n${"Evidence and analysis. ".repeat(700)}\n\n[Trusted source](https://example.com/report)`;
  await storage.appendMessage({id:`task-report_${"a".repeat(48)}`,conversationId:CONVERSATION,ownerId:OWNER,role:"assistant",content});
  for(let index=0;index<30;index++)await storage.appendMessage({conversationId:CONVERSATION,ownerId:OWNER,role:index%2?"assistant":"user",content:`Later message ${index}`});
  const result=await retrieveConversationTransformSource({storage,ownerId:OWNER,conversationId:CONVERSATION,request:"Translate the previous report into Arabic.",bounds:{pageSize:10}});
  assert.equal(result.reason,"terminal_report");assert.equal(result.source.content,content);assert.ok(result.pages>2);assert.ok(result.messages>24);
});

test("source retrieval is isolated to the exact owner and conversation with no cross-conversation fallback",async()=>{
  const storage=await fixture();
  await storage.ensureConversation({id:"other-conversation",ownerId:OWNER,title:"Other"});
  await storage.appendMessage({id:`task-report_${"b".repeat(48)}`,conversationId:"other-conversation",ownerId:OWNER,role:"assistant",content:"# Other private report"});
  assert.equal((await retrieveConversationTransformSource({storage,ownerId:OWNER,conversationId:CONVERSATION,request:"Summarize the previous report."})).source,null);
  assert.equal((await retrieveConversationTransformSource({storage,ownerId:"different-owner",conversationId:"other-conversation",request:"Summarize the previous report."})).source,null);
});

test("retrieval bounds page count message count scanned bytes and timeout calls",async()=>{
  let calls=0;
  const storage={async listMessages(_conversationId,_ownerId,{limit}){calls+=1;return Array.from({length:limit},(_,index)=>({id:`user-${calls}-${index}`,role:"user",content:"x"}));}};
  const result=await retrieveConversationTransformSource({storage,ownerId:OWNER,conversationId:CONVERSATION,request:"Rewrite the previous report.",bounds:{pageSize:5,maxPages:2,maxMessages:10,maxScannedBytes:100,timeoutMs:500}});
  assert.equal(result.source,null);assert.equal(result.pages,2);assert.equal(result.messages,10);assert.equal(calls,2);
});

test("minimal transform context excludes the exact source and stays byte and message bounded",()=>{
  const source={id:"source",role:"assistant",content:"source"},history=[source,...Array.from({length:10},(_,index)=>({id:`m${index}`,role:index%2?"assistant":"user",content:`context-${index}`}))],selected=minimalTransformContext(history,source,{maxMessages:4,maxBytes:100});
  assert.deepEqual(selected.map(item=>item.id),["m6","m7","m8","m9"]);assert.equal(selected.some(item=>item.id==="source"),false);
});
