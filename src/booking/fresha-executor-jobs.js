import {randomUUID} from 'node:crypto';

const PROJECT='sharp-cuts-web',SCOPE='fresha_connection_v1';
const OPERATIONS=new Set(['inspect_connection','inspect_availability']);
const STATES=new Set(['unavailable','sign_in_required','owner_intervention_required','business_verification_required','business_visible']);
const fail=code=>Object.assign(Error(code),{code,statusCode:409});
export function sanitizeFreshaConnection(value={}){
  return {state:STATES.has(value.state)?value.state:'unavailable',calendarVisible:value.calendarVisible===true,businessVisible:value.businessVisible===true,writesEnabled:false,localOnly:value.localOnly!==false,observedAt:Number.isFinite(Date.parse(value.observedAt))?value.observedAt:null};
}
export function sanitizeFreshaAvailability(value={}){
  const valid=value.state==='availability_read'&&value.locationId==='139805'&&value.date==='2026-11-21'&&value.teamMember==='Hamood'&&value.service==='Haircut (no beard trim )'&&Array.isArray(value.times)&&value.times.some(t=>typeof t==='string'&&/^(?:[1-9]|1[0-2]):[0-5][0-9]\s(?:am|pm)$/.test(t));
  return {state:valid?'availability_read':'availability_read_incomplete',locationId:'139805',date:'2026-11-21',teamMember:'Hamood',service:'Haircut (no beard trim )',times:valid?[...new Set(value.times.filter(t=>typeof t==='string'&&/^(?:[1-9]|1[0-2]):[0-5][0-9]\s(?:am|pm)$/.test(t)))].slice(0,144):[],writesEnabled:false,observedAt:Number.isFinite(Date.parse(value.observedAt))?value.observedAt:null};
}

// Reuse Nova's durable job store, but never claim general jobs or the WhatsApp
// backlog. This initial transport has precisely one capability: inspect the
// dedicated browser's current connection. No arbitrary URL, selector or script.
export function createFreshaExecutorJobs({storage,ownerId,clock=()=>Date.now()}){
  const belongs=t=>t?.ownerId===ownerId&&t.projectId===PROJECT&&t.metadata?.connectedExecution===SCOPE&&OPERATIONS.has(t.metadata?.freshaOperation);
  const receipt=t=>({id:t.id,status:t.status,createdAt:t.createdAt,completedAt:t.completedAt||null,result:t.metadata?.freshaResult||null,writesEnabled:false});
  async function list(){return(await storage.listAutonomyTasks(ownerId,{limit:100,executionScope:SCOPE})).filter(belongs);}
  return{
    async request({operation='inspect_connection'}={}){
      if(!OPERATIONS.has(operation))throw fail('fresha_operation_forbidden');
      if(!(await storage.listProjects(ownerId)).some(p=>p.id===PROJECT))throw fail('fresha_project_access_denied');
      const existing=(await list()).find(t=>['queued','running'].includes(t.status)&&t.metadata.freshaOperation===operation);
      if(existing)return{...receipt(existing),reused:true};
      const task=await storage.createAutonomyTask({id:`fresha_${randomUUID()}`,ownerId,projectId:PROJECT,title:operation==='inspect_availability'?'Read Fresha controlled-test availability':'Check dedicated Fresha connection',objective:'Read only; no calendar writes, customer records or sends.',taskType:'fresha_connection',maxSteps:1,maxRetries:0,maxRuntimeMinutes:5,metadata:{connectedExecution:SCOPE,requiredCapability:SCOPE,freshaOperation:operation}});
      return receipt(task);
    },
    async status(){return{capability:'read_only_connection_and_availability',writesEnabled:false,checks:(await list()).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,10).map(receipt)};},
    async next({workerId}){
      if(!/^fresha-[a-zA-Z0-9-]{6,80}$/.test(workerId||''))throw fail('fresha_worker_invalid');
      for(const task of await list()){
        if(task.status==='running'&&Date.parse(task.leaseExpiresAt)<clock()){
          await storage.updateAutonomyTask(task.id,ownerId,{status:'blocked',errorCode:'fresha_executor_disconnected',blockedReason:'Connection check lost its executor. Request a new read; no write was attempted.'},task.stateVersion);continue;
        }
        if(task.status!=='queued')continue;
        const leaseToken=randomUUID(),claimed=await storage.updateAutonomyTask(task.id,ownerId,{status:'running',leaseOwner:workerId,leaseToken,leaseExpiresAt:new Date(clock()+300000).toISOString(),startedAt:new Date(clock()).toISOString()},task.stateVersion);
        if(claimed)return{worked:true,taskId:task.id,operation:task.metadata.freshaOperation,leaseToken,version:claimed.stateVersion};
      }
      return{worked:false};
    },
    async complete({taskId,workerId,leaseToken,version,result}){
      const task=await storage.getAutonomyTask(taskId,ownerId);
      if(!belongs(task)||task.status!=='running'||task.leaseOwner!==workerId||task.leaseToken!==leaseToken||task.stateVersion!==version||Date.parse(task.leaseExpiresAt)<=clock())throw fail('fresha_receipt_binding_invalid');
      const safe=task.metadata.freshaOperation==='inspect_availability'?sanitizeFreshaAvailability(result):sanitizeFreshaConnection(result),updated=await storage.updateAutonomyTask(taskId,ownerId,{status:'completed',completedAt:new Date(clock()).toISOString(),leaseOwner:null,leaseToken:null,leaseExpiresAt:null,resultSummary:`Fresha read: ${safe.state}. Booking writes disabled.`,metadata:{...task.metadata,freshaResult:safe}},version);
      if(!updated)throw fail('fresha_receipt_conflict');
      return receipt(updated);
    }
  };
}
