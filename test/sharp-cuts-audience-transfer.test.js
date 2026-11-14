import test from "node:test";
import assert from "node:assert/strict";
import {createSenderMarketingClient,parseSharpCutsSenderConfig} from "../src/email/sender-marketing.js";
import {describeCampaignSource,SHARP_CUTS_EMAIL_SOURCE} from "../src/email/sharp-cuts-audience.js";

const groupId="sharp_cuts_campaign", membershipHash=SHARP_CUTS_EMAIL_SOURCE.membershipHash;
const config=parseSharpCutsSenderConfig({NOVA_SHARP_CUTS_SENDER_API_TOKEN:"fixture",NOVA_SHARP_CUTS_SENDER_GROUP_ID:groupId});
const group={id:groupId};
const getAddress=key=>key+"@example.invalid";
function fixture({ambiguous=false,contaminated=false}={}) {
  const calls=[];
  const addresses=["new","existing","old-member","unsubscribed","unknown-eligibility","source-suppressed","future-booking"].map(getAddress);
  const evidence=addresses.filter(k=>!k.startsWith("unknown")).map(email=>({
    email,basis:"consent",suppressed:email.startsWith("source-suppressed"),futureBooking:email.startsWith("future-booking"),
    source:"synthetic_opt_in_record",reachabilityVerified:true,sharedAddressCleared:true,checkedAt:"2026-01-01T00:00:00Z",
  }));
  const makeRow=(email,tags=[])=>({email,status:{email:"active"},subscriber_tags:tags});
  const rows=[makeRow(addresses[1]),makeRow(addresses[2],[group]),{...makeRow(addresses[3]),status:{email:"unsubscribed",temail:"active"}}];
  if(contaminated)rows.push(makeRow(getAddress("foreign"),[group]));
  const client=createSenderMarketingClient({config,fetchImpl:async(url,opts)=>{
    const path=new URL(url).pathname, body=opts.body?JSON.parse(opts.body):null;
    calls.push({method:opts.method,path,body});
    if(opts.method==="GET"){
      const page=Number(new URL(url).searchParams.get("page")),data=rows.slice((page-1)*2,page*2);
      return Response.json({data,meta:{current_page:page,total:rows.length},links:{next:page*2<rows.length?"next":null}});
    }
    assert.equal(body.trigger_automation,false);
    if(path==="/v2/subscribers"){
      rows.push(makeRow(body.email,[group]));
      if(ambiguous){ambiguous=false;throw Error("connection lost after write");}
      return Response.json({success:true,data:{id:"new_subscriber"}});
    }
    assert.equal(path,"/v2/subscribers/groups/"+groupId);
    for(const email of body.subscribers)rows.find(r=>r.email===email).subscriber_tags.push(group);
    return Response.json({success:true});
  }});
  return {calls,client,input:{addresses,evidence,membershipHash},addresses};
}
test("review counts all profiles, pins membership and separates distinct directed addresses",()=>{
  const source={profileCount:1562,distinctProfileIds:1562,membershipHash,ambiguousProfiles:662};
  assert.equal(describeCampaignSource(source,0).transferStatus,"channel_evidence_required");
  assert.equal(describeCampaignSource({...source,membershipHash:"changed"},100).membershipStatus,"changed");
  assert.equal(describeCampaignSource(null,null).membershipStatus,"unavailable");
});
test("dry run traverses paginated subscribers, preserves suppressions and verifies exact group after an approved transfer",async()=>{
  const {client,input,calls,addresses}=fixture();
  const preview=await client.reconcileAudience(input);
  assert.equal(preview.eligible,3);assert.equal(preview.unknownEvidence,1);assert.equal(preview.futureBooking,1);assert.equal(preview.sourceSuppressed,1);assert.equal(preview.providerSuppressed,1);
  assert.equal(preview.create,1);assert.equal(preview.add,1);assert.equal(preview.alreadyInGroup,1);
  assert.ok(calls.every(c=>c.method==="GET"));assert.doesNotMatch(JSON.stringify(preview),/@/);
  await assert.rejects(client.reconcileAudience({...input,approvalHash:"wrong"}),/reviewed/);
  const result=await client.reconcileAudience({...input,approvalHash:preview.approvalHash});
  assert.equal(result.status,"membership_verified");assert.equal(result.contactsTransferred,2);assert.equal(result.alreadyInGroup,3);
  assert.deepEqual(calls.filter(c=>c.method==="POST").map(c=>c.body),[
    {email:addresses[0],groups:[groupId],trigger_automation:false},{subscribers:[addresses[1]],trigger_automation:false},
  ]);
  assert.equal((await client.reconcileAudience({...input,approvalHash:preview.approvalHash})).contactsTransferred,0);
});
test("ambiguous provider acknowledgement stops and recovery reads membership before retrying",async()=>{
  const {client,input,calls}=fixture({ambiguous:true});
  const {approvalHash}=await client.reconcileAudience(input);
  const partial=await client.reconcileAudience({...input,approvalHash});
  assert.equal(partial.status,"provider_outcome_requires_reconciliation");assert.equal(partial.contactsTransferred,null);
  assert.equal(calls.filter(c=>c.method==="POST").length,1);
  assert.equal((await client.reconcileAudience({...input,approvalHash})).status,"membership_verified");
  assert.equal(calls.filter(c=>c.method==="POST"&&c.path==="/v2/subscribers").length,1);
});
test("contaminated target group and changing source cannot trigger writes",async()=>{
  const {client,input,calls}=fixture({contaminated:true});
  const review=await client.reconcileAudience(input);
  assert.equal(review.unexpectedGroupMembers,1);
  await assert.rejects(client.reconcileAudience({...input,approvalHash:review.approvalHash}),/reviewed/);
  await assert.rejects(client.reconcileAudience({...input,membershipHash:"wrong"}),/cohort/);
  assert.ok(calls.every(c=>c.method==="GET"));
});
