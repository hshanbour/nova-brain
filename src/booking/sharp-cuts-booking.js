import {randomUUID,randomBytes} from 'node:crypto';
import {SHARP_CUTS_BOOKING_URL,SHARP_CUTS_VERIFIED_SERVICES} from '../automation/sharp-cuts-campaign.js';
import {createAppointmentWorkflow,createBookingLinks,syntheticBookingProvider,reminderEligibility} from './appointment-workflow.js';

export const SHARP_CUTS_PUBLIC_BOOKING_PROFILE=Object.freeze({
  businessName:'Sharp Cuts Gents Barbers',address:'57 Cheapside, Luton LU1 2HN',phone:'+441582510565',bookingSystem:'Fresha',bookingUrl:SHARP_CUTS_BOOKING_URL,
  serviceCatalogue:{source:'Fresha service catalogue; manually reviewed, not a live feed',observedDate:'2026-11-20',services:SHARP_CUTS_VERIFIED_SERVICES},
  team:{names:['Abu yasser','Hamood','Rovand'],source:'Fresha calendar observed 2026-11-20; not a staff availability feed'},timeZone:'Europe/London',
  bookingCapabilities:{liveAvailability:false,create:false,confirm:false,reschedule:false,cancel:false},
  conversationGuidance:'Use this conversation to understand the service, preferred barber and desired day/time. Ask only for missing details, remember corrections and offer alternatives only when supported by live availability. We cannot check live slots or write bookings yet. Clearly say this and offer the official team booking link or shop phone. Existing bookings must be managed through the customer’s authenticated Fresha account. Never claim a time is available, or a booking is created, confirmed, changed or cancelled. Do not collect payment details, passwords, verification codes or unnecessary personal details. Never claim a booking request has been sent to staff. No owner context or private tools.',
  limitations:['Opening hours and individual shifts have not been verified for this assistant.','Prices are a manually reviewed catalogue, not a live quote. Fresha confirms the final price.','Customer identity and booking ownership cannot currently be verified by this assistant.']
});

export const BOOKING_RULES=Object.freeze([
  {id:'appointment-24h',purpose:'appointment',channel:'email',enabled:false,hoursBefore:24,maxPerBookingVersion:1,label:'Appointment reminder — 24 hours before'},
  {id:'recorded-no-show',purpose:'no_show',channel:'email',enabled:false,hoursAfter:24,maxPerBookingVersion:1,label:'Recorded no-show — review before follow-up'},
  {id:'return-visit',purpose:'return_visit',channel:'email',enabled:false,daysAfter:45,maxPerCustomerDays:30,label:'Return visit — completed visit + marketing permission required'}
]);

export async function runBookingRehearsal(){
  const checks=[],identity={verified:true,projectId:'sharp-cuts-web',customerId:'test-customer'};
  const check=async(name,fn)=>{try{const detail=await fn();checks.push({name,result:'passed',detail:detail||'Synthetic contract check passed.'});}catch(e){checks.push({name,result:'failed',detail:e.code||e.message});}};
  const expect=condition=>{if(!condition)throw Error('Expectation failed.');};
  const rejects=async(fn,code)=>{try{await fn();}catch(e){expect(e.code===code);return;}throw Error('Expected rejection: '+code);};
  const provider=syntheticBookingProvider(),flow=createAppointmentWorkflow(provider);
  const proposal=await flow.propose(identity,{bookingId:'test-booking',desiredAt:'2030-01-09T10:00:00Z'});
  const input={action:'reschedule',bookingId:'test-booking',expectedVersion:1,slot:proposal.slots[0],idempotencyKey:'test-reschedule-001',confirmed:true};
  let receipt;
  await check('Preserve service, duration and preferred barber',()=>{expect(proposal.service.durationMinutes===25&&proposal.slots.every(s=>s.barberId==='test-barber-a'));});
  await check('Require customer confirmation',()=>rejects(()=>flow.commit(identity,{...input,confirmed:false}),'confirmation_required'));
  await check('Require agreement before changing barber',()=>rejects(()=>flow.commit(identity,{...input,slot:proposal.alternatives[0]}),'barber_agreement_required'));
  await check('Reschedule and read back the exact booking',async()=>{receipt=await flow.commit(identity,input);expect(receipt.booking.start===input.slot.start&&receipt.booking.durationMinutes===25&&receipt.status==='simulated');return 'Simulated receipt '+receipt.id;});
  await check('Duplicate action returns the same receipt',async()=>expect((await flow.commit(identity,input)).id===receipt.id));
  await check('Another customer cannot read this booking',()=>rejects(()=>flow.propose({...identity,customerId:'other-test-customer'},{bookingId:'test-booking'}),'booking_access_denied'));
  await check('Unverified customer cannot act',()=>rejects(()=>flow.commit({...identity,verified:false},input),'booking_access_denied'));
  await check('Failed provider write preserves original',async()=>{const p=syntheticBookingProvider({failWrite:true});await rejects(()=>createAppointmentWorkflow(p).commit(identity,input),'synthetic_provider_failure');expect((await p.read('test-booking')).version===1);});
  await check('Concurrent customers cannot take the same slot',async()=>{const p=syntheticBookingProvider(),f=createAppointmentWorkflow(p),v={action:'create',serviceId:'test-haircut',slot:proposal.slots[0],confirmed:true};const results=await Promise.allSettled([f.commit(identity,{...v,idempotencyKey:'concurrent-first'}),f.commit({...identity,customerId:'second-test-customer'},{...v,idempotencyKey:'concurrent-second'})]);expect(results.filter(r=>r.status==='fulfilled').length===1&&results.filter(r=>r.status==='rejected'&&r.reason.code==='slot_unavailable').length===1);});
  await check('Unavailable time offers same-barber alternatives',async()=>{const next=await flow.propose(identity,{bookingId:receipt.booking.id,desiredAt:'2030-01-09T11:00:00Z'});expect(!next.slots.some(s=>s.start==='2030-01-09T11:00:00Z')&&next.slots.length>0&&next.alternatives.length>0);});
  await check('Booking link is customer/action/version scoped',()=>{const l=createBookingLinks(randomBytes(32));const token=l.issue({projectId:identity.projectId,customerId:identity.customerId,bookingId:'test-booking',version:1,action:'reschedule'});expect(l.verify(token,identity,'reschedule').version===1);return rejects(()=>l.verify(token,{...identity,customerId:'other'},'reschedule'),'booking_access_denied');});
  await check('Expired link cannot authorise an action',()=>{let now=1;const l=createBookingLinks(randomBytes(32),{clock:()=>now});const t=l.issue({...identity,bookingId:'test-booking',version:1,action:'cancel'},10);now=12;return rejects(()=>l.verify(t,identity,'cancel'),'booking_access_denied');});
  await check('Duplicate and obsolete reminders are excluded',()=>{const b=receipt.booking,r={...BOOKING_RULES[0],enabled:true},now=Date.parse(b.start)-3600_000;const eligible=reminderEligibility({booking:b,rule:r,now});expect(eligible.eligible);expect(!reminderEligibility({booking:b,rule:r,now,alreadySent:[eligible.key]}).eligible);expect(!reminderEligibility({booking:{...b,status:'cancelled'},rule:r,now}).eligible);});
  await check('Past date alone is not a no-show',()=>expect(!reminderEligibility({booking:receipt.booking,rule:{...BOOKING_RULES[1],enabled:true},now:Date.parse('2031-01-01')}).eligible));
  return {mode:'synthetic',providerWrites:0,customerMessagesSent:0,checks,receipt,warning:'These fixtures prove Nova’s workflow contract, not Fresha integration. No real slot or customer was used.'};
}

export function createSharpCutsBookingService({storage,ownerId,novaTurn,whatsapp}){
  const prefix='sharp-cuts-booking-preview-';
  async function scope(){if(!(await storage.listProjects(ownerId)).some(p=>p.id==='sharp-cuts-web'))throw Object.assign(new Error('Sharp Cuts workspace access required.'),{statusCode:403});}
  return {
    async review(){await scope();const activity=await storage.listActivity(ownerId,{projectId:'sharp-cuts-web',limit:100});return {
      projectId:'sharp-cuts-web',mode:'private_preparation',profile:SHARP_CUTS_PUBLIC_BOOKING_PROFILE,
      connection:{system:'Fresha',browserObservation:'2026-11-20',browser:'Authenticated calendar, service catalogue and scheduling settings inspected; no appointments changed.',lastSuccessfulSync:null,liveAppointmentFeed:false,liveWrites:false,source:'https://partners.fresha.com/calendar',dataConnector:'Optional paid, one-way Snowflake reporting; cannot write appointments. Not activated.',blocker:'No supported booking API/credentials or unattended, customer-scoped write connection is available in the existing account. A Codex-controlled browser session is not an integration Nova’s worker can invoke.'},
      metrics:{upcomingAppointments:null,availableCapacity:null,recordedNoShows:null,note:'Unavailable without a live appointment/status feed. Imported customer visit dates are not appointment or no-show counts.'},
      rules:BOOKING_RULES,outreach:{enabled:false,budgetGbp:0,note:'Proposed rules only. Fresha’s existing reminders must be reconciled before activating Nova reminders. Sender restrictions remain; no recurring sends or WhatsApp template use authorised.'},
      whatsapp:await whatsapp?.status(),
      receipts:activity.filter(a=>a.action==='sharp_cuts_booking_rehearsal').slice(0,5).map(a=>({createdAt:a.createdAt,status:'simulated',...a.metadata})),
      execution:{choice:'Existing Nova agent and worker',n8n:'No n8n binding or executor was found in the application configuration. Adding it would still require the same missing Fresha write access, plus another runtime, credentials, callback authentication and monitoring. Keep Nova’s existing scope, pauses, receipts and duplicate controls.'},
      next:'Obtain Fresha-supported appointment read/write access and customer verification, then approve one identified live test. The customer-facing preview stays behind Nova sign-in until those checks pass.'
    };},
    async chat(input){
      await scope();const message=String(input.message||'').trim();
      if(!message||message.length>2000)throw Object.assign(new Error('Enter a message of 1–2,000 characters.'),{statusCode:400});
      const conversationId=input.conversationId||prefix+randomUUID();
      if(!new RegExp('^'+prefix+'[a-f0-9-]{36}$').test(conversationId))throw Object.assign(new Error('Invalid booking conversation.'),{statusCode:400});
      const requestId=input.requestId;
      if(!/^[a-f0-9-]{36}$/.test(requestId||''))throw Object.assign(new Error('A unique request ID is required.'),{statusCode:400});
      const messages=await storage.listMessages(conversationId,ownerId,{limit:100});
      const prior=messages.find(m=>m.id==='booking-reply-'+requestId),user=messages.find(m=>m.id==='booking-user-'+requestId);
      if(user&&user.content!==message)throw Object.assign(new Error('Request ID already used for another message.'),{statusCode:409});
      if(prior)return {conversationId,message:prior.content,status:'answered',duplicate:true};
      if(user)throw Object.assign(new Error('This request is pending or failed; review its run before retrying.'),{statusCode:409});
      const result=await novaTurn({message,conversationId,requestId:'booking-preview:'+requestId,userMessageId:'booking-user-'+requestId,assistantMessageId:'booking-reply-'+requestId,context:{channel:'whatsapp',projectId:'sharp-cuts-web',personId:'owner-controlled-customer-preview',externalActionsAllowed:false,verifiedBusinessProfile:SHARP_CUTS_PUBLIC_BOOKING_PROFILE}});
      return {conversationId,message:result.message,runId:result.runId,status:'answered',bookingWritten:false,mode:'private_customer_preview'};
    },
    async rehearse(){await scope();const result=await runBookingRehearsal();await storage.appendActivity({ownerId,projectId:'sharp-cuts-web',action:'sharp_cuts_booking_rehearsal',status:result.checks.every(c=>c.result==='passed')?'completed':'failed',summary:'Synthetic booking contract checks; no provider writes or customer messages.',metadata:{mode:'synthetic',checks:result.checks,providerWrites:0,customerMessagesSent:0}});return result;},
    async reminderPreview(action='reschedule'){
      await scope();if(!['confirm','cancel','reschedule'].includes(action))throw Object.assign(new Error('Unsupported reminder action.'),{statusCode:400});
      const provider=syntheticBookingProvider(),flow=createAppointmentWorkflow(provider),identity={verified:true,projectId:'sharp-cuts-web',customerId:'test-customer'};
      const original=await provider.read('test-booking');
      if(action==='reschedule')return {mode:'synthetic',message:'What day and time would suit you? We will keep your synthetic haircut (25 minutes) with Test Barber A unless you agree otherwise.',proposal:await flow.propose(identity,{bookingId:original.id})};
      return {mode:'synthetic',receipt:await flow.commit(identity,{action,bookingId:original.id,expectedVersion:original.version,idempotencyKey:'reminder-test-'+action,confirmed:true}),message:'Synthetic '+action+' result only. No Fresha appointment changed.'};
    }
  };
}
