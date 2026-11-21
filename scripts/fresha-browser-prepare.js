import {chromium} from 'playwright-core';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeFile} from 'node:fs/promises';
import {startFreshaBrowserSession} from '../src/booking/fresha-browser-session.js';
import {createFreshaConnectionWorker} from '../src/booking/fresha-connection-worker.js';
import {createLocalWorkerClient} from '../src/autonomy/local-worker-client.js';
import {createWindowsCredentialStore,loadLocalWorkerCredentials} from '../src/autonomy/local-worker-credentials.js';

const repositoryRoot=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(process.platform!=='win32'||!process.env.LOCALAPPDATA)throw Error('Use the target-specific secure bootstrap.');
const root=join(process.env.LOCALAPPDATA,'NovaBrain','FreshaExecutor');
let session,timer,worker,credentials,closing=false;
async function stop(){if(closing)return;closing=true;clearInterval(timer);credentials?.clear();await session?.close();process.exit(0);}
try {
  session=await startFreshaBrowserSession({root,repositoryRoot,chromium});
  if(process.argv.includes('--worker')){
    const store=createWindowsCredentialStore({helperExecutable:join(process.env.LOCALAPPDATA,'NovaBrain','PersistentWorker','NovaCredentialHelper.exe'),requireNativeHelper:true});
    credentials=await loadLocalWorkerCredentials({store});
    const client=createLocalWorkerClient({baseUrl:'https://nova-test-project-git-codex-combine-ede5f3-hamodehshanbour-6196.vercel.app',...credentials});
    worker=createFreshaConnectionWorker({client,session,workerId:'fresha-local-connection-pilot'});
  }
  const initial=await session.saveStatus();
  console.log(JSON.stringify({state:initial.state,writesEnabled:false,workerStarted:Boolean(worker)}));
  if(process.argv.includes('--availability-proof')){
    const evidence=await session.inspectAvailableTimes();
    await writeFile(join(root,'availability-proof.json'),JSON.stringify(evidence),{mode:0o600});
    console.log(JSON.stringify(evidence));
  }
  let busy=false;
  timer=setInterval(async()=>{if(busy||closing)return;busy=true;try{await session.saveStatus();if(worker){const result=await worker.runOnce();if(result.id){const receipt={workerStarted:true,taskId:result.id,status:result.status,result:result.result,observedAt:new Date().toISOString()};await writeFile(join(root,'worker-receipt.json'),JSON.stringify(receipt),{mode:0o600});console.log(JSON.stringify(receipt));}}}catch(error){const diagnostic={workerStarted:Boolean(worker),state:'queue_request_failed',httpStatus:Number(error.statusCode)||null,observedAt:new Date().toISOString()};await writeFile(join(root,'worker-status.json'),JSON.stringify(diagnostic),{mode:0o600}).catch(()=>{});/* Never log raw browser/auth errors. */}finally{busy=false;}},15000);
  session.context.on('close',()=>stop());
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}catch(error){credentials?.clear();await session?.close().catch(()=>{});console.error(['executor_already_running','unsafe_profile_path'].includes(error.code)?error.code:'fresha_browser_start_failed');process.exitCode=1;}
