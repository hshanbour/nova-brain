import test from "node:test";
import assert from "node:assert/strict";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {createGithubWriteAttestation,LIVE_PUSH_ATTESTATION,REQUIRED_BLOCKER_SHA} from "../src/autonomy/github-write-attestation.js";

const OWNER="owner",input=()=>({...LIVE_PUSH_ATTESTATION}),completed=["1:inspect_repo","2:apply_patch","3:run_focused_tests","4:run_full_tests","5:inspect_diff","6:commit"];
async function fixture({approvalStatus="approved",tool="git_push",approvalSha=LIVE_PUSH_ATTESTATION.sha,currentTip="c".repeat(40),ancestors,deployment={},noApproval=false}={}){const storage=createInMemoryStorage();await storage.initialize({owner:{id:OWNER,fullName:"Owner"},projects:[{id:"nova-brain",name:"Nova"}]});await storage.createAutonomyTask({id:LIVE_PUSH_ATTESTATION.taskId,ownerId:OWNER,projectId:"nova-brain",title:"Acceptance",objective:"Attest push",branch:LIVE_PUSH_ATTESTATION.branch,startingCommit:LIVE_PUSH_ATTESTATION.sha,metadata:{steps:[]}});await storage.updateAutonomyTask(LIVE_PUSH_ATTESTATION.taskId,OWNER,{status:"waiting_for_worker",currentStep:6,currentCommit:LIVE_PUSH_ATTESTATION.sha,checkpoint:{completedSteps:completed},metadata:{steps:[],requiredCapability:"github_write"},approvalState:{approvalId:LIVE_PUSH_ATTESTATION.approvalId,approved:true}});if(!noApproval){await storage.createApproval({id:LIVE_PUSH_ATTESTATION.approvalId,ownerId:OWNER,projectId:"nova-brain",runId:LIVE_PUSH_ATTESTATION.taskId,tool,reason:"Exact push",riskLevel:"SENSITIVE",arguments:{branch:LIVE_PUSH_ATTESTATION.branch,commitSha:approvalSha}});if(approvalStatus!=="pending")await storage.decideApproval(LIVE_PUSH_ATTESTATION.approvalId,OWNER,approvalStatus);}let remoteChecks=0,deploymentChecks=0;const exactAncestors=ancestors||{[LIVE_PUSH_ATTESTATION.sha]:true,[REQUIRED_BLOCKER_SHA]:true};const service=createGithubWriteAttestation({storage,ownerId:OWNER,verifyRemote:async()=>{remoteChecks++;return{currentTip,ancestors:exactAncestors};},verifyDeployment:async()=>{deploymentChecks++;return{id:LIVE_PUSH_ATTESTATION.deploymentId,url:LIVE_PUSH_ATTESTATION.deploymentUrl,status:"READY",target:null,sha:LIVE_PUSH_ATTESTATION.sha,branch:LIVE_PUSH_ATTESTATION.branch,...deployment};}});return{storage,service,checks:()=>({remoteChecks,deploymentChecks})};}
const rejects=async(overrides,code,options)=>{const f=await fixture(options);await assert.rejects(()=>f.service.attest({...input(),...overrides}),error=>error.code===code);return f;};

test("exact authorized already-completed push attestation succeeds",async()=>{const f=await fixture(),before=await f.storage.getAutonomyTask(LIVE_PUSH_ATTESTATION.taskId,OWNER),result=await f.service.attest(input());assert.equal(result.idempotent,false);assert.equal(result.task.currentStep,8);assert.equal(result.task.stateVersion,before.stateVersion+1);});
test("wrong task ID is rejected",()=>rejects({taskId:"wrong"},"taskId_mismatch"));
test("wrong repository is rejected",()=>rejects({repository:"other/repo"},"repository_mismatch"));
test("wrong branch is rejected",()=>rejects({branch:"other"},"branch_mismatch"));
test("wrong SHA is rejected",()=>rejects({sha:"a".repeat(40)},"sha_mismatch"));
test("wrong approval ID is rejected",()=>rejects({approvalId:"wrong"},"approvalId_mismatch"));
test("approval for another action is rejected",()=>rejects({},"approval_action_mismatch",{tool:"preview_deploy"}));
test("missing approval is rejected",()=>rejects({},"approval_missing",{noApproval:true}));
test("pending approval is rejected",()=>rejects({},"approval_invalid",{approvalStatus:"pending"}));
test("rejected approval is rejected",()=>rejects({},"approval_invalid",{approvalStatus:"rejected"}));
test("acceptance SHA missing from exact ancestry is rejected",()=>rejects({},"acceptance_ancestry_mismatch",{ancestors:{[LIVE_PUSH_ATTESTATION.sha]:false,[REQUIRED_BLOCKER_SHA]:true}}));
test("blocker-fix SHA missing from exact ancestry is rejected",()=>rejects({},"blocker_ancestry_mismatch",{ancestors:{[LIVE_PUSH_ATTESTATION.sha]:true,[REQUIRED_BLOCKER_SHA]:false}}));
test("invalid or rewritten branch tip is rejected",()=>rejects({},"remote_tip_invalid",{currentTip:"diverged"}));
test("main target cannot pass the exact binding",()=>rejects({branch:"main"},"branch_mismatch"));
test("Production deployment is rejected",()=>rejects({},"production_target_forbidden",{deployment:{target:"production"}}));
test("duplicate attestation is idempotent without repeat verification",async()=>{const f=await fixture();await f.service.attest(input());const replay=await f.service.attest(input());assert.equal(replay.idempotent,true);assert.deepEqual(f.checks(),{remoteChecks:1,deploymentChecks:1});});
test("attestation records no GitHub write tool",async()=>{const f=await fixture();await f.service.attest(input());const steps=await f.storage.listAutonomySteps(LIVE_PUSH_ATTESTATION.taskId);assert.equal(steps.find(x=>x.stepId==="7:push").capability,"github_write_attestation");assert.equal(steps.some(x=>x.input?.tool==="git_push"),false);});
test("prior checkpoints remain unduplicated",async()=>{const f=await fixture(),r=await f.service.attest(input());assert.deepEqual(r.task.checkpoint.completedSteps,[...completed,"7:push","8:deploy_preview"]);});
test("Activity is secret-free",async()=>{const f=await fixture();await f.service.attest(input());const activity=await f.storage.listActivity(OWNER,{runId:LIVE_PUSH_ATTESTATION.taskId});assert.doesNotMatch(JSON.stringify(activity),/token|secret|authorization/i);});
test("exact existing Preview is attached READY",async()=>{const f=await fixture(),r=await f.service.attest(input());assert.equal(r.task.checkpoint.latestResult.deploymentId,LIVE_PUSH_ATTESTATION.deploymentId);assert.equal(r.task.checkpoint.latestResult.status,"READY");});
test("Preview SHA mismatch cannot mutate task",async()=>{const f=await fixture({deployment:{sha:"c".repeat(40)}}),before=await f.storage.getAutonomyTask(LIVE_PUSH_ATTESTATION.taskId,OWNER);await assert.rejects(()=>f.service.attest(input()),error=>error.code==="deployment_sha_mismatch");assert.equal((await f.storage.getAutonomyTask(before.id,OWNER)).stateVersion,before.stateVersion);});
test("Preview branch mismatch is rejected",()=>rejects({},"deployment_branch_mismatch",{deployment:{branch:"other"}}));
test("approval SHA mismatch is rejected",()=>rejects({},"approval_sha_mismatch",{approvalSha:"d".repeat(40)}));
test("current tip may advance while both exact ancestors remain verified",async()=>{const f=await fixture({currentTip:"e".repeat(40)});assert.equal((await f.service.attest(input())).idempotent,false);});
test("unsupported fields cannot inject arbitrary operations",()=>rejects({action:"force_push"},"invalid_attestation"));
test("task remains queued for independent final Preview verification",async()=>{const f=await fixture(),r=await f.service.attest(input());assert.equal(r.task.status,"queued");assert.notEqual(r.task.status,"completed");});
