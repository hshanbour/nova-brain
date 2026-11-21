import {createHmac, timingSafeEqual, randomUUID} from 'node:crypto';

const fail=(code,message)=>Object.assign(new Error(message),{code,statusCode:409});
const digest=(key,value)=>createHmac('sha256',key).update(value).digest('base64url');

// Capability links are scoped intent, NOT customer identity. The independently
// verified customer must still match. GET only previews; commit requires POST.
export function createBookingLinks(key,{clock=()=>Date.now()}={}) {
  if(!key||Buffer.byteLength(key)<32)throw Error('A dedicated 32-byte signing key is required.');
  return {
    issue({projectId,customerId,bookingId,version,action},ttlMs=15*60_000){
      if(!['confirm','reschedule','cancel'].includes(action))throw Error('Unsupported action.');
      const body=Buffer.from(JSON.stringify({projectId,customerId,bookingId,version,action,expires:clock()+ttlMs})).toString('base64url');
      return `${body}.${digest(key,body)}`;
    },
    verify(token,identity,action){
      try {
        const [body,signature,...extra]=String(token).split('.');
        const expected=Buffer.from(digest(key,body)),actual=Buffer.from(signature||'');
        if(extra.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();
        const claim=JSON.parse(Buffer.from(body,'base64url').toString());
        if(identity?.verified!==true||claim.projectId!==identity.projectId||claim.customerId!==identity.customerId||claim.action!==action||claim.expires<=clock())throw Error();
        return claim;
      } catch {throw fail('booking_access_denied','Verify the customer and request a fresh booking link.');}
    }
  };
}

// Adapter must supply atomic compare-and-write + idempotency, and a read-back.
// No live adapter is connected until Fresha supports those guarantees.
export function createAppointmentWorkflow(provider){
  function authorize(identity){if(!identity?.verified||identity.projectId!=='sharp-cuts-web')throw fail('booking_access_denied','Customer verification is required.');}
  async function owned(identity,id){authorize(identity);const row=await provider.read(id);if(!row||row.customerId!==identity.customerId||row.projectId!==identity.projectId)throw fail('booking_access_denied','Booking unavailable for this customer.');return row;}
  return {
    async propose(identity,{bookingId,serviceId,barberId,desiredAt}){
      authorize(identity);
      const original=bookingId?await owned(identity,bookingId):null;
      if(original&&['cancelled','completed','no_show'].includes(original.status))throw fail('booking_not_active','This booking cannot be rescheduled.');
      const service=await provider.service(original?.serviceId||serviceId);
      if(!service)throw fail('service_required','Which service would you like?');
      const preferred=original?.barberId||barberId;
      const slots=await provider.availability({serviceId:service.id,durationMinutes:service.durationMinutes,barberId:preferred,desiredAt,excludeBookingId:bookingId});
      const alternatives=preferred?await provider.availability({serviceId:service.id,durationMinutes:service.durationMinutes,excludeBarberId:preferred,desiredAt,excludeBookingId:bookingId}):[];
      return {status:'proposed',mode:provider.mode,original,service,slots,alternatives,requiresCustomerConfirmation:true};
    },
    async commit(identity,{action,bookingId,expectedVersion,serviceId,slot,idempotencyKey,confirmed=false,agreeOtherBarber=false}){
      authorize(identity);
      if(!confirmed)throw fail('confirmation_required','Confirm the exact appointment details first.');
      if(!/^[a-zA-Z0-9_-]{12,100}$/.test(idempotencyKey||''))throw fail('idempotency_required','A unique action receipt is required.');
      if(!['create','reschedule','confirm','cancel'].includes(action))throw fail('unsupported_action','Unsupported booking action.');
      const operation={action,bookingId:bookingId||null,expectedVersion:expectedVersion??null,serviceId:serviceId||null,slot:slot||null,agreeOtherBarber};
      const previous=await provider.receipt(identity,idempotencyKey);
      if(previous){if(JSON.stringify(previous.operation)!==JSON.stringify(operation))throw fail('duplicate_key_conflict','This receipt belongs to different appointment details.');return previous;}
      const original=action==='create'?null:await owned(identity,bookingId);
      if(original&&original.version!==expectedVersion)throw fail('booking_changed','The booking changed. Review its latest details before continuing.');
      if(original&&['cancelled','completed','no_show'].includes(original.status))throw fail('booking_not_active','This booking is no longer active.');
      if(original&&serviceId&&serviceId!==original.serviceId)throw fail('service_changed','Rescheduling preserves the original service.');
      if(original&&slot?.barberId!==original.barberId&&action==='reschedule'&&!agreeOtherBarber)throw fail('barber_agreement_required','Changing barber needs the customer’s explicit agreement.');
      const service=await provider.service(original?.serviceId||serviceId);
      if(!service)throw fail('service_required','Choose a verified service.');
      if(action==='create'||action==='reschedule'){
        const available=await provider.availability({serviceId:service.id,durationMinutes:service.durationMinutes,barberId:slot?.barberId,desiredAt:slot?.start,excludeBookingId:bookingId});
        if(!available.some(s=>s.start===slot?.start&&s.barberId===slot?.barberId))throw fail('slot_unavailable','That time is no longer available. Your original booking is unchanged.');
      }
      let result;
      try {result=await provider.commitAtomic({identity,operation,original,service,idempotencyKey});}
      catch(error){if(error.code)throw error;throw fail('provider_outcome_unknown','The provider result is uncertain. Reconcile this receipt before retrying.');}
      const readback=await provider.read(result.booking.id);
      if(!readback||JSON.stringify(readback)!==JSON.stringify(result.booking))throw fail('readback_pending','The write was submitted; provider read-back is not confirmed. Do not retry.');
      return result;
    }
  };
}

export function reminderEligibility({booking,rule,now,alreadySent=[],suppressed=false,marketingAllowed=false}){
  if(!booking||booking.projectId!=='sharp-cuts-web')return {eligible:false,reason:'wrong_project'};
  if(!rule.enabled)return {eligible:false,reason:'activation_held'};
  if(suppressed)return {eligible:false,reason:'suppressed'};
  const key=`${booking.id}:${booking.version}:${rule.id}:${rule.channel}`;
  if(alreadySent.includes(key))return {eligible:false,reason:'duplicate'};
  if(rule.purpose==='no_show'&&booking.status!=='no_show')return {eligible:false,reason:'no_recorded_no_show'};
  if(rule.purpose==='return_visit'&&(booking.status!=='completed'||!marketingAllowed))return {eligible:false,reason:'marketing_or_visit_evidence_missing'};
  if(rule.purpose==='appointment'&&(!['booked','confirmed'].includes(booking.status)||Date.parse(booking.start)<=now||Date.parse(booking.start)-now>rule.hoursBefore*3600_000))return {eligible:false,reason:'not_due_or_obsolete'};
  return {eligible:true,key,requiresFreshProviderRead:true};
}

// Fresh synthetic fixtures only. No real appointments, provider calls or queue.
export function syntheticBookingProvider({failWrite=false}={}){
  const service={id:'test-haircut',name:'Synthetic haircut',durationMinutes:25};
  const rows=new Map([['test-booking',{id:'test-booking',projectId:'sharp-cuts-web',customerId:'test-customer',serviceId:service.id,durationMinutes:25,barberId:'test-barber-a',start:'2030-01-08T10:00:00Z',version:1,status:'booked'}]]),receipts=new Map();
  const starts=['2030-01-09T10:00:00Z','2030-01-09T10:30:00Z'];
  const copy=x=>x?structuredClone(x):null;
  return {
    mode:'synthetic',rows,receipts,
    async service(id){return id===service.id?copy(service):null;},
    async read(id){return copy(rows.get(id));},
    async receipt(identity,key){return copy(receipts.get(identity.customerId+':'+key));},
    async availability({barberId,excludeBarberId,excludeBookingId,durationMinutes}){
      return ['test-barber-a','test-barber-b'].filter(b=>(!barberId||b===barberId)&&b!==excludeBarberId).flatMap(b=>starts.map(start=>({barberId:b,start}))).filter(s=>![...rows.values()].some(r=>r.id!==excludeBookingId&&r.barberId===s.barberId&&r.status!=='cancelled'&&Date.parse(r.start)<Date.parse(s.start)+durationMinutes*60000&&Date.parse(s.start)<Date.parse(r.start)+r.durationMinutes*60000));
    },
    async commitAtomic({identity,operation,original,service,idempotencyKey}){
      const key=identity.customerId+':'+idempotencyKey,prior=receipts.get(key);
      if(prior){if(JSON.stringify(prior.operation)!==JSON.stringify(operation))throw fail('duplicate_key_conflict','Receipt conflict.');return copy(prior);}
      if(failWrite)throw fail('synthetic_provider_failure','Synthetic write failed; original booking retained.');
      if(original&&rows.get(original.id)?.version!==original.version)throw fail('booking_changed','Concurrent booking change.');
      const {action,slot}=operation;
      // Deliberately synchronous after all checks: models provider atomicity.
      if(['create','reschedule'].includes(action)&&[...rows.values()].some(r=>r.id!==original?.id&&r.barberId===slot.barberId&&r.status!=='cancelled'&&Date.parse(r.start)<Date.parse(slot.start)+service.durationMinutes*60000&&Date.parse(slot.start)<Date.parse(r.start)+r.durationMinutes*60000))throw fail('slot_unavailable','Concurrent appointment won this slot.');
      const booking={...(original||{id:'test-'+randomUUID(),projectId:identity.projectId,customerId:identity.customerId}),serviceId:service.id,durationMinutes:service.durationMinutes,barberId:slot?.barberId||original.barberId,start:slot?.start||original.start,version:(original?.version||0)+1,status:action==='cancel'?'cancelled':action==='confirm'?'confirmed':'booked'};
      rows.set(booking.id,booking);
      const receipt={id:'sim-'+randomUUID(),status:'simulated',provider:'synthetic — not Fresha',operation,booking:copy(booking)};
      receipts.set(key,receipt);return copy(receipt);
    }
  };
}
