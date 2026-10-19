import test from "node:test";
import assert from "node:assert/strict";
import {auditCustomerProfiles,buildMigrationReadyCustomerRows,inspectCsvHeaders,mapFreshaCustomerRows,parseCsvRecords} from "../src/automation/sharp-cuts-customer-audit.js";

const AS_OF=new Date("2026-10-18T12:00:00.000Z"),KEY="k".repeat(32);

test("customer audit detects conservative duplicates, contact gaps, inactivity, bookings, eligibility and delivery without retaining PII",()=>{
  const records=[
    {sourceRef:"fresha-1",email:" FIRST@example.test ",mobile:"+44 7000 000001",lastVisitAt:"2026-09-17",marketingBasis:"consent",deliveryEvidence:{email:"delivered",sms:"none",whatsapp:"unknown"}},
    {sourceRef:"fresha-2",email:"first@example.test",mobile:"",lastVisitAt:"2026-09-01",marketingBasis:"soft_opt_in_verified",deliveryEvidence:{email:"sent"}},
    {sourceRef:"fresha-3",email:"",mobile:"",lastVisitAt:"2026-08-01",marketingBasis:"unknown",suppressed:true,deliveryEvidence:{email:"failed"}},
    {sourceRef:"fresha-4",email:"fourth@example.test",mobile:"+44 7000 000004",lastVisitAt:"2026-06-01",nextBookingAt:"2026-10-22",marketingBasis:"consent",deliveryEvidence:{sms:"delivered"}}
  ];
  const audit=auditCustomerProfiles(records,{asOf:AS_OF,identityKey:KEY,expectedCount:4});
  assert.equal(audit.counts.profiles,4);assert.equal(audit.counts.duplicateClusters,1);assert.equal(audit.counts.duplicateProfiles,2);assert.equal(audit.counts.missingEmail,1);assert.equal(audit.counts.missingMobile,2);assert.equal(audit.counts.missingBoth,1);assert.equal(audit.counts.upcomingBooking,1);assert.equal(audit.counts.inactive30,1);assert.equal(audit.counts.inactive45,1);assert.equal(audit.counts.inactive60,1);assert.equal(audit.counts.inactive90,1);assert.equal(audit.counts.emailEligible,3);assert.equal(audit.counts.smsEligible,2);assert.equal(audit.deliveryEvidence.email.delivered,1);assert.equal(audit.deliveryEvidence.sms.delivered,1);assert.equal(audit.rawContactDataRetained,false);assert.equal(audit.profiles.every(item=>/^[a-f0-9]{64}$/.test(item.profileKey)),true);
  const serialised=JSON.stringify(audit);assert.doesNotMatch(serialised,/example\.test|7000|fresha-/);assert.equal(buildMigrationReadyCustomerRows(audit).length,4);
});

test("customer audit fails closed on incomplete exports, weak identity keys and repeated source identifiers",()=>{
  const record={sourceRef:"one",email:"one@example.test"};
  assert.throws(()=>auditCustomerProfiles([record],{identityKey:KEY,expectedCount:1991}),error=>error.code==="sharp_cuts_customer_export_incomplete");
  assert.throws(()=>auditCustomerProfiles([record],{identityKey:"short"}),error=>error.code==="sharp_cuts_identity_key_required");
  assert.throws(()=>auditCustomerProfiles([record,record],{identityKey:KEY}),error=>error.code==="sharp_cuts_customer_source_duplicate");
});

test("header inspection reads no customer rows or personal data",()=>{
  const result=inspectCsvHeaders('\uFEFF"Client name","Mobile number","Email","Last appointment"\r\n"A Person","07000000000","a@example.test","2026-01-01"');
  assert.deepEqual(result.headers,["Client name","Mobile number","Email","Last appointment"]);assert.equal(result.rowsRead,0);assert.equal(result.personalDataRead,false);assert.doesNotMatch(JSON.stringify(result),/A Person|070000|a@example/);
});

test("CSV parsing requires an explicit mapping and preserves quoted cells without guessing fields",()=>{
  const rows=parseCsvRecords('Client ID,Email,Mobile,Last appointment,Consent\r\n1,"a@example.test","+44 7000, 000001",2026-09-01,consent\r\n2,,,2026-08-01,unknown');
  const mapped=mapFreshaCustomerRows(rows,{sourceRef:"Client ID",email:"Email",mobile:"Mobile",lastVisitAt:"Last appointment",marketingBasis:"Consent"});
  assert.equal(mapped.length,2);assert.equal(mapped[0].mobile,"+44 7000, 000001");assert.equal(mapped[1].marketingBasis,"unknown");
  assert.throws(()=>mapFreshaCustomerRows(rows,{sourceRef:"Client ID"}),error=>error.code==="sharp_cuts_customer_mapping_required");
});

