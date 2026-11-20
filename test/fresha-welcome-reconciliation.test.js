import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileFreshaWelcome} from '../src/email/fresha-welcome-reconciliation.js';
const live=(id,Email,extra={})=>({'Client ID':id,Email,'Accepts Marketing':'Yes','Accepts SMS Marketing':'Yes',Blocked:'No',...extra});
test('fresh Fresha preferences, future bookings and provider suppressions narrow the unchanged source',()=>{
 const original=['ok','optout','blocked','shared','future','unknown','bounce','missing'].map(v=>({Email:v+'@example.test'}));
 original.push({Email:'shared@example.test'});
 const current=[live('1','ok@example.test'),live('2','optout@example.test',{'Accepts Marketing':'No'}),live('3','blocked@example.test',{Blocked:'Yes'}),live('4','shared@example.test'),live('5','future@example.test'),live('6','unknown@example.test',{'Accepts Marketing':''}),live('7','bounce@example.test'),live('8','new@example.test')];
 const before=JSON.stringify({original,current});
 const r=reconcileFreshaWelcome({original,current,upcomingIds:['5'],expectedUpcomingCount:1,providerSubscribers:[{email:'bounce@example.test',status:{email:'bounced'}}]});
 assert.deepEqual(r.counts,{sourceAddresses:8,missingCurrent:1,marketingOptOut:1,blocked:1,sharedAddress:1,upcomingBooking:1,unknownPreference:1,providerSuppressed:1,eligible:1});
 assert.deepEqual(r.records.filter(x=>x.eligible).map(x=>x.email),['ok@example.test']);
 assert.equal(JSON.stringify({original,current}),before);assert.equal(r.contactsUploaded,0);assert.equal(r.sent,0);
});
test('incomplete booking evidence and duplicate identifiers fail closed',()=>{
 assert.throws(()=>reconcileFreshaWelcome({original:[],current:[],upcomingIds:[],expectedUpcomingCount:2}),/incomplete/);
 assert.throws(()=>reconcileFreshaWelcome({original:[],current:[live('1','a'),live('1','b')],upcomingIds:[],expectedUpcomingCount:0}),/identifiers/);
});
