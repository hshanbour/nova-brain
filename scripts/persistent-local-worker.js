import {runPersistentWorkerService} from "../src/autonomy/persistent-worker-startup.js";
import {writePersistentWorkerStatus} from "../src/autonomy/persistent-worker-process.js";

const urlIndex=process.argv.indexOf("--preview-url"),argumentUrl=urlIndex>=0?process.argv[urlIndex+1]:"";
const base=(argumentUrl||process.env.NOVA_LOCAL_WORKER_URL||"").replace(/\/$/,"");
const interval=Math.max(1000,Math.min(60000,Number(process.env.NOVA_WORKER_POLL_MS)||5000));
const probeOnly=process.argv.includes("--probe-only");let stopping=false;
process.on("SIGINT",()=>{stopping=true;});process.on("SIGTERM",()=>{stopping=true;});
const fatal=async error=>{await writePersistentWorkerStatus({state:"fatal",code:error?.code||error?.name||"unexpected_error",version:process.env.NOVA_WORKER_VERSION||"local"}).catch(()=>{});process.exit(1);};process.once("uncaughtException",fatal);process.once("unhandledRejection",fatal);
await runPersistentWorkerService({baseUrl:base,intervalMs:interval,version:process.env.NOVA_WORKER_VERSION||"local",probeOnly,maxIterations:probeOnly?3:Infinity,shouldStop:()=>stopping});
