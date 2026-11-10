import test from 'node:test';
import assert from 'node:assert/strict';
import {continuityPreviewEnvironment,continuityRouteAllowed,continuityToolAllowed,CONTINUITY_BRANCH,EXISTING_WORKSPACE_BRANCH,EXISTING_WORKSPACE_ENDPOINT} from '../src/identity/continuity-preview.js';
import {PREVIEW_AUTH_URL} from '../src/identity/synthetic-preview.js';
import {workspaceActor} from '../src/identity/preview-auth.js';
import {createPostgresStorage} from '../src/storage/postgres-storage.js';
const env={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:CONTINUITY_BRANCH,NOVA_CONTINUITY_PREVIEW:'true',NEON_AUTH_BASE_URL:PREVIEW_AUTH_URL,NOVA_PREVIEW_OWNER_EMAIL:'owner@example.invalid',NOVA_PREVIEW_OWNER_SUBJECT:'subject-owner',DATABASE_URL:`postgresql://fixture:fixture@${EXISTING_WORKSPACE_ENDPOINT}.c-2.eu-central-1.aws.neon.tech/neondb`};
test('continuity binds one Preview branch and disables consequential paths',()=>{
 const result=continuityPreviewEnvironment(env);assert.equal(result.continuity,true);assert.equal(result.environment.NOVA_PHONE_PRIVATE_OWNER_ENABLED,'false');assert.equal(result.environment.NOVA_SHARP_CUTS_WHATSAPP_EXECUTION_ENABLED,'false');
 for(const change of [{VERCEL_ENV:'production'},{NEON_AUTH_BASE_URL:'https://other.invalid'},{NOVA_PREVIEW_OWNER_SUBJECT:''},{DATABASE_URL:'postgresql://fixture:fixture@other.invalid/neondb'}])assert.throws(()=>continuityPreviewEnvironment({...env,...change}));
 for(const [path,method] of [['/api/admin/worker/next','GET'],['/api/internal/phone/call','POST'],['/wa','POST'],['/api/social/publish','POST']])assert.equal(continuityRouteAllowed(path,method),false);
 assert.equal(continuityRouteAllowed('/api/agent','POST'),true);assert.equal(continuityToolAllowed({name:'send',riskLevel:'SENSITIVE_WRITE'}),false);
});
test('verified subject maps to owner workspace; another verified account or replaced subject cannot',()=>{
 const session={user:{id:'subject-owner',email:'owner@example.invalid',emailVerified:true},session:{userId:'subject-owner',expiresAt:new Date(Date.now()+60000).toISOString()}};
 assert.equal(workspaceActor(session,env,'real-owner').ownerId,'real-owner');
 for(const user of [{id:'other',email:'other@example.invalid',emailVerified:true},{id:'other',email:'owner@example.invalid',emailVerified:true},{...session.user,emailVerified:false}])assert.throws(()=>workspaceActor({...session,user,session:{...session.session,userId:user.id}},env,'real-owner'));
});
test('existing workspace bootstrap performs SELECT only, no migration, seed, or owner mutation',async()=>{
 for(const valid of [true,false]){
  const calls=[];const storage=createPostgresStorage({sqlClient:{async query(sql,params){calls.push({sql,params});return [{branch:valid?EXISTING_WORKSPACE_BRANCH:'wrong',endpoint:EXISTING_WORKSPACE_ENDPOINT,owner_exists:true}];}}});
  const promise=storage.initialize({owner:{id:'real-owner'},existingWorkspaceOnly:{branch:EXISTING_WORKSPACE_BRANCH,endpoint:EXISTING_WORKSPACE_ENDPOINT}});
  if(valid)await promise;else await assert.rejects(promise,/binding/);
  assert.equal(calls.length,1);assert.match(calls[0].sql,/^SELECT /);assert.deepEqual(calls[0].params,['real-owner']);
 }
});
