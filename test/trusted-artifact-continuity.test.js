import test from "node:test";
import assert from "node:assert/strict";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createTrustedArtifactContinuity,isExplicitTrustedArtifactRequest} from "../src/autonomy/trusted-artifact-continuity.js";

const OWNER="owner",REPOSITORY="hshanbour/nova-brain",BRANCH="codex/combined-nova-preview-d5b5-c5bd",SOURCE="coding_"+"1".repeat(32),SHA="a".repeat(40),BASE="b".repeat(40);

async function fixture({sourceBranch="feat/old",startingCommit="c".repeat(40),localProof}={}){
  const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER},projects:[{id:"nova-brain",name:"Nova Brain"}]});
  await storage.createAutonomyTask({id:SOURCE,ownerId:OWNER,projectId:"nova-brain",title:"Recent Conversations drawer accessibility",objective:"Improve drawer keyboard and focus behavior.",taskType:"coding_delegation",branch:sourceBranch,startingCommit,currentCommit:SHA,metadata:{codingJob:{repository:{slug:REPOSITORY,branch:sourceBranch}},steps:[{type:"delegate_coding"}]}});
  await storage.updateAutonomyTask(SOURCE,OWNER,{status:"completed",currentCommit:SHA});
  await storage.recordAutonomyStep({taskId:SOURCE,stepId:"1:delegate_coding",stepType:"delegate_coding",capability:"codex_local",operationFingerprint:"coding",status:"completed",result:{status:"completed",summary:"Drawer completed.",finalLocalSha:SHA,filesChanged:["assets/console.js","test/console-static.test.js"],tests:[{name:"focused",status:"passed",summary:null}],pushOccurred:false,deploymentOccurred:false,executor:{localRef:`refs/nova/coding-jobs/${SOURCE}`}}});
  const calls={integration:[],delivery:[]},codingDelegation={async prepareTrustedArtifact(input,context){calls.integration.push({input,context});return{task:{id:"orchestration_"+"2".repeat(32)},creationRequest:{parentTaskId:"orchestration_"+"2".repeat(32),specificationHash:"d".repeat(64)}};}},artifactDelivery={async create(id,context){calls.delivery.push({id,context});return{task:{id:"shipping_"+"3".repeat(32)}};}};
  const service=createTrustedArtifactContinuity({storage,ownerId:OWNER,approvedRepository:REPOSITORY,approvedBranch:BRANCH,verifyRemote:async()=>({currentTip:BASE}),codingDelegation,artifactDelivery,verifyLocalArtifact:localProof});
  return{storage,service,calls};
}

test("historical completed artifacts become bounded candidates and divergent artifacts create one current-baseline integration",async()=>{
  const f=await fixture(),[candidate]=await f.service.candidates();assert.equal(candidate.id,SOURCE);assert.equal(candidate.title,"Recent Conversations drawer accessibility");assert.deepEqual(candidate.allowedTransitions,["artifact_adoption"]);
  const first=await f.service.adopt(SOURCE,{conversationId:"conversation-current",runId:"run-1"});assert.equal(first.adoptionMode,"current_baseline_integration");assert.equal(f.calls.delivery.length,0);assert.equal(f.calls.integration.length,1);
  const artifact=f.calls.integration[0].input.trustedArtifact;assert.deepEqual(artifact,{version:1,sourceTaskId:SOURCE,sourceStateVersion:2,repository:REPOSITORY,sourceBranch:"feat/old",commitSha:SHA,artifactRef:`refs/nova/coding-jobs/${SOURCE}`,filesChanged:["assets/console.js","test/console-static.test.js"]});
  assert.equal(f.calls.integration[0].context.conversationId,"conversation-current");
});

test("an exact task id is deterministic only when paired with an explicit continuation action",()=>{
  assert.equal(isExplicitTrustedArtifactRequest(`Ship ${SOURCE}`,SOURCE),true);assert.equal(isExplicitTrustedArtifactRequest(`What is ${SOURCE}?`,SOURCE),false);assert.equal(isExplicitTrustedArtifactRequest(`Ship ${"f".repeat(40)}`,SOURCE),false);
});

test("only a locally proven compatible artifact can flow directly into existing artifact delivery",async()=>{
  const f=await fixture({sourceBranch:BRANCH,startingCommit:BASE,localProof:async artifact=>({commitExists:artifact.commitSha===SHA,refMatches:true})});
  const result=await f.service.adopt(SOURCE,{conversationId:"conversation-current"});assert.equal(result.adoptionMode,"direct_delivery");assert.equal(f.calls.delivery.length,1);assert.equal(f.calls.integration.length,0);
});

test("unknown, incomplete, already-shipping, and foreign-repository artifacts fail closed",async()=>{
  const f=await fixture();await assert.rejects(()=>f.service.adopt("coding_"+"9".repeat(32),{conversationId:"c"}),error=>error.code==="trusted_artifact_source_invalid");
  await f.storage.createAutonomyTask({id:"shipping_"+"4".repeat(32),ownerId:OWNER,projectId:"nova-brain",title:"shipping",objective:"shipping",taskType:"artifact_delivery",branch:BRANCH,startingCommit:BASE,currentCommit:BASE,metadata:{artifactDelivery:{sourceTaskId:SOURCE}}});
  assert.equal((await f.service.candidates()).length,0);await assert.rejects(()=>f.service.adopt(SOURCE,{conversationId:"c"}),error=>error.code==="trusted_artifact_source_invalid");
});
