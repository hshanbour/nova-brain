import {randomBytes} from "node:crypto";
import {execFile,spawn as spawnChild} from "node:child_process";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {promisify} from "node:util";
import {existsSync} from "node:fs";

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

export function createWindowsCredentialStore({platform=process.platform,spawn=spawnChild,killTree=defaultKillTree,isAlive=defaultAlive,exists=existsSync,environment=process.env,helperExecutable="",requireNativeHelper=false,helperTimeoutMs=60000}={}){
  if(platform!=="win32")throw new Error("secure_os_store_unavailable");
  const powershell=join(environment.SystemRoot||environment.WINDIR||"C:\\Windows","System32","WindowsPowerShell","v1.0","powershell.exe"),configured=typeof helperExecutable==="string"&&helperExecutable.length>0,native=configured&&/^[A-Za-z]:\\[^\r\n]+\.exe$/i.test(helperExecutable)&&exists(helperExecutable);if(requireNativeHelper&&!native)throw Object.assign(new Error("credential_native_helper_required"),{code:"credential_native_helper_required",safeDiagnostics:{source:"windows_credential_manager",credentialType:"credential_set",stage:"initializing",helperKind:"native",helperExecutable:configured?helperExecutable:null,nativeExists:configured&&exists(helperExecutable),selectionSource:"worker_cli",fallbackUsed:false}});const executable=native?helperExecutable:powershell;
  const invoke=(action,name,secret,secondName)=>new Promise((resolve,reject)=>{
    const args=native?[action,TARGET(name)]:["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",SCRIPT,action,TARGET(name)];if(secondName)args.push(TARGET(secondName));
    const startedAt=new Date().toISOString(),type=secondName?"credential_set":TYPE(name);let child;
    try{child=spawn(executable,args,{windowsHide:true,shell:false,stdio:[secret===undefined?"ignore":"pipe","pipe","pipe"]});}catch(error){return reject(Object.assign(new Error("credential_helper_start_failed"),{code:"credential_helper_start_failed",cause:error,safeDiagnostics:{source:"windows_credential_manager",credentialType:type,helperExecutable:executable,helperKind:native?"native":"powershell",helperScriptPath:native?null:SCRIPT,helperArgvShape:native?["action","target",...(secondName?["target"]:[])]:["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","policy","-File","script","action","target",...(secondName?["target"]:[])],helperPid:null,startedAt,stage:"process_start",stdoutBytes:0,stderrBytes:0,exitCode:null,errno:error?.code||null}}));}
    let stdout=Buffer.alloc(0),stderrBytes=0,stage="process_start",safeError=null,settled=false,timingOut=false,timer;
    const diagnostics=extra=>({source:"windows_credential_manager",credentialType:type,helperExecutable:executable,helperKind:native?"native":"powershell",helperScriptPath:native?null:SCRIPT,helperArgvShape:native?["action","target",...(secondName?["target"]:[])]:["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","policy","-File","script","action","target",...(secondName?["target"]:[])],helperPid:child.pid||null,startedAt,stage,stdoutBytes:stdout.length,stderrBytes,...extra});
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
    const terminate=async()=>{await killTree(child.pid);await new Promise(done=>setTimeout(done,100));if(isAlive(child.pid))child.kill("SIGKILL");await new Promise(done=>setTimeout(done,100));return isAlive(child.pid);};
    child.stdout.on("data",async chunk=>{stdout=Buffer.concat([stdout,chunk]);if(stdout.length>MAX_OUTPUT){const alive=await terminate();finish(Object.assign(new Error("credential_helper_output_invalid"),{code:"credential_helper_output_invalid",safeDiagnostics:diagnostics({exitCode:child.exitCode,childAliveAfterTermination:alive})}));}});
    child.stderr.on("data",chunk=>{stderrBytes+=chunk.length;const text=String(chunk);for(const match of text.matchAll(/NOVA_STAGE:([a-z_]+)/g)){const marker=match[1];if(["script_started","powershell_started","native_api_loading","native_api_loaded","credread_start","credential_api_read","credread_complete","credential_api_complete","output_complete"].includes(marker))stage=marker;}for(const match of text.matchAll(/NOVA_ERROR:([a-z_]+)/g))safeError=match[1];});
    child.once("error",()=>finish(Object.assign(new Error("credential_helper_start_failed"),{code:"credential_helper_start_failed",safeDiagnostics:diagnostics({exitCode:null})})));
    child.once("close",code=>{if(timingOut)return;const value=stdout.toString("utf8");if(code===3)return finish(Object.assign(new Error("credential_missing"),{code:"credential_missing",safeDiagnostics:diagnostics({exitCode:code})}));if(code!==0){const failure=safeError==="invalid_arguments"?"credential_helper_arguments_invalid":safeError==="parameter_binding_failed"?"credential_helper_parameter_binding_failed":safeError==="credential_read_failed"?"credential_read_failed":safeError==="add_type_failed"||stage==="native_api_loading"||stage==="powershell_started"?"credential_native_api_load_failed":stage==="process_start"?"credential_helper_script_not_entered":"credential_helper_process_failed";return finish(Object.assign(new Error(failure),{code:failure,safeDiagnostics:diagnostics({exitCode:code})}));}if(!value||value.length>MAX_OUTPUT||/[\r\n]/.test(value))return finish(Object.assign(new Error("credential_helper_output_invalid"),{code:"credential_helper_output_invalid",safeDiagnostics:diagnostics({exitCode:code})}));finish(null,value);});
    timer=setTimeout(async()=>{timingOut=true;stage=`${stage}_timeout`;const alive=await terminate();finish(Object.assign(new Error("credential_helper_timeout"),{code:"credential_helper_timeout",safeDiagnostics:diagnostics({exitCode:child.exitCode,childAliveAfterTimeout:alive})}));},helperTimeoutMs);
    if(secret!==undefined)child.stdin.end(secret);
  });
  return Object.freeze({
    storage:"secure_os_store",
    helper:Object.freeze({kind:native?"native":"powershell",executable,selectionSource:native?"worker_cli":"management_fallback",nativeExists:native,fallbackUsed:!native}),
    async get(name){const value=await invoke("get",name);if(!value)throw Object.assign(new Error("credential_missing"),{code:"credential_missing"});return value;},
    async getPair(firstName,secondName){const value=await invoke("get-pair",firstName,undefined,secondName);let encoded;try{encoded=JSON.parse(value);}catch{throw Object.assign(new Error("credential_helper_output_invalid"),{code:"credential_helper_output_invalid"});}if(!Array.isArray(encoded)||encoded.length!==2||encoded.some(item=>typeof item!=="string"||!/^[A-Za-z0-9+/]+={0,2}$/.test(item)))throw Object.assign(new Error("credential_helper_output_invalid"),{code:"credential_helper_output_invalid"});return encoded.map(item=>Buffer.from(item,"base64").toString("utf8"));},
    async set(name,value){if(typeof value!=="string"||value.length<32)throw new Error("credential_invalid");await invoke("set",name,value);return{configured:true,storage:"secure_os_store"};},
    async delete(name){return{deleted:(await invoke("delete",name))==="deleted",storage:"secure_os_store"};},
    async status(name){return{configured:(await invoke("status",name))==="configured",storage:"secure_os_store"};},
  });
}

export async function loadLocalWorkerCredentials({environment=process.env,store=createWindowsCredentialStore(),onStage=async()=>{}}={}){
  if(!environment.NOVA_LOCAL_WORKER_TOKEN&&!environment.VERCEL_AUTOMATION_BYPASS_SECRET&&typeof store.getPair==="function"){await onStage({source:"windows_credential_manager",credentialType:"credential_set",stage:"loading"});try{const[novaToken,vercelBypassToken]=await store.getPair(LOCAL_WORKER_CREDENTIALS.nova,LOCAL_WORKER_CREDENTIALS.vercel);await onStage({source:"windows_credential_manager",credentialType:"credential_set",stage:"loaded"});if(novaToken===vercelBypassToken)throw new Error("credentials_must_remain_separate");return{novaToken,vercelBypassToken,clear(){this.novaToken=null;this.vercelBypassToken=null;}};}catch(error){error.safeDiagnostics={...error.safeDiagnostics,source:"windows_credential_manager",credentialType:"credential_set",stage:error.safeDiagnostics?.stage||"credential_read",operation:"get-pair"};throw error;}}
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
