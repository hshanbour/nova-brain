import { realpath, stat, readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";

const SHA=/^[a-f0-9]{40}$/;
const cleanPath=value=>resolve(String(value||""));
export const REPOSITORY_CONTEXT_VERSION=1;
const normalize=value=>String(value||"").trim().replaceAll("\\","/").replace(/\/?\.git\/?$/i,"").replace(/\/$/,"");
const githubIdentity=value=>{
  const normalized=normalize(value),match=normalized.match(/(?:github\.com[/:])([^/]+)\/([^/]+)$/i);
  return match?`${match[1]}/${match[2]}`:null;
};
const localRemote=value=>{
  const normalized=String(value||"").trim().replace(/[/\\]\.$/,"");
  if(!normalized||/^[a-z]+:\/\//i.test(normalized)||/^[^/\\]+@[^:]+:/i.test(normalized))return null;
  return isAbsolute(normalized)?normalized:null;
};

export async function resolveRepositoryContext({root,git,expectedRepository="hshanbour/nova-brain",expectedBranch,expectedHead,requireClean=false,source="local_verification"}={}){
  if(!root||typeof git!=="function")throw Object.assign(new Error("Controlled repository root is required."),{code:"repository_context_unproven"});
  let resolvedRoot;
  try{resolvedRoot=await realpath(cleanPath(root));}catch{throw Object.assign(new Error("Controlled repository root cannot be resolved."),{code:"repository_context_unproven"});}
  const [top,head,status,gitPath,remote,branch]=await Promise.all([
    git(resolvedRoot,["rev-parse","--show-toplevel"]),git(resolvedRoot,["rev-parse","HEAD"]),git(resolvedRoot,["status","--porcelain=v1"]),git(resolvedRoot,["rev-parse","--git-dir"]),git(resolvedRoot,["remote","get-url","origin"]),git(resolvedRoot,["symbolic-ref","--short","HEAD"]),
  ]);
  let resolvedTop;try{resolvedTop=await realpath(cleanPath(top.stdout.trim()));}catch{resolvedTop="";}
  let packageName="";try{packageName=JSON.parse(await readFile(resolve(resolvedRoot,"package.json"),"utf8")).name||"";}catch{}
  let repositoryIdentity=githubIdentity(remote.stdout),identitySource=repositoryIdentity?"origin":"package";
  const upstreamRoot=localRemote(remote.stdout);
  if(!repositoryIdentity&&upstreamRoot){
    try{const resolvedUpstream=await realpath(cleanPath(upstreamRoot)),upstream=await git(resolvedUpstream,["remote","get-url","origin"]);repositoryIdentity=githubIdentity(upstream.stdout);if(repositoryIdentity)identitySource="local_upstream_origin";}catch{}
  }
  if(!repositoryIdentity&&!String(remote.stdout||"").trim()&&packageName==="nova-brain")repositoryIdentity=expectedRepository;
  const actualHead=head.stdout.trim(),actualBranch=branch.stdout.trim(),clean=!status.stdout.trim();
  const failedCommand=[["top_level",top],["head",head],["status",status],["git_dir",gitPath],["branch",branch]].find(([,result])=>result.exitCode),branchFailure=String(branch.stderr||branch.stdout||"").trim(),detached=branch.exitCode&&head.exitCode===0&&(!branchFailure||/not a symbolic ref|detached head/i.test(branchFailure));
  const failureCode=detached?"git_detached_head":failedCommand?.[1]?.errorCode||(!top.exitCode&&resolvedTop!==resolvedRoot?"git_repo_unavailable":head.exitCode?"git_head_resolution_failed":branch.exitCode?"git_branch_resolution_failed":"repository_context_unproven");
  const diagnostics={contextVersion:REPOSITORY_CONTEXT_VERSION,contextSource:source,verificationStage:"local_git_proof",root:resolvedRoot,gitTopLevel:resolvedTop||null,expectedRepository,actualRepository:repositoryIdentity||null,actualHead:SHA.test(actualHead)?actualHead:null,taskCurrentCommit:expectedHead||null,expectedBranch:expectedBranch||null,actualBranch:actualBranch||null,clean,identitySource,gitExecutable:top.diagnostics?.gitExecutable||null,failedCommand:failedCommand?.[0]||null,gitExitCode:failedCommand?.[1]?.exitCode??0,gitFailureCode:failureCode,safeFailureCode:failureCode};
  if(top.exitCode||head.exitCode||status.exitCode||gitPath.exitCode||branch.exitCode||resolvedTop!==resolvedRoot||repositoryIdentity!==expectedRepository||(expectedBranch&&actualBranch!==expectedBranch))throw Object.assign(new Error("Controlled repository identity cannot be proven."),{code:failureCode,safeDiagnostics:diagnostics});
  let gitLayout="directory";try{gitLayout=(await stat(resolve(resolvedRoot,".git"))).isDirectory()?"directory":"gitfile";}catch{gitLayout="gitfile";}
  return Object.freeze({...diagnostics,version:REPOSITORY_CONTEXT_VERSION,root:resolvedRoot,workingDirectory:resolvedRoot,gitTopLevel:resolvedTop,actualHead:SHA.test(actualHead)?actualHead:null,clean,gitLayout,isWorktree:gitLayout==="gitfile",repository:expectedRepository,proven:true});
}
