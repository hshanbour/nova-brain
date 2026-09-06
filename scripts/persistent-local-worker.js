import {createLocalWorkerClient} from "../src/autonomy/local-worker-client.js";
import {loadLocalWorkerCredentials} from "../src/autonomy/local-worker-credentials.js";
import {createPersistentLocalWorker,runPersistentWorkerLoop} from "../src/autonomy/persistent-local-worker.js";
import {acquirePersistentWorkerInstance,writePersistentWorkerStatus} from "../src/autonomy/persistent-worker-process.js";

const urlIndex=process.argv.indexOf("--preview-url"),argumentUrl=urlIndex>=0?process.argv[urlIndex+1]:"";
const base=(argumentUrl||process.env.NOVA_LOCAL_WORKER_URL||"").replace(/\/$/,"");
const interval=Math.max(1000,Math.min(60000,Number(process.env.NOVA_WORKER_POLL_MS)||5000));
const instance=await acquirePersistentWorkerInstance();if(!instance.acquired)process.exit(0);
const credentials=await loadLocalWorkerCredentials();let stopping=false;
process.on("SIGINT",()=>{stopping=true;});process.on("SIGTERM",()=>{stopping=true;});
const fatal=async error=>{await writePersistentWorkerStatus({state:"fatal",code:error?.code||"unexpected_error"}).catch(()=>{});process.exit(1);};process.once("uncaughtException",fatal);process.once("unhandledRejection",fatal);
try{const client=createLocalWorkerClient({baseUrl:base,novaToken:credentials.novaToken,vercelBypassToken:credentials.vercelBypassToken}),worker=createPersistentLocalWorker({client});await writePersistentWorkerStatus({state:"started"});await runPersistentWorkerLoop({worker,intervalMs:interval,shouldStop:()=>stopping,onState:state=>{writePersistentWorkerStatus(state).catch(()=>{});}});}finally{credentials.clear();await instance.release();await writePersistentWorkerStatus({state:"stopped"}).catch(()=>{});}
