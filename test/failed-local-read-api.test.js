import test from "node:test";
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {Readable} from "node:stream";
import {createApi} from "../src/http/api.js";
import {runPersistentWorkerService} from "../src/autonomy/persistent-worker-startup.js";

test("failed-local-read recovery requires worker auth and a verified signed proof before calling the service",async()=>{
  const calls=[],token="fixture-local-token",proof={expectedVersion:174,runtimeVersion:"a".repeat(40),taskId:"fixture",workspace:{root:"C:/fixture"}};
  const signature=createHmac("sha256",token).update(JSON.stringify(proof)).digest("hex");
  const app=createApi({agent:{tools:{list:()=>[]}},config:{allowedOrigins:[],maxBodyBytes:64000,localWorkerToken:token},storage:{provider:"memory",durable:false},initialize:async()=>{},ownerId:"owner",selfDevelopment:{async recoverFailedTaskOwnedLocalRead(id,input,actor){calls.push({id,input,actor});return{task:{id,stateVersion:175}};}},logger:{info(){},error(){}}});
  async function post(authorization,workspaceProofSignature=signature){
    const input={expectedVersion:174,runtimeVersion:proof.runtimeVersion,workspaceProof:proof,workspaceProofSignature};
    const request=Readable.from([JSON.stringify(input)]);Object.assign(request,{method:"POST",url:"/api/admin/self-development/tasks/fixture/recover-failed-local-read",headers:{"content-type":"application/json",...(authorization?{authorization}:{})}});
    const response={setHeader(){},end(value){this.body=value;}};await app.handle(request,response);return response;
  }
  assert.equal((await post()).statusCode,401);
  assert.equal((await post("Bearer wrong")).statusCode,401);
  assert.equal((await post(`Bearer ${token}`,"0".repeat(64))).statusCode,403);
  assert.equal(calls.length,0);
  assert.equal((await post(`Bearer ${token}`)).statusCode,200);
  assert.equal(calls.length,1);assert.equal(calls[0].id,"fixture");
  assert.deepEqual(calls[0].actor,{actorType:"scoped_local_worker",workspaceProof:proof});
});

test("verified installation runtime identity reaches the worker factory without using product HEAD",async()=>{
  let received;
  const runtimeVersion="a".repeat(40),productHead="b".repeat(40);
  await runPersistentWorkerService({baseUrl:"https://fixture.invalid",repositoryRoot:"C:/fixture",version:"local",startupMetadata:{runtimeVersion,repositoryProof:{head:productHead}},probeOnly:true,maxIterations:0,credentialLoader:async()=>({novaToken:"synthetic",clear(){}}),clientFactory:()=>({request:async()=>({dispatched:false})}),workerFactory:value=>{received=value;return{workerId:"synthetic-unused"};},acquireInstance:async()=>({acquired:true,release:async()=>{}}),statusWriter:async()=>{}});
  assert.equal(received.runtimeVersion,runtimeVersion);assert.notEqual(received.runtimeVersion,productHead);
});
