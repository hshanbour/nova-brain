import test from 'node:test';
import assert from 'node:assert/strict';
import {createSpeakerIdentity} from '../src/voice/speaker-identity.js';
import {createEcapaSpeakerEngine} from '../src/voice/ecapa-speaker-engine.js';

test('enrollment readiness checks scoped decryption without exposing or changing voiceprints',async()=>{
  const rows=[];const storage={async listSpeakerProfiles(owner,options){assert.equal(owner,'owner-test');assert.equal(options.includeRepresentation,true);return rows;}};
  const identity=createSpeakerIdentity({storage,ownerId:'owner-test',embeddingKey:'synthetic-correct-key-'.repeat(3)});
  rows.push({status:'active',relation:'owner',representation:identity.protectRepresentation([1,2,3])});
  rows.push({status:'revoked',relation:'owner',representation:{algorithm:'aes-256-gcm'}});
  const before=JSON.stringify(rows);
  assert.deepEqual(await identity.enrollmentReadiness(),{activeProfiles:1,readableProfiles:1,unreadableProfiles:0,readableOwnerProfiles:1});
  const wrong=createSpeakerIdentity({storage,ownerId:'owner-test',embeddingKey:'synthetic-wrong-key-'.repeat(3)});
  assert.deepEqual(await wrong.enrollmentReadiness(),{activeProfiles:1,readableProfiles:0,unreadableProfiles:1,readableOwnerProfiles:0});
  assert.equal(JSON.stringify(rows),before);
  const engine=createEcapaSpeakerEngine({identity,extractor:{configured:true,async readiness(){return {available:false,status:'Unavailable',errorCode:'worker_rejected'};}}});
  const ready=await engine.readiness();
  assert.equal(ready.available,false);assert.equal(ready.enrollment.readableOwnerProfiles,1);
  assert.equal('representation' in ready.enrollment,false);
});

test('diagnostics distinguish a historical wrong-key enrollment without disclosing vectors or mutating it',async()=>{
 const rows=[];const storage={async listSpeakerProfiles(){return rows;}};
 const old=createSpeakerIdentity({storage,ownerId:'owner',embeddingKey:'older-fixture-key-'.repeat(3)});
 const current=createSpeakerIdentity({storage,ownerId:'owner',embeddingKey:'current-fixture-key-'.repeat(3),threshold:.35});
 rows.push({id:'historical',status:'active',relation:'owner',representation:old.protectRepresentation([1,0,0])});
 rows.push({id:'current',status:'active',relation:'owner',representation:current.protectRepresentation([0,1,0])});
 const before=JSON.stringify(rows);const readiness=await current.enrollmentReadiness({diagnostics:true});
 assert.equal(readiness.profiles[0].readability,'authentication_failed');
 assert.equal(readiness.profiles[1].readability,'readable');
 assert.equal(readiness.profiles[1].dimensions,3);
 const match=await current.recognizeMany([{label:'vad_v3',representation:[Math.sqrt(1-.293**2),.293,0]},{label:'legacy_full_waveform',representation:[1,0,0]}]);
 assert.equal(match.state,'unknown');assert.equal(match.threshold,.35);
 assert.equal(match.comparisonDiagnostics.comparedProfileId,'current');
 assert.equal(match.comparisonDiagnostics.profileDimensions,3);
 assert.ok(Math.abs(match.comparisonDiagnostics.vadScore-.293)<.0001);
 assert.equal(match.comparisonDiagnostics.legacyScore,0);
 assert.doesNotMatch(JSON.stringify(readiness),/"(?:ciphertext|tag|iv|vector|representation)"|\[0,1,0\]/);
 assert.equal(JSON.stringify(rows),before);
});

test('malformed readable data cannot poison matching against another valid profile',async()=>{
 const rows=[{id:'invalid',status:'active',relation:'owner',representation:[0,0,0]},{id:'valid',status:'active',relation:'owner',representation:[1,0,0]}];
 const identity=createSpeakerIdentity({storage:{async listSpeakerProfiles(){return rows;}},ownerId:'owner',threshold:.35});
 const ready=await identity.enrollmentReadiness({diagnostics:true});
 assert.equal(ready.profiles[0].readability,'invalid_representation');
 assert.equal((await identity.recognize([1,0,0])).speakerProfileId,'valid');
});
