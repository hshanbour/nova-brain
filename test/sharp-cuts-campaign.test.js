import test from "node:test";
import assert from "node:assert/strict";
import {analyseSharpCutsWinbackAudience,buildSharpCutsWinbackReview,SHARP_CUTS_BOOKING_URL,SHARP_CUTS_STAGING_SNAPSHOT} from "../src/automation/sharp-cuts-campaign.js";

const AS_OF=new Date("2026-10-19T00:00:00.000Z");
const rows=[
  {Email:"ONE@example.test","Mobile number":"+44 7000 000001","Last appt.":"1 Jan 2026"},
  {Email:"one@example.test","Mobile number":"+44 7000 000002","Last appt.":"2 Jan 2026"},
  {Email:"two@example.test","Mobile number":"","Last appt.":"1 Sep 2026"},
  {Email:"future@example.test","Mobile number":"+44 7000 000004","Last appt.":"30 Oct 2026"},
  {Email:"none@example.test","Mobile number":"","Last appt.":""}
];

test("real-audience analyser deduplicates recipients, excludes future/no-history rows, and retains no identifiers",()=>{
  const result=analyseSharpCutsWinbackAudience(rows,{asOf:AS_OF});
  assert.equal(result.candidateProfiles,2);assert.equal(result.email.uniqueRecipientCandidates,1);assert.equal(result.email.duplicateAddressProfilesExcluded,1);
  assert.equal(result.futureDateProxyExcluded,1);assert.equal(result.noVisitHistoryExcluded,1);assert.equal(result.verifiedEligibility.email,0);assert.equal(result.sendAuthorised,false);
  assert.doesNotMatch(JSON.stringify(result),/example\.test|7000/);assert.match(result.audienceSnapshotHash,/^[a-f0-9]{64}$/);
});

test("owner review includes exact offer/copy and fails closed before consent, booking and Sharp Cuts sender evidence",()=>{
  const audit=analyseSharpCutsWinbackAudience(rows,{asOf:AS_OF}),review=buildSharpCutsWinbackReview(audit);
  assert.equal(review.projectId,"sharp-cuts-web");assert.equal(review.status,"blocked_before_approval");assert.equal(review.approval.status,"not_created");assert.equal(review.approval.approveEnabled,false);assert.equal(review.approval.rejectEnabled,true);
  assert.equal(review.audience.verifiedSendableRecipients,0);assert.equal(review.safeguards.liveSend,false);assert.equal(review.safeguards.projectIsolated,true);
  assert.match(review.email.body,/upgraded shop/);assert.match(review.email.body,/new chairs/);assert.match(review.email.body,/new décor/);assert.match(review.email.body,/team/);assert.match(review.email.body,new RegExp(SHARP_CUTS_BOOKING_URL.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.equal(review.deliveryCost.amount,null);assert.equal(review.whatsapp.eligibilityIndependentFromEmail,true);
});

test("staging snapshot exposes only safe aggregates",()=>{
  assert.deepEqual(SHARP_CUTS_STAGING_SNAPSHOT.contact,{email:1571,phone:1649,both:1569,emailOnly:2,phoneOnly:80,missingBoth:340});
  assert.equal(SHARP_CUTS_STAGING_SNAPSHOT.duplicates.confirmedPairs,10);assert.equal(SHARP_CUTS_STAGING_SNAPSHOT.duplicates.ambiguousPairs,1647);assert.equal(SHARP_CUTS_STAGING_SNAPSHOT.duplicates.mergedProfiles,0);
  assert.doesNotMatch(JSON.stringify(SHARP_CUTS_STAGING_SNAPSHOT),/@|\+44|ciphertext|nonce/);
});
