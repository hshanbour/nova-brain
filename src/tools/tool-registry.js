export function createToolRegistry({ policy } = {}) {
  const tools = new Map();

  return Object.freeze({
    register(tool) {
      if (!tool?.name || typeof tool.execute !== "function") {
        throw new Error("A tool requires a name and execute function.");
      }

      if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
        throw new Error("Tool names must use 1-64 letters, numbers, underscores, or hyphens.");
      }

      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }

      tools.set(tool.name, Object.freeze({ ...tool }));
    },
    list({ executableOnly = false } = {}) {
      return [...tools.values()].filter((tool) => !executableOnly || tool.available !== false).map(({ execute: _execute, validate: _validate, ...tool }) => ({
        ...tool
      }));
    },
    async execute(name, input, context) {
      const tool = tools.get(name);

      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error(`Tool arguments must be an object: ${name}`);
      }

      if (tool.available === false) throw new Error(`Tool is unavailable: ${name}`);

      if (tool.validate) await tool.validate(input);
      if (policy) await policy.authorize(tool, input, context);

      return tool.execute(input, context);
    }
  });
}
