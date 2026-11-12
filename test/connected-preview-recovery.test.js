import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createApi} from '../src/http/api.js';
import {createConversationHistory} from '../assets/conversation-history.js';
import {continuityPreviewEnvironment,CONNECTED_BRANCH,EXISTING_WORKSPACE_ENDPOINT,continuityRouteAllowed} from '../src/identity/continuity-preview.js';
import {PREVIEW_AUTH_URL} from '../src/identity/synthetic-preview.js';
import {registerProjectActivityReport} from '../src/tools/project-activity-report.js';
import {projectVoiceResult} from '../assets/voice-results.js';
import {createPreviewAuth} from '../src/identity/preview-auth.js';

test('original connected branch requires exact verified bindings and keeps outbound held',()=>{
 const env={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:CONNECTED_BRANCH,NOVA_CONTINUITY_PREVIEW:'true',NEON_AUTH_BASE_URL:PREVIEW_AUTH_URL,NOVA_PREVIEW_OWNER_EMAIL:'fixture@example.invalid',NOVA_PREVIEW_OWNER_SUBJECT:'fixture',DATABASE_URL:`postgres://fixture:fixture@${EXISTING_WORKSPACE_ENDPOINT}.c-2.eu-central-1.aws.neon.tech/neondb`};
 const r=continuityPreviewEnvironment(env);assert.equal(r.connected,true);assert.equal(r.environment.NOVA_SHARP_CUTS_WHATSAPP_OUTBOUND_ENABLED,'false');assert.equal(r.environment.NOVA_PHONE_PRIVATE_OWNER_ENABLED,'false');
 assert.throws(()=>continuityPreviewEnvironment({...env,VERCEL_ENV:'production'}));assert.throws(()=>continuityPreviewEnvironment({...env,NOVA_PREVIEW_OWNER_SUBJECT:''}));
 assert.equal(continuityRouteAllowed('/wa','POST',{connected:true}),true);assert.equal(continuityRouteAllowed('/api/social/publish','POST',{connected:true}),false);
});

async function call(api,url,method='GET',headers={}){const req=Readable.from(method==='POST'?['{}']:[]);Object.assign(req,{url,method,headers});const res={statusCode:200,setHeader(){},end(v){this.body=v;}};await api.handle(req,res);return {...res,data:JSON.parse(res.body)};}
test('history API pages oldest stored conversations, searches bodies, and never returns other owners',async()=>{
 const storage=createInMemoryStorage();await storage.initialize({owner:{id:'a'}});await storage.initialize({owner:{id:'b'}});
 for(let i=0;i<45;i++){await storage.ensureConversation({id:`a-${i}`,ownerId:'a',title:`Title ${i}`});await storage.appendMessage({conversationId:`a-${i}`,ownerId:'a',role:'user',content:i===0?'الزيتونة archived example':'fixture'});}
 await storage.ensureConversation({id:'b-private',ownerId:'b',title:'الزيتونة private'});
 let actor='a';const api=createApi({storage,ownerId:'a',config:{allowedOrigins:[]},initialize:async()=>{},authorizeConsole:async()=>({role:'owner',ownerId:actor,workspaceId:actor})});
 const first=await call(api,'/api/conversations');assert.equal(first.data.conversations.length,20);assert.equal(first.data.nextOffset,20);
 const second=await call(api,'/api/conversations?offset=20');const third=await call(api,'/api/conversations?offset=40');assert.equal(third.data.conversations.length,5);assert.equal(third.data.nextOffset,null);
 assert.equal(new Set([...first.data.conversations,...second.data.conversations,...third.data.conversations].map(c=>c.id)).size,45);
 const found=await call(api,'/api/conversations?q='+encodeURIComponent('الزيتونة'));assert.deepEqual(found.data.conversations.map(c=>c.id),['a-0']);
 actor='b';const denied=await call(api,'/api/conversations?q='+encodeURIComponent('الزيتونة'));assert.equal(denied.statusCode,403);assert.doesNotMatch(denied.body,/a-0|private/);
});
test('history changing search discards a stale load-more response',async()=>{
 let resolveMore;const api={conversations:async({query,offset})=>offset?new Promise(r=>resolveMore=r):{conversations:[{id:query||'initial',updatedAt:'2026-11-11'}],nextOffset:query?null:20}};
 const history=createConversationHistory({api,client:{},storage:{}});await history.refresh();const pending=history.more();await history.refresh({query:'new'});resolveMore({conversations:[{id:'stale'}],nextOffset:null});await pending;assert.deepEqual(history.conversations.map(c=>c.id),['new']);
});
test('authenticated worker poll with no released task leaves outbound channels held',async()=>{
 let writes=0;const api=createApi({ownerId:'a',connectedPreview:true,continuityPreview:true,config:{allowedOrigins:[],localWorkerToken:'fixture-worker'},authorizeConsole:()=>{throw Error('not a browser');},initialize:async()=>writes++,storage:{},autoDispatch:{async next(){return{dispatched:false};}}});
 const url='/api/admin/worker/auto-dispatch/next';const denied=await call(api,url,'POST');assert.notEqual(denied.statusCode,200);
 const held=await call(api,url,'POST',{'authorization':'Bearer fixture-worker','content-type':'application/json'});assert.equal(held.statusCode,200);assert.equal(held.data.dispatched,false);assert.deepEqual(held.data.channelPolling,[]);assert.equal(writes,1);
});
test('project activity analysis returns real scoped counts with attributable charts and refuses another project',async()=>{
 const storage=createInMemoryStorage();await storage.initialize({owner:{id:'a'},projects:[{id:'p',name:'Fixture'}]});await storage.appendActivity({ownerId:'a',projectId:'p',action:'read',status:'completed',summary:'test'});await storage.appendActivity({ownerId:'b',projectId:'other',action:'private',status:'failed',summary:'hidden'});
 let tool;registerProjectActivityReport({register:t=>tool=t},{storage,ownerId:'a'});const result=await tool.execute({projectId:'p'});assert.equal(result.recordedEvents,1);assert.deepEqual(result.charts[0].points,[{label:'completed',value:1}]);await assert.rejects(()=>tool.execute({projectId:'other'}));
 const projected=projectVoiceResult({runId:'real-fixture-receipt',conversationId:'c',toolCalls:[{name:tool.name,status:'completed',result}]},'c');assert.equal(projected.charts[0].points[0].value,1);assert.doesNotMatch(JSON.stringify(projected),/hidden/);
 assert.equal(projectVoiceResult({runId:'r',conversationId:'c',toolCalls:[{status:'completed',result:{charts:[{type:'bar',sourceIds:['unavailable'],points:[{label:'fake',value:99}]}]}}]},'c').charts,undefined);
});
test('public guest starts without private context; additional project grants still require owner reauthentication',async()=>{
 let user={id:'owner-subject',emailVerified:true};
 const environment={DATABASE_URL:'postgres://fixture:fixture@localhost/test',NOVA_PREVIEW_OWNER_EMAIL:'owner@example.invalid',NOVA_PREVIEW_OWNER_SUBJECT:'owner-subject'};
 const auth=createPreviewAuth({environment,workspaceId:'a',synthetic:false,proxy:async()=>new Response(JSON.stringify({user}),{status:200})});
 const approve=async()=>{const req=Readable.from([JSON.stringify({email:'owner@example.invalid',password:'synthetic-fixture-only'})]);Object.assign(req,{url:'/api/auth/approve-guest',method:'POST',headers:{host:'nova.test',origin:'https://nova.test','content-type':'application/json'}});const res={setHeader(){},getHeader(){},end(body){this.data=JSON.parse(body);}};await auth.handle(req,res);return res;};
 const approved=await approve();assert.equal(approved.statusCode,200);assert.equal(auth.verifyGuestGrant(approved.data.guestApproval),true);assert.equal(auth.verifyGuestGrant(approved.data.guestApproval+'x'),false);assert.equal(auth.verifyGuestGrant(null),false);
 user={id:'different-subject',emailVerified:true};assert.equal((await approve()).statusCode,403);
 let minted=0;const api=createApi({ownerId:'a',connectedPreview:true,continuityPreview:true,realtimeAccountContext:true,storage:{getOwner(){throw Error('Guest must not load owner profile');}},config:{allowedOrigins:[],maxBodyBytes:10000},initialize:async()=>{},authorizeConsole:async()=>({ownerId:'a',workspaceId:'a',role:'owner'}),realtimeVoiceService:{createClientSecret(input){minted++;assert.equal(input.guest,true);assert.equal(input.accountContext,undefined);assert.equal(input.guestProjectBrief,null);return{clientSecret:'synthetic'};}}});
 const req=Readable.from(['{"mode":"guest"}']);Object.assign(req,{url:'/api/voice/realtime/session',method:'POST',headers:{host:'nova.test',origin:'https://nova.test','content-type':'application/json'}});const res={setHeader(){},end(b){this.body=b;}};await api.handle(req,res);assert.equal(res.statusCode,201);assert.equal(minted,1);
});
