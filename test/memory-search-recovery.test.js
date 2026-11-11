import test from 'node:test';
import assert from 'node:assert/strict';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createMultilingualMemoryStorage} from '../src/memory/multilingual-retrieval.js';
import {registerMemorySearch} from '../src/tools/memory-search.js';
import {registerSystemTools} from '../src/tools/developer-tools.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';
import {createAgent} from '../src/agent/agent.js';
import {allowsMemoryMutation} from '../src/memory/mutation-intent.js';

test('explicit deletion survives a narrow do-not-delete-anything-else restriction',async()=>{
 const request='انسي واحذفي من الذاكرة المعلومة الخيالية للاختبار الخاصة برمز تجربة الربط المتصل. لا تحذفي أي معلومات ثانية.';
 assert.equal(allowsMemoryMutation('memory_forget',request),true);
 assert.equal(allowsMemoryMutation('memory_remember',request),false);
 assert.equal(allowsMemoryMutation('memory_forget','Delete my fictional test code. Do not delete anything else.'),true);
 for(const denied of ['لا تحذفي رمز الاختبار','Forget nothing. Do not delete this memory.','هل تتذكري الرمز؟ لا تحذفي أي معلومات ثانية.','Do not delete any memories.','Delete the test code. Do not delete any memories.','Delete the test code. Do not delete the test code.'])assert.equal(allowsMemoryMutation('memory_forget',denied),false,denied);
 const storage=createInMemoryStorage();await storage.initialize({owner:{id:'a'}});
 await storage.createMemory({id:'target',ownerId:'a',content:'رمز تجربة الربط المتصل',category:'decision',scope:'global',status:'active'});
 await storage.createMemory({id:'keep',ownerId:'a',content:'Unrelated memory',category:'decision',scope:'global',status:'active'});
 const registry=createToolRegistry();registerSystemTools(registry,{storage,ownerId:'a'});
 const agent=createAgent({storage,ownerId:'a',toolRegistry:registry,modelProvider:{name:'fixture',async generate(input){
  if(!input.toolResults.length){assert.ok(input.tools.some(t=>t.name==='memory_forget'));return{type:'tool_calls',toolCalls:[{id:'forget',name:'memory_forget',arguments:{memoryId:'target'}}]};}
  return{type:'final',message:'Forgot the selected record.'};
 }}});
 await agent.run({message:request});
 assert.equal(await storage.getMemory('target','a'),null);assert.equal((await storage.getMemory('keep','a')).status,'active');
});

test('saved-memory-only can refine bilingual lookup without archive, writes or scope expansion',async()=>{
 const raw=createInMemoryStorage();await raw.initialize({owner:{id:'a'},projects:[{id:'private-project',name:'Private Project'}]});
 for(const row of [{id:'target',ownerId:'a',content:'رمز تجربة الربط المتصل هو زمرد الثلاثاء',scope:'global'},{id:'other-owner',ownerId:'b',content:'رمز تجربة الربط المتصل',scope:'global'},{id:'other-project',ownerId:'a',content:'رمز تجربة الربط المتصل',scope:'project',projectId:'private-project'},{id:'deleted',ownerId:'a',content:'رمز تجربة الربط المتصل',scope:'global',status:'deleted'}])await raw.createMemory({...row,category:'decision',status:row.status||'active'});
 const storage=createMultilingualMemoryStorage({storage:raw,translateQuery:async()=>{throw Error('translation deadline');}});
 const registry=createToolRegistry();registerSystemTools(registry,{storage,ownerId:'a'});registerMemorySearch(registry,{storage,ownerId:'a'});
 let observed;
 const agent=createAgent({storage,ownerId:'a',toolRegistry:registry,modelProvider:{name:'fixture',async generate(input){
  if(!input.toolResults.length){assert.deepEqual(input.tools.map(t=>t.name),['memory_search']);return{type:'tool_calls',toolCalls:[{id:'lookup',name:'memory_search',arguments:{query:'connected link test code رمز تجربة الربط المتصل Private Project'}}]};}
  observed=input.toolResults[0].output;return{type:'final',message:'Source-backed fixture answer.'};
 }}});
 await agent.run({message:'What is my connected-link test code? Use saved memory only.'});
 assert.equal(observed.ok,true);assert.deepEqual(observed.result.memories.map(m=>m.id),['target']);
 await raw.deleteMemory('target','a');assert.deepEqual((await registry.execute('memory_search',{query:'رمز تجربة الربط المتصل'},{ownerMessage:'What is my connected-link test code?'})).memories,[]);
});

test('unknown phone speaker cannot run the memory-search fallback',async()=>{
 const storage=createInMemoryStorage();await storage.initialize({owner:{id:'a'}});
 let reads=0;const registry=createToolRegistry();registerMemorySearch(registry,{ownerId:'a',storage:{retrieveMemories(){reads++;return[];}}});
 const agent=createAgent({storage,ownerId:'a',toolRegistry:registry,modelProvider:{name:'fixture',async generate(input){
  assert.deepEqual(input.tools,[]);if(!input.toolResults.length)return{type:'tool_calls',toolCalls:[{id:'denied',name:'memory_search',arguments:{query:'private'}}]};
  assert.equal(input.toolResults[0].output.ok,false);return{type:'final',message:'Public conversation only.'};
 }}});
 await agent.run({message:'Search saved memory only',context:{voice:true,channel:'phone'}});assert.equal(reads,0);
});
