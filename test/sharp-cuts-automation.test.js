import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {classifyRetentionRecords,createSharpCutsAutomationService,syntheticRetentionFixture} from "../src/automation/sharp-cuts-automation.js";

const OWNER="owner-primary",AS_OF=new Date("2026-10-17T09:00:00.000Z");

test("30/45/60 retention segmentation excludes booked customers and fails closed on consent and suppression",()=>{
  const result=classifyRetentionRecords(syntheticRetentionFixture(AS_OF),{asOf:AS_OF});
  assert.deepEqual(result.counts,{inactive30:1,inactive45:1,inactive60:2,notDue:1,alreadyBooked:1,blocked:2,eligibleForOwnerReview:2});
  assert.equal(result.records.find(item=>item.customerRef==="demo-customer-003").recommendedAction,"blocked");
  assert.match(result.records.find(item=>item.customerRef==="demo-customer-003").reason,/No verified electronic-marketing basis/);
  assert.equal(result.records.find(item=>item.customerRef==="demo-customer-004").recommendedAction,"blocked");
  assert.match(result.records.find(item=>item.customerRef==="demo-customer-004").reason,/Suppression/);
  assert.equal(result.records.find(item=>item.customerRef==="demo-customer-005").segment,"already_booked");
  assert.equal(result.records.every(item=>item.customerRef.startsWith("demo-customer-")),true);
});

test("the demonstration is idempotent, project-isolated, durable in Activity, and never sends",async()=>{
  const storage=createInMemoryStorage({clock:()=>AS_OF});await storage.initialize({owner:{id:OWNER,fullName:"Mohammad"},projects:[{id:"sharp-cuts",name:"Sharp Cuts"},{id:"sharp-cuts-web",name:"Sharp Cuts Web"}]});
  const service=createSharpCutsAutomationService({storage,ownerId:OWNER,clock:()=>AS_OF}),first=await service.runSyntheticRetentionDemo(),second=await service.runSyntheticRetentionDemo(),dashboard=await service.dashboard();
  assert.equal(first.created,true);assert.equal(second.created,false);assert.equal(dashboard.activity.length,1);assert.equal(dashboard.activity[0].projectId,"sharp-cuts-web");assert.equal(dashboard.safeguards.liveMessagesSent,false);assert.equal(dashboard.safeguards.rawCustomerDataStored,false);assert.equal(dashboard.sections.pendingApprovals.count,0);
  assert.equal((await storage.listActivity(OWNER,{projectId:"sharp-cuts"})).length,0);
});

test("the demonstration refuses to create or merge the missing Sharp Cuts Web project",async()=>{
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER,fullName:"Mohammad"},projects:[{id:"sharp-cuts",name:"Sharp Cuts"}]});
  const service=createSharpCutsAutomationService({storage,ownerId:OWNER,clock:()=>AS_OF});
  await assert.rejects(()=>service.runSyntheticRetentionDemo(),error=>error.code==="sharp_cuts_project_required");
  assert.deepEqual((await storage.listProjects(OWNER)).map(item=>item.id),["sharp-cuts"]);
});

test("the n8n workflow export is inactive, fixture-only, and contains no provider or customer credential",async()=>{
  const workflow=JSON.parse(await readFile(new URL("../automations/n8n/sharp-cuts-retention-monitor.demo.json",import.meta.url),"utf8")),serialized=JSON.stringify(workflow);
  assert.equal(workflow.active,false);assert.equal(workflow.meta.fixtureOnly,true);assert.equal(workflow.meta.liveMessaging,false);assert.equal(workflow.meta.ownerApprovalRequired,true);assert.deepEqual(workflow.nodes.map(node=>node.type),["n8n-nodes-base.manualTrigger","n8n-nodes-base.code","n8n-nodes-base.code"]);assert.doesNotMatch(serialized,/api[_-]?key|authorization|phone|email|fresha\.com|twilio/i);
});
