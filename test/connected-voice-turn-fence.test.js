import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
import {createTurnPcm} from '../assets/turn-pcm.js';
import {createApi} from '../src/http/api.js';
import {createSpeakerAssertions} from '../src/voice/speaker-assertion.js';

test('48kHz mono capture preserves onset, writes a 16kHz WAV, never carries a prior speaker; overlap and overflow discard',()=>{
 const c=createTurnPcm(48000),chunk=v=>new Float32Array(1920).fill(v);
 for(let n=0;n<20;n++)c.write(chunk(.25));c.begin();for(let n=0;n<30;n++)c.write(chunk(.5));
 const a=c.end(),view=new DataView(a.bytes.buffer);
 assert.equal(view.getUint32(24,true),16000);assert.equal(a.durationSeconds,1.52);assert.equal(view.getUint32(40,true),a.bytes.length-44);
 assert.equal(view.getInt16(44,true),8192);assert.equal(view.getInt16(a.bytes.length-2,true),16384);
 c.begin();c.write(chunk(-.5));const b=c.end();assert.equal(b.durationSeconds,.04);assert.equal(new DataView(b.bytes.buffer).getInt16(44,true),-16383);
 c.begin();c.write(chunk(1));c.begin();assert.equal(c.end(),null);
 c.begin();for(let n=0;n<705;n++)c.write(chunk(.1));assert.equal(c.end(),null);
});

test('original connected API denies replay, older recordings, stale closes and unsigned private requests',async()=>{
 const storage=createInMemoryStorage(),ownerId='fixture',sessionId=randomUUID(),turn=randomUUID(),guest=randomUUID(),nextSession=randomUUID(),newTurn=randomUUID();
 const assertions=createSpeakerAssertions({key:'fixture-only-verification-signing-key-1234567890'});
 let calls=0;
 const api=createApi({connectedPreview:true,ownerId,initialize:async()=>{},storage,config:{allowedOrigins:[],maxBodyBytes:12000,speakerRecognition:{}},speakerAssertions:assertions,speakerIdentity:{get:async()=>({relation:'owner',status:'active'})},agent:{async run(){calls++;return{message:'receipt',runId:'fixture'};}},logger:{info(){},error(){}}});
 async function post(path,body){const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(v){this.body=v;}},req=Object.assign(Readable.from([JSON.stringify(body)]),{method:'POST',url:path,headers:{host:'nova.test',origin:'https://nova.test','content-type':'application/json'}});await api.handle(req,res);return res.statusCode;}
 const begin=(session_id,turn_seq,turn_id)=>post('/api/voice/realtime/turn-state',{op:'begin',session_id,turn_seq,turn_id});
 const evidence=(session_id,turn_seq,turn_id)=>{const s={session_id,turn_seq,turn_id,match_status:'confirmed',speaker_label:'owner',speaker_profile_id:'fixture-profile'};return {...s,assertion:assertions.issue(s)}};
 const run=s=>post('/api/agent',{message:'private task',context:{voice:true,speaker:s}});
 await storage.voiceTurnFence({op:'open',ownerId,sessionId});assert.equal(await begin(sessionId,1,turn),200);
 const old=evidence(sessionId,1,turn);assert.equal(await begin(sessionId,2,guest),200);
 assert.equal(await run(old),409);assert.equal(await begin(sessionId,1,turn),409);assert.equal(await run({speaker_label:'owner',turn_id:guest}),403);
 await storage.voiceTurnFence({op:'open',ownerId,sessionId:nextSession});assert.equal(await begin(nextSession,1,newTurn),200);
 await post('/api/voice/realtime/turn-state',{op:'close',session_id:sessionId});
 const fresh=evidence(nextSession,1,newTurn);assert.equal(await run(fresh),200);assert.equal(await run(fresh),409);assert.equal(calls,1);
});
