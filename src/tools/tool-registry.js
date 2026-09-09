import {canonicalSchemaDiagnostic} from "../autonomy/schema-diagnostics.js";

export function createToolRegistry({ policy } = {}) {
  const tools = new Map();

  class ToolInputError extends Error {
    constructor(message, safeDiagnostics = {}) {
      super(message);
      this.name = "ToolInputError";
      this.code = "schema_mismatch";
      this.statusCode = 400;
      this.safeDiagnostics = safeDiagnostics;
    }
  }

  function validateSchemaInput(schema, input, name) {
    if (!schema) return;
    const properties = schema.properties || {};
    for (const field of schema.required || []) {
      if (!(field in input)) throw new ToolInputError(`Missing required tool argument: ${name}.${field}`, {fieldPath:`${name}.${field}`,expected:"required",received:"missing",validationCode:"required_field_missing"});
    }
    if (schema.additionalProperties === false) {
      for (const field of Object.keys(input)) {
        if (!(field in properties)) throw new ToolInputError(`Unknown tool argument: ${name}.${field}`, {fieldPath:`${name}.${field}`,expected:"declared_property",received:typeof input[field],validationCode:"unsupported_field"});
      }
    }
    for (const [field, definition] of Object.entries(properties)) {
      if (!(field in input)) continue;
      if (definition.type === "string" && typeof input[field] !== "string") {
        throw new ToolInputError(`Invalid tool argument type: ${name}.${field}`,{fieldPath:`${name}.${field}`,expected:{type:"string"},received:{type:Array.isArray(input[field])?"array":input[field]===null?"null":typeof input[field]},validationCode:"invalid_type"});
      }
      if (definition.type === "number" && typeof input[field] !== "number") {
        throw new ToolInputError(`Invalid tool argument type: ${name}.${field}`,{fieldPath:`${name}.${field}`,expected:{type:"number"},received:{type:Array.isArray(input[field])?"array":input[field]===null?"null":typeof input[field]},validationCode:"invalid_type"});
      }
      if (definition.type === "boolean" && typeof input[field] !== "boolean") {
        throw new ToolInputError(`Invalid tool argument type: ${name}.${field}`,{fieldPath:`${name}.${field}`,expected:{type:"boolean"},received:{type:Array.isArray(input[field])?"array":input[field]===null?"null":typeof input[field]},validationCode:"invalid_type"});
      }
      if (definition.type === "array" && !Array.isArray(input[field])) {
        throw new ToolInputError(`Invalid tool argument type: ${name}.${field}`,{fieldPath:`${name}.${field}`,expected:{type:"array"},received:{type:input[field]===null?"null":typeof input[field]},validationCode:"invalid_type"});
      }
      if (definition.type === "object" && (!input[field] || typeof input[field] !== "object" || Array.isArray(input[field]))) {
        throw new ToolInputError(`Invalid tool argument type: ${name}.${field}`,{fieldPath:`${name}.${field}`,expected:{type:"object"},received:{type:Array.isArray(input[field])?"array":input[field]===null?"null":typeof input[field]},validationCode:"invalid_type"});
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

      try{validateSchemaInput(tool.inputSchema, input, name);if (tool.validate) await tool.validate(input);}catch(error){if(error?.code==="schema_mismatch")error.safeDiagnostics=canonicalSchemaDiagnostic({...error.safeDiagnostics,...context?.schemaDiagnosticContext,tool:name,schemaVersion:tool.inputSchema?.schemaVersion||tool.inputSchema?.version||"1",argumentKeys:Object.keys(input),validationLayer:"hands_tool_registry"});throw error;}
      if (policy) await policy.authorize(tool, input, context);

      return tool.execute(input, context);
    }
  });
}
