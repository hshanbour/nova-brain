import {runPersistentWorkerService} from "../src/autonomy/persistent-worker-startup.js";
import {writePersistentWorkerStatus} from "../src/autonomy/persistent-worker-process.js";
import {fileURLToPath} from "node:url";
import {resolve,dirname} from "node:path";
import {resolveGitExecutable,createGitExecutor} from "../src/tools/git-execution.js";
import {resolveRepositoryContext} from "../src/tools/repository-context.js";

const urlIndex=process.argv.indexOf("--preview-url"),argumentUrl=urlIndex>=0?process.argv[urlIndex+1]:"";
const gitIndex=process.argv.indexOf("--git-executable"),gitArgument=gitIndex>=0?process.argv[gitIndex+1]:"";
const base=(argumentUrl||process.env.NOVA_LOCAL_WORKER_URL||"").replace(/\/$/,"");
const interval=Math.max(1000,Math.min(60000,Number(process.env.NOVA_WORKER_POLL_MS)||5000));
const probeOnly=process.argv.includes("--probe-only");let stopping=false;
const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),"..");
process.on("SIGINT",()=>{stopping=true;});process.on("SIGTERM",()=>{stopping=true;});
const fatal=async error=>{await writePersistentWorkerStatus({state:"fatal",code:error?.code||error?.name||"unexpected_error",version:process.env.NOVA_WORKER_VERSION||"local"}).catch(()=>{});process.exit(1);};process.once("uncaughtException",fatal);process.once("unhandledRejection",fatal);
const gitExecutable=await resolveGitExecutable({explicit:gitArgument});process.env.NOVA_BRAIN_GIT_EXECUTABLE=gitExecutable;
const repositoryProof=await resolveRepositoryContext({root:repositoryRoot,expectedRepository:"hshanbour/nova-brain",expectedBranch:"feat/nova-brain-mvp-foundation",source:"persistent_worker_startup",git:createGitExecutor({executable:gitExecutable})});
await runPersistentWorkerService({baseUrl:base,repositoryRoot,intervalMs:interval,version:process.env.NOVA_WORKER_VERSION||"local",startupMetadata:{repositoryProof:{proven:true,contextVersion:repositoryProof.version,root:repositoryProof.root,repository:repositoryProof.repository,branch:repositoryProof.actualBranch,head:repositoryProof.actualHead,gitLayout:repositoryProof.gitLayout}},probeOnly,maxIterations:probeOnly?3:Infinity,shouldStop:()=>stopping});
