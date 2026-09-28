import test from "node:test";
import assert from "node:assert/strict";
import {createVercelPreviewClient,resolveVercelPreviewBinding} from "../src/deployment/vercel-preview-client.js";

const SHA="7c67e3bc013de32db062033e31a7f7d9bc33b465",BRANCH="feat/nova-brain-mvp-foundation",PROJECT="prj_FEoDvOYoElPvvheSvc66GjdRQZ42",TEAM="team_MGjtLwfuGRigo1dqRCAXsgbU";
const environment={NOVA_BRAIN_VERCEL_TOKEN:"credential-not-for-diagnostics",VERCEL_PROJECT_ID:PROJECT,VERCEL_TEAM_ID:TEAM};
const response=(status,value)=>({ok:status>=200&&status<300,status,async json(){return value;}});
const deployment=(patch={})=>({uid:"dpl_9MDHHzQnuHdkW17hgcYC3kvBqY6q",url:"nova-test-project-l3u602l3u-hamodehshanbour-6196.vercel.app",readyState:"READY",target:null,meta:{githubCommitSha:SHA,githubCommitRef:BRANCH},...patch});

test("Vercel discovery is team scoped and selects only the exact Preview source",async()=>{
  const requests=[],client=createVercelPreviewClient({environment,fetchImpl:async(url,options)=>{requests.push({url,options});return response(200,{deployments:[deployment(),deployment({uid:"wrong",meta:{githubCommitSha:"a".repeat(40),githubCommitRef:BRANCH}}),deployment({uid:"production",target:"production"})]});}}),found=await client.findPreview({commitSha:SHA,branch:BRANCH});
  assert.equal(found.id,"dpl_9MDHHzQnuHdkW17hgcYC3kvBqY6q");
  const url=new URL(requests[0].url);assert.equal(url.searchParams.get("projectId"),PROJECT);assert.equal(url.searchParams.get("teamId"),TEAM);assert.equal(url.searchParams.get("sha"),SHA);assert.equal(url.searchParams.get("branch"),BRANCH);assert.equal(url.searchParams.get("target"),"preview");assert.equal(requests[0].options.headers.Authorization,`Bearer ${environment.NOVA_BRAIN_VERCEL_TOKEN}`);
});

test("wrong project, team, commit, and branch fail closed",async()=>{
  assert.throws(()=>resolveVercelPreviewBinding({...environment,NOVA_BRAIN_VERCEL_PROJECT_ID:"prj_wrong"}),error=>error.code==="deployment_discovery_not_configured"&&error.safeDiagnostics.projectBindingMatch===false);
  assert.throws(()=>resolveVercelPreviewBinding({...environment,NOVA_BRAIN_VERCEL_TEAM_ID:"team_wrong"}),error=>error.code==="deployment_discovery_not_configured"&&error.safeDiagnostics.teamBindingMatch===false);
  const client=createVercelPreviewClient({environment,fetchImpl:async()=>response(200,{deployments:[deployment()]})});
  assert.equal(await client.findPreview({commitSha:"b".repeat(40),branch:BRANCH}),null);assert.equal(await client.findPreview({commitSha:SHA,branch:"wrong"}),null);
});

test("discovery failures retain only bounded safe provider diagnostics",async()=>{
  const secret="sensitive-value",client=createVercelPreviewClient({environment:{...environment,NOVA_BRAIN_VERCEL_TOKEN:secret},fetchImpl:async()=>response(403,{error:{code:"forbidden",message:`token=${secret}\nnot authorized ${"x".repeat(300)}`},unrestricted:{credential:secret}})});
  await assert.rejects(()=>client.findPreview({commitSha:SHA,branch:BRANCH}),error=>{assert.equal(error.code,"deployment_discovery_failed");assert.equal(error.retryable,false);assert.deepEqual(Object.keys(error.safeDiagnostics).sort(),["projectBindingMatch","providerError","providerErrorCode","stage","teamBindingMatch","upstreamStatus"].sort());assert.equal(error.safeDiagnostics.upstreamStatus,403);assert.equal(error.safeDiagnostics.providerErrorCode,"forbidden");assert.ok(error.safeDiagnostics.providerError.length<=160);assert.doesNotMatch(JSON.stringify(error.safeDiagnostics),new RegExp(secret));return true;});
});

test("deployment verification uses the same exact team binding",async()=>{
  let requested;const client=createVercelPreviewClient({environment,fetchImpl:async url=>{requested=new URL(url);return response(200,deployment());}}),found=await client.verifyDeployment({deploymentId:"dpl_9MDHHzQnuHdkW17hgcYC3kvBqY6q"});
  assert.equal(requested.searchParams.get("teamId"),TEAM);assert.equal(found.sha,SHA);assert.equal(found.branch,BRANCH);
});
