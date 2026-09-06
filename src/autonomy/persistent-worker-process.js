import {mkdir,open,readFile,rm,writeFile} from "node:fs/promises";
import {dirname,join} from "node:path";

const safeState=value=>({state:String(value.state||"unknown").slice(0,40),code:value.code?String(value.code).slice(0,80):null,taskId:value.taskId?String(value.taskId).slice(0,100):null,status:value.status?String(value.status).slice(0,40):null,pid:process.pid,updatedAt:new Date().toISOString()});
export function persistentWorkerPaths({environment=process.env}={}){const root=environment.LOCALAPPDATA||environment.TEMP;if(!root)throw new Error("persistent_worker_state_unavailable");const dir=join(root,"NovaBrain","PersistentWorker");return{dir,lock:join(dir,"worker.lock"),status:join(dir,"status.json")};}
export async function acquirePersistentWorkerInstance({paths=persistentWorkerPaths(),pid=process.pid,isAlive=value=>{try{process.kill(value,0);return true;}catch{return false;}}}={}){
  await mkdir(paths.dir,{recursive:true});try{const handle=await open(paths.lock,"wx");await handle.writeFile(String(pid));await handle.close();return{acquired:true,async release(){await rm(paths.lock,{force:true});}};}catch(error){if(error.code!=="EEXIST")throw error;const prior=Number(await readFile(paths.lock,"utf8").catch(()=>"0"));if(prior>0&&isAlive(prior))return{acquired:false,async release(){}};await rm(paths.lock,{force:true});return acquirePersistentWorkerInstance({paths,pid,isAlive});}
}
export async function writePersistentWorkerStatus(value,{paths=persistentWorkerPaths()}={}){await mkdir(dirname(paths.status),{recursive:true});await writeFile(paths.status,JSON.stringify(safeState(value)),"utf8");}
