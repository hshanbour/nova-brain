import test from 'node:test';
import assert from 'node:assert/strict';
import {assertDedicatedProfile,connectionEvidence,isSharpCutsCalendar} from '../src/booking/fresha-browser-session.js';
import {resolve,join} from 'node:path';
test('dedicated credentials cannot be stored under the repository or in a general browser profile',()=>{
  const repo=resolve('test-repo');
  assert.throws(()=>assertDedicatedProfile(join(repo,'NovaBrain','FreshaExecutor'),repo));
  assert.throws(()=>assertDedicatedProfile(resolve('../Edge/User Data'),repo));
  assert.ok(assertDedicatedProfile(resolve('../NovaBrain/FreshaExecutor'),repo));
});
test('login and MFA do not establish booking authority',()=>{
  for(const data of [{url:'https://accounts.fresha.com/login?token=private'}, {url:'https://partners.fresha.com/calendar',challengeVisible:true,calendarVisible:true}]){
    const state=connectionEvidence(data);assert.equal(state.writesEnabled,false);assert.ok(!JSON.stringify(state).includes('private'));
  }
});
test('calendar alone never proves the business or grants write permission',()=>{
  assert.equal(connectionEvidence({url:'https://partners.fresha.com/calendar',calendarVisible:true}).state,'business_verification_required');
  assert.equal(connectionEvidence({url:'https://partners.fresha.com/calendar',calendarVisible:true,businessVisible:true}).writesEnabled,false);
  assert.equal(connectionEvidence({url:'https://attacker.example/calendar',calendarVisible:true,businessVisible:true}).state,'sign_in_required');
});
test('business evidence is only usable on the exact Sharp Cuts live calendar',()=>{
  assert.equal(isSharpCutsCalendar('https://partners.fresha.com/calendar?location_id=139805'),true);
  for(const url of ['https://partners.fresha.com/calendar?location_id=999','https://evil.test/calendar?location_id=139805','https://partners.fresha.com/setup?location_id=139805','invalid'])assert.equal(isSharpCutsCalendar(url),false);
});
