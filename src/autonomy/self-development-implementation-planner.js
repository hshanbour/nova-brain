import {createHash} from "node:crypto";

const SHA=/^[a-f0-9]{40}$/;
const PROTECTED=/(^|\/)(src\/voice|speaker-worker|assets\/(?:voice-(?!input(?:\.|$))|speaker-)|\.github|api\/index\.js|src\/(?:policy|storage|autonomy))(\/|$)|ecapa|elevenlabs|voice-control|production|credential|secret|token/i;
const safePath=value=>{const path=String(value||"").trim().replaceAll("\\","/");if(!path||path.length>240||path.startsWith("/")||path.includes(".."))throw plannerError("implementation_plan_invalid","Implementation plan contains an invalid path.");return path;};
const plannerError=(code,message)=>Object.assign(new Error(message),{code,retryable:false});
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const hash=value=>createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
const parse=value=>{const text=String(value||"").trim().replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"");try{return JSON.parse(text);}catch{throw plannerError("implementation_plan_invalid","Nova returned an invalid structured implementation plan.");}};

export function createSelfDevelopmentImplementationPlanner({modelProvider,storage,ownerId}={}){
  if(!modelProvider||!storage||!ownerId)throw new Error("Self-development implementation planner dependencies are required.");
  async function generate({taskId,candidatePaths,currentCommit}){
    if(typeof taskId!=="string"||!Array.isArray(candidatePaths)||candidatePaths.length<2||candidatePaths.length>12||!SHA.test(currentCommit||""))throw plannerError("implementation_plan_invalid","Exact task, commit, and bounded candidate paths are required.");
    const task=await storage.getAutonomyTask(taskId,ownerId);if(!task||task.taskType!=="self_development"||task.currentCommit!==currentCommit||task.branch!=="feat/nova-brain-mvp-foundation")throw plannerError("implementation_plan_precondition_failed","Implementation planning task binding changed.");
    const candidates=[...new Set(candidatePaths.map(safePath))];if(candidates.some(path=>PROTECTED.test(path)))throw plannerError("protected_scope_requires_approval","Protected Voice or runtime architecture cannot be planned by this recovery.");
    const steps=await storage.listAutonomySteps(task.id),reads=new Map();for(const step of steps.filter(item=>item.stepType==="read_files"&&item.status==="completed")){const path=step.result?.path||step.input?.arguments?.path;if(path&&typeof step.result?.content==="string"&&!step.result?.truncated)reads.set(path,step.result.content);}
    if(candidates.some(path=>!reads.has(path)))throw plannerError("implementation_evidence_incomplete","Every candidate file must be read completely before implementation planning.");
    const request=task.metadata?.selfDevelopment,evidence=candidates.map(path=>({path,content:reads.get(path)}));if(JSON.stringify(evidence).length>180000)throw plannerError("implementation_evidence_too_large","Implementation evidence exceeds the bounded planner context.");
    const generated=await modelProvider.generate({message:`Create the bounded implementation plan as JSON only.\n${JSON.stringify({taskId:task.id,currentCommit,userGoal:request.userGoal,acceptanceCriteria:request.acceptanceCriteria,candidateFiles:evidence})}`,conversationHistory:[],context:{},tools:[],systemContext:"You are Nova's Self-Development implementation planner. Return one JSON object with files, focusedTests, acceptanceMapping, riskLevel, and summary. files must contain path, complete replacement content, reason, and intendedChanges. Use only candidateFiles. Modify only files required by the goal. focusedTests must name candidate test files. Never target Voice Mode, ECAPA, ElevenLabs, speaker verification, Voice controls, main, or Production. Do not use shell commands, markdown fences, or secrets."});
    if(generated?.type!=="final")throw plannerError("implementation_plan_invalid","Nova implementation planning must return one structured final result.");const value=parse(generated.message);
    if(!value||typeof value!=="object"||Array.isArray(value)||!Array.isArray(value.files)||!value.files.length||value.files.length>8||!Array.isArray(value.focusedTests)||!value.focusedTests.length||!Array.isArray(value.acceptanceMapping)||!['low','medium'].includes(value.riskLevel)||typeof value.summary!=="string")throw plannerError("implementation_plan_invalid","Nova implementation plan does not match the bounded schema.");
    const files=value.files.map(file=>{const path=safePath(file?.path);if(!candidates.includes(path)||PROTECTED.test(path)||typeof file.content!=="string"||file.content.length>250000||typeof file.reason!=="string"||!Array.isArray(file.intendedChanges)||file.intendedChanges.some(item=>typeof item!=="string"))throw plannerError("implementation_scope_violation","Nova proposed a file outside the evidence-bound scope.");return{path,content:file.content,expectedContent:reads.get(path),reason:file.reason.slice(0,500),intendedChanges:file.intendedChanges.slice(0,20).map(item=>item.slice(0,300))};});
    const paths=new Set(files.map(file=>file.path)),focusedTests=[...new Set(value.focusedTests.map(safePath))];if(focusedTests.some(path=>!candidates.includes(path)||!path.startsWith("test/")||!reads.has(path)))throw plannerError("implementation_scope_violation","Focused tests must be evidence-read candidate test files.");
    for(const mapping of value.acceptanceMapping){if(typeof mapping?.criterion!=="string"||!Array.isArray(mapping.files)||mapping.files.some(path=>!paths.has(path)))throw plannerError("implementation_plan_invalid","Acceptance mapping must reference only generated patch files.");}
    const implementationPlan={files,focusedTests,acceptanceMapping:value.acceptanceMapping.map(item=>({criterion:item.criterion.slice(0,500),files:item.files})),riskLevel:value.riskLevel,summary:value.summary.slice(0,1000),evidencePaths:candidates,goalHash:hash(request.userGoal),evidenceHash:hash(evidence),planHash:hash({files:files.map(({expectedContent,...file})=>file),focusedTests,acceptanceMapping:value.acceptanceMapping,riskLevel:value.riskLevel})};
    return{ok:true,implementationPlan};
  }
  return Object.freeze({generate});
}

export const SELF_DEVELOPMENT_PLANNER_PROTECTED=PROTECTED;
