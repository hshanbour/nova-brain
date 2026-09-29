import test from "node:test";
import assert from "node:assert/strict";
import {createPostgresStorage} from "../src/storage/postgres-storage.js";
import {SCHEMA_STATEMENTS} from "../src/storage/schema.js";

const OWNER="owner-browser-postgres",CONVERSATION="conversation-browser-postgres",TASK=`web_${"c".repeat(32)}`,STAMP="2026-09-29T12:00:00.000Z";

function postgresContractClient({omitRun=false,failTable=null}={}){
  const state={runs:new Map(),tasks:new Map(),steps:new Map(),activity:[]};
  const clone=()=>({runs:new Map(state.runs),tasks:new Map(state.tasks),steps:new Map(state.steps),activity:structuredClone(state.activity)});
  const client={
    state,
    query(){throw new Error("Unexpected non-transaction query.");},
    async transaction(builder){
      const descriptors=builder({query:(text,params=[])=>({text,params})}),draft=clone(),results=[];
      for(const descriptor of descriptors){
        const {text,params}=descriptor,table=/INSERT INTO\s+(nova_[a-z_]+)/i.exec(text)?.[1];
        if(failTable===table)throw Object.assign(new Error(`Synthetic ${table} failure.`),{code:"synthetic_transaction_failure"});
        if(table==="nova_execution_runs"){
          if(omitRun){results.push([]);continue;}
          const row={id:params[0],owner_id:params[1],project_id:params[2],conversation_id:params[3],goal:params[4],status:params[5],current_step:0,result:null,error:null,created_at:STAMP,updated_at:STAMP,completed_at:null};draft.runs.set(row.id,row);results.push([row]);continue;
        }
        if(table==="nova_autonomy_tasks"){
          const row={id:params[0],owner_id:params[1],project_id:params[2],title:params[3],objective:params[4],task_type:params[5],status:"queued",priority:params[6],current_phase:"queued",current_step:0,max_steps:params[7],max_retries:params[8],max_runtime_minutes:params[9],branch:params[10],starting_commit:params[11],current_commit:params[11],checkpoint:JSON.parse(params[12]),approval_state:null,blocked_reason:null,result_summary:null,error_code:null,next_run_at:params[13]||STAMP,metadata:JSON.parse(params[14]),lease_owner:null,lease_token:null,lease_expires_at:null,retry_count:0,repair_iteration:0,state_version:1,created_at:STAMP,started_at:null,updated_at:STAMP,completed_at:null};draft.tasks.set(row.id,row);results.push([row]);continue;
        }
        if(table==="nova_autonomy_steps"){
          if(!draft.tasks.has(params[0]))throw Object.assign(new Error("Autonomy step task FK failed."),{code:"23503",constraint:"nova_autonomy_steps_task_id_fkey"});
          const row={task_id:params[0],step_id:params[1],step_type:params[2],capability:params[3],operation_fingerprint:params[4],status:params[5],attempt:params[6],input:JSON.parse(params[7]),started_at:params[8]||STAMP,completed_at:params[9],result:params[10]===null?null:JSON.parse(params[10]),error_code:params[11],created_at:STAMP};draft.steps.set(`${row.task_id}:${row.step_id}`,row);results.push([row]);continue;
        }
        if(table==="nova_activity_events"){
          if(!draft.runs.has(params[3]))throw Object.assign(new Error("Activity run FK failed."),{code:"23503",constraint:"nova_activity_events_run_id_fkey"});
          const row={sequence:draft.activity.length+1,id:params[0],owner_id:params[1],project_id:params[2],run_id:params[3],action:params[4],tool:params[5],status:params[6],summary:params[7],metadata:JSON.parse(params[8]),created_at:STAMP};draft.activity.push(row);results.push([row]);continue;
        }
        throw new Error(`Unexpected transaction statement: ${text}`);
      }
      state.runs=draft.runs;state.tasks=draft.tasks;state.steps=draft.steps;state.activity=draft.activity;return results;
    },
  };
  return client;
}

const bundle=()=>({
  task:{id:TASK,ownerId:OWNER,projectId:null,title:"Public browser research",objective:"Read one bounded public interactive source.",taskType:"public_web_browser",maxSteps:1,maxRetries:1,maxRuntimeMinutes:5,metadata:{requiredCapability:"remote_public_browser",browserJob:{version:2},terminalReporting:{version:1,conversationId:CONVERSATION,runId:"originating-chat-run"}}},
  run:{id:TASK,ownerId:OWNER,projectId:null,conversationId:CONVERSATION,goal:"Read one bounded public interactive source.",status:"queued"},
  step:{taskId:TASK,stepId:"1:public_browser_read",stepType:"public_browser_read",capability:"remote_public_browser",operationFingerprint:"f".repeat(64),status:"queued",input:{reason:"interactive rendering",allowedDomains:["example.com"]}},
  activity:{id:"activity-browser-queued",ownerId:OWNER,projectId:null,runId:TASK,action:"browser_task_queued",tool:"public_browser_read",status:"queued",summary:"Queued bounded public browser research.",metadata:{taskId:TASK}},
});

const researchBundle=()=>({
  task:{id:`web_${"d".repeat(32)}`,ownerId:OWNER,projectId:null,title:"Public Web research",objective:"Complete multi-source public research.",taskType:"public_web_research",maxSteps:2,maxRetries:0,maxRuntimeMinutes:30,metadata:{requiredCapability:"remote_public_research",researchJob:{version:1},researchState:{version:1,phase:"research_queued"},terminalReporting:{version:1,conversationId:CONVERSATION,runId:"originating-chat-run"}}},
  run:{id:`web_${"d".repeat(32)}`,ownerId:OWNER,projectId:null,conversationId:CONVERSATION,goal:"Complete multi-source public research.",status:"queued"},
  step:{taskId:`web_${"d".repeat(32)}`,stepId:"1:public_web_research",stepType:"public_web_research",capability:"remote_public_research",operationFingerprint:"e".repeat(64),status:"queued",input:{depth:"deep"}},
  activity:{id:"activity-research-queued",ownerId:OWNER,projectId:null,runId:`web_${"d".repeat(32)}`,action:"web_research_task_queued",tool:"web_research",status:"queued",summary:"Queued durable public Web research before provider contact.",metadata:{}},
});

test("Postgres durable research preparation atomically owns task run step and FK-bound activity before dispatch",async()=>{const sqlClient=postgresContractClient(),storage=createPostgresStorage({sqlClient}),prepared=await storage.prepareAutonomyTaskBundle(researchBundle());assert.equal(prepared.task.taskType,"public_web_research");assert.equal(prepared.run.id,prepared.task.id);assert.equal(prepared.activity.runId,prepared.task.id);assert.equal(sqlClient.state.runs.size,1);assert.equal(sqlClient.state.tasks.size,1);assert.equal(sqlClient.state.steps.size,1);assert.equal(sqlClient.state.activity.length,1);});

test("Postgres durable research preparation failure leaves no dispatchable partial task",async()=>{const sqlClient=postgresContractClient({failTable:"nova_activity_events"}),storage=createPostgresStorage({sqlClient});await assert.rejects(()=>storage.prepareAutonomyTaskBundle(researchBundle()),error=>error.code==="synthetic_transaction_failure");assert.equal(sqlClient.state.runs.size,0);assert.equal(sqlClient.state.tasks.size,0);assert.equal(sqlClient.state.steps.size,0);assert.equal(sqlClient.state.activity.length,0);});

test("Postgres browser preparation commits the task-owned run before FK-bound activity",async()=>{
  const sqlClient=postgresContractClient(),storage=createPostgresStorage({sqlClient}),prepared=await storage.prepareAutonomyTaskBundle(bundle());
  assert.ok(SCHEMA_STATEMENTS.some(statement=>/CREATE TABLE IF NOT EXISTS nova_activity_events/.test(statement)&&/run_id text REFERENCES nova_execution_runs\(id\)/.test(statement)));assert.equal(prepared.task.id,TASK);assert.equal(prepared.run.id,TASK);assert.equal(prepared.run.conversationId,CONVERSATION);assert.equal(prepared.activity.runId,TASK);assert.equal(sqlClient.state.runs.has(TASK),true);assert.equal(sqlClient.state.tasks.has(TASK),true);assert.equal(sqlClient.state.steps.size,1);assert.equal(sqlClient.state.activity.length,1);assert.equal(prepared.task.metadata.terminalReporting.runId,"originating-chat-run");
});

test("Postgres FK rejection rolls back every browser preparation record",async()=>{
  const sqlClient=postgresContractClient({omitRun:true}),storage=createPostgresStorage({sqlClient});
  await assert.rejects(()=>storage.prepareAutonomyTaskBundle(bundle()),error=>error.code==="23503"&&error.constraint==="nova_activity_events_run_id_fkey");
  assert.equal(sqlClient.state.runs.size,0);assert.equal(sqlClient.state.tasks.size,0);assert.equal(sqlClient.state.steps.size,0);assert.equal(sqlClient.state.activity.length,0);
});

test("Postgres preparation step failure cannot leave a dispatchable browser task",async()=>{
  const sqlClient=postgresContractClient({failTable:"nova_autonomy_steps"}),storage=createPostgresStorage({sqlClient});
  await assert.rejects(()=>storage.prepareAutonomyTaskBundle(bundle()),error=>error.code==="synthetic_transaction_failure");
  assert.equal(sqlClient.state.runs.size,0);assert.equal(sqlClient.state.tasks.size,0);assert.equal(sqlClient.state.steps.size,0);assert.equal(sqlClient.state.activity.length,0);
});
