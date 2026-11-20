import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createWelcomeTest,WELCOME_TEST_RECIPIENT} from '../src/automation/sharp-cuts-welcome-test.js';
import {DEFAULT_WELCOME_COPY,welcomeEmailHtml} from '../src/automation/sharp-cuts-welcome-review.js';
import {createSenderMarketingClient,parseSharpCutsSenderConfig} from '../src/email/sender-marketing.js';
import {continuityToolAllowed} from '../src/identity/continuity-preview.js';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture({connected=true,ready=true,fail=false,projects=true,run=true}={}){
 const rows=new Map(),calls=[];
 const storage={getRun:async(id,owner)=>run&&owner==='test-owner'?{conversationId:'normal-chat'}:null,listProjects:async()=>projects?[{id:'sharp-cuts-web'}]:[],getActivity:async(id,owner)=>owner==='test-owner'?rows.get(id):null,appendActivity:async e=>{if(rows.has(e.id))throw Object.assign(Error('duplicate'),{code:'23505'});rows.set(e.id,e);}};
 const service=createWelcomeTest({storage,ownerId:'test-owner',connected,welcome:{read:async()=>({copy:DEFAULT_WELCOME_COPY,review:{id:'saved',creativeHash:hash(welcomeEmailHtml(DEFAULT_WELCOME_COPY))},preparation:{provider:{ready,submitted:0}}})},senderClient:{sendWelcomeTest:async input=>{calls.push(input);if(fail)throw Object.assign(Error('timeout'),{code:'sender_timeout'});return {accepted:true,status:'submitted',messageId:'synthetic-id',recipient:input.recipient};}}});
 return {service,rows,calls};
}
const input={recipient:WELCOME_TEST_RECIPIENT},context={runId:'run-1'};
test('normal Nova approval resumption derives conversation from owner-scoped run; concurrent and later requests send once',async()=>{
 const f=fixture();const r=await Promise.all([f.service.send(input,context),f.service.send(input,context)]);assert.equal(f.calls.length,1);assert.equal(f.rows.size,2);const receipt=await f.service.read();assert.equal(receipt.conversationId,'normal-chat');assert.equal(receipt.delivered,null);assert.equal(receipt.audienceMessages,0);assert.equal(receipt.messageId,'synthetic-id');assert.equal((await f.service.send(input,context)).reused,true);assert.equal(f.calls.length,1);
});
test('wrong recipient, nonconnected environment, foreign workspace, missing run and unsynced draft fail before claim',async()=>{
 for(const opts of [{connected:false},{ready:false},{projects:false},{run:false}]){const f=fixture(opts);await assert.rejects(f.service.send(input,context));assert.equal(f.calls.length,0);assert.equal(f.rows.size,0);}
 const f=fixture();await assert.rejects(f.service.send({recipient:'customer@example.test'},context));assert.equal(f.calls.length,0);
});
test('ambiguous provider result is retained and never automatically retried',async()=>{
 const f=fixture({fail:true});assert.equal((await f.service.send(input,context)).status,'outcome_unconfirmed');assert.equal((await f.service.send(input,context)).retryAllowed,false);assert.equal(f.calls.length,1);
});
test('provider request has one recipient, exact finished creative, no groups/subscribers/campaign sends',async()=>{
 const calls=[],config=parseSharpCutsSenderConfig({NOVA_SHARP_CUTS_SENDER_API_TOKEN:'synthetic'});
 const client=createSenderMarketingClient({config,fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({success:true,emailId:'synthetic-id'});}});
 const html=welcomeEmailHtml(DEFAULT_WELCOME_COPY),args={recipient:WELCOME_TEST_RECIPIENT,subject:'[TEST] Welcome',html,text:'Test'};
 await assert.rejects(client.sendWelcomeTest(args));assert.equal(calls.length,0);
 const receipt=await client.sendWelcomeTest(args,{authority:{operation:'welcome_single_test',projectId:'sharp-cuts-web',campaignId:'J6P5lD',recipient:WELCOME_TEST_RECIPIENT,creativeHash:hash(html)}});
 assert.equal(receipt.status,'submitted');assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.sender.net/v2/message/send');assert.deepEqual(calls[0].body.to,{email:WELCOME_TEST_RECIPIENT,name:'Sharp Cuts owner'});assert.equal(calls[0].body.groups,undefined);assert.match(calls[0].body.html,/logo_hq.jpg/);assert.match(calls[0].body.html,/unsubscribe_preview/);
 assert.equal(continuityToolAllowed({name:'sharp_cuts_welcome_test_send',riskLevel:'HIGH_IMPACT'},{connected:false}),false);assert.equal(continuityToolAllowed({name:'sharp_cuts_welcome_test_send',riskLevel:'HIGH_IMPACT'},{connected:true}),true);assert.equal(continuityToolAllowed({name:'sharp_cuts_campaign_send',riskLevel:'HIGH_IMPACT'},{connected:true}),false);
});
