import test from "node:test";
import assert from "node:assert/strict";
import { createInMemoryStorage } from "../src/storage/in-memory-storage.js";
import {
  createSelfDevelopmentImplementationPlanner,
  SELF_DEVELOPMENT_IMPLEMENTATION_PLAN_SCHEMA,
} from "../src/autonomy/self-development-implementation-planner.js";
import { createWorkerRuntime } from "../src/autonomy/worker-runtime.js";
import { SELF_DEVELOPMENT_HANDS_PATCH_INPUT_SCHEMA, SELF_DEVELOPMENT_IMPLEMENTATION_PLAN_SCHEMA_VERSION } from "../src/autonomy/self-development-implementation-contract.js";
import { createToolRegistry } from "../src/tools/tool-registry.js";
import { registerHandsTools } from "../src/tools/hands-runtime.js";
import {canonicalContentHash} from "../src/autonomy/self-development-plan-lifecycle.js";

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
test("planner and Hands share the canonical versioned patch bridge contract", () => {
  const registry=createToolRegistry();registerHandsTools(registry,{root:process.cwd(),environment:{VERCEL:"",NOVA_BRAIN_DEVELOPMENT_BRANCH:BRANCH}});
  const patch=registry.list().find((tool)=>tool.name==="repo_apply_patch");
  assert.equal(SELF_DEVELOPMENT_IMPLEMENTATION_PLAN_SCHEMA_VERSION,"1");
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
test("instructional replacement prose is rejected and regenerated before mutation",async()=>{const prose=valid();prose.files=[{path:"assets/voice-input.js",operation:"replace",content:"Replace the adapter with valid JavaScript and preserve editable transcription.",reason:"repair",intendedChanges:["repair adapter"]}];prose.focusedTests=[{path:"test/voice-input.test.js",kind:"existing"}];prose.acceptanceMapping=[{criterion:"Works",files:["assets/voice-input.js"]}];const corrected=structuredClone(prose);corrected.files[0].content="export const supported = true;\n";const f=await fixture([prose,corrected],{discovered:["assets/voice-input.js","test/voice-input.test.js"],reads:[["assets/voice-input.js","export const supported = false;\n"],["test/voice-input.test.js","import test from 'node:test';\n"]]}),result=await f.planner.generate({taskId:"selfdev-plan",candidatePaths:["assets/voice-input.js","test/voice-input.test.js"],currentCommit:SHA});assert.equal(f.calls,2);assert.match(f.prompts[1].message,/file_0_replacement_script_not_source/);assert.equal(result.implementationPlan.files[0].content,"export const supported = true;\n");});

test("partial-plan recovery regenerates every exact task-owned dirty path and rejects another partial plan",async()=>{
  const paths=[DOC,TEST,EXTRA],contents={[DOC]:"dirty doc",[TEST]:"import test from 'node:test';\n",[EXTRA]:"import test from 'node:test';\n"},complete={files:paths.map(path=>({path,operation:"replace",content:path===DOC?"fixed doc":"import test from 'node:test';\n// repaired\n",reason:"repair",intendedChanges:["repair"]})),focusedTests:[{path:TEST,kind:"existing"}],acceptanceMapping:[{criterion:"Document is updated",files:paths}],riskLevel:"medium",summary:"Complete repair"};
  async function prepared(outputs){const f=await fixture(outputs,{discovered:paths,reads:[],existing:paths}),task=await f.storage.getAutonomyTask("selfdev-plan",OWNER),generationId="partial-recovery-generation",entries=paths.map(path=>({path,contentHash:canonicalContentHash(contents[path])})),record={taskId:task.id,repository:"hshanbour/nova-brain",branch:BRANCH,currentCommit:SHA,fingerprint:"f".repeat(64),sourcePlanStepId:"26:plan_repair",sourceApplyStepId:"27:apply_patch",requiredPaths:paths,entries,activeContinuation:{generationId}};await f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...task.metadata,selfDevelopment:{...task.metadata.selfDevelopment,repository:"hshanbour/nova-brain"},activeContinuation:{generationId},partialRepairPlanRecoveryHistory:[record]}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:record.sourcePlanStepId,stepType:"plan_repair",capability:"reasoning",operationFingerprint:"source-plan",status:"completed",result:{implementationPlan:{files:paths.map(path=>({path,content:contents[path]}))}}});await f.storage.recordAutonomyStep({taskId:task.id,stepId:record.sourceApplyStepId,stepType:"apply_patch",capability:"repo_mutate_local",operationFingerprint:"source-apply",status:"completed",result:{files:paths}});return{f,failureEvidence:{code:"repair_plan_incomplete",fingerprint:record.fingerprint}};}
  const exact=await prepared([complete]),result=await exact.f.planner.generate({taskId:"selfdev-plan",candidatePaths:paths,currentCommit:SHA,failureEvidence:exact.failureEvidence});assert.deepEqual(result.implementationPlan.files.map(file=>file.path).sort(),[...paths].sort());assert.match(exact.f.prompts[0].message,/dirty doc/);
  const partial=structuredClone(complete);partial.files=partial.files.slice(1);partial.acceptanceMapping=[{criterion:"Document is updated",files:partial.files.map(file=>file.path)}];const rejected=await prepared([partial,partial,partial]);await assert.rejects(()=>rejected.f.planner.generate({taskId:"selfdev-plan",candidatePaths:paths,currentCommit:SHA,failureEvidence:rejected.failureEvidence}),error=>error.code==="implementation_plan_invalid"||error.code==="implementation_scope_violation");
  for(const [field,value] of [["taskId","another-task"],["repository","another/repository"],["branch","feat/another-branch"]]){const mismatched=await prepared([complete]),task=await mismatched.f.storage.getAutonomyTask("selfdev-plan",OWNER),record={...task.metadata.partialRepairPlanRecoveryHistory[0],[field]:value};await mismatched.f.storage.updateAutonomyTask(task.id,OWNER,{metadata:{...task.metadata,partialRepairPlanRecoveryHistory:[record]}});await assert.rejects(()=>mismatched.f.planner.generate({taskId:"selfdev-plan",candidatePaths:paths,currentCommit:SHA,failureEvidence:mismatched.failureEvidence}),error=>error.code==="implementation_evidence_incomplete");}
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
test("durable Worker passes only the validated Nova patch to Hands", async () => {
  const f = await fixture(),
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
    capabilities: ["reasoning", "repo_mutate_local"],
    toolRegistry: {
      async execute(name, args) {
        calls.push({ name, args });
        return name === "self_development_plan_implementation"
          ? generated
          : { ok: true, files: args.files.map((x) => x.path) };
      },
    },
  });
  await runtime.tickTask("selfdev-plan", { idempotencyKey: "plan" });
  await runtime.tickTask("selfdev-plan", { idempotencyKey: "apply" });
  assert.deepEqual(
    calls.map((x) => x.name),
    ["self_development_plan_implementation", "repo_apply_patch"],
  );
  assert.equal(calls[1].args.files[0].content, "new doc");
  assert.equal(calls[1].args.files[0].operation, "replace");
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
