export function createToolRegistry({ policy } = {}) {
  const tools = new Map();

  function validateSchemaInput(schema, input, name) {
    if (!schema) return;
    const properties = schema.properties || {};
    for (const field of schema.required || []) {
      if (!(field in input)) throw new Error(`Missing required tool argument: ${name}.${field}`);
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(input)) {
        if (!(field in properties)) throw new Error(`Unknown tool argument: ${name}.${field}`);
      }
    }
    for (const [field, definition] of Object.entries(properties)) {
      if (!(field in input)) continue;
      if (definition.type === "string" && typeof input[field] !== "string") {
        throw new Error(`Invalid tool argument type: ${name}.${field}`);
      }
      if (definition.type === "number" && typeof input[field] !== "number") {
        throw new Error(`Invalid tool argument type: ${name}.${field}`);
      }
      if (definition.type === "boolean" && typeof input[field] !== "boolean") {
        throw new Error(`Invalid tool argument type: ${name}.${field}`);
      }
      if (definition.type === "array" && !Array.isArray(input[field])) {
        throw new Error(`Invalid tool argument type: ${name}.${field}`);
      }
      if (definition.type === "object" && (!input[field] || typeof input[field] !== "object" || Array.isArray(input[field]))) {
        throw new Error(`Invalid tool argument type: ${name}.${field}`);
      }
    }
  }

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

      validateSchemaInput(tool.inputSchema, input, name);
      if (tool.validate) await tool.validate(input);
      if (policy) await policy.authorize(tool, input, context);

      return tool.execute(input, context);
    }
  });
}
