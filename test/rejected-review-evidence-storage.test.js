import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createInMemoryStorage} from "../src/storage/in-memory-storage.js";
import {SCHEMA_STATEMENTS,SCHEMA_VERSION} from "../src/storage/schema.js";
import {buildRejectedReviewEvidence,validateRejectedReviewEvidenceEnvelope,REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT} from "../src/autonomy/rejected-review-evidence.js";

const OWNER="private-evidence-owner",OTHER="different-private-owner",TASK="private-evidence-task";
const PATHS=["assets/a.js","assets/b.js","assets/c.css","index.html","test/a.test.js","test/b.test.js","test/c.test.js","test/d.test.js"];
const GENERATION="a".repeat(64),FINGERPRINT="b".repeat(64),PRIVATE_MARKER="PRIVATE_BOUNDED_TEST_ARTIFACT";
function envelope({taskId=TASK,stateVersion=306,generation=GENERATION,executionId="187:plan_repair",testName=PRIVATE_MARKER}={}){
  const review={findings:Array.from({length:4},(_,index)=>({id:`finding-${index}`,severity:"blocking",paths:[PATHS[index]]})),acceptanceConstraints:Array.from({length:5},(_,index)=>({id:`constraint-${index}`,findingIds:[`finding-${index%4}`]}))};
  const coverage=review.acceptanceConstraints.map(item=>({constraintId:item.id,findingIds:item.findingIds,testPath:PATHS[4],testName,sourceExcerpt:`test('${testName}', () => { const result = invoke(); assert.equal(result, true); });`,stimulus:"const result = invoke();",observable:"result",assertion:"assert.equal(result, true);"}));
  const value=buildRejectedReviewEvidence({task:{id:taskId,stateVersion,metadata:{activeContinuation:{generationId:generation}}},executionId,attempt:1,plan:{files:[{path:PATHS[0],operation:"replace",content:"export const fixture = true;"}],focusedTests:[{path:PATHS[4],kind:"existing"}],reviewCoverage:coverage},review,requiredPaths:PATHS,reads:new Map([[PATHS[4],coverage[0].sourceExcerpt]]),planFingerprint:FINGERPRINT,diagnostics:{predicate:"source_bound_behavioral_coverage"}});
  assert.equal(validateRejectedReviewEvidenceEnvelope(value),true);return value;
}
async function memory(){
  const storage=createInMemoryStorage();
  for(const[id,ownerId]of[[TASK,OWNER],["another-owned-task",OWNER],["other-owner-task",OTHER]])await storage.createAutonomyTask({id,ownerId,projectId:"fixture-project",taskType:"self_development",title:"Private diagnostic",objective:"Synthetic storage isolation",branch:"feat/synthetic",startingCommit:"c".repeat(40)});
  return storage;
}

test("private rejection evidence is owner/task scoped in the real memory adapter",async()=>{
  const storage=await memory(),record=await storage.createRejectedReviewEvidence({ownerId:OWNER,taskId:TASK,envelope:envelope()});
  assert.match(record.id,/^[a-f0-9-]{36}$/);assert.equal(record.ownerId,OWNER);assert.equal(record.taskId,TASK);assert.equal(record.envelope.coverage[0].testName,PRIVATE_MARKER);assert.equal(record.envelope.executionAuthorized,false);assert.equal(record.envelope.mutationApplied,false);
  assert.deepEqual(await storage.getRejectedReviewEvidence(record.id,OWNER,TASK),record);
  for(const[ownerId,taskId]of[[OTHER,TASK],[OWNER,"another-owned-task"],[OTHER,"other-owner-task"],[OWNER,"missing-task"]])assert.equal(await storage.getRejectedReviewEvidence(record.id,ownerId,taskId),null);
  assert.equal(await storage.getRejectedReviewEvidence("missing-id",OWNER,TASK),null);
});

test("exact rejected execution identity is idempotent and never overwrites its first private evidence",async()=>{
  const storage=await memory(),first=await storage.createRejectedReviewEvidence({ownerId:OWNER,taskId:TASK,envelope:envelope()});
  const repeated=await storage.createRejectedReviewEvidence({ownerId:OWNER,taskId:TASK,envelope:envelope({testName:"different bounded candidate"})});
  assert.deepEqual(repeated,first);assert.equal((await storage.getRejectedReviewEvidence(first.id,OWNER,TASK)).envelope.coverage[0].testName,PRIVATE_MARKER);
  const next=await storage.createRejectedReviewEvidence({ownerId:OWNER,taskId:TASK,envelope:envelope({generation:"d".repeat(64)})});assert.notEqual(next.id,first.id);
});

test("forged, rebound or mutated envelopes cannot enter memory storage",async()=>{
  const storage=await memory();
  const unbranded=JSON.parse(JSON.stringify(envelope())),mutated=envelope();mutated.executionAuthorized=true;
  for(const input of[
    {ownerId:OWNER,taskId:TASK,envelope:unbranded},
    {ownerId:OWNER,taskId:TASK,envelope:mutated},
    {ownerId:OTHER,taskId:TASK,envelope:envelope()},
    {ownerId:OWNER,taskId:"another-owned-task",envelope:envelope()},
    {ownerId:OWNER,taskId:"missing-task",envelope:envelope({taskId:"missing-task"})},
  ])await assert.rejects(()=>storage.createRejectedReviewEvidence(input),/Invalid private rejection evidence binding/);
});

test("private records do not leak through generic tasks, steps, activity or mutation of returned copies",async()=>{
  const storage=await memory(),before=await storage.getAutonomyTask(TASK,OWNER),record=await storage.createRejectedReviewEvidence({ownerId:OWNER,taskId:TASK,envelope:envelope()});
  const exposed={task:await storage.getAutonomyTask(TASK,OWNER),tasks:await storage.listAutonomyTasks(OWNER),steps:await storage.listAutonomySteps(TASK),activity:await storage.listActivity(OWNER)};
  assert.equal(JSON.stringify(exposed).includes(PRIVATE_MARKER),false);assert.equal(JSON.stringify(exposed).includes(record.id),false);assert.deepEqual(exposed.task,before);
  record.envelope.coverage[0].testName="changed outside storage";
  const reread=await storage.getRejectedReviewEvidence(record.id,OWNER,TASK);assert.equal(reread.envelope.coverage[0].testName,PRIVATE_MARKER);
  assert.equal(validateRejectedReviewEvidenceEnvelope(reread.envelope),false,"deserialized evidence is data, not a writable branded artifact");
});

// Exercise the exact production method bodies with an injected query sink.
// No Postgres driver, live connection, source rewrite or network is involved.
async function postgresMethods(run){
  const source=await readFile(new URL("../src/storage/postgres-storage.js",import.meta.url),"utf8"),start=source.indexOf("    async createRejectedReviewEvidence("),end=source.indexOf("    async listAutonomyTasks(",start);
  assert.ok(start>0&&end>start);const methods=source.slice(start,end);
  return Function("run","randomUUID","json","date","validateRejectedReviewEvidenceEnvelope",`"use strict";return {${methods}};`)(run,()=>"11111111-1111-4111-8111-111111111111",JSON.stringify,value=>value instanceof Date?value.toISOString():value,validateRejectedReviewEvidenceEnvelope);
}
function row(value=envelope()){
  return{id:"11111111-1111-4111-8111-111111111111",owner_id:OWNER,task_id:TASK,execution_id:value.executionId,attempt:1,continuation_generation_id:value.continuationGenerationId,envelope:JSON.parse(JSON.stringify(value)),created_at:new Date("2026-09-15T00:00:00.000Z")};
}

test("Postgres insert uses a separate private table and atomically binds owner/task existence",async()=>{
  const calls=[],value=envelope(),stored=row(value),storage=await postgresMethods(async(statement,params)=>{calls.push({statement,params});return[stored];});
  const record=await storage.createRejectedReviewEvidence({ownerId:OWNER,taskId:TASK,envelope:value});assert.equal(calls.length,1);
  assert.match(calls[0].statement,/INSERT INTO nova_rejected_review_evidence/);assert.match(calls[0].statement,/WHERE EXISTS \(SELECT 1 FROM nova_autonomy_tasks WHERE id=\$3 AND owner_id=\$2\)/);
  assert.match(calls[0].statement,/ON CONFLICT \(owner_id,task_id,execution_id,attempt,continuation_generation_id\) DO NOTHING RETURNING \*/);assert.doesNotMatch(calls[0].statement,/DO UPDATE|nova_activity_events|UPDATE nova_autonomy_tasks/);
  assert.deepEqual(calls[0].params.slice(1,6),[OWNER,TASK,"187:plan_repair",1,GENERATION]);assert.deepEqual(JSON.parse(calls[0].params[6]),JSON.parse(JSON.stringify(value)));assert.equal(record.createdAt,"2026-09-15T00:00:00.000Z");assert.equal(record.envelope.executionAuthorized,false);
});

test("Postgres duplicate creation selects only the same owner/task/execution/generation and never overwrites",async()=>{
  const first=row(),calls=[],storage=await postgresMethods(async(statement,params)=>{calls.push({statement,params});return calls.length===1?[]:[first];});
  const value=envelope({testName:"second model artifact must not replace first"}),record=await storage.createRejectedReviewEvidence({ownerId:OWNER,taskId:TASK,envelope:value});assert.equal(calls.length,2);
  assert.match(calls[1].statement,/JOIN nova_autonomy_tasks t ON t.id=e.task_id AND t.owner_id=e.owner_id/);assert.match(calls[1].statement,/WHERE e.owner_id=\$1 AND e.task_id=\$2 AND e.execution_id=\$3 AND e.attempt=\$4 AND e.continuation_generation_id=\$5/);
  assert.deepEqual(calls[1].params,[OWNER,TASK,"187:plan_repair",1,GENERATION]);assert.equal(record.envelope.coverage[0].testName,PRIVATE_MARKER);
});

test("Postgres rejects missing owner/task rows and unbranded or mismatched evidence",async()=>{
  const calls=[],storage=await postgresMethods(async(statement,params)=>{calls.push({statement,params});return[];});
  await assert.rejects(()=>storage.createRejectedReviewEvidence({ownerId:OTHER,taskId:TASK,envelope:envelope()}),/owner\/task/);assert.equal(calls.length,2);assert.equal(calls[0].params[1],OTHER);assert.equal(calls[1].params[0],OTHER);
  calls.length=0;
  for(const value of[JSON.parse(JSON.stringify(envelope())),envelope({taskId:"another-owned-task"})])await assert.rejects(()=>storage.createRejectedReviewEvidence({ownerId:OWNER,taskId:TASK,envelope:value}),/Invalid private rejection evidence binding/);
  assert.equal(calls.length,0);
});

test("Postgres diagnostic lookup requires exact id, owner and task with ownership join",async()=>{
  const calls=[],stored=row(),storage=await postgresMethods(async(statement,params)=>{calls.push({statement,params});return params[0]===stored.id&&params[1]===OWNER&&params[2]===TASK?[stored]:[];});
  assert.equal((await storage.getRejectedReviewEvidence(stored.id,OWNER,TASK)).envelope.coverage[0].testName,PRIVATE_MARKER);
  for(const[id,owner,task]of[[stored.id,OTHER,TASK],[stored.id,OWNER,"another-owned-task"],["missing",OWNER,TASK]])assert.equal(await storage.getRejectedReviewEvidence(id,owner,task),null);
  for(const call of calls){assert.match(call.statement,/JOIN nova_autonomy_tasks t ON t.id=e.task_id AND t.owner_id=e.owner_id/);assert.match(call.statement,/WHERE e.id=\$1 AND e.owner_id=\$2 AND e.task_id=\$3/);assert.equal(call.params.length,3);}
});

test("schema eight stores private bounded JSON separately with ownership, cascade and unique execution constraints",()=>{
  assert.equal(SCHEMA_VERSION,8);const statements=SCHEMA_STATEMENTS.filter(statement=>statement.includes("CREATE TABLE IF NOT EXISTS nova_rejected_review_evidence"));assert.equal(statements.length,1);const table=statements[0];
  assert.match(table,/owner_id text NOT NULL REFERENCES nova_owners\(id\) ON DELETE CASCADE/);assert.match(table,/task_id text NOT NULL REFERENCES nova_autonomy_tasks\(id\) ON DELETE CASCADE/);assert.match(table,/attempt integer NOT NULL CHECK \(attempt > 0\)/);
  assert.match(table,new RegExp(`octet_length\\(envelope::text\\) <= ${REJECTED_REVIEW_EVIDENCE_BYTE_LIMIT}`));assert.match(table,/UNIQUE\(owner_id,task_id,execution_id,attempt,continuation_generation_id\)/);assert.ok(SCHEMA_STATEMENTS.some(statement=>/INSERT INTO nova_schema_migrations/.test(statement)&&/\(8\)/.test(statement)));
  assert.doesNotMatch(table,/nova_activity_events|ALTER TABLE nova_autonomy_tasks/);
});
