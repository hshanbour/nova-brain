// Same authenticated Nova worker client; a separate bounded capability prevents
// this browser from dispatching old jobs or acquiring repository-execution rights.
export function createFreshaConnectionWorker({client,session,workerId}){
  let busy=false;
  return{async runOnce(){
    if(busy)return{worked:false};busy=true;
    try{
      const job=await client.request('/api/admin/worker/fresha/next',{workerId});
      if(!job.worked)return{worked:false};
      if(!['inspect_connection','inspect_availability','test_prepare','test_create','test_read','test_reschedule','test_cancel'].includes(job.operation)||!job.taskId?.startsWith('fresha_'))throw Object.assign(Error('Unexpected Fresha operation.'),{code:'fresha_operation_forbidden'});
      const result=job.operation.startsWith('test_')?await session.runControlledTest(job.operation,job.previous):job.operation==='inspect_availability'?await session.inspectAvailableTimes():await session.inspect();
      return await client.request('/api/admin/worker/fresha/complete',{taskId:job.taskId,workerId,leaseToken:job.leaseToken,version:job.version,result});
    }finally{busy=false;}
  }};
}
