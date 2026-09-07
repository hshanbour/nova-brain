import { realpath, stat, readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";

const SHA=/^[a-f0-9]{40}$/;
const cleanPath=value=>resolve(String(value||""));

export async function resolveRepositoryContext({root,git,expectedRepository="hshanbour/nova-brain"}={}){
  if(!root||typeof git!=="function")throw Object.assign(new Error("Controlled repository root is required."),{code:"repository_context_unproven"});
  let resolvedRoot;
  try{resolvedRoot=await realpath(cleanPath(root));}catch{throw Object.assign(new Error("Controlled repository root cannot be resolved."),{code:"repository_context_unproven"});}
  const [top,head,status,gitPath,remote]=await Promise.all([
    git(resolvedRoot,["rev-parse","--show-toplevel"]),git(resolvedRoot,["rev-parse","HEAD"]),git(resolvedRoot,["status","--porcelain=v1"]),git(resolvedRoot,["rev-parse","--git-dir"]),git(resolvedRoot,["remote","get-url","origin"]),
  ]);
  let resolvedTop;try{resolvedTop=await realpath(cleanPath(top.stdout.trim()));}catch{resolvedTop="";}
  let packageName="";try{packageName=JSON.parse(await readFile(resolve(resolvedRoot,"package.json"),"utf8")).name||"";}catch{}
  const remoteName=String(remote.stdout||"").replaceAll("\\","/").replace(/\/?\.git\/?$/i,"").split("/").filter(Boolean).at(-1)||"";
  if(top.exitCode||head.exitCode||status.exitCode||gitPath.exitCode||resolvedTop!==resolvedRoot||(packageName&&packageName!=="nova-brain")||(remoteName&&remoteName!==expectedRepository.split("/").at(-1)))throw Object.assign(new Error("Controlled repository identity cannot be proven."),{code:"repository_context_unproven",safeDiagnostics:{root:resolvedRoot,gitTopLevel:resolvedTop||null,packageName:packageName||null,remoteName:remoteName||null}});
  let gitLayout="directory";try{gitLayout=(await stat(resolve(resolvedRoot,".git"))).isDirectory()?"directory":"gitfile";}catch{gitLayout="gitfile";}
  const actualHead=head.stdout.trim();
  return Object.freeze({root:resolvedRoot,workingDirectory:resolvedRoot,gitTopLevel:resolvedTop,actualHead:SHA.test(actualHead)?actualHead:null,clean:!status.stdout.trim(),gitLayout,isWorktree:gitLayout==="gitfile",repository:expectedRepository});
}
