import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';
import {createAgent} from '../src/agent/agent.js';
import {registerProjectDeploymentRead,requestsDeploymentStatus} from '../src/tools/project-deployment-read.js';
import {projectVoiceResult} from '../assets/voice-results.js';
import {retrieveAgentContext} from '../src/memory/context-retriever.js';

async function fixture() {
  const ownerId='fixture', projectId='plumber-growth', storage=createInMemoryStorage();
  await storage.initialize({owner:{id:ownerId,preferences:{}},projects:[{id:projectId,name:'Plumber Growth Kit'},{id:'sharp-cuts',name:'Sharp Cuts'}]});
  const snapshot=JSON.stringify({id:'prj_fixture',provider:'vercel'});
  const source={ownerId,projectId,id:'source-1',sourceType:'vercel',accessMode:'read_only',status:'active',
    extractionMetadata:{classification:'confirmed_provider_metadata',providerAuthenticated:true},permissions:{readOnly:true,externalAccess:true},
    extractedText:snapshot,contentHash:createHash('sha256').update(snapshot).digest('hex')};
  await storage.createProjectSource(source);
  let reads=0;
  const registry=createToolRegistry();
  registerProjectDeploymentRead(registry,{storage,ownerId,vercel:{configured:true,inspect:async id=>{
    reads++;assert.equal(id,'prj_fixture');
    return {id,name:projectId,latestDeployment:{id:'dpl_fresh',state:'READY',environment:'preview',url:'https://preview.example.com',git:{commitSha:'a'.repeat(40)}}};
  }}});
  return {registry,storage,ownerId,projectId,source,reads:()=>reads};
}
test('the normal agent sends an exact project read to the registered provider and returns attributable evidence',async()=>{
  const f=await fixture();
  const agent=createAgent({...f,toolRegistry:f.registry,modelProvider:{name:'fixture',async generate(input){
    if(!input.toolResults.length){
      assert.equal(input.requiredTool,'project_deployment_read');
      return {type:'tool_calls',toolCalls:[{id:'call',name:input.requiredTool,arguments:{projectId:f.projectId}}]};
    }
    return {type:'final',message:input.toolResults[0].output.result.deployment.state};
  }}});
  const result=await agent.run({message:'Check the latest Vercel deployment of PGK',conversationId:'provider-check'});
  const panel=projectVoiceResult(result,'provider-check');
  assert.equal(panel.message,'READY'); assert.equal(f.reads(),1);
  assert.equal(panel.sources[0].id,'vercel:prj_fixture:dpl_fresh');assert.equal(panel.tools[0].verification,'provider_read');
  assert.ok(panel.runId);assert.equal(panel.charts,undefined);
});
test('a similar project name, foreign ID, or conflicting imported binding cannot trigger a read',async()=>{
  const f=await fixture(),read=(projectId,context={})=>f.registry.execute('project_deployment_read',{projectId},context);
  assert.equal((await read('sharp-cuts')).verification,'unavailable');
  await assert.rejects(read('foreign'),/outside/); await assert.rejects(read(f.projectId,{projectId:'sharp-cuts'}),/outside/);
  const extra=JSON.stringify({id:'prj_other',provider:'vercel'});
  await f.storage.createProjectSource({...f.source,id:'source-2',extractedText:extra,contentHash:createHash('sha256').update(extra).digest('hex')});
  assert.match((await read(f.projectId)).reason,/Conflicting/);assert.equal(f.reads(),0);
  assert.equal(requestsDeploymentStatus('لا تفحص حالة النشر'),false);
});
test('a project-scoped recent-work query filters before the database limit and excludes unscoped history',async()=>{
  const f=await fixture();
  await f.storage.appendActivity({ownerId:f.ownerId,projectId:f.projectId,action:'provider_checked',summary:'Relevant scoped work',status:'completed'});
  for(let i=0;i<31;i++)await f.storage.appendActivity({ownerId:f.ownerId,action:'provider_checked',summary:'PGK recent UNRELATED work',status:'completed'});
  const context=await retrieveAgentContext({storage:f.storage,ownerId:f.ownerId,message:'What recent work was done for PGK?'});
  assert.match(JSON.stringify(context.recentWork),/Relevant scoped work/);
  assert.doesNotMatch(JSON.stringify(context.recentWork),/UNRELATED/);
});
