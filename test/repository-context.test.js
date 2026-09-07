import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {createToolRegistry} from "../src/tools/tool-registry.js";
import {registerHandsTools} from "../src/tools/hands-runtime.js";
const run=promisify(execFile),BRANCH="feat/nova-brain-mvp-foundation";
async function repo(packageName="nova-brain"){const root=await mkdtemp(join(tmpdir(),"nova-context-"));await writeFile(join(root,"package.json"),JSON.stringify({name:packageName}));await writeFile(join(root,"file.txt"),"before\n");await run("git",["init","-b",BRANCH],{cwd:root});await run("git",["config","user.name","Nova Test"],{cwd:root});await run("git",["config","user.email","nova@example.invalid"],{cwd:root});await run("git",["add","."],{cwd:root});await run("git",["commit","-m","initial"],{cwd:root});return root;}
test("explicit controlled root survives unrelated process cwd and verifies before mutation",async t=>{const root=await repo();t.after(()=>rm(root,{recursive:true,force:true}));const sha=(await run("git",["rev-parse","HEAD"],{cwd:root})).stdout.trim(),registry=createToolRegistry();registerHandsTools(registry,{root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:BRANCH}});await registry.execute("repo_apply_patch",{branch:BRANCH,currentCommit:sha,files:[{path:"file.txt",operation:"replace",expectedContent:"before\n",content:"after\n"}]});assert.equal(await readFile(join(root,"file.txt"),"utf8"),"after\n");});
test("wrong HEAD and wrong repository identity fail closed before mutation",async t=>{for(const packageName of ["nova-brain","other-repo"]){const root=await repo(packageName);t.after(()=>rm(root,{recursive:true,force:true}));const registry=createToolRegistry();registerHandsTools(registry,{root,environment:{NOVA_BRAIN_DEVELOPMENT_BRANCH:BRANCH}});await assert.rejects(()=>registry.execute("repo_apply_patch",{branch:BRANCH,currentCommit:"f".repeat(40),files:[{path:"file.txt",operation:"replace",expectedContent:"before\n",content:"after\n"}]}),error=>["commit_mismatch","repository_context_unproven"].includes(error.code));assert.equal(await readFile(join(root,"file.txt"),"utf8"),"before\n");}});
