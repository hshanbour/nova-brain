import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersistentLocalWorker} from '../src/autonomy/persistent-local-worker.js';

function fixture({execute=async()=>({ok:true}),complete=async()=>({status:'completed'}),fail=async()=>({}),heartbeat=async()=>({})}={}){
 const task={id:'coding_'+'a'.repeat(32),branch:'feature',expectedCommit:'b'.repeat(40),stateVersion:1,mode:'local_handoff',stepType:'delegate_coding'};
 const job={taskId:task.id,branch:task.branch,expectedCommit:task.expectedCommit,tool:'codex_execute',arguments:{},handoffId:'fixture',executionAttempt:{id:'attempt',generation:1,fenceToken:'test-only'}};
 const events=[];
 const client={async request(path,body){if(path.endsWith('/next'))return{dispatched:true,task};if(path.endsWith('/claim'))return{claimed:true,handoff:job};if(path.endsWith('/heartbeat'))return heartbeat(body);if(path.endsWith('/complete'))return complete();if(path.endsWith('/fail'))return fail();throw Error('Unexpected route');}};
 return{worker:createPersistentLocalWorker({client,branch:'feature',registry:{execute},onHeartbeat:async e=>events.push(e)}),events};
}
test('execution lease remains renewed while result acknowledgement is pending',async t=>{
 t.mock.timers.enable({apis:['setInterval']});let entered,release;const pending=new Promise(r=>entered=r),ack=new Promise(r=>release=r);let beats=0;
 const {worker,events}=fixture({heartbeat:async()=>{beats++;},complete:async()=>{entered();await ack;return{status:'completed'};}});
 const running=worker.runOnce();await pending;t.mock.timers.tick(15000);await Promise.resolve();await Promise.resolve();
 assert.equal(beats,2);release();assert.equal((await running).status,'completed');t.mock.timers.tick(15000);assert.equal(beats,2);
 assert.equal(events.length,1);
});
test('failed reporting never replaces the original execution failure',async()=>{
 const {worker}=fixture({execute:async()=>{throw Object.assign(Error('bounded failure'),{code:'coding_result_uncommitted'});},fail:async()=>{throw Object.assign(Error('expired'),{code:'execution_attempt_stale'});}});
 await assert.rejects(worker.runOnce(),e=>e.code==='coding_result_uncommitted'&&e.reportFailureCode==='execution_attempt_stale');
});
