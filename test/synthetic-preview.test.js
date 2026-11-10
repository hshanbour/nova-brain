import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {syntheticPreviewEnvironment,SYNTHETIC_SEED,SYNTHETIC_OWNER_ID,PREVIEW_GIT_BRANCH,PREVIEW_NEON_BRANCH,PREVIEW_ENDPOINT,PREVIEW_AUTH_URL,syntheticRouteAllowed} from '../src/identity/synthetic-preview.js';
import {workspaceActor,createPreviewAuth} from '../src/identity/preview-auth.js';
import {createPostgresStorage} from '../src/storage/postgres-storage.js';
import {createApi} from '../src/http/api.js';
import {createToolRegistry} from '../src/tools/tool-registry.js';
import {createApp} from '../src/app.js';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
const env={NOVA_SYNTHETIC_PREVIEW:'true',VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:PREVIEW_GIT_BRANCH,NOVA_SYNTHETIC_DATABASE_URL:`postgresql://test:fixture-password@${PREVIEW_ENDPOINT}.c-16.us-east-1.aws.neon.tech/neondb?sslmode=require`,NEON_AUTH_BASE_URL:PREVIEW_AUTH_URL,NOVA_PREVIEW_OWNER_EMAIL:'owner@example.invalid'};
const session=(email='owner@example.invalid',verified=true)=>({user:{id:email,email,emailVerified:verified},session:{userId:email,expiresAt:new Date(Date.now()+60000).toISOString()}});
const req=(path,method='GET',headers={})=>Object.assign(Readable.from([]),{url:path,method,headers});
const res=()=>({statusCode:200,body:'',headers:{},setHeader(k,v){this.headers[k]=v},getHeader(k){return this.headers[k]},end(v=''){this.body+=v}});
test('synthetic environment drops every inherited credential and send switch',()=>{
 const p=syntheticPreviewEnvironment({...env,DATABASE_URL:'PRIVATE',OPENAI_API_KEY:'PRIVATE',GUPSHUP_API_KEY:'PRIVATE',NOVA_LOCAL_WORKER_TOKEN:'PRIVATE',POSTGRES_URL:'PRIVATE',NEW_PROVIDER_SECRET:'PRIVATE',NOVA_SHARP_CUTS_WHATSAPP_OUTBOUND_ENABLED:'true'});
 assert.ok(!Object.values(p.environment).includes('PRIVATE'));assert.equal(p.environment.NOVA_BRAIN_MODEL_PROVIDER,'mock');assert.equal(p.environment.NOVA_SHARP_CUTS_WHATSAPP_OUTBOUND_ENABLED,'false');
 assert.doesNotMatch(JSON.stringify(SYNTHETIC_SEED),/Shanbour|Sharp Cuts|Plumber Growth|Luton/);
});
test('synthetic boot refuses Production, wrong Git branch, wrong database and Auth',()=>{
 for(const patch of [{VERCEL_ENV:'production'},{VERCEL_GIT_COMMIT_REF:'main'},{NOVA_SYNTHETIC_DATABASE_URL:env.NOVA_SYNTHETIC_DATABASE_URL.replace(PREVIEW_ENDPOINT,'ep-production')},{NEON_AUTH_BASE_URL:'https://other.example'},{NOVA_SYNTHETIC_PREVIEW:'false'}])assert.throws(()=>syntheticPreviewEnvironment({...env,...patch}));
});
test('database identity is checked before any migration statement',async()=>{
 let queries=[];const storage=createPostgresStorage({sqlClient:{query:async sql=>{queries.push(sql);return [{branch:'wrong',endpoint:PREVIEW_ENDPOINT}]}}});
 await assert.rejects(storage.initialize({...SYNTHETIC_SEED,syntheticGuard:true}),/identity verification/);assert.equal(queries.length,1);assert.match(queries[0],/^SELECT/);
});
test('owner requires upstream verified email, matching subject, valid session and expiry',()=>{
 assert.equal(workspaceActor(session(),env).workspaceId,SYNTHETIC_OWNER_ID);
 for(const s of [null,session('other@example.invalid'),session('owner@example.invalid',false),{...session(),session:{userId:'other',expiresAt:new Date(Date.now()+60000)}},{...session(),session:{userId:'owner@example.invalid',expiresAt:'invalid'}}])assert.throws(()=>workspaceActor(s,env));
 assert.throws(()=>workspaceActor(session(),{...env,NOVA_PREVIEW_OWNER_SUBJECT:'different'}));
});
test('server revalidates session upstream and ignores forged identity headers',async()=>{
 let called=0;const auth=createPreviewAuth({environment:syntheticPreviewEnvironment(env).environment,serverFactory:()=>({getSession:async options=>{called++;assert.equal(options.query.disableCookieCache,'true');return {data:session()}}})});
 await assert.rejects(auth.authorize(req('/api/projects','GET',{'x-owner-id':SYNTHETIC_OWNER_ID})));assert.equal(called,0);
 assert.equal((await auth.authorize(req('/api/projects','GET',{cookie:'fixture'}))).workspaceId,SYNTHETIC_OWNER_ID);assert.equal(called,1);
});
test('phone, webhook, worker, approval and send routes denied before auth or initialization',async()=>{
 let reads=0;const api=createApi({syntheticPreview:true,config:{allowedOrigins:[]},initialize:async()=>reads++,authorizeConsole:async()=>{reads++}});
 for(const path of ['/api/admin/worker/poll','/api/admin/scheduler/social/tick','/api/phone/bridge/session/start','/wa','/api/integrations/sharp-cuts/whatsapp/webhook','/api/approvals/a','/api/voice/realtime/session']){const response=res();await api.handle(req(path,'POST'),response);assert.equal(response.statusCode,403);}
 assert.equal(reads,0);
});
test('owner and other isolated identities are separated before synthetic reads',async()=>{
 let reads=0;const api=createApi({syntheticPreview:true,ownerId:SYNTHETIC_OWNER_ID,config:{allowedOrigins:[]},initialize:async()=>reads++,authorizeConsole:async r=>workspaceActor(session(r.headers.testemail),env),storage:{getOwner:async()=>SYNTHETIC_SEED.owner}});
 const other=res();await api.handle(req('/api/owner/profile','GET',{testemail:'other@example.invalid'}),other);assert.equal(other.statusCode,403);assert.equal(reads,0);
 const owner=res();await api.handle(req('/api/owner/profile','GET',{testemail:'owner@example.invalid'}),owner);assert.equal(owner.statusCode,200);assert.match(owner.body,/Synthetic Preview Owner/);assert.equal(reads,1);
});
test('disabled registry cannot execute even read-only network tools or approved sends',async()=>{
 let calls=0;const registry=createToolRegistry({disabled:true});registry.register({name:'send',execute:async()=>calls++});await assert.rejects(registry.execute('send',{}, {approvalId:'approved'}),/disabled/);assert.equal(calls,0);
});
test('actual app initialization seeds only fictional data',async()=>{
 const storage=createInMemoryStorage();const app=createApp({environment:env,storage});await app.initialize();assert.equal((await storage.getOwner(SYNTHETIC_OWNER_ID)).fullName,'Synthetic Preview Owner');assert.equal(await storage.getOwner('owner_mohammad_shanbour'),null);assert.deepEqual((await storage.listProjects(SYNTHETIC_OWNER_ID)).map(p=>p.id),['synthetic-lantern']);
});
test('only synthetic memory mutations are enabled',()=>{
 assert.equal(syntheticRouteAllowed('/api/memories/test','PATCH'),true);assert.equal(syntheticRouteAllowed('/api/projects/import','POST'),false);assert.equal(syntheticRouteAllowed('/api/integrations/sender','GET'),false);
});
