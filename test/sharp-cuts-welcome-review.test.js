import test from 'node:test';
import assert from 'node:assert/strict';
import {createWelcomeReview,welcomeCosts,welcomeEmailHtml,DEFAULT_WELCOME_COPY,WELCOME_EVIDENCE} from '../src/automation/sharp-cuts-welcome-review.js';
import {SHARP_CUTS_EMAIL_SOURCE} from '../src/email/sharp-cuts-audience.js';
import {continuityRouteAllowed,continuityToolAllowed} from '../src/identity/continuity-preview.js';
function fixture({projects=[{id:'sharp-cuts-web'}],unavailable=false}={}){
 const events=[],calls=[];
 const service=createWelcomeReview({ownerId:'synthetic-owner',clock:()=>new Date('2026-11-20T12:00:00Z'),
  storage:{listProjects:async owner=>{assert.equal(owner,'synthetic-owner');return projects;},listActivity:async(owner,opts)=>{assert.equal(owner,'synthetic-owner');assert.equal(opts.projectId,'sharp-cuts-web');return [...events].reverse();},appendActivity:async e=>events.push(e)},
  customerReader:{snapshot:async()=>{if(unavailable)throw Error('offline');return {emailSource:{profileCount:1562,distinctProfileIds:1562,membershipHash:SHARP_CUTS_EMAIL_SOURCE.membershipHash},channels:{email:{verifiedEligible:0}}};}},
  senderClient:{inspectCampaignReadiness:async()=>{calls.push('GET readiness');return {groups:[{id:'test',active:0,total:0,boundToNova:true}]};}}});
 return {service,events,calls};
}
test('costs use actual mobile countries, marketing category and provider fee without counting top-up twice',()=>{
 const c=welcomeCosts();assert.equal(c.email.totalUsd,0);assert.equal(c.email.remainingEmails,14998);assert.equal(c.whatsapp.messages,1312);assert.equal(c.whatsapp.totalUsd,84.7287);assert.equal(c.whatsapp.additionalCreditUsd,74.7357);assert.equal(c.whatsapp.minimumBatches,6);assert.equal(c.whatsapp.destinations.reduce((n,r)=>n+r.count,0),1312);
});
test('validity does not grant consent or WhatsApp reachability; live membership and unavailable sources remain distinct',async()=>{
 const f=fixture(),r=await f.service.read();assert.equal(r.reconciliation.membershipStatus,'matched');assert.equal(r.audience.emailLaunchEligible,null);assert.equal(r.audience.whatsappLaunchEligible,null);assert.match(r.audience.whatsappReachability,/Not checked/);assert.equal(r.approval.launchEnabled,false);assert.equal(r.results.delivered,null);assert.equal(r.results.submitted,null);assert.equal(r.preparation.ready,false);assert.equal(f.events.length,0);
 const failed=await fixture({unavailable:true}).service.read();assert.equal(failed.reconciliation.membershipStatus,'unavailable');assert.match(failed.approval.blocks[0],/could not be confirmed/);
});
test('save is durable, idempotent, owner/project scoped and cannot schedule or call sending APIs',async()=>{
 const f=fixture();const a=await f.service.save({channel:'email'});const b=await f.service.save({channel:'email'});assert.equal(f.events.length,1);assert.equal(b.reused,true);assert.equal(a.review.sendAuthorised,false);assert.equal(a.messagesSent,0);assert.equal(a.contactsChanged,0);
 const fresh=await f.service.read();assert.equal(fresh.review.hash,a.review.hash);assert.equal(fresh.copy.bookingUrl,DEFAULT_WELCOME_COPY.bookingUrl);assert.ok(f.calls.every(v=>v==='GET readiness'));
 const changed=await f.service.save({channel:'email',subject:'A different welcome'});assert.notEqual(a.review.hash,changed.review.hash);assert.equal((await f.service.read()).copy.subject,'A different welcome');
});
test('foreign workspace and invalid schedule cannot save a draft',async()=>{
 const f=fixture({projects:[]});await assert.rejects(f.service.read(),/workspace access/);await assert.rejects(f.service.save({channel:'email'}),/workspace access/);assert.equal(f.events.length,0);
 await assert.rejects(fixture().service.save({channel:'email',proposedAt:'2026-01-01'}),/future proposed/);
 await assert.rejects(fixture().service.save({channel:'sms'}),/campaign channel/);
});
test('creative escapes editable copy, preserves team link, real unsubscribe token and authentic branded assets',()=>{
 const html=welcomeEmailHtml({...DEFAULT_WELCOME_COPY,emailBody:'<script>bad()</script>'});assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/p20zttw0/);assert.match(html,/\{\$unsubscribe_link\}/);assert.match(html,/cdn.sender.net\/email_images\/493660\/images\/0\/logo_hq.jpg/);assert.match(html,/wa.me\/441582510565/);assert.match(html,/Book with the Sharp Cuts Team/);assert.equal(WELCOME_EVIDENCE.distinctValidPhones-WELCOME_EVIDENCE.nonMobile,1312);
});
test('new write boundary permits preparation only on connected Preview',()=>{
 assert.equal(continuityRouteAllowed('/api/business-automation/sharp-cuts/welcome-review','POST',{connected:true}),true);
 assert.equal(continuityRouteAllowed('/api/business-automation/sharp-cuts/welcome-review','POST',{connected:false}),false);
 assert.equal(continuityRouteAllowed('/api/business-automation/sharp-cuts/welcome-review/send','POST',{connected:true}),false);
 assert.equal(continuityToolAllowed({name:'sharp_cuts_welcome_review_save',riskLevel:'LOW_RISK_WRITE'},{connected:true}),true);
 assert.equal(continuityToolAllowed({name:'sharp_cuts_campaign_send',riskLevel:'HIGH_IMPACT'},{connected:true}),false);
});

test('owner creative test verifies only the saved draft without scanning any customers',async()=>{
 let checks=0;const saved={id:'saved',projectId:'sharp-cuts-web',copy:DEFAULT_WELCOME_COPY};
 const forbidden=async()=>{throw Error('customer inventory must not run');};
 const svc=createWelcomeReview({ownerId:'owner',storage:{listProjects:async()=>[{id:'sharp-cuts-web'}],listActivity:async()=>[{action:'sharp_cuts_welcome_review_saved',metadata:{review:saved}}]},customerReader:{snapshot:forbidden},senderClient:{inspectSuppressionReadiness:forbidden,inspectCampaignReadiness:forbidden,inspectPreparedCampaign:async args=>{checks++;assert.equal(args.campaignId,'J6P5lD');assert.match(args.html,/logo_hq/);return {ready:true,submitted:0};}}});
 const result=await svc.readTestPreparation();assert.equal(result.review.id,'saved');assert.equal(result.preparation.provider.ready,true);assert.equal(checks,1);
});
