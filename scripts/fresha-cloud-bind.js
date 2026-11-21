import {randomBytes} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {createWindowsCredentialStore,loadLocalWorkerCredentials} from '../src/autonomy/local-worker-credentials.js';
const store=createWindowsCredentialStore({helperExecutable:join(process.env.LOCALAPPDATA,'NovaBrain','PersistentWorker','NovaCredentialHelper.exe'),requireNativeHelper:true});
const values=await loadLocalWorkerCredentials({store});
const secretPath=join(process.env.LOCALAPPDATA,'NovaBrain','FreshaExecutor','cloud-vnc.secret');const vnc=await readFile(secretPath,'utf8').catch(async()=>{const v=randomBytes(18).toString('base64url');await writeFile(secretPath,v,{mode:0o600});return v;});
try{if(!values.novaToken||!values.vercelBypassToken)throw Error('Required existing worker bindings unavailable');const child=spawn(join(process.env.USERPROFILE,'.fly','bin','flyctl.exe'),['secrets','import','--stage','--app','nova-sharp-cuts-fresha-executor'],{stdio:['pipe','pipe','pipe'],windowsHide:true});let diagnostic='';child.stdout.on('data',x=>diagnostic+=x);child.stderr.on('data',x=>diagnostic+=x);child.stdin.end('NOVA_LOCAL_WORKER_TOKEN='+values.novaToken+'\nVERCEL_AUTOMATION_BYPASS_SECRET='+values.vercelBypassToken+'\nFRESHA_VNC_PASSWORD='+vnc+'\n');const code=await new Promise(r=>child.on('close',r));if(code!==0)throw Error('Fly secret import failed; values withheld');console.log('Existing worker bindings staged securely for the approved Fresha app. Values not printed.');}finally{values.clear();}
