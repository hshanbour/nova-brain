export function createToolRegistry() {
  const tools = new Map();

  return Object.freeze({
    register(tool) {
      if (!tool?.name || typeof tool.execute !== "function") {
        throw new Error("A tool requires a name and execute function.");
      }

      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }

      tools.set(tool.name, Object.freeze({ ...tool }));
    },
    list() {
      return [...tools.values()].map(({ name, description }) => ({ name, description }));
    },
    async execute(name, input, context) {
      const tool = tools.get(name);

      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }

      return tool.execute(input, context);
    }
  });
}
