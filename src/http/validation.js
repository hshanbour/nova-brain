export class ValidationError extends Error {}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value, field, { maxLength = 500 } = {}) {
  if (value === undefined) return undefined;

  if (typeof value !== "string" || value.length > maxLength) {
    throw new ValidationError(`${field} must be a string up to ${maxLength} characters.`);
  }

  return value.trim();
}

const MEMORY_CATEGORIES = new Set(["identity", "preference", "goal", "decision", "project_context", "relationship_context", "reusable_instruction"]);
const MEMORY_SCOPES = new Set(["global", "system", "project"]);
const MEMORY_PRIVACY = new Set(["private", "restricted"]);
const MEMORY_SENSITIVITY = new Set(["normal", "personal", "business", "sensitive"]);

function requiredChoice(value, field, choices) {
  const parsed = optionalString(value, field, { maxLength: 64 });
  if (!parsed || !choices.has(parsed)) throw new ValidationError(`${field} is invalid.`);
  return parsed;
}

function optionalObject(value, field) {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new ValidationError(`${field} must be a JSON object.`);
  return value;
}

export function validateAgentRequest(value) {
  if (!isPlainObject(value)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  const message = optionalString(value.message, "message", { maxLength: 4_000 });

  if (!message) {
    throw new ValidationError("message is required.");
  }

  const conversationId = optionalString(value.conversationId, "conversationId", {
    maxLength: 128
  });
  const context = value.context === undefined ? {} : value.context;

  if (!isPlainObject(context)) {
    throw new ValidationError("context must be a JSON object.");
  }

  return { message, ...(conversationId ? { conversationId } : {}), context };
}

export function validateMissedCallRequest(value) {
  if (!isPlainObject(value)) {
    throw new ValidationError("Request body must be a JSON object.");
  }

  return {
    name: optionalString(value.name, "name", { maxLength: 200 }) || "Unknown",
    phone: optionalString(value.phone, "phone", { maxLength: 64 }) || null
  };
}

export function validateOwnerProfilePatch(value) {
  if (!isPlainObject(value)) throw new ValidationError("Request body must be a JSON object.");
  const patch = {};
  for (const [field, maxLength] of [["fullName",200],["preferredName",100],["arabicName",200]]) {
    const parsed = optionalString(value[field], field, { maxLength }); if (parsed !== undefined) patch[field] = parsed;
  }
  for (const field of ["facts", "preferences", "context"]) { const parsed = optionalObject(value[field], field); if (parsed !== undefined) patch[field] = parsed; }
  if (value.goals !== undefined) {
    if (!Array.isArray(value.goals) || value.goals.length > 50 || value.goals.some((goal) => typeof goal !== "string" || goal.length > 500)) throw new ValidationError("goals must be an array of up to 50 strings.");
    patch.goals = value.goals.map((goal) => goal.trim()).filter(Boolean);
  }
  if (!Object.keys(patch).length) throw new ValidationError("At least one editable profile field is required.");
  return patch;
}

export function validateMemoryCreate(value) {
  if (!isPlainObject(value)) throw new ValidationError("Request body must be a JSON object.");
  const content = optionalString(value.content, "content", { maxLength: 4_000 });
  if (!content) throw new ValidationError("content is required.");
  const scope = requiredChoice(value.scope || "global", "scope", MEMORY_SCOPES);
  const projectId = optionalString(value.projectId, "projectId", { maxLength: 128 });
  if (scope === "project" && !projectId) throw new ValidationError("projectId is required for project-scoped memory.");
  if (scope !== "project" && projectId) throw new ValidationError("projectId is only allowed for project-scoped memory.");
  return {
    category: requiredChoice(value.category, "category", MEMORY_CATEGORIES), content,
    scope, ...(projectId ? { projectId } : {}),
    privacy: requiredChoice(value.privacy || "private", "privacy", MEMORY_PRIVACY),
    sensitivity: requiredChoice(value.sensitivity || "normal", "sensitivity", MEMORY_SENSITIVITY),
    provenance: "owner-explicit", status: "active"
  };
}

export function validateMemoryPatch(value) {
  if (!isPlainObject(value)) throw new ValidationError("Request body must be a JSON object.");
  const patch = {};
  if (value.content !== undefined) { const content = optionalString(value.content, "content", { maxLength: 4_000 }); if (!content) throw new ValidationError("content cannot be empty."); patch.content = content; }
  if (value.category !== undefined) patch.category = requiredChoice(value.category, "category", MEMORY_CATEGORIES);
  if (value.scope !== undefined) patch.scope = requiredChoice(value.scope, "scope", MEMORY_SCOPES);
  if (value.privacy !== undefined) patch.privacy = requiredChoice(value.privacy, "privacy", MEMORY_PRIVACY);
  if (value.sensitivity !== undefined) patch.sensitivity = requiredChoice(value.sensitivity, "sensitivity", MEMORY_SENSITIVITY);
  if (value.projectId !== undefined) patch.projectId = value.projectId === null ? null : optionalString(value.projectId, "projectId", { maxLength: 128 }) || null;
  if (!Object.keys(patch).length) throw new ValidationError("At least one editable memory field is required.");
  const effectiveScope = patch.scope || value.scope;
  if (patch.scope === "project" && !patch.projectId) throw new ValidationError("projectId is required when changing to project scope.");
  if (effectiveScope && effectiveScope !== "project" && patch.projectId) throw new ValidationError("projectId is only allowed for project-scoped memory.");
  return patch;
}

export function validateListLimit(value, fallback, max) {
  if (value === null || value === "") return fallback;
  const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new ValidationError(`limit must be an integer between 1 and ${max}.`);
  return parsed;
}

export function validateListOffset(value, max = 100_000) {
  if (value === null || value === "") return 0;
  const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) throw new ValidationError(`offset must be an integer between 0 and ${max}.`);
  return parsed;
}
