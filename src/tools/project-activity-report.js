import {RISK_LEVELS} from '../policy/action-policy.js';

// A current read of Nova's records, explicitly not a claim about revenue,
// bookings or provider delivery. No cross-project or synthetic chart values.
export function registerProjectActivityReport(registry,{storage,ownerId}){
 registry.register({name:'project_activity_report',description:'Analyse the current authorised Nova project records and recent execution activity, with sources and a structured chart. This is recorded activity, not live revenue or external provider status.',category:'projects',capability:'read',riskLevel:RISK_LEVELS.READ_ONLY,available:typeof storage.listActivity==='function',configurationStatus:'ready',inputSchema:{type:'object',properties:{projectId:{type:'string'}},required:['projectId'],additionalProperties:false},
  validate({projectId}){if(typeof projectId!=='string'||projectId.length>100||!projectId.trim())throw Error('An exact project is required.');},
  async execute({projectId}){
   const project=(await storage.listProjects(ownerId)).find(p=>p.id===projectId);if(!project)throw Error('Project not found.');
   const activity=await storage.listActivity(ownerId,{projectId,limit:100});
   const sources=await storage.listProjectSources(ownerId,{projectId,status:'active',limit:100});
   const counts=new Map();for(const event of activity)counts.set(event.status,(counts.get(event.status)||0)+1);
   const observedAt=new Date().toISOString(),sourceId=`nova-activity:${projectId}`;
   return {project:{id:project.id,name:project.name},observedAt,recordedEvents:activity.length,sources:[{id:sourceId,label:`Nova activity records: ${project.name}`,retrievedAt:observedAt},...sources.map(s=>({id:s.id,label:s.label,locator:s.locator,accessMode:s.accessMode,retrievedAt:s.retrievedAt}))],charts:activity.length?[{type:'bar',title:'Recorded project activity — latest 100 events',unit:'events',sourceIds:[sourceId],observedAt,points:[...counts].map(([label,value])=>({label,value}))}]:[],recentEvidence:activity.slice(0,12).map(e=>({id:e.id,action:e.action,status:e.status,createdAt:e.createdAt,runId:e.runId})),limitations:['Events can include tests and repeated stages of one run; counts are not unique completed jobs.','Provider delivery, bookings, revenue and current website health are unavailable unless separately verified.','Source records retain their original retrieval dates; registering a source is not refreshing it.']};
  }});
}
