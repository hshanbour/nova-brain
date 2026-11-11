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
