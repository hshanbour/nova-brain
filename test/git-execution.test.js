import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,rm,realpath} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolveGitExecutable,createGitExecutor} from "../src/tools/git-execution.js";
import {resolveRepositoryContext} from "../src/tools/repository-context.js";

const run=promisify(execFile),BRANCH="feat/nova-brain-mvp-foundation";
async function repository(){const root=await mkdtemp(join(tmpdir(),"nova-git-proof-")),git=await resolveGitExecutable();await writeFile(join(root,"package.json"),'{"name":"nova-brain"}\n');await run(git,["init","-b",BRANCH],{cwd:root,windowsHide:true});await run(git,["config","user.email","test@example.com"],{cwd:root,windowsHide:true});await run(git,["config","user.name","Test"],{cwd:root,windowsHide:true});await run(git,["add","package.json"],{cwd:root,windowsHide:true});await run(git,["commit","-m","initial"],{cwd:root,windowsHide:true});return{root,git};}

test("canonical Git executor survives Scheduled Task-like PATH and cwd",async t=>{const f=await repository();t.after(()=>rm(f.root,{recursive:true,force:true}));const executor=createGitExecutor({executable:f.git,environment:{PATH:"",USERPROFILE:process.env.USERPROFILE}}),head=(await executor(f.root,["rev-parse","HEAD"])).stdout.trim(),proof=await resolveRepositoryContext({root:f.root,git:executor,expectedBranch:BRANCH,expectedHead:head});assert.equal(proof.proven,true);assert.equal(proof.actualHead,head);assert.equal(proof.actualBranch,BRANCH);assert.equal(proof.root,await realpath(f.root));});

test("Git executor is direct hidden bounded and strips repository overrides",async()=>{let observed;const executable=process.platform==="win32"?"C:/trusted/git.exe":"/usr/bin/git",executor=createGitExecutor({executable,environment:{PATH:"",GIT_DIR:"bad",GIT_WORK_TREE:"bad",USERPROFILE:"C:/Users/owner"},runner:async(file,args,options)=>{observed={file,args,options};return{stdout:"ok",stderr:""};}}),result=await executor(resolve("controlled"),["rev-parse","HEAD"]);assert.equal(result.exitCode,0);assert.equal(observed.file,resolve(executable));assert.equal(observed.options.cwd,resolve("controlled"));assert.equal(observed.options.windowsHide,true);assert.equal(observed.options.shell,false);assert.equal(observed.options.env.GIT_DIR,undefined);assert.equal(observed.options.env.GIT_WORK_TREE,undefined);assert.match(observed.args[1],/^safe\.directory=/);assert.equal(result.diagnostics.environment.pathPresent,false);assert.equal(result.diagnostics.environment.userProfilePresent,true);assert.equal(result.diagnostics.environment.gitDirPresent,false);assert.equal(result.diagnostics.safeDirectory,"exact_root");});

test("missing executable and safe-directory rejection fail with structured codes",async()=>{await assert.rejects(()=>resolveGitExecutable({explicit:"C:/missing/git.exe",candidates:[]}),error=>error.code==="git_executable_missing");const executable=process.platform==="win32"?"C:/trusted/git.exe":"/usr/bin/git",executor=createGitExecutor({executable,runner:async()=>{throw Object.assign(new Error("dubious ownership; add safe.directory"),{stderr:"fatal: detected dubious ownership"});}}),result=await executor(resolve("controlled"),["rev-parse","HEAD"]);assert.equal(result.errorCode,"git_safe_directory_rejected");});

test("detached HEAD is rejected distinctly",async t=>{const f=await repository();t.after(()=>rm(f.root,{recursive:true,force:true}));const executor=createGitExecutor({executable:f.git}),head=(await executor(f.root,["rev-parse","HEAD"])).stdout.trim();await executor(f.root,["checkout","--detach",head]);await assert.rejects(()=>resolveRepositoryContext({root:f.root,git:executor,expectedBranch:BRANCH,expectedHead:head}),error=>error.code==="git_detached_head");});
