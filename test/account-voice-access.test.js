import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createAccountVoiceAccess,accountVoiceEvidence,ACCOUNT_VOICE_CONSENT} from '../src/voice/account-voice-access.js';
import {createApi} from '../src/http/api.js';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createAgent} from '../src/agent/agent.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';

const key='test-only-purpose-separated-signing-key-1234567890';
test('Brain grants account-authorised work without claiming a voice match; forged context remains public',async()=>{
 const ownerId='test-account',storage=createInMemoryStorage();await storage.initialize({owner:{id:ownerId,preferredName:'Test Owner'}});
 const tools=createToolRegistry();tools.register({name:'project_test_read',riskLevel:'READ_ONLY',async execute(){return{ok:true};}});
 const observed=[],agent=createAgent({ownerId,storage,toolRegistry:tools,modelProvider:{name:'fixture',async generate(input){observed.push(input);return{type:'final',message:'A bounded fixture answer.'};}}});
 await agent.run({message:'Please help with a project task',context:{voice:true,speaker:{access_source:'signed_in_account_session'},verifiedAccountVoice:true}});
 assert.equal(observed.at(-1).tools.length,0);
 await agent.run({verifiedAccountVoice:true,message:'Please help with a project task',context:{voice:true}});
 assert.ok(observed.at(-1).tools.some(t=>t.name==='project_test_read'));
 assert.match(JSON.stringify(observed.at(-1)),/ACCOUNT-AUTHORISED VOICE/);
 const identity=await agent.run({verifiedAccountVoice:true,message:'How did you recognize me?',context:{voice:true}});
 assert.match(identity.message,/account.*not a voice match/i);
});
test('account permission is scoped, expiring, tamper-resistant and never a voice match',()=>{
 let now=1000;const grants=createAccountVoiceAccess({key,ownerId:'a',clock:()=>now}),session_id=randomUUID(),accountGrant=grants.issue(session_id);
 assert.equal(grants.verify({session_id,accountGrant}),true);
 assert.equal(grants.verify({session_id:randomUUID(),accountGrant}),false);
 assert.equal(createAccountVoiceAccess({key,ownerId:'b',clock:()=>now}).verify({session_id,accountGrant}),false);
 assert.equal(grants.verify({session_id,accountGrant:accountGrant.slice(0,-4)+'xxxx'}),false);
 now+=1800001;assert.equal(grants.verify({session_id,accountGrant}),false);
 assert.equal(accountVoiceEvidence({preferredName:'Test'}).voiceMatched,false);
});

test('real API boundary requires account, consent, session and current turn; rejects replay, guests and other accounts',async()=>{
 const storage=createInMemoryStorage(),ownerId='fixture';await storage.initialize({owner:{id:ownerId}});
 let actor=ownerId;const calls=[];
 const api=createApi({connectedPreview:true,ownerId,storage,initialize:async()=>{},config:{allowedOrigins:[],maxBodyBytes:12000,speakerRecognition:{assertionKey:key}},authorizeConsole:async()=>({role:'owner',ownerId:actor,workspaceId:actor}),realtimeVoiceService:{async createClientSecret(){return{clientSecret:'fake',isolatedTurns:true,privacyGate:true};}},agent:{async run(input){calls.push(input);return{message:'fixture'};}},logger:{info(){},error(){}}});
 async function post(url,body){const req=Object.assign(Readable.from([JSON.stringify(body)]),{url,method:'POST',headers:{host:'nova.test',origin:'https://nova.test','content-type':'application/json'}}),res={setHeader(){},end(body){this.body=body;}};await api.handle(req,res);return{status:res.statusCode,data:JSON.parse(res.body)};}
 const session=await post('/api/voice/realtime/session',{mode:'owner',accountConsent:ACCOUNT_VOICE_CONSENT});assert.equal(session.status,201);assert.ok(session.data.accountGrant);
 const speaker={accountGrant:session.data.accountGrant,session_id:session.data.sessionId,turn_seq:1,turn_id:randomUUID()};
 await post('/api/voice/realtime/turn-state',{op:'begin',...speaker});
 const authorised=await post('/api/voice/realtime/authorize-turn',{speaker,turnId:speaker.turn_id});assert.equal(authorised.status,200);assert.equal(authorised.data.speakerIdentity.voiceMatched,false);
 const body={message:'Save a harmless test',context:{voice:true,speaker}};
 assert.equal((await post('/api/agent',body)).status,200);assert.equal(calls[0].verifiedAccountVoice,true);
 assert.equal((await post('/api/agent',body)).status,409);
 actor='different';assert.equal((await post('/api/voice/realtime/authorize-turn',{speaker,turnId:speaker.turn_id})).status,403);actor=ownerId;
 const guest=await post('/api/voice/realtime/session',{mode:'guest',accountConsent:ACCOUNT_VOICE_CONSENT});assert.equal(guest.data.accountGrant,undefined);
 assert.equal((await post('/api/voice/realtime/authorize-turn',{speaker,turnId:speaker.turn_id})).status,409);
 const strict=await post('/api/voice/realtime/session',{mode:'owner'});assert.equal(strict.data.accountGrant,undefined);
 const forged={...speaker,session_id:strict.data.sessionId,turn_id:randomUUID(),accountGrant:'fake'};
 await post('/api/voice/realtime/turn-state',{op:'begin',...forged});
 assert.equal((await post('/api/agent',{...body,verifiedAccountVoice:true,context:{voice:true,verifiedAccountVoice:true,speaker:forged}})).status,403);
 assert.equal(calls.length,1);
});
