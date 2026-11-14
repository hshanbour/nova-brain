import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {registerBusinessPreparationTools} from '../src/automation/business-preparation-tools.js';
import {createProjectService} from '../src/projects/project-service.js';
import {createPreviewAuth} from '../src/identity/preview-auth.js';
import {createRealtimeVoiceService} from '../src/voice/realtime-voice-service.js';
test('business tool names do not introduce a second Sharp Cuts project',async()=>{
 const service=createProjectService({ownerId:'fixture',storage:{listProjects:async()=>[{id:'sharp-cuts-web',name:'Sharp Cuts Web'},{id:'sharp-cuts',name:'Sharp Cuts'}]}});
 assert.equal((await service.resolve({message:'For Sharp Cuts Web, run sharp_cuts_email_provider_review and sharp_cuts_email_drafts.'})).project.id,'sharp-cuts-web');
 assert.equal((await service.resolve({message:'Compare Sharp Cuts Web and Sharp Cuts.'})).status,'multiple');
});
test('campaign draft uses current aggregates, stores copy/approval boundaries and cannot send',async()=>{
 const tools=new Map(),events=[];let probes=0;
 registerBusinessPreparationTools({register:t=>tools.set(t.name,t)},{ownerId:'fixture',storage:{appendActivity:async e=>events.push(e)},senderConfig:{groupId:'dedicated'},senderClient:{probe:async()=>{probes++;return{connected:true};}},customerReader:{snapshot:async()=>({source:'neon_select_only_aggregate',uniqueProfiles:3,channels:{email:{contactCandidates:2,verifiedEligible:0,status:'blocked_evidence_incomplete'}}})},whatsapp:{}});
 const draft=await tools.get('sharp_cuts_email_draft_prepare').execute({subject:'Welcome back',body:'Book when it suits you.'},{conversationId:'test'});
 assert.equal(probes,1);assert.equal(draft.verifiedEligible,0);assert.equal(draft.sendingEnabled,false);assert.equal(draft.contactsUploaded,0);assert.equal(draft.delivery.delivered,0);assert.match(draft.copy.bookingUrl,/p20zttw0/);assert.match(draft.copy.unsubscribe,/validated/);assert.equal(events[0].projectId,'sharp-cuts-web');assert.ok(draft.blocks.includes('No verified eligible audience available'));
});
test('explicit repository project wins over business subject while foreign IDs grant no access',async()=>{
 const service=createProjectService({ownerId:'owner',storage:{listProjects:async()=>[{id:'nova-brain',name:'Nova Brain'},{id:'sharp-cuts',name:'Sharp Cuts'}]}});
 assert.equal((await service.resolve({message:'For project nova-brain document the Sharp Cuts path'})).project.id,'nova-brain');
 assert.equal((await service.resolve({message:'Nova Brain (project ID nova-brain). Sharp Cuts is only subject matter.'})).project.id,'nova-brain');
 assert.equal((await service.resolve({message:'project other-owner-private'})).project,null);
});

test('saved campaign review retrieves only owner-scoped Sharp Cuts drafts without provider writes',async()=>{
 const tools=new Map();registerBusinessPreparationTools({register:t=>tools.set(t.name,t)},{ownerId:'owner',storage:{listActivity:async(id,options)=>{assert.equal(id,'owner');assert.equal(options.projectId,'sharp-cuts-web');return[{action:'sharp_cuts_email_review_draft_prepared',metadata:{draft:{id:'review',projectId:'sharp-cuts-web',copy:{body:'Saved copy'}}}},{action:'other',metadata:{draft:{projectId:'other'}}}];}},whatsapp:{}});
 const result=await tools.get('sharp_cuts_email_drafts').execute();assert.equal(result.drafts.length,1);assert.equal(result.drafts[0].copy.body,'Saved copy');assert.equal(result.sendingEnabled,false);
});
test('guest project scope requires fresh owner credentials and signed exact project binding',async()=>{
 let verified=true,lookups=0;
 const auth=createPreviewAuth({environment:{DATABASE_URL:'postgres://fixture:fixture@localhost/test',NOVA_PREVIEW_OWNER_EMAIL:'owner@example.invalid',NOVA_PREVIEW_OWNER_SUBJECT:'owner'},workspaceId:'workspace',synthetic:false,resolveGuestProject:async id=>{lookups++;return id==='permitted';},proxy:async({request})=>{const body=await request.json();assert.equal(body.projectId,undefined);return Response.json({user:{id:verified?'owner':'stranger',emailVerified:true}});}});
 const approve=async projectId=>{const req=Readable.from([JSON.stringify({email:'owner@example.invalid',password:'synthetic',projectId})]);Object.assign(req,{url:'/api/auth/approve-guest',method:'POST',headers:{host:'nova.test',origin:'https://nova.test','content-type':'application/json'}});const res={setHeader(){},end(b){this.data=JSON.parse(b);}};await auth.handle(req,res);return res;};
 const ok=await approve('permitted');assert.equal(ok.statusCode,200);assert.equal(auth.readGuestGrant(ok.data.guestApproval).projectId,'permitted');assert.equal(auth.readGuestGrant(ok.data.guestApproval+'x'),false);
 assert.equal((await approve('other-workspace')).statusCode,403);
 verified=false;const before=lookups;assert.equal((await approve('permitted')).statusCode,403);assert.equal(lookups,before);
});
test('project guest receives one brief and no owner memory, history or tools',async()=>{
 let request;
 const service=createRealtimeVoiceService({apiKey:'synthetic',fetchImpl:async(_url,options)=>{request=JSON.parse(options.body);return Response.json({value:'ek_test'});}});
 await service.createClientSecret({guest:true,accountContext:{replyLanguage:'ar',projects:[{name:'OTHER PRIVATE PROJECT'}],memories:['SECRET MEMORY'],conversation:['SECRET HISTORY']},guestProjectBrief:{id:'selected',name:'Selected project',description:'Approved brief'}});
 assert.deepEqual(request.session.tools,[]);assert.match(request.session.instructions,/Approved brief/);assert.doesNotMatch(request.session.instructions,/OTHER PRIVATE PROJECT|SECRET MEMORY|SECRET HISTORY/);
});
