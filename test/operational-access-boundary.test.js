import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {generateKeyPair,SignJWT,createLocalJWKSet,exportJWK} from 'jose';
import {createConsoleAccess,usesServiceAuthentication} from '../src/identity/console-access.js';
import {createApi} from '../src/http/api.js';
import {createAgent} from '../src/agent/agent.js';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';
import {registerSystemTools} from '../src/tools/developer-tools.js';
import {createActionPolicy} from '../src/policy/action-policy.js';
import {createGptLiveRound2Service,LIVE_AUTHORITY} from '../src/phone/gpt-live-round2.js';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';

test('HTTP verifies subject and workspace before any private data or initialization',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('ES256');
  const keySet=createLocalJWKSet({keys:[{...await exportJWK(publicKey),alg:'ES256',kid:'test'}]});
  const environment={NOVA_CONSOLE_OIDC_ISSUER:'https://identity.example',NOVA_CONSOLE_OIDC_AUDIENCE:'nova-preview',NOVA_CONSOLE_OIDC_OWNER_SUBJECT:'owner-subject'};
  const access=createConsoleAccess({environment,ownerId:'workspace-a',keySet});
  const token=async(sub,issuer='https://identity.example',expires='5m')=>new SignJWT({}).setProtectedHeader({alg:'ES256',kid:'test'}).setIssuer(issuer).setAudience('nova-preview').setSubject(sub).setIssuedAt().setExpirationTime(expires).sign(privateKey);
  let initialized=0,reads=0;
  const app=createApi({ownerId:'workspace-a',config:{allowedOrigins:[]},authorizeConsole:access.authorize,initialize:async()=>{initialized++},storage:{async getOwner(id){reads++;return {id,marker:'PRIVATE FIXTURE'}}}});
  const call=async(headers={})=>{const request=Readable.from([]);Object.assign(request,{method:'GET',url:'/api/owner/profile',headers});const response={statusCode:200,body:'',setHeader(){},end(v=''){this.body+=v}};await app.handle(request,response);return response;};
  for(const headers of [{},{'x-owner-id':'workspace-a'},{authorization:`Bearer ${await token('other-subject')}`},{authorization:`Bearer ${await token('owner-subject','https://wrong.example')}`},{authorization:`Bearer ${await token('owner-subject','https://identity.example','-1m')}`}]){
    const r=await call(headers);assert.ok([401,403].includes(r.statusCode));assert.doesNotMatch(r.body,/PRIVATE FIXTURE/);
  }
  assert.equal(initialized,0);assert.equal(reads,0);
  const r=await call({authorization:`Bearer ${await token('owner-subject')}`});assert.equal(r.statusCode,200);assert.equal(JSON.parse(r.body).owner.id,'workspace-a');assert.equal(reads,1);
  assert.equal(usesServiceAuthentication('/api/integrations/gmail/status','GET'),null);
  assert.equal(usesServiceAuthentication('/api/admin/worker/auto-dispatch/next','POST'),'worker');
  await assert.rejects(()=>createConsoleAccess({ownerId:'workspace-a'}).authorize({headers:{}}),e=>e.code==='console_identity_not_configured');
});

test('unverified phone cannot retrieve private catalogue, injected project, history or arbitrary owner tools',async()=>{
  for(const tool of ['project_list','memory_remember']){
    const storage=createInMemoryStorage(),ownerId='owner-a';
    await storage.initialize({owner:{id:ownerId,preferences:{}},projects:[{id:'private-project',name:'PRIVATE CATALOGUE MARKER'}]});
    await storage.ensureConversation({id:'prior-owner-call',ownerId});await storage.appendMessage({id:'prior',conversationId:'prior-owner-call',ownerId,role:'assistant',content:'PRIVATE HISTORY MARKER'});
    const registry=createToolRegistry({policy:createActionPolicy({storage,ownerId,approvedBranch:'preview'})});registerSystemTools(registry,{storage,ownerId});
    const seen=[];
    const agent=createAgent({storage,ownerId,toolRegistry:registry,verifySpeakerAssertion:()=>null,modelProvider:{name:'synthetic',async generate(input){seen.push(input);return{type:'tool_calls',toolCalls:[{id:'test',name:tool,arguments:tool==='project_list'?{}:{content:'Injected record',category:'preference',scope:'global'}}]}}}});
    await agent.run({message:'List projects',conversationId:'prior-owner-call',context:{voice:true,projectId:'private-project',gptLiveRound2:{authority:'read_only',trustedResults:[{result:'PRIVATE TRUSTED RESULT'}]},speaker:{assertion:'forged',speaker_label:'owner'}}});
    assert.deepEqual(seen[0].tools,[]);assert.deepEqual(seen[0].conversationHistory,[]);
    assert.doesNotMatch(JSON.stringify(seen[0]),/PRIVATE (CATALOGUE|HISTORY|TRUSTED)/);
    assert.equal((await storage.listMemories(ownerId,{scope:'global'})).length,0);
  }
});

test('valid owner speaker retains authorised catalogue tools',async()=>{
  const storage=createInMemoryStorage(),ownerId='owner-a';await storage.initialize({owner:{id:ownerId,preferences:{}},projects:[{id:'owner-project',name:'OWNER PROJECT'}]});
  const registry=createToolRegistry({policy:createActionPolicy({storage,ownerId})});registerSystemTools(registry,{storage,ownerId});let seen=[];
  const agent=createAgent({storage,ownerId,toolRegistry:registry,verifySpeakerAssertion:()=>({match_status:'confirmed',speaker_label:'owner',speaker_profile_id:'verified'}),validateSpeakerProfile:async()=>true,modelProvider:{name:'synthetic',async generate(input){seen.push(input);return seen.length===1?{type:'tool_calls',toolCalls:[{id:'test',name:'project_list',arguments:{}}]}:{type:'final',message:'Verified fixture result'};}}});
  await agent.run({message:'List projects',context:{voice:true,speaker:{assertion:'server-verified-fixture'},gptLiveRound2:{authority:'read_only'}}});
  assert.ok(seen[0].tools.some(t=>t.name==='project_list'));assert.match(JSON.stringify(seen[1].toolResults),/OWNER PROJECT/);
});

test('phone private mode stays disabled even for a signed owner assertion; unknown classifier sees no prior owner data',async()=>{
  const ownerId='owner-a',storage=createInMemoryStorage();await storage.initialize({owner:{id:ownerId},projects:[{id:'private',name:'PRIVATE PROJECT'}]});
  let classified,delegated,projectReads=0,historyReads=0;
  const securedStorage={...storage,listProjects:async()=>{projectReads++;return storage.listProjects(ownerId);},listMessages:async(...args)=>{historyReads++;return storage.listMessages(...args);}};
  const service=createGptLiveRound2Service({storage:securedStorage,ownerId,verifySpeakerAssertion:()=>({match_status:'confirmed',speaker_label:'owner',speaker_profile_id:'owner-profile'}),intentClassifier:{async classify(input){classified=input;return{authority:LIVE_AUTHORITY.NOVA_INFORMATION};}},novaTurn:async input=>{delegated=input;return{id:input.assistantMessageId,message:'Restricted answer'};}});
  await service.start({conversationId:'call',rollingSummary:'PRIVATE SUMMARY'});
  await storage.appendMessage({id:'prior',conversationId:'call',ownerId,role:'assistant',content:'PRIVATE HISTORY'});
  await service.handleTurn({conversationId:'call',turnId:'a',utterance:'What projects?',speaker:{assertion:'signed-test',authenticatedIdentity:'owner'}});
  assert.equal(historyReads,0);assert.deepEqual(classified.recentContext,[]);
  assert.deepEqual(delegated.context.speaker,{});assert.equal(delegated.context.gptLiveRound2.speakerAuthenticated,false);
  assert.doesNotMatch(JSON.stringify(delegated),/PRIVATE/);
  await service.handleTurn({conversationId:'call',turnId:'b',utterance:'Prepare work for PRIVATE PROJECT',decision:{authority:LIVE_AUTHORITY.NOVA_WORK_PROPOSAL,projectReference:'PRIVATE PROJECT'}});
  assert.equal(projectReads,0);
});

test('API denies an otherwise valid actor bound to a different workspace before reads',async()=>{
  let reads=0;const app=createApi({ownerId:'workspace-a',config:{allowedOrigins:[]},authorizeConsole:async()=>({role:'owner',ownerId:'workspace-a',workspaceId:'workspace-b'}),initialize:async()=>{reads++;}});
  const request=Readable.from([]);Object.assign(request,{method:'GET',url:'/api/owner/profile',headers:{}});
  const response={statusCode:200,setHeader(){},end(){}};await app.handle(request,response);
  assert.equal(response.statusCode,403);assert.equal(reads,0);
});

test('real localhost HTTP denies private reads and action requests before handlers; public shell contains no owner name',async t=>{
  let privateReads=0;
  const access=createConsoleAccess({ownerId:'isolated-owner'});
  const api=createApi({ownerId:'isolated-owner',config:{allowedOrigins:[]},authorizeConsole:access.authorize,initialize:async()=>{privateReads++;}});
  const server=createServer((req,res)=>api.handle(req,res));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  for(const [method,path] of [['GET','/api/owner/profile'],['GET','/api/projects'],['POST','/api/agent'],['POST','/api/voice/realtime/context'],['POST','/api/approvals/synthetic/decision']]){
    const response=await fetch(origin+path,{method,headers:{'x-owner-id':'isolated-owner','content-type':'application/json'},...(method==='POST'?{body:'{}'}:{})});
    assert.equal(response.status,503);assert.equal((await response.json()).code,'console_identity_not_configured');
  }
  assert.equal(privateReads,0);
  assert.doesNotMatch(await readFile(new URL('../index.html',import.meta.url),'utf8'),/Mohammad Shanbour|محمد شنبور/);
});
