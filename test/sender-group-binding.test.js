import test from 'node:test';
import assert from 'node:assert/strict';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createSenderGroupBinding} from '../src/email/sender-group-binding.js';
import {createSenderMarketingClient,parseSharpCutsSenderConfig} from '../src/email/sender-marketing.js';

const config=parseSharpCutsSenderConfig({NOVA_SHARP_CUTS_SENDER_API_TOKEN:'fixture-not-a-secret'});
test('dedicated group is created once, verified and owner-scoped without contact writes or sending',async()=>{
 const storage=createInMemoryStorage();await storage.initialize({owner:{id:'a'}});
 const groupBinding=createSenderGroupBinding({storage,ownerId:'a'}),groups=[],calls=[];
 const client=createSenderMarketingClient({config,groupBinding,fetchImpl:async(url,options)=>{
   calls.push([url,options.method]);assert.equal(new URL(url).pathname,'/v2/groups');
   if(options.method==='POST'){groups.push({id:'test_group',title:JSON.parse(options.body).title,recipient_count:0});return Response.json({success:true,data:groups[0]});}
   return Response.json({data:groups,links:{next:null}});
 }});
 assert.equal((await client.prepareDedicatedGroup()).created,true);
 assert.equal((await client.prepareDedicatedGroup()).created,false);
 assert.equal(calls.filter(c=>c[1]==='POST').length,1);
 assert.equal(await client.audienceBinding(),'test_group');
 assert.equal(await createSenderGroupBinding({storage,ownerId:'b'}).read(),null);
});
test('ambiguous group POST is never retried; later matching group can be reconciled',async()=>{
 const storage=createInMemoryStorage();await storage.initialize({owner:{id:'a'}});
 const groupBinding=createSenderGroupBinding({storage,ownerId:'a'});let posts=0,visible=false;
 const group={id:'group_existing',title:'Nova Sharp Cuts — campaign review'};
 const client=createSenderMarketingClient({config,groupBinding,fetchImpl:async(_url,options)=>{
   if(options.method==='POST'){posts++;throw Error('ambiguous network failure');}
   return Response.json({data:visible?[group]:[],links:{next:null}});
 }});
 await assert.rejects(()=>client.prepareDedicatedGroup());await assert.rejects(()=>client.prepareDedicatedGroup());assert.equal(posts,1);
 visible=true;assert.equal((await client.prepareDedicatedGroup()).created,false);assert.equal(await client.audienceBinding(),group.id);assert.equal(posts,1);
});
test('incomplete or duplicate provider groups block creation',async()=>{
 for(const result of [{data:[],links:{next:'page2'}},{data:[{id:'one',title:'Nova Sharp Cuts — campaign review'},{id:'two',title:'Nova Sharp Cuts — campaign review'}]}]){
   let claimed=0;const client=createSenderMarketingClient({config,groupBinding:{read:async()=>null,claim:async()=>claimed++,save:async()=>{}},fetchImpl:async()=>Response.json(result)});
   await assert.rejects(()=>client.prepareDedicatedGroup());assert.equal(claimed,0);
 }
});
