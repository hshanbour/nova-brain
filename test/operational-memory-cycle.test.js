import test from 'node:test';
import assert from 'node:assert/strict';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createMultilingualMemoryStorage} from '../src/memory/multilingual-retrieval.js';
import {retrieveAgentContext} from '../src/memory/context-retriever.js';
import {readRealtimeContext} from '../src/voice/realtime-context.js';
import {createProjectService} from '../src/projects/project-service.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';
import {createActionPolicy} from '../src/policy/action-policy.js';
import {registerSystemTools} from '../src/tools/developer-tools.js';

test('fresh chat and Voice context select the same bilingual record through correction and deletion',async()=>{
  const ownerId='audit-owner-a',raw=createInMemoryStorage();
  await raw.initialize({owner:{id:ownerId,preferences:{replyLanguage:'ar'}},projects:[{id:'synthetic-project-lantern',name:'Lantern'}]});
  let translations=0;
  // Provider translation is simulated, not a claim of live Arabic speech or model quality.
  const storage=createMultilingualMemoryStorage({storage:raw,translateQuery:async()=>{translations++;return JSON.stringify({english:'What is the fictional lighthouse name used in the audit test?',arabic:'شو اسم المنارة التجريبية؟'});}});
  const registry=createToolRegistry({policy:createActionPolicy({storage,ownerId})});registerSystemTools(registry,{storage,ownerId});
  const saved=await registry.execute('memory_remember',{content:'The fictional lighthouse name used in the audit test is Copper Finch.',category:'decision',scope:'global'},{});
  await raw.createMemory({id:'unrelated-lantern',ownerId,scope:'project',projectId:'synthetic-project-lantern',category:'project_context',content:'اسم المشروع التجريبي Lantern',status:'active'});
  await raw.createMemory({id:'different-owner',ownerId:'audit-owner-b',scope:'global',category:'decision',content:'The fictional lighthouse name used in the audit test is PRIVATE OTHER OWNER.',status:'active'});
  const preference=await registry.execute('memory_remember',{content:'For fictional audit examples use two short bullets.',category:'preference',scope:'global'},{});
  async function freshContexts(expectedId,expectedText){
    for(const message of ['شو اسم المنارة التجريبية؟','What is the fictional lighthouse name?']){
      const projectService=createProjectService({storage,ownerId});
      const chat=await retrieveAgentContext({storage,ownerId,message});
      const voice=await readRealtimeContext({storage,ownerId,projectService,message,conversationId:null});
      for(const context of [chat,voice]){
        assert.ok(context.memories.some(m=>m.id===expectedId&&m.content.includes(expectedText)),JSON.stringify(context.memories));
        assert.ok(context.memories.every(m=>!['different-owner','unrelated-lantern'].includes(m.id)));
      }
    }
  }
  await freshContexts(saved.memory.id,'Copper Finch');
  const corrected=await registry.execute('memory_remember',{content:'The fictional lighthouse name used in the audit test is Amber Wren.',category:'decision',scope:'global',supersedesMemoryId:saved.memory.id},{});
  await assert.rejects(()=>registry.execute('memory_remember',{content:'Invalid correction',category:'decision',scope:'global',supersedesMemoryId:'different-owner'},{}));
  await raw.deleteMemory(preference.memory.id,ownerId);
  await freshContexts(corrected.memory.id,'Amber Wren');
  assert.equal((await raw.getMemory(saved.memory.id,ownerId)).status,'superseded');
  for(const message of ['شو اسم المنارة التجريبية؟','What is the fictional lighthouse name?']){
    const results=await storage.retrieveMemories(ownerId,message,{limit:20});
    assert.ok(results.every(m=>![saved.memory.id,preference.memory.id].includes(m.id)));
  }
  assert.equal(translations,2,'same queries reuse translations, never stale memory results');
  console.log(JSON.stringify({synthetic:true,original:saved.memory.id,corrected:corrected.memory.id,deleted:preference.memory.id,channels:['chat-context','voice-context'],languages:['ar','en']}));
});

test('project aliases are owner-scoped, explicit and refuse mixed references',async()=>{
  const records=[{id:'plumber-growth',name:'Plumber Growth Kit'},{id:'sharp-cuts',name:'Sharp Cuts'},{id:'sharp-cuts-web',name:'Sharp Cuts web project'},{id:'nova-digital-services-uk',name:'Nova Digital Services UK'},{id:'nova-brain',name:'Nova Brain'}];
  const service=createProjectService({storage:{async listProjects(owner){return owner==='owner'?records:[];}},ownerId:'owner'});
  for(const [query,id] of [['PGK','plumber-growth'],['بلومبر جروث كيت','plumber-growth'],['Sharp Cuts website','sharp-cuts-web'],['شارب كتس','sharp-cuts-web'],['NDS UK','nova-digital-services-uk'],['نوفا برين','nova-brain']])assert.equal((await service.resolve({message:query})).project?.id,id);
  assert.equal((await service.resolve({message:'PGK and Nova Brain'})).status,'multiple');
  assert.equal((await service.resolve({message:'Direct Nova'})).status,'unresolved');
  const other=createProjectService({storage:{async listProjects(){return[];}},ownerId:'other'});
  assert.equal((await other.resolve({message:'PGK'})).status,'unresolved');
  assert.equal((await other.resolve({projectId:'plumber-growth'})).status,'missing');
});

test('failed translation never substitutes an unrelated project memory',async()=>{
  const raw=createInMemoryStorage();await raw.initialize({owner:{id:'owner'},projects:[]});
  await raw.createMemory({id:'wrong',ownerId:'owner',scope:'project',projectId:'unrelated',category:'project_context',content:'اسم المشروع التجريبي',status:'active'});
  const storage=createMultilingualMemoryStorage({storage:raw,translateQuery:async()=>{throw Error('provider unavailable');}});
  assert.deepEqual(await storage.retrieveMemories('owner','شو اسم المنارة التجريبية؟'),[]);
});
