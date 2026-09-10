import {runPersistentWorkerService} from "../src/autonomy/persistent-worker-startup.js";
import {writePersistentWorkerStatus} from "../src/autonomy/persistent-worker-process.js";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";
import {resolveGitExecutable,createGitExecutor} from "../src/tools/git-execution.js";
import {resolveRepositoryContext} from "../src/tools/repository-context.js";
import {createWindowsCredentialStore,loadLocalWorkerCredentials} from "../src/autonomy/local-worker-credentials.js";
import {parsePersistentWorkerArguments} from "../src/autonomy/persistent-worker-cli.js";

const {previewUrl:argumentUrl,gitExecutable:gitArgument,credentialHelper,repositoryRoot:repositoryArgument,runtimeVersion,verifyRuntime,probeOnly}=parsePersistentWorkerArguments();
const base=(argumentUrl||process.env.NOVA_LOCAL_WORKER_URL||"").replace(/\/$/,"");
const interval=Math.max(1000,Math.min(60000,Number(process.env.NOVA_WORKER_POLL_MS)||5000));
let stopping=false;
const runtimeScriptPath=fileURLToPath(import.meta.url);
const repositoryRoot=repositoryArgument?resolve(repositoryArgument):resolve(dirname(runtimeScriptPath),"..");
if(verifyRuntime){
  if(!runtimeVersion||!repositoryArgument)throw Object.assign(new Error("Runtime verification requires explicit immutable bindings."),{code:"worker_runtime_binding_required"});
  process.stdout.write(JSON.stringify({ok:true,runtimeVersion,runtimeScriptPath,repositoryRoot}));
  process.exit(0);
}
process.on("SIGINT",()=>{stopping=true;});process.on("SIGTERM",()=>{stopping=true;});
const fatal=async error=>{const diagnostic=error?.safeDiagnostics||{};await writePersistentWorkerStatus({state:"fatal",code:error?.code||error?.name||"unexpected_error",version:process.env.NOVA_WORKER_VERSION||"local",startupStage:diagnostic.startupStage,failureOperation:diagnostic.failureOperation,failurePathKind:diagnostic.failurePathKind,failurePath:diagnostic.failurePath,pathExisted:diagnostic.pathExisted,cwd:diagnostic.cwd,nodeExecutable:diagnostic.nodeExecutable,gitExecutable:diagnostic.gitExecutable}).catch(()=>{});process.exit(1);};process.once("uncaughtException",fatal);process.once("unhandledRejection",fatal);
const gitExecutable=await resolveGitExecutable({explicit:gitArgument});process.env.NOVA_BRAIN_GIT_EXECUTABLE=gitExecutable;
const repositoryProof=await resolveRepositoryContext({root:repositoryRoot,expectedRepository:"hshanbour/nova-brain",expectedBranch:"feat/nova-brain-mvp-foundation",source:"persistent_worker_startup",git:createGitExecutor({executable:gitExecutable})});
const credentialStore=createWindowsCredentialStore({helperExecutable:credentialHelper,requireNativeHelper:true});
await runPersistentWorkerService({baseUrl:base,repositoryRoot,intervalMs:interval,version:runtimeVersion||process.env.NOVA_WORKER_VERSION||"local",startupMetadata:{runtimeVersion:runtimeVersion||null,runtimeScriptPath,repositoryProof:{proven:true,contextVersion:repositoryProof.version,root:repositoryProof.root,repository:repositoryProof.repository,branch:repositoryProof.actualBranch,head:repositoryProof.actualHead,gitLayout:repositoryProof.gitLayout},startupStage:"repository_proof",cwd:repositoryProof.root,nodeExecutable:process.execPath,gitExecutable,credentialHelperExecutable:credentialStore.helper.executable,credentialHelperKind:credentialStore.helper.kind,credentialHelperSelectionSource:credentialStore.helper.selectionSource,credentialHelperNativeExists:credentialStore.helper.nativeExists,credentialHelperFallbackUsed:credentialStore.helper.fallbackUsed},credentialLoader:options=>loadLocalWorkerCredentials({...options,store:credentialStore}),probeOnly,maxIterations:probeOnly?3:Infinity,shouldStop:()=>stopping});
