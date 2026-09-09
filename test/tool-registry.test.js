import test from "node:test";
import assert from "node:assert/strict";
import { createToolRegistry } from "../src/tools/tool-registry.js";

test("tool registry registers, lists, and executes a tool", async () => {
  const registry = createToolRegistry();
  registry.register({
    name: "echo",
    description: "Returns its input",
    async execute(input, context) {
      return { input, context };
    }
  });

  assert.deepEqual(registry.list(), [
    { name: "echo", description: "Returns its input" }
  ]);
  assert.deepEqual(await registry.execute("echo", { value: 1 }, { requestId: "r1" }), {
    input: { value: 1 },
    context: { requestId: "r1" }
  });
});

test("tool registry rejects invalid, duplicate, and unknown tools", async () => {
  const registry = createToolRegistry();
  assert.throws(() => registry.register({ name: "invalid" }), /execute function/);

  registry.register({ name: "echo", async execute() {} });
  assert.throws(
    () => registry.register({ name: "echo", async execute() {} }),
    /already registered/
  );
  await assert.rejects(() => registry.execute("unknown"), /Unknown tool/);
});

test("tool registry enforces required, type, and additional-property schemas server-side", async () => {
  const registry = createToolRegistry();
  registry.register({
    name: "read",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
    async execute(input) { return input; }
  });
  await assert.rejects(() => registry.execute("read", {}), /Missing required/);
  await assert.rejects(() => registry.execute("read", {}), error => error.code === "schema_mismatch");
  await assert.rejects(() => registry.execute("read", { path: 7 }), /Invalid tool argument type/);
  await assert.rejects(() => registry.execute("read", { path: "README.md", secret: true }), /Unknown tool argument/);
  assert.deepEqual(await registry.execute("read", { path: "README.md" }), { path: "README.md" });
});

test("schema failures expose only safe structural diagnostics", async () => {
  const registry=createToolRegistry();
  registry.register({name:"bounded",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false},execute:async()=>({ok:true})});
  await assert.rejects(()=>registry.execute("bounded",{path:"safe",currentCommit:"a".repeat(40)},{schemaDiagnosticContext:{taskId:"task-one",handoffId:"handoff-one",stepId:"8:apply_patch",stepType:"apply_patch",payloadProvenance:"server_handoff_arguments"}}),error=>error.code==="schema_mismatch"&&error.safeDiagnostics.fieldPath==="bounded.currentCommit"&&error.safeDiagnostics.expected.type==="declared_property"&&error.safeDiagnostics.received.type==="string"&&error.safeDiagnostics.validationCode==="unsupported_field"&&error.safeDiagnostics.validationLayer==="hands_tool_registry"&&error.safeDiagnostics.tool==="bounded"&&error.safeDiagnostics.schemaVersion==="1"&&error.safeDiagnostics.taskId==="task-one"&&!JSON.stringify(error.safeDiagnostics).includes("a".repeat(40)));
});

test("type mismatches retain structural shapes and never literal values",async()=>{const registry=createToolRegistry();registry.register({name:"typed",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false},execute:async()=>({ok:true})});await assert.rejects(()=>registry.execute("typed",{path:{token:"never"}},{schemaDiagnosticContext:{payloadProvenance:"server_handoff_arguments"}}),error=>error.safeDiagnostics.expected.type==="string"&&error.safeDiagnostics.received.type==="object"&&!JSON.stringify(error.safeDiagnostics).includes("never"));});
