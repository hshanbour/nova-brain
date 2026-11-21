import {randomUUID} from 'node:crypto';

const PROJECT='sharp-cuts-web',SCOPE='fresha_connection_v1';
const TEST_ID='fresha_controlled_20261121';
const TEST_OPS=new Set(['test_prepare','test_create','test_read','test_reschedule','test_cancel']);
const OPERATIONS=new Set(['inspect_connection','inspect_availability',...TEST_OPS]);
export function sanitizeTestResult(v={}){
 const states=new Set(['prepared','created','read_back','rescheduled','cancelled','blocked','uncertain']);
 return {state:states.has(v.state)?v.state:'blocked',appointmentId:/^[0-9]{4,20}$/.test(v.appointmentId||'')?String(v.appointmentId):null,stage:typeof v.stage==='string'?v.stage.replace(/[^a-z_]/g,'').slice(0,60):null,start:/^2026-11-21T[0-2][0-9]:[0-5][0-9]:00Z$/.test(v.start||'')?v.start:null,end:/^2026-11-21T[0-2][0-9]:[0-5][0-9]:00Z$/.test(v.end||'')?v.end:null,observedAt:Number.isFinite(Date.parse(v.observedAt))?v.observedAt:null,walkIn:v.walkIn===true,notifications:false,checkout:false,customerCreated:false,detail:typeof v.detail==='string'?v.detail.slice(0,240):null};
}
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
  const receipt=t=>({id:t.id,status:t.status,createdAt:t.createdAt,completedAt:t.completedAt||null,result:t.metadata?.freshaResult||null,writesEnabled:false,operation:t.metadata?.freshaOperation,history:t.metadata?.freshaHistory||[]});
  async function list(){return(await storage.listAutonomyTasks(ownerId,{limit:100,executionScope:SCOPE})).filter(belongs);}
  return{
    async request({operation='inspect_connection'}={}){
      if(!OPERATIONS.has(operation))throw fail('fresha_operation_forbidden');
      if(!(await storage.listProjects(ownerId)).some(p=>p.id===PROJECT))throw fail('fresha_project_access_denied');
      if(TEST_OPS.has(operation)){
        if(new Date(clock()).toISOString().slice(0,10)!=='2026-11-21')throw fail('test_approval_date_expired');
        const old=await storage.getAutonomyTask(TEST_ID,ownerId);
        if(old){
          if(!belongs(old))throw fail('test_record_scope_mismatch');
          if(['queued','running'].includes(old.status))return{...receipt(old),reused:true};
          const last=old.metadata?.freshaResult;
          const allowed={test_prepare:['prepared','blocked'],test_create:['prepared'],test_read:['created','read_back','rescheduled'],test_reschedule:['read_back'],test_cancel:['rescheduled']};
          if(!allowed[operation]?.includes(last?.state))throw fail('test_lifecycle_order_or_reconciliation_required');
          if(operation==='test_prepare'&&(last?.appointmentId||old.metadata.freshaHistory?.some(x=>x.operation==='test_create')))throw fail('test_creation_already_attempted');
          if(operation==='test_create'&&old.metadata.freshaHistory?.some(x=>x.operation==='test_create'))throw fail('test_creation_already_attempted');
          const updated=await storage.updateAutonomyTask(TEST_ID,ownerId,{status:'queued',completedAt:null,metadata:{...old.metadata,freshaOperation:operation}},old.stateVersion);
          if(!updated)throw fail('test_request_conflict');return receipt(updated);
        }
        if(operation!=='test_prepare')throw fail('test_prepare_required');
        return receipt(await storage.createAutonomyTask({id:TEST_ID,ownerId,projectId:PROJECT,title:'Owner-approved Fresha walk-in lifecycle · 21 November',objective:'Exactly one new Hamood walk-in haircut, 25 minutes, future available slots today; read, move same ID, cancel same ID. No customer, checkout, payment or notifications.',taskType:'fresha_connection',maxSteps:1,maxRetries:0,maxRuntimeMinutes:5,metadata:{connectedExecution:SCOPE,requiredCapability:SCOPE,freshaOperation:operation,freshaHistory:[],approval:'Owner approval 21 November: nearest available future slots; exactly one walk-in test.'}}));
      }
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
        if(claimed)return{worked:true,taskId:task.id,operation:task.metadata.freshaOperation,previous:task.metadata.freshaResult||null,leaseToken,version:claimed.stateVersion};
      }
      return{worked:false};
    },
    async complete({taskId,workerId,leaseToken,version,result}){
      const task=await storage.getAutonomyTask(taskId,ownerId);
      if(!belongs(task)||task.status!=='running'||task.leaseOwner!==workerId||task.leaseToken!==leaseToken||task.stateVersion!==version||Date.parse(task.leaseExpiresAt)<=clock())throw fail('fresha_receipt_binding_invalid');
      const isTest=TEST_OPS.has(task.metadata.freshaOperation),safe=isTest?sanitizeTestResult(result):task.metadata.freshaOperation==='inspect_availability'?sanitizeFreshaAvailability(result):sanitizeFreshaConnection(result);
      if(isTest&&task.metadata.freshaResult?.appointmentId&&safe.appointmentId!==task.metadata.freshaResult.appointmentId)throw fail('test_appointment_id_mismatch');
      const updated=await storage.updateAutonomyTask(taskId,ownerId,{status:'completed',completedAt:new Date(clock()).toISOString(),leaseOwner:null,leaseToken:null,leaseExpiresAt:null,resultSummary:`Fresha result: ${safe.state}.`,metadata:{...task.metadata,freshaResult:safe,...(isTest?{freshaHistory:[...(task.metadata.freshaHistory||[]),{operation:task.metadata.freshaOperation,...safe}]}:{})}},version);
      if(!updated)throw fail('fresha_receipt_conflict');
      return receipt(updated);
    }
  };
}
