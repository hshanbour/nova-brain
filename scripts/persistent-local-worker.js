import {setTimeout as delay} from "node:timers/promises";
import {createLocalWorkerClient} from "../src/autonomy/local-worker-client.js";
import {loadLocalWorkerCredentials} from "../src/autonomy/local-worker-credentials.js";
import {createPersistentLocalWorker} from "../src/autonomy/persistent-local-worker.js";

const base=(process.env.NOVA_LOCAL_WORKER_URL||"").replace(/\/$/,"");
const interval=Math.max(1000,Math.min(60000,Number(process.env.NOVA_WORKER_POLL_MS)||5000));
const credentials=await loadLocalWorkerCredentials();let stopping=false;
process.on("SIGINT",()=>{stopping=true;});process.on("SIGTERM",()=>{stopping=true;});
try{const client=createLocalWorkerClient({baseUrl:base,novaToken:credentials.novaToken,vercelBypassToken:credentials.vercelBypassToken}),worker=createPersistentLocalWorker({client});while(!stopping){try{const result=await worker.runOnce();if(!result.worked)await delay(interval);}catch(error){console.error("Nova persistent Worker iteration failed safely.",{code:error.code||"unexpected_error"});await delay(interval);}}}finally{credentials.clear();}
