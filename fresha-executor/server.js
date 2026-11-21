import {chromium} from 'playwright-core';
import {createServer} from 'node:http';
import {startFreshaBrowserSession} from '../src/booking/fresha-browser-session.js';
import {createFreshaConnectionWorker} from '../src/booking/fresha-connection-worker.js';
import {createLocalWorkerClient} from '../src/autonomy/local-worker-client.js';

const baseUrl='https://nova-test-project-git-codex-combine-ede5f3-hamodehshanbour-6196.vercel.app';
const client=createLocalWorkerClient({baseUrl,novaToken:process.env.NOVA_LOCAL_WORKER_TOKEN,vercelBypassToken:process.env.VERCEL_AUTOMATION_BYPASS_SECRET});
const session=await startFreshaBrowserSession({root:'/data/NovaBrain/FreshaExecutor',repositoryRoot:'/app',chromium,executablePath:'/usr/bin/chromium',headless:false,localOnly:false});
const worker=createFreshaConnectionWorker({client,session,workerId:`fresha-cloud-${process.env.FLY_MACHINE_ID||'unbound'}`,ownerLoginMode:process.env.FRESHA_OWNER_LOGIN_ENABLED==='true'});
let busy=false,lastPoll=null,lastError=null,stopping=false;
// Loopback health only. Hosting probe must execute inside the machine.
const health=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({lastPoll,lastError,capability:'bounded_fresha_executor',writesEnabled:false}));}).listen(8080,'127.0.0.1');
const timer=setInterval(async()=>{if(busy||stopping)return;busy=true;try{await worker.runOnce();lastPoll=new Date().toISOString();lastError=null;}catch{lastError='connection_check_failed';}finally{busy=false;}},15000);
async function stop(){stopping=true;clearInterval(timer);health.close();const until=Date.now()+25000;while(busy&&Date.now()<until)await new Promise(r=>setTimeout(r,250));await session.close();process.exit(0);}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
