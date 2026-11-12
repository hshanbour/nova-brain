import test from 'node:test';
import assert from 'node:assert/strict';
import {allowsMemoryMutation,requestedMemoryTool} from '../src/memory/mutation-intent.js';
import {classifyTypedMemoryCandidate} from '../src/memory/learning-service.js';
import {createAgent} from '../src/agent/agent.js';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';
import {registerSystemTools} from '../src/tools/developer-tools.js';
const request='بدياك تحفظ معلومة خيالية للاختبار. رمز اختبار نوفمبر هو زيتونة 42.';
test('natural explicit requests are writable, recollections, questions and negations are not',()=>{
 for(const text of [request,'بديك تحفظي معلومة للاختبار','I want you to save this fictional fact'])assert.equal(requestedMemoryTool(text),'memory_remember');
 for(const text of ['قلتلك بدياك تحفظ معلومة','Did I ask you to save this?','بديك لا تحفظ المعلومة','Can you not save this fact?','I do not want you to save this fact'])assert.equal(requestedMemoryTool(text),null,text);
 assert.equal(allowsMemoryMutation('memory_forget',request),false);
 assert.equal(requestedMemoryTool('بديك تحذفي معلومة الاختبار'),'memory_forget');
 assert.equal(classifyTypedMemoryCandidate(request),null);
});
async function fixture(generate){
 const ownerId='synthetic-receipt-owner',storage=createInMemoryStorage();await storage.initialize({owner:{id:ownerId,preferences:{replyLanguage:'ar'}},projects:[]});
 const registry=createToolRegistry();registerSystemTools(registry,{storage,ownerId});
 return {storage,ownerId,agent:createAgent({storage,ownerId,toolRegistry:registry,modelProvider:{name:'scripted',generate}})};
}
test('a search-only promise cannot be persisted as a successful memory write',async()=>{
 let calls=0;const f=await fixture(async input=>{calls++;assert.ok(input.tools.some(t=>t.name==='memory_remember'));return {type:'final',message:'أكيد رح أحفظها'};});
 const result=await f.agent.run({message:request,conversationId:'synthetic-save-failure'});
 assert.equal(calls,2);assert.match(result.message,/لم يتم تأكيد/);assert.doesNotMatch(result.message,/أكيد رح/);
 assert.equal((await f.storage.listMemories(f.ownerId)).length,0);
});
test('receipt recovery uses the actual tool and stores an active owner-scoped memory',async()=>{
 let calls=0;const f=await fixture(async()=>++calls===1?{type:'final',message:'I will save it'}:calls===2?{type:'tool_calls',toolCalls:[{id:'save-test',name:'memory_remember',arguments:{content:'رمز اختبار نوفمبر الخيالي هو زيتونة 42',category:'decision',scope:'global'}}]}:{type:'final',message:'تم الحفظ'});
 const result=await f.agent.run({message:request,conversationId:'synthetic-save-success'});
 assert.equal(result.message,'تم الحفظ');assert.equal(result.toolCalls[0].result.memory.status,'active');
 assert.equal((await f.storage.listMemories(f.ownerId)).length,1);
 assert.equal((await f.storage.listMemories('other-owner')).length,0);
});
