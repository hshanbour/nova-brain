import test from 'node:test';
import assert from 'node:assert/strict';
import {createFreshaExecutorJobs,sanitizeFreshaConnection} from '../src/booking/fresha-executor-jobs.js';
import {createFreshaConnectionWorker} from '../src/booking/fresha-connection-worker.js';
import {createApi} from '../src/http/api.js';
import {Readable} from 'node:stream';
function fixture(){const rows=new Map(),ownerId='test-owner';let now=Date.now();const storage={
  async listProjects(){return[{id:'sharp-cuts-web'}];},async listAutonomyTasks(id){return [...rows.values()].filter(x=>x.ownerId===id);},
  async createAutonomyTask(x){const row={...x,status:'queued',stateVersion:1};rows.set(x.id,row);return row;},
  async getAutonomyTask(id,owner){const r=rows.get(id);return r?.ownerId===owner?r:null;},
  async updateAutonomyTask(id,owner,patch,version){const row=rows.get(id);if(!row||row.ownerId!==owner||row.stateVersion!==version)return null;const updated={...row,...patch,stateVersion:version+1};rows.set(id,updated);return updated;}
};return{rows,storage,service:createFreshaExecutorJobs({storage,ownerId,clock:()=>now}),advance(){now+=301000;}};}
test('connection jobs cannot claim the historical queue, other owners or projects',async()=>{
  const f=fixture();for(const [id,ownerId,projectId,metadata]of[['whatsapp','test-owner','sharp-cuts-web',{}],['other','someone-else','sharp-cuts-web',{connectedExecution:'fresha_connection_v1',freshaOperation:'inspect_connection'}]])f.rows.set(id,{id,ownerId,projectId,metadata,status:'queued',stateVersion:1});
  const task=await f.service.request(),job=await f.service.next({workerId:'fresha-test-worker'});assert.equal(job.taskId,task.id);assert.equal(f.rows.get('whatsapp').status,'queued');assert.equal(f.rows.get('other').status,'queued');
});
test('one claim wins and completion must match the worker, lease and version',async()=>{
  const f=fixture();await f.service.request();const jobs=await Promise.all([f.service.next({workerId:'fresha-worker-a'}),f.service.next({workerId:'fresha-worker-b'})]);assert.equal(jobs.filter(j=>j.worked).length,1);
  const j=jobs[0];await assert.rejects(()=>f.service.complete({...j,workerId:'fresha-worker-b',result:{}}));
  const receipt=await f.service.complete({...j,workerId:'fresha-worker-a',result:{state:'business_visible',cookies:'SECRET',writesEnabled:true}});assert.equal(receipt.status,'completed');assert.equal(receipt.result.writesEnabled,false);assert.ok(!JSON.stringify(receipt).includes('SECRET'));
});
test('expired checks stop instead of being silently rerun; stale receipts cannot overwrite',async()=>{
  const f=fixture();await f.service.request();const j=await f.service.next({workerId:'fresha-worker-a'});f.advance();assert.equal((await f.service.next({workerId:'fresha-worker-a'})).worked,false);assert.equal(f.rows.get(j.taskId).status,'blocked');await assert.rejects(()=>f.service.complete({...j,workerId:'fresha-worker-a',result:{}}));
});
test('worker refuses an unexpected write operation',async()=>{
  let read=false;const worker=createFreshaConnectionWorker({workerId:'fresha-worker-a',client:{async request(){return{worked:true,taskId:'fresha_test',operation:'create_booking'};}},session:{async inspect(){read=true;}}});await assert.rejects(()=>worker.runOnce(),{code:'fresha_operation_forbidden'});assert.equal(read,false);
});
test('availability uses the isolated queue and returns a bounded read receipt',async()=>{
  const f=fixture();const task=await f.service.request({operation:'inspect_availability'});
  const worker=createFreshaConnectionWorker({workerId:'fresha-worker-a',client:{request(path,input){return path.endsWith('/next')?f.service.next(input):f.service.complete(input);}},session:{async inspectAvailableTimes(){return{state:'availability_read',locationId:'139805',date:'2026-11-21',teamMember:'Hamood',service:'Haircut (no beard trim )',times:['11:00 am','secret'],cookies:'SECRET',writesEnabled:true,observedAt:new Date().toISOString()};}}});
  const receipt=await worker.runOnce();assert.equal(receipt.id,task.id);assert.deepEqual(receipt.result.times,['11:00 am']);assert.equal(receipt.result.writesEnabled,false);assert.ok(!JSON.stringify(receipt).includes('SECRET'));await assert.rejects(()=>f.service.request({operation:'create_booking'}),{code:'fresha_operation_forbidden'});
});
test('connection reports cannot smuggle credentials or claim live write readiness',()=>{
  assert.deepEqual(Object.keys(sanitizeFreshaConnection({cookies:'secret',accessToken:'secret',writesEnabled:true})),['state','calendarVisible','businessVisible','writesEnabled','localOnly','observedAt']);
});
test('HTTP connection checks require the owner workspace or authenticated worker, never an arbitrary account',async()=>{
  let actor='test-owner',calls=0;
  const api=createApi({ownerId:'test-owner',connectedPreview:true,continuityPreview:true,initialize:async()=>{},storage:{},config:{localWorkerToken:'synthetic-worker-token-for-boundary-test',allowedOrigins:[],maxBodyBytes:4096},authorizeConsole:async()=>({role:'owner',ownerId:actor,workspaceId:actor}),freshaExecutorJobs:{async request(){calls++;return{};},async status(){calls++;return{};},async next(){calls++;return{worked:false};}}});
  async function call(path,method,headers={}){const req=Readable.from(method==='POST'?['{}']:[]);Object.assign(req,{url:path,method,headers});const res={statusCode:200,setHeader(){},end(body){this.body=body;}};await api.handle(req,res);return res.statusCode;}
  const path='/api/business-automation/sharp-cuts/fresha-connection';
  actor='other';assert.equal(await call(path,'GET'),403);assert.equal(calls,0);
  actor='test-owner';assert.equal(await call(path,'POST',{host:'nova.test',origin:'https://evil.test'}),403);assert.equal(calls,0);
  assert.equal(await call(path,'POST',{host:'nova.test',origin:'https://nova.test','content-type':'application/json'}),200);
  assert.equal(await call('/api/admin/worker/fresha/next','POST'),401);
  assert.equal(await call('/api/admin/worker/fresha/next','POST',{authorization:'Bearer synthetic-worker-token-for-boundary-test','content-type':'application/json'}),200);
  assert.equal(await call('/api/admin/worker/fresha/create','POST',{authorization:'Bearer synthetic-worker-token-for-boundary-test'}),403);
});
test('controlled lifecycle is a single durable test and cannot skip preparation or change appointment IDs',async()=>{
 const f=fixture();await assert.rejects(()=>f.service.request({operation:'test_create'}),{code:'test_prepare_required'});
 const t=await f.service.request({operation:'test_prepare'});assert.equal(t.id,'fresha_controlled_20261121');
 async function finish(result){const j=await f.service.next({workerId:'fresha-worker-a'});return f.service.complete({...j,workerId:'fresha-worker-a',result:{...result,observedAt:new Date().toISOString()}});}
 await finish({state:'prepared',walkIn:true});await f.service.request({operation:'test_create'});await finish({state:'created',appointmentId:'12345678'});
 await assert.rejects(()=>f.service.request({operation:'test_create'}));await assert.rejects(()=>f.service.request({operation:'test_prepare'}));await assert.rejects(()=>f.service.request({operation:'test_cancel'}));
 await f.service.request({operation:'test_read'});const j=await f.service.next({workerId:'fresha-worker-a'});await assert.rejects(()=>f.service.complete({...j,workerId:'fresha-worker-a',result:{state:'read_back',appointmentId:'87654321'}}),{code:'test_appointment_id_mismatch'});
 await f.service.complete({...j,workerId:'fresha-worker-a',result:{state:'read_back',appointmentId:'12345678'}});
 await f.service.request({operation:'test_reschedule'});await finish({state:'rescheduled',appointmentId:'12345678'});await f.service.request({operation:'test_cancel'});await finish({state:'cancelled',appointmentId:'12345678'});
 await assert.rejects(()=>f.service.request({operation:'test_create'}));assert.equal(f.rows.size,1);
});
