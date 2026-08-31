import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import { INITIAL_OWNER_PROFILE, INITIAL_PROJECTS, OWNER_ID } from "../src/identity/initial-context.js";
import { createActionPolicy, ApprovalRequiredError, RISK_LEVELS } from "../src/policy/action-policy.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { registerDeveloperTools, registerSystemTools } from "../src/tools/developer-tools.js";
import { createOpenAIModelProvider, toolDefinition } from "../src/providers/openai-model-provider.js";

async function foundation() { const storage=createInMemoryStorage();await storage.initialize({owner:INITIAL_OWNER_PROFILE,projects:INITIAL_PROJECTS});const policy=createActionPolicy({storage,ownerId:OWNER_ID,approvedBranch:"feat/nova-brain-mvp-foundation"});return {storage,registry:createToolRegistry({policy})}; }

test("execution runs, project association, and activity persist newest-first",async()=>{const {storage}=await foundation();const run=await storage.createRun({ownerId:OWNER_ID,projectId:"nova-brain",goal:"Inspect Nova"});await storage.appendActivity({ownerId:OWNER_ID,projectId:"nova-brain",runId:run.id,action:"repository_inspected",status:"completed",summary:"Inspected repository."});await storage.updateRun(run.id,OWNER_ID,{status:"completed",currentStep:1});assert.equal((await storage.listRuns(OWNER_ID,{projectId:"nova-brain"}))[0].status,"completed");assert.equal((await storage.listActivity(OWNER_ID,{runId:run.id}))[0].action,"repository_inspected");});

test("sensitive actions wait for durable approval and pending or rejected approval cannot execute",async()=>{const {storage,registry}=await foundation();let executions=0;registry.register({name:"sensitive_action",riskLevel:RISK_LEVELS.SENSITIVE,available:true,async execute(){executions+=1;return "done";}});let pending;try{await registry.execute("sensitive_action",{target:"one"},{runId:"run-1"});}catch(error){assert.ok(error instanceof ApprovalRequiredError);pending=error.approval;}assert.equal(executions,0);assert.equal((await storage.listApprovals(OWNER_ID))[0].status,"pending");await assert.rejects(()=>registry.execute("sensitive_action",{target:"one"},{approvalId:pending.id,runId:"run-1"}),/does not authorize/);await storage.decideApproval(pending.id,OWNER_ID,"rejected");await assert.rejects(()=>registry.execute("sensitive_action",{target:"one"},{approvalId:pending.id,runId:"run-1"}),/does not authorize/);assert.equal(executions,0);});

test("approved action authorizes only its exact tool, arguments, and run",async()=>{const {storage,registry}=await foundation();registry.register({name:"controlled",riskLevel:RISK_LEVELS.SENSITIVE,available:true,async execute(input){return input.value;}});let approval;try{await registry.execute("controlled",{value:1},{runId:"run-a"});}catch(error){approval=error.approval;}await storage.decideApproval(approval.id,OWNER_ID,"approved");assert.equal(await registry.execute("controlled",{value:1},{approvalId:approval.id,runId:"run-a"}),1);await assert.rejects(()=>registry.execute("controlled",{value:2},{approvalId:approval.id,runId:"run-a"}),/does not authorize/);await assert.rejects(()=>registry.execute("controlled",{value:1},{approvalId:approval.id,runId:"run-b"}),/does not authorize/);});

test("real registry exposes usable reads and fail-closed unconfigured writes",async()=>{const {storage,registry}=await foundation();registerDeveloperTools(registry,{root:process.cwd(),environment:{}});registerSystemTools(registry,{storage,ownerId:OWNER_ID});const tools=registry.list();assert.ok(tools.some((tool)=>tool.name==="repo_read"&&tool.available));assert.ok(tools.some((tool)=>tool.name==="repo_apply_patch"&&!tool.available&&tool.configurationStatus==="configuration_required"));assert.ok(tools.some((tool)=>tool.name==="test_run"&&tool.available));const result=await registry.execute("repo_read",{path:"package.json"});assert.match(result.content,/nova-brain/);await assert.rejects(()=>registry.execute("repo_read",{path:"../outside"}),/outside/);await assert.rejects(()=>registry.execute("repo_apply_patch",{}),/unavailable/);});

test("serverless registry uses remote reads while local-only search, Git state, and tests stay unavailable",async()=>{const {registry}=await foundation();registerDeveloperTools(registry,{environment:{VERCEL:"1"}});const tools=registry.list();assert.equal(tools.find((tool)=>tool.name==="repo_read").available,true);for(const name of ["repo_search","git_status","repo_diff","test_run"])assert.equal(tools.find((tool)=>tool.name===name).available,false);});

test("the real serverless executable set serializes safely and reaches a normal OpenAI response", async () => {
  const { storage, registry } = await foundation();
  registerDeveloperTools(registry, { environment: { VERCEL: "1" } });
  registerSystemTools(registry, { storage, ownerId: OWNER_ID });
  const executable = registry.list({ executableOnly: true });
  assert.deepEqual(executable.map(({ name }) => name), ["repo_list", "repo_read", "project_list", "memory_remember", "memory_forget"]);
  assert.doesNotThrow(() => executable.map(toolDefinition));
  let sent;
  const provider = createOpenAIModelProvider({
    apiKey: "test-secret",
    model: "test-model",
    async fetchImpl(_url, options) {
      sent = JSON.parse(options.body);
      return { ok: true, status: 200, async json() { return { output_text: "Hello from Nova." }; } };
    }
  });
  assert.deepEqual(await provider.generate({ message: "Hello.", conversationHistory: [], context: {}, tools: executable }), { type: "final", message: "Hello from Nova." });
  assert.equal(sent.tools.find(({ name }) => name === "repo_list").strict, false);
  assert.equal(sent.tools.find(({ name }) => name === "project_list").strict, false);
  assert.equal(sent.tools.some(({ name }) => name === "repo_search"), false);
});

test("memory tools create, deduplicate, correct, retrieve across conversations, reject secrets, and forget with audit",async()=>{const {storage,registry}=await foundation();registerSystemTools(registry,{storage,ownerId:OWNER_ID});const first=await registry.execute("memory_remember",{content:"Mohammad prefers project summaries on Friday.",category:"preference",scope:"global"});assert.equal(first.operation,"created");const duplicate=await registry.execute("memory_remember",{content:"Mohammad prefers project summaries on Friday.",category:"preference",scope:"global"});assert.equal(duplicate.operation,"unchanged");assert.equal((await storage.retrieveMemories(OWNER_ID,"Friday project summaries",{limit:5}))[0].id,first.memory.id);const corrected=await registry.execute("memory_remember",{content:"Mohammad prefers project summaries on Saturday.",category:"preference",scope:"global"});assert.equal(corrected.operation,"updated");assert.equal(corrected.memory.id,first.memory.id);await assert.rejects(()=>registry.execute("memory_remember",{content:"My API key is secret-123",category:"preference",scope:"global"}),/Secrets cannot/);const forgotten=await registry.execute("memory_forget",{memoryId:first.memory.id});assert.equal(forgotten.deleted,true);assert.equal(await storage.getMemory(first.memory.id,OWNER_ID),null);const actions=(await storage.listActivity(OWNER_ID,{limit:20})).map(({action})=>action);assert.ok(actions.includes("memory_remembered"));assert.ok(actions.includes("memory_corrected"));assert.ok(actions.includes("memory_forgotten"));});

test("configured repository writes remain bound away from main and secrets are redacted in approvals",async()=>{const {storage,registry}=await foundation();registerDeveloperTools(registry,{root:process.cwd(),environment:{NOVA_BRAIN_GITHUB_TOKEN:"server-secret",NOVA_BRAIN_GITHUB_REPOSITORY:"hshanbour/nova-brain",NOVA_BRAIN_DEVELOPMENT_BRANCH:"feat/nova-brain-mvp-foundation"}});const write=registry.list().find((tool)=>tool.name==="repo_apply_patch");assert.equal(write.available,true);await assert.rejects(()=>registry.execute("repo_apply_patch",{path:"README.md",content:"x",expectedSha:"abc",message:"test",branch:"main"}),/not approved/);registry.register({name:"secret_action",riskLevel:RISK_LEVELS.SENSITIVE,available:true,async execute(){return true;}});try{await registry.execute("secret_action",{apiKey:"must-not-appear"});}catch{}const approval=(await storage.listApprovals(OWNER_ID))[0];assert.equal(approval.arguments.apiKey,"[REDACTED]");assert.equal(JSON.stringify(approval).includes("must-not-appear"),false);});

