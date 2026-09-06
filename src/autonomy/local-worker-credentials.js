import {randomBytes} from "node:crypto";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";

export const LOCAL_WORKER_CREDENTIALS=Object.freeze({
  nova:"NOVA_LOCAL_WORKER_TOKEN",
  vercel:"VERCEL_AUTOMATION_BYPASS",
});
const SCRIPT=fileURLToPath(new URL("../../scripts/windows-credential-store.ps1",import.meta.url));
const TARGET=name=>`NovaBrain/LocalWorker/${name}`;

export function createWindowsCredentialStore({platform=process.platform,run=execFile}={}){
  if(platform!=="win32")throw new Error("secure_os_store_unavailable");
  const invoke=(action,name,secret)=>new Promise((resolve,reject)=>{
    const child=run("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",SCRIPT,action,TARGET(name)],{windowsHide:true,maxBuffer:8192},(error,stdout)=>error?reject(Object.assign(new Error("secure_os_store_failed"),{code:"secure_os_store_failed"})):resolve(String(stdout).trim()));
    if(secret!==undefined){child.stdin.end(secret);}else child.stdin.end();
  });
  return Object.freeze({
    storage:"secure_os_store",
    async get(name){const value=await invoke("get",name);if(!value)throw Object.assign(new Error("credential_missing"),{code:"credential_missing"});return value;},
    async set(name,value){if(typeof value!=="string"||value.length<32)throw new Error("credential_invalid");await invoke("set",name,value);return{configured:true,storage:"secure_os_store"};},
    async delete(name){return{deleted:(await invoke("delete",name))==="deleted",storage:"secure_os_store"};},
    async status(name){return{configured:(await invoke("status",name))==="configured",storage:"secure_os_store"};},
  });
}

export async function loadLocalWorkerCredentials({environment=process.env,store=createWindowsCredentialStore()}={}){
  const novaToken=environment.NOVA_LOCAL_WORKER_TOKEN||await store.get(LOCAL_WORKER_CREDENTIALS.nova);
  const vercelBypassToken=environment.VERCEL_AUTOMATION_BYPASS_SECRET||await store.get(LOCAL_WORKER_CREDENTIALS.vercel);
  if(novaToken===vercelBypassToken)throw new Error("credentials_must_remain_separate");
  return{novaToken,vercelBypassToken,clear(){this.novaToken=null;this.vercelBypassToken=null;}};
}

export function createLocalWorkerCredentialManager({store,serverSync,verify,generate=()=>randomBytes(48).toString("base64url")}={}){
  if(!store)throw new Error("secure_os_store_required");
  const assertScope=scope=>{if(scope?.environment!=="preview"||scope?.branch!=="feat/nova-brain-mvp-foundation")throw Object.assign(new Error("credential_scope_forbidden"),{code:"credential_scope_forbidden"});};
  return Object.freeze({
    async status(){return{nova:await store.status(LOCAL_WORKER_CREDENTIALS.nova),vercel:await store.status(LOCAL_WORKER_CREDENTIALS.vercel)};},
    async storeVercelBypass(value){return store.set(LOCAL_WORKER_CREDENTIALS.vercel,value);},
    async delete(name){if(!Object.values(LOCAL_WORKER_CREDENTIALS).includes(name))throw new Error("credential_name_forbidden");return store.delete(name);},
    async rotateNova(scope){assertScope(scope);if(!serverSync||!verify)throw new Error("credential_sync_unavailable");let secret=generate(),phase="server_sync";try{await serverSync(secret,scope);phase="local_store";await store.set(LOCAL_WORKER_CREDENTIALS.nova,secret);phase="verification";await verify(secret,scope);return{configured:true,storage:"secure_os_store",environment:"preview",branch:scope.branch};}catch(error){await store.delete(LOCAL_WORKER_CREDENTIALS.nova).catch(()=>{});throw Object.assign(new Error("credential_rotation_incomplete"),{code:"credential_rotation_incomplete",recovery:phase==="server_sync"?"server_sync":"local_secure_store",cause:error});}finally{secret=null;}},
  });
}
