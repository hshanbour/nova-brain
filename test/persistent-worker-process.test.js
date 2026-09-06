import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {acquirePersistentWorkerInstance,writePersistentWorkerStatus} from "../src/autonomy/persistent-worker-process.js";
import {runPersistentWorkerLoop} from "../src/autonomy/persistent-local-worker.js";

test("persistent loop survives idle queues and transient failures",async()=>{let calls=0;const states=[],delays=[];const result=await runPersistentWorkerLoop({worker:{async runOnce(){calls++;if(calls===1)throw Object.assign(new Error("temporary"),{code:"network_error"});return{worked:false};}},maxIterations:3,delay:async ms=>delays.push(ms),onState:value=>states.push(value)});assert.equal(result.iterations,3);assert.deepEqual(states.map(x=>x.state),["retrying","idle","idle"]);assert.equal(delays.length,2);});
test("single-instance lock rejects a live duplicate and reclaims stale ownership",async t=>{const dir=await mkdtemp(join(tmpdir(),"nova-worker-"));t.after(()=>rm(dir,{recursive:true,force:true}));const paths={dir,lock:join(dir,"worker.lock"),status:join(dir,"status.json")},first=await acquirePersistentWorkerInstance({paths,pid:111,isAlive:value=>value===111}),duplicate=await acquirePersistentWorkerInstance({paths,pid:222,isAlive:value=>value===111});assert.equal(first.acquired,true);assert.equal(duplicate.acquired,false);await first.release();const stale=await acquirePersistentWorkerInstance({paths,pid:333,isAlive:()=>false});assert.equal(stale.acquired,true);await stale.release();});
test("persistent status is bounded and cannot contain credential material",async t=>{const dir=await mkdtemp(join(tmpdir(),"nova-worker-status-"));t.after(()=>rm(dir,{recursive:true,force:true}));const paths={dir,lock:join(dir,"worker.lock"),status:join(dir,"status.json")};await writePersistentWorkerStatus({state:"retrying",code:"network_error",token:"never",password:"never"},{paths});const value=await readFile(paths.status,"utf8");assert.doesNotMatch(value,/never|token|password/i);assert.equal(JSON.parse(value).state,"retrying");});
