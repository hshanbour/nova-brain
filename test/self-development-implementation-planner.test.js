import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import {
  createSelfDevelopmentImplementationPlanner,
  SELF_DEVELOPMENT_IMPLEMENTATION_PLAN_SCHEMA,
  SELF_DEVELOPMENT_PLANNER_PROTECTED,
} from "../src/autonomy/self-development-implementation-planner.js";
import { createWorkerRuntime } from "../src/autonomy/worker-runtime.js";
import { SELF_DEVELOPMENT_HANDS_PATCH_INPUT_SCHEMA, SELF_DEVELOPMENT_IMPLEMENTATION_PLAN_SCHEMA_VERSION } from "../src/autonomy/self-development-implementation-contract.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { registerHandsTools } from "../src/tools/hands-runtime.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";
import {focusedTestEvidenceRelevance,focusedTestSourceRelationship} from "../src/autonomy/focused-test-evidence-relevance.js";

const OWNER = "owner",
  BRANCH = "feat/nova-brain-mvp-foundation",
  SHA = "a".repeat(40),
  DOC = "docs/planner-acceptance.md",
  TEST = "test/planner-acceptance.test.js",
  EXTRA = "test/planner-extra.test.js";
const valid = () => ({
  files: [
    {
      path: DOC,
      operation: "replace",
      content: "new doc",
      reason: "acceptance",
      intendedChanges: ["update marker"],
    },
  ],
  focusedTests: [{ path: TEST, kind: "existing" }],
  acceptanceMapping: [{ criterion: "Document is updated", files: [DOC] }],
  riskLevel: "medium",
  summary: "Bounded documentation update",
});
async function fixture(
  outputs = [valid()],
  {
    discovered = [DOC, TEST],
    reads = [
      [DOC, "old doc"],
      [TEST, "old test"],
    ],
    existing = discovered,
  } = {},
) {
  const storage = createInMemoryStorage();
  await storage.initialize({
    owner: { id: OWNER, fullName: "Owner" },
    projects: [{ id: "nova-brain", name: "Nova" }],
  });
  await storage.createAutonomyTask({
    id: "selfdev-plan",
    ownerId: OWNER,
    projectId: "nova-brain",
    title: "Planner",
    objective: "Update harmless documentation",
    taskType: "self_development",
    branch: BRANCH,
    startingCommit: SHA,
    maxRuntimeMinutes: 60,
    metadata: {
      steps: [],
      selfDevelopment: {
        userGoal: "Update harmless planner documentation",
        acceptanceCriteria: ["Document is updated"],
      },
    },
  });
  await storage.recordAutonomyStep({
    taskId: "selfdev-plan",
    stepId: "evidence:inventory",
    stepType: "inspect_repo",
    capability: "repo_read_remote",
    operationFingerprint: "inventory",
    status: "completed",
    result: { files: discovered },
  });
  for (const [index, [path, content]] of reads.entries())
    await storage.recordAutonomyStep({
      taskId: "selfdev-plan",
      stepId: `evidence:${index}:read_files`,
      stepType: "read_files",
      capability: "repo_read_remote",
      operationFingerprint: path,
      status: "completed",
      input: { arguments: { path } },
      result: { path, content, truncated: false },
    });
  let prompts = [],
    calls = 0;
  const modelProvider = {
      async generate(input) {
        prompts.push(input);
        const output = outputs[Math.min(calls++, outputs.length - 1)];
        return output?.type
          ? output
          : {
              type: "final",
              message:
                typeof output === "string" ? output : JSON.stringify(output),
            };
      },
    },
    planner = createSelfDevelopmentImplementationPlanner({
      modelProvider,
      storage,
      ownerId: OWNER,
      resolvePathState: async (path) => ({
        existsInCommit: existing.includes(path),
        existsInWorktree: existing.includes(path),
        staged: false,
        untracked: false,
      }),
    });
  return {
    storage,
    planner,
    prompts,
    get calls() {
      return calls;
    },
  };
}

test("canonical valid structured output produces the Hands replacement representation", async () => {
  const f = await fixture(),
    result = await f.planner.generate({
      taskId: "selfdev-plan",
      candidatePaths: [DOC, TEST],
      currentCommit: SHA,
    });
  assert.equal(result.implementationPlan.files[0].operation, "replace");
  assert.equal(result.implementationPlan.files[0].expectedContent, "old doc");
  assert.deepEqual(f.prompts[0].responseFormat, {
    name: "nova_self_development_implementation_plan",
    schema: SELF_DEVELOPMENT_IMPLEMENTATION_PLAN_SCHEMA,
    strict: true,
  });
});
test("an unchanged evidence-bound plan becomes a bounded no-change candidate",async()=>{
  const output=valid();output.files[0].content="old doc";
  const f=await fixture([output]),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA});
  assert.equal(result.implementationPlan,undefined);
  assert.equal(result.noChangeCandidate.intent,"implementation");
  assert.deepEqual(result.noChangeCandidate.evidenceEntries.map(item=>item.path),[DOC,TEST]);
  assert.ok(result.noChangeCandidate.evidenceEntries.every(item=>/^[a-f0-9]{64}$/.test(item.contentHash)&&item.readStepId));
  assert.deepEqual(result.noChangeCandidate.focusedTests,[{path:TEST,kind:"existing"}]);
  assert.match(result.noChangeCandidate.decisionHash,/^[a-f0-9]{64}$/);
});
test("planner and Hands share the canonical versioned patch bridge contract", () => {
  const registry=createToolRegistry();registerHandsTools(registry,{root:process.cwd(),environment:{VERCEL:"",NOVA_BRAIN_DEVELOPMENT_BRANCH:BRANCH}});
  const patch=registry.list().find((tool)=>tool.name==="repo_apply_patch");
  assert.equal(SELF_DEVELOPMENT_IMPLEMENTATION_PLAN_SCHEMA_VERSION,"2");
  assert.deepEqual(patch.inputSchema,SELF_DEVELOPMENT_HANDS_PATCH_INPUT_SCHEMA);
  assert.deepEqual(Object.keys(patch.inputSchema.properties).sort(),["branch","currentCommit","files","planProvenance"]);
});
test("canonical composer-style plan validates before Hands-compatible mutation", async () => {
  const output=valid();output.files=[{path:"assets/voice-input.js",operation:"replace",content:"export function createVoiceInput() { return { supported: true }; }\n",reason:"bounded composer dictation",intendedChanges:["preserve editable transcription"]},{path:"test/voice-input.test.js",operation:"replace",content:"import test from 'node:test';\ntest('dictation', () => {});\n",reason:"focused evidence",intendedChanges:["cover dictation"]}];output.focusedTests=[{path:"test/voice-input.test.js",kind:"existing"}];output.acceptanceMapping=[{criterion:"Composer dictation stays editable",files:["assets/voice-input.js","test/voice-input.test.js"]}];
  const f=await fixture([output],{discovered:["assets/voice-input.js","test/voice-input.test.js"],reads:[["assets/voice-input.js","old adapter"],["test/voice-input.test.js","old focused tests"]]}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:["assets/voice-input.js","test/voice-input.test.js"],currentCommit:SHA});
  assert.deepEqual(result.implementationPlan.focusedTests,[{path:"test/voice-input.test.js",kind:"existing"}]);
  assert.deepEqual(result.implementationPlan.files.map(({path,operation})=>({path,operation})),[{path:"assets/voice-input.js",operation:"replace"},{path:"test/voice-input.test.js",operation:"replace"}]);
  assert.equal(result.implementationPlan.files.every((file)=>typeof file.expectedContent==="string"),true);
});
test("canonical planner separates focused-test verification from mutation acceptance",async()=>{
  const source="assets/voice-input.js",changedTest="test/voice-input.test.js",staticTest="test/console-static.test.js",integrationTest="test/composer-voice-console.integration.test.js",clientTest="test/console-client.test.js",paths=[source,changedTest,staticTest,integrationTest,clientTest],output={summary:"Refine the analyser-driven microphone waveform",files:[
    {path:source,operation:"replace",content:"export const waveform = 'dense';\n",reason:"refine live waveform",intendedChanges:["render denser real amplitude bars"]},
    {path:changedTest,operation:"replace",content:"import test from 'node:test';\ntest('dense waveform', () => {});\n",reason:"cover analyser behavior",intendedChanges:["verify denser waveform"]},
    {path:staticTest,operation:"replace",content:"import test from 'node:test';\ntest('recording layout', () => {});\n",reason:"cover recording layout",intendedChanges:["verify control clearance"]},
  ],focusedTests:[{path:changedTest,kind:"existing"},{path:integrationTest,kind:"existing"},{path:staticTest,kind:"existing"},{path:clientTest,kind:"existing"}],acceptanceMapping:[
    {criterion:"Waveform is dense and responsive",files:[source,changedTest,staticTest]},
    {criterion:"Recording controls remain clear",files:[source,staticTest]},
    {criterion:"Console behavior remains intact",files:[changedTest,integrationTest,staticTest,clientTest]},
  ],riskLevel:"medium"};
  const reads=paths.map(path=>[path,path.startsWith("test/")?"import test from 'node:test';\n": "export const waveform = 'old';\n"]),f=await fixture([output],{discovered:paths,reads}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:paths,currentCommit:SHA}),plan=result.implementationPlan;
  assert.deepEqual(plan.files.map(file=>file.path),[source,changedTest,staticTest]);
  assert.deepEqual(plan.acceptanceMapping,[
    {criterion:"Waveform is dense and responsive",files:[source,changedTest,staticTest]},
    {criterion:"Recording controls remain clear",files:[source,staticTest]},
    {criterion:"Console behavior remains intact",files:[changedTest,staticTest],tests:[integrationTest,clientTest]},
  ]);
  assert.deepEqual(plan.focusedTests,output.focusedTests);
  assert.equal(plan.provenance.mutationPreconditions.some(item=>item.path===integrationTest||item.path===clientTest),false);
  assert.deepEqual(plan.provenance.mutationPreconditions.map(item=>item.path),[source,changedTest,staticTest]);
  assert.match(plan.provenance.generationId,/^[a-f0-9]{64}$/);
});
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==="object"?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const durableHash=value=>createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
test("instructional replacement prose is rejected and regenerated before mutation",async()=>{const prose=valid();prose.files=[{path:"assets/voice-input.js",operation:"replace",content:"Replace the adapter with valid JavaScript and preserve editable transcription.",reason:"repair",intendedChanges:["repair adapter"]}];prose.focusedTests=[{path:"test/voice-input.test.js",kind:"existing"}];prose.acceptanceMapping=[{criterion:"Works",files:["assets/voice-input.js"]}];const corrected=structuredClone(prose);corrected.files[0].content="export const supported = true;\n";const f=await fixture([prose,corrected],{discovered:["assets/voice-input.js","test/voice-input.test.js"],reads:[["assets/voice-input.js","export const supported = false;\n"],["test/voice-input.test.js","import test from 'node:test';\n"]]}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:["assets/voice-input.js","test/voice-input.test.js"],currentCommit:SHA});assert.equal(f.calls,2);assert.match(f.prompts[1].message,/file_0_replacement_script_not_source/);assert.equal(result.implementationPlan.files[0].content,"export const supported = true;\n");});

test("partial-plan recovery regenerates every exact task-owned dirty path and rejects another partial plan",async()=>{
  const paths=[DOC,TEST,EXTRA],contents={[DOC]:"dirty doc",[TEST]:"import test from 'node:test';\n",[EXTRA]:"import test from 'node:test';\n"},complete={files:paths.map(path=>({path,operation:"replace",content:path===DOC?"fixed doc":"import test from 'node:test';\n// repaired\n",reason:"repair",intendedChanges:["repair"]})),focusedTests:[{path:TEST,kind:"existing"}],acceptanceMapping:[{criterion:"Document is updated",files:paths}],riskLevel:"medium",summary:"Complete repair"};
  async function prepared(outputs){const f=await fixture(outputs,{discovered:paths,reads:[],existing:paths}),task=await f.storage.getAutonomyTask("selfdev-plan",OWNER),generationId="partial-recovery-generation",entries=paths.map(path=>({path,contentHash:canonicalContentHash(contents[path])})),record={taskId:task.id,repository:"hshanbour/nova-brain",branch:BRANCH,currentCommit:SHA,fingerprint:"f".repeat(64),sourcePlanStepId:"26:plan_repair",sourceApplyStepId:"27:apply_patch",requiredPaths:paths,entries,activeContinuation:{generationId}};await f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...task.metadata,selfDevelopment:{...task.metadata.selfDevelopment,repository:"hshanbour/nova-brain"},activeContinuation:{generationId},partialRepairPlanRecoveryHistory:[record]}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:record.sourcePlanStepId,stepType:"plan_repair",capability:"reasoning",operationFingerprint:"source-plan",status:"completed",result:{implementationPlan:{files:paths.map(path=>({path,content:contents[path]}))}}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:record.sourceApplyStepId,stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"source-apply",status:"completed",result:{files:paths}});return{f,failureEvidence:{code:"repair_plan_incomplete",fingerprint:record.fingerprint}};}
  const exact=await prepared([complete]),result=await exact.f.planner.generate({taskId:"selfdev-plan",candidatePaths:paths,currentCommit:SHA,failureEvidence:exact.failureEvidence});assert.deepEqual(result.implementationPlan.files.map(file=>file.path).sort(),[...paths].sort());assert.match(exact.f.prompts[0].message,/dirty doc/);
  const partial=structuredClone(complete);partial.files=partial.files.slice(1);partial.acceptanceMapping=[{criterion:"Document is updated",files:partial.files.map(file=>file.path)}];const rejected=await prepared([partial,partial,partial]);await assert.rejects(()=>rejected.f.planner.generate({taskId:"selfdev-plan",candidatePaths:paths,currentCommit:SHA,failureEvidence:rejected.failureEvidence}),error=>error.code==="implementation_plan_invalid"||error.code==="implementation_scope_violation");
  for(const [field,value] of [["taskId","another-task"],["repository","another/repository"],["branch","feat/another-branch"]]){const mismatched=await prepared([complete]),task=await mismatched.f.storage.getAutonomyTask("selfdev-plan",OWNER),record={...task.metadata.partialRepairPlanRecoveryHistory[0],[field]:value};await mismatched.f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...task.metadata,partialRepairPlanRecoveryHistory:[record]}});await assert.rejects(()=>mismatched.f.planner.generate({taskId:"selfdev-plan",candidatePaths:paths,currentCommit:SHA,failureEvidence:mismatched.failureEvidence}),error=>error.code==="implementation_evidence_incomplete");}
});
test("v148-shaped partial recovery reads complete durable lineage when the latest apply mutated only a subset",async()=>{
  const paths=[DOC,TEST,EXTRA],contents={[DOC]:"dirty doc",[TEST]:"import test from 'node:test';\n",[EXTRA]:"import test from 'node:test';\n"},entries=paths.map(path=>({path,contentHash:canonicalContentHash(contents[path])})).sort((a,b)=>a.path.localeCompare(b.path)),complete={files:paths.map(path=>({path,operation:"replace",content:path===DOC?"fixed doc":"import test from 'node:test';\n// repaired\n",reason:"repair",intendedChanges:["repair"]})),focusedTests:[{path:TEST,kind:"existing"}],acceptanceMapping:[{criterion:"Document is updated",files:paths}],riskLevel:"medium",summary:"Complete repair"},f=await fixture([complete],{discovered:paths,reads:[],existing:paths}),task=await f.storage.getAutonomyTask("selfdev-plan",OWNER),generationId="v148-recovery",previousStateVersion=145,sourcePlanStepId="79:plan_repair",sourceApplyStepId="80:apply_patch",sourceApplyFingerprint="source-apply",record={taskId:task.id,previousStateVersion,repository:"hshanbour/nova-brain",branch:BRANCH,currentCommit:SHA,sourcePlanStepId,sourceApplyStepId,sourceApplyFingerprint,requiredPaths:paths,entries,activeContinuation:{generationId}};record.fingerprint=durableHash([record.taskId,record.previousStateVersion,record.sourcePlanStepId,record.sourceApplyStepId,record.entries]);await f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...task.metadata,selfDevelopment:{...task.metadata.selfDevelopment,repository:"hshanbour/nova-brain"},activeContinuation:{generationId},partialRepairPlanRecoveryHistory:[record],escalatedRepairHistory:[{consumed:true,additionalAttempts:1}]}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:"63:plan_repair",stepType:"plan_repair",capability:"reasoning",operationFingerprint:"carried-plan",status:"completed",result:{implementationPlan:{files:paths.slice(1).map(path=>({path,content:contents[path]}))}}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:sourcePlanStepId,stepType:"plan_repair",capability:"reasoning",operationFingerprint:"source-plan",status:"completed",result:{implementationPlan:{files:[{path:DOC,content:contents[DOC]}]}}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:sourceApplyStepId,stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:sourceApplyFingerprint,status:"completed",result:{files:[DOC],taskOwnedDirtyLineage:{version:1,taskId:task.id,repository:"hshanbour/nova-brain",branch:BRANCH,currentCommit:SHA,sourcePlanStepId,entries}}});const before=await f.storage.getAutonomyTask(task.id,OWNER),result=await f.planner.generate({taskId:task.id,candidatePaths:paths,currentCommit:SHA,failureEvidence:{code:"repair_plan_incomplete",fingerprint:record.fingerprint}}),after=await f.storage.getAutonomyTask(task.id,OWNER);assert.deepEqual(result.implementationPlan.files.map(file=>file.path).sort(),[...paths].sort());assert.match(f.prompts[0].message,/dirty doc/);assert.match(f.prompts[0].message,/import test from/);assert.equal(after.stateVersion,before.stateVersion);assert.deepEqual(after.metadata.escalatedRepairHistory,before.metadata.escalatedRepairHistory);
  for(const mutate of [lineage=>{lineage.entries[0].contentHash="0".repeat(64);},lineage=>{lineage.sourcePlanStepId="78:plan_repair";}]){const broken=structuredClone(record),lineage={version:1,taskId:task.id,repository:"hshanbour/nova-brain",branch:BRANCH,currentCommit:SHA,sourcePlanStepId,entries:structuredClone(entries)};mutate(lineage);const g=await fixture([complete],{discovered:paths,reads:[],existing:paths}),t=await g.storage.getAutonomyTask("selfdev-plan",OWNER);await g.storage.updateAutonomyTask(t.id,OWNER,{metadata:{...t.metadata,selfDevelopment:{...t.metadata.selfDevelopment,repository:"hshanbour/nova-brain"},activeContinuation:{generationId},partialRepairPlanRecoveryHistory:[broken]}});await g.storage.recordAutonomyStep({taskId:t.id,stepId:sourcePlanStepId,stepType:"plan_repair",capability:"reasoning",operationFingerprint:"source-plan",status:"completed",result:{implementationPlan:{files:paths.map(path=>({path,content:contents[path]}))}}});await g.storage.recordAutonomyStep({taskId:t.id,stepId:sourceApplyStepId,stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:sourceApplyFingerprint,status:"completed",result:{files:[DOC],taskOwnedDirtyLineage:lineage}});await assert.rejects(()=>g.planner.generate({taskId:t.id,candidatePaths:paths,currentCommit:SHA,failureEvidence:{code:"repair_plan_incomplete",fingerprint:broken.fingerprint}}),error=>error.code==="implementation_evidence_incomplete");}
});
test("repair planning includes a relevant previously read failing test as exact evidence",async()=>{
  const output=valid();output.focusedTests=[{path:EXTRA,kind:"existing"}];
  const f=await fixture([output],{discovered:[DOC,TEST,EXTRA],reads:[[DOC,"old doc"],[TEST,"old test"],[EXTRA,"exact failing test"]]}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA,failureEvidence:{fingerprint:"f".repeat(64),failedFiles:["test/hands-runtime.test.js",EXTRA]}}),prompt=JSON.parse(f.prompts[0].message.split("\n")[1]);
  assert.deepEqual(prompt.candidateFiles.map(item=>item.path),[DOC,TEST,EXTRA]);assert.equal(prompt.candidateFiles.at(-1).content,"exact failing test");assert.ok(result.implementationPlan.evidencePaths.includes(EXTRA));
});
test("authoritative full-test failure expands to an existing tracked test outside discovery inventory",async()=>{
  const output=valid();output.focusedTests=[{path:EXTRA,kind:"existing"}];
  const f=await fixture([output],{discovered:[DOC,TEST],reads:[[DOC,"old doc"],[TEST,"old test"]],existing:[DOC,TEST,EXTRA]}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA,failureEvidence:{version:1,fingerprint:"f".repeat(64),identity:{command:"npm:test"},failedFiles:[EXTRA]}});
  assert.equal(result.evidenceExpansion.category,"full_test_failure_evidence");assert.deepEqual(result.evidenceExpansion.paths,[EXTRA]);assert.equal(f.calls,1);
});
test("authoritative focused-test failure retains bounded tracked-path expansion",async()=>{
  const output=valid();output.focusedTests=[{path:EXTRA,kind:"existing"}];
  const f=await fixture([output],{discovered:[DOC,TEST],reads:[[DOC,"old doc"],[TEST,"old test"]],existing:[DOC,TEST,EXTRA]}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA,failureEvidence:{version:1,fingerprint:"f".repeat(64),identity:{command:"node:test:focused"},failedFiles:[EXTRA]}});
  assert.equal(result.evidenceExpansion.category,"focused_test_failure_evidence");assert.deepEqual(result.evidenceExpansion.paths,[EXTRA]);
});
test("failure-evidence expansion rejects nonexistent untracked and unrelated existing tests",async()=>{
  for(const {failed,existing} of [{failed:[EXTRA],existing:[DOC,TEST]},{failed:["test/another.test.js"],existing:[DOC,TEST,EXTRA]}]){const output=valid();output.focusedTests=[{path:EXTRA,kind:"existing"}];const f=await fixture([output],{discovered:[DOC,TEST],reads:[[DOC,"old doc"],[TEST,"old test"]],existing});await assert.rejects(()=>f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA,failureEvidence:{version:1,fingerprint:"f".repeat(64),identity:{command:"npm:test"},failedFiles:failed}}),error=>error.code==="implementation_scope_violation"&&error.safeDiagnostics.proposedPath===EXTRA);}
});
test("Windows separators in authoritative failure evidence normalize to the tracked repository path",async()=>{
  const output=valid();output.focusedTests=[{path:EXTRA,kind:"existing"}];const f=await fixture([output],{discovered:[DOC,TEST],reads:[[DOC,"old doc"],[TEST,"old test"]],existing:[DOC,TEST,EXTRA]}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA,failureEvidence:{version:1,fingerprint:"f".repeat(64),identity:{command:"npm:test"},failedFiles:[EXTRA.replaceAll("/","\\")]}});assert.deepEqual(result.evidenceExpansion.paths,[EXTRA]);
});
test("schema-imperfect output receives safe feedback and corrects within the same evidence", async () => {
  const imperfect = {
      files: [DOC],
      tests: [TEST],
      risk: "medium",
      summary: "x",
    },
    f = await fixture([imperfect, valid()]),
    result = await f.planner.generate({
      taskId: "selfdev-plan",
      candidatePaths: [DOC, TEST],
      currentCommit: SHA,
    });
  assert.equal(f.calls, 2);
  assert.equal(result.implementationPlan.files[0].path, DOC);
  assert.match(f.prompts[1].message, /file_0_object_required/);
  assert.match(f.prompts[1].message, /acceptance_mapping_invalid/);
});
test("identical malformed output is bounded and exposes only issue codes and a hash", async () => {
  const malformed = {
      files: [DOC],
      focusedTests: [TEST],
      acceptanceMapping: [],
      riskLevel: "medium",
      summary: "x",
    },
    f = await fixture([malformed, malformed]);
  await assert.rejects(
    () =>
      f.planner.generate({
        taskId: "selfdev-plan",
        candidatePaths: [DOC, TEST],
        currentCommit: SHA,
      }),
    (error) =>
      error.code === "implementation_plan_invalid" &&
      error.safeDiagnostics.formatAttempts === 2 &&
      error.safeDiagnostics.validationIssues.includes(
        "file_0_object_required",
      ) &&
      /^[a-f0-9]{64}$/.test(error.safeDiagnostics.outputShapeHash),
  );
  assert.equal(f.calls, 2);
});
test("markdown JSON fence is harmless but explanatory prose is rejected deterministically", async () => {
  const fenced = await fixture([
    `\`\`\`json\n${JSON.stringify(valid())}\n\`\`\``,
  ]);
  assert.ok(
    (
      await fenced.planner.generate({
        taskId: "selfdev-plan",
        candidatePaths: [DOC, TEST],
        currentCommit: SHA,
      })
    ).ok,
  );
  const prose = await fixture([`Here is the plan: ${JSON.stringify(valid())}`]);
  await assert.rejects(
    () =>
      prose.planner.generate({
        taskId: "selfdev-plan",
        candidatePaths: [DOC, TEST],
        currentCommit: SHA,
      }),
    (error) => error.code === "implementation_plan_invalid",
  );
});
test("missing fields, unknown paths, and protected or unread evidence fail closed", async () => {
  const missing = await fixture([
    {
      files: [],
      focusedTests: [TEST],
      acceptanceMapping: [],
      riskLevel: "medium",
      summary: "x",
    },
  ]);
  await assert.rejects(
    () =>
      missing.planner.generate({
        taskId: "selfdev-plan",
        candidatePaths: [DOC, TEST],
        currentCommit: SHA,
      }),
    (e) => e.code === "implementation_plan_invalid",
  );
  const outside = valid();
  outside.files[0].path = "src/unrelated.js";
  outside.files[0].content = "export const unrelated = true;\n";
  await assert.rejects(
    () =>
      fixture([outside]).then((f) =>
        f.planner.generate({
          taskId: "selfdev-plan",
          candidatePaths: [DOC, TEST],
          currentCommit: SHA,
        }),
      ),
    (e) => e.code === "implementation_scope_violation",
  );
  const f = await fixture();
  await assert.rejects(
    () =>
      f.planner.generate({
        taskId: "selfdev-plan",
        candidatePaths: [DOC, "test/missing.test.js"],
        currentCommit: SHA,
      }),
    (e) => e.code === "implementation_evidence_incomplete",
  );
  await assert.rejects(
    () =>
      f.planner.generate({
        taskId: "selfdev-plan",
        candidatePaths: ["assets/voice-control.js", TEST],
        currentCommit: SHA,
      }),
    (e) => e.code === "protected_scope_requires_approval",
  );
});
test("acceptance mapping cannot substitute an unmodified test file", async () => {
  const output = valid();
  output.acceptanceMapping[0].files = [TEST];
  const f = await fixture([output]);
  await assert.rejects(
    () =>
      f.planner.generate({
        taskId: "selfdev-plan",
        candidatePaths: [DOC, TEST],
        currentCommit: SHA,
      }),
    (e) => e.code === "implementation_plan_invalid",
  );
});
test("acceptance verification still rejects tests outside the selected focused-test contract",async()=>{
  const output=valid();output.acceptanceMapping[0].tests=[EXTRA];
  const f=await fixture([output]);
  await assert.rejects(()=>f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA}),error=>error.code==="implementation_plan_invalid"&&error.safeDiagnostics.validationIssues.includes("acceptance_mapping_test_invalid"));
});
test("durable Worker passes only the validated Nova patch to Hands", async () => {
  const output=valid();output.acceptanceMapping[0].files=[DOC,TEST];
  const f = await fixture([output]),
    generated = await f.planner.generate({
      taskId: "selfdev-plan",
      candidatePaths: [DOC, TEST],
      currentCommit: SHA,
    }),
    calls = [];
  await f.storage.updateAutonomyTask("selfdev-plan", OWNER, {
    status: "queued",
    metadata: {
      steps: [
        {
          type: "plan_implementation",
          capability: "reasoning",
          input: {
            tool: "self_development_plan_implementation",
            arguments: {},
          },
          idempotencyIdentity: "plan",
        },
        {
          type: "apply_patch",
          capability: "repo_mutate_local",
          input: {
            tool: "repo_apply_patch",
            arguments: { files: "$IMPLEMENTATION_FILES" },
          },
          idempotencyIdentity: "apply",
        },
        {
          type: "run_focused_tests",
          capability: "test_local",
          input: {
            tool: "test_run",
            arguments: { files: "$IMPLEMENTATION_TESTS" },
          },
          idempotencyIdentity: "focused",
        },
      ],
      selfDevelopment: {
        userGoal: "Update harmless documentation",
        acceptanceCriteria: ["Document is updated"],
      },
    },
  });
  const runtime = createWorkerRuntime({
    storage: f.storage,
    ownerId: OWNER,
    approvedBranch: BRANCH,
    capabilities: ["reasoning", "repo_mutate_local", "test_local"],
    toolRegistry: {
      async execute(name, args) {
        calls.push({ name, args });
        if(name === "self_development_plan_implementation")return generated;
        return name === "repo_apply_patch"?{ok:true,files:args.files.map((x)=>x.path)}:{ok:true,passed:1,failed:0};
      },
    },
  });
  await runtime.tickTask("selfdev-plan", { idempotencyKey: "plan" });
  await runtime.tickTask("selfdev-plan", { idempotencyKey: "apply" });
  await runtime.tickTask("selfdev-plan", { idempotencyKey: "focused" });
  assert.deepEqual(
    calls.map((x) => x.name),
    ["self_development_plan_implementation", "repo_apply_patch", "test_run"],
  );
  assert.equal(calls[1].args.files[0].content, "new doc");
  assert.equal(calls[1].args.files[0].operation, "replace");
  assert.deepEqual(calls[2].args.files,[TEST]);
  assert.deepEqual(generated.implementationPlan.acceptanceMapping,[{criterion:"Document is updated",files:[DOC],tests:[TEST]}]);
});
test("relevant unread focused test expands evidence, is read, and replans before Hands", async () => {
  const first = valid();
  first.focusedTests = [{ path: EXTRA, kind: "existing" }];
  const f = await fixture([first, first], { discovered: [DOC, TEST, EXTRA] }),
    calls = [];
  await f.storage.updateAutonomyTask("selfdev-plan", OWNER, {
    status: "queued",
    metadata: {
      steps: [
        {
          type: "plan_implementation",
          capability: "reasoning",
          input: {
            tool: "self_development_plan_implementation",
            arguments: {
              taskId: "selfdev-plan",
              candidatePaths: [DOC, TEST],
              currentCommit: SHA,
            },
          },
          idempotencyIdentity: "plan",
        },
        {
          type: "apply_patch",
          capability: "repo_mutate_local",
          input: {
            tool: "repo_apply_patch",
            arguments: { files: "$IMPLEMENTATION_FILES" },
          },
          idempotencyIdentity: "apply",
        },
      ],
      selfDevelopment: {
        userGoal: "Update harmless planner documentation",
        acceptanceCriteria: ["Document is updated"],
      },
    },
  });
  const runtime = createWorkerRuntime({
    storage: f.storage,
    ownerId: OWNER,
    approvedBranch: BRANCH,
    capabilities: ["reasoning", "repo_read_remote", "repo_mutate_local"],
    toolRegistry: {
      async execute(name, args) {
        calls.push({ name, args });
        if (name === "self_development_plan_implementation")
          return f.planner.generate(args);
        if (name === "repo_read")
          return {
            ok: true,
            path: args.path,
            content: "new focused evidence",
            truncated: false,
          };
        return { ok: true };
      },
    },
  });
  await runtime.tickTask("selfdev-plan");
  let task = await runtime.get("selfdev-plan");
  assert.equal(task.metadata.steps[1].type, "read_files");
  assert.equal(task.metadata.steps[1].input.arguments.path, EXTRA);
  assert.equal(task.metadata.steps[2].type, "plan_implementation");
  assert.equal(
    calls.some((call) => call.name === "repo_apply_patch"),
    false,
  );
  await runtime.tickTask("selfdev-plan");
  await runtime.tickTask("selfdev-plan");
  task = await runtime.get("selfdev-plan");
  assert.deepEqual(
    calls.map((x) => x.name),
    [
      "self_development_plan_implementation",
      "repo_read",
      "self_development_plan_implementation",
    ],
  );
  assert.equal(
    task.metadata.selfDevelopmentImplementationPlan.focusedTests[0].path,
    EXTRA,
  );
  assert.ok(task.checkpoint.completedSteps.includes("2:read_files"));
});
test("unrelated nonexistent protected and repeated evidence expansion fail closed", async () => {
  for (const path of [
    "test/unrelated.test.js",
    "test/missing.test.js",
    "test/voice-control.test.js",
    "../external.test.js",
  ]) {
    const output = valid();
    output.focusedTests = [path];
    const f = await fixture([output], {
      discovered: [
        DOC,
        TEST,
        "test/unrelated.test.js",
        "test/voice-control.test.js",
      ],
    });
    await assert.rejects(
      () =>
        f.planner.generate({
          taskId: "selfdev-plan",
          candidatePaths: [DOC, TEST],
          currentCommit: SHA,
        }),
      (e) =>
        e.code === "implementation_scope_violation" ||
        e.code === "implementation_plan_invalid",
    );
  }
  const repeated = valid();
  repeated.focusedTests = [EXTRA];
  const f = await fixture([repeated], { discovered: [DOC, TEST, EXTRA] });
  const first = await f.planner.generate({
    taskId: "selfdev-plan",
    candidatePaths: [DOC, TEST],
    currentCommit: SHA,
  });
  await f.storage.updateAutonomyTask("selfdev-plan", OWNER, {
    metadata: {
      ...(await f.storage.getAutonomyTask("selfdev-plan", OWNER)).metadata,
      implementationEvidenceExpansionHistory: [
        { pathHashes: first.evidenceExpansion.pathHashes },
      ],
    },
  });
  await assert.rejects(
    () =>
      f.planner.generate({
        taskId: "selfdev-plan",
        candidatePaths: [DOC, TEST],
        currentCommit: SHA,
      }),
    (e) => e.code === "implementation_evidence_expansion_repeated",
  );
});

test("a planned new focused test is create-bound, content-bound, and not evidence-read", async () => {
  const NEW = "test/planner-new.test.js",
    output = valid();
  output.files.push({
    path: NEW,
    operation: "create",
    content: 'import test from "node:test";\ntest("new",()=>{});\n',
    reason: "new focused coverage",
    intendedChanges: ["cover new behavior"],
  });
  output.focusedTests = [{ path: NEW, kind: "planned_new" }];
  const f = await fixture([output], { discovered: [DOC, TEST] }),
    result = await f.planner.generate({
      taskId: "selfdev-plan",
      candidatePaths: [DOC, TEST],
      currentCommit: SHA,
    });
  assert.deepEqual(result.implementationPlan.focusedTests, [
    { path: NEW, kind: "planned_new" },
  ]);
  assert.equal(
    result.implementationPlan.files.find((file) => file.path === NEW).operation,
    "create",
  );
  assert.equal(
    result.implementationPlan.files.find((file) => file.path === NEW)
      .expectedContent,
    undefined,
  );
});

test("undiscovered existing path is not mistaken for a safe create target", async () => {
  const path = "test/planner-new.test.js";
  const output = valid();
  output.files.push({path,operation:"create",content:"export const coverage = true;\n",reason:"coverage",intendedChanges:["cover"]});
  output.focusedTests = [{path,kind:"planned_new"}];
  const f = await fixture([output], {discovered:[DOC,TEST], existing:[DOC,TEST,path]});
  await assert.rejects(() => f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA}), error => error.code === "operation_conflict" && error.safeDiagnostics.discovered === false && error.safeDiagnostics.requiredAction === "read_before_modify");
});

test("planned new tests fail closed unless nonexistent relevant bounded create files", async () => {
  for (const mutate of [
    (output) => {
      output.files[1].operation = "replace";
    },
    (output) => {
      output.files[1].content = "";
    },
    (output) => {
      output.files[1].path = output.focusedTests[0].path =
        "test/unrelated.test.js";
    },
  ]) {
    const NEW = "test/planner-new.test.js",
      output = valid();
    output.files.push({
      path: NEW,
      operation: "create",
      content: "bounded",
      reason: "coverage",
      intendedChanges: [],
    });
    output.focusedTests = [{ path: NEW, kind: "planned_new" }];
    mutate(output);
    const discovered = [
      DOC,
      TEST,
      ...(output.files[1].path === NEW && output.files[1].operation === "create"
        ? [NEW]
        : []),
    ];
    await assert.rejects(
      () =>
        fixture([output], { discovered }).then((f) =>
          f.planner.generate({
            taskId: "selfdev-plan",
            candidatePaths: [DOC, TEST],
            currentCommit: SHA,
          }),
        ),
      (e) =>
        e.code === "implementation_scope_violation" ||
        e.code === "implementation_plan_invalid",
    );
  }
});

test("missing intended test uses bounded discovery and retains safe rejected-path diagnostics", async () => {
  const output = valid();
  output.focusedTests = [
    { path: "test/planner-missing.test.js", kind: "existing" },
  ];
  const f = await fixture([output], {
      discovered: [DOC, TEST, EXTRA],
      reads: [
        [DOC, "old doc"],
        [TEST, "old test"],
      ],
    }),
    result = await f.planner.generate({
      taskId: "selfdev-plan",
      candidatePaths: [DOC, TEST],
      currentCommit: SHA,
    });
  assert.equal(result.evidenceExpansion.category, "test_discovery");
  assert.deepEqual(result.evidenceExpansion.paths, [EXTRA]);
  assert.deepEqual(result.evidenceExpansion.rejectedTarget, {
    path: "test/planner-missing.test.js",
    classification: "nonexistent_invalid",
    rejectionCode: "focused_test_evidence_rejected",
  });
  assert.equal(result.evidenceExpansion.attempt, 1);
  assert.equal(result.evidenceExpansion.plannerAttempt, 1);
  assert.ok(result.evidenceExpansion.paths.length <= 3);
});

test("microphone planner does not offer discovered tests rejected by the canonical relevance contract", async () => {
  const source="assets/voice-input.js",focused="test/voice-input.test.js",unrelated="test/console-client.test.js",other="test/workspace-navigation.test.js",output=valid();
  output.files=[{path:source,operation:"replace",content:"export const supported = true;\n",reason:"dictation",intendedChanges:["preserve draft"]}];
  output.focusedTests=[{path:focused,kind:"existing"}];
  output.acceptanceMapping=[{criterion:"Microphone dictation remains editable",files:[source]}];
  const f=await fixture([output],{discovered:[source,focused,unrelated,other],reads:[[source,"export const supported = false;\n"],[focused,"import test from 'node:test';\n"]]}),task=await f.storage.getAutonomyTask("selfdev-plan",OWNER);
  await f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...task.metadata,selfDevelopment:{userGoal:"Complete the composer microphone and editable dictation",acceptanceCriteria:["Microphone dictation remains editable"]}}});
  const before=await f.storage.getAutonomyTask(task.id,OWNER),result=await f.planner.generate({taskId:task.id,candidatePaths:[source,focused],currentCommit:SHA}),prompt=JSON.parse(f.prompts[0].message.split("\n")[1]);
  assert.deepEqual(prompt.availableEvidenceExpansionTests,[]);
  assert.deepEqual(result.implementationPlan.evidencePaths,[source,focused]);
  assert.equal(focusedTestEvidenceRelevance(unrelated,{candidatePaths:[source,focused],userGoal:before.metadata.selfDevelopment.userGoal,discoveredPaths:new Set([source,focused,unrelated,other])}).classification,"unrelated");
  assert.deepEqual(await f.storage.getAutonomyTask(task.id,OWNER),before);
  output.focusedTests=[{path:unrelated,kind:"existing"}];
  await assert.rejects(()=>f.planner.generate({taskId:task.id,candidatePaths:[source,focused],currentCommit:SHA}),error=>error.code==="implementation_scope_violation"&&error.safeDiagnostics.classification==="unrelated"&&error.safeDiagnostics.proposedPath===unrelated&&error.safeDiagnostics.mutationApplied===false);
});

test("canonical relevance offers legitimate evidence and validation accepts exactly that discovery candidate", async () => {
  const output=valid();output.focusedTests=[{path:EXTRA,kind:"existing"}];
  const f=await fixture([output],{discovered:[DOC,TEST,EXTRA,"test/unrelated.test.js","test/voice-control.test.js"]}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA}),prompt=JSON.parse(f.prompts[0].message.split("\n")[1]);
  assert.deepEqual(prompt.availableEvidenceExpansionTests,[EXTRA]);
  assert.deepEqual(result.evidenceExpansion.paths,[EXTRA]);
  assert.equal(result.evidenceExpansion.category,"existing_file");
  assert.equal(focusedTestEvidenceRelevance("test/console-client.test.js",{candidatePaths:["assets/api-client.js",TEST],userGoal:"Repair API client response handling",discoveredPaths:new Set(["test/console-client.test.js"])}).eligible,true,"eligibility is contextual, not a filename deny-list");
});

test("microphone planning keeps preservation suites outside complete mutation-authoritative evidence",async()=>{
  const sources=["assets/console.js","assets/console.css","assets/voice-input.js"],tests=["test/composer-voice-console.integration.test.js","test/console-static.test.js","test/voice-input.test.js"],preservation=["assets/voice-benchmark.js","assets/voice-capture.js","assets/voice-v2.js","test/voice-mode.test.js","test/voice-v2.test.js","test/speaker-identity.test.js"],candidates=[...sources,...tests],contents=new Map([
    [sources[0],"export const composer = true;\n".repeat(900)],
    [sources[1],".composer { display: flex; }\n".repeat(700)],
    [sources[2],"export const waveform = true;\n".repeat(500)],
    [tests[0],"import test from 'node:test';\n".repeat(80)],
    [tests[1],"import test from 'node:test';\n".repeat(80)],
    [tests[2],"import test from 'node:test';\n".repeat(80)],
  ]),output={summary:"Update the analyser-driven composer waveform",files:[{path:sources[2],operation:"replace",content:"export const waveform = 'wide';\n",reason:"real amplitude UI",intendedChanges:["widen live waveform"]}],focusedTests:[{path:tests[2],kind:"existing"}],acceptanceMapping:[{criterion:"Live waveform remains responsive",files:[sources[2]]}],riskLevel:"medium"};
  const f=await fixture([output],{discovered:[...candidates,...preservation],reads:[...contents],existing:[...candidates,...preservation]}),task=await f.storage.getAutonomyTask("selfdev-plan",OWNER);
  await f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...task.metadata,selfDevelopment:{userGoal:"Improve the microphone waveform while preserving Voice V2 and speaker identity",acceptanceCriteria:["Live waveform remains responsive"]}}});
  const result=await f.planner.generate({taskId:task.id,candidatePaths:candidates,currentCommit:SHA}),prompt=JSON.parse(f.prompts[0].message.split("\n")[1]),serialized=JSON.stringify(prompt.candidateFiles);
  assert.ok(serialized.length<180000,serialized.length);
  assert.deepEqual(prompt.candidateFiles.map(item=>item.path),candidates);
  assert.equal(prompt.availableEvidenceExpansionTests.includes("test/voice-v2.test.js"),false);
  assert.equal(prompt.availableEvidenceExpansionTests.includes("test/speaker-identity.test.js"),false);
  assert.ok(result.implementationPlan.provenance);
  assert.deepEqual(result.implementationPlan.evidencePaths,candidates);
  assert.match(result.implementationPlan.provenance.evidenceGenerationId,/^[a-f0-9]{64}$/);
  assert.deepEqual(result.implementationPlan.provenance.mutationPreconditions.map(item=>item.path),[sources[2]]);
  assert.equal(SELF_DEVELOPMENT_PLANNER_PROTECTED.test("assets/voice-v2.js"),true);
  assert.equal(SELF_DEVELOPMENT_PLANNER_PROTECTED.test("assets/voice-input.js"),false);
  assert.equal(focusedTestSourceRelationship("test/voice-v2.test.js",sources).related,false);
  assert.equal(focusedTestSourceRelationship("test/speaker-identity.test.js",sources).related,false);
  assert.equal(focusedTestEvidenceRelevance("test/console-static.test.js",{candidatePaths:sources,userGoal:"microphone waveform",discoveredPaths:new Set(["test/console-static.test.js"])}).eligible,true);
});

test("rejected structured plans retain bounded references and fingerprints without source or model prose", async () => {
  const output=valid(),marker="private-model-prose-must-not-be-stored",unrelated="test/unrelated.test.js";
  output.files[0].content=marker;output.files[0].reason=marker;output.files[0].intendedChanges=[marker];output.summary=marker;
  output.focusedTests=[{path:unrelated,kind:"existing"}];
  output.acceptanceMapping=[{criterion:marker,files:[DOC,unrelated]}];
  const f=await fixture([output],{discovered:[DOC,TEST,unrelated]});
  let failure;await assert.rejects(()=>f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA}),error=>{failure=error;return error.code==="implementation_scope_violation";});
  const diagnostic=failure.safeDiagnostics,proof=diagnostic.rejectedPlanEvidence;
  assert.equal(proof.version,1);assert.equal(proof.taskId,"selfdev-plan");assert.equal(proof.currentCommit,SHA);
  assert.deepEqual(proof.requestedMutationPaths.map(({path,operation})=>({path,operation})),[{path:DOC,operation:"replace"}]);
  assert.deepEqual(proof.requestedFocusedTests.map(({path,kind})=>({path,kind})),[{path:unrelated,kind:"existing"}]);
  assert.deepEqual(proof.acceptanceMapping[0].files,[{mutationIndex:0}]);
  assert.deepEqual(proof.acceptanceMapping[0].tests,[{focusedTestIndex:0}]);
  assert.equal(proof.acceptanceMapping[0].criterionIndex,-1);
  assert.match(proof.planFingerprint,/^[a-f0-9]{64}$/);assert.match(proof.evidenceFingerprint,/^[a-f0-9]{64}$/);assert.match(diagnostic.outputShapeHash,/^[a-f0-9]{64}$/);
  assert.equal(proof.validation.classification,"unrelated");assert.equal(proof.mutationApplied,false);
  assert.equal(JSON.stringify(diagnostic).includes(marker),false);
  assert.ok(JSON.stringify(diagnostic).length<10000);
});

test("Worker durably records rejected plan references before any Hands mutation", async () => {
  const output=valid(),unrelated="test/unrelated.test.js";output.focusedTests=[{path:unrelated,kind:"existing"}];
  const f=await fixture([output],{discovered:[DOC,TEST,unrelated]}),task=await f.storage.getAutonomyTask("selfdev-plan",OWNER),calls=[];
  await f.storage.updateAutonomyTask(task.id,OWNER,{status:"queued",metadata:{...task.metadata,steps:[{type:"plan_repair",capability:"reasoning",input:{tool:"self_development_plan_implementation",arguments:{taskId:task.id,candidatePaths:[DOC,TEST],currentCommit:SHA}},idempotencyIdentity:"invalid-repair-plan"},{type:"apply_patch",capability:"repo_mutate_local",input:{tool:"repo_apply_patch",arguments:{files:"$IMPLEMENTATION_FILES"}},idempotencyIdentity:"must-not-mutate"}]}});
  const runtime=createWorkerRuntime({storage:f.storage,ownerId:OWNER,approvedBranch:BRANCH,capabilities:["reasoning","repo_mutate_local"],toolRegistry:{async execute(name,args){calls.push(name);assert.equal(name,"self_development_plan_implementation");return f.planner.generate(args);}}});
  await runtime.tickTask(task.id);
  const failed=(await f.storage.listAutonomySteps(task.id)).find(step=>step.stepType==="plan_repair"&&step.status==="failed");
  assert.equal(failed.errorCode,"implementation_scope_violation");
  assert.equal(failed.result.diagnostics.rejectedPlanEvidence.requestedFocusedTests[0].path,unrelated);
  assert.equal(failed.result.diagnostics.rejectedPlanEvidence.requestedMutationPaths[0].path,DOC);
  assert.equal(failed.result.diagnostics.mutationApplied,false);
  assert.deepEqual(calls,["self_development_plan_implementation"]);
  assert.equal((await runtime.get(task.id)).metadata.selfDevelopmentImplementationPlan,undefined);
});

test("rejected-plan audit evidence remains bounded even when model arrays exceed schema limits", async () => {
  const output=valid(),marker="Bearer do-not-retain-model-secrets";
  output.focusedTests=Array.from({length:40},(_,i)=>({path:`test/unrelated-${i}.test.js`,kind:"existing"}));
  output.acceptanceMapping=Array.from({length:40},()=>({criterion:marker,files:Array.from({length:20},()=>DOC)}));
  const f=await fixture([output]);
  await assert.rejects(()=>f.planner.generate({taskId:"selfdev-plan",candidatePaths:[DOC,TEST],currentCommit:SHA}),error=>{
    const proof=error.safeDiagnostics.rejectedPlanEvidence;
    assert.equal(proof.requestedFocusedTests.length,12);assert.equal(proof.omittedFocusedTestCount,28);
    assert.equal(proof.acceptanceMapping.length,30);assert.equal(proof.omittedMappingCount,10);
    assert.equal(proof.acceptanceMapping[0].files.length,8);assert.equal(proof.acceptanceMapping[0].omittedFileCount,12);
    assert.equal(JSON.stringify(proof).includes(marker),false);assert.ok(JSON.stringify(proof).length<20000);
    return error.code==="implementation_scope_violation"&&error.safeDiagnostics.mutationApplied===false;
  });
});
