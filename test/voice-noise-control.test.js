import test from 'node:test';
import assert from 'node:assert/strict';
import {createRealtimeVoice} from '../assets/realtime-voice.js';
import {createRealtimeVoiceService} from '../src/voice/realtime-voice-service.js';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture({sendTurn,account=true,manual=false,guest=false}={}){
 const sent=[],requests=[],work=[],timings=[];let onMessage,onOpen;
 const channel={readyState:'connecting',addEventListener(n,f){if(n==='message')onMessage=f;if(n==='open')onOpen=f;},send(s){sent.push(JSON.parse(s));},close(){this.readyState='closed';}};
 const track={kind:'audio',enabled:true,stop(){this.enabled=false;},getSettings:()=>({echoCancellation:true,noiseSuppression:true,sampleRate:48000,channelCount:1})};
 const peer={createDataChannel:()=>channel,addTrack(){},async createOffer(){return{sdp:'offer'};},async setLocalDescription(){},async setRemoteDescription(){},close(){}};
 const voice=createRealtimeVoice({mediaDevices:{async getUserMedia(){return{getTracks:()=>[track],getAudioTracks:()=>[track]};}},RTCPeerConnectionImpl:class{constructor(){return peer;}},MediaRecorderImpl:null,AudioImpl:class{pause(){}},interruptionConfirmMs:20,transcriptWaitMs:25,manualDrainMs:1,getConversationId:()=> 'conversation',onTiming:x=>timings.push(x),
  fetchImpl:async(url,o)=>{requests.push({url,body:o?.body?.startsWith('{')?JSON.parse(o.body):null});if(url.endsWith('/session'))return Response.json({clientSecret:'test',privacyGate:!guest,isolatedTurns:!guest,sessionId:'session',...(account&&!guest?{accountGrant:'account-grant'}:{})});if(url.endsWith('/authorize-turn'))return Response.json({authorized:account,speakerIdentity:{status:'account_authorised',source:'signed_in_account_session',voiceMatched:false}});return Response.json({ok:true});},
  sendTurn:async(text,options)=>{work.push(text);return sendTurn?sendTurn(text,options):{message:'Safe answer',conversationId:'conversation'};}});
 await voice.start({guest,accountPermission:account,microphoneMode:manual?'tap-to-talk':'hands-free'});channel.readyState='open';onOpen();
 const event=e=>onMessage({data:JSON.stringify(e)});
 const turn=(id,text)=>{event({type:'input_audio_buffer.speech_started',item_id:id});event({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});event({type:'input_audio_buffer.speech_stopped',item_id:id});};
 const playback=()=>{const response=sent.filter(e=>e.type==='response.create').at(-1)?.response;assert.ok(response);event({type:'response.created',response:{id:'reply',metadata:response.metadata}});event({type:'output_audio_buffer.started',response_id:'reply'});};
 return{voice,sent,requests,work,event,turn,track,playback,timings};
}
test('provider cannot cancel isolated replies before application qualifies input',async()=>{
 let body;const s=createRealtimeVoiceService({apiKey:'test',fetchImpl:async(_u,o)=>{body=JSON.parse(o.body);return Response.json({value:'ek_test'});}});await s.createClientSecret({privacyGate:true,isolatedTurns:true});assert.equal(body.session.audio.input.turn_detection.interrupt_response,false);assert.equal(body.session.audio.input.turn_detection.create_response,false);
});
test('short empty VAD burst does not cancel account playback; sustained speech does',async()=>{
 const f=await fixture();try{f.turn('one','Explain a public idea');await wait(10);f.playback();const cancels=()=>f.sent.filter(x=>x.type==='response.cancel'||x.type==='output_audio_buffer.clear').length;const before=cancels();
 f.event({type:'input_audio_buffer.speech_started',item_id:'noise'});f.event({type:'input_audio_buffer.speech_stopped',item_id:'noise'});f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'noise',transcript:''});await wait(30);assert.equal(cancels(),before);assert.equal(f.work.length,1);
 f.event({type:'input_audio_buffer.speech_started',item_id:'real'});await wait(30);assert.ok(cancels()>before);assert.ok(f.timings.some(t=>t.stage==='barge-confirmed'));
 }finally{f.voice.end();}
});
test('brief intelligible stop interrupts without waiting for duration threshold',async()=>{
 const f=await fixture();try{f.turn('one','Explain a public idea');await wait(10);f.playback();f.turn('stop','وقف');await wait(10);assert.ok(f.sent.some(x=>x.type==='output_audio_buffer.clear'));assert.deepEqual(f.work,['Explain a public idea','وقف']);}finally{f.voice.end();}
});
test('overlapping Brain turns are serial; a clear Arabic yes reaches Brain after preceding result',async()=>{
 let release;const pending=new Promise(r=>release=r);const f=await fixture({sendTurn:async text=>{if(text==='Is the notebook copper?')await pending;return{message:'Result',conversationId:'conversation'};}});
 try{f.turn('one','Is the notebook copper?');await wait(5);f.turn('two','إيه.');await wait(5);assert.equal(f.work.length,1);release();await wait(15);assert.deepEqual(f.work,['Is the notebook copper?','إيه.']);assert.equal(f.sent.filter(x=>x.type==='response.create').length,1);}finally{release();f.voice.end();}
});
test('explicit mic stays closed until clear acknowledgement, commits once and shares normal authorisation',async()=>{
 const f=await fixture({manual:true});try{
 assert.equal(f.track.enabled,false);assert.equal(f.voice.beginManualTurn(),false);f.event({type:'session.updated',session:{audio:{input:{turn_detection:null}}}});
 assert.equal(f.voice.beginManualTurn(),true);assert.equal(f.track.enabled,false);f.event({type:'input_audio_buffer.cleared'});assert.equal(f.track.enabled,true);
 assert.equal(f.voice.finishManualTurn(),true);assert.equal(f.voice.finishManualTurn(),false);assert.equal(f.track.enabled,false);await wait(5);assert.equal(f.sent.filter(x=>x.type==='input_audio_buffer.commit').length,1);
 f.event({type:'input_audio_buffer.committed',item_id:'manual-real'});f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'manual-real',transcript:'What is the test notebook colour?'});await wait(10);
 assert.deepEqual(f.work,['What is the test notebook colour?']);assert.equal(f.requests.filter(x=>x.url.endsWith('/authorize-turn')).length,1);f.playback();assert.equal(f.track.enabled,false);
 f.voice.beginManualTurn();assert.ok(f.sent.some(x=>x.type==='output_audio_buffer.clear'));f.event({type:'input_audio_buffer.cleared'});f.voice.setMuted(true);assert.equal(f.track.enabled,false);assert.equal(f.voice.finishManualTurn(),false);f.event({type:'input_audio_buffer.cleared'});f.voice.setMuted(false);assert.equal(f.track.enabled,false);
 }finally{f.voice.end();}
});
test('strict speaker mode never gains account permission from manual controls',async()=>{
 const f=await fixture({manual:true,account:false});try{f.event({type:'session.updated',session:{audio:{input:{turn_detection:null}}}});f.voice.beginManualTurn();f.event({type:'input_audio_buffer.cleared'});f.voice.finishManualTurn();await wait(5);f.event({type:'input_audio_buffer.committed',item_id:'guest'});f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'guest',transcript:'Show me your private projects'});await wait(20);assert.equal(f.work.length,0);assert.equal(f.requests.find(x=>x.url.endsWith('/session')).body.accountConsent,undefined);const outputs=f.sent.filter(x=>x.type==='response.create');assert.ok(outputs.length);assert.match(JSON.stringify(outputs),/public/i);}finally{f.voice.end();}
});
test('public guest can use explicit speech controls without private Brain or recognition',async()=>{
 const f=await fixture({manual:true,guest:true});try{f.event({type:'session.updated',session:{audio:{input:{turn_detection:null}}}});f.voice.beginManualTurn();f.event({type:'input_audio_buffer.cleared'});f.voice.finishManualTurn();await wait(5);f.event({type:'input_audio_buffer.committed',item_id:'public'});f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'public',transcript:'Explain the seasons'});await wait(10);assert.equal(f.work.length,0);assert.equal(f.requests.some(x=>x.url.endsWith('/recognize')||x.url.endsWith('/authorize-turn')),false);assert.match(JSON.stringify(f.sent.filter(x=>x.type==='response.create')),/PUBLIC conversation only/);}finally{f.voice.end();}
});
test('mute discards a pending noise candidate and no delayed event starts work',async()=>{
 const f=await fixture();try{f.turn('one','Explain an idea');await wait(10);f.playback();f.event({type:'input_audio_buffer.speech_started',item_id:'late'});f.voice.setMuted(true);f.event({type:'input_audio_buffer.committed',item_id:'late'});f.event({type:'conversation.item.input_audio_transcription.completed',item_id:'late',transcript:'Save a private fact'});await wait(30);assert.equal(f.work.length,1);assert.equal(f.track.enabled,false);}finally{f.voice.end();}
});
