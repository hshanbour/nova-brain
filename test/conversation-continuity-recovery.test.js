import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createMemoryLearningService} from '../src/memory/learning-service.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';
import {createActionPolicy} from '../src/policy/action-policy.js';
import {registerSystemTools} from '../src/tools/developer-tools.js';
import {createAgent} from '../src/agent/agent.js';
import {createApi} from '../src/http/api.js';
import {createRealtimeVoiceService} from '../src/voice/realtime-voice-service.js';
import {requirePrivateVoiceSpeaker} from '../src/voice/private-context-access.js';

async function fixture(){const storage=createInMemoryStorage();await storage.initialize({owner:{id:'owner-a',preferences:{replyLanguage:'ar'}},projects:[{id:'lantern',name:'Synthetic Lantern'}]});return storage;}
test('explicit archive recall reaches ended/old sessions, cites source and never reads another owner',async()=>{
 const storage=await fixture();
 for(const [id,ownerId,content] of [['old','owner-a','Synthetic Lantern decision: use violet.'],['other','owner-b','PRIVATE OTHER ACCOUNT Synthetic Lantern decision.']]){await storage.ensureConversation({id,ownerId});await storage.appendMessage({id:id+'-message',ownerId,conversationId:id,role:'user',content});}
 // More than the previous 20-conversation window; no active-session dependency.
 for(let i=0;i<25;i++)await storage.ensureConversation({id:'new-'+i,ownerId:'owner-a'});
 const registry=createToolRegistry({policy:createActionPolicy({storage,ownerId:'owner-a'})});registerSystemTools(registry,{storage,ownerId:'owner-a'});
 await assert.rejects(registry.execute('conversation_recall',{query:'Synthetic Lantern'},{ownerMessage:'Hello',conversationId:'new-1'}),/explicit request/);
 let evidence;
 const agent=createAgent({storage,ownerId:'owner-a',toolRegistry:registry,modelProvider:{name:'fixture',async generate(input){if(!input.toolResults?.length)return{type:'tool_calls',toolCalls:[{id:'recall',name:'conversation_recall',arguments:{query:'Synthetic Lantern'}}]};evidence=input.toolResults;return{type:'final',message:'Historical evidence read, not a current permission.'};}}});
 const result=await agent.run({message:'Recall our earlier conversation about Synthetic Lantern',conversationId:'fresh'});
 assert.match(JSON.stringify(evidence),/old-message/);assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE OTHER ACCOUNT/);assert.ok(result.runId);
 assert.equal((await storage.listMemories('owner-a')).length,0,'archive search does not create a memory');
});

test('voice decisions become review candidates only for a verified owner and retain exact provenance',async()=>{
 const storage=await fixture(),learning=createMemoryLearningService({storage,ownerId:'owner-a'});
 const input={message:'We decided Synthetic Lantern will use violet.',conversationId:'voice-session',userMessageId:'voice-user-1',assistantMessageId:'voice-answer-1'};
 await storage.ensureConversation({id:input.conversationId,ownerId:'owner-a'});
 await storage.appendMessage({id:input.userMessageId,conversationId:input.conversationId,ownerId:'owner-a',role:'user',content:input.message});
 assert.equal(await learning.observeVoiceTurn(input),null);
 const result=await learning.observeVoiceTurn({...input,verifiedOwner:true});
 assert.equal(result.candidate.evidence.channel,'voice');assert.equal(result.candidate.sourceMessageId,input.userMessageId);assert.equal(result.candidate.status,'pending');
 assert.equal((await storage.listMemories('owner-a')).length,0);
 assert.equal((await learning.observeVoiceTurn({...input,verifiedOwner:true})).created,false);
 await learning.reviewCandidate(result.candidate.id,{decision:'accepted'});
 assert.ok((await storage.listMemories('owner-a')).some(m=>m.content.includes('Synthetic Lantern')));
 assert.equal(await storage.getMemoryCandidate(result.candidate.id,'owner-b'),null);
});

test('private voice rejects unverified, expired/revoked/member identity and permits active owner only',async()=>{
 const args={speakerAssertions:{verify:a=>a==='valid'?{match_status:'confirmed',speaker_label:'owner',speaker_profile_id:'p'}:null},speakerIdentity:{get:async()=>({status:'active',relation:'owner'})}};
 for(const assertion of [null,'forged'])await assert.rejects(requirePrivateVoiceSpeaker({...args,assertion}),e=>e.code==='voice_owner_verification_required');
 await assert.rejects(requirePrivateVoiceSpeaker({...args,assertion:'valid',speakerIdentity:{get:async()=>({status:'revoked',relation:'owner'})}}));
 await assert.rejects(requirePrivateVoiceSpeaker({...args,assertion:'valid',speakerIdentity:{get:async()=>({status:'active',relation:'member'})}}));
 assert.equal((await requirePrivateVoiceSpeaker({...args,assertion:'valid'})).speaker_profile_id,'p');
});

test('protected session never preloads owner catalogue/history and guest mode has no tools',async()=>{
 let body;const service=createRealtimeVoiceService({apiKey:'test',fetchImpl:async(_,options)=>{body=JSON.parse(options.body);return Response.json({value:'ek_test'});}});
 const accountContext={replyLanguage:'ar',projects:[{name:'PRIVATE PROJECT'}],conversation:[{content:'PRIVATE HISTORY'}]};
 await service.createClientSecret({privacyGate:true,accountContext});assert.doesNotMatch(JSON.stringify(body),/PRIVATE PROJECT|PRIVATE HISTORY/);assert.equal(body.session.audio.input.turn_detection.create_response,false);
 await service.createClientSecret({privacyGate:true,guest:true,accountContext});assert.deepEqual(body.session.tools,[]);assert.doesNotMatch(JSON.stringify(body),/PRIVATE PROJECT|PRIVATE HISTORY/);assert.equal(body.session.audio.input.turn_detection.create_response,true);
});

test('HTTP private context denies unmatched voice before context read, even with signed-in account',async()=>{
 let reads=0;const app=createApi({ownerId:'owner-a',config:{allowedOrigins:[],maxBodyBytes:10000},initialize:async()=>{},authorizeConsole:async()=>({role:'owner',ownerId:'owner-a',workspaceId:'owner-a'}),realtimeAccountContext:true,storage:{getOwner:async()=>{reads++;return {id:'owner-a'};}},speakerAssertions:{verify:()=>null},logger:{info(){},error(){}}});
 const req=Readable.from([JSON.stringify({message:'list projects',context:{speaker:{assertion:'forged'}}})]);Object.assign(req,{method:'POST',url:'/api/voice/realtime/context',headers:{host:'nova.test',origin:'https://nova.test','content-type':'application/json'}});
 const res={statusCode:200,body:'',setHeader(){},end(v){this.body=v;}};await app.handle(req,res);assert.equal(res.statusCode,403);assert.equal(reads,0);
});
