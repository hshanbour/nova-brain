import test from 'node:test';
import assert from 'node:assert/strict';
import {CONNECTED_EXECUTION,connectedTaskAllowed} from '../src/identity/connected-execution.js';
import {continuityRouteAllowed,continuityToolAllowed} from '../src/identity/continuity-preview.js';
import {createAutoDispatchService} from '../src/autonomy/auto-dispatch.js';
import {createLocalWorkerHandoff} from '../src/autonomy/local-worker-handoff.js';
import {createInMemoryStorage} from '../src/storage/in-memory-storage.js';
const ownerId='test-owner',branch='codex/combined-nova-preview-d5b5-c5bd';
function setup(){
 const parent={id:'parent',ownerId,taskType:'coding_orchestration',projectId:'nova-brain',metadata:{connectedExecution:CONNECTED_EXECUTION,codingDelegation:{codingJobHash:'hash'}}};
 const approval={status:'approved',tool:'coding_job_create',projectId:'nova-brain',arguments:{parentTaskId:'parent',specificationHash:'hash'}};
 const task={id:'fresh',ownerId,taskType:'coding_delegation',projectId:'nova-brain',branch,status:'queued',currentCommit:'a'.repeat(40),currentStep:0,metadata:{connectedExecution:CONNECTED_EXECUTION,codingSpecificationHash:'hash',codingJob:{parentTaskId:'parent',repository:{slug:'hshanbour/nova-brain'},delivery:{boundary:'local_commit',allowPush:false,allowDeploy:false},approval:{buildApproved:true,approvalId:'approval'}},steps:[{type:'delegate_coding'}]}};
 const storage={getAutonomyTask:async id=>id==='parent'?parent:id==='fresh'?task:null,getApproval:async()=>approval};
 return {parent,approval,task,storage};
}
test('only fresh server-stamped local coding jobs with exact approved handle are released',async()=>{
 const {task,parent,approval,storage}=setup();
 assert.equal(await connectedTaskAllowed(storage,ownerId,task),true);
 for(const value of [null,{...task,ownerId:'other'},{...task,taskType:'self_development'},{...task,metadata:{...task.metadata,connectedExecution:null}}])assert.equal(await connectedTaskAllowed(storage,ownerId,value),false);
 approval.status='pending';assert.equal(await connectedTaskAllowed(storage,ownerId,task),false);approval.status='approved';
 approval.arguments.specificationHash='different';assert.equal(await connectedTaskAllowed(storage,ownerId,task),false);approval.arguments.specificationHash='hash';
 parent.metadata.connectedExecution=null;assert.equal(await connectedTaskAllowed(storage,ownerId,task),false);
});
test('dispatch skips historical queue and global recovery while retaining approved task',async()=>{
 const {task,storage}=setup();const legacy={...task,id:'legacy',metadata:{...task.metadata,connectedExecution:null}};
 storage.listAutonomyTasks=async()=>[legacy,task];
 const allowed=t=>connectedTaskAllowed(storage,ownerId,t);
 const service=createAutoDispatchService({storage,ownerId,approvedBranch:branch,taskAllowed:allowed,executionTruth:{reconcile({taskAllowed}){assert.equal(taskAllowed,allowed);}}});
 assert.equal((await service.next({workerId:'test-worker',branch})).task.id,'fresh');
 storage.listAutonomyTasks=async()=>[legacy];assert.equal((await service.next({workerId:'test-worker',branch})).dispatched,false);
});
test('direct handoff cannot bypass held task filter',async()=>{
 const {task,storage}=setup();task.metadata.connectedExecution=null;
 const service=createLocalWorkerHandoff({storage,ownerId,approvedBranch:branch,taskAllowed:t=>connectedTaskAllowed(storage,ownerId,t)});
 await assert.rejects(service.claim({taskId:'fresh',workerId:'worker',idempotencyKey:'one',expectedBranch:branch,expectedCommit:task.currentCommit,capabilities:['codex_local']}),{code:'connected_preview_task_held'});
});

test('a fresh permitted task cannot be starved by 100 historical records',async()=>{
 const storage=createInMemoryStorage();await storage.initialize({owner:{id:ownerId,fullName:'Fixture'},projects:[{id:'nova-brain',name:'Nova'}]});
 for(let n=0;n<101;n++)await storage.createAutonomyTask({id:`old-${n}`,ownerId,projectId:'nova-brain',title:'Held',objective:'Held fixture',taskType:'self_development',branch,startingCommit:'a'.repeat(40),metadata:{steps:[{type:'delegate_coding'}]}});
 await storage.createAutonomyTask({id:'new',ownerId,projectId:'nova-brain',title:'New',objective:'Approved fixture',taskType:'coding_delegation',branch,startingCommit:'a'.repeat(40),metadata:{connectedExecution:CONNECTED_EXECUTION,codingJob:{repository:{slug:'hshanbour/nova-brain'}},steps:[{type:'delegate_coding'}]}});
 const service=createAutoDispatchService({storage,ownerId,approvedBranch:branch,executionScope:CONNECTED_EXECUTION,taskAllowed:async t=>t.id==='new'});
 assert.equal((await service.next({workerId:'fixture'})).task.id,'new');
 assert.equal((await storage.getAutonomyTask('old-0',ownerId)).status,'queued');
});
test('only connected Preview exposes bounded coding controls; sending stays unavailable',()=>{
 assert.equal(continuityToolAllowed({name:'coding_job_prepare',riskLevel:'LOW_RISK_WRITE'},{connected:true}),true);
 assert.equal(continuityToolAllowed({name:'coding_job_prepare',riskLevel:'LOW_RISK_WRITE'}),false);
 for(const name of ['sender_campaign_send','whatsapp_send','git_push'])assert.equal(continuityToolAllowed({name,riskLevel:'HIGH_IMPACT'},{connected:true}),false);
 assert.equal(continuityRouteAllowed('/api/admin/worker/handoff/claim','POST',{connected:true}),true);
 assert.equal(continuityRouteAllowed('/api/admin/worker/github-write-attestation','POST',{connected:true}),false);
 assert.equal(continuityRouteAllowed('/api/admin/scheduler/social/tick','POST',{connected:true}),false);
});
