import {loadLocalWorkerCredentials} from "./local-worker-credentials.js";
import {createLocalWorkerClient} from "./local-worker-client.js";
import {createPersistentLocalWorker,runPersistentWorkerLoop} from "./persistent-local-worker.js";
import {acquirePersistentWorkerInstance,writePersistentWorkerStatus} from "./persistent-worker-process.js";

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const safeCode=error=>String(error?.code||error?.name||"unexpected_error").slice(0,80);
const bounded=async(promise,ms,code)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error(code),{code})),ms);})]);}finally{clearTimeout(timer);}};
const fatalAuth=error=>error?.statusCode===401||error?.statusCode===403||["unauthorized","handoff_not_configured"].includes(error?.code);

export async function runPersistentWorkerService({baseUrl,repositoryRoot,intervalMs=5000,version="local",probeOnly=false,maxIterations=Infinity,shouldStop=()=>false,delay=sleep,credentialLoader=loadLocalWorkerCredentials,clientFactory=createLocalWorkerClient,workerFactory=createPersistentLocalWorker,acquireInstance=acquirePersistentWorkerInstance,statusWriter=writePersistentWorkerStatus,credentialTimeoutMs=12000,authTimeoutMs=20000}={}){
  const startedAt=new Date().toISOString();let state={startedAt,version};let credentials=null,instance=null;
  const report=async update=>{state={...state,...update};return statusWriter(state);};
  instance=await acquireInstance();
  if(!instance.acquired)return{started:false,reason:"active_instance"};
  await report({state:"starting"});await report({state:"lock_acquired"});
  try{
    try{credentials=await bounded(Promise.resolve().then(()=>credentialLoader()),credentialTimeoutMs,"credential_load_timeout");}catch(error){await report({state:"fatal",code:safeCode(error)});return{started:false,reason:safeCode(error)};}
    await report({state:"credentials_loaded"});let client,worker;
    try{client=clientFactory({baseUrl,novaToken:credentials.novaToken,vercelBypassToken:credentials.vercelBypassToken,requestTimeoutMs:authTimeoutMs});worker=workerFactory({client,root:repositoryRoot});}catch(error){await report({state:"fatal",code:safeCode(error)});return{started:false,reason:safeCode(error)};}
    await report({state:"authenticating",workerId:worker.workerId});let authenticated=false,attempt=0;
    while(!shouldStop()&&!authenticated){attempt+=1;try{await bounded(client.request("/api/admin/worker/auto-dispatch/next",{workerId:worker.workerId,branch:"feat/nova-brain-mvp-foundation"}),authTimeoutMs,"network_timeout");authenticated=true;await report({state:"authenticated",workerId:worker.workerId,lastSuccessfulPoll:new Date().toISOString(),code:null});}catch(error){if(fatalAuth(error)){await report({state:"fatal",code:safeCode(error),workerId:worker.workerId});return{started:false,reason:safeCode(error)};}await report({state:"retrying",code:safeCode(error),workerId:worker.workerId});if(!shouldStop())await delay(Math.min(30000,Math.max(1000,intervalMs*attempt)));}}
    if(!authenticated)return{started:true,stopped:true};
    if(probeOnly){let iterations=0;while(!shouldStop()&&iterations<maxIterations){iterations+=1;await report({state:iterations===1?"polling":"idle",workerId:worker.workerId,lastSuccessfulPoll:new Date().toISOString(),iterations});if(!shouldStop()&&iterations<maxIterations)await delay(intervalMs);}return{started:true,probeOnly:true,iterations};}
    return runPersistentWorkerLoop({worker,intervalMs,delay,shouldStop,maxIterations,onState:report});
  }finally{credentials?.clear?.();await report({state:"stopped"}).catch(()=>{});await instance?.release?.();}
}
