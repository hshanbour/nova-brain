import test from 'node:test';
import assert from 'node:assert/strict';
import {senderRestriction,withSenderRestriction} from '../src/email/sender-restriction.js';
const saved={upstreamStatus:429,checkedAt:'2026-11-20T17:17:40.419Z',retryAfterSeconds:96,providerResponse:{type:'plan',message:'Rate limit exceeded. Retry after 2026-11-21T17:04:51Z.'},transport:{retryAfter:'96',rateLimit:{'X-RateLimit-Limit':100,'X-RateLimit-Remaining':0,'X-RateLimit-Reset':1795280691}}};
test('actual conflicting response uses latest deadline without inventing allowance or permission',()=>{
 const r=senderRestriction(saved);assert.equal(r.notBefore,'2026-11-21T17:04:51.000Z');assert.equal(r.conflictingDeadlines,true);assert.equal(r.scope,'unconfirmed');assert.equal(r.allowance,'unconfirmed');assert.equal(r.requiresProviderClarification,true);assert.equal(r.automaticRetry,false);assert.equal(r.deadlines.length,3);
 const before=JSON.stringify(saved);assert.equal(withSenderRestriction(saved).retryAfterSeconds,96);assert.equal(JSON.stringify(saved),before);
});
test('HTTP date, missing, malformed and non429 responses remain conservative',()=>{
 assert.equal(senderRestriction(null),null);assert.equal(senderRestriction({upstreamStatus:200}),null);
 assert.equal(senderRestriction({upstreamStatus:429,transport:{retryAfter:'Sat, 21 Nov 2026 18:00:00 GMT'}}).notBefore,'2026-11-21T18:00:00.000Z');
 const r=senderRestriction({upstreamStatus:429,transport:{retryAfter:'broken',rateLimit:{'X-RateLimit-Reset':null}}});assert.equal(r.notBefore,null);assert.equal(r.automaticRetry,false);
});
