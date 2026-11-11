import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createRealtimeVoice} from '../assets/realtime-voice.js';
import {createPreviewAuth} from '../src/identity/preview-auth.js';
import {createApi} from '../src/http/api.js';
import {readPreviewSession} from '../assets/preview-session.js';

const wait=()=>new Promise(r=>setTimeout(r,320));
function voiceHarness({shortResult='insufficient_speech',authorize=true}={}){
 let clock=0,frame,requests=[],notices=0,pauses=0;
 const prior=globalThis.requestAnimationFrame,priorCancel=globalThis.cancelAnimationFrame;
 globalThis.requestAnimationFrame=fn=>{frame=fn;return 1;};globalThis.cancelAnimationFrame=()=>{};
 class Channel extends EventTarget{readyState='open';sent=[];send(s){this.sent.push(JSON.parse(s));}close(){this.readyState='closed';}message(e){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(e)}));}}
 const channel=new Channel();
 class Peer extends EventTarget{createDataChannel(){return channel;}addTrack(){}async createOffer(){return{sdp:'test'};}async setLocalDescription(){}async setRemoteDescription(){}close(){}}
 class Recorder extends EventTarget{state='inactive';mimeType='audio/webm';start(){this.state='recording';}stop(){this.state='inactive';const e=new Event('dataavailable');e.data=new Blob(['synthetic-audio-fixture']);this.dispatchEvent(e);this.dispatchEvent(new Event('stop'));}}
 class Context{createMediaStreamSource(){return{connect(){},disconnect(){}};}createAnalyser(){return{getByteTimeDomainData:a=>a.fill(133)};}async close(){}}
 const voice=createRealtimeVoice({mediaDevices:{async getUserMedia(){return{getTracks:()=>[{stop(){}}]};}},RTCPeerConnectionImpl:Peer,MediaRecorderImpl:Recorder,AudioContextImpl:Context,AudioImpl:class{pause(){}},now:()=>clock,onVerificationNeeded:()=>notices++,onPrivacyPause:()=>pauses++,
 fetchImpl:async(url,o)=>{
  if(url.endsWith('/session'))return Response.json({clientSecret:'fixture',privacyGate:true,replyLanguage:'ar'});
  if(url.endsWith('/recognize')){const body=JSON.parse(o.body);requests.push(body);return Response.json({speaker:body.durationSeconds>=1?{match_status:'confirmed',authenticated_identity:'owner',assertion:'fixture'}:{match_status:shortResult,authenticated_identity:'none'}});}
  if(url.endsWith('/authorize-turn')){const allowed=authorize&&JSON.parse(o.body).speaker?.match_status==='confirmed';return Response.json({authorized:allowed},{status:allowed?200:403});}
  return new Response('fixture');
 }});
 return{voice,channel,requests,counts:()=>({notices,pauses}),set:t=>clock=t,local:t=>{clock=t;frame();},event:(type,id)=>channel.message({type:'input_audio_buffer.'+type,item_id:id}),close(){voice.end();globalThis.requestAnimationFrame=prior;globalThis.cancelAnimationFrame=priorCancel;}};
}

test('local capture preserves speech onset before delayed remote VAD and still requires server authorization',async()=>{
 const h=voiceHarness();try{
  await h.voice.start();h.local(1000);h.set(1500);h.event('speech_started','one');h.set(2200);h.event('speech_stopped','one');await wait();
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].durationSeconds,1.2);
  assert.equal(h.channel.sent.filter(x=>x.type==='response.create').length,1);
  // A short later fragment cannot retain access from the previous owner assertion.
  h.set(3000);h.event('speech_started','two');h.set(3200);h.event('speech_stopped','two');await wait();
  assert.equal(h.counts().pauses,1);assert.equal(h.voice.isActive(),false);
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
