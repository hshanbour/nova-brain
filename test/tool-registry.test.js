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
