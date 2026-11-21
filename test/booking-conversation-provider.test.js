import test from 'node:test';
import assert from 'node:assert/strict';
import {createBookingConversation} from '../src/booking/customer-conversation.js';
import {createOpenAIModelProvider} from '../src/providers/openai-model-provider.js';
test('customer turn satisfies actual provider contract and queues only an authorised read',async()=>{
 let sent,queued;const messages=[],activities=[];
 const plan={reply:'Checking only.',intent:'availability',service:'Haircut',barber:'Hamood',date:'2026-11-22',time:'',appointmentId:'',explicitConfirmation:false,agreesAlternativeBarber:false};
 const provider=createOpenAIModelProvider({apiKey:'synthetic-test-key',model:'test-model',fetchImpl:async(_url,options)=>{sent=JSON.parse(options.body);return new Response(JSON.stringify({id:'test-response',output_text:JSON.stringify(plan)}));}});
 const storage={async getActivity(){return null;},async ensureConversation(x){return x;},async listMessages(){return[];},async appendMessage(m){messages.push(m);},async appendActivity(a){activities.push(a);}};
 const operations={async status(){return{catalogue:{services:[{name:'Haircut'}],staff:['Hamood']},jobs:[]};},async request(request,principal){queued={request,principal};return{id:'read-receipt'};}};
 const service=createBookingConversation({storage,ownerId:'test-owner',modelProvider:provider,operations,clock:()=>Date.parse('2026-11-21T13:00:00Z')});
 const result=await service.turn({message:'Check tomorrow with Hamood, do not book.',requestId:'provider-contract-test'});
 assert.equal(queued.request.operation,'availability');assert.equal(result.bookingWritten,false);assert.equal(result.jobId,'read-receipt');assert.deepEqual(sent.tools,[]);assert.equal(sent.input.length,1);assert.equal(messages.length,2);assert.equal(activities[0].action,'sharp_cuts_customer_booking_turn');assert.ok(!JSON.stringify(sent).includes('test-owner'));
});
