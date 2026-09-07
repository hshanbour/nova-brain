import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {isAbsolute,basename,delimiter,join,resolve} from "node:path";
import {access,realpath} from "node:fs/promises";

const exec=promisify(execFile),GIT_NAME=/^git(?:\.exe)?$/i;
const safeEnvironment=environment=>{
  const value={...environment,GIT_TERMINAL_PROMPT:"0",GCM_INTERACTIVE:"Never"};
  delete value.GIT_DIR;delete value.GIT_WORK_TREE;
  return value;
};
const executableCandidates=environment=>{
  const pathEntries=String(environment.PATH||environment.Path||"").split(delimiter).filter(Boolean).map(path=>join(path,process.platform==="win32"?"git.exe":"git"));
  const windows=process.platform==="win32"?[join(environment.ProgramFiles||"C:/Program Files","Git/cmd/git.exe"),join(environment.LOCALAPPDATA||"","Programs/Git/cmd/git.exe")]:["/usr/bin/git","/usr/local/bin/git"];
  return [...pathEntries,...windows];
};
export async function resolveGitExecutable({explicit,environment=process.env,candidates}={}){
  const values=[explicit,...(candidates||executableCandidates(environment))].filter(Boolean);
  for(const value of values){if(!isAbsolute(value)||!GIT_NAME.test(basename(value)))continue;try{await access(value);return realpath(value);}catch{}}
  throw Object.assign(new Error("A validated Git executable is unavailable."),{code:"git_executable_missing"});
}
const classify=error=>{
  const stderr=String(error?.stderr||error?.message||"");
  if(error?.code==="ENOENT")return "git_executable_missing";
  if(/dubious ownership|safe\.directory/i.test(stderr))return "git_safe_directory_rejected";
  return "git_spawn_failed";
};
export function createGitExecutor({executable,environment=process.env,runner=exec}={}){
  if(!isAbsolute(executable||"")||!GIT_NAME.test(basename(executable)))throw Object.assign(new Error("A validated absolute Git executable is required."),{code:"git_executable_missing"});
  const file=resolve(executable),env=safeEnvironment(environment),environmentProof={identity:String(environment.USERNAME||environment.USER||"").slice(0,80)||null,pathPresent:Boolean(environment.PATH||environment.Path),homePresent:Boolean(environment.HOME),userProfilePresent:Boolean(environment.USERPROFILE),gitDirPresent:Boolean(env.GIT_DIR),gitWorkTreePresent:Boolean(env.GIT_WORK_TREE)};
  return async(root,args)=>{const cwd=resolve(root),argv=["-c",`safe.directory=${cwd.replaceAll("\\","/")}`,...args],started=Date.now(),diagnostics={gitExecutable:file,spawnExecutable:file,cwd,argv,windowsHide:true,shell:false,safeDirectory:"exact_root",environment:environmentProof};try{const result=await runner(file,argv,{cwd,env,windowsHide:true,shell:false,timeout:30000,maxBuffer:500000});return{exitCode:0,stdout:String(result.stdout||""),stderr:String(result.stderr||""),durationMs:Date.now()-started,diagnostics};}catch(error){return{exitCode:Number.isInteger(error.code)?error.code:1,stdout:String(error.stdout||""),stderr:String(error.stderr||error.message||""),durationMs:Date.now()-started,errorCode:classify(error),diagnostics};}};
}
