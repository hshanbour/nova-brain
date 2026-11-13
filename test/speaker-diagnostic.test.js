import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {Readable} from 'node:stream';
import {createDiagnosticVault,encodeMonoWav} from '../assets/speaker-diagnostic-vault.js';
import {createSpeakerDiagnostic,DIAGNOSTIC_TTL_MS,diagnosticPcmWindow} from '../src/voice/speaker-diagnostic.js';
import {createSpeakerIdentity} from '../src/voice/speaker-identity.js';
import {createApi} from '../src/http/api.js';
import {novaMicrophoneConstraints,preferredRecorderOptions} from '../assets/voice-capture.js';

function fixture(){
 let now=100000,extracts=0;const rows=[];
 const key='synthetic-diagnostic-key-'.repeat(3);
 const storage={async listSpeakerProfiles(owner){assert.equal(owner,'owner');return rows;}};
 const identity=createSpeakerIdentity({ownerId:'owner',storage,embeddingKey:key,threshold:.35});
 const old=createSpeakerIdentity({ownerId:'owner',storage,embeddingKey:'different-enrollment-fixture-key'.repeat(2)});
 rows.push({id:'readable-owner',relation:'owner',status:'active',representation:identity.protectRepresentation([0,1])});
 rows.push({id:'old-unreadable',relation:'owner',status:'active',representation:old.protectRepresentation([0,1])});
 rows.push({id:'guest',relation:'guest',status:'active',representation:identity.protectRepresentation([1,0])});
 const extractor={configured:true,async readiness(){return{available:true};},async extract(input){extracts++;return{sufficient:true,totalDurationSeconds:input.durationSeconds,speechSeconds:16,clippingRatio:0,quality:'accepted',sampleRate:48000,channelCount:1,representation:[1,0],representationVariants:[{label:'vad_v3',representation:[1,0]},{label:'legacy_full_waveform',representation:[Math.sqrt(1-.293**2),.293]}]};}};
 const diagnostic=createSpeakerDiagnostic({ownerId:'owner',key,extractor,identity,calibration:{threshold:.35},clock:()=>now});
 return {diagnostic,identity,extractor,rows,key,advance:ms=>now+=ms,count:()=>extracts};
}
const audio={consent:true,variant:'original',audioBase64:Buffer.from('synthetic audio fixture').toString('base64'),durationSeconds:24,mimeType:'audio/webm'};

test('diagnostic compares only readable owner; non-match is useful evidence, never authorization or enrollment',async()=>{
 const f=fixture(),before=JSON.stringify(f.rows),grant=await f.diagnostic.prepare();
 const report=await f.diagnostic.compare({...audio,token:grant.token});
 assert.equal(report.match.state,'unknown');assert.equal(report.match.threshold,.35);assert.equal(report.match.confidence,.293);
 assert.equal(report.match.comparedProfileId,'readable-owner');assert.equal(report.match.candidateCount,1);
 assert.equal(report.usableDiagnostic,true);assert.equal(report.privateAccessGranted,false);assert.equal(report.profileUpdated,false);
 assert.equal(JSON.stringify(f.rows),before);
 assert.equal(grant.profiles.profiles.find(p=>p.id==='old-unreadable').readability,'authentication_failed');
 assert.doesNotMatch(JSON.stringify(report),/"(?:representation|embedding|assertion|audioBase64|token)"/);
 const repeat=await f.diagnostic.compare({...audio,token:grant.token,variant:'original-repeat'});
 assert.equal(repeat.sha256,report.sha256);assert.deepEqual(repeat.match,report.match);
});
test('expired or forged diagnostic grants and missing consent never extract',async()=>{
 const f=fixture(),grant=await f.diagnostic.prepare();
 await assert.rejects(()=>f.diagnostic.compare({...audio,token:grant.token+'x'}),{code:'diagnostic_grant_invalid'});
 await assert.rejects(()=>f.diagnostic.compare({...audio,token:grant.token,consent:false}));
 f.advance(DIAGNOSTIC_TTL_MS);
 await assert.rejects(()=>f.diagnostic.compare({...audio,token:grant.token}),{code:'diagnostic_grant_expired'});assert.equal(f.count(),0);
});
test('valid matching diagnostic still grants no private assertion',async()=>{
 const f=fixture();f.extractor.extract=async()=>({sufficient:true,totalDurationSeconds:24,speechSeconds:18,clippingRatio:0,representation:[0,1]});
 const grant=await f.diagnostic.prepare(),report=await f.diagnostic.compare({...audio,token:grant.token});
 assert.equal(report.match.state,'confirmed');assert.equal(report.privateAccessGranted,false);assert.equal(report.assertion,undefined);
});
test('short decoded audio and clipping are not accepted for diagnosis; no raw exception reaches response',async()=>{
 const f=fixture(),grant=await f.diagnostic.prepare();
 f.extractor.extract=async()=>({sufficient:true,totalDurationSeconds:3,speechSeconds:1,clippingRatio:.05,representation:[0,1]});
 assert.equal((await f.diagnostic.compare({...audio,token:grant.token})).usableDiagnostic,false);
 f.extractor.extract=async()=>{throw Error('sensitive upstream content');};
 await assert.rejects(()=>f.diagnostic.compare({...audio,token:grant.token}),{message:'diagnostic_extraction_failed'});
});
test('tab vault is encrypted, uses non-exportable key, expires even when timer is suspended',async()=>{
 let now=1000,timer,deleted=[];let key;
 const subtle={generateKey:async(...args)=>{key=await webcrypto.subtle.generateKey(...args);return key;},encrypt:(...a)=>webcrypto.subtle.encrypt(...a),decrypt:(...a)=>webcrypto.subtle.decrypt(...a)};
 const vault=createDiagnosticVault({cryptoImpl:{subtle,getRandomValues:a=>webcrypto.getRandomValues(a)},clock:()=>now,schedule:cb=>{timer=cb;return 1;},cancel(){},onDelete:reason=>deleted.push(reason)});
 const input=new Uint8Array([5,8,13]);await vault.retain(input,now+1000);input.fill(0);
 assert.equal(key.extractable,false);await assert.rejects(()=>webcrypto.subtle.exportKey('raw',key));
 assert.deepEqual(await vault.read(),new Uint8Array([5,8,13]));now+=1001;
 await assert.rejects(()=>vault.read());assert.equal(vault.available(),false);assert.equal(deleted.at(-1),'expired');timer();
});
test('manual deletion and cancellation during encryption cannot restore discarded audio',async()=>{
 let finish;const cryptoImpl={getRandomValues:a=>a,subtle:{generateKey:async()=>({}),encrypt:()=>new Promise(r=>finish=r)}};
 const vault=createDiagnosticVault({cryptoImpl});const pending=vault.retain(new Uint8Array([1]),Date.now()+10000);
 await new Promise(r=>setImmediate(r));vault.erase();finish(new ArrayBuffer(8));await assert.rejects(()=>pending);assert.equal(vault.available(),false);
});
test('mono WAV encoding averages channels; full duration and halves preserve samples',()=>{
 const channels=[new Float32Array([1,.5,-.5,-1]),new Float32Array([0,.5,-.5,0])];
 const full=encodeMonoWav(channels,16000),view=new DataView(full.buffer);
 assert.equal(view.getUint32(24,true),16000);assert.equal(view.getUint16(22,true),1);assert.equal(view.getUint32(40,true),8);
 assert.equal(view.getInt16(44,true),16383);assert.equal(view.getInt16(50,true),-16384);
 const half=encodeMonoWav(channels,16000,2,4);assert.deepEqual(half.slice(44),full.slice(48));
});
test('diagnostic uses the same saved Nova microphone and recorder contract',()=>{
 assert.deepEqual(novaMicrophoneConstraints({getItem:key=>{assert.equal(key,'nova-microphone-device-id');return'device';}}),{echoCancellation:true,noiseSuppression:true,autoGainControl:true,deviceId:{exact:'device'}});
 assert.equal(preferredRecorderOptions({isTypeSupported:()=>true}).audioBitsPerSecond,64000);
});

test('same retained PCM yields bounded exact short windows without WebM concatenation or profile changes',async()=>{
 const f=fixture(),grant=await f.diagnostic.prepare(),before=JSON.stringify(f.rows);
 const wav=Buffer.from(encodeMonoWav([new Float32Array(24*16000).fill(.2)],16000));
 const part=diagnosticPcmWindow(wav,4,3.5);assert.equal(part.length,44+3.5*32000);assert.deepEqual(part.subarray(44),wav.subarray(44+4*32000,44+7.5*32000));
 assert.throws(()=>diagnosticPcmWindow(Buffer.from('invalid'),0,3.5));
 const report=await f.diagnostic.compare({...audio,token:grant.token,variant:'decoded-full',mimeType:'audio/wav',audioBase64:wav.toString('base64')});
 assert.equal(report.windowComparisons.length,8);assert.equal(f.count(),9);assert.equal(JSON.stringify(f.rows),before);
 assert.ok(report.windowComparisons.every(r=>r.privateAccessGranted===false&&r.match.threshold===.35));
});

async function call(api,path,input,headers={}){const req=Readable.from([JSON.stringify(input)]);Object.assign(req,{url:path,method:'POST',headers:{host:'nova.invalid',origin:'https://nova.invalid','content-type':'application/json',...headers}});const res={statusCode:200,setHeader(){},end(body){this.body=body;}};await api.handle(req,res);return{status:res.statusCode,data:JSON.parse(res.body)};}
test('HTTP diagnostic requires original connected Preview, signed-in workspace owner and same origin',async()=>{
 const f=fixture();let actor={role:'owner',ownerId:'owner',workspaceId:'owner'},reads=0;
 const options={ownerId:'owner',connectedPreview:true,continuityPreview:true,config:{allowedOrigins:[],voiceV2:{maxBodyBytes:3000000},speakerRecognition:{assertionKey:f.key,threshold:.35}},speakerExtractor:f.extractor,speakerIdentity:f.identity,authorizeConsole:async()=>actor,initialize:async()=>reads++,logger:{info(){},error(){}}};
 const api=createApi(options),path='/api/voice/speaker/diagnostic/prepare';
 actor={role:'owner',ownerId:'other',workspaceId:'other'};assert.equal((await call(api,path,{consent:true})).status,403);assert.equal(reads,0);
 actor=null;assert.equal((await call(api,path,{consent:true})).status,403);assert.equal(reads,0);
 actor={role:'owner',ownerId:'owner',workspaceId:'owner'};
 assert.equal((await call(api,path,{consent:true},{origin:'https://unrelated.invalid'})).status,403);assert.equal(reads,0);
 assert.equal((await call(api,path,{consent:false})).status,400);
 const prepared=await call(api,path,{consent:true});assert.equal(prepared.status,200);
 const result=await call(api,'/api/voice/speaker/diagnostic/compare',{...audio,token:prepared.data.token});assert.equal(result.status,200);assert.equal(result.data.privateAccessGranted,false);
 const production=createApi({...options,connectedPreview:false,continuityPreview:false});assert.equal((await call(production,path,{consent:true})).status,404);
 const unbound=createApi({...options,authorizeConsole:null});assert.equal((await call(unbound,path,{consent:true})).status,404);
});
