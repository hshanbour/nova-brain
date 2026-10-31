const CONTROL_KEYS=Object.freeze(["master","publishing","messaging","marketing","reminders"]);
const DEFAULT_CONTROLS=Object.freeze({master:false,publishing:false,messaging:false,marketing:false,reminders:false});

export class ProjectAutomationControlError extends Error{
  constructor(message,{code="automation_control_invalid",statusCode=400}={}){super(message);this.name="ProjectAutomationControlError";this.code=code;this.statusCode=statusCode;}
}

export function createProjectAutomationControls({storage,ownerId}={}){
  if(!storage||!ownerId)throw new TypeError("Project automation control dependencies are required.");
  const ensureProject=async projectId=>{
    const id=String(projectId||"").trim();
    if(!id||(await storage.listProjects(ownerId)).every(project=>project.id!==id))throw new ProjectAutomationControlError("Project was not found.",{code:"automation_project_not_found",statusCode:404});
    return id;
  };
  const current=async projectId=>{
    const id=await ensureProject(projectId),events=await storage.listActivity(ownerId,{projectId:id,limit:100});
    const latest=events.find(event=>event.action==="project_automation_controls_updated"&&event.metadata?.controls);
    const controls={...DEFAULT_CONTROLS,...(latest?.metadata?.controls||{})};
    return{projectId:id,controls,effective:Object.fromEntries(CONTROL_KEYS.map(key=>[key,key==="master"?controls.master:controls.master&&controls[key]])),updatedAt:latest?.createdAt||null,updatedBy:latest?.metadata?.actor||null,safety:{missedWorkExecution:false,approvalRequirementsPreserved:true,draftsSchedulesHistoryPreserved:true,externalSpendAuthority:false},audit:events.filter(event=>event.action==="project_automation_controls_updated").slice(0,20)};
  };
  return Object.freeze({
    current,
    async update(projectId,input={}){
      const state=await current(projectId),patch=input.controls;
      if(!patch||typeof patch!=="object"||Array.isArray(patch))throw new ProjectAutomationControlError("controls must be an object.");
      const keys=Object.keys(patch);
      if(!keys.length||keys.some(key=>!CONTROL_KEYS.includes(key))||keys.some(key=>typeof patch[key]!=="boolean"))throw new ProjectAutomationControlError("Only supported boolean automation controls may be changed.");
      const controls={...state.controls,...patch};
      const event=await storage.appendActivity({ownerId,projectId:state.projectId,action:"project_automation_controls_updated",tool:"project_automation_control",status:"completed",summary:`Updated ${keys.join(", ")} automation control${keys.length===1?"":"s"}; no queued work was executed.`,metadata:{controls,changed:keys,actor:"owner_dashboard",missedWorkExecution:false,externalSideEffects:false}});
      return{...(await current(state.projectId)),eventId:event.id};
    },
    async allows(projectId,capability){
      if(!CONTROL_KEYS.includes(capability)||capability==="master")return false;
      const state=await current(projectId);return state.controls.master===true&&state.controls[capability]===true;
    }
  });
}

export {CONTROL_KEYS,DEFAULT_CONTROLS};
