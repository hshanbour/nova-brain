import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createRealtimeVoice} from '../assets/realtime-voice.js';
import {createPreviewAuth} from '../src/identity/preview-auth.js';
import {createApi} from '../src/http/api.js';
import {verifiedOwnerVoiceEvidence} from '../src/voice/private-context-access.js';
import {isVoiceLanguageOnlyChange} from '../assets/voice-language.js';
import {readPreviewSession} from '../assets/preview-session.js';

const wait=()=>new Promise(r=>setTimeout(r,320));
function voiceHarness({shortResult='insufficient_speech',authorize=true,sendTurn,recognize,authorizationFailure=false}={}){
 let clock=0,frame,requests=[],notices=0,pauses=0,verified=0;const results=[],pauseReasons=[],recoveries=[];
 const prior=globalThis.requestAnimationFrame,priorCancel=globalThis.cancelAnimationFrame;
 globalThis.requestAnimationFrame=fn=>{frame=fn;return 1;};globalThis.cancelAnimationFrame=()=>{};
 class Channel extends EventTarget{readyState='open';sent=[];send(s){this.sent.push(JSON.parse(s));}close(){this.readyState='closed';}message(e){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(e)}));}}
 let channel;
 class Peer extends EventTarget{createDataChannel(){channel=new Channel();return channel;}addTrack(){}async createOffer(){return{sdp:'test'};}async setLocalDescription(){}async setRemoteDescription(){}close(){}}
 class Recorder extends EventTarget{state='inactive';mimeType='audio/webm';start(){this.state='recording';}stop(){this.state='inactive';const e=new Event('dataavailable');e.data=new Blob(['synthetic-audio-fixture']);this.dispatchEvent(e);this.dispatchEvent(new Event('stop'));}}
 class Context{createMediaStreamSource(){return{connect(){},disconnect(){}};}createAnalyser(){return{getByteTimeDomainData:a=>a.fill(133)};}async close(){}}
 const voice=createRealtimeVoice({mediaDevices:{async getUserMedia(){return{getTracks:()=>[{stop(){}}]};}},RTCPeerConnectionImpl:Peer,MediaRecorderImpl:Recorder,AudioContextImpl:Context,AudioImpl:class{pause(){}},now:()=>clock,sendTurn,onResult:r=>results.push(r),getConversationId:()=> 'fixture-conversation',onPrivacyRecovery:()=>recoveries.push(true),onVerificationNeeded:()=>notices++,onPrivacyPause:detail=>{pauses++;pauseReasons.push(detail?.reason);},onOwnerVerified:()=>verified++,
 fetchImpl:async(url,o)=>{
  if(url.endsWith('/session'))return Response.json({clientSecret:'fixture',privacyGate:true,replyLanguage:'ar'});
  if(url.endsWith('/recognize')){const body=JSON.parse(o.body);requests.push(body);return Response.json({speaker:recognize?recognize(body,requests.length):body.durationSeconds>=1?{match_status:'confirmed',authenticated_identity:'owner',assertion:'fixture'}:{match_status:shortResult,authenticated_identity:'none'}});}
  if(url.endsWith('/authorize-turn')){if(authorizationFailure)throw new TypeError('Failed to fetch');const allowed=authorize&&JSON.parse(o.body).speaker?.match_status==='confirmed';return Response.json({authorized:allowed,...(allowed?{speakerIdentity:verifiedOwnerVoiceEvidence()}:{})},{status:allowed?200:403});}
  return new Response('fixture');
 }});
 return{voice,get channel(){return channel;},requests,results,pauseReasons,recoveries,verifiedCount:()=>verified,counts:()=>({notices,pauses}),set:t=>clock=t,local:t=>{clock=t;frame();},event:(type,id)=>channel.message({type:'input_audio_buffer.'+type,item_id:id}),close(){voice.end();globalThis.requestAnimationFrame=prior;globalThis.cancelAnimationFrame=priorCancel;}};
}

test('local capture preserves speech onset before delayed remote VAD and still requires server authorization',async()=>{
 const h=voiceHarness();try{
  await h.voice.start();h.local(1000);h.set(1500);h.event('speech_started','one');h.set(2200);h.event('speech_stopped','one');await wait();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].durationSeconds,1.2);
  assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,1);
  // A short later fragment cannot retain access from the previous owner assertion.
  h.set(3000);h.event('speech_started','two');h.set(3200);h.event('speech_stopped','two');await wait();
  assert.equal(h.counts().pauses,0);assert.equal(h.recoveries.length,1);assert.equal(h.voice.isActive(),true);
  assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,0,'Fresh session is locked until a new match');
 }finally{h.close();}
});

test('short initial clip keeps private gate closed, requests more speech, and accepts only a fresh authorized turn',async()=>{
 const h=voiceHarness();try{
  await h.voice.start();h.set(1000);h.event('speech_started','short');h.set(1900);h.event('speech_stopped','short');await wait();
  assert.equal(h.requests[0].durationSeconds,.9);assert.deepEqual(h.counts(),{notices:1,pauses:0});assert.equal(h.voice.isActive(),true);
  assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,0);assert.ok(h.channel.sent.some(x=>x.type==='conversation.item.delete'&&x.item_id==='short'));
  h.local(2500);h.set(2800);h.event('speech_started','long');h.set(4500);h.event('speech_stopped','long');await wait();
  assert.equal(h.requests[1].durationSeconds,2);assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,1);
 }finally{h.close();}
});

test('apparently matched but unauthorized voice still closes the session',async()=>{
 const h=voiceHarness({authorize:false});try{await h.voice.start();h.set(1000);h.event('speech_started','a');h.set(3000);h.event('speech_stopped','a');await wait();assert.equal(h.counts().pauses,1);assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,0);}finally{h.close();}
});

test('a superseded recognition cannot launch a stale private reply',async()=>{
 const h=voiceHarness();try{await h.voice.start();h.set(1000);h.event('speech_started','a');h.set(3000);h.event('speech_stopped','a');h.set(3050);h.event('speech_started','b');await wait();assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,0);}finally{h.close();}
});

const environment={DATABASE_URL:'postgres://fixture:fixture@localhost/test',NOVA_PREVIEW_OWNER_EMAIL:'owner@example.invalid',NOVA_PREVIEW_OWNER_SUBJECT:'owner-subject'};
const session={user:{id:'owner-subject',email:'owner@example.invalid',emailVerified:true},session:{userId:'owner-subject',expiresAt:new Date(Date.now()+3600000).toISOString()}};
const request=url=>Object.assign(Readable.from([]),{url,method:'GET',headers:{cookie:'fixture'}});
const response=()=>({statusCode:200,headers:{},getHeader(k){return this.headers[k];},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}});

test('session refresh cookies survive both the session endpoint and private API authorization',async()=>{
 const auth=createPreviewAuth({environment,workspaceId:'owner',synthetic:false,serverFactory:config=>({async getSession(){config.context().setCookie('__Secure-neon-auth.session_token','synthetic-fixture',{httpOnly:true,secure:true,sameSite:'strict',path:'/',maxAge:3600});return{data:session};}})});
 const r=response();await auth.handle(request('/api/preview/session'),r);assert.equal(r.statusCode,200);assert.match(r.headers['Set-Cookie'][0],/HttpOnly/);assert.match(r.headers['Set-Cookie'][0],/Max-Age=3600/);
 const api=createApi({config:{allowedOrigins:[]},ownerId:'owner',authorizeConsole:auth.authorize,initialize:async()=>{},storage:{getOwner:async()=>({id:'owner'})}});
 const privateResponse=response();await api.handle(request('/api/owner/profile'),privateResponse);assert.equal(privateResponse.statusCode,200);assert.ok(privateResponse.headers['Set-Cookie'].length);
});

test('Neon network failure remains unavailable, not signed out, and wrong accounts remain denied',async()=>{
 let result={data:null,error:{status:502,code:'NETWORK_ERROR'}};
 const auth=createPreviewAuth({environment,workspaceId:'owner',serverFactory:()=>({getSession:async()=>result})});
 const r=response();await auth.handle(request('/api/preview/session'),r);assert.equal(r.statusCode,503);
 result={data:{...session,user:{...session.user,id:'other'},session:{...session.session,userId:'other'}}};await assert.rejects(auth.authorize(request('/api/projects')),e=>e.statusCode===403);
 for(const code of [429,500,502,503])assert.equal((await readPreviewSession(async()=>new Response('',{status:code}))).state,'unavailable');
 assert.equal((await readPreviewSession(async()=>{throw Error('offline');})).state,'unavailable');
 for(const code of [401,403])assert.equal((await readPreviewSession(async()=>new Response('',{status:code}))).state,'signed-out');
 assert.equal((await readPreviewSession(async()=>Response.json({workspaceId:'owner'}))).state,'verified');
});

// Regression for the real 16:49 failure: quality rejection finished after the
// old live-turn deadline, then an unnecessary profile read hid its reason.
test('quality rejection does not query profiles and preserves its actual reason',async()=>{
 const {createEcapaSpeakerEngine}=await import('../src/voice/ecapa-speaker-engine.js');
 let reads=0;const engine=createEcapaSpeakerEngine({extractor:{configured:true,async extract(){return{sufficient:false,reason:'insufficient_voiced_speech',speechSeconds:.95,totalDurationSeconds:1.62,latencyMs:2259};}},identity:{candidateCount(){reads++;throw Error('must not query');}}});
 const result=await engine.recognize({durationSeconds:1.645},{transcriptPromise:Promise.resolve({transcript:'fixture'})});
 assert.equal(result.status,'insufficient');assert.equal(result.diagnostics.qualityGateReason,'insufficient_voiced_speech');assert.equal(result.diagnostics.voicedDurationSeconds,.95);assert.equal(reads,0);
});

test('protected recognition uses its own bounded deadline and does not misclassify a late quality result',async()=>{
 const {createSpeakerEngineResult}=await import('../src/voice/speaker-engine.js');
 let mode='insufficient';
 const api=createApi({ownerId:'owner',config:{allowedOrigins:[],voiceV2:{maxBodyBytes:5000},speakerRecognition:{liveTurnBudgetMs:5,protectedTurnBudgetMs:80,modelVersion:'fixture'}},initialize:async()=>{},speakerEngines:{authoritativeEngineId:'ecapa',async recognize(){await new Promise(r=>setTimeout(r,25));return{authoritative:createSpeakerEngineResult({status:mode,engineId:'ecapa',diagnostics:{qualityGateReason:'insufficient_voiced_speech'},error:mode==='failure'?{code:'extractor_timeout'}:null})};}},speakerAssertions:{issue:()=>null}});
 const call=async()=>{const r=response();const q=Object.assign(Readable.from(['{}']),{url:'/api/voice/speaker/recognize',method:'POST',headers:{'content-type':'application/json'}});await api.handle(q,r);return JSON.parse(r.body);};
 const rejected=await call();assert.equal(rejected.speaker.match_status,'insufficient_speech');assert.equal(rejected.verificationStatus,'insufficient');
 mode='failure';const unavailable=await call();assert.equal(unavailable.speaker.authenticated_identity,'none');assert.equal(unavailable.verificationStatus,'unavailable');
});

test('language-only correction is narrow and never hides cancellation or a new instruction',()=>{
 for(const text of ['احكي باللغة الثانية، احكي بالعربي.','احكي بالعربي','Please speak in Arabic','Switch to English'])assert.equal(isVoiceLanguageOnlyChange(text),true,text);
 for(const text of ['وقف احكي بالعربي','احكي بالعربي وشو أخبار المشي','Speak Arabic and cancel the booking','خلينا نغير الموضوع','Arfeminana'])assert.equal(isVoiceLanguageOnlyChange(text),false,text);
});

for(const correction of ['احكي باللغة الثانية، احكي بالعربي.','وقف خلينا نغير الموضوع'])test('pending result after '+correction,async()=>{
 let finish,calls=0;const h=voiceHarness({sendTurn:async()=>{calls++;return new Promise(r=>finish=r);}});
 try{
  await h.voice.start();h.set(1000);h.event('speech_started','request');h.channel.message({type:'conversation.item.input_audio_transcription.completed',item_id:'request',transcript:'شو بتعرفي عن مشروع الاختبار؟'});h.set(3500);h.event('speech_stopped','request');await wait();
  const identity=h.channel.sent.find(x=>x.item?.role==='system');assert.match(identity.item.content[0].text,/server_verified_enrolled_voice/);assert.doesNotMatch(identity.item.content[0].text,/assertion|fixture-conversation/);
  assert.ok(h.channel.sent.indexOf(identity)<h.channel.sent.findIndex(x=>x.type==='response.create'));
  h.channel.message({type:'response.created',response:{id:'r1'}});h.channel.message({type:'response.done',response:{id:'r1',output:[{type:'function_call',name:'nova_turn',call_id:'pending-call',arguments:'{}'}]}});await new Promise(r=>setTimeout(r,10));assert.equal(calls,1);
  h.set(5000);h.event('speech_started','language');h.channel.message({type:'conversation.item.input_audio_transcription.completed',item_id:'language',transcript:correction});h.set(7500);h.event('speech_stopped','language');await wait();
  finish({message:'Completed project evidence',runId:'fixture-receipt',conversationId:'fixture-conversation'});await new Promise(r=>setTimeout(r,15));
  const output=h.channel.sent.find(x=>x.item?.call_id==='pending-call');
  if(isVoiceLanguageOnlyChange(correction)){assert.match(output.item.output,/fixture-receipt/);assert.equal(h.results.length,1);assert.ok(h.channel.sent.some(x=>x.item?.content?.[0]?.text?.includes('reply language to ar')));}
  else {assert.equal(JSON.parse(output.item.output).status,'superseded');assert.equal(h.results.length,0);}
  assert.equal(calls,1,'Never re-execute the original request');
 }finally{h.close();}
});

test('owner-verification notice requires a signed active owner profile, not a browser claim',async()=>{
 let profileReads=0;const api=createApi({ownerId:'owner',storage:{async getOwner(id){assert.equal(id,'owner');profileReads++;return{preferredName:'Fixture Owner',arabicName:'اسم الاختبار',email:'must-not-leak',facts:{private:'must-not-leak'}};}},initialize:async()=>{},config:{allowedOrigins:[],maxBodyBytes:5000},speakerAssertions:{verify:a=>a==='signed-owner'?{speaker_profile_id:'enrolled',speaker_label:'owner',match_status:'confirmed'}:null},speakerIdentity:{get:async()=>({status:'active',relation:'owner'})},logger:{info(){},error(){}}});
 const call=async speaker=>{const r=response(),q=Object.assign(Readable.from([JSON.stringify({speaker})]),{url:'/api/voice/realtime/authorize-turn',method:'POST',headers:{host:'nova.test',origin:'https://nova.test','content-type':'application/json'}});await api.handle(q,r);return r;};
 const denied=await call({authenticated_identity:'owner',match_status:'confirmed'});assert.equal(denied.statusCode,403);assert.doesNotMatch(denied.body,/server_verified_enrolled_voice/);assert.equal(profileReads,0);
 const granted=await call({assertion:'signed-owner'});assert.equal(granted.statusCode,200);assert.equal(JSON.parse(granted.body).speakerIdentity.status,'verified_owner');assert.doesNotMatch(granted.body,/signed-owner|enrolled\"/);assert.equal(profileReads,1);assert.equal(JSON.parse(granted.body).speakerIdentity.identity.preferredName,'Fixture Owner');assert.doesNotMatch(granted.body,/must-not-leak/);
});

test('owner to unknown speaker destroys private session; clean retry requires and accepts a fresh owner assertion',async()=>{
 const h=voiceHarness({recognize:(_body,n)=>n===2?{match_status:'unknown',authenticated_identity:'none',assertion:'unknown-fixture'}:{match_status:'confirmed',authenticated_identity:'owner',assertion:'fixture'}});
 try{
  await h.voice.start();h.set(1000);h.event('speech_started','owner');h.set(4000);h.event('speech_stopped','owner');await wait();
  assert.equal(h.verifiedCount(),1);const old=h.channel;
  h.set(5000);h.event('speech_started','guest');h.set(8000);h.event('speech_stopped','guest');await wait();
  assert.equal(h.voice.isActive(),false);assert.equal(old.readyState,'closed');assert.deepEqual(h.pauseReasons,['not-matched']);assert.equal(h.verifiedCount(),1);
  assert.equal(old.sent.filter(x=>x.type==='response.create').length,1);
  await h.voice.start();assert.notEqual(h.channel,old);assert.equal(h.verifiedCount(),1,'Starting a new session does not unlock owner context');
  old.message({type:'response.done',response:{output:[{type:'function_call',name:'nova_context',call_id:'stale',arguments:'{}'}]}});
  h.set(9000);h.event('speech_started','returning-owner');h.set(15000);h.event('speech_stopped','returning-owner');await wait();
  assert.equal(h.verifiedCount(),2);assert.equal(h.voice.isActive(),true);assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,1);
  assert.equal(h.channel.sent.some(x=>x.item?.call_id==='stale'),false);
 }finally{h.close();}
});

test('repeated fresh non-owner recordings never unlock, and account authorization failure is distinct from mismatch',async()=>{
 for(const unavailable of [false,true]){
  const h=voiceHarness({authorizationFailure:unavailable,recognize:()=>unavailable?{match_status:'confirmed',authenticated_identity:'owner',assertion:'fixture'}:{match_status:'unknown',authenticated_identity:'none'}});
  try{for(let n=0;n<2;n++){await h.voice.start();h.set(n*5000+1000);h.event('speech_started','retry-'+n);h.set(n*5000+4000);h.event('speech_stopped','retry-'+n);await wait();assert.equal(h.voice.isActive(),false);assert.equal(h.verifiedCount(),0);assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,0);}
   assert.deepEqual(h.pauseReasons,Array(2).fill(unavailable?'service-unavailable':'not-matched'));
  }finally{h.close();}
 }
});

test('recreated browser controller has no persistent speaker denial, but still independently verifies owner',async()=>{
 const first=voiceHarness({recognize:()=>({match_status:'unknown',authenticated_identity:'none'})});
 try{await first.voice.start();first.set(1000);first.event('speech_started','unknown');first.set(4000);first.event('speech_stopped','unknown');await wait();assert.equal(first.counts().pauses,1);}finally{first.close();}
 const fresh=voiceHarness();try{await fresh.voice.start();assert.equal(fresh.verifiedCount(),0);fresh.set(1000);fresh.event('speech_started','owner');fresh.set(7000);fresh.event('speech_stopped','owner');await wait();assert.equal(fresh.verifiedCount(),1);assert.equal(fresh.counts().pauses,0);}finally{fresh.close();}
});


test('quality recovery destroys private context, accepts only fresh owner evidence and cannot loop',async()=>{
 const h=voiceHarness();try{
  await h.voice.start();h.set(1000);h.event('speech_started','owner');h.set(4000);h.event('speech_stopped','owner');await wait();
  const old=h.channel;h.set(5000);h.event('speech_started','fragment');h.set(5300);h.event('speech_stopped','fragment');await wait();
  assert.equal(old.readyState,'closed');assert.notEqual(h.channel,old);assert.equal(h.recoveries.length,1);assert.equal(h.verifiedCount(),1);
  old.message({type:'response.created',response:{id:'stale'}});assert.equal(h.channel.sent.length,0);
  h.set(6000);h.event('speech_started','owner-return');h.set(9000);h.event('speech_stopped','owner-return');await wait();assert.equal(h.verifiedCount(),2);
  h.set(10000);h.event('speech_started','second-fragment');h.set(10300);h.event('speech_stopped','second-fragment');await wait();
  assert.equal(h.voice.isActive(),false);assert.equal(h.recoveries.length,1);assert.deepEqual(h.pauseReasons,['insufficient-speech']);
 }finally{h.close();}
});

test('different speaker after automatic quality recovery cannot inherit the previous match',async()=>{
 const h=voiceHarness({recognize:(_b,n)=>({match_status:n===1?'confirmed':n===2?'insufficient_speech':'unknown',authenticated_identity:n===1?'owner':'none',assertion:n===1?'fixture':null})});try{
  await h.voice.start();for(let n=0;n<3;n++){h.set(1000+n*4000);h.event('speech_started','turn-'+n);h.set(3000+n*4000);h.event('speech_stopped','turn-'+n);await wait();}
  assert.equal(h.recoveries.length,1);assert.equal(h.verifiedCount(),1);assert.equal(h.voice.isActive(),false);assert.deepEqual(h.pauseReasons,['not-matched']);
 }finally{h.close();}
});
