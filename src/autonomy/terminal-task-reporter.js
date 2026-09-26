import {createHash} from "node:crypto";

const TERMINAL=new Set(["completed","failed","blocked","cancelled","expired"]);
const RESULT_QUESTION=/\b(?:what\s+(?:changed|happened)|show\s+me|what\s+(?:tests?|commit|files?)|completed\s+(?:result|task)|task\s+(?:result|outcome|status)|result\s+(?:of|from))\b/i;
const MUTATION_REQUEST=/\b(?:implement|build|fix|change|update|edit|modify|deploy|push|retry|resume|recover|cancel|approve|reject)\b/i;
const bounded=(value,max=500)=>typeof value==="string"?value
  .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi,"Bearer [REDACTED]")
  .replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g,"[REDACTED]")
  .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi,"$1=[REDACTED]")
  .replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,max):"";
const list=(value,max=20)=>Array.isArray(value)?value.map(item=>bounded(item,300)).filter(Boolean).slice(0,max):[];
const digest=(value)=>createHash("sha256").update(value).digest("hex");
const bullet=(items)=>items.map(item=>`- ${item}`).join("\n");
const stepOrdinal=(step)=>Number.parseInt(step?.stepId,10)||0;

export function isConversationTaskResultQuestion(message){
  const value=String(message||"").trim();
  return value.length>0&&value.length<=500&&RESULT_QUESTION.test(value)&&!MUTATION_REQUEST.test(value);
}

function codingResult(task,steps){
  const execution=[...steps].sort((a,b)=>stepOrdinal(a)-stepOrdinal(b)).reverse().find(step=>step.stepType==="delegate_coding");
  return execution?.result?.diagnostics?.codingResult||execution?.result||null;
}

function testLines(raw,steps){
  const reported=Array.isArray(raw?.tests)?raw.tests.map(test=>{
    if(typeof test==="string")return bounded(test,300);
    const name=bounded(test?.name||test?.command||"Test",120),status=bounded(test?.status||test?.result||"reported",40),summary=bounded(test?.summary||"",240);
    return `${name}: ${status}${summary?` — ${summary}`:""}`;
  }).filter(Boolean):[];
  if(reported.length)return reported.slice(0,20);
  return steps.filter(step=>["run_focused_tests","run_full_tests"].includes(step.stepType)).map(step=>`${step.stepType==="run_focused_tests"?"Focused tests":"Broader tests"}: ${bounded(step.status,40)||"unknown"}`).slice(0,10);
}

export function renderTerminalTaskReport(task,steps=[]){
  if(!task||!TERMINAL.has(task.status))return null;
  const raw=task.taskType==="coding_delegation"?codingResult(task,steps):null;
  const summary=bounded(raw?.summary||task.resultSummary||task.blockedReason||({completed:"The durable task completed.",failed:"The durable task failed safely.",blocked:"The durable task is blocked.",cancelled:"The durable task was cancelled.",expired:"The durable task expired."}[task.status]),1200);
  const ordered=[...steps].sort((a,b)=>stepOrdinal(a)-stepOrdinal(b)),apply=[...ordered].reverse().find(step=>step.stepType==="apply_patch"&&step.status==="completed"),commitStep=[...ordered].reverse().find(step=>["commit","integrate_commit"].includes(step.stepType)&&step.status==="completed");
  const files=list(raw?.filesChanged||apply?.result?.changedFiles,40),tests=testLines(raw,steps),limitations=list(raw?.limitations,20);
  const commit=bounded(raw?.finalLocalSha||raw?.commitSha||commitStep?.result?.commitSha||"",64),jobRef=bounded(raw?.executor?.localRef||raw?.retainedJobRef||raw?.jobRef||raw?.localRef||"",240);
  const failure=raw?.failure||null,errorCode=bounded(failure?.code||task.errorCode||"",80),reason=bounded(failure?.message||task.blockedReason||"",600);
  const completedSteps=steps.filter(step=>step.status==="completed").length,changed=files.length>0||steps.some(step=>["apply_patch","commit","integrate_commit"].includes(step.stepType)&&step.status==="completed");
  const lines=[`Task report — ${task.id}`,`Status: ${task.status}`,"",summary];
  if(files.length)lines.push("","Files changed:",bullet(files));
  if(tests.length)lines.push("","Tests:",bullet(tests));
  if(commit&&/^[a-f0-9]{40}$/.test(commit))lines.push("",`Local commit: ${commit}`);
  if(jobRef)lines.push(`Retained coding-job ref: ${jobRef}`);
  if(limitations.length)lines.push("","Limitations:",bullet(limitations));
  if(errorCode||reason)lines.push("",`Reason: ${errorCode?`${errorCode}${reason?" — ":""}`:""}${reason}`);
  if(task.status!=="completed")lines.push("",`Reached: ${bounded(task.currentPhase||"unknown",80)}; ${completedSteps} durable step${completedSteps===1?"":"s"} completed.`,`Changes recorded: ${changed?"yes":"no"}. Tests recorded: ${tests.length?"yes":"no"}.`);
  const pushOccurred=raw?raw.pushOccurred===true:ordered.some(step=>step.stepType==="push"&&step.status==="completed"),deploymentOccurred=raw?raw.deploymentOccurred===true:ordered.some(step=>step.stepType==="deploy_preview"&&step.status==="completed");
  lines.push("",`Push: ${pushOccurred?"occurred":"not performed"}. Deployment: ${deploymentOccurred?"occurred":"not performed"}.`);
  const approvals=list(raw?.approvalsRequiredNext,10);
  lines.push("",approvals.length?`Next approval/action:\n${bullet(approvals)}`:task.status==="blocked"||task.status==="failed"?"Next action: review the safe failure above before retrying or changing scope.":"Next approval/action: none reported.");
  return lines.join("\n").slice(0,12000);
}

export function createTerminalTaskReporter({storage,ownerId}={}){
  if(!storage||!ownerId)throw new Error("Terminal task reporting requires storage and an owner.");
  const binding=(task)=>task?.metadata?.terminalReporting;
  const eligible=(task)=>{
    const origin=binding(task);
    if(!TERMINAL.has(task?.status)||origin?.version!==1||typeof origin.conversationId!=="string")return false;
    if(task.taskType==="coding_orchestration"&&task.metadata?.delegatedTaskId)return false;
    return true;
  };
  async function enqueue(task){
    if(!eligible(task))return null;
    const content=renderTerminalTaskReport(task,await storage.listAutonomySteps(task.id));
    const reportKey=`${task.id}:${task.stateVersion}`,messageId=`task-report_${digest(`${task.id}:${task.stateVersion}:${task.status}`).slice(0,48)}`;
    return storage.enqueueTaskReport({reportKey,taskId:task.id,ownerId,conversationId:binding(task).conversationId,terminalStateVersion:task.stateVersion,terminalStatus:task.status,messageId,content});
  }
  async function reconcile({limit=100}={}){
    const tasks=await storage.listTerminalTaskReportCandidates(ownerId,{limit:Math.max(100,limit)});
    let enqueued=0,delivered=0;
    for(const task of tasks){if(eligible(task)){await enqueue(task);enqueued+=1;}}
    for(const report of await storage.listPendingTaskReports(ownerId,{limit})){await storage.deliverTaskReport(report.reportKey,ownerId);delivered+=1;}
    return{enqueued,delivered};
  }
  async function latestForConversation(conversationId){
    const tasks=await storage.listConversationBoundTasks(ownerId,conversationId,{limit:50});
    tasks.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))||String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const task=tasks.find(item=>!(item.taskType==="coding_orchestration"&&item.metadata?.delegatedTaskId));
    if(!task)return null;
    const message=TERMINAL.has(task.status)?renderTerminalTaskReport(task,await storage.listAutonomySteps(task.id)):`Task report — ${task.id}\nStatus: ${task.status}\n\nNova is still working at the ${bounded(task.currentPhase||"current",80)} stage. No terminal result is available yet.`;
    return{task,message};
  }
  return Object.freeze({enqueue,reconcile,latestForConversation});
}
