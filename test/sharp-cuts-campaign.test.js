import test from "node:test";
import assert from "node:assert/strict";
import {analyseSharpCutsWinbackAudience,buildSharpCutsWinbackReview,SHARP_CUTS_BOOKING_URL,SHARP_CUTS_SERVICE_SOURCE,SHARP_CUTS_STAGING_SNAPSHOT,SHARP_CUTS_VERIFIED_SERVICES} from "../src/automation/sharp-cuts-campaign.js";

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
  assert.match(review.email.body,/SAME SHARP CUTS\. A WHOLE NEW EXPERIENCE/);assert.match(review.email.body,/It's been a while/);assert.match(review.email.body,/fresh new look/);assert.match(review.email.body,/NOW IT'S YOUR TURN FOR A FRESH LOOK/);assert.match(review.email.body,new RegExp(SHARP_CUTS_BOOKING_URL.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.equal(review.deliveryCost.amount,null);assert.equal(review.whatsapp.eligibilityIndependentFromEmail,true);
});

test("premium comeback offer uses only verified service prices and renders a mobile email without pretending placeholders are shop photos",()=>{
  const review=buildSharpCutsWinbackReview(analyseSharpCutsWinbackAudience(rows,{asOf:AS_OF}));
  assert.equal(review.version,4);assert.equal(review.offer.proposal,"20% off one selected adult cut for customers inactive more than 90 days");
  assert.deepEqual(review.offer.eligibleServices.map(({name,priceGbp,pricePrefix,offerPriceGbp,savingGbp})=>({name,priceGbp,pricePrefix,offerPriceGbp,savingGbp})),[
    {name:"Sharp cuts premium package",priceGbp:40,pricePrefix:"from",offerPriceGbp:32,savingGbp:8},
    {name:"The premium package",priceGbp:37,pricePrefix:null,offerPriceGbp:29.6,savingGbp:7.4},
    {name:"Haircut and beard trim",priceGbp:25,pricePrefix:null,offerPriceGbp:20,savingGbp:5},
    {name:"Haircut (no beard trim )",priceGbp:20,pricePrefix:null,offerPriceGbp:16,savingGbp:4}
  ]);
  assert.equal(review.offer.serviceSource,SHARP_CUTS_SERVICE_SOURCE);assert.equal(SHARP_CUTS_VERIFIED_SERVICES.length,10);
  assert.match(review.email.html,/GENUINE SHOP PHOTO PLACEHOLDER/);assert.match(review.email.html,/No stock imagery/);assert.match(review.email.html,/BOOK YOUR NEXT CUT/);assert.match(review.email.html,/Unsubscribe from Sharp Cuts emails/);
  assert.match(review.email.html,/GENTS BARBERS/);assert.doesNotMatch(review.email.html,/PREMIUM GROOMING/);assert.equal((review.email.html.match(/>20% OFF</g)||[]).length,1);
  assert.match(review.email.html,/from £40\.00/);assert.match(review.email.html,/£37\.00/);assert.match(review.email.html,/£25\.00/);assert.match(review.email.html,/£20\.00/);assert.doesNotMatch(review.email.html,/from £32\.00|£29\.60|£16\.00|text-decoration:line-through/);
  assert.match(review.email.html,/#070707/);assert.match(review.email.html,/#d3a53b/i);assert.match(review.email.html,/#f2d16f/i);assert.match(review.email.html,/#f2eee5/i);assert.doesNotMatch(review.email.body,/20% OFF/);
  assert.doesNotMatch(review.email.html,/<script|stock photo|data:image/i);assert.equal(review.email.imageStatus,"owner_shop_photos_required");
  assert.equal(review.social.concepts.length,2);assert.ok(review.social.concepts.every(concept=>concept.status==="image_placeholders_only"));assert.equal(review.social.publishingEnabled,false);
  assert.equal(review.approval.approveEnabled,false);assert.equal(review.audience.verifiedSendableRecipients,0);assert.equal(review.safeguards.liveSend,false);
});

test("staging snapshot exposes only safe aggregates",()=>{
  assert.deepEqual(SHARP_CUTS_STAGING_SNAPSHOT.contact,{email:1571,phone:1649,both:1569,emailOnly:2,phoneOnly:80,missingBoth:340});
  assert.equal(SHARP_CUTS_STAGING_SNAPSHOT.duplicates.confirmedPairs,10);assert.equal(SHARP_CUTS_STAGING_SNAPSHOT.duplicates.ambiguousPairs,1647);assert.equal(SHARP_CUTS_STAGING_SNAPSHOT.duplicates.mergedProfiles,0);
  assert.doesNotMatch(JSON.stringify(SHARP_CUTS_STAGING_SNAPSHOT),/@|\+44|ciphertext|nonce/);
});
