import {randomUUID} from "node:crypto";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
import {createLocalWorkerClient} from "../src/autonomy/local-worker-client.js";

const base=(process.env.NOVA_LOCAL_WORKER_URL||"").replace(/\/$/,"");
const token=process.env.NOVA_LOCAL_WORKER_TOKEN;
const vercelBypassToken=process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const taskId=process.env.NOVA_LOCAL_WORKER_TASK_ID;
const branch=process.env.NOVA_BRAIN_DEVELOPMENT_BRANCH||"feat/nova-brain-mvp-foundation";
let expectedCommit=process.env.NOVA_LOCAL_WORKER_EXPECTED_COMMIT;
if(!taskId||!/^[a-f0-9]{40}$/.test(expectedCommit||""))throw new Error("Bounded local Worker handoff configuration is required.");
const workerId=`local-${randomUUID()}`,allowed=new Set(["repo_apply_patch","test_run","test_run_full","repo_diff","git_commit"]);
const registry=createToolRegistry();registerHandsTools(registry,{root:process.cwd(),environment:{...process.env,VERCEL:"",NOVA_BRAIN_DEVELOPMENT_BRANCH:branch}});
const {request}=createLocalWorkerClient({baseUrl:base,novaToken:token,vercelBypassToken});
for(let count=0;count<12;count+=1){
  const idempotencyKey=`${taskId}:${workerId}:${count}`;
  const claimed=await request("/api/admin/worker/handoff/claim",{workerId,capabilities:["repo_mutate_local","test_local","repo_read_remote"],expectedBranch:branch,expectedCommit,taskId,idempotencyKey});
  if(!claimed.claimed)break;
  const handoff=claimed.handoff;if(!handoff||handoff.taskId!==taskId||handoff.branch!==branch||handoff.expectedCommit!==expectedCommit||!allowed.has(handoff.tool))throw new Error("Server returned an invalid bounded handoff.");
  try{
    const started=Date.now(),result=await registry.execute(handoff.tool,handoff.arguments,{runId:taskId,projectId:"nova-brain"});
    if(result?.ok===false)throw Object.assign(new Error(result.error?.message||"Bounded local step failed."),{code:result.error?.code||"worker_failed"});
    const normalized=result?.ok===undefined?{...result,ok:true}:result;
    const completed=await request(`/api/admin/worker/handoff/${encodeURIComponent(handoff.handoffId)}/complete`,{taskId,workerId,idempotencyKey,result:{...normalized,durationMs:normalized.durationMs??Date.now()-started}});
    if(result.commitSha)expectedCommit=result.commitSha;
    if(completed.status==="waiting_for_approval"){console.log(JSON.stringify({status:completed.status,taskId,commitSha:completed.task.currentCommit}));break;}
  }catch(error){await request(`/api/admin/worker/handoff/${encodeURIComponent(handoff.handoffId)}/fail`,{taskId,workerId,idempotencyKey,error:{code:error.code||"worker_failed",message:String(error.message).slice(0,300)}});throw error;}
}
