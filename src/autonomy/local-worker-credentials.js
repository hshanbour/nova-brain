import {randomBytes} from "node:crypto";
import {execFile,spawn as spawnChild} from "node:child_process";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {promisify} from "node:util";

export const LOCAL_WORKER_CREDENTIALS=Object.freeze({
  nova:"NOVA_LOCAL_WORKER_TOKEN",
  vercel:"VERCEL_AUTOMATION_BYPASS",
});
const SCRIPT=fileURLToPath(new URL("../../scripts/windows-credential-store.ps1",import.meta.url));
const TARGET=name=>`NovaBrain/LocalWorker/${name}`;
const TYPE=name=>name===LOCAL_WORKER_CREDENTIALS.nova?"nova_worker":"vercel_bypass";
const exec=promisify(execFile),MAX_OUTPUT=8192;
const defaultKillTree=pid=>Number.isInteger(pid)?exec("taskkill.exe",["/PID",String(pid),"/T","/F"],{windowsHide:true,timeout:5000}).catch(()=>{}):Promise.resolve();
const defaultAlive=pid=>{if(!Number.isInteger(pid))return false;try{process.kill(pid,0);return true;}catch{return false;}};

export function createWindowsCredentialStore({platform=process.platform,spawn=spawnChild,killTree=defaultKillTree,isAlive=defaultAlive,environment=process.env,helperTimeoutMs=60000}={}){
  if(platform!=="win32")throw new Error("secure_os_store_unavailable");
  const executable=join(environment.SystemRoot||environment.WINDIR||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe");
  const invoke=(action,name,secret)=>new Promise((resolve,reject)=>{
    const startedAt=new Date().toISOString(),type=TYPE(name),child=spawn(executable,["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",SCRIPT,action,TARGET(name)],{windowsHide:true,stdio:[secret===undefined?"ignore":"pipe","pipe","pipe"]});
    let stdout=Buffer.alloc(0),stderrBytes=0,stage="process_start",settled=false,timer;
    const diagnostics=extra=>({source:"windows_credential_manager",credentialType:type,helperExecutable:executable,helperPid:child.pid||null,startedAt,stage,stdoutBytes:stdout.length,stderrBytes,...extra});
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const terminate=async()=>{await killTree(child.pid);await new Promise(done=>setTimeout(done,100));if(isAlive(child.pid))child.kill("SIGKILL");await new Promise(done=>setTimeout(done,100));return isAlive(child.pid);};
    child.stdout.on("data",async chunk=>{stdout=Buffer.concat([stdout,chunk]);if(stdout.length>MAX_OUTPUT){const alive=await terminate();finish(Object.assign(new Error("credential_helper_output_invalid"),{code:"credential_helper_output_invalid",safeDiagnostics:diagnostics({exitCode:child.exitCode,childAliveAfterTermination:alive})}));}});
    child.stderr.on("data",chunk=>{stderrBytes+=chunk.length;for(const match of String(chunk).matchAll(/NOVA_STAGE:([a-z_]+)/g)){const marker=match[1];if(["powershell_started","native_api_loaded","credential_api_read","credential_api_complete"].includes(marker))stage=marker;}});
    child.once("error",()=>finish(Object.assign(new Error("credential_helper_start_failed"),{code:"credential_helper_start_failed",safeDiagnostics:diagnostics({exitCode:null})})));
    child.once("close",code=>{const value=stdout.toString("utf8");if(code===3)return finish(Object.assign(new Error("credential_missing"),{code:"credential_missing",safeDiagnostics:diagnostics({exitCode:code})}));if(code!==0)return finish(Object.assign(new Error("secure_os_store_failed"),{code:"secure_os_store_failed",safeDiagnostics:diagnostics({exitCode:code})}));if(!value||value.length>MAX_OUTPUT||/[\r\n]/.test(value))return finish(Object.assign(new Error("credential_helper_output_invalid"),{code:"credential_helper_output_invalid",safeDiagnostics:diagnostics({exitCode:code})}));finish(null,value);});
    timer=setTimeout(async()=>{stage=`${stage}_timeout`;const alive=await terminate();finish(Object.assign(new Error("credential_helper_timeout"),{code:"credential_helper_timeout",safeDiagnostics:diagnostics({exitCode:child.exitCode,childAliveAfterTimeout:alive})}));},helperTimeoutMs);
    if(secret!==undefined)child.stdin.end(secret);
  });
  return Object.freeze({
    storage:"secure_os_store",
    async get(name){const value=await invoke("get",name);if(!value)throw Object.assign(new Error("credential_missing"),{code:"credential_missing"});return value;},
    async set(name,value){if(typeof value!=="string"||value.length<32)throw new Error("credential_invalid");await invoke("set",name,value);return{configured:true,storage:"secure_os_store"};},
    async delete(name){return{deleted:(await invoke("delete",name))==="deleted",storage:"secure_os_store"};},
    async status(name){return{configured:(await invoke("status",name))==="configured",storage:"secure_os_store"};},
  });
}

export async function loadLocalWorkerCredentials({environment=process.env,store=createWindowsCredentialStore(),onStage=async()=>{}}={}){
  const read=async(name,type,environmentValue)=>{if(environmentValue){await onStage({source:"process_environment",credentialType:type,stage:"loaded"});return environmentValue;}await onStage({source:"windows_credential_manager",credentialType:type,stage:"loading"});try{const value=await store.get(name);await onStage({source:"windows_credential_manager",credentialType:type,stage:"loaded"});return value;}catch(error){error.safeDiagnostics={...error.safeDiagnostics,source:"windows_credential_manager",credentialType:type,stage:error.safeDiagnostics?.stage||"credential_read",operation:"get"};throw error;}};
  const novaToken=await read(LOCAL_WORKER_CREDENTIALS.nova,"nova_worker",environment.NOVA_LOCAL_WORKER_TOKEN);
  const vercelBypassToken=await read(LOCAL_WORKER_CREDENTIALS.vercel,"vercel_bypass",environment.VERCEL_AUTOMATION_BYPASS_SECRET);
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
